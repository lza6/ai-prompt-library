"""情报全局存储（E9/E10，DESIGN.md §16）：data/intel/intel.db（SQLite WAL）。

与项目黑板无关的**全局** DB（新模式：现全局配置仅 config/*.json）。
文章池 + 简报归档 + vault 笔记元数据索引 + 学习计划四张表；feeds.json / profile.json 由 config.py 管理。
流量极低（人工触发抓取/翻页），单连接 + 写锁即可，不照抄 Blackboard 的线程局部连接。

**落点（2026-10-27，两目录契约）**：运行数据只允许落 `data/` 与 `workspaces/`，故
情报全局库由 `config/intel/` 归位到 `data/intel/`（老位置整目录惰性迁移，仿 campaign.db）。
`config/` 只留纯配置（含 `config/searxng/settings.yml`）。
"""

import json
import logging
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from core.blackboard.store import new_id  # 复用 <前缀>-<12hex> 约定
from core.intel.ranking import normalize_day

log = logging.getLogger(__name__)

SCHEMA_VERSION = 8

#: 情报全局目录（运行数据归口 data/；与 app.py 的 `intel_dir` 默认值同源）
DEFAULT_INTEL_DIR = Path("data") / "intel"
#: 老默认位置（2026-10-27 前）——惰性迁移源，迁移成功后不再出现
_LEGACY_INTEL_DIR = Path("config") / "intel"


def migrate_default_dir(intel_dir: str | Path = DEFAULT_INTEL_DIR) -> Path:
    """老默认位置 `config/intel/` → `data/intel/` 惰性迁移；返回实际生效目录。

    仅当传入的正是**默认目录**（`data/intel`）时触发（显式传 intel_dir 的一律不迁移，
    测试 fixture 天然豁免）。整目录 rename（intel.db + -wal/-shm + feeds.json +
    profile.json + .history 一并搬）；目标已存在或老位置不在场则原样返回。失败
    （旧进程仍持句柄 / 杀软占用）保留老位置下次启动重试——**绝不半搬**：要么整目录走，
    要么原地不动，避免两处各半份数据。

    **必须早于任何对新目录的读写**（`create_app` 装配时即调用）：否则 serve 侧先
    `load_profile("data/intel")` 会种子出一份新 profile.json，把目录占住，迁移从此
    永久跳过 → 老数据与新空库分叉。
    """
    d = Path(intel_dir)
    if d != DEFAULT_INTEL_DIR:
        return d
    if d.exists() or not _LEGACY_INTEL_DIR.is_dir():
        return d
    try:
        d.parent.mkdir(parents=True, exist_ok=True)
        _LEGACY_INTEL_DIR.rename(d)
        log.info("intel 目录已从 config/ 迁移到 %s", d)
        return d
    except OSError as e:
        log.warning("intel 目录迁移失败（可能被旧进程占用），本次继续用 %s：%s",
                    _LEGACY_INTEL_DIR, e)
        return _LEGACY_INTEL_DIR


_DDL = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    source TEXT NOT NULL,          -- 源名（feed 名 / nvd / kev / ghsa）
    kind TEXT NOT NULL,            -- cve | article
    summary TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    published_day TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL,
    via TEXT NOT NULL DEFAULT '',
    focus_keywords TEXT NOT NULL DEFAULT '[]',
    score REAL NOT NULL DEFAULT 0,
    direction TEXT NOT NULL DEFAULT '',    -- 打分命中的主方向
    is_priority INTEGER NOT NULL DEFAULT 0,-- KEV / 有公开 POC 优先标
    has_poc INTEGER NOT NULL DEFAULT 0,    -- 启发式判定有公开 POC / KEV 在野利用（证据合并后）
    poc_url TEXT NOT NULL DEFAULT '',      -- 最优 PoC 链接（KEV 无补充证据时为 ''）
    score_detail TEXT NOT NULL DEFAULT '', -- JSON（llm/规则、明细）
    brief_date TEXT,               -- 已并入哪份简报
    read INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_articles_kind ON articles(kind, score DESC);
CREATE TABLE IF NOT EXISTS briefs (
    date TEXT PRIMARY KEY,         -- YYYY-MM-DD（UTC）
    content TEXT NOT NULL,         -- markdown 全文
    stats TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_notes (          -- E10：vault 元数据索引（只读，全量重建语义）
    path TEXT PRIMARY KEY,         -- vault 根相对 POSIX 路径
    title TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '', -- JSON 数组
    category TEXT NOT NULL DEFAULT '', -- F5：frontmatter category（归一化小写；方向判定优先命中）
    mtime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL DEFAULT '', -- 正文仅本地搜索用，绝不进 LLM 入参（隐私红线）
    indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_plans (       -- E10：周学习计划（周一起始，同周覆盖）
    week TEXT PRIMARY KEY,         -- YYYY-MM-DD（ISO 周起始日）
    content TEXT NOT NULL,         -- markdown 全文
    inputs TEXT NOT NULL DEFAULT '{}', -- 输入摘要统计（不含笔记正文）
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_history (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    cache_key TEXT NOT NULL UNIQUE,
    rows TEXT NOT NULL DEFAULT '[]',
    meta TEXT NOT NULL DEFAULT '{}',
    total INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_history_created ON search_history(created_at DESC);
CREATE TABLE IF NOT EXISTS resolved_urls (
    source_url TEXT PRIMARY KEY,
    target_url TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reader_cache (        -- 阅读器正文缓存（2026-10-27）
    url TEXT PRIMARY KEY,
    final_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    markdown TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    published TEXT NOT NULL DEFAULT '',
    engine TEXT NOT NULL DEFAULT '',     -- http | render | failed
    status TEXT NOT NULL DEFAULT 'ok',   -- ok | partial | failed
    chars INTEGER NOT NULL DEFAULT 0,
    errors TEXT NOT NULL DEFAULT '[]',
    warnings TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reader_cache_created ON reader_cache(created_at DESC);
"""

def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json_list(raw: object) -> list:
    """把库里存的 JSON 数组解析回 list；坏数据/非数组一律回空列表。

    绝不抛：库里的脏 JSON（历史写入 / 手改）不该让读取端点 500。
    """
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def _migrate(conn: sqlite3.Connection) -> None:
    """按 PRAGMA 实测列集幂等迁移（不按版本号分支——9515da9 教训：并行编辑掉落
    ALTER + 启动无条件升版本号会掩盖缺列）。版本号 upsert 由调用方在迁移后执行。"""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(articles)")}
    if "has_poc" not in cols:
        conn.execute("ALTER TABLE articles ADD COLUMN has_poc INTEGER NOT NULL DEFAULT 0")
    if "poc_url" not in cols:
        conn.execute("ALTER TABLE articles ADD COLUMN poc_url TEXT NOT NULL DEFAULT ''")
    if "published_day" not in cols:
        conn.execute("ALTER TABLE articles ADD COLUMN published_day TEXT NOT NULL DEFAULT ''")
    if "via" not in cols:
        conn.execute("ALTER TABLE articles ADD COLUMN via TEXT NOT NULL DEFAULT ''")
    if "focus_keywords" not in cols:
        conn.execute("ALTER TABLE articles ADD COLUMN focus_keywords TEXT NOT NULL DEFAULT '[]'")
    vcols = {r[1] for r in conn.execute("PRAGMA table_info(vault_notes)")}
    if vcols and "category" not in vcols:  # F5：frontmatter category 入索引
        conn.execute("ALTER TABLE vault_notes ADD COLUMN category TEXT NOT NULL DEFAULT ''")


class IntelStore:
    def __init__(self, intel_dir: str | Path = DEFAULT_INTEL_DIR):
        self.dir = migrate_default_dir(intel_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "intel.db"
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(_DDL)
        _migrate(self._conn)
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_articles_published_day ON articles(published_day)")
        # 一次性回填日期归一化；非法/未知日期保持空串，绝不猜测。
        from core.intel.ranking import normalize_day
        rows = self._conn.execute("SELECT id, published_at FROM articles WHERE published_day='' AND published_at!=''").fetchall()
        for row in rows:
            day = normalize_day(row["published_at"])
            if day:
                self._conn.execute("UPDATE articles SET published_day=? WHERE id=?", (day, row["id"]))
        self._conn.execute(
            "INSERT INTO meta(key,value) VALUES('schema_version',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(SCHEMA_VERSION),))
        self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---- 搜索历史 ----

    def save_search(self, query: str, rows: list[dict], meta: dict,
                    *, cache_key: str, limit: int = 20) -> dict:
        query = str(query or "").strip()[:120]
        cache_key = str(cache_key or "").strip()[:100]
        if not query or not cache_key:
            raise ValueError("搜索词和缓存键不能为空")
        created_at = now()
        with self._lock:
            self._conn.execute(
                "INSERT INTO search_history(id,query,cache_key,rows,meta,total,created_at) "
                "VALUES(?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET "
                "query=excluded.query,rows=excluded.rows,meta=excluded.meta,"
                "total=excluded.total,created_at=excluded.created_at",
                (new_id("search"), query, cache_key,
                 json.dumps(rows, ensure_ascii=False),
                 json.dumps(meta, ensure_ascii=False), len(rows), created_at))
            self._conn.execute(
                "DELETE FROM search_history WHERE id NOT IN ("
                "SELECT id FROM search_history ORDER BY created_at DESC LIMIT ?)",
                (max(1, min(int(limit or 20), 100)),))
            self._conn.commit()
        return {"query": query, "cache_key": cache_key, "total": len(rows),
                "created_at": created_at, "meta": meta}

    def list_searches(self, limit: int = 20) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id,query,cache_key,total,created_at,meta FROM search_history "
                "ORDER BY created_at DESC LIMIT ?",
                (max(1, min(int(limit or 20), 100)),)).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item["meta"] = json.loads(item.get("meta") or "{}")
            out.append(item)
        return out

    def get_search(self, cache_key: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM search_history WHERE cache_key=?", (str(cache_key),)
            ).fetchone()
        if row is None:
            return None
        item = dict(row)
        item["rows"] = json.loads(item.get("rows") or "[]")
        item["meta"] = json.loads(item.get("meta") or "{}")
        return item

    def get_resolved_url(self, source_url: str) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT target_url FROM resolved_urls WHERE source_url=?", (source_url,)
            ).fetchone()
        return str(row["target_url"]) if row else None

    def save_resolved_url(self, source_url: str, target_url: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO resolved_urls(source_url,target_url,created_at) VALUES(?,?,?) "
                "ON CONFLICT(source_url) DO UPDATE SET target_url=excluded.target_url, "
                "created_at=excluded.created_at", (source_url, target_url, now()))
            self._conn.commit()

    # ---- 阅读器正文缓存（2026-10-27） ----

    def get_read(self, url: str, *, max_age_s: int | None = None) -> dict | None:
        """取缓存正文。`max_age_s` 为 None 时不判过期；给正整数则超龄返回 None 触发重抓。

        **不用 0 当「不限」**：0 的直觉含义是「立刻过期」，拿它表示无限期是反直觉的
        坑（调用方传 0 会意外拿到任意旧正文）。需要「不管多旧」时传 None。
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM reader_cache WHERE url=?", (str(url),)).fetchone()
        if row is None:
            return None
        item = dict(row)
        item["errors"] = _json_list(item.get("errors"))
        item["warnings"] = _json_list(item.get("warnings"))
        if max_age_s is not None:
            try:
                age = (datetime.now(timezone.utc)
                       - datetime.fromisoformat(item["created_at"])).total_seconds()
            except (TypeError, ValueError):
                return None
            if age > max_age_s:
                return None
        return item

    def save_read(self, item: dict) -> None:
        """写入正文缓存。**失败结果存 0 秒语义**——即不落库。

        「网页抓取失败」几乎都是暂态（风控窗口、站点抖动、渲染超时）。把一次
        失败持久化下来，用户之后每次点同一篇都直接吃缓存里的失败，看起来像
        「这个功能永远坏着」。故只有 ok/partial 才落库，failed 交由前端
        「重试」按钮重新走一遍完整链路。
        """
        status = str(item.get("status") or "")
        if status not in ("ok", "partial"):
            return
        with self._lock:
            self._conn.execute(
                "INSERT INTO reader_cache(url,final_url,title,markdown,text,site,"
                "author,published,engine,status,chars,errors,warnings,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(url) DO UPDATE SET final_url=excluded.final_url,"
                "title=excluded.title,markdown=excluded.markdown,text=excluded.text,"
                "site=excluded.site,author=excluded.author,published=excluded.published,"
                "engine=excluded.engine,status=excluded.status,chars=excluded.chars,"
                "errors=excluded.errors,warnings=excluded.warnings,"
                "created_at=excluded.created_at",
                (str(item.get("url") or ""), str(item.get("final_url") or ""),
                 str(item.get("title") or ""), str(item.get("markdown") or ""),
                 str(item.get("text") or ""), str(item.get("site") or ""),
                 str(item.get("author") or ""), str(item.get("published") or ""),
                 str(item.get("engine") or ""), status,
                 int(item.get("chars") or 0),
                 json.dumps(item.get("errors") or [], ensure_ascii=False),
                 json.dumps(item.get("warnings") or [], ensure_ascii=False),
                 now()))
            # 缓存上限：400 篇（技术长文正文占空间，过量会拖慢库文件；
            # 淘汰最旧的，阅读记录本身另有文章池兜底）
            self._conn.execute(
                "DELETE FROM reader_cache WHERE url NOT IN ("
                "SELECT url FROM reader_cache ORDER BY created_at DESC LIMIT 400)")
            self._conn.commit()

    # ---- 文章池 ----

    def upsert_articles(self, items: list[dict]) -> int:
        """按 URL 入池；已存在只升不降地补 has_poc/poc_url（NVD 后补 Exploit 标签的
        窗口差回填），不动打分/已读状态。返回新入池条数。"""
        n = 0
        with self._lock:
            cur = self._conn.cursor()
            for it in items:
                existing = cur.execute("SELECT focus_keywords FROM articles WHERE url=?",
                                       (it["url"],)).fetchone()
                if existing is None:
                    n += 1
                    focus_keywords = []
                else:
                    try:
                        focus_keywords = json.loads(existing["focus_keywords"] or "[]")
                    except (TypeError, ValueError):
                        focus_keywords = []
                    if not isinstance(focus_keywords, list):
                        focus_keywords = []
                keyword = str(it.get("focus_keyword") or "").strip()
                added_focus = bool(keyword and keyword.casefold() not in {
                    str(k).casefold() for k in focus_keywords})
                if added_focus:
                    focus_keywords.append(keyword)
                cur.execute(
                    "INSERT INTO articles(id,url,title,source,kind,summary,"
                    "published_at,published_day,fetched_at,via,focus_keywords,is_priority,has_poc,poc_url) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(url) DO UPDATE SET "
                    "focus_keywords=CASE WHEN ? THEN excluded.focus_keywords ELSE articles.focus_keywords END, "
                    "via=CASE WHEN excluded.via!='' THEN excluded.via ELSE articles.via END, "
                    "has_poc=MAX(articles.has_poc, excluded.has_poc), "
                    "poc_url=CASE WHEN excluded.has_poc=1 AND articles.has_poc=0 "
                    "THEN excluded.poc_url ELSE articles.poc_url END",
                    (new_id("art"), it["url"], it["title"], it["source"], it["kind"],
                     it.get("summary", ""), it.get("published_at", ""),
                     it.get("published_day") or normalize_day(it.get("published_at", "")),
                     now(), it.get("via", ""),
                     json.dumps(focus_keywords, ensure_ascii=False),
                     1 if it.get("is_priority") else 0,
                     1 if it.get("has_poc") else 0, it.get("poc_url", ""),
                     1 if added_focus else 0))
            self._conn.commit()
        return n

    def unscored(self, limit: int = 200) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM articles WHERE score=0 AND score_detail='' "
                "ORDER BY fetched_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    def apply_scores(self, scores: list[dict]) -> None:
        """scores: [{id, score, direction, is_priority?, score_detail}]"""
        with self._lock:
            cur = self._conn.cursor()
            for s in scores:
                cur.execute(
                    "UPDATE articles SET score=?, direction=?, score_detail=? "
                    "WHERE id=?",
                    (s["score"], s.get("direction", ""),
                     json.dumps(s.get("score_detail", {}), ensure_ascii=False), s["id"]))
                if s.get("is_priority") is not None:
                    cur.execute("UPDATE articles SET is_priority=? WHERE id=?",
                                (1 if s["is_priority"] else 0, s["id"]))
            self._conn.commit()

    def search_articles(self, query: str, *, since: str = "", limit: int = 100) -> list[dict]:
        """在本地文章池按标题/摘要/来源搜索，默认只收归一化日期在窗口内的文章。"""
        query = str(query or "").strip()
        if not query:
            return []
        like = f"%{query.replace('%', '\\%').replace('_', '\\_')}%"
        sql = ("SELECT * FROM articles WHERE (title LIKE ? ESCAPE '\\' "
               "OR summary LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')")
        args: list = [like, like, like]
        if since:
            sql += " AND published_day >= ?"
            args.append(str(since)[:10])
        sql += " ORDER BY is_priority DESC, score DESC, published_day DESC, fetched_at DESC LIMIT ?"
        args.append(max(1, min(int(limit or 100), 500)))
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        return [dict(r) for r in rows]

    def list_articles(self, *, kind: str | None = None, unread_only: bool = False,
                      starred_only: bool = False, limit: int = 50) -> list[dict]:
        sql = "SELECT * FROM articles WHERE 1=1"
        args: list = []
        if kind:
            sql += " AND kind=?"; args.append(kind)
        if unread_only:
            sql += " AND read=0"
        if starred_only:
            sql += " AND starred=1"
        sql += " ORDER BY is_priority DESC, score DESC, fetched_at DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        return [dict(r) for r in rows]

    def recent_vulns(self, *, since: str = "", until: str = "",
                     only_poc: bool = False, limit: int = 50) -> list[dict]:
        """按**抓取日期窗**取漏洞条目（渗透测试与情报联动的入口）。

        与 `list_articles(kind="cve")` 的区别：那个按 `is_priority/score` 排序（简报选材
        口径），本方法按 **`fetched_at` 日期窗**过滤——「今天收集到的漏洞」问的是时间，
        不是分数。`published_at` 不用：NVD 的 published 是漏洞披露日，可能是几年前的，
        与「今天新进库」不是一回事。

        日期口径：`fetched_at` 是 UTC ISO 串（`2026-10-22T03:11:05+00:00`），故只取
        前 10 字符做字符串比较即可（ISO 8601 字典序 == 时间序）。`since`/`until` 均含端点，
        空串=不限该端。

        `only_poc=True` 只回有公开 PoC 的条目——**批量验证前的默认口径**：没 PoC 的漏洞
        让 agent 现场从零写利用，投入产出比极差，且容易写成「猜着打」。
        """
        sql = "SELECT * FROM articles WHERE kind='cve'"
        args: list = []
        if since:
            sql += " AND substr(fetched_at,1,10) >= ?"; args.append(str(since)[:10])
        if until:
            sql += " AND substr(fetched_at,1,10) <= ?"; args.append(str(until)[:10])
        if only_poc:
            sql += " AND has_poc=1"
        sql += (" ORDER BY has_poc DESC, is_priority DESC, score DESC,"
                " fetched_at DESC LIMIT ?")
        args.append(max(1, min(int(limit or 50), 500)))
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        return [dict(r) for r in rows]

    def latest_article_date(self) -> str:
        """最近一次抓取日（`fetched_at` 前 10 字符）；空库返回 ''。

        工具层用它把「今天的情报」落到**真实有数据的那一天**——库可能今天还没抓，
        直接按系统日期查会返回空，模型会误以为「今天没有新漏洞」。
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT MAX(substr(fetched_at,1,10)) d FROM articles").fetchone()
        return str((row["d"] if row else "") or "")

    def mark_article(self, article_id: str, *, read: bool | None = None,
                     starred: bool | None = None) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM articles WHERE id=?",
                                     (article_id,)).fetchone()
            if row is None:
                return None
            if read is not None:
                self._conn.execute("UPDATE articles SET read=? WHERE id=?",
                                   (1 if read else 0, article_id))
            if starred is not None:
                self._conn.execute("UPDATE articles SET starred=? WHERE id=?",
                                   (1 if starred else 0, article_id))
            self._conn.commit()
            return dict(self._conn.execute("SELECT * FROM articles WHERE id=?",
                                           (article_id,)).fetchone())

    # ---- 简报 ----

    def save_brief(self, date: str, content: str, stats: dict) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO briefs(date,content,stats,created_at) VALUES(?,?,?,?) "
                "ON CONFLICT(date) DO UPDATE SET content=excluded.content, "
                "stats=excluded.stats", (date, content,
                                         json.dumps(stats, ensure_ascii=False), now()))
            self._conn.commit()

    def get_brief(self, date: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM briefs WHERE date=?",
                                     (date,)).fetchone()
        if row is None:
            return None
        d = dict(row)
        d["stats"] = json.loads(d.get("stats") or "{}")
        return d

    def list_briefs(self) -> list[dict]:
        """归档列表（不含全文）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT date, stats, created_at FROM briefs ORDER BY date DESC").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["stats"] = json.loads(d.get("stats") or "{}")
            out.append(d)
        return out

    def counts(self) -> dict:
        with self._lock:
            total = self._conn.execute("SELECT COUNT(*) c FROM articles").fetchone()["c"]
            unread = self._conn.execute(
                "SELECT COUNT(*) c FROM articles WHERE read=0").fetchone()["c"]
            starred = self._conn.execute(
                "SELECT COUNT(*) c FROM articles WHERE starred=1").fetchone()["c"]
        return {"articles": total, "unread": unread, "starred": starred}

    # ---- vault 笔记元数据索引（E10，只读；正文仅本地搜索用） ----

    def replace_notes(self, notes: list[dict]) -> int:
        """全量重建索引（事务内清表重灌）。返回入索引篇数。"""
        with self._lock:
            self._conn.execute("DELETE FROM vault_notes")
            for n in notes:
                self._conn.execute(
                    "INSERT OR REPLACE INTO vault_notes"
                    "(path,title,tags,category,mtime,size,content,indexed_at) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (n["path"], n.get("title", ""),
                     json.dumps(n.get("tags", []), ensure_ascii=False),
                     n.get("category", ""),
                     n.get("mtime", ""), n.get("size", 0),
                     n.get("content", ""), now()))
            self._conn.commit()
        return len(notes)

    def list_notes(self, limit: int = 2000) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT path,title,tags,category,mtime,size,indexed_at FROM vault_notes "
                "ORDER BY path LIMIT ?", (limit,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["tags"] = json.loads(d.get("tags") or "[]")
            out.append(d)
        return out

    def search_notes(self, q: str, limit: int = 50) -> list[dict]:
        """本地全文搜索（title/tags/content LIKE）。返回元数据 + 命中 snippet，不返回全文。"""
        q = q.strip()
        if not q:
            return []
        like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        with self._lock:
            rows = self._conn.execute(
                "SELECT path,title,tags,mtime,size,content FROM vault_notes "
                "WHERE title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' "
                "OR content LIKE ? ESCAPE '\\' ORDER BY path LIMIT ?",
                (like, like, like, limit)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["tags"] = json.loads(d.get("tags") or "[]")
            content = d.pop("content", "")
            pos = content.lower().find(q.lower())
            if pos < 0:  # 命中在 title/tags 而非正文
                d["snippet"] = content[:120]
            else:
                s = max(0, pos - 80)
                d["snippet"] = ("…" if s > 0 else "") + content[s:pos + len(q) + 80] + "…"
            out.append(d)
        return out

    def note_stats(self) -> dict:
        with self._lock:
            total = self._conn.execute("SELECT COUNT(*) c FROM vault_notes").fetchone()["c"]
            row = self._conn.execute(
                "SELECT MAX(indexed_at) m FROM vault_notes").fetchone()
        return {"notes": total, "last_indexed": row["m"] or ""}

    def platform_direction_counts(self) -> dict:
        """文章池按方向的已读/收藏计数（E10 学习档案平台侧来源）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT direction, COUNT(*) total, SUM(read) reads, SUM(starred) stars "
                "FROM articles WHERE direction!='' GROUP BY direction").fetchall()
        return {r["direction"]: {"notes": 0, "total": r["total"],
                                 "read": r["reads"] or 0, "starred": r["stars"] or 0}
                for r in rows}

    # ---- 周学习计划（E10） ----

    def save_plan(self, week: str, content: str, inputs: dict) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO learning_plans(week,content,inputs,created_at) VALUES(?,?,?,?) "
                "ON CONFLICT(week) DO UPDATE SET content=excluded.content, "
                "inputs=excluded.inputs", (week, content,
                                           json.dumps(inputs, ensure_ascii=False), now()))
            self._conn.commit()

    def get_plan(self, week: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM learning_plans WHERE week=?",
                                     (week,)).fetchone()
        if row is None:
            return None
        d = dict(row)
        d["inputs"] = json.loads(d.get("inputs") or "{}")
        return d

    def latest_plan(self) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT week FROM learning_plans ORDER BY week DESC LIMIT 1").fetchone()
        return self.get_plan(row["week"]) if row else None

    def list_plans(self) -> list[dict]:
        """归档列表（不含全文）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT week, inputs, created_at FROM learning_plans "
                "ORDER BY week DESC").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["inputs"] = json.loads(d.get("inputs") or "{}")
            out.append(d)
        return out
