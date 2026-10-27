# ETF Intelligence Platform

个性化 A 股 ETF 投资情报与匹配平台：投资者画像 → ETF 匹配 → 每日情报。

**在线版（GitHub Pages）**：https://chenluh1231-rgb.github.io/etf-intelligence-platform/
所有计算在浏览器本地完成，上传的持仓文件不会离开你的电脑。

**本地版（FastAPI + SQLite）**：`python server.py` 后访问 http://127.0.0.1:8770

## 组成

| 目录 | 说明 |
|---|---|
| `docs/` | GitHub Pages 静态站（三个入口：Dashboard / Discover & Match / Investor Profile） |
| `docs/match.js` | 浏览器端四阶段匹配引擎，与 `etfi/matching.py` 逐项对齐（见 `tools/verify_match.js`） |
| `etfi/` | Python 数据层：抓取、缓存、SQLite 8 表、画像、匹配、简报、Excel 报告 |
| `pipeline.py` | 生成静态快照（`docs/data/snapshot.json` + `returns.json`） |
| `server.py` | 本地 FastAPI 服务 |
| `analyze.py` | 命令行分析入口：`python analyze.py 持仓.csv --goals 长期增值,分散风险` |
| `tools/verify_match.js` | Node 一致性校验：同输入下 JS 与 Python 引擎结果应逐项一致 |

## 数据

来源：东方财富（天天基金）。全部接口封装在 `etfi/datasource.py`，带磁盘缓存与 TTL。

| 数据 | 更新频率 | 说明 |
|---|---|---|
| 全市场 ETF 清单 | 每日 | 天天基金全量基金清单过滤，约 1,768 只场内 ETF |
| 基本信息与规模 | 7 天 | 跟踪指数、费率、近 1 年波动/回撤 |
| 底层持仓 | 30 天 | 季报/年报披露持仓（通常前十大重仓） |
| 历史净值 | 每日 | 250 个交易日，用于相关性与边际风险 |
| 快讯 | 30 分钟 | 东财 7x24，带 `stockList`（约 8 成直接关联个股或 ETF 代码） |
| 资讯文章 | 30 分钟 | 东财搜索接口，按行业/主题关键词并发抓取，含摘要与来源 |
| 券商研报 | 30 分钟 | 行业/策略/宏观 + 个股，含机构名与原文链接 |

数据质量约定（方案 §4.3）：每份数据带 `data_date` / `fetched_at`，按各自真实频率缓存。
**持仓穿透为季报口径，覆盖率约 20%–60%，所有指标均标注口径，不冒充全持仓。**

## 相关快讯与文章（方案 §7.2 What Matters to You）

不是每天生成市场综述，而是从数百条全市场资讯里挑出与你有关的那一小撮。

相关度 = **成分股直连 50% + 行业暴露 30% + 关注主题 20%**，再按时间新鲜度衰减（72 小时衰减到 0.5）。
得分为 0 的直接丢弃，绝不凑数；找不到就如实说「未找到相关资讯」。

四个层级的命中信号，每条都能说出推给你的理由：

| 信号 | 说明 | 权重贡献 |
|---|---|---|
| 直接点名持仓 ETF | 快讯的 `stockList` 里出现你持有的 ETF 代码 | 满分直连 |
| 底层成分股直连 | 命中穿透后的重仓股（如「中际旭创净买入超 6 亿」） | 最强，3% 权重即满 |
| 组合行业暴露 | 命中组合的行业配置（如白酒、半导体） | 15% 暴露即满 |
| 关注主题 | 命中你勾选的主题（如高股息防御） | 命中 2 个即满 |

两个刻意的设计：

- **标签在服务端打好**（`etfi/news.py`），浏览器端只做集合运算，所以持仓文件始终不出本地。
- **新闻打标用收紧版词典**。ETF 名称很短，用「消费」「价值」这类宽泛词分类没问题；
  但新闻是自然语言，这些词几乎无处不在，会把「港股速报」误判成「高股息防御」。
  因此 `NEWS_SECTOR_KW` / `NEWS_THEME_KW` 只保留具象词，宁可少命中也不误命中。

## 每日更新

`.github/workflows/update-data.yml` 在每个交易日（北京时间 10:00）自动：
1. 重建 ETF 数据库（规模前 800 只）；
2. 生成快照 JSON 并提交到 `docs/data/`，GitHub Pages 随之更新；
3. 数据源不可用时保留上次快照（Actions cache 兜底）。

手动触发：仓库页面 Actions → 每日更新 ETF 数据快照 → Run workflow。

## 匹配算法（方案 §5）

四阶段：硬约束过滤（不可被高分抵消）→ 加权评分 `S = 100 × Σₖ αₖ·sₖ`（目标 30 / 偏好 20 / 互补 20 / 成本 15 / 风险 15）→ 组合增量价值（重叠度、新增暴露、相关性、边际风险 Δσ）→ 排序与解释。

原则：缺失维度不参与打分、其余权重重归一化；分数是特征适配度，**不是未来收益概率**。

输出双榜：**Best Match**（最符合目标）与 **Best Portfolio Addition**（对现有组合最有补充价值）。

## 本地开发

```bash
pip install -r requirements.txt
python pipeline.py --build       # 建库 + 生成快照（首次约 10–15 分钟）
python server.py                 # 本地完整版
node tools/verify_match.js       # 校验 JS 与 Python 引擎一致性
cd docs && python -m http.server 8000   # 仅静态站
```

## 边界

第一版不做 AI 选股、不做自动交易、不把每日涨跌转化为买卖建议。本平台仅供研究与教育用途，不构成投资建议。
