"""CTF 题目 flag 台账与题目状态派生（challenge-flag-ledger，2026-10-19）。

**为什么要把 flag 从 findings 里搬出来**：`findings` 的「正式漏洞五项必填契约」
（漏洞名称/等级/类型/受影响资产/摘要/测试环境/操作步骤/验证结果/风险影响/POC）
是为渗透结论设计的。CTF 的 flag **不是漏洞**——此前为了让 flag 过闸，只能硬写
套话（`tools.py` 里 `risk_assessment: "CTF 题目环境内的解题结论，不对应真实业务
风险"` 就是被契约逼出来的）。语义错位还会连带两个真问题：

1. **状态无法派生**：一道题「解没解出来」要从 findings 的 severity/status 组合
   里猜，多个 flag（flag_count>1）时完全没法表达「拿到 1/3」；
2. **人工否决无处落地**：flagjudge 只有形态判定，误判必然发生；人工标错后既
   扣不掉「已解」状态，也没有「已拒绝」清单——模型会反复提交同一串白烧轮次。

本模块把 flag 做成**唯一真值**，题目状态一律**派生**（`challenge_state`），
不独立维护字段——否则会出现「状态说已解但 flag 表是空的」这种自相矛盾。

状态机（五态，不是三态）：

    untouched  未跑（无 flag、无候选、无活跃 Worker）
    running    有 Worker 在跑（附 running 数）
    partial    拿到部分进展仍需继续（部分 flag / 仅候选 / 已收尾待确认）
    solved     全部 flag 到手（或 flag_count 未声明时拿到 1 条 accepted）
    abandoned  人工放弃（否则「未跑」与「跑过但放弃」混在一起，Planner 无限重派）

**不再有「格式冲突」规则**（2026-11-03 用户裁决）：多 flag 题的答案格式本来就可能
各不相同（取证题的答案可以是山名、手机号、时间、布尔值），拿「前缀互不相同」
当判据会把正确答案压成 partial、永远不判解出。题目的解出只看 accepted 条数。

**verdict 语义**：`pending`（AI 判定通过待人工复核，即**候选**）/ `accepted`（有效）/
`rejected`（**人工标记错误**）。**只有 accepted 计入 solved**（2026-10-20 起）；
rejected 一律不进 solved 派生，且同串再提交必须拦（`is_rejected`）——这是「人工
标错」唯一真正生效的地方。
"""
from __future__ import annotations

import json
import logging
import math
import re
from collections import Counter
from typing import Any

from core.blackboard.store import _row_to_dict, new_id, now

log = logging.getLogger(__name__)

# verdict 三态。AI 判定通过落 pending（待人复核），人工确认落 accepted，
# 人工否决落 rejected。**没有**「AI 直接 accepted」——flag 判定是加分项不是
# 证明项，留一个人工确认窗口成本极低、收益是「模型自嗨」永远进不了 solved。
VERDICTS = frozenset({"pending", "accepted", "rejected"})

# **计入「解出」的只有 accepted**（2026-10-20 修正，用户裁决方案 A）。
#
# 此前 `pending` 也算解出，导致「候选 = 已解出」：AI 提交一个假 flag 就判 solved，
# 调度层立刻停派，题目被一条假答案提前终止——用户实测正是这个后果
# （`flag{E574...}` 与 `DASCTF{6f93...}` 同时入账，2/1 显示「已拿满」）。
#
# 现在的语义分工：
#   pending   候选（AI 形态判定通过，**未经人工确认**）→ 进台账、前端「待复核」可见，
#             但**不计 solved**，题目继续跑；
#   accepted  人工确认有效（强证据）→ 才算解出。
#
# **无人值守逃生阀**：`config.ctf.auto_accept_ai`（默认关）为真时，AI 判定通过
# 直接落 accepted——否则通宵跑题会全部停在 pending 白烧预算。开关由项目配置给，
# 不由模型自述给。
_COUNTED_VERDICTS = frozenset({"accepted"})
# 候选态：进台账但不计 solved。单独列出来，供 summary / review 区分渲染。
CANDIDATE_VERDICTS = frozenset({"pending"})

# 题目派生状态五态。
STATE_UNTOUCHED = "untouched"
STATE_RUNNING = "running"
STATE_PARTIAL = "partial"
STATE_SOLVED = "solved"
STATE_ABANDONED = "abandoned"
CHALLENGE_STATES = (STATE_UNTOUCHED, STATE_RUNNING, STATE_PARTIAL,
                    STATE_SOLVED, STATE_ABANDONED)

# flag_count 上限（防一次灌 99999 让题目永远解不完）
MAX_FLAG_COUNT = 50
_DEFAULT_FLAG_COUNT = 1


# ---------- 基础读写 ----------


def _normalize_flag(value: str) -> str:
    return str(value or "").strip()


def hint_index_of(row: dict | None) -> int:
    """台账行的 `hint_index`（0 是合法值——**不能用 `x or -1`**，会把 0 吃成 -1）。"""
    try:
        raw = (row or {}).get("hint_index")
        return int(raw) if raw is not None else -1
    except (TypeError, ValueError):
        return -1


def list_flags(bb, project_id: str, challenge_id: str, *,
               verdicts: Any = None) -> list[dict]:
    """某题目的全部 flag（按登记顺序，含 rejected）。

    ``verdicts`` 可传单个 verdict 或列表做过滤；``None`` = 全部（人工复核界面
    需要看到 rejected，才能撤销误否决）。

    **排序用 rowid 而不是 id**：`id` 是随机 hex（`cflag-<10位hex>`），同一秒内
    登记的多条 flag 其 `created_at` 完全相同，`ORDER BY created_at, id` 就会
    退化成按随机 id 排——「按登记顺序」这个承诺随即失效。实测后果：测试里用
    `list_flags(...)[-1]` 取「最新一条」，会随机取到别的条目，把 rejected 判到
    刚 accepted 的那条上（单跑通过、同批跑失败）。`challenge_flags.id` 是
    `TEXT PRIMARY KEY`（不是 `INTEGER PRIMARY KEY`），故隐式 rowid 仍是插入序。
    """
    sql = ("SELECT * FROM challenge_flags WHERE project_id=? AND challenge_id=?"
           " ORDER BY rowid ASC")
    args: list[Any] = [project_id, str(challenge_id or "")]
    rows = [_row_to_dict(r) or {} for r in bb.conn.execute(sql, args).fetchall()]
    if verdicts is not None:
        wanted = ({verdicts} if isinstance(verdicts, str)
                  else {str(v) for v in verdicts})
        rows = [r for r in rows if str(r.get("verdict") or "") in wanted]
    return rows


def accepted_flags(bb, project_id: str, challenge_id: str) -> list[dict]:
    """计入「解出」的 flag（**只算 accepted**，pending 是候选不算）。

    2026-10-20 语义变更：此前 pending 也计入，导致假 flag 一提交就判 solved、
    题目被提前终止。现在 pending 是候选——进台账、前端可见，但不计解出。
    """
    return [r for r in list_flags(bb, project_id, challenge_id)
            if str(r.get("verdict") or "") in _COUNTED_VERDICTS]


def candidate_flags(bb, project_id: str, challenge_id: str) -> list[dict]:
    """候选 flag（AI 判定通过、待人工确认；**不计解出**）。"""
    return [r for r in list_flags(bb, project_id, challenge_id)
            if str(r.get("verdict") or "") in CANDIDATE_VERDICTS]


def rejected_flags(bb, project_id: str, challenge_id: str) -> list[dict]:
    return list_flags(bb, project_id, challenge_id, verdicts="rejected")


def is_rejected(bb, project_id: str, challenge_id: str, flag: str) -> dict | None:
    """该串是否已被人工否决（命中返回该行，否则 None）。

    这是「人工标错」真正生效的地方：不加这道闸，模型会把同一串反复提交，
    每次都要跑一遍 flagjudge + 落一条 finding，纯烧轮次。
    """
    token = _normalize_flag(flag)
    if not token:
        return None
    for row in rejected_flags(bb, project_id, challenge_id):
        if _normalize_flag(row.get("flag")) == token:
            return row
    return None


def record_flag(bb, project_id: str, challenge_id: str, flag: str, *,
                flag_format: str = "", confidence: float = 0.0,
                source: str = "", transform: str = "",
                judged_by: str = "ai", verdict: str = "pending",
                verdict_reason: str = "", author: str = "",
                session_id: str = "", finding_id: str = "",
                hint_index: int | None = None) -> dict:
    """登记一条 flag（幂等：同题目同串只更新，不新增）。

    返回 ``{flag, created, rejected, row}``。``rejected=True`` 表示该串已被人工
    否决——调用方**必须**据此拒绝本次提交（不是「登记成功」）。

    幂等更新时**不降级 verdict**：已 accepted 的不会被后到的 pending 冲回去；
    已 rejected 的也不会被 pending 覆盖（人工裁决优先于 AI）。

    ``hint_index``：本行对应题面「第几条 flag」的提示（0 基，-1=未指定）。
    确认这条 flag 时会把 ``meta.flag_hints[hint_index]`` 一并告诉子 agent，
    它据此判断「这条是不是我正在分析的方向」——是就收尾，不是就继续。
    """
    cid = str(challenge_id or "").strip()
    if not cid:
        raise ValueError("challenge_id 必填")
    token = _normalize_flag(flag)
    if not token:
        raise ValueError("flag 不能为空")
    if verdict not in VERDICTS:
        raise ValueError(f"verdict 只能是 {'/'.join(sorted(VERDICTS))}")
    asset = bb.get_asset(cid)
    if asset is None or asset.get("project_id") != project_id:
        raise ValueError(f"题目不存在于本项目: {cid}")
    try:
        hidx = int(hint_index) if hint_index is not None else -1
    except (TypeError, ValueError):
        hidx = -1
    # 夹到 [-1, MAX_FLAG_COUNT-1]：模型可能传个越界值（如第 8 条但题目只 6 条）。
    # 越界值本身无害（派生时会被当「未指定」补空位），但落库就是脏数据——
    # 之后人工在台账里看到「第 8 条」会以为提示丢了。
    if hidx < -1 or hidx >= MAX_FLAG_COUNT:
        hidx = -1

    existing = bb.conn.execute(
        "SELECT * FROM challenge_flags WHERE project_id=? AND challenge_id=?"
        " AND flag=?", (project_id, cid, token)).fetchone()
    ts = now()
    if existing is not None:
        row = _row_to_dict(existing) or {}
        if str(row.get("verdict") or "") == "rejected":
            # 人工否决优先：不再改动，直接告诉调用方「这串被拒过」。
            return {"flag": token, "created": False, "rejected": True, "row": row}
        keep = str(row.get("verdict") or "")
        new_verdict = "accepted" if "accepted" in (keep, verdict) else verdict
        patch = {
            "verdict": new_verdict,
            "verdict_reason": (verdict_reason or str(row.get("verdict_reason") or ""))[:500],
            "confidence": max(float(row.get("confidence") or 0.0), float(confidence or 0.0)),
            "source": (source or str(row.get("source") or ""))[:2000],
            "transform": (transform or str(row.get("transform") or ""))[:200],
            "finding_id": (finding_id or str(row.get("finding_id") or ""))[:80],
            "flag_format": (flag_format or str(row.get("flag_format") or ""))[:40],
            # 提示序号：显式给了才覆盖（-1 不冲掉既有值——重新提交同串时
            # worker 通常不带 hint_index，不该把它清掉）。
            "hint_index": hidx if hidx >= 0 else hint_index_of(row),
            "updated_at": ts,
        }
        with bb._tx():
            bb.conn.execute(
                "UPDATE challenge_flags SET verdict=?, verdict_reason=?, confidence=?,"
                " source=?, transform=?, finding_id=?, flag_format=?, hint_index=?,"
                " updated_at=?"
                " WHERE id=? AND project_id=?",
                (patch["verdict"], patch["verdict_reason"], patch["confidence"],
                 patch["source"], patch["transform"], patch["finding_id"],
                 patch["flag_format"], patch["hint_index"], ts,
                 row["id"], project_id))
        bb.append_event(project_id, "challenge.flag.updated", {
            "challenge_id": cid, "flag_id": row["id"], "flag": token[:120],
            "verdict": patch["verdict"]})
        return {"flag": token, "created": False, "rejected": False,
                "row": {**row, **patch}}

    fid = new_id("cflag")
    with bb._tx():
        bb.conn.execute(
            "INSERT INTO challenge_flags(id,project_id,challenge_id,flag,flag_format,"
            "confidence,source,transform,judged_by,verdict,verdict_reason,author,"
            "session_id,finding_id,hint_index,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (fid, project_id, cid, token, str(flag_format or "")[:40],
             float(confidence or 0.0), str(source or "")[:2000],
             str(transform or "")[:200], str(judged_by or "ai"), verdict,
             str(verdict_reason or "")[:500], str(author or ""),
             str(session_id or ""), str(finding_id or "")[:80], hidx, ts, ts))
    bb.append_event(project_id, "challenge.flag.recorded", {
        "challenge_id": cid, "flag_id": fid, "flag": token[:120],
        "verdict": verdict, "judged_by": judged_by,
        "confidence": round(float(confidence or 0.0), 2)})
    row = _row_to_dict(bb.conn.execute(
        "SELECT * FROM challenge_flags WHERE id=?", (fid,)).fetchone()) or {}
    return {"flag": token, "created": True, "rejected": False, "row": row}


def set_finding_id(bb, project_id: str, flag_id: str, finding_id: str) -> None:
    """把过程留痕 finding 的 id 回填到 flag 行（flag 落台账后才有 finding）。

    留痕 finding 只是可读的过程记录（intel/unverified），**不是** flag 的真值；
    回填失败/为空都不影响台账语义，故本函数静默容忍缺行。
    """
    fid = str(flag_id or "").strip()
    if not fid:
        return
    with bb._tx():
        bb.conn.execute(
            "UPDATE challenge_flags SET finding_id=?, updated_at=?"
            " WHERE id=? AND project_id=?",
            (str(finding_id or "")[:80], now(), fid, project_id))


def decide_flag(bb, project_id: str, flag_id: str, *, verdict: str,
                reason: str = "", author: str = "") -> dict:
    """人工裁决（确认 / 否决 / 撤销否决）。

    ``verdict='rejected'`` 就是用户说的「人工标记为错误 flag」——该串立刻从
    solved 派生里扣除（状态是派生值，自动生效），并进「已拒绝」清单。
    """
    if verdict not in VERDICTS:
        raise ValueError(f"verdict 只能是 {'/'.join(sorted(VERDICTS))}")
    row = bb.conn.execute(
        "SELECT * FROM challenge_flags WHERE id=? AND project_id=?",
        (str(flag_id or ""), project_id)).fetchone()
    if row is None:
        raise ValueError(f"flag 记录不存在: {flag_id}")
    old = _row_to_dict(row) or {}
    ts = now()
    with bb._tx():
        bb.conn.execute(
            "UPDATE challenge_flags SET verdict=?, verdict_reason=?, judged_by='human',"
            " updated_at=? WHERE id=? AND project_id=?",
            (verdict, str(reason or "")[:500], ts, old["id"], project_id))
    bb.append_event(project_id, "challenge.flag.decided", {
        "challenge_id": old.get("challenge_id"), "flag_id": old["id"],
        "flag": str(old.get("flag") or "")[:120],
        "verdict": verdict, "previous": old.get("verdict"),
        "author": str(author or "")[:80], "reason": str(reason or "")[:200]})
    return _row_to_dict(bb.conn.execute(
        "SELECT * FROM challenge_flags WHERE id=?", (old["id"],)).fetchone()) or {}


# ---------- 题目状态派生 ----------


def _meta_of(asset: dict | None) -> dict:
    """资产 meta（``get_asset`` 返回的已是 dict；原始行可能是 JSON 串）。

    两种形态都要认：``list_assets``/``get_asset`` 走 ``_row_to_dict`` 不解码 meta，
    而部分调用方（API 层）会先 json.loads。写成一个 helper 避免每处都 try/except。
    """
    raw = (asset or {}).get("meta")
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw or "{}") or {}
    except (TypeError, ValueError):
        return {}


def challenge_flag_quota(bb, project_id: str, challenge_id: str) -> int:
    """题目声明的 flag 数量（meta.flag_count，缺省/坏值 = 1，上限 50）。"""
    meta = _meta_of(bb.get_asset(challenge_id))
    try:
        n = int(meta.get("flag_count") or _DEFAULT_FLAG_COUNT)
    except (TypeError, ValueError):
        n = _DEFAULT_FLAG_COUNT
    return max(1, min(n, MAX_FLAG_COUNT))


def challenge_flag_hints(bb, challenge_id: str) -> list[str]:
    """题目声明的「每条 flag 各一句提示」（`meta.flag_hints`，2026-10-21）。

    按**序号**与 flag 对齐（第 i 条提示对应第 i 个 flag）。空串 = 题面没给这条
    提示，**必须保留占位**，否则后面几条全错位。

    用途：确认某条 flag 时把对应提示一并告诉子 agent——它据此判断「这条是不是
    我正在分析的方向」，是就收尾、不是就继续。没有提示时它只能看 flag 原文
    （`flag{1a2b}`），对方向的指示性几乎为零，只能猜。
    """
    meta = _meta_of(bb.get_asset(challenge_id))
    raw = meta.get("flag_hints")
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[str] = []
    for it in list(raw)[:MAX_FLAG_COUNT]:
        out.append(str(it or "").strip()[:300])
    while out and not out[-1]:
        out.pop()
    return out


def flag_hint_at(bb, challenge_id: str, index: int) -> str:
    """第 ``index`` 个 flag（0 基）的提示；没声明 / 越界 / 空 → 空串。"""
    hints = challenge_flag_hints(bb, challenge_id)
    if 0 <= index < len(hints):
        return hints[index]
    return ""


def accepted_flag_briefs(bb, project_id: str, challenge_id: str) -> list[dict]:
    """已确认 flag 的「序号 + 原文 + 题面提示」清单（flag-hint，2026-10-21）。

    这是「告诉子 agent 已经拿到哪些 flag」的数据源。每条：

    ``{index, flag, hint}``——``index`` 是**题面里的第几条**（1 基，供人读；
    未绑定为 ``None``），``hint`` 是该条的题面提示（没绑定为空串）。

    **只认台账行上显式写入的 `hint_index`，不做任何「按空位推断」**（2026-11-03）：
    此前未指定（-1）的行会按 accepted 顺序补第一个空位，于是「A 题面的答案」会被
    贴上「B 题面的要求」——用户实测服务器取证整题序号偏移两条。序号来自题面，
    推断出来的序号就是假事实；没有绑定就老实显示「未标注题面」。

    排序：已绑定的按序号升序，未绑定的排在最后（按登记顺序）。
    """
    rows = accepted_flags(bb, project_id, challenge_id)
    hints = challenge_flag_hints(bb, challenge_id)
    out: list[dict] = []
    for r in rows:
        idx = hint_index_of(r)
        if not (0 <= idx < len(hints)):
            idx = -1
        out.append({"index": idx + 1 if idx >= 0 else None,
                    "flag": str(r.get("flag") or ""),
                    "hint": hints[idx] if idx >= 0 else "",
                    "_sort": idx if idx >= 0 else MAX_FLAG_COUNT})
    out.sort(key=lambda x: x["_sort"])
    for item in out:
        item.pop("_sort", None)
    return out


# ---------- 题面提示 ↔ flag 来源的匹配（2026-11-03） ----------
#
# 背景：`ctf_submit_flag` 的 `hint_index` 由模型自由填写，而历史实现既不校验、
# 又在展示时按空位推断，导致「B 题面的答案提交到 A 题面的序号」（用户实测
# proj-1936a1c76e50 服务器取证整题偏移 2 条）。这里用**来源文本**做机械核对：
# 题面提示里的中文/英文关键词若出现在解题路径里，说明这一对是可信的。
#
# 只做「明显矛盾」的判定：题面提示与来源一个词都不重合，或另一个提示的匹配度
# 远高于当前选择。匹配度接近时不猜（保留模型选择），避免把正确的绑定改坏。

_CJK_RUN_RE = re.compile(r"[\u4e00-\u9fff]{2,}")
_ASCII_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.\-]{1,}")
_HINT_PREFIX_RE = re.compile(r"^题\s*\d+\s*")
_HINT_FORMAT_RE = re.compile(r"[，,（(]?格式[：:].*$")

# 判定「来源与提示有实质重合」的下限；低于它视为对不上。
_HINT_MIN_MATCH = 5.0
# 判定「另一个提示明显更匹配」的下限与倍数。
_HINT_STRONG_MATCH = 30.0
_HINT_STRONG_RATIO = 2.5
# 存量重绑更保守：必须**强**匹配（60 分 ≈ 来源里成段复述了题面要求），且
# ≥3 倍于次优，否则不动。实测把阈值放到 30 时，手机取证两条会被「来源描述了
# 取证过程而非答案主题」带偏（17751125237 是手机号却被「中国电信 SIM」拉到
# IMSI 条；勇哥是人名却被「记账软件」拉到记账笔数条），60 分能挡住这两类。
_REBIND_MIN_MATCH = 60.0
_REBIND_MIN_RATIO = 3.0


def _hint_terms(hint: str) -> set[str]:
    """题面提示里的可匹配词元：中文 2/3/4-gram + 英文单词（小写）。

    中文按 n-gram 切而不是整句：来源里通常只出现提示的一部分
    （「二级域名」出现在「盲盒平台可选二级域名数量」的答案来源里）。
    """
    text = _HINT_FORMAT_RE.sub("", _HINT_PREFIX_RE.sub("", str(hint or "")))
    terms: set[str] = set()
    for run in _CJK_RUN_RE.findall(text):
        for n in (2, 3, 4):
            for i in range(len(run) - n + 1):
                terms.add(run[i:i + n])
    for word in _ASCII_WORD_RE.findall(text):
        terms.add(word.lower())
    return terms


def _hint_weights(hints: list[str]) -> dict[str, float]:
    """按提示列表算 IDF 权重：多条题面共有的词（如「金瑞币平台」）自动降权。"""
    docs = [_hint_terms(h) for h in hints]
    df = Counter(t for d in docs for t in d)
    n = max(len(docs), 1)
    return {t: math.log((n + 1) / (c + 1)) + 1.0 for t, c in df.items()}


def _hint_number(hint: str) -> int | None:
    m = re.match(r"^题\s*(\d+)", str(hint or ""))
    return int(m.group(1)) if m else None


def hint_match_scores(source: str, hints: list[str]) -> list[float]:
    """来源文本对每条题面提示的匹配分（下标与 hints 对齐）。"""
    src = str(source or "").lower()
    weights = _hint_weights(hints)
    scores: list[float] = []
    for hint in hints:
        score = sum(len(t) * weights[t]
                    for t in _hint_terms(hint) if t in src)
        num = _hint_number(hint)
        # 来源里显式写了「题N」→ 强信号（不少取证题会直接把题号抄进路径）
        if num is not None and re.search(rf"题\s*{num}(?!\d)", src):
            score += 30.0
        scores.append(score)
    return scores


def best_hint_for_source(source: str, hints: list[str]) -> tuple[int, float, float]:
    """来源最匹配的提示：``(下标, 最高分, 次高分)``；无提示/无匹配返回 (-1, 0, 0)。"""
    if not hints:
        return -1, 0.0, 0.0
    scores = hint_match_scores(source, hints)
    ranked = sorted(range(len(scores)), key=lambda i: -scores[i])
    best = ranked[0]
    second = scores[ranked[1]] if len(ranked) > 1 else 0.0
    return best, scores[best], second


def verify_hint_index(bb, challenge_id: str, source: str,
                      hint_index: int | None) -> tuple[int, str]:
    """核对 agent 传来的 `hint_index`（2026-11-03）。

    返回 ``(采用的序号, 回执提示)``。只在**有明确反证**时改判为 -1：
    - 该序号对应的提示与来源毫无重合（`< _HINT_MIN_MATCH`）；
    - 或另一条提示的匹配分 ≥30 且 ≥2.5 倍，说明提交时数错了。
    匹配度接近时不猜，保留 agent 的选择（避免把正确绑定改坏）。
    """
    hints = challenge_flag_hints(bb, challenge_id)
    if hint_index is None:
        return -1, ""
    try:
        idx = int(hint_index)
    except (TypeError, ValueError):
        return -1, ""
    if idx < 0 or idx >= len(hints):
        return -1, ""
    if not hints[idx].strip():
        # 该条题面没写提示，无从核对——保留序号（它是空位占位，不算错）。
        return idx, ""
    scores = hint_match_scores(source, hints)
    cur = scores[idx]
    best, best_score, _ = best_hint_for_source(source, hints)
    if (best != idx and best_score >= _HINT_STRONG_MATCH
            and best_score >= _HINT_STRONG_RATIO * max(cur, _HINT_MIN_MATCH)):
        return -1, (f"\n[提示] 你传的 hint_index={idx}（{hints[idx]}）与来源对不上，"
                    f"按来源最匹配的是 #{best}（{hints[best]}）。本次已记为"
                    "「未标注题面」，请在台账里绑定，或按正确序号重新提交。")
    if cur < _HINT_MIN_MATCH:
        return -1, (f"\n[提示] 来源里没有与题面「{hints[idx]}」重合的关键词，"
                    "本次已记为「未标注题面」——不要按「已提交几条」猜序号，"
                    "用系统提示里列出的 hint_index 原值。")
    return idx, ""


def set_flag_hint(bb, project_id: str, flag_id: str,
                  hint_index: int) -> dict:
    """人工把某条 flag 绑定到题面第几条（-1=解除绑定）。

    序号以题面提示列表长度为准（空提示列表只允许 -1），避免落越界脏数据。
    允许同一序号被多条 flag 绑定：同一题面要求的多种写法（如带/不带分隔符的
    会议号）都算这条的答案，强行唯一会逼人把变体标错。
    """
    row = bb.conn.execute(
        "SELECT * FROM challenge_flags WHERE id=? AND project_id=?",
        (str(flag_id or ""), project_id)).fetchone()
    if row is None:
        raise ValueError(f"flag 记录不存在: {flag_id}")
    old = _row_to_dict(row) or {}
    hints = challenge_flag_hints(bb, str(old.get("challenge_id") or ""))
    try:
        idx = int(hint_index)
    except (TypeError, ValueError):
        raise ValueError("hint_index 必须是整数") from None
    if idx < -1 or idx >= max(len(hints), 1):
        raise ValueError(f"hint_index 越界：本题只有 {len(hints)} 条题面提示")
    with bb._tx():
        bb.conn.execute(
            "UPDATE challenge_flags SET hint_index=?, updated_at=?"
            " WHERE id=? AND project_id=?",
            (idx, now(), old["id"], project_id))
    bb.append_event(project_id, "challenge.flag.hint", {
        "challenge_id": old.get("challenge_id"), "flag_id": old["id"],
        "hint_index": idx,
        "previous": hint_index_of(old)})
    return _row_to_dict(bb.conn.execute(
        "SELECT * FROM challenge_flags WHERE id=?", (old["id"],)).fetchone()) or {}


def rebind_flags_by_source(bb, project_id: str, challenge_id: str) -> dict:
    """按来源文本重绑存量 flag 的题面序号（2026-11-03，一次性修复用）。

    只处理 accepted / pending（rejected 不进展示，无需修）。只在**强匹配**时改：
    最高分 ≥60、且 ≥3 倍于次高分，否则保持原值（宁可不改，不再制造新错位）。
    返回 ``{checked, rebound: [...], skipped: [...]}`` 供人工核对。
    """
    hints = challenge_flag_hints(bb, challenge_id)
    rows = [r for r in list_flags(bb, project_id, challenge_id)
            if str(r.get("verdict") or "") in ("accepted", "pending")]
    report: dict = {"checked": len(rows), "rebound": [], "skipped": []}
    if not hints:
        return report
    for r in rows:
        cur = hint_index_of(r)
        best, score, second = best_hint_for_source(str(r.get("source") or ""), hints)
        if best < 0 or best == cur:
            continue
        if score < _REBIND_MIN_MATCH or score < _REBIND_MIN_RATIO * max(second, 1.0):
            report["skipped"].append({
                "flag_id": r.get("id"), "flag": r.get("flag"),
                "reason": f"匹配不足（best={score:.1f} second={second:.1f}）"})
            continue
        with bb._tx():
            bb.conn.execute(
                "UPDATE challenge_flags SET hint_index=?, updated_at=?"
                " WHERE id=? AND project_id=?",
                (best, now(), r["id"], project_id))
        report["rebound"].append({
            "flag_id": r.get("id"), "flag": r.get("flag"),
            "from": cur, "to": best, "hint": hints[best],
            "score": round(score, 1)})
    if report["rebound"]:
        bb.append_event(project_id, "challenge.flag.rebind", {
            "challenge_id": challenge_id,
            "count": len(report["rebound"]),
            "items": [{k: v for k, v in x.items() if k != "flag"}
                      for x in report["rebound"][:50]]})
    return report


def challenge_state(bb, project_id: str, challenge_id: str, *,
                    running: int = 0) -> dict:
    """派生一道题的状态。

    返回 ``{state, solved, accepted, candidate, rejected, quota, abandoned,
    running, over_quota}``。

    - ``running`` 由调用方传入该题目下当前 claimed/running 的 Intent 数（本模块
      不查 artex_intents，避免反向依赖调度层）；
    - ``abandoned`` 来自 meta.abandoned（人工放弃，唯一**不是**派生的一位——
      因为「放弃」是人类意图，不是数据事实）；
    - ``candidate`` 是待人工确认的候选数（**不计 solved**，2026-10-20 起）；
    - ``over_quota`` 是 accepted 数超过 quota（拿的比需要的多）。**它不压
      solved**：最典型成因是用户主动把 flag_count 下调（「这题只要一个」）。
      它只作为异常信号回传，供前端提示；
    - 判定优先级：**solved > partial > abandoned > running > untouched**。
      solved 优先于 abandoned：拿到全部 flag 后人工又标了放弃，仍算解出。
    """
    cid = str(challenge_id or "").strip()
    quota = challenge_flag_quota(bb, project_id, cid)
    counted = accepted_flags(bb, project_id, cid)
    candidates = candidate_flags(bb, project_id, cid)
    rejected = rejected_flags(bb, project_id, cid)
    over_quota = len(counted) > quota
    # 解出只看「已确认条数」——不再有前缀冲突压制（2026-11-03 用户裁决：
    # 多 flag 题的答案格式本来就各不相同）。
    solved = len(counted) >= quota
    meta = _meta_of(bb.get_asset(cid))
    abandoned = bool(meta.get("abandoned"))
    # 主控主动收尾（`set_concluded`）：不再派工，但**不伪装成 solved**。
    concluded = bool(meta.get("concluded"))
    if solved:
        state = STATE_SOLVED
    elif counted:
        state = STATE_PARTIAL
    elif abandoned:
        state = STATE_ABANDONED
    elif running > 0 and not concluded:
        state = STATE_RUNNING
    elif candidates:
        # **只有候选也算 partial**（2026-10-20）：`untouched` 的定义是「无 flag、
        # 无活跃 Worker」，而这里有 N 条候选——题目明显跑过、拿到东西了，只是
        # 还没人确认。报 untouched 会让用户以为这题根本没动过（前端徽标、覆盖度
        # 分母的「未测」全错）。partial 的语义是「拿到部分进展，仍需继续」，
        # 候选正是这个状态。
        state = STATE_PARTIAL
    elif concluded:
        state = STATE_PARTIAL
    else:
        state = STATE_UNTOUCHED
    return {"state": state, "solved": solved,
            "accepted": len(counted), "candidate": len(candidates),
            "rejected": len(rejected),
            "quota": quota, "abandoned": abandoned, "concluded": concluded,
            "over_quota": over_quota,
            "running": max(0, int(running or 0))}


def set_abandoned(bb, project_id: str, challenge_id: str, *,
                  abandoned: bool = True, author: str = "") -> dict:
    """人工标记「放弃这道题」/ 撤销放弃（meta.abandoned）。

    放弃后调度层不再为它派新 Worker（见 `claim_next_intent` 的题目闸），但既有
    flag 全部保留——放弃是「不继续投入」，不是「清空结论」。
    """
    asset = bb.get_asset(challenge_id)
    if asset is None or asset.get("project_id") != project_id:
        raise ValueError(f"题目不存在于本项目: {challenge_id}")
    row = bb.update_asset_meta(challenge_id, {"abandoned": bool(abandoned)})
    bb.append_event(project_id,
                    "challenge.abandoned" if abandoned else "challenge.resumed",
                    {"challenge_id": challenge_id, "author": str(author or "")[:80]})
    return row


def set_concluded(bb, project_id: str, challenge_id: str, *,
                  concluded: bool = True, reason: str = "",
                  author: str = "") -> dict:
    """**主控主动收尾**：宣称「这题的答案已经拿到，别再派工」（meta.concluded）。

    **为什么需要这个出口**（2026-10-20，方案 A 的配套）：

    `pending` 不计 solved 之后，AI 判定通过只能把题目停在 `partial`——必须等人
    点确认。这在有人值守时是对的（人工确认是强证据），但**通宵跑题会全部卡在
    pending 白烧预算**：明明解出来了，没人点按钮，调度层就一直在派 Worker。

    故给主控一个**显式收尾**动作：它看过证据、判定答案已拿到 → 置 `concluded`，
    调度层停止派工，但题目状态**仍是 partial/待复核**，不伪装成 solved。
    与 `abandoned` 的区别：放弃是「不做了，可能没解出」，收尾是「做完了，
    但等人工确认」——两者都不再派工，语义不同，前端徽标也不同。

    **与 solved 的区别**：`concluded` 只是「不再派工」的开关，**不参与 solved
    派生**。所以人工后来否决了那条候选，题目会退回 partial/untouched 并且
    `concluded` 仍在——此时调度层仍不派工。这是刻意的：主控已经判断过一轮，
    再派只会重复劳动；要重新开跑由人撤销 `concluded`。
    """
    asset = bb.get_asset(challenge_id)
    if asset is None or asset.get("project_id") != project_id:
        raise ValueError(f"题目不存在于本项目: {challenge_id}")
    patch = {"concluded": bool(concluded)}
    if concluded and str(reason or "").strip():
        patch["concluded_reason"] = str(reason)[:500]
    row = bb.update_asset_meta(challenge_id, patch)
    bb.append_event(project_id,
                    "challenge.concluded" if concluded else "challenge.reopened",
                    {"challenge_id": challenge_id,
                     "author": str(author or "")[:80],
                     "reason": str(reason or "")[:300]})
    return row


# ---------- 存量迁移 ----------


def backfill_from_findings(bb, project_id: str) -> dict:
    """把存量 findings 里的 flag（v47 之前唯一落点）补登进 challenge_flags。

    幂等：``UNIQUE(project_id, challenge_id, flag)`` + record_flag 的更新语义，
    重复跑只会刷新 confidence/source，不会重复插行。**只搬 formal flag**
    （evidence.flag 非空且该 finding 挂在题目子树内）；candidate 线索
    （category=intel）也搬，但 verdict 记 pending（不判为解出）。

    找不到题目归属的（target_asset_id 空/非 challenge）跳过——不猜。
    """
    moved = 0
    skipped = 0
    try:
        assets = bb.list_assets(project_id)
    except Exception:  # noqa: BLE001
        return {"moved": 0, "skipped": 0}
    by_id = {a["id"]: a for a in assets}

    def _challenge_of(aid: str) -> str:
        walker, seen = str(aid or ""), set()
        while walker and walker not in seen:
            seen.add(walker)
            row = by_id.get(walker)
            if row is None:
                return ""
            if row.get("type") == "challenge" and not row.get("parent_id"):
                return walker
            walker = str(row.get("parent_id") or "")
        return ""

    for f in bb.list_findings(project_id):
        ev = f.get("evidence") or {}
        if not isinstance(ev, dict):
            continue
        token = _normalize_flag(ev.get("flag"))
        if not token:
            continue
        cid = _challenge_of(str(f.get("target_asset_id") or ""))
        if not cid:
            skipped += 1
            continue
        try:
            r = record_flag(
                bb, project_id, cid, token,
                confidence=float(ev.get("flag_confidence") or 0.0),
                source=str(f.get("summary") or "")[:2000],
                transform=str((ev.get("flag_transform") or {}).get("transform") or ""),
                judged_by="ai", verdict="pending",
                author=str(f.get("author") or ""), finding_id=str(f.get("id") or ""))
        except ValueError:
            skipped += 1
            continue
        if r.get("created"):
            moved += 1
    if moved:
        bb.append_event(project_id, "challenge.flags.backfill",
                        {"moved": moved, "skipped": skipped})
    return {"moved": moved, "skipped": skipped}


# ---------- 汇总（API / 前端 / 覆盖度共用） ----------


def challenge_flag_summary(bb, project_id: str, challenge_ids: list[str],
                           running_by_challenge: dict[str, int] | None = None
                           ) -> dict[str, dict]:
    """批量派生多道题的状态（一次查表，避免 N+1）。

    返回 ``{challenge_id: {state, solved, accepted, rejected, quota,
    abandoned, running, flags: [...]}}``。``flags`` 是**全部**（含 rejected），
    前端人工裁决界面需要看到被否决的那条才能撤销。
    """
    out: dict[str, dict] = {}
    ids = [str(c) for c in (challenge_ids or []) if str(c)]
    if not ids:
        return out
    marks = ",".join("?" for _ in ids)
    rows = [_row_to_dict(r) or {} for r in bb.conn.execute(
        f"SELECT * FROM challenge_flags WHERE project_id=? AND challenge_id IN ({marks})"
        " ORDER BY created_at ASC, id ASC", (project_id, *ids)).fetchall()]
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("challenge_id") or ""), []).append(row)
    running_by_challenge = running_by_challenge or {}
    for cid in ids:
        flags = grouped.get(cid, [])
        counted = [f for f in flags
                   if str(f.get("verdict") or "") in _COUNTED_VERDICTS]
        candidates = [f for f in flags
                      if str(f.get("verdict") or "") in CANDIDATE_VERDICTS]
        rejected = [f for f in flags if str(f.get("verdict") or "") == "rejected"]
        quota = challenge_flag_quota(bb, project_id, cid)
        meta = _meta_of(bb.get_asset(cid))
        abandoned = bool(meta.get("abandoned"))
        concluded = bool(meta.get("concluded"))
        running = max(0, int(running_by_challenge.get(cid) or 0))
        # **必须与 `challenge_state` 逐字同口径**（两条派生路径分叉过一次，
        # 见 CLAUDE.md）。解出只看已确认条数；超额不压（配额下调是用户意图）。
        over_quota = len(counted) > quota
        solved = len(counted) >= quota
        if solved:
            state = STATE_SOLVED
        elif counted:
            state = STATE_PARTIAL
        elif abandoned:
            state = STATE_ABANDONED
        elif running > 0 and not concluded:
            state = STATE_RUNNING
        elif candidates:
            # 与 `challenge_state` 逐字同口径：只有候选也算 partial（不是
            # untouched——题目跑过、拿到东西了，只是没人确认）。
            state = STATE_PARTIAL
        elif concluded:
            state = STATE_PARTIAL
        else:
            state = STATE_UNTOUCHED
        out[cid] = {"state": state, "solved": solved, "accepted": len(counted),
                    "candidate": len(candidates),
                    "rejected": len(rejected), "quota": quota,
                    "abandoned": abandoned, "concluded": concluded,
                    "running": running,
                    "over_quota": over_quota,
                    "flags": flags}
    return out


# ---------- 覆盖度（CTF 轨专用，替代资产覆盖度） ----------


def challenge_coverage(bb, project_id: str, challenge_ids: list[str],
                       running_by_challenge: dict[str, int] | None = None) -> dict:
    """CTF 轨覆盖度：**分母 = 题目数**，**分子 = 已解题目数**。

    渗透轨的 `artex_coverage.task_coverage` 在 CTF 轨算出来是无意义的数字
    （「已测资产 0/3，覆盖度 0%」——题目不是待测资产，flag 也不是 fact）。
    本函数是 CTF 轨的对应物，口径对齐上游 `Coverage` 的形状（enabled /
    denominator / tested / untested / pct / by_type），只是分桶维度换成题目状态。
    """
    summary = challenge_flag_summary(bb, project_id, challenge_ids,
                                     running_by_challenge)
    by_state: dict[str, int] = {}
    for cid in challenge_ids:
        state = str((summary.get(cid) or {}).get("state") or STATE_UNTOUCHED)
        by_state[state] = by_state.get(state, 0) + 1
    denominator = len([c for c in challenge_ids if str(c)])
    tested = by_state.get(STATE_SOLVED, 0)
    pct = (tested / denominator) if denominator else None
    return {
        "enabled": True,
        "scope_rows": denominator,
        "scope_source": "challenges",
        "denominator": denominator,
        "tested": tested,
        "untested": denominator - tested,
        "pct": pct,
        "by_type": [{"type": s, "total": by_state.get(s, 0),
                     "tested": by_state.get(s, 0) if s == STATE_SOLVED else 0}
                    for s in CHALLENGE_STATES if by_state.get(s, 0)],
        "by_state": by_state,
    }
