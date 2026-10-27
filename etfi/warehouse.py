"""ETF 数据仓库：建库与按需补全。

第一版策略：
  · 全市场 ETF 列表（1 个请求）先入库，得到代码与名称；
  · 再按成交额降序并发补全基本信息与费率，默认取前 N 只（覆盖绝大多数规模）；
  · 持仓与行情只在真正需要时（组合内 / 候选池内）拉取，避免 1600 只全量抓取。
"""
from __future__ import annotations

import json

from . import datasource as ds
from . import store
from .taxonomy import classify


def build_universe(limit: int = 800, progress=None) -> dict:
    """建立 ETF 基础数据库。返回统计信息。"""
    uni = ds.get_universe()
    if not uni:
        return {"ok": False, "msg": "ETF 列表获取失败"}
    all_codes = [u["code"] for u in uni]
    name_of = {u["code"]: u["name"] for u in uni}
    market_of = {u["code"]: u.get("market") or (1 if u["code"][0] in "56" else 0)
                 for u in uni}

    # 盘前成交额常为空，不能用它排序；先取基本信息拿到真实规模，再按规模降序取前 N
    infos = ds.parallel(lambda c: (c, ds.get_info(c)), all_codes, workers=16)
    infos = [(c, i) for c, i in infos if i]

    def _scale(item):
        return item[1].get("scale_yi") or 0

    infos.sort(key=_scale, reverse=True)
    picked = infos[:limit]
    codes = [c for c, _ in picked]

    # 基础表先落一份，保证即使详情抓取失败也有可筛选的最小集
    base = []
    for c, info in picked:
        cl = classify(info.get("name") or name_of.get(c, ""), info.get("index_name") or "")
        base.append({"code": c, "name": info.get("name") or name_of.get(c, ""),
                     "market": market_of.get(c, 1),
                     "asset_class": cl["asset_class"], "layer": cl["layer"],
                     "mkt": cl["market"], "tags": json.dumps(cl["tags"], ensure_ascii=False),
                     "size_style": (cl["size_style"] or [None])[0],
                     "leveraged": 1 if cl["leveraged"] else 0,
                     "data_date": ds.today(), "fetched_at": store.now()})
    store.upsert_etfs(base)

    def enrich(item):
        code, info = item
        fee = ds.get_fee(code)
        cl = classify(info.get("name") or "", info.get("index_name") or "", info.get("ftype") or "")
        return {
            "code": code,
            "name": info.get("name"),
            "market": market_of.get(code, 1),
            "company": info.get("company"),
            "index_code": info.get("index_code"),
            "index_name": info.get("index_name"),
            "asset_class": cl["asset_class"],
            "layer": cl["layer"],
            "mkt": cl["market"],
            "tags": json.dumps(cl["tags"], ensure_ascii=False),
            "size_style": (cl["size_style"] or [None])[0],
            "fee": (fee or {}).get("mgmt_fee"),
            "cust_fee": (fee or {}).get("cust_fee"),
            "scale_yi": info.get("scale_yi"),
            "vol_1y": info.get("vol_1y"),
            "maxdd_1y": info.get("maxdd_1y"),
            "ret_1y": info.get("ret_1y"),
            "ret_3y": info.get("ret_3y"),
            "establish_date": info.get("establish_date"),
            "leveraged": 1 if cl["leveraged"] else 0,
            "data_date": info.get("nav_date") or ds.today(),
            "fetched_at": store.now(),
        }

    recs = ds.parallel(enrich, picked, workers=14)
    recs = [r for r in recs if r]
    store.upsert_etfs(recs)
    return {"ok": True, "total_universe": len(uni), "enriched": len(recs),
            "in_db": store.etf_count()}


def ensure_holdings(codes: list[str]) -> dict[str, dict]:
    """按需拉取并持久化持仓，返回 {code: {report_date, rows}}。"""
    exist = store.load_holdings(codes)
    todo = [c for c in codes if c not in exist or not exist.get(c)]
    if todo:
        got = ds.parallel(lambda c: (c, ds.get_holdings(c)), todo, workers=8)
        for item in got:
            if not item:
                continue
            c, h = item
            if h and h.get("rows"):
                store.save_holdings(c, h["rows"], h.get("report_date", ""))
                exist[c] = [dict(r, report_date=h.get("report_date", "")) for r in h["rows"]]
    out = {}
    for c in codes:
        rows = exist.get(c) or []
        if rows:
            out[c] = {"report_date": rows[0].get("report_date") or "", "rows": rows}
    return out


def fetch_kline_map(codes: list[str], days: int = 250) -> dict[str, list[dict]]:
    markets = {}
    for r in store.load_etf_master(codes):
        markets[r["code"]] = r.get("market") or (1 if r["code"][0] in "56" else 0)
    res = ds.parallel(lambda c: (c, ds.get_kline(c, markets.get(c, 1), days)), codes, workers=10)
    return {c: k for c, k in res if k}
