"""全局配置与常量。

所有可调参数集中在此，方便替换与实验；算法版本号会写入匹配快照，
用于追溯「为什么匹配结果发生变化」。
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
EXPORT_DIR = ROOT / "exports"
DB_PATH = DATA_DIR / "etf_intel.db"

for _p in (DATA_DIR, CACHE_DIR, EXPORT_DIR):
    _p.mkdir(parents=True, exist_ok=True)

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
HEADERS = {"User-Agent": UA, "Referer": "https://fundf10.eastmoney.com/"}

REQ_TIMEOUT = 20
MAX_WORKERS = 12

# 各类数据缓存天数。价格天天变，持仓按季变，费率几乎不变。
# 不能因为价格每天更新就假设底层持仓也实时变化（方案 §4.3）。
TTL_DAYS = {
    "universe": 1,
    "info": 7,
    "holdings": 30,
    "fee": 180,
    "scale": 30,
    "kline": 1,
    "industry": 180,
}

# 匹配评分权重（方案 §5.2 示例权重，尚未实证验证）
ALPHA = {
    "goal": 0.30,          # 投资目标适配
    "preference": 0.20,    # 产品与主题偏好
    "complement": 0.20,    # 组合互补性
    "cost": 0.15,          # 成本与交易条件
    "risk": 0.15,          # 风险特征适配
}

# Best Portfolio Addition 权重（方案 §5.3）
ADD_BETA = {
    "novelty": 0.35,       # 与现有组合的重叠惩罚
    "exposure": 0.25,      # 新增底层暴露
    "correlation": 0.20,   # 与组合的低相关收益
    "goal": 0.20,          # 仍需符合投资目标
}

# 风险容忍度 → 目标年化波动率（%）。用于风险特征适配打分。
RISK_TARGET_VOL = {"保守": 6.0, "稳健": 11.0, "平衡": 17.0, "积极": 24.0, "激进": 32.0}

# 候选池硬约束默认值（方案 §5.1 第一阶段）
HARD_LIMITS = {
    "min_scale_yi": 2.0,        # 期末净资产下限（亿元）
    "min_amount_wan": 500.0,    # 近 20 日日均成交额下限（万元）
    "max_fee": 1.5,             # 管理费率上限（%）
    "exclude_leverage": True,   # 排除杠杆/反向产品
    "min_list_days": 60,        # 上市满 N 个交易日
}

ALGO_VERSION = "v1.0.0-a"

# 数据新鲜度阈值（天）：超过则标记数据过期，不生成看似精确的分数
FRESHNESS = {"holdings": 180, "kline": 5, "info": 14}
