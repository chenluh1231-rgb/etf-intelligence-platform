# 交接说明 · ETF Intelligence Platform

给接手这个项目的 Agent / 人。读完这份文档 + 下面「可直接复制的接手 Prompt」，
就能在不问任何问题的情况下继续改这个项目。

- 本地路径：`/Users/acturus/WorkBuddy/2026-10-27-08-51-55/etf-intel`
- GitHub：`chenluh1231-rgb/etf-intelligence-platform`
- 线上站（GitHub Pages）：https://chenluh1231-rgb.github.io/etf-intelligence-platform/
- 当前静态资源版本：`?v=20261028a`

---

## 1. 这个项目是什么

A 股 ETF 的个性化匹配与每日情报工具。用户上传持仓（手动 / 截图 OCR），
系统在 790 只 ETF 里做四阶段匹配，输出：持仓画像（穿透到个股）、风险雷达、
每日简报、相关快讯、候选 ETF 及理由。**只做研究辅助，不做投资建议。**

## 2. 架构：两套前端，计算逻辑是重复实现

| | `docs/` | `web/` |
|---|---|---|
| 形态 | 纯静态站（GitHub Pages，**用户主要用这个**） | FastAPI 本地服务（`server.py`，127.0.0.1:8770） |
| 计算 | 浏览器内 `docs/match.js`（`ETFEngine`，845 行） | 后端 `etfi/*.py`（`matching.py` / `profile.py` / `brief.py`） |
| 持仓 | localStorage `etfi.positions.v1` | SQLite + `/api/positions/{uid}` |

**`match.js` 是 `etfi/matching.py` 的 JS 移植，公式必须一一对应。**
改任何计算逻辑或文案，两边都要改，否则两个版本会算得不一样。
（`web/` 的前端是简化版，Dashboard 的很多模块它还没有，改前先 grep 确认有没有对应代码。）

用户口头说的页面名（"Dashboard · 每日情报"、"Discover & Match"）是 **docs 版**的 tab 名，
web 版对应的叫"Dashboard · 我的每日 ETF 情报"。据此判断他在说哪个版本。

## 3. 数据链路

```
东方财富/天天基金 API
  → warehouse.build_universe(limit=800)      # 按规模取前 800 只入库 SQLite(data/)
  → snapshot.build_snapshot()                # 特征 + 持仓穿透 + 收益序列打包
  → docs/data/{snapshot.json, news.json}     # 静态站读这三个文件（+ returns.json）
```

- 本地重跑：`python pipeline.py`（只导出）/ `python pipeline.py --build`（重建库再导出）
- CI：`.github/workflows/update-data.yml`，工作日 UTC 02:00（北京 10:00）自动跑，
  并自动 commit 回仓库；`etfi/**` 或 `pipeline.py` 有 push 也会触发。
- 前端加载（`docs/app.js` boot）：先 `snapshot.json`，再异步 `returns.json` + `news.json`。
- 只数漏斗：全市场 1769 → 按规模取前 800 → 丢弃 K 线不足 5 日的 → **790**。
  规模覆盖约 97.6%，漏掉的都是长尾迷你基金，这是有意设计。

## 4. 改完代码必须做的三件事（缺一不可）

1. **bump 版本号**：`docs/index.html` 里所有 `?v=YYYYMMDDx`（style.css、terms.js、
   ocr.js、match.js、app.js）。不加版本号 = 用户浏览器命中 CDN 缓存，**改了等于没改**。
2. **commit + push**。沙箱代理常对 github.com 502，用系统代理：
   ```
   git -c http.proxy=http://127.0.0.1:10808 -c https.proxy=http://127.0.0.1:10808 push origin main
   ```
   被 rejected 是因为 CI 自动提交了快照 → 先 `git ... pull --rebase origin main` 再 push。
3. **curl 抽检线上**（Pages + CDN 有约 1–2 分钟延迟，延后检查确认）：
   ```
   curl -s https://chenluh1231-rgb.github.io/etf-intelligence-platform/app.js | grep -c "关键词"
   ```
   然后把线上网址给用户。**只改本地 = 用户看不到。**

## 5. 已知坑（按踩过的次数排序）

1. **两个异步资源各自重建引擎 = 竞态**。returns.json 与 news.json 加载完谁后到谁建引擎，
   后到的会冲掉先到的数据（表现为"快讯时有时无"）。已统一走 `rebuildEngine()`，
   用 `RET_OK/NEWS_OK` 标志，两次都带上全部数据。**不要绕过它再 new Engine。**
2. **CSS 优先级**：`.mcard .score span{display:block}`（0,2,1）会盖掉嵌套进来的
   `.tipb{display:none}`（0,1,0），导致术语气泡常驻显示。给容器内 span 写样式的宽泛
   后代选择器，会误伤嵌套组件内部元素。已改 `.score > span`。
3. **`<span>` 是行内元素**，width/height 不生效。`.bar-fill` 必须 `display:block`，
   否则条形图永不渲染。
4. **`[hidden]` 会被 `display:flex` 覆盖**，需要 `.posbar[hidden]{display:none!important}`。
5. **`termHTML(label, key)`**：第一个参数是显示文案，第二个才是查表键。写反了查不到，
   静默降级成纯文本，不报错。
6. **天天基金净值接口不返回成交额** → `amount` 恒 None → 原"近20日均额"恒 0。
   前端已改用「最新规模(亿)」作流动性替代指标（20261028a）。要恢复真实成交额，
   可换东财 `push2his` K 线接口（klines 自带成交额字段）。
7. **穿透覆盖率系统性偏低**：快照为压体积把成分股权重取整到 1%（<0.5% 记 0），
   实测均值约 0.478。改这条要重跑 build + snapshot。
8. **收益序列缺失交易日填 null 而非 0**；组合层已过滤，相关性需 ≥30 个共同样本。
9. **穿透覆盖率是各 ETF 的简单平均**，不是按权重加权（用户确认过的口径）。
10. Bash 里 `grep` 对中文 pattern 会失灵，搜中文一律用 Grep 工具。

## 6. 用户偏好（这个项目内）

- 交付物中文输出、中文注释；术语注释写清「是什么 + 怎么算 + 口径限制」三段。
- 改动倾向"只改措辞、不动结构"：先确认是否涉及结构再动手。
- 头条不能变成单只 ETF 的涨跌幅播报 → 单只必须带"拉动/拖累组合 X 个百分点"。
- 讨厌机翻腔（"无对应暴露"这类），用词要像中文母语者写的。
- 图表/表格优先，不要纯文字论证；涨红跌绿。
- 每次改完都要同步线上并把网址给他。

## 7. 已修复的缺陷：returns.json 从未随快照更新（2026-10-28 修复）

`snapshot.write_snapshot()` 原先只写 `snapshot.json` 和 `news.json`，
而前端的收益序列（相关性、分散化收益、组合波动、最大回撤）全部来自 `returns.json`
（初始 Engine 传 `{dates, returns:{}}`，收益只能由 RET 补齐）。
该文件只有首次提交，实测停在 2026-10-26，而快照已到 10-28 ——
**当日涨跌是新数据、收益序列是旧数据**，且会越拖越旧。

修法：`write_snapshot()` 增加把 `{"dates", "returns"}` 落盘为 `docs/data/returns.json`
（约 1.06MB），从此与 snapshot.json 同一次导出生成，日期轴必然一致。

校验方式（每次跑完 pipeline 都应确认这两件事）：
1. `returns.json.dates` 与 `snapshot.json.dates` **必须完全相等**——
   前端 `Engine` 用 `ret.dates` 建日期索引，两个文件日期轴不一致会导致收益错位。
2. `returns.json` 的 ETF 数与 `snapshot.json` 的 `etf_count` 相等。

## 8. 可直接复制的接手 Prompt

把下面这段贴给新的 Agent 即可：

```
接手 A 股 ETF 情报平台项目，本地路径 /Users/acturus/WorkBuddy/2026-10-27-08-51-55/etf-intel，
线上 https://chenluh1231-rgb.github.io/etf-intelligence-platform/。
开工前请先读 /Users/acturus/WorkBuddy/2026-10-27-08-51-55/etf-intel/HANDOFF.md 和
项目记忆 .workbuddy/memory/MEMORY.md 与最近几天的日志，特别是「已知坑」那一节。

项目要点：
1. 两套前端必须同步改：docs/ 是 GitHub Pages 静态站（用户主要用这个），
   计算在浏览器内的 docs/match.js；web/ 是 FastAPI 版，计算在 etfi/*.py。
   match.js 是 etfi/matching.py 的 JS 移植，公式要一一对应。
2. 每次改完必须：① 给 docs/index.html 里所有资源 ?v= 版本号 bump（否则用户命中缓存看不到）；
   ② commit + push（沙箱代理 502 时用
   git -c http.proxy=http://127.0.0.1:10808 -c https.proxy=http://127.0.0.1:10808 push origin main，
   被 reject 就先 pull --rebase，因为 CI 会自动提交数据快照）；
   ③ curl 抽检线上内容确认部署生效（Pages 有 1–2 分钟延迟），然后把网址给用户。
3. 已知坑里最常被踩的：引擎重建竞态（必须走 rebuildEngine）、CSS 优先级打穿嵌套气泡、
   span 是行内元素不认宽高、termHTML(label, key) 参数顺序、
   天天基金接口不返回成交额所以流动性指标改用最新规模。
4. 用户偏好：中文输出与中文注释；术语注释写「是什么/怎么算/口径限制」三段；
   先确认是否涉及结构再动手（倾向只改措辞）；讨厌机翻腔；图表表格优先；涨红跌绿。
5. 已知的待修缺陷：docs/data/returns.json 从未随快照更新（write_snapshot 不写它），
   收益序列比当日行情落后，需要让它每天一起落盘。

我的要求：<在这里写你的具体需求>
```
