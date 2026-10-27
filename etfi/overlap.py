"""持仓穿透与重叠度计算。

核心指标（方案 §4.2）：
    Overlap(A, B) = Σᵢ min(wᵢ,ᴀ, wᵢ,ʙ)

说明：公募 ETF 季报仅披露前十大重仓，半年报/年报披露全部持仓。
因此这里同时给出两个口径：
  · overlap_raw  —— 以「占基金净值比例」计的共同持仓规模，绝对值可比；
  · overlap_norm —— 用双方披露覆盖率归一化到 [0,1]，用于打分与横向比较。
两者都会在解释卡片中展示，绝不只报一个好看的数字。
"""
from __future__ import annotations

import math
from collections import defaultdict


def stock_weights(rows: list[dict]) -> dict[str, float]:
    """[{stock_code, weight}] -> {code: 权重（小数，占净值比例）}"""
    out: dict[str, float] = {}
    for r in rows or []:
        w = r.get("weight")
        c = r.get("stock_code")
        if not c or w is None:
            continue
        out[c] = out.get(c, 0.0) + float(w)
    return out


def total_coverage(w: dict[str, float]) -> float:
    return float(sum(w.values()))


def overlap_raw(a: dict[str, float], b: dict[str, float]) -> float:
    """Σ min(w_A, w_B)，占净值比例口径。"""
    if not a or not b:
        return None if (a is None or b is None) else 0.0
    keys = set(a) & set(b)
    return float(sum(min(a[k], b[k]) for k in keys))


def overlap_norm(a: dict[str, float], b: dict[str, float]) -> float | None:
    """归一化重叠度，取值 [0,1]。披露不足时返回 None（无法评估，不伪造）。"""
    if not a or not b:
        return None
    denom = min(total_coverage(a), total_coverage(b))
    if denom <= 0:
        return None
    return min(1.0, overlap_raw(a, b) / denom)


def portfolio_stock_weights(positions: list[dict],
                            holdings_map: dict[str, list[dict]]) -> dict[str, float]:
    """把组合穿透到个股：wᵢ = Σⱼ vⱼ · wᵢ,ⱼ。未披露持仓的 ETF 计为「未穿透」。"""
    out: dict[str, float] = defaultdict(float)
    for p in positions:
        v = float(p.get("weight") or 0.0)
        rows = holdings_map.get(p.get("code")) or []
        if not rows:
            continue
        for k, w in stock_weights(rows).items():
            out[k] += v * w
    return dict(out)


def exposure_gain(cand: dict[str, float], port: dict[str, float]) -> float | None:
    """候选 ETF 相对现有组合的「新增暴露」占比：Σ max(0, wᴇ − wᴘ) / Σ wᴇ。"""
    if not cand:
        return None
    base = total_coverage(cand)
    if base <= 0:
        return None
    gain = sum(max(0.0, cand.get(k, 0.0) - port.get(k, 0.0)) for k in cand)
    return min(1.0, gain / base)


def pairwise_overlap(codes: list[str],
                     holdings_map: dict[str, list[dict]]) -> list[dict]:
    """组合内部两两重叠，返回按重叠度降序的列表。"""
    ws = {c: stock_weights(holdings_map.get(c) or []) for c in codes}
    out = []
    for i in range(len(codes)):
        for j in range(i + 1, len(codes)):
            a, b = ws.get(codes[i]) or {}, ws.get(codes[j]) or {}
            if not a or not b:
                continue
            n = overlap_norm(a, b)
            if n is None:
                continue
            out.append({"a": codes[i], "b": codes[j], "overlap": round(n, 4),
                        "raw": round(overlap_raw(a, b), 4)})
    out.sort(key=lambda x: -x["overlap"])
    return out


def concentration(weights: list[float]) -> dict:
    """集中度：HHI、Top1/3/5 占比、有效持仓数。"""
    ws = sorted([w for w in weights if w and w > 0], reverse=True)
    if not ws:
        return {"hhi": None, "top1": None, "top3": None, "top5": None, "effective_n": None}
    s = sum(ws)
    ws = [w / s for w in ws] if s > 0 else ws
    hhi = sum(w * w for w in ws)
    return {
        "hhi": round(hhi, 4),
        "top1": round(ws[0], 4),
        "top3": round(sum(ws[:3]), 4),
        "top5": round(sum(ws[:5]), 4),
        "effective_n": round(1 / hhi, 2) if hhi > 0 else None,
    }


def sector_exposure(stock_w: dict[str, float],
                    industry_map: dict[str, str]) -> list[dict]:
    """把穿透后的个股权重按行业汇总并归一化。"""
    agg: dict[str, float] = defaultdict(float)
    unknown = 0.0
    for code, w in stock_w.items():
        ind = industry_map.get(code) or "未分类"
        if ind == "未分类":
            unknown += w
        agg[ind] += w
    tot = sum(agg.values())
    out = [{"sector": k, "weight": round(v / tot, 4) if tot else 0.0}
            for k, v in sorted(agg.items(), key=lambda x: -x[1])]
    return out


def returns_from_kline(kline: list[dict]) -> list[float]:
    return [k["pct"] / 100.0 for k in kline if k.get("pct") is not None]


def corr(a: list[float], b: list[float]) -> float | None:
    n = min(len(a), len(b))
    if n < 30:
        return None
    a, b = a[-n:], b[-n:]
    ma, mb = sum(a) / n, sum(b) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va <= 0 or vb <= 0:
        return None
    return cov / math.sqrt(va * vb)


def ann_vol(rets: list[float]) -> float | None:
    """年化波动率（%），按 252 个交易日。"""
    if len(rets) < 30:
        return None
    n = len(rets)
    m = sum(rets) / n
    var = sum((x - m) ** 2 for x in rets) / (n - 1)
    return round(math.sqrt(var * 252) * 100, 2)


def max_drawdown(kline: list[dict]) -> float | None:
    closes = [k["close"] for k in kline if k.get("close")]
    if len(closes) < 30:
        return None
    peak, mdd = closes[0], 0.0
    for c in closes:
        peak = max(peak, c)
        mdd = min(mdd, c / peak - 1)
    return round(mdd * 100, 2)
