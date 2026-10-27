"""东方财富数据源封装。

数据层原则（方案 §4.3）：
  1. 每份数据都记录 data_date（数据日期）与 fetched_at（获取时间）；
  2. 按各自真实频率缓存，价格天天取、持仓按季取、费率半年取；
  3. 取不到就返回 None，由上层标记「无法评估」，不伪造数值。
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from .config import CACHE_DIR, HEADERS, MAX_WORKERS, REQ_TIMEOUT, TTL_DAYS, UA


class _Resp:
    """curl 返回结果的轻量封装，接口与 requests.Response 保持最小一致。"""

    def __init__(self, status_code: int, text: str):
        self.status_code = status_code
        self.text = text
        self.encoding = "utf-8"

    def json(self):
        return json.loads(self.text)


def _decode(raw: bytes) -> str:
    head = raw[:1024].lower()
    for enc in ("gbk", "gb2312", "gb18030"):
        if f"charset={enc}".encode() in head or f'charset="{enc}"'.encode() in head:
            return raw.decode(enc, errors="replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("gbk", errors="replace")


def _curl(url: str, referer: str | None, timeout: int) -> _Resp | None:
    """用 curl 抓取。本机 Python requests 经沙箱代理访问东财行情域名会被断开，
    curl 稳定可用，因此传输层统一走 curl。"""
    cmd = ["curl", "-sS", "-m", str(timeout), "-A", UA, "--compressed",
           "-w", "\n__HTTPCODE__%{http_code}"]
    if referer:
        cmd += ["-e", referer]
    cmd.append(url)
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout + 8)
    except Exception:
        return None
    if p.returncode != 0 and not p.stdout:
        return None
    raw = p.stdout
    txt = _decode(raw)
    m = re.search(r"__HTTPCODE__(\d+)\s*$", txt)
    if not m:
        return None
    return _Resp(int(m.group(1)), txt[:m.start()])


# ---------------------------------------------------------------- 缓存 ----
def _cache_path(kind: str, key: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(key))
    return CACHE_DIR / f"{kind}_{safe}.json"


def _cached(kind: str, key: str, fn):
    """带 TTL 的磁盘缓存。命中即返回，未命中则抓取并落盘。"""
    p = _cache_path(kind, key)
    ttl = TTL_DAYS.get(kind, 1)
    if p.exists():
        try:
            obj = json.loads(p.read_text(encoding="utf-8"))
            age = time.time() - obj.get("_fetched_at", 0)
            if age < ttl * 86400:
                return obj.get("data")
        except Exception:
            pass
    data = fn()
    if data:  # 空结果不落盘，避免一次失败把空数据缓存一整天
        try:
            p.write_text(json.dumps({"_fetched_at": time.time(), "data": data},
                                    ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
    return data


def _get(url: str, referer: str | None = None, retry: int = 2):
    for i in range(retry + 1):
        r = _curl(url, referer, REQ_TIMEOUT)
        if r is not None and r.status_code == 200:
            return r
        time.sleep(0.4 * (i + 1))
    return None


# ------------------------------------------------------- ETF 全市场列表 ----
def fetch_universe() -> list[dict]:
    """全市场场内 ETF 清单。

    数据源为天天基金全量基金清单（fundcode_search.js），场内 ETF 代码以 5（沪）或
    1（深）开头，且名称含 ETF、不含「联接」（联接基金是场外母基金，不是 ETF 本身）。
    该源比 push2 行情接口稳定，不受盘中限流影响。
    """
    r = _get("https://fund.eastmoney.com/js/fundcode_search.js",
             referer="https://fund.eastmoney.com/", )
    if not r:
        return []
    txt = r.text
    if txt.startswith("\ufeff"):
        txt = txt[1:]
    out = []
    for code, _py, name, ftype, _full in re.findall(
            r'\["(\d{6})","([A-Z0-9]+)","(.*?)","(.*?)","([A-Z0-9]*)"\]', txt):
        if code[0] not in "51":          # 场内 ETF：沪 5xxxxx / 深 1xxxxx
            continue
        up = name.upper()
        if "ETF" not in up:
            continue
        if "联接" in name:                # 排除 ETF 联接基金
            continue
        out.append({"code": code,
                    "market": 1 if code[0] == "5" else 0,
                    "name": name.strip(),
                    "price": None, "pct": None, "amount": None})
    return out


def get_universe(force: bool = False) -> list[dict]:
    fn = fetch_universe
    return _cached("universe", "all", fn) if not force else _force("universe", "all", fn)


def _force(kind, key, fn):
    p = _cache_path(kind, key)
    if p.exists():
        p.unlink()
    return _cached(kind, key, fn)


# --------------------------------------------------------- 基金基本信息 ----
def fetch_info(code: str) -> dict | None:
    url = ("https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation"
           f"?FCODE={code}&deviceid=1&plat=Android&product=EFund&version=1")
    r = _get(url)
    if not r:
        return None
    try:
        d = (r.json() or {}).get("Datas")
    except Exception:
        d = None
    if not d:
        return None
    return {
        "code": code,
        "name": d.get("SHORTNAME") or "",
        "ftype": d.get("FTYPE") or "",
        "company": d.get("JJGS") or "",
        "manager": d.get("JJJL") or "",
        "index_code": d.get("INDEXCODE") or "",
        "index_name": d.get("INDEXNAME") or "",
        "establish_date": (d.get("ESTABDATE") or "")[:10],
        "scale_yi": _div(d.get("ENDNAV"), 1e8),        # 期末净资产（亿元）
        "shares_yi": _div(d.get("FEGM"), 1e8),
        "nav": _num(d.get("DWJZ")),
        "nav_date": d.get("FSRQ") or "",
        "risk_level": _num(d.get("RISKLEVEL")),
        "ret_1y": _num(d.get("SYL_1N")),
        "ret_3y": _num(d.get("SYL_3N")),
        "ret_ytd": _num(d.get("SYL_JN")),
        "vol_1y": _num(d.get("STDDEV1")),              # 年化波动率 %
        "maxdd_1y": _num(d.get("MAXRETRA1")),          # 最大回撤 %
        "sharpe_1y": _num(d.get("SHARP1")),
        "top5": d.get("FUNDINVEST") or "",
    }


def get_info(code: str) -> dict | None:
    return _cached("info", code, lambda: fetch_info(code))


# ------------------------------------------------------------- 持仓穿透 ----
def fetch_holdings(code: str, topline: int = 50) -> dict | None:
    """季报/年报披露的底层持仓。返回 {report_date, rows:[{code,name,weight,...}]}"""
    url = ("https://fundf10.eastmoney.com/FundArchivesDatas.aspx"
           f"?type=jjcc&code={code}&topline={topline}&year=&month=&rt=0.1")
    r = _get(url, referer=f"https://fundf10.eastmoney.com/ccmx_{code}.html")
    if not r:
        return None
    txt = r.text
    m = re.search(r"截止至：<font[^>]*>(\d{4}-\d{2}-\d{2})</font>", txt)
    report_date = m.group(1) if m else ""
    tables = re.findall(r"<table[^>]*>(.*?)</table>", txt, re.S)
    if not tables:
        return None
    rows = []
    for tr in re.findall(r"<tr>(.*?)</tr>", tables[0], re.S):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        tds = [re.sub(r"<.*?>", "", t).strip() for t in tds]
        if len(tds) < 3:
            continue
        scode = next((t for t in tds if re.fullmatch(r"\d{6}", t)), None)
        if not scode:
            continue
        sname = next((t for t in tds if t and not re.fullmatch(r"[\d,\.%]+", t)
                      and t not in ("变动详情股吧行情",)), "")
        w = next((t for t in tds if re.fullmatch(r"\d+\.\d+%", t)), None)
        rows.append({
            "stock_code": scode,
            "stock_name": sname,
            "weight": _pct(w),
            "shares_wan": _num(next((t for t in tds if re.fullmatch(r"[\d,]+\.\d+", t)), None)),
            "value_wan": _num(tds[-1]) if tds else None,
        })
    if not rows:
        return None
    return {"report_date": report_date, "rows": rows, "n": len(rows)}


def get_holdings(code: str) -> dict | None:
    return _cached("holdings", code, lambda: fetch_holdings(code))


# ----------------------------------------------------------------- 费率 ----
def fetch_fee(code: str) -> dict | None:
    url = f"https://fundf10.eastmoney.com/jjfl_{code}.html"
    r = _get(url, referer=f"https://fundf10.eastmoney.com/jjfl_{code}.html")
    if not r:
        return None
    txt = re.sub(r"<.*?>", " ", r.text)
    mg = re.search(r"管理费率\s*([\d.]+)%", txt)
    cs = re.search(r"托管费率\s*([\d.]+)%", txt)
    sl = re.search(r"销售服务费率\s*([\d.]+)%", txt)
    if not mg:
        return None
    return {
        "code": code,
        "mgmt_fee": _num(mg.group(1)),
        "cust_fee": _num(cs.group(1)) if cs else None,
        "sales_fee": _num(sl.group(1)) if sl else None,
    }


def get_fee(code: str) -> dict | None:
    return _cached("fee", code, lambda: fetch_fee(code))


# ------------------------------------------------------------- 规模变动 ----
def fetch_scale_history(code: str) -> list[dict]:
    """期末净资产历史（来源：基金季报/年报，季度频率）。"""
    url = f"https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=gmbd&code={code}&page=1"
    r = _get(url, referer=f"https://fundf10.eastmoney.com/gmbd_{code}.html")
    if not r:
        return []
    out = []
    for tr in re.findall(r"<tr>(.*?)</tr>", r.text, re.S):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        tds = [re.sub(r"<.*?>", "", t).strip() for t in tds]
        if len(tds) < 5 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", tds[0]):
            continue
        # 只认四个季末日，避开成立日/转型日等特殊行
        if tds[0][5:] not in ("03-31", "06-30", "09-30", "12-31"):
            continue
        out.append({"date": tds[0], "nav_yi": _num(tds[4])})
    return out


def get_scale_history(code: str) -> list[dict]:
    return _cached("scale", code, lambda: fetch_scale_history(code)) or []


# ----------------------------------------------------------------- 行情 ----
def fetch_kline(code: str, market: int, days: int = 250) -> list[dict]:
    """历史净值序列（日期 / 单位净值 / 日涨跌幅）。

    主数据源为天天基金历史净值接口；该接口不返回成交额，因此 amount 为 None，
    流动性判断改用基金规模，并在解释卡片中标注成交额缺失。
    """
    url = ("https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList"
           f"?FCODE={code}&RANGE=y&pageIndex=1&pageSize={min(days, 300)}"
           "&deviceid=1&plat=Android&product=EFund&version=1")
    r = _get(url)
    if r:
        try:
            datas = r.json().get("Datas") or []
        except Exception:
            datas = []
        out = []
        for d in reversed(datas):          # 接口返回倒序，改为时间正序
            dt = d.get("FSRQ")
            if not dt:
                continue
            out.append({"date": dt, "open": _num(d.get("DWJZ")),
                        "close": _num(d.get("DWJZ")), "amount": None,
                        "amplitude": None, "pct": _num(d.get("JZZZL"))})
        if len(out) >= 30:
            return out
    return []


def get_kline(code: str, market: int, days: int = 250) -> list[dict]:
    return _cached("kline", f"{code}_{days}", lambda: fetch_kline(code, market, days)) or []


# ------------------------------------------------------------- 个股行业 ----
def fetch_industry(stock_code: str) -> str:
    """个股所属行业。主用 push2 行情接口，失败时回退到 F10 核心题材的所属板块。"""
    market = 1 if stock_code[0] in "56" else 0
    url = ("https://push2.eastmoney.com/api/qt/stock/get"
           f"?secid={market}.{stock_code}&fields=f57,f58,f127&fltt=2&invt=2")
    r = _get(url, referer="https://quote.eastmoney.com/")
    if r:
        try:
            v = (r.json()["data"] or {}).get("f127")
            if v and not str(v).replace(".", "").isdigit():
                return v
        except Exception:
            pass
    prefix = "SH" if market == 1 else "SZ"
    r = _get("https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax"
             f"?code={prefix}{stock_code}",
             referer="https://emweb.securities.eastmoney.com/")
    if r:
        try:
            bk = (r.json().get("ssbk") or [])
            if bk:
                return bk[0].get("BOARD_NAME") or ""
        except Exception:
            pass
    return ""


def get_industry(stock_code: str) -> str:
    return _cached("industry", stock_code, lambda: fetch_industry(stock_code)) or ""


def get_industries(codes: list[str]) -> dict[str, str]:
    codes = [c for c in dict.fromkeys(codes) if c]
    out = {}
    todo = []
    for c in codes:
        v = _cached("industry", c, None) if False else None
        todo.append(c)
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        res = list(ex.map(lambda c: (c, get_industry(c)), todo))
    out.update(dict(res))
    return out


# ----------------------------------------------------------------- 工具 ----
def _num(x):
    try:
        if x in (None, "", "-", "--"):
            return None
        return float(str(x).replace(",", ""))
    except Exception:
        return None


def _pct(x):
    try:
        return float(str(x).replace("%", "").replace(",", "")) / 100.0
    except Exception:
        return None


def _div(x, d):
    v = _num(x)
    return None if v is None else round(v / d, 4)


def parallel(fn, items, workers: int = MAX_WORKERS) -> list:
    """并发执行；单个任务抛异常时返回 None，避免整批失败。"""

    def _safe(x):
        try:
            return fn(x)
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(_safe, items))


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")
