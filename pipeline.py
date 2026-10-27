"""生成静态快照，供 GitHub Pages 前端使用（本地与 GitHub Actions 共用）。

    python pipeline.py            # 用现有数据库直接导出快照
    python pipeline.py --build    # 先重建 ETF 数据库再导出（Actions 每日任务用）
    python pipeline.py --limit 300  # 只导出规模最大的 N 只（控制体积）
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from etfi import snapshot as snap_mod  # noqa: E402
from etfi import store, warehouse      # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true", help="先重建 ETF 数据库")
    ap.add_argument("--limit", type=int, default=0, help="只导出规模前 N 只")
    ap.add_argument("--build-limit", type=int, default=800, help="建库取前 N 只")
    a = ap.parse_args()

    if a.build:
        t = time.time()
        print("建库中…", flush=True)
        r = warehouse.build_universe(limit=a.build_limit)
        print(f"  {r}  用时 {time.time() - t:.0f}s", flush=True)

    t = time.time()
    snap = snap_mod.build_snapshot(limit=a.limit)
    files = snap_mod.write_snapshot(snap)
    print(f"快照生成完毕（{time.time() - t:.1f}s）：")
    for f in files:
        print(f"  {f}  {snap_mod.size_mb(f)} MB")
    print(json.dumps(snap["meta"], ensure_ascii=False, indent=1))
    print(f"  ETF {len(snap['etfs'])} 只 · 有持仓穿透 {len(snap['holdings'])} 只 · "
          f"有收益序列 {len(snap['returns'])} 只 · 交易日 {len(snap['dates'])} 天")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
