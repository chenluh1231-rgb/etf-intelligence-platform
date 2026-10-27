"""四阶段 Matching Engine（方案 §5）。

    Stage 1  Candidate Generation    —— 硬约束过滤（不可被高分抵消）
    Stage 2  Compatibility Scoring   —— S(u,e) = 100 × Σₖ αᵤ,ₖ · sₖ(u,e)
    Stage 3  Portfolio Incremental   —— 重叠、新增暴露、相关性、边际风险
    Stage 4  Ranking & Explanation   —— Best Match / Best Portfolio Addition + 解释卡片

原则：
  · 某个维度无法评估时，标记为缺失并重新归一化其余权重，而不是填 0 分或编造数值；
  · 明确的硬约束优先过滤，不允许高分抵消（方案 §5.2）；
  · 匹配分数不是未来收益概率。
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date

from . import datasource as ds
from . import store
from .config import (ADD_BETA, ALGO_VERSION, ALPHA, FRESHNESS, HARD_LIMITS,
                     RISK_TARGET_VOL)
from .overlap import (ann_vol, corr, exposure_gain, max_drawdown, overlap_norm,
                      overlap_raw, portfolio_stock_weights, returns_from_kline,
                      stock_weights)
from .profile import build_profile
from .warehouse import ensure_holdings, fetch_kline_map

# ---------------------------------------------------------------- 目标向量 ----
# 投资目标 → 期望的资产类别 / 产品层级 / 风格标签。数值为期望强度，用于可解释打分。
GOAL_VECTORS = {
    "长期增值": {
        "asset": {"境内股票": 1.0, "境外股票": 0.85, "债券": 0.15, "商品": 0.25, "货币": 0.0},
        "layer": {"宽基": 1.0, "策略因子": 0.85, "行业主题": 0.6, "境外宽基": 0.9, "债券": 0.1, "商品": 0.2},
        "tag": {"成长": 0.6, "大盘": 0.4, "质量": 0.4},
    },
    "稳定收入": {
        "asset": {"债券": 1.0, "境内股票": 0.6, "境外股票": 0.3, "商品": 0.2, "货币": 0.3},
        "layer": {"策略因子": 1.0, "宽基": 0.55, "债券": 0.85, "行业主题": 0.3},
        "tag": {"红利": 1.0, "低波": 0.8, "价值": 0.6, "央企国企": 0.5, "自由现金流": 0.5},
    },
    "分散风险": {
        "asset": {"债券": 1.0, "商品": 0.9, "境外股票": 0.9, "境内股票": 0.6, "货币": 0.4},
        "layer": {"宽基": 1.0, "债券": 0.9, "商品": 0.85, "境外宽基": 0.9, "行业主题": 0.2},
        "tag": {"低波": 0.8, "红利": 0.5, "ESG": 0.3},
    },
    "海外配置": {
        "asset": {"境外股票": 1.0, "商品": 0.4, "债券": 0.3, "境内股票": 0.3},
        "layer": {"境外宽基": 1.0, "行业主题": 0.5, "宽基": 0.35},
        "tag": {"出海全球化": 0.8, "科技自主": 0.2},
    },
    "主题机会": {
        "asset": {"境内股票": 1.0, "境外股票": 0.7, "债券": 0.05, "商品": 0.2},
        "layer": {"行业主题": 1.0, "策略因子": 0.5, "宽基": 0.25},
        "tag": {},
    },
}

SHORTLIST_SIZE = 100
DEFAULT_ADD_WEIGHT = 0.10   # 评估候选加入组合时的默认权重


# ============================================================== 主流程 ====
def run_matching(user_id: str, stated: dict | None, positions: list[dict],
                 top_k: int = 10, limits: dict | None = None,
                 shortlist_size: int = SHORTLIST_SIZE) -> dict:
    limits = {**HARD_LIMITS, **(limits or {})}
    stated = stated or {}
    profile = build_profile(user_id, stated, positions)

    masters = store.load_etf_master()
    if not masters:
        return {"ok": False, "msg": "ETF 数据库为空，请先执行建库", "profile": profile}
    held = {p["code"] for p in positions}

    # ---------- Stage 1：候选生成（硬约束） ----------
    uni_amount = {u["code"]: u.get("amount") for u in (ds.get_universe() or [])}
    allowed_assets = stated.get("asset_scope") or ["境内股票", "境外股票", "债券", "商品"]
    exclude_sectors = set((stated.get("constraints") or {}).get("exclude_sectors") or [])

    cands, filtered = [], defaultdict(int)
    for m in masters:
        c = m["code"]
        if c in held:
            filtered["已持有"] += 1
            continue
        if limits.get("exclude_leverage") and m.get("leveraged"):
            filtered["杠杆/反向"] += 1
            continue
        if m.get("asset_class") and m["asset_class"] not in allowed_assets:
            filtered["资产类别不符"] += 1
            continue
        if m.get("scale_yi") is not None and m["scale_yi"] < limits["min_scale_yi"]:
            filtered["规模过小"] += 1
            continue
        if m.get("fee") is not None and m["fee"] > limits["max_fee"]:
            filtered["费率过高"] += 1
            continue
        amt = uni_amount.get(c) or 0
        if amt and amt < limits["min_amount_wan"] * 1e4:
            filtered["成交额不足"] += 1
            continue
        if exclude_sectors and set(m.get("tags") or []) & exclude_sectors:
            filtered["行业被排除"] += 1
            continue
        cands.append(m)

    # ---------- Stage 2a：仅用元数据的快速打分，筛出待深算短名单 ----------
    ctx = _ScoringContext(profile, stated)
    for m in cands:
        m["_goal"] = ctx.goal_score(m)
        m["_pref"] = ctx.pref_score(m)
        m["_risk"] = ctx.risk_score(m)
        m["_cost_meta"] = ctx.cost_score(m, amount=uni_amount.get(m["code"]))
    cands.sort(key=lambda m: -(0.45 * (m["_goal"] or 0) + 0.25 * (m["_pref"] or 0)
                               + 0.15 * (m["_cost_meta"] or 0) + 0.15 * (m["_risk"] or 0)))
    shortlist = cands[:shortlist_size]

    # ---------- 组合侧：穿透、收益序列、波动 ----------
    port = _portfolio_context(positions, shortlist)

    # ---------- Stage 2b + 3：完整打分 ----------
    rows = []
    for m in shortlist:
        r = _score_candidate(m, ctx, port, stated)
        if r:
            rows.append(r)

    for r in rows:
        r["score"] = round(_blend(r["components"], ALPHA), 2)
    rows.sort(key=lambda r: -r["score"])
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    best_match = rows[:top_k]

    # ---------- Best Portfolio Addition ----------
    if port["available"]:
        for r in rows:
            r["addition_score"] = round(_addition_score(r, port), 2)
        additions = sorted([r for r in rows if r.get("addition_score") is not None],
                           key=lambda r: -r["addition_score"])[:top_k]
    else:
        additions = []
        for r in rows:
            r["addition_score"] = None

    # ---------- Stage 4：解释与可信度 ----------
    for r in rows:
        _explain(r, ctx, port, profile)

    out = {
        "ok": True,
        "algo_version": ALGO_VERSION,
        "trade_date": ds.today(),
        "n_candidates": len(cands),
        "n_shortlist": len(shortlist),
        "filtered": dict(filtered),
        "profile": profile,
        "portfolio": port["summary"],
        "best_match": [_public(r) for r in best_match],
        "best_addition": [_public(r) for r in additions],
        "portfolio_unavailable_reason": None if port["available"] else port["reason"],
    }
    _persist(user_id, out)
    return out


# ========================================================== 打分上下文 ====
class _ScoringContext:
    """把画像与目标翻译为每个维度的打分函数。"""

    def __init__(self, profile: dict, stated: dict):
        self.profile = profile
        self.stated = stated
        self.revealed = profile.get("revealed") or {}
        self.goals = stated.get("goals") or []
        self.risk = stated.get("risk")
        self.focus = stated.get("focus_themes") or []
        self.tag_exp = self.revealed.get("tag_exposure") or {}
        self.implicit_goal = not self.goals
        if self.risk:
            self.target_vol = RISK_TARGET_VOL.get(self.risk, 17.0)
        elif self.revealed.get("weighted_vol_1y"):
            self.target_vol = float(self.revealed["weighted_vol_1y"])
        else:
            self.target_vol = 17.0

    # --- 投资目标适配 ---
    def goal_score(self, m: dict) -> float | None:
        if self.goals:
            vals = []
            for g in self.goals:
                v = GOAL_VECTORS.get(g)
                if not v:
                    continue
                a = v["asset"].get(m.get("asset_class"), 0.0)
                l = v["layer"].get(m.get("layer"), 0.0)
                t = max([v["tag"].get(x, 0.0) for x in (m.get("tags") or [])] or [0.0])
                vals.append(0.55 * a + 0.30 * l + 0.15 * t)
            return _clip(sum(vals) / len(vals)) if vals else None
        # 未表达目标：用实际持仓结构作为隐性目标，并在解释中明确标注
        alloc = self.revealed.get("asset_allocation") or {}
        layer = self.revealed.get("layer_allocation") or {}
        if not alloc:
            return None
        a = alloc.get(m.get("asset_class"), 0.0)
        l = layer.get(m.get("layer"), 0.0)
        return _clip(0.6 * a + 0.4 * l)

    # --- 产品与主题偏好 ---
    def pref_score(self, m: dict) -> float | None:
        tags = set(m.get("tags") or [])
        if self.focus:
            hit = tags & set(self.focus)
            if not hit:
                return 0.0
            return _clip(0.7 + 0.3 * min(1.0, len(hit) / max(1, len(self.focus))))
        if not self.tag_exp:
            return None
        vals = [self.tag_exp.get(t, 0.0) for t in tags]
        if not vals:
            return 0.0
        return _clip(0.55 * max(vals) + 0.45 * (sum(vals) / len(vals)))

    # --- 风险特征适配 ---
    def risk_score(self, m: dict) -> float | None:
        vol = m.get("vol_1y")
        if vol is None:
            return None
        t = self.target_vol
        s = math.exp(-0.5 * ((vol - t) / (0.55 * t)) ** 2) if t > 0 else 0.5
        dd = m.get("maxdd_1y")
        if dd is not None and t > 0 and dd > 1.8 * t:
            s *= max(0.35, 1 - (dd - 1.8 * t) / (3 * t))
        return _clip(s)

    # --- 成本与交易条件 ---
    def cost_score(self, m: dict, amount: float | None = None) -> float | None:
        parts, ws = [], []
        if m.get("fee") is not None:
            parts.append(_clip(1 - m["fee"] / 1.2))
            ws.append(0.45)
        if m.get("scale_yi"):
            parts.append(_clip(math.log10(max(m["scale_yi"], 2) / 2) / math.log10(50)))
            ws.append(0.30)
        if amount:
            wan = amount / 1e4
            parts.append(_clip(math.log10(max(wan, 500) / 500) / math.log10(400)))
            ws.append(0.25)
        if not parts:
            return None
        tot = sum(ws)
        return _clip(sum(p * w for p, w in zip(parts, ws)) / tot)


# ======================================================= 组合侧上下文 ====
def _portfolio_context(positions: list[dict], shortlist: list[dict]) -> dict:
    codes = [p["code"] for p in positions if p.get("code")]
    if not positions:
        return {"available": False, "reason": "未提供持仓，无法计算对现有组合的增量价值",
                "stock_w": {}, "summary": {}, "rets": [], "vol": None, "kmap": {}}

    hmap = {c: h["rows"] for c, h in ensure_holdings(codes).items()}
    stock_w = portfolio_stock_weights(positions, hmap)

    need = codes + [m["code"] for m in shortlist]
    kmap = fetch_kline_map(list(dict.fromkeys(need)), days=250)

    port_dates, port_rets = _portfolio_returns(positions, kmap)
    vol = ann_vol(port_rets) if len(port_rets) >= 30 else None

    summary = {
        "n": len(positions),
        "weights": {p["code"]: p.get("weight") for p in positions},
        "vol_ann": vol,
        "maxdd": maxdd_from_returns(port_rets),
        "penetration_coverage": round(sum(stock_w.values()), 4),
        "n_days": len(port_rets),
    }
    return {"available": bool(port_rets) and vol is not None,
            "reason": "组合收益序列不足，无法计算边际风险" if not (port_rets and vol) else "",
            "stock_w": stock_w, "summary": summary, "rets": port_rets,
            "dates": port_dates, "vol": vol, "kmap": kmap}


def _portfolio_returns(positions: list[dict], kmap: dict):
    """按日期对齐，组合日收益 = Σ vⱼ · rⱼ。返回 (日期列表, 收益列表)。"""
    series = {}
    for p in positions:
        k = kmap.get(p["code"]) or []
        if not k:
            continue
        series[p["code"]] = {x["date"]: (x["pct"] or 0) / 100 for x in k}
    if not series:
        return [], []
    dates = None
    for d in series.values():
        dates = set(d) if dates is None else (dates & set(d))
    dates = sorted(dates or [])
    out = []
    used = []
    for d in dates:
        r = 0.0
        ok = True
        for p in positions:
            v = float(p.get("weight") or 0)
            s = series.get(p["code"])
            if s is None or d not in s:
                ok = False
                break
            r += v * s[d]
        if ok:
            out.append(r)
            used.append(d)
    return used, out


def maxdd_from_returns(rets: list[float]) -> float | None:
    """由收益序列构造净值曲线并计算最大回撤（%）。"""
    if len(rets) < 30:
        return None
    equity, cur = [], 1.0
    for r in rets:
        cur *= (1 + r)
        equity.append(cur)
    peak, mdd = equity[0], 0.0
    for v in equity:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1)
    return round(mdd * 100, 2)


def aligned_returns(kline: list[dict], dates: list[str]) -> list[float]:
    """按组合的交易日历对齐候选收益。

    不能直接按下标对齐：不同基金的净值发布日期可能差一天，错位一天会把相关系数算废。
    """
    m = {k["date"]: (k.get("pct") or 0) / 100 for k in kline or []}
    return [m[d] for d in dates if d in m]


# ========================================================== 单只打分 ====
def _score_candidate(m: dict, ctx: _ScoringContext, port: dict, stated: dict) -> dict | None:
    code = m["code"]
    goal = ctx.goal_score(m)
    pref = ctx.pref_score(m)
    risk = ctx.risk_score(m)
    cost = ctx.cost_score(m)

    kline = (port.get("kmap") or {}).get(code) or []
    # 必须与组合收益按同一套交易日配对：缺失日两边同时剔除，否则相关性会错位
    cmap = {k["date"]: (k.get("pct") or 0) / 100 for k in kline}
    cand_r, port_r = [], []
    for i, d in enumerate(port.get("dates") or []):
        if d in cmap:
            cand_r.append(cmap[d])
            port_r.append(port["rets"][i])
    rets = cand_r if len(cand_r) >= 30 else returns_from_kline(kline)
    vol_e = ann_vol(rets)
    if vol_e is None and m.get("vol_1y") is not None:
        vol_e = float(m["vol_1y"])
    if risk is None and vol_e is not None:
        risk = ctx.risk_score({**m, "vol_1y": vol_e})

    comp = None
    overlap_n = overlap_r = gain = None
    if port["available"]:
        hrows = (ensure_holdings([code]).get(code) or {}).get("rows") or []
        cw = stock_weights(hrows)
        if cw:
            overlap_n = overlap_norm(cw, port["stock_w"])
            overlap_r = overlap_raw(cw, port["stock_w"])
            gain = exposure_gain(cw, port["stock_w"])
        if overlap_n is not None:
            comp = _clip(0.6 * (1 - overlap_n) + 0.4 * (gain or 0))
            if not port["stock_w"]:
                comp = None

    # 流动性与费率等交易条件：用真实日均成交额再校正一次。
    # 注意：净值接口不返回成交额，此时 ma20 为 0，属「数据缺失」而非「零成交」，
    # 不能当成 0 分参与混合，否则会把成本维度无端打折。
    if kline:
        amt = [k.get("amount") or 0 for k in kline[-20:]]
        ma20 = sum(amt) / len(amt) if amt else 0
        if ma20 > 0:
            m["_amount_ma20"] = ma20
            liq = _clip(math.log10(max(ma20 / 1e4, 500) / 500) / math.log10(400))
            if cost is None:
                cost = liq
            else:
                cost = _clip(0.75 * cost + 0.25 * liq)

    # 边际风险
    dv = None
    rho = None
    if port["available"] and vol_e is not None and len(cand_r) >= 30:
        rho = corr(cand_r, port_r)
        dv = _marginal_vol(port["vol"], vol_e, rho, DEFAULT_ADD_WEIGHT)

    return {
        "code": code, "name": m.get("name"), "index_name": m.get("index_name"),
        "asset_class": m.get("asset_class"), "layer": m.get("layer"),
        "market": m.get("mkt"), "tags": m.get("tags") or [],
        "fee": m.get("fee"), "scale_yi": m.get("scale_yi"),
        "vol_1y": vol_e, "maxdd_1y": m.get("maxdd_1y"), "ret_1y": m.get("ret_1y"),
        "amount_ma20_wan": round((m.get("_amount_ma20") or 0) / 1e4, 2) if m.get("_amount_ma20") else None,
        "components": {"goal": goal, "preference": pref, "complement": comp,
                       "cost": cost, "risk": risk},
        "overlap_norm": overlap_n, "overlap_raw": overlap_r, "exposure_gain": gain,
        "corr_with_portfolio": rho, "marginal_vol_change_pct": dv,
        "report_date": (ensure_holdings([code]).get(code) or {}).get("report_date"),
    }


def _marginal_vol(sigma_p: float, sigma_e: float, rho: float | None,
                  w: float = DEFAULT_ADD_WEIGHT) -> float | None:
    """以权重 w 加入候选后的组合波动率变化（%）。ρ 缺失时保守取 0.6。"""
    if sigma_p is None or sigma_e is None:
        return None
    r = 0.6 if rho is None else rho
    new = math.sqrt((1 - w) ** 2 * sigma_p ** 2 + w ** 2 * sigma_e ** 2
                    + 2 * w * (1 - w) * r * sigma_p * sigma_e)
    return round((new - sigma_p) / sigma_p * 100, 2)


def _blend(comp: dict, alpha: dict) -> float:
    """缺失维度不参与，其余权重重新归一化。"""
    num = den = 0.0
    for k, a in alpha.items():
        v = comp.get(k)
        if v is None:
            continue
        num += a * float(v)
        den += a
    if den <= 0:
        return 0.0
    return num / den * 100


def _addition_score(r: dict, port: dict) -> float | None:
    novelty = None if r.get("overlap_norm") is None else 1 - r["overlap_norm"]
    gain = r.get("exposure_gain")
    rho = r.get("corr_with_portfolio")
    corr_gain = None if rho is None else _clip((1 - rho) / 2)
    goal = (r.get("components") or {}).get("goal")
    parts = [(ADD_BETA["novelty"], novelty), (ADD_BETA["exposure"], gain),
             (ADD_BETA["correlation"], corr_gain), (ADD_BETA["goal"], goal)]
    num = den = 0.0
    for w, v in parts:
        if v is None:
            continue
        num += w * v
        den += w
    if den <= 0:
        return None
    # 边际风险上升做温和惩罚
    dv = r.get("marginal_vol_change_pct")
    pen = 1.0
    if dv is not None and dv > 3:
        pen = max(0.7, 1 - (dv - 3) / 60)
    return num / den * 100 * pen


# ============================================================ 解释卡片 ====
def _explain(r: dict, ctx: _ScoringContext, port: dict, profile: dict):
    c = r["components"]
    reasons, mismatches = [], []

    if r.get("index_name"):
        reasons.append(f"跟踪{r['index_name']}，属{r.get('asset_class')}·{r.get('layer')}")
    if c.get("goal") is not None and c["goal"] >= 0.6:
        src = "匹配你设定的投资目标" if ctx.goals else "与你当前持仓结构一致（未设定目标，按实际持仓推断）"
        reasons.append(f"目标适配 {c['goal'] * 100:.0f} 分：{src}")
    if c.get("preference") is not None and c["preference"] >= 0.5:
        hit = [t for t in r.get("tags") or [] if t in (ctx.tag_exp or {}) or t in ctx.focus]
        if hit:
            reasons.append(f"命中关注标签：{'、'.join(hit[:4])}")
    if r.get("fee") is not None and r["fee"] <= 0.2:
        reasons.append(f"管理费率仅 {r['fee']:.2f}%，处于同类低位")
    if r.get("scale_yi") and r["scale_yi"] >= 50:
        reasons.append(f"规模 {r['scale_yi']:.0f} 亿元，流动性与清盘风险较好")
    if r.get("overlap_norm") is not None and r["overlap_norm"] <= 0.25:
        reasons.append(f"与你现有组合的底层重叠仅 {r['overlap_norm']:.0%}，分散效果好")
    if r.get("exposure_gain") is not None and r["exposure_gain"] >= 0.6:
        reasons.append(f"带来 {r['exposure_gain']:.0%} 的全新底层暴露")

    if r.get("overlap_norm") is not None and r["overlap_norm"] >= 0.5:
        mismatches.append(f"与现有组合底层重叠高达 {r['overlap_norm']:.0%}，"
                          f"共同持仓占净值 {r.get('overlap_raw', 0):.2%}，增量有限")
    if r.get("fee") is not None and r["fee"] >= 0.6:
        mismatches.append(f"管理费率 {r['fee']:.2f}% 偏高，长期持有成本需考虑")
    if r.get("scale_yi") is not None and r["scale_yi"] < 5:
        mismatches.append(f"规模仅 {r['scale_yi']:.2f} 亿元，存在流动性与清盘风险")
    if r.get("maxdd_1y") is not None and ctx.target_vol and r["maxdd_1y"] > 1.8 * ctx.target_vol:
        mismatches.append(f"近一年最大回撤 {r['maxdd_1y']:.1f}%，高于「{ctx.risk or '当前'}」"
                          f"风险水平对应的容忍区间")
    if r.get("corr_with_portfolio") is not None and r["corr_with_portfolio"] >= 0.85:
        mismatches.append(f"与组合日收益相关性 {r['corr_with_portfolio']:.2f}，分散作用有限")
    if r.get("marginal_vol_change_pct") is not None and r["marginal_vol_change_pct"] > 3:
        mismatches.append(f"按 {DEFAULT_ADD_WEIGHT:.0%} 权重加入后，组合波动率上升 "
                          f"{r['marginal_vol_change_pct']:.1f}%")
    if r.get("amount_ma20_wan") is not None and r["amount_ma20_wan"] < 1000:
        mismatches.append(f"近 20 日日均成交额 {r['amount_ma20_wan']:.0f} 万元，"
                          f"大额资金需注意冲击成本")

    missing = [k for k, v in c.items() if v is None]
    rd = r.get("report_date") or ""
    age = None
    if rd:
        try:
            age = (date.today() - date(*[int(x) for x in rd.split("-")])).days
        except Exception:
            age = None
    fresh = age is not None and age <= FRESHNESS["holdings"]
    level = "高"
    if profile.get("completeness", 0) < 0.4 or not fresh or missing:
        level = "中"
    if profile.get("completeness", 0) < 0.25 or (port["available"] and r.get("overlap_norm") is None):
        level = "低"

    r["reasons"] = reasons[:5]
    r["mismatches"] = mismatches[:5]
    r["confidence"] = {
        "level": level,
        "profile_completeness": profile.get("completeness"),
        "profile_gaps": profile.get("gaps") or [],
        "holdings_report_date": rd or None,
        "holdings_age_days": age,
        "holdings_fresh": bool(fresh),
        "dimensions_missing": missing,
        "note": "匹配分数为特征适配度，不是未来收益概率",
    }


def _public(r: dict) -> dict:
    keys = ["rank", "code", "name", "index_name", "asset_class", "layer", "market",
            "tags", "fee", "scale_yi", "vol_1y", "maxdd_1y", "ret_1y",
            "amount_ma20_wan", "components", "score", "addition_score",
            "overlap_norm", "overlap_raw", "exposure_gain", "corr_with_portfolio",
            "marginal_vol_change_pct", "report_date", "reasons", "mismatches", "confidence"]
    return {k: r.get(k) for k in keys}


# ============================================================== 持久化 ====
def _persist(user_id: str, out: dict):
    if not out.get("ok"):
        return
    td = out["trade_date"]
    store.save_profile(user_id, out["profile"])
    rows = []
    for r in out["best_match"]:
        rows.append({"result_type": "best_match", "rank": r["rank"], "code": r["code"],
                     "name": r["name"], "score": r["score"],
                     "components": r["components"], "reasons": r["reasons"],
                     "mismatches": r["mismatches"], "confidence": r["confidence"]})
    for i, r in enumerate(out["best_addition"], 1):
        rows.append({"result_type": "best_addition", "rank": i, "code": r["code"],
                     "name": r["name"], "score": r["addition_score"],
                     "components": r["components"], "reasons": r["reasons"],
                     "mismatches": r["mismatches"], "confidence": r["confidence"]})
    store.save_matching(user_id, td, ALGO_VERSION, rows)
    store.save_brief  # noqa
    out["persisted"] = True
    # 与上一快照比较，产出匹配变化事件
    _diff_snapshots(user_id, td, out)


def _diff_snapshots(user_id: str, td: str, out: dict):
    hist = store.load_matching(user_id)
    prev_dates = sorted({r["trade_date"] for r in hist if r["trade_date"] != td}, reverse=True)
    if not prev_dates:
        return
    prev = {r["code"]: r for r in hist if r["trade_date"] == prev_dates[0]
            and r["result_type"] == "best_match"}
    cur = {r["code"]: r for r in out["best_match"]}
    entered = [c for c in cur if c not in prev]
    exited = [c for c in prev if c not in cur]
    for c in entered[:5]:
        store.save_event(user_id, td, "matching_enter", c,
                         {"name": cur[c]["name"], "score": cur[c]["score"]})
    for c in exited[:5]:
        store.save_event(user_id, td, "matching_exit", c, {"name": prev[c]["name"]})
    out["matching_changes"] = {
        "baseline_date": prev_dates[0],
        "entered": [{"code": c, "name": cur[c]["name"], "score": cur[c]["score"]} for c in entered[:5]],
        "exited": [{"code": c, "name": prev[c]["name"]} for c in exited[:5]],
    }


def _clip(x) -> float:
    try:
        return max(0.0, min(1.0, float(x)))
    except Exception:
        return 0.0
