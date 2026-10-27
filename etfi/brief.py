"""Daily ETF Intelligence（方案 §7）。

不是每天生成一篇市场综述，而是先判断「今天有没有真的值得你看的变化」：
    数据获取 → 质量检查 → 更新画像与特征 → 重算匹配 → 识别显著变化 → 生成简报
没有重要变化时，只输出一句话状态，不制造投资机会。
"""
from __future__ import annotations

import math
from datetime import date, datetime

from . import datasource as ds
from . import store
from .config import ALGO_VERSION
from .matching import run_matching
from .overlap import (ann_vol, concentration, max_drawdown, pairwise_overlap,
                      portfolio_stock_weights, returns_from_kline, stock_weights)
from .profile import build_profile
from .warehouse import ensure_holdings, fetch_kline_map

SIGNIFICANT_PCT = 1.5     # 单只 ETF 日内涨跌幅显著阈值（%）
SIGNIFICANT_MOVE = 0.8    # 组合日内涨跌幅显著阈值（%）
VOL_CHANGE_PCT = 20.0     # 波动率相对变化显著阈值（%）


def generate_brief(user_id: str, stated: dict | None = None,
                   positions: list[dict] | None = None,
                   with_matching: bool = True) -> dict:
    stated = stated or {}
    positions = positions or store.load_positions(user_id)
    profile = build_profile(user_id, stated, positions)
    td = ds.today()

    codes = [p["code"] for p in positions if p.get("code")]
    masters = {m["code"]: m for m in store.load_etf_master(codes)}
    kmap = fetch_kline_map(codes, days=250) if codes else {}

    # ---------------- 特征落库 ----------------
    feats = []
    for c in codes:
        k = kmap.get(c) or []
        if len(k) < 2:
            continue
        last = k[-1]
        amt20 = sum((x.get("amount") or 0) for x in k[-20:]) / max(1, min(20, len(k)))
        r20 = (k[-1]["close"] / k[max(0, len(k) - 21)]["close"] - 1) * 100 if len(k) > 21 and k[max(0, len(k) - 21)]["close"] else None
        v60 = ann_vol(returns_from_kline(k[-60:])) if len(k) >= 60 else None
        feats.append({"code": c, "trade_date": td, "close": last.get("close"),
                      "pct": last.get("pct"), "amount": last.get("amount"),
                      "amount_ma20": amt20, "ret_20d": round(r20, 2) if r20 else None,
                      "vol_60d": v60})
    store.save_features_daily(feats)

    prev_feat = _prev_features(codes, td)

    # ---------------- 1. Portfolio Pulse ----------------
    pulse = _portfolio_pulse(positions, kmap, masters)
    # ---------------- 2. What Matters to You ----------------
    matters = _what_matters(positions, masters, kmap, stated, profile)
    # ---------------- 3. Risk Radar ----------------
    risk = _risk_radar(positions, masters, kmap, prev_feat, profile)
    # ---------------- 4. ETF Radar ----------------
    radar = _etf_radar(stated, profile, codes)
    # ---------------- 5. Matching Updates ----------------
    changes = {}
    if with_matching and positions:
        res = run_matching(user_id, stated, positions, top_k=8)
        changes = res.get("matching_changes") or {}
        top_match = res.get("best_match") or []
    else:
        top_match = []

    signals = []
    if pulse.get("portfolio_pct") is not None and abs(pulse["portfolio_pct"]) >= SIGNIFICANT_MOVE:
        signals.append(f"组合当日变动 {pulse['portfolio_pct']:+.2f}%")
    for m in pulse.get("movers", [])[:3]:
        if abs(m["pct"]) >= SIGNIFICANT_PCT:
            signals.append(f"{m['name']} 当日 {m['pct']:+.2f}%")
    if risk.get("vol_changed"):
        signals.append("组合波动率出现明显变化")
    if changes.get("entered"):
        signals.append(f"{len(changes['entered'])} 只 ETF 新进入匹配前列")

    has_signal = bool(signals)
    as_of = (pulse or {}).get("as_of_date") or ""
    prefix = f"数据截至 {as_of}：" if as_of and as_of != td else ""
    headline = (prefix + "；".join(signals[:3]) + "。" if has_signal
                else (prefix or "") + "最新交易日组合未出现需要你特别处理的显著变化。")

    brief = {
        "user_id": user_id,
        "trade_date": td,
        "algo_version": ALGO_VERSION,
        "has_signal": has_signal,
        "headline": headline,
        "signals": signals,
        "portfolio_pulse": pulse,
        "what_matters": matters,
        "risk_radar": risk,
        "etf_radar": radar,
        "matching_updates": changes,
        "top_match": [{k: r.get(k) for k in ("rank", "code", "name", "score",
                                             "reasons", "mismatches")}
                      for r in top_match[:5]],
        "profile_completeness": profile.get("completeness"),
        "profile_gaps": profile.get("gaps"),
        "profile": profile,
        "disclaimer": "本简报为持仓与研究辅助信息，不构成任何证券买卖建议。",
    }
    store.save_brief(user_id, td, brief)
    return brief


# ------------------------------------------------------------- 模块 1 ----
def _portfolio_pulse(positions, kmap, masters) -> dict:
    rows, tot, last_date = [], 0.0, ""
    for p in positions:
        k = kmap.get(p["code"]) or []
        pct = k[-1].get("pct") if k else None
        if k and k[-1].get("date", "") > last_date:
            last_date = k[-1]["date"]
        w = float(p.get("weight") or 0)
        contrib = (pct or 0) * w
        tot += contrib
        rows.append({"code": p["code"], "name": (masters.get(p["code"]) or {}).get("name") or p.get("name"),
                     "weight": w, "pct": pct, "contribution": round(contrib, 4)})
    rows.sort(key=lambda r: -(abs(r["contribution"] or 0)))
    return {"portfolio_pct": round(tot, 3) if rows else None,
            "as_of_date": last_date,
            "holdings": rows,
            "movers": [r for r in rows if r["pct"] is not None][:5],
            "note": "组合当日变动按持仓权重加权估算，数值取自最新已披露净值交易日"}


# ------------------------------------------------------------- 模块 2 ----
def _what_matters(positions, masters, kmap, stated, profile) -> dict:
    out = {"etf_moves": [], "theme_watch": [], "notes": []}
    for p in positions:
        k = kmap.get(p["code"]) or []
        if len(k) < 2:
            continue
        pct = k[-1].get("pct") or 0
        if abs(pct) >= SIGNIFICANT_PCT:
            m = masters.get(p["code"]) or {}
            out["etf_moves"].append({
                "code": p["code"], "name": m.get("name") or p.get("name"),
                "pct": pct, "weight": p.get("weight"),
                "index_name": m.get("index_name") or "",
                "why": f"跟踪{m.get('index_name') or '对应指数'}" if m.get("index_name") else "",
            })
    out["etf_moves"].sort(key=lambda x: -abs(x["pct"]))

    focus = stated.get("focus_themes") or []
    if not focus:
        tag_exp = (profile.get("revealed") or {}).get("tag_exposure") or {}
        focus = [k for k, _ in sorted(tag_exp.items(), key=lambda x: -x[1])[:3]]
    if focus:
        allm = store.load_etf_master()
        hit = [m for m in allm if set(m.get("tags") or []) & set(focus)]
        hit.sort(key=lambda m: -((m.get("scale_yi") or 0)))
        out["theme_watch"] = [{"code": m["code"], "name": m["name"],
                               "tags": [t for t in (m.get("tags") or []) if t in focus],
                               "scale_yi": m.get("scale_yi"), "fee": m.get("fee")}
                              for m in hit[:8]]
        out["theme_focus"] = focus
    return out


# ------------------------------------------------------------- 模块 3 ----
def _risk_radar(positions, masters, kmap, prev_feat, profile) -> dict:
    codes = [p["code"] for p in positions]
    hmap = {c: h["rows"] for c, h in ensure_holdings(codes).items()}
    psw = portfolio_stock_weights(positions, hmap)
    pairs = pairwise_overlap(codes, hmap)[:5]
    names = {c: (masters.get(c) or {}).get("name") or c for c in codes}
    for x in pairs:
        x["a_name"] = names.get(x["a"], x["a"])
        x["b_name"] = names.get(x["b"], x["b"])

    weights = [float(p.get("weight") or 0) for p in positions]
    conc = concentration(weights)

    vol_changed, vol_detail = False, []
    for c in codes:
        cur = (kmap.get(c) or [])
        v = ann_vol(returns_from_kline(cur[-60:])) if len(cur) >= 60 else None
        pv = (prev_feat.get(c) or {}).get("vol_60d")
        if v and pv:
            chg = (v - pv) / pv * 100
            if abs(chg) >= VOL_CHANGE_PCT:
                vol_changed = True
                vol_detail.append({"code": c, "name": names.get(c), "vol_now": v,
                                   "vol_prev": pv, "change_pct": round(chg, 1)})
    if conc.get("hhi") and conc["hhi"] >= 0.25:
        vol_changed = vol_changed or True

    return {"concentration": conc,
            "top_overlap_pairs": pairs,
            "penetration_coverage": round(sum(psw.values()), 4),
            "vol_changed": vol_changed,
            "vol_detail": vol_detail,
            "sector_exposure": (profile.get("revealed") or {}).get("sector_exposure", [])[:10],
            "note": "重叠度基于季报披露持仓，仅反映共同持仓权重，不等于风险相关性"}


# ------------------------------------------------------------- 模块 4 ----
def _etf_radar(stated, profile, held_codes) -> dict:
    allm = store.load_etf_master()
    focus = stated.get("focus_themes") or []
    if not focus:
        tag_exp = (profile.get("revealed") or {}).get("tag_exposure") or {}
        focus = [k for k, _ in sorted(tag_exp.items(), key=lambda x: -x[1])[:3]]
    goals = stated.get("goals") or []

    new_list, low_fee = [], []
    today = date.today()
    for m in allm:
        if m["code"] in held_codes or not m.get("establish_date"):
            continue
        try:
            est = date(*[int(x) for x in m["establish_date"][:10].split("-")])
        except Exception:
            continue
        age = (today - est).days
        if 0 <= age <= 240 and (m.get("scale_yi") or 0) >= 2:
            hit = set(m.get("tags") or []) & set(focus)
            if hit or not focus:
                new_list.append({"code": m["code"], "name": m["name"], "age_days": age,
                                 "scale_yi": m.get("scale_yi"), "fee": m.get("fee"),
                                 "tags": list(hit) or (m.get("tags") or [])[:2],
                                 "index_name": m.get("index_name")})
    new_list.sort(key=lambda x: -(x.get("scale_yi") or 0))

    by_layer = {}
    for m in allm:
        if m.get("fee") is None or m.get("layer") in (None, "货币"):
            continue
        cur = by_layer.get(m["layer"])
        if cur is None or m["fee"] < cur["fee"]:
            by_layer[m["layer"]] = {"code": m["code"], "name": m["name"],
                                    "fee": m["fee"], "scale_yi": m.get("scale_yi"),
                                    "layer": m["layer"], "index_name": m.get("index_name")}
    low_fee = sorted([v for v in by_layer.values() if (v.get("scale_yi") or 0) >= 10],
                     key=lambda x: x["fee"])[:6]

    return {"new_products": new_list[:6], "low_fee_picks": low_fee,
            "focus_used": focus, "goals_used": goals,
            "note": "ETF Radar 仅呈现与你的关注标签或目标相关的产品变化，不做收益预测"}


# ------------------------------------------------------------- 工具 ----
def _prev_features(codes: list[str], td: str) -> dict:
    if not codes:
        return {}
    c = store.conn()
    out = {}
    for code in codes:
        r = c.execute("SELECT vol_60d, trade_date FROM etf_features_daily "
                      "WHERE code=? AND trade_date<? ORDER BY trade_date DESC LIMIT 1",
                      (code, td)).fetchone()
        if r:
            out[code] = {"vol_60d": r[0], "trade_date": r[1]}
    c.close()
    return out
