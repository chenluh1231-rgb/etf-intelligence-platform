"""SQLite 持久化。

表结构对齐方案 §8：investor_profiles / investor_positions / etf_master /
etf_holdings / etf_features_daily / matching_results / matching_events / daily_briefs。
第一版用 SQLite 而非 PostgreSQL，目标是单机可跑、零运维；接口与 SQL 保持可迁移。
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS investor_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  stated TEXT,             -- 显式表达：目标、偏好、约束
  revealed TEXT,           -- 实际持仓反推
  behavioral TEXT,         -- 可观测行为
  profile TEXT,            -- 合并后的画像向量
  completeness REAL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS investor_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT,
  weight REAL,
  market_value REAL,
  shares REAL,
  cost_price REAL,
  buy_date TEXT,
  source TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS etf_master (
  code TEXT PRIMARY KEY,
  name TEXT,
  market INTEGER,
  company TEXT,
  index_code TEXT,
  index_name TEXT,
  asset_class TEXT,
  layer TEXT,
  mkt TEXT,
  tags TEXT,
  size_style TEXT,
  fee REAL,
  cust_fee REAL,
  scale_yi REAL,
  vol_1y REAL,
  maxdd_1y REAL,
  ret_1y REAL,
  ret_3y REAL,
  establish_date TEXT,
  leveraged INTEGER DEFAULT 0,
  data_date TEXT,
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS etf_holdings (
  code TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  stock_name TEXT,
  weight REAL,
  report_date TEXT,
  fetched_at TEXT,
  PRIMARY KEY (code, stock_code)
);
CREATE TABLE IF NOT EXISTS etf_features_daily (
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  close REAL,
  pct REAL,
  amount REAL,
  amount_ma20 REAL,
  ret_20d REAL,
  vol_60d REAL,
  PRIMARY KEY (code, trade_date)
);
CREATE TABLE IF NOT EXISTS matching_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  algo_version TEXT,
  result_type TEXT,          -- best_match / best_addition
  rank INTEGER,
  code TEXT,
  name TEXT,
  score REAL,
  components TEXT,
  reasons TEXT,
  mismatches TEXT,
  confidence TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS matching_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  event_type TEXT,
  code TEXT,
  detail TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS daily_briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  brief TEXT,
  has_signal INTEGER,
  created_at TEXT,
  UNIQUE (user_id, trade_date)
);
-- 新闻/快讯/研报缓存（方案 §7.2 What Matters to You）
-- 只存标题、摘要与结构化标签，不存正文；原文一律链回来源站点。
CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- 快讯 / 文章 / 研报
  title TEXT NOT NULL,
  summary TEXT,
  time TEXT,
  url TEXT,
  source TEXT,
  stocks TEXT,                 -- JSON 数组：关联个股 6 位代码
  sectors TEXT,                -- JSON 数组：命中的行业标签
  themes TEXT,                 -- JSON 数组：命中的主题标签
  fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_time ON news_items(time);
CREATE INDEX IF NOT EXISTS idx_news_kind ON news_items(kind);
CREATE INDEX IF NOT EXISTS idx_pos_user ON investor_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_match_user ON matching_results(user_id, trade_date);
"""


def conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.executescript(SCHEMA)
    return c


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# --------------------------------------------------------------- 持仓 ----
def save_positions(user_id: str, rows: list[dict]):
    c = conn()
    c.execute("DELETE FROM investor_positions WHERE user_id=?", (user_id,))
    for r in rows:
        c.execute(
            "INSERT INTO investor_positions(user_id,code,name,weight,market_value,"
            "shares,cost_price,buy_date,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (user_id, r.get("code"), r.get("name"), r.get("weight"),
             r.get("market_value"), r.get("shares"), r.get("cost_price"),
             r.get("buy_date"), r.get("source", "csv"), now()))
    c.commit()
    c.close()


def load_positions(user_id: str) -> list[dict]:
    c = conn()
    rows = [dict(r) for r in c.execute(
        "SELECT * FROM investor_positions WHERE user_id=? ORDER BY weight DESC", (user_id,))]
    c.close()
    return rows


# ------------------------------------------------------------ ETF 主表 ----
def upsert_etf(rec: dict):
    c = conn()
    cols = ["code", "name", "market", "company", "index_code", "index_name",
            "asset_class", "layer", "mkt", "tags", "size_style", "fee", "cust_fee",
            "scale_yi", "vol_1y", "maxdd_1y", "ret_1y", "ret_3y",
            "establish_date", "leveraged", "data_date", "fetched_at"]
    vals = [rec.get(k) for k in cols]
    ph = ",".join("?" * len(cols))
    c.execute(f"INSERT OR REPLACE INTO etf_master({','.join(cols)}) VALUES({ph})", vals)
    c.commit()
    c.close()


def upsert_etfs(recs: list[dict]):
    c = conn()
    cols = ["code", "name", "market", "company", "index_code", "index_name",
            "asset_class", "layer", "mkt", "tags", "size_style", "fee", "cust_fee",
            "scale_yi", "vol_1y", "maxdd_1y", "ret_1y", "ret_3y",
            "establish_date", "leveraged", "data_date", "fetched_at"]
    ph = ",".join("?" * len(cols))
    c.executemany(f"INSERT OR REPLACE INTO etf_master({','.join(cols)}) VALUES({ph})",
                  [[r.get(k) for k in cols] for r in recs])
    c.commit()
    c.close()


def etf_count() -> int:
    c = conn()
    n = c.execute("SELECT COUNT(*) FROM etf_master").fetchone()[0]
    c.close()
    return n


def load_etf_master(codes: list[str] | None = None) -> list[dict]:
    c = conn()
    if codes:
        ph = ",".join("?" * len(codes))
        rows = [dict(r) for r in c.execute(
            f"SELECT * FROM etf_master WHERE code IN ({ph})", codes)]
    else:
        rows = [dict(r) for r in c.execute("SELECT * FROM etf_master")]
    c.close()
    for r in rows:
        if r.get("tags"):
            try:
                r["tags"] = json.loads(r["tags"])
            except Exception:
                r["tags"] = []
        else:
            r["tags"] = []
    return rows


# --------------------------------------------------------------- 持仓表 ----
def save_holdings(code: str, rows: list[dict], report_date: str):
    c = conn()
    c.execute("DELETE FROM etf_holdings WHERE code=?", (code,))
    c.executemany(
        "INSERT OR REPLACE INTO etf_holdings(code,stock_code,stock_name,weight,"
        "report_date,fetched_at) VALUES(?,?,?,?,?,?)",
        [(code, r["stock_code"], r.get("stock_name"), r.get("weight"),
          report_date, now()) for r in rows])
    c.commit()
    c.close()


def load_holdings(codes: list[str]) -> dict[str, list[dict]]:
    if not codes:
        return {}
    c = conn()
    ph = ",".join("?" * len(codes))
    rows = [dict(r) for r in c.execute(
        f"SELECT * FROM etf_holdings WHERE code IN ({ph})", codes)]
    c.close()
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r["code"], []).append(r)
    return out


# ---------------------------------------------------------------- 画像 ----
def save_profile(user_id: str, profile: dict):
    c = conn()
    v = c.execute("SELECT COALESCE(MAX(version),0) FROM investor_profiles WHERE user_id=?",
                  (user_id,)).fetchone()[0] + 1
    c.execute("INSERT INTO investor_profiles(user_id,version,stated,revealed,behavioral,"
              "profile,completeness,created_at) VALUES(?,?,?,?,?,?,?,?)",
              (user_id, v, json.dumps(profile.get("stated"), ensure_ascii=False),
               json.dumps(profile.get("revealed"), ensure_ascii=False),
               json.dumps(profile.get("behavioral"), ensure_ascii=False),
               json.dumps({k: v2 for k, v2 in profile.items()
                           if k not in ("stated", "revealed", "behavioral")},
                          ensure_ascii=False),
               profile.get("completeness", 0), now()))
    c.commit()
    c.close()
    return v


def load_profile_history(user_id: str, limit: int = 10) -> list[dict]:
    c = conn()
    rows = [dict(r) for r in c.execute(
        "SELECT * FROM investor_profiles WHERE user_id=? ORDER BY version DESC LIMIT ?",
        (user_id, limit))]
    c.close()
    for r in rows:
        for k in ("stated", "revealed", "behavioral", "profile"):
            try:
                r[k] = json.loads(r[k]) if r.get(k) else {}
            except Exception:
                r[k] = {}
    return rows


# -------------------------------------------------------------- 匹配结果 ----
def save_matching(user_id: str, trade_date: str, algo: str, rows: list[dict]):
    c = conn()
    c.execute("DELETE FROM matching_results WHERE user_id=? AND trade_date=? AND algo_version=?",
              (user_id, trade_date, algo))
    c.executemany(
        "INSERT INTO matching_results(user_id,trade_date,algo_version,result_type,rank,"
        "code,name,score,components,reasons,mismatches,confidence,created_at)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(user_id, trade_date, algo, r["result_type"], r["rank"], r["code"], r["name"],
          r["score"], json.dumps(r.get("components"), ensure_ascii=False),
          json.dumps(r.get("reasons"), ensure_ascii=False),
          json.dumps(r.get("mismatches"), ensure_ascii=False),
          json.dumps(r.get("confidence"), ensure_ascii=False), now()) for r in rows])
    c.commit()
    c.close()


def load_matching(user_id: str, trade_date: str | None = None) -> list[dict]:
    c = conn()
    if trade_date:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM matching_results WHERE user_id=? AND trade_date=? ORDER BY result_type,rank",
            (user_id, trade_date))]
    else:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM matching_results WHERE user_id=? ORDER BY trade_date DESC,"
            "result_type,rank", (user_id,))]
    c.close()
    for r in rows:
        for k in ("components", "reasons", "mismatches", "confidence"):
            try:
                r[k] = json.loads(r[k]) if r.get(k) else ([] if k != "components" else {})
            except Exception:
                r[k] = [] if k != "components" else {}
    return rows


# -------------------------------------------------------------- 事件/简报 ----
def save_event(user_id: str, trade_date: str, event_type: str, code: str, detail: dict):
    c = conn()
    c.execute("INSERT INTO matching_events(user_id,trade_date,event_type,code,detail,created_at)"
              " VALUES(?,?,?,?,?,?)",
              (user_id, trade_date, event_type, code,
               json.dumps(detail, ensure_ascii=False), now()))
    c.commit()
    c.close()


def save_brief(user_id: str, trade_date: str, brief: dict):
    c = conn()
    c.execute("INSERT OR REPLACE INTO daily_briefs(user_id,trade_date,brief,has_signal,created_at)"
              " VALUES(?,?,?,?,?)",
              (user_id, trade_date, json.dumps(brief, ensure_ascii=False),
               1 if brief.get("has_signal") else 0, now()))
    c.commit()
    c.close()


def load_brief(user_id: str, trade_date: str) -> dict | None:
    c = conn()
    r = c.execute("SELECT brief FROM daily_briefs WHERE user_id=? AND trade_date=?",
                  (user_id, trade_date)).fetchone()
    c.close()
    if not r:
        return None
    try:
        return json.loads(r[0])
    except Exception:
        return None


def save_news(items: list[dict]):
    """新闻按 id 去重入库。只保留最近 N 条，避免无限膨胀。"""
    if not items:
        return
    c = conn()
    c.executemany(
        "INSERT OR REPLACE INTO news_items(id,kind,title,summary,time,url,source,"
        "stocks,sectors,themes,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [(r["id"], r["kind"], r["title"], r.get("summary") or "", r.get("time") or "",
          r.get("url") or "", r.get("source") or "",
          json.dumps(r.get("stocks") or [], ensure_ascii=False),
          json.dumps(r.get("sectors") or [], ensure_ascii=False),
          json.dumps(r.get("themes") or [], ensure_ascii=False),
          r.get("fetched_at") or now()) for r in items])
    c.execute("DELETE FROM news_items WHERE id NOT IN "
              "(SELECT id FROM news_items ORDER BY time DESC LIMIT 1200)")
    c.commit()
    c.close()


def load_news(limit: int = 600) -> list[dict]:
    c = conn()
    rows = c.execute("SELECT * FROM news_items ORDER BY time DESC LIMIT ?",
                     (limit,)).fetchall()
    c.close()
    out = []
    for r in rows:
        try:
            out.append({
                "id": r["id"], "kind": r["kind"], "title": r["title"],
                "summary": r["summary"], "time": r["time"], "url": r["url"],
                "source": r["source"],
                "stocks": json.loads(r["stocks"] or "[]"),
                "sectors": json.loads(r["sectors"] or "[]"),
                "themes": json.loads(r["themes"] or "[]"),
            })
        except Exception:
            continue
    return out


def save_features_daily(rows: list[dict]):
    if not rows:
        return
    c = conn()
    c.executemany(
        "INSERT OR REPLACE INTO etf_features_daily(code,trade_date,close,pct,amount,"
        "amount_ma20,ret_20d,vol_60d) VALUES(?,?,?,?,?,?,?,?)",
        [(r["code"], r["trade_date"], r.get("close"), r.get("pct"), r.get("amount"),
          r.get("amount_ma20"), r.get("ret_20d"), r.get("vol_60d")) for r in rows])
    c.commit()
    c.close()
