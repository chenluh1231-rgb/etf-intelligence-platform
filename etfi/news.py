"""新闻快讯 / 资讯文章 / 研报（方案 §7.2 What Matters to You）。

不是每天生成一篇市场综述，而是从全市场资讯里挑出与你有关的那一小撮。

设计原则：
  1. **相关性靠结构化命中，不靠主观判断**：个股代码直连 > 行业暴露 > 关注主题，
     每一条都能说出「为什么推给你」，且可追溯到具体命中的股票或标签。
  2. **标签在服务端算好**：行业/主题/个股标签预先打完写进快照，浏览器端只做集合
     运算与加权，因此持仓文件不需要上传服务器。
  3. **不抓正文**：只保留标题、摘要与原文链接，来源信息一并展示。
  4. **数据缺失就标注**：新闻源取不到时不伪造内容，直接返回空并说明原因。

三个数据源（均为东方财富公开接口）：
  快讯  7x24 滚动快讯，带 stockList（关联个股），时效最强；
  文章  正式资讯稿件，有独立正文页，适合深度阅读；
  研报  券商行业/策略/个股研报，适合作为「文章」的深度补充。
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from urllib.parse import quote

from . import datasource as ds

# ------------------------------------------------------------ 常量 ----
FAST_NEWS_URL = ("https://np-listapi.eastmoney.com/comm/web/getFastNewsList"
                 "?client=web&biz=web_724&fastColumn=102&sortEnd={cursor}"
                 "&pageSize={size}&req_trace=1")
REPORT_URL = ("https://reportapi.eastmoney.com/report/list?cb=&industryCode=*"
              "&pageSize={size}&industry=*&rating=*&ratingChange=*"
              "&beginTime={begin}&endTime={end}&pageNo={page}&fields=&qType={qtype}"
              "&orgCode=&code=*&rcode=&p=1&pageNum={page}")

# 搜索关键词：覆盖产品本身 + 主要行业 + 主要主题，静态站无法预知用户关注什么
ARTICLE_KEYWORDS = [
    "ETF", "指数基金", "半导体", "人工智能", "算力", "机器人", "创新药",
    "新能源", "光伏", "储能", "白酒", "消费", "银行", "券商", "军工",
    "港股", "黄金", "红利", "债券", "房地产", "军工电子",
]

# 文章走东财搜索接口：栏目列表接口（getListInfo）不支持翻页，
# page_index / sortEnd / mTypeAndCode 全都无效，永远只返回同一页 10 条。
SEARCH_URL = "https://search-api-web.eastmoney.com/search/jsonp?cb=&param={param}"

FAST_NEWS_PAGES = 6        # 每页 50 条 → 约 300 条快讯
ARTICLE_PAGES = 2          # 每个关键词取 2 页 × 10 条
REPORT_DAYS = 10           # 研报回溯天数
KEEP_PER_KIND = {"快讯": 300, "文章": 150, "研报": 120}

# 相关性权重。成分股直连最强：它是最硬的证据，说明这条消息直接影响你的底层资产。
W = {"stock": 0.50, "sector": 0.30, "theme": 0.20}
STOCK_FULL_HIT = 0.03      # 命中成分股合计权重达到 3% 即视为强直连
SECTOR_FULL_HIT = 0.15     # 命中行业暴露达到 15% 即视为强暴露
DECAY_HOURS = 72.0         # 72 小时内线性衰减到 0.5

# 噪声过滤：这些是快讯里常见但与投资决策无关的八卦/社会新闻
NOISE_KW = ["彩票", "离婚", "出轨", "演唱会", "明星", "综艺", "宠物", "烧烤",
            "被捕", "判刑", "车祸", "火灾", "坠亡", "溺水", "诈骗", "赌博"]


def _norm_stock(s: str) -> str:
    """'1.600838' / 'sh600838' → '600838'。"""
    m = re.search(r"(\d{6})", str(s or ""))
    return m.group(1) if m else ""


def _clean_summary(title: str, summary: str) -> str:
    """快讯 summary 常以【标题】开头，去掉重复。"""
    s = (summary or "").strip()
    if title and s.startswith(f"【{title}】"):
        s = s[len(f"【{title}】"):].strip()
    s = re.sub(r"\s+", " ", s)
    return s[:220]


# 新闻打标用的收紧版词典。
# ETF 名称很短，用宽泛词（"消费""价值"）分类没问题；但新闻是自然语言，
# 这类词几乎无处不在，会把「港股速报」误判成「高股息防御」。
# 因此新闻侧只保留具象词，宁可少命中，也不要误命中。
NEWS_SECTOR_KW = {
    "电子半导体": ["半导体", "芯片", "集成电路", "晶圆", "光刻", "消费电子", "存储芯片"],
    "计算机": ["信创", "国产软件", "云计算", "大数据", "数据要素"],
    "通信": ["光模块", "通信设备", "5G"],
    "人工智能": ["人工智能", "AI算力", "大模型", "算力", "智能算力", "ChatGPT", "AIGC"],
    "机器人": ["机器人", "工业母机", "人形机器人"],
    "医药生物": ["创新药", "生物医药", "疫苗", "中药", "医疗器械", "CXO", "医保"],
    "电力设备新能源": ["光伏", "储能", "锂电池", "风电", "碳中和", "新能源车", "固态电池"],
    "汽车": ["智能汽车", "汽车零部件", "自动驾驶", "新能源车"],
    "国防军工": ["军工", "国防", "航空航天", "兵器"],
    "食品饮料": ["白酒", "食品饮料", "乳业", "调味品", "啤酒"],
    "银行": ["银行股", "银行业", "存贷", "LPR"],
    "非银金融": ["券商", "证券行业", "保险资金", "险资"],
    "房地产": ["房地产", "楼市", "商品房", "土地出让"],
    "商贸社服": ["免税", "跨境电商", "旅游股", "影视股", "游戏版号"],
    "有色金属": ["稀土", "锂矿", "铜价", "铝价", "贵金属", "黄金价格"],
    "钢铁煤炭": ["钢铁", "煤炭", "原油", "石油"],
    "基础化工": ["化工行业", "新材料", "氟化工", "磷化工"],
    "农林牧渔": ["生猪", "养殖", "种业", "畜牧"],
    "公用事业": ["电力改革", "水务", "燃气", "核电", "绿电"],
    "机械设备": ["工程机械", "高端装备", "船舶制造"],
    "互联网": ["互联网平台", "电商平台", "网络游戏"],
}
NEWS_THEME_KW = {
    "科技自主": ["信创", "自主可控", "国产替代", "芯片", "半导体", "光刻机"],
    "AI算力": ["人工智能", "AI", "算力", "光模块", "数据中心", "大模型"],
    "新能源": ["光伏", "储能", "锂电", "风电", "碳中和"],
    "消费复苏": ["消费复苏", "白酒", "食品饮料", "免税", "餐饮"],
    "医药创新": ["创新药", "生物医药", "CXO", "医疗器械"],
    "高股息防御": ["红利", "高股息", "股息", "分红", "派息", "股息率"],
    "国家安全": ["军工", "国防", "信息安全", "网络安全", "自主可控"],
    "出海全球化": ["出海", "纳斯达克", "标普", "东南亚", "越南", "印度市场"],
    "人口老龄": ["养老", "康养", "老龄化"],
    "数字经济": ["数字经济", "数据要素", "云计算", "大数据"],
}
NEWS_STYLE_KW = {
    "红利": ["红利", "高股息", "股息", "分红", "派息"],
    "低波": ["低波动"],
    "央企国企": ["央企", "国企", "国资", "中字头", "央国企"],
    "ESG": ["ESG", "可持续发展", "责任投资"],
}


def _tag_text(text: str) -> tuple[list[str], list[str]]:
    """对新闻文本打行业与主题标签。

    复用 ETF 分类的标签名（保证与产品侧同一套口径），但关键词用收紧版，
    避免「价值」「消费」这类通用词把不相关的消息拉进来。
    """
    t = text or ""
    sectors, themes = [], []
    for sec, kws in NEWS_SECTOR_KW.items():
        if any(k in t for k in kws):
            sectors.append(sec)
    for th, kws in NEWS_THEME_KW.items():
        if any(k in t for k in kws):
            themes.append(th)
    for st, kws in NEWS_STYLE_KW.items():
        if any(k in t for k in kws) and st not in themes:
            themes.append(st)
    return sectors[:4], themes[:4]


def _is_noise(title: str, summary: str) -> bool:
    t = f"{title} {summary}"
    return sum(1 for k in NOISE_KW if k in t) >= 2


# ------------------------------------------------------------ 抓取 ----
def fetch_fast_news(pages: int = FAST_NEWS_PAGES, size: int = 50) -> list[dict]:
    """7x24 快讯，按 sortEnd 游标向前翻页。"""
    out, cursor = [], ""
    for _ in range(pages):
        r = ds._get(FAST_NEWS_URL.format(cursor=cursor, size=size),
                    referer="https://kuaixun.eastmoney.com/")
        if not r:
            break
        try:
            d = r.json().get("data") or {}
        except Exception:
            break
        lst = d.get("fastNewsList") or []
        if not lst:
            break
        for it in lst:
            title = (it.get("title") or "").strip()
            if not title:
                continue
            summary = _clean_summary(title, it.get("summary") or "")
            if _is_noise(title, summary):
                continue
            stocks = [_norm_stock(s) for s in (it.get("stockList") or [])]
            stocks = [s for s in stocks if s]
            secs, ths = _tag_text(f"{title} {summary}")
            out.append({
                "id": f"fn_{it.get('code')}",
                "kind": "快讯",
                "title": title,
                "summary": summary,
                "time": (it.get("showTime") or "")[:19],
                "url": f"https://finance.eastmoney.com/a/{it.get('code')}.html",
                "source": "东方财富",
                "stocks": stocks,
                "sectors": secs,
                "themes": ths,
            })
        nxt = d.get("sortEnd")
        if not nxt or nxt == cursor:
            break
        cursor = nxt
    return out


def _search_articles(kw: str, pages: int = ARTICLE_PAGES, size: int = 10) -> list[dict]:
    """按单个关键词搜索资讯文章。返回的是带摘要与来源的正式稿件。"""
    out = []
    for p in range(1, pages + 1):
        param = {"uid": "", "keyword": kw, "type": ["cmsArticleWebOld"],
                 "client": "web", "clientType": "web", "clientVersion": "curr",
                 "param": {"cmsArticleWebOld": {"searchScope": "default",
                                                "sort": "time", "pageIndex": p,
                                                "pageSize": size,
                                                "preTag": "<em>", "postTag": "</em>"}}}
        r = ds._get(SEARCH_URL.format(param=quote(json.dumps(param, ensure_ascii=False))),
                    referer="https://so.eastmoney.com/")
        if not r:
            break
        txt = r.text.strip()
        if txt.startswith("("):          # 某些情况下返回 JSONP 外壳
            txt = txt.strip("()")
        try:
            lst = (json.loads(txt).get("result") or {}).get("cmsArticleWebOld") or []
        except Exception:
            break
        if not lst:
            break
        for it in lst:
            title = re.sub(r"</?em>", "", (it.get("title") or "")).strip()
            code = it.get("code")
            if not title or not code:
                continue
            summary = re.sub(r"</?em>", "", (it.get("content") or "")).strip()
            secs, ths = _tag_text(f"{title} {summary}")
            out.append({
                "id": f"ar_{code}",
                "kind": "文章",
                "title": title,
                "summary": _clean_summary(title, summary)[:220],
                "time": (it.get("date") or "")[:19],
                "url": (it.get("url") or f"https://finance.eastmoney.com/a/{code}.html"),
                "source": (it.get("mediaName") or "东方财富资讯").strip(),
                "stocks": [],
                "sectors": secs,
                "themes": ths,
            })
    return out


def fetch_articles(keywords: list[str] | None = None) -> list[dict]:
    """并发搜索多个关键词，合并去重。"""
    kws = keywords or ARTICLE_KEYWORDS
    with ThreadPoolExecutor(max_workers=8) as ex:
        groups = list(ex.map(_search_articles, kws))
    out, seen = [], set()
    for g in groups:
        for it in g:
            if it["id"] in seen:
                continue
            seen.add(it["id"])
            out.append(it)
    return out


def fetch_reports(days: int = REPORT_DAYS, size: int = 50, pages: int = 2) -> list[dict]:
    """券商研报。qType=2 覆盖行业/策略/宏观，qType=0 覆盖个股。"""
    end = datetime.now().strftime("%Y-%m-%d")
    begin = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    out = []
    for qtype in (2, 0):
        for p in range(1, pages + 1):
            r = ds._get(REPORT_URL.format(size=size, begin=begin, end=end,
                                          page=p, qtype=qtype),
                        referer="https://data.eastmoney.com/report/")
            if not r:
                break
            try:
                lst = r.json().get("data") or []
            except Exception:
                break
            if not lst:
                break
            for it in lst:
                title = (it.get("title") or "").strip()
                ic = it.get("infoCode")
                if not title or not ic:
                    continue
                sc = _norm_stock(it.get("stockCode") or "")
                sn = (it.get("stockName") or "").strip()
                org = (it.get("orgSName") or "").strip()
                ind = (it.get("industryName") or "").strip()
                bits = [b for b in (org, ind or ("个股研究" if sc else "策略/行业研究")) if b]
                if sn:
                    bits.append(f"个股：{sn}({sc})" if sc else f"个股：{sn}")
                secs, ths = _tag_text(f"{title} {ind}")
                url = ("https://data.eastmoney.com/report/zw_stock.jshtml?infocode="
                       f"{ic}" if sc else
                       "https://data.eastmoney.com/report/zw_industry.jshtml?infocode="
                       f"{ic}")
                out.append({
                    "id": f"rp_{ic}",
                    "kind": "研报",
                    "title": title,
                    "summary": " · ".join(bits),
                    "time": (it.get("publishDate") or "")[:19],
                    "url": url,
                    "source": org or "券商研报",
                    "stocks": [sc] if sc else [],
                    "sectors": secs,
                    "themes": ths,
                })
    return out


# ------------------------------------------------------------ 汇总 ----
def _dedup(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for it in items:
        if it["id"] in seen or not it.get("time"):
            continue
        seen.add(it["id"])
        out.append(it)
    return out


def refresh_news(force: bool = False) -> dict:
    """抓取三源 → 去重 → 打标 → 落库。返回统计，便于排查数据源状态。"""
    def _go():
        got = fetch_fast_news() + fetch_articles() + fetch_reports()
        items = _dedup(got)
        # 按类型各保留最新的 N 条，避免单一来源刷屏
        by_kind: dict[str, list] = {}
        for it in items:
            by_kind.setdefault(it["kind"], []).append(it)
        keep = []
        for k, lst in by_kind.items():
            lst.sort(key=lambda x: x["time"], reverse=True)
            keep.extend(lst[:KEEP_PER_KIND.get(k, 150)])
        keep.sort(key=lambda x: x["time"], reverse=True)
        return keep

    items = ds._cached("news", "all", _go) if not force else _go()
    if not items:
        return {"ok": False, "msg": "新闻数据源不可用", "count": 0}
    from . import store
    store.save_news(items)
    by_kind = {}
    for it in items:
        by_kind[it["kind"]] = by_kind.get(it["kind"], 0) + 1
    return {"ok": True, "count": len(items), "by_kind": by_kind}


# ------------------------------------------------------------ 相关性 ----
def build_context(positions: list[dict], stock_w: dict[str, float],
                  sector_exposure: list[dict] | None = None,
                  themes: list[str] | None = None,
                  etf_names: list[str] | None = None,
                  code_names: dict[str, str] | None = None,
                  stock_names: dict[str, str] | None = None) -> dict:
    """构造相关性上下文。所有输入都是持仓侧已经算好的结果。

    stock_w     : 组合穿透后的成分股权重（个股代码 → 权重）
    sector      : 组合行业暴露（行业名 → 权重）
    themes      : 用户关注主题
    etf_names   : 持仓 ETF 名称与跟踪指数名，用于名称级关键词命中
    code_names  : 持仓 ETF 代码 → 名称。快讯的 stockList 里会混入 ETF 代码
                  （例如「养殖ETF逆市上涨」带的是 159023），必须单独匹配，
                  否则这类最直接相关的消息会被漏掉。
    stock_names : 成分股代码 → 名称。理由文案要给具体公司名，
                  只报 6 位代码对投资者没有意义。
    """
    sec_w = {}
    for s in (sector_exposure or []):
        key = s.get("sector") if isinstance(s, dict) else None
        if key:
            sec_w[key] = float(s.get("weight") or 0)
    return {
        "stock_w": {k: float(v) for k, v in (stock_w or {}).items() if v},
        "sector_w": sec_w,
        "themes": list(themes or []),
        "names": [n for n in (etf_names or []) if n],
        "code_names": dict(code_names or {}),
        "stock_names": dict(stock_names or {}),
    }


def _display_name(code: str, names: dict | None) -> str:
    """公司名优先；名称缺失或被脱敏（如 '12*'）时退回代码。"""
    n = (names or {}).get(code) or ""
    n = n.strip()
    if len(n) < 2 or "*" in n:
        return code
    return n


def _time_decay(time_str: str) -> float:
    try:
        t = datetime.strptime(time_str[:19], "%Y-%m-%d %H:%M:%S")
    except Exception:
        return 0.8
    age_h = (datetime.now() - t).total_seconds() / 3600.0
    if age_h < 0:
        age_h = 0.0
    return max(0.5, 1.0 - 0.5 * min(1.0, age_h / DECAY_HOURS))


def relevance(item: dict, ctx: dict) -> dict:
    """算一条新闻与当前组合的相关度，并给出可解释的命中理由。

    返回 {score, reasons, hits:{stocks, sectors, themes}}
    score=0 表示无关，调用方应直接过滤掉，不要展示凑数。
    """
    stock_w = ctx.get("stock_w") or {}
    sector_w = ctx.get("sector_w") or {}
    themes = set(ctx.get("themes") or [])
    names = ctx.get("names") or []
    code_names = ctx.get("code_names") or {}
    codes = item.get("stocks") or []

    # ① 直接点名你持有的某只 ETF —— 最强信号，等同满分的成分股直连
    hit_etf = [c for c in codes if c in code_names]
    # ② 命中穿透后的底层成分股
    hit_stocks = [s for s in codes if s in stock_w and s not in code_names]
    hit_w = sum(stock_w[s] for s in hit_stocks)
    s_stock = 1.0 if hit_etf else (min(1.0, hit_w / STOCK_FULL_HIT) if hit_w else 0.0)

    hit_secs = [s for s in (item.get("sectors") or []) if s in sector_w]
    sec_w = sum(sector_w[s] for s in hit_secs)
    s_sector = min(1.0, sec_w / SECTOR_FULL_HIT) if sec_w else 0.0

    hit_ths = sorted(set(item.get("themes") or []) & themes)
    s_theme = min(1.0, len(hit_ths) / 2.0) if hit_ths else 0.0

    # 名称级命中：持仓 ETF 名或指数名出现在标题里（如「沪深300」）
    title = item.get("title") or ""
    name_hits = [n for n in names if n and len(n) >= 3 and n in title]
    s_name = min(1.0, len(name_hits) / 2.0) if name_hits else 0.0

    base = (W["stock"] * s_stock + W["sector"] * s_sector +
            W["theme"] * s_theme)
    if s_name:
        base = min(1.0, base + 0.35 * s_name)
    if base <= 0:
        return {"score": 0.0, "reasons": [],
                "hits": {"stocks": [], "sectors": [], "themes": [], "names": []}}

    score = round(100.0 * base * _time_decay(item.get("time") or ""), 1)

    reasons = []
    if hit_etf:
        reasons.append("直接点名你持有的 " + "、".join(
            code_names[c] or c for c in hit_etf[:2]))
    if hit_stocks:
        top = sorted(hit_stocks, key=lambda s: -stock_w[s])[:3]
        reasons.append("关联你的持仓成分股 " + "、".join(
            _display_name(s, ctx.get("stock_names")) for s in top))
    if hit_secs:
        reasons.append("命中组合行业暴露 " + "、".join(hit_secs[:2]))
    if hit_ths:
        reasons.append("命中你的关注主题 " + "、".join(hit_ths[:2]))
    if name_hits:
        reasons.append("提及你持有的 " + "、".join(name_hits[:2]))
    return {"score": score, "reasons": reasons,
            "hits": {"stocks": hit_stocks, "etf": hit_etf, "sectors": hit_secs,
                     "themes": hit_ths, "names": name_hits}}


def select_for(ctx: dict, items: list[dict] | None = None,
               limit_fast: int = 10, limit_article: int = 8) -> dict:
    """挑出与组合相关的新闻，按类型分栏。

    只保留 score>0 的条目；不足时不凑数，而是如实返回「没有找到」。
    """
    from . import store
    items = items if items is not None else store.load_news(limit=600)
    scored = []
    for it in items:
        rel = relevance(it, ctx)
        if rel["score"] <= 0:
            continue
        scored.append({**it, "score": rel["score"], "reasons": rel["reasons"],
                       "hits": rel["hits"]})
    # 稳定排序：先按时间倒序，再按相关度倒序，同分时新的在前
    scored.sort(key=lambda x: x["time"], reverse=True)
    scored.sort(key=lambda x: x["score"], reverse=True)

    fast = [x for x in scored if x["kind"] == "快讯"][:limit_fast]
    arts = [x for x in scored if x["kind"] in ("文章", "研报")][:limit_article]
    return {
        "fast": fast,
        "articles": arts,
        "n_scanned": len(items),
        "n_related": len(scored),
        "note": ("相关度 = 成分股直连 50% + 行业暴露 30% + 关注主题 20%，"
                 "再按时间新鲜度衰减；得分为 0 的不展示"),
        "empty_hint": ("未找到与你当前持仓或关注主题直接相关的资讯。"
                       "持仓穿透为季报口径，覆盖率有限；补充关注主题可提高命中率。"),
    }
