"""ETF Intelligence Platform —— Matching API（FastAPI）。

对外只暴露「可解释的计算结果」；自然语言部分由确定性模板生成，
不编造匹配分数、历史表现或持仓数据（方案 §6）。
"""
from __future__ import annotations

import io
import re
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from etfi import brief as brief_mod
from etfi import datasource as ds
from etfi import matching as match_mod
from etfi import report as report_mod
from etfi import store, warehouse
from etfi.config import EXPORT_DIR, ROOT
from etfi.profile import build_profile

app = FastAPI(title="ETF Intelligence Platform", version="1.0.0")
WEB_DIR = ROOT / "web"

# ------------------------------------------------------------ 数据结构 ----
class MatchRequest(BaseModel):
    user_id: str = "demo"
    stated: dict | None = None
    positions: list[dict] | None = None
    top_k: int = 10
    limits: dict | None = None


class BriefRequest(BaseModel):
    user_id: str = "demo"
    stated: dict | None = None
    positions: list[dict] | None = None
    with_matching: bool = True


# ---------------------------------------------------------------- 首页 ----
app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


# ------------------------------------------------------------ 建库接口 ----
@app.get("/api/stats")
def stats():
    return {"etf_in_db": store.etf_count(),
            "universe": len(ds.get_universe() or []),
            "algo_version": match_mod.ALGO_VERSION}


@app.post("/api/build")
def build(limit: int = 800):
    res = warehouse.build_universe(limit=limit)
    res["etf_in_db"] = store.etf_count()
    return res


# ------------------------------------------------------------ 持仓上传 ----
HDR_MAP = {
    "code": ["代码", "证券代码", "基金代码", "code", "ticker", "symbol"],
    "name": ["名称", "证券名称", "基金名称", "name"],
    "weight": ["权重", "占比", "仓位", "weight", "比例"],
    "market_value": ["市值", "持仓市值", "market_value", "金额"],
    "shares": ["份额", "数量", "shares", "持有份额"],
    "cost_price": ["成本价", "买入价", "cost", "成本"],
    "buy_date": ["买入日期", "建仓日期", "buy_date", "日期"],
}


def _map_header(h: str) -> str | None:
    h = (h or "").strip().lower()
    for k, vs in HDR_MAP.items():
        if h in [v.lower() for v in vs]:
            return k
    return None


def parse_csv(text: str) -> list[dict]:
    """文本 CSV/TSV → 持仓记录。自动识别分隔符与表头行。"""
    text = (text or "").lstrip("\ufeff")
    rows = [r for r in text.splitlines() if r.strip()]
    if not rows:
        return []
    sep = "," if rows[0].count(",") >= rows[0].count("\t") else "\t"
    grid = [[c.strip() for c in r.split(sep)] for r in rows]
    return parse_table(grid[0], grid[1:])


def parse_table(header: list[str], grid: list[list[str]]) -> list[dict]:
    """表头 + 单元格矩阵 → 持仓记录。列名容错、权重/市值归一化、代码校验。"""
    cols = [_map_header(h) for h in header]
    out = []
    for cells in grid:
        rec: dict[str, Any] = {}
        for i, c in enumerate(cells):
            key = cols[i] if i < len(cols) else None
            if not key:
                continue
            rec[key] = c
        code = re.sub(r"\D", "", str(rec.get("code") or ""))
        if len(code) != 6:
            continue
        rec["code"] = code
        w = rec.get("weight")
        mv = rec.get("market_value")
        try:
            if w not in (None, ""):
                wv = float(str(w).replace("%", "").replace(",", ""))
                rec["weight"] = wv / 100 if wv > 1.5 else wv
            elif mv not in (None, ""):
                rec["market_value"] = float(str(mv).replace(",", ""))
            if rec.get("shares") not in (None, ""):
                rec["shares"] = float(str(rec["shares"]).replace(",", ""))
            if rec.get("cost_price") not in (None, ""):
                rec["cost_price"] = float(str(rec["cost_price"]).replace(",", ""))
        except Exception:
            pass
        out.append(rec)
    # 只有市值没有权重时，按市值归一化
    if out and all(o.get("weight") in (None, "") for o in out) and \
       any(o.get("market_value") for o in out):
        tot = sum(o.get("market_value") or 0 for o in out)
        for o in out:
            o["weight"] = (o.get("market_value") or 0) / tot if tot else 0
    else:
        tot = sum(o.get("weight") or 0 for o in out)
        if tot and abs(tot - 1.0) > 0.02:
            for o in out:
                o["weight"] = (o.get("weight") or 0) / tot
    for o in out:
        o.setdefault("name", "")
        o.setdefault("weight", 0.0)
        o["source"] = "csv"
    return out


def parse_xlsx(raw: bytes) -> list[dict]:
    """Excel 持仓表 → 与 parse_csv 相同的结构（首个有表头的工作表）。"""
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    grid = []
    for row in ws.iter_rows(values_only=True):
        cells = ["" if c is None else str(c).strip() for c in row]
        if any(cells):
            grid.append(cells)
    wb.close()
    if len(grid) < 2:
        return []
    header = grid[0]
    if not any(_map_header(h) for h in header):  # 首行不是表头时后移一行
        grid = grid[1:]
        header = grid[0] if grid else []
    return parse_table(header, grid[1:])


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), user_id: str = Form("demo")):
    raw = await file.read()
    name = (file.filename or "").lower()
    if name.endswith((".xlsx", ".xls")):
        rows = parse_xlsx(raw)
        if not rows:
            raise HTTPException(400, "Excel 中未解析出有效持仓，请确认首行为表头且含 6 位基金代码")
    else:
        for enc in ("utf-8-sig", "gbk", "utf-8"):
            try:
                text = raw.decode(enc)
                break
            except Exception:
                continue
        else:
            raise HTTPException(400, "CSV 编码无法识别")
        rows = parse_csv(text)
    if not rows:
        raise HTTPException(400, "未能解析出有效持仓，请检查列名（代码/名称/权重）")
    store.save_positions(user_id, rows)
    return {"ok": True, "count": len(rows), "positions": rows}


@app.get("/api/positions/{user_id}")
def get_positions(user_id: str):
    return {"positions": store.load_positions(user_id)}


# -------------------------------------------------------------- 画像 ----
@app.get("/api/profile/{user_id}")
def get_profile(user_id: str, stated: str | None = None):
    import json
    st = json.loads(stated) if stated else {}
    p = build_profile(user_id, st, store.load_positions(user_id))
    return p


@app.get("/api/profile_history/{user_id}")
def profile_history(user_id: str, limit: int = 10):
    return {"history": store.load_profile_history(user_id, limit)}


# -------------------------------------------------------------- 匹配 ----
@app.post("/api/match")
def match(req: MatchRequest):
    positions = req.positions or store.load_positions(req.user_id)
    res = match_mod.run_matching(req.user_id, req.stated, positions,
                                 top_k=req.top_k, limits=req.limits)
    return JSONResponse(res)


# ------------------------------------------------------------ 每日情报 ----
@app.post("/api/brief")
def gen_brief(req: BriefRequest):
    positions = req.positions or store.load_positions(req.user_id)
    b = brief_mod.generate_brief(req.user_id, req.stated, positions, req.with_matching)
    return JSONResponse(b)


@app.get("/api/brief/{user_id}")
def get_brief(user_id: str, date: str | None = None):
    b = store.load_brief(user_id, date or ds.today())
    if not b:
        raise HTTPException(404, "暂无当日简报")
    return b


# -------------------------------------------------------------- 浏览 ----
@app.get("/api/etfs")
def list_etfs(q: str = "", asset: str = "", layer: str = "", limit: int = 100):
    rows = store.load_etf_master()
    if q:
        rows = [r for r in rows if q in (r.get("name") or "") or q in r["code"]
                or q in (r.get("index_name") or "")]
    if asset:
        rows = [r for r in rows if r.get("asset_class") == asset]
    if layer:
        rows = [r for r in rows if r.get("layer") == layer]
    rows.sort(key=lambda r: -(r.get("scale_yi") or 0))
    return {"total": len(rows), "rows": rows[:limit]}


@app.get("/api/etf/{code}")
def etf_detail(code: str):
    m = store.load_etf_master([code])
    if not m:
        raise HTTPException(404, "未找到该 ETF")
    h = warehouse.ensure_holdings([code]).get(code) or {}
    return {"master": m[0], "holdings": h.get("rows") or [],
            "report_date": h.get("report_date"),
            "scale_history": ds.get_scale_history(code),
            "kline": ds.get_kline(code, m[0].get("market") or 1, 60)}


# -------------------------------------------------------------- 导出 ----
@app.post("/api/export")
def export(user_id: str = Form("demo"), stated: str = Form("")):
    import json
    st = json.loads(stated) if stated else {}
    positions = store.load_positions(user_id)
    prof = build_profile(user_id, st, positions)
    res = match_mod.run_matching(user_id, st, positions, top_k=10) if positions else None
    b = brief_mod.generate_brief(user_id, st, positions, with_matching=False) if positions else None
    path = report_mod.export(user_id, prof, res, b)
    return {"ok": True, "path": path, "filename": path.split("/")[-1]}


@app.get("/api/download/{filename}")
def download(filename: str):
    p = EXPORT_DIR / filename
    if not p.exists():
        raise HTTPException(404, "文件不存在")
    return FileResponse(p, filename=filename)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8770, log_level="info")
