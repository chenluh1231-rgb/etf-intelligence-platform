"""静态快照导出器 —— 把 SQLite 里的 ETF 特征、持仓穿透与收益序列固化成 JSON。

目的：让 GitHub Pages 上的纯静态前端也能跑完整的四阶段匹配，
计算全部在浏览器本地完成，持仓数据不出浏览器（方案 §8 的静态部署变体）。

体积控制技巧：
  · 枚举字段（资产类别/层级/标签/行业）转成字典索引；
  · 收益序列存整数（×100，即 0.01% 精度），只存起始偏移 + 连续数组；
  · 个股名称按股票代码去重存放。
"""
from __future__ import annotations

import json
import math
from datetime import date
from pathlib import Path

from . import datasource as ds
from . import store
from .config import ALGO_VERSION, HARD_LIMITS, ALPHA, ADD_BETA, RISK_TARGET_VOL
from .matching import GOAL_VECTORS
from .overlap import stock_weights
from .warehouse import ensure_holdings, fetch_kline_map

# GitHub Pages 只认仓库根目录或 /docs，站点目录已从 site/ 更名为 docs/
SITE_DATA_DIR = Path(__file__).resolve().parents[1] / "docs" / "data"
RET_SCALE = 100          # 收益放大倍数：0.01% 精度
RET_DAYS = 250


def _idx_table(values) -> tuple[list[str], dict[str, int]]:
    seen: dict[str, int] = {}
    for v in values:
        if v is None:
            continue
        v = str(v)
        if v not in seen:
            seen[v] = len(seen)
    return list(seen.keys()), seen


def build_snapshot(limit: int = 0) -> dict:
    masters = store.load_etf_master()
    if not masters:
        raise RuntimeError("ETF 数据库为空，请先运行 warehouse.build_universe()")
    masters.sort(key=lambda m: -(m.get("scale_yi") or 0))
    if limit:
        masters = masters[:limit]
    codes = [m["code"] for m in masters]

    # ---------- 枚举字典 ----------
    assets, ai = _idx_table([m.get("asset_class") for m in masters])
    layers, li = _idx_table([m.get("layer") for m in masters])
    mkts, mi = _idx_table([m.get("mkt") for m in masters])
    tag_list, ti = _idx_table([t for m in masters for t in (m.get("tags") or [])])

    # ---------- 持仓穿透 ----------
    hmap = ensure_holdings(codes)
    stock_name: dict[str, str] = {}
    holdings_out: dict[str, list] = {}
    for c, h in hmap.items():
        rows = h.get("rows") or []
        hs = []
        for r in rows:
            sc = r.get("stock_code")
            if not sc or r.get("weight") is None:
                continue
            stock_name[sc] = r.get("stock_name") or ""
            hs.append([sc, round(float(r["weight"]) * 100)])
        if hs:
            holdings_out[c] = hs
        m = next((x for x in masters if x["code"] == c), None)
        if m is not None:
            m["_coverage"] = round(sum(stock_weights(rows).values()), 4)
            m["_report_date"] = h.get("report_date")

    # ---------- 个股行业 ----------
    ind_map = ds.get_industries(list(stock_name.keys())[:600]) if stock_name else {}
    industries, ii = _idx_table(list(ind_map.values()) or ["未分类"])
    stocks_out = {sc: [nm, ii.get(ind_map.get(sc) or "未分类", 0)]
                  for sc, nm in stock_name.items()}

    # ---------- K 线 / 收益 ----------
    kmap = fetch_kline_map(codes, days=RET_DAYS)
    # 日期轴取「全部出现的交易日」，不做截断：
    # 截断会让老 ETF 的序列被砍短，进而缩小组合收益的交集天数。
    dates = sorted({k["date"] for ks in kmap.values() for k in ks})
    dpos = {d: i for i, d in enumerate(dates)}

    returns_out: dict[str, list] = {}
    latest_out: dict[str, list] = {}
    for c in codes:
        ks = kmap.get(c) or []
        if not ks:
            continue
        ks = [k for k in ks if k.get("date") in dpos]
        if len(ks) < 5:
            continue
        ks.sort(key=lambda k: k["date"])
        # 稀疏对齐：数组下标 = 日期索引 − start，缺失交易日填 null 而不是 0
        start = dpos[ks[0]["date"]]
        end = dpos[ks[-1]["date"]]
        arr = [None] * (end - start + 1)
        for k in ks:
            arr[dpos[k["date"]] - start] = int(round((k.get("pct") or 0) * RET_SCALE))
        returns_out[c] = [start, arr]
        amt = [k.get("amount") or 0 for k in ks[-20:]]
        latest_out[c] = [
            round(float(ks[-1].get("close") or 0), 4),
            round(float(ks[-1].get("pct") or 0), 2),
            round(sum(amt) / len(amt) / 1e4, 2) if amt else 0,  # 近20日日均成交额（万元）
        ]

    # ---------- ETF 主表 ----------
    etfs = []
    for m in masters:
        if m["code"] not in returns_out:
            continue
        etfs.append([
            m["code"], m.get("name") or "", m.get("index_name") or "",
            ai.get(str(m.get("asset_class")), -1), li.get(str(m.get("layer")), -1),
            mi.get(str(m.get("mkt")), -1),
            [ti[t] for t in (m.get("tags") or []) if t in ti],
            m.get("fee"), round(float(m.get("scale_yi") or 0), 3) or None,
            m.get("vol_1y"), m.get("maxdd_1y"), m.get("ret_1y"),
            int(bool(m.get("leveraged"))),
            m.get("_coverage"), m.get("_report_date") or "",
        ])

    # 新闻单独成文件：更新频率比 ETF 特征高得多，拆开便于增量更新
    news_out = _pack_news()

    snap = {
        "meta": {
            "generated_at": date.today().isoformat(),
            "trade_date": ds.today(),
            "etf_count": len(etfs),
            "universe_size": len(ds.get_universe() or []),
            "algo_version": ALGO_VERSION,
            "ret_days": RET_DAYS,
            "ret_scale": RET_SCALE,
            "holding_scope": "季报/年报披露持仓（通常前十大重仓）",
            "news_count": len(news_out),
        },
        "config": {"alpha": ALPHA, "add_beta": ADD_BETA,
                   "risk_target_vol": RISK_TARGET_VOL, "hard_limits": HARD_LIMITS,
                   "goal_vectors": GOAL_VECTORS},
        "dict": {"asset": assets, "layer": layers, "mkt": mkts,
                 "tag": tag_list, "industry": industries},
        "dates": dates,
        "etfs": etfs,
        "holdings": holdings_out,
        "stocks": stocks_out,
        "returns": returns_out,
        "latest": latest_out,
        "news": news_out,
    }
    return snap


def _pack_news() -> list[list]:
    """新闻打包成紧凑数组，浏览器端只做集合运算，不做文本分析。

    [id, kind, title, summary, time, url, source, stocks, sectors, themes]
    """
    from . import news as news_mod
    try:
        news_mod.refresh_news()
    except Exception:
        pass
    from . import store as _store
    items = _store.load_news(limit=600)
    if not items:
        return []
    ki = {"快讯": 0, "文章": 1, "研报": 2}
    return [[it["id"], ki.get(it["kind"], 1), it["title"],
             (it.get("summary") or "")[:200], (it.get("time") or "")[5:16],
             it.get("url") or "", it.get("source") or "",
             it.get("stocks") or [], it.get("sectors") or [], it.get("themes") or []]
            for it in items]


def write_snapshot(snap: dict, outdir: Path | None = None) -> list[str]:
    outdir = outdir or SITE_DATA_DIR
    outdir.mkdir(parents=True, exist_ok=True)
    written = []

    # 主体（不含收益序列与新闻）先落盘，便于首屏快速加载
    core = {k: v for k, v in snap.items() if k not in ("returns", "news")}
    p = outdir / "snapshot.json"
    p.write_text(json.dumps(core, ensure_ascii=False, separators=(",", ":")),
                 encoding="utf-8")
    written.append(str(p))

    # 新闻单独成文件：更新频率高，且前端可异步加载，不阻塞首屏
    p3 = outdir / "news.json"
    p3.write_text(json.dumps({"news": snap.get("news") or []}, ensure_ascii=False,
                             separators=(",", ":")), encoding="utf-8")
    written.append(str(p3))
    return written


def size_mb(path: str) -> float:
    return round(Path(path).stat().st_size / 1024 / 1024, 2)
