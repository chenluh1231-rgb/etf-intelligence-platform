"""投资者画像引擎（方案 §3）。

严格区分三类信息来源，绝不混为一谈：
  · stated     用户明确表达的目标、偏好与约束；
  · revealed   用户实际持仓反推出的真实暴露；
  · behavioral 一段时间内可观测的行为规律（交易频率、持有期限）。

画像不能只靠问卷，也不能靠点击行为猜风险承受能力。三类分开记录、分开展示。
"""
from __future__ import annotations

from collections import defaultdict

from . import store
from .overlap import (concentration, pairwise_overlap, portfolio_stock_weights,
                      sector_exposure, stock_weights)
from .warehouse import ensure_holdings


def build_profile(user_id: str, stated: dict | None,
                  positions: list[dict]) -> dict:
    """生成投资者画像。持仓为空时仍可产出 stated 画像，但 revealed 标记为不可评估。"""
    stated = stated or {}
    codes = [p["code"] for p in positions if p.get("code")]
    masters = {m["code"]: m for m in store.load_etf_master(codes)}
    holdings = ensure_holdings(codes)
    hmap = {c: h["rows"] for c, h in holdings.items()}

    # ---------------- Revealed：从持仓反推 ----------------
    asset = defaultdict(float)
    layer = defaultdict(float)
    mkt = defaultdict(float)
    tags = defaultdict(float)
    fees, vols, dds = [], [], []
    missing_data = []

    for p in positions:
        v = float(p.get("weight") or 0.0)
        m = masters.get(p["code"])
        if not m:
            missing_data.append(p["code"])
            continue
        asset[m.get("asset_class") or "未分类"] += v
        layer[m.get("layer") or "未分类"] += v
        mkt[m.get("mkt") or "未分类"] += v
        for t in (m.get("tags") or []):
            tags[t] += v
        if m.get("fee") is not None:
            fees.append((v, m["fee"]))
        if m.get("vol_1y") is not None:
            vols.append((v, m["vol_1y"]))
        if m.get("maxdd_1y") is not None:
            dds.append((v, m["maxdd_1y"]))

    # 穿透到个股
    psw = portfolio_stock_weights(positions, hmap)
    ind_codes = list(psw.keys())
    from . import datasource as ds
    ind_map = ds.get_industries(ind_codes[:400]) if ind_codes else {}
    sec = sector_exposure(psw, ind_map)
    top_stocks = sorted(psw.items(), key=lambda x: -x[1])[:15]
    stock_names = {}
    for c, rows in hmap.items():
        for r in rows:
            stock_names[r["stock_code"]] = r.get("stock_name")

    coverages = []
    for c, h in holdings.items():
        sw = stock_weights(h["rows"])
        coverages.append(sum(sw.values()))

    revealed = {
        "n_positions": len(positions),
        "asset_allocation": _norm(asset),
        "layer_allocation": _norm(layer),
        "market_allocation": _norm(mkt),
        "tag_exposure": _norm(tags),
        "sector_exposure": sec[:12],
        "top_stocks": [{"code": k, "name": stock_names.get(k, ""), "weight": round(v, 4)}
                       for k, v in top_stocks],
        "weighted_fee": _wavg(fees),
        "weighted_vol_1y": _wavg(vols),
        "weighted_maxdd_1y": _wavg(dds),
        "concentration": concentration([float(p.get("weight") or 0) for p in positions]),
        "overlap_pairs": pairwise_overlap(codes, hmap)[:8],
        "penetration_coverage": round(sum(coverages) / len(coverages), 4) if coverages else None,
        "missing_etf_data": missing_data,
    }

    # ---------------- Behavioral：从可观测交易记录 ----------------
    behavioral = _behavioral(positions)

    # ---------------- 完整性 ----------------
    gaps = []
    filled = 0
    total = 6
    if stated.get("goals"):
        filled += 1
    else:
        gaps.append("未提供投资目标")
    if stated.get("risk"):
        filled += 1
    else:
        gaps.append("未提供风险容忍度")
    if stated.get("horizon_years") is not None:
        filled += 1
    else:
        gaps.append("未提供投资期限")
    if positions:
        filled += 1
    else:
        gaps.append("未上传持仓，无法计算组合增量价值")
    if behavioral.get("n_observed"):
        filled += 1
    else:
        gaps.append("缺少交易行为记录")
    if revealed["penetration_coverage"] and revealed["penetration_coverage"] > 0.05:
        filled += 1
    else:
        gaps.append("底层持仓数据不足，穿透分析受限")
    completeness = round(filled / total, 3)

    # 显式偏好与实际持仓的差异（方案 §2.3）
    divergence = _divergence(stated, revealed)

    profile = {
        "user_id": user_id,
        "stated": stated,
        "revealed": revealed,
        "behavioral": behavioral,
        "divergence": divergence,
        "gaps": gaps,
        "completeness": completeness,
        "data_date": ds.today(),
    }
    return profile


def _norm(d: dict) -> dict:
    s = sum(d.values())
    if s <= 0:
        return {}
    return {k: round(v / s, 4) for k, v in sorted(d.items(), key=lambda x: -x[1])}


def _wavg(pairs) -> float | None:
    tot = sum(w for w, _ in pairs)
    if not pairs or tot <= 0:
        return None
    return round(sum(w * v for w, v in pairs) / tot, 4)


def _behavioral(positions: list[dict]) -> dict:
    """从 buy_date / 份额变化推断可观测行为；无记录则明确返回空。"""
    dates = [p.get("buy_date") for p in positions if p.get("buy_date")]
    if not dates:
        return {"n_observed": 0, "note": "无交易日期记录"}
    parsed = []
    for d in dates:
        try:
            from datetime import date
            y, m, dd = [int(x) for x in str(d)[:10].split("-")]
            parsed.append(date(y, m, dd))
        except Exception:
            continue
    if not parsed:
        return {"n_observed": 0, "note": "交易日期无法解析"}
    from datetime import date
    today = date.today()
    holds = [(today - d).days for d in parsed]
    holds.sort()
    n = len(holds)
    return {
        "n_observed": n,
        "median_holding_days": holds[n // 2],
        "max_holding_days": holds[-1],
        "min_holding_days": holds[0],
        "patience": ("长期持有" if holds[n // 2] > 365
                     else "中期持有" if holds[n // 2] > 90 else "偏短期交易"),
        "note": "基于买入日期推断，仅作可观测行为记录，不等同于风险承受能力",
    }


def _divergence(stated: dict, revealed: dict) -> list[dict]:
    """显式表达与实际持仓之间的差异。"""
    out = []
    focus = stated.get("focus_themes") or stated.get("focus") or []
    if focus:
        tag_exp = revealed.get("tag_exposure") or {}
        for f in focus:
            w = tag_exp.get(f)
            if w is None:
                out.append({"item": f, "type": "关注但未持有",
                            "detail": f"关注的「{f}」在当前持仓中无对应暴露"})
            elif w < 0.05:
                out.append({"item": f, "type": "关注但占比很低",
                            "detail": f"关注的「{f}」仅占组合 {w:.1%}"})
    risk = stated.get("risk")
    vol = revealed.get("weighted_vol_1y")
    if risk and vol is not None:
        from .config import RISK_TARGET_VOL
        target = RISK_TARGET_VOL.get(risk)
        if target and abs(vol - target) / max(target, 1e-6) > 0.5:
            out.append({"item": "风险水平", "type": "风险错配",
                        "detail": f"自述「{risk}」对应目标波动约 {target}%，"
                                  f"实际组合加权波动约 {vol:.1f}%"})
    return out
