"""命令行分析入口：上传自己的 CSV → 画像 + 匹配 + 每日情报 + Excel 报告。

用法：
    python analyze.py ~/Desktop/我的持仓.csv
    python analyze.py 持仓.csv --goals 长期增值,分散风险 --risk 平衡 --horizon 5 --themes 人工智能,高股息防御
    python analyze.py 持仓.csv --top 10 --no-export

CSV 要求（列名容错，逗号或制表符分隔，UTF-8/GBK 均可）：
    必填：代码列（代码 / 证券代码 / 基金代码 / code / ticker / symbol），6 位数字
    可选：权重（权重 / 占比 / 仓位，支持 12.5% 或 0.125）
          市值（市值 / 持仓市值 / market_value，无权重时按市值自动归一化）
          成本价、份额、买入日期（用于行为特征与盈亏）
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from etfi import brief as brief_mod          # noqa: E402
from etfi import matching as match_mod       # noqa: E402
from etfi import report as report_mod        # noqa: E402
from etfi import store                       # noqa: E402
from etfi.profile import build_profile       # noqa: E402
from server import parse_csv                 # noqa: E402


def read_text(path: str) -> str:
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "gbk", "utf-8", "latin-1"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", errors="ignore")


def pct(x, nd=2):
    return "—" if x is None else f"{x * 100:.{nd}f}%" if abs(x) <= 1.5 else f"{x:.{nd}f}%"


def main() -> int:
    ap = argparse.ArgumentParser(description="ETF 持仓分析")
    ap.add_argument("csv", help="持仓 CSV 路径")
    ap.add_argument("--user", default="me", help="用户标识，默认 me")
    ap.add_argument("--goals", default="", help="投资目标，逗号分隔，如 长期增值,分散风险")
    ap.add_argument("--risk", default="", help="风险偏好：保守 / 平衡 / 进取")
    ap.add_argument("--horizon", type=int, default=0, help="投资期限（年）")
    ap.add_argument("--themes", default="", help="关注主题，逗号分隔，如 人工智能,高股息防御")
    ap.add_argument("--top", type=int, default=10, help="匹配结果条数")
    ap.add_argument("--no-export", action="store_true", help="不导出 Excel")
    a = ap.parse_args()

    path = Path(a.csv).expanduser()
    if not path.exists():
        print(f"[错误] 文件不存在：{path}")
        return 1

    rows = parse_csv(read_text(str(path)))
    if not rows:
        print("[错误] 未解析出有效持仓。请确认有一列为 6 位基金代码。")
        return 1
    store.save_positions(a.user, rows)

    stated = {
        "goals": [g.strip() for g in a.goals.split(",") if g.strip()],
        "risk": a.risk.strip(),
        "horizon_years": a.horizon or None,
        "focus_themes": [t.strip() for t in a.themes.split(",") if t.strip()],
    }
    print(f"解析到 {len(rows)} 只 ETF：")
    for r in sorted(rows, key=lambda x: -(x.get("weight") or 0)):
        print(f"  {r['code']}  {r.get('name') or '':<16} 权重 {pct(r.get('weight'))}")
    print()

    print("=" * 70)
    print("【一】投资者画像")
    prof = build_profile(a.user, stated, rows)
    print(json.dumps(prof, ensure_ascii=False, indent=1)[:2200])
    print()

    print("=" * 70)
    print("【二】Matching 结果")
    m = match_mod.run_matching(a.user, stated, rows, top_k=a.top)
    print("组合：", json.dumps(m.get("portfolio"), ensure_ascii=False))
    print(f"候选 {m.get('n_candidates')} → 打分 {m.get('n_shortlist')}，过滤 {m.get('filtered')}")
    print("\n-- Best Match（最符合目标）--")
    for r in m.get("best_match", [])[:a.top]:
        c = r["components"]
        print(f"{r['rank']:>2}. {r['code']} {r['name']}  综合 {r['score']}")
        print(f"    目标 {c['goal']} 偏好 {c['preference']} 互补 {c['complement']} "
              f"成本 {c['cost']} 风险 {c['risk']} | 重叠 {r['overlap_norm']} "
              f"相关性 {r['corr_with_portfolio']} Δσ {r['marginal_vol_change_pct']}")
        for x in r["reasons"][:3]:
            print(f"    + {x}")
        for x in r["mismatches"][:2]:
            print(f"    - {x}")
    print("\n-- Best Portfolio Addition（对现有组合最有补充价值）--")
    for r in m.get("best_addition", [])[:a.top]:
        print(f"    {r['code']} {r['name']}  增量分 {r['addition_score']} "
              f"重叠 {r['overlap_norm']} 新暴露 {r['exposure_gain']} "
              f"相关性 {r['corr_with_portfolio']} Δσ {r['marginal_vol_change_pct']}")
    print()

    print("=" * 70)
    print("【三】每日情报")
    b = brief_mod.generate_brief(a.user, stated, rows, with_matching=False)
    print("头条：", b["headline"])
    for s in b["signals"]:
        print("  •", s)
    print("\n风险雷达：", json.dumps(b["risk_radar"].get("concentration"), ensure_ascii=False))
    for p in b["risk_radar"].get("top_overlap_pairs", [])[:5]:
        print(f"  重叠 {p['overlap']:.3f}  {p['a_name']} × {p['b_name']}")
    print("行业暴露：", [(s["sector"], s["weight"]) for s in b["risk_radar"].get("sector_exposure", [])[:8]])
    print("画像缺口：", b.get("profile_gaps"))
    print()

    if not a.no_export:
        fp = report_mod.export(a.user, prof, m, b)
        print("=" * 70)
        print(f"Excel 报告：{fp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
