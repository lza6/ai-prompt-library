"""跨供应商兜底（provider-failover，2026-10-21）。

**动因**：传输层（`openai_compat` / `anthropic_compat`）对同一家供应商有 3 次
尝试的预算（首次 + 2 次重试，2026-10-30 用户定稿，原 11 次），解决「抖动」。
真正不能用的场合——额度耗尽、key 失效、渠道风控超过恢复窗口、模型在全账号池
冷却——重试同一家只是把用户钉在等待里。用户定稿的行为是：

    某模型重试 3 次仍失败 → 按 providers.json 顺序换下一个供应商的默认模型
    → 一圈全失败也没关系：**从第一家开始再轮一圈**，直到成功 / 点了停止 /
    总时长预算耗尽（2026-11-02 Nan 改定：循环轮询，不再「最后一家失败就停」）

**分层**：本模块只做「换一家再试一次」和「一圈失败后等一会再来一轮」，
**不重试**——每家自己的 3 次预算仍由传输层负责。轮间退避 30s 起、每轮翻倍，
封顶 120s（共用 `retry.sleep_cancellable`，点停止可立刻中断）。

**循环只对暂态错误进行**（`retry.should_failover` 为假则原样上抛）：参数错、
上下文超限、半截流、工具参数截断、人类中止都不该在供应商之间绕圈。另外
**只有一个可用供应商时不循环**——同一家再绕一圈等价于把传输层预算拉长，
没有收益，还会把失败反馈拖到总预算耗尽。

**必须守住的语义**（否则比不兜底更糟）：

1. **粘住，不回头**：成功那家成为新起点（`_idx` 前移）。失败轮询时仍从当前
   起点开始转圈，不会每轮先烧掉已挂供应商的 3 次预算又从头来。
2. **不换的几种错**：`partial`（已吐增量，换家重发会让半截答复重复上屏，上层
   走「接着续写」）、`truncated`（上层整轮重发 + 末轮降级非流式）、`context`
   （上层强制压缩后重试）、`bad_request`（换家同样 400）。
   **例外（2026-10-31）**：连续「流式无帧挂起」到 2 次（`_idle_streak >=
   _IDLE_STREAK_FAILOVER`）把该供应商判为坏窗口，降级 `partial=False` 强制换
   下一家——单次挂起保护偶发，连续挂起若仍不换，前端会「每 2 分钟动一次、
   永远不更新」，比换家糟（见 chat() 内注释与 `_is_stream_idle_error`）。
3. **图不能发给看不见的供应商**：请求里带 image 块时，跳过 `vision` 未声明的
   兜底项——往不支持看图的网关塞图片块会被 400 打死，等于把「换家」变成「必挂」。

**诊断**：每次失败 / 切换 / 全链耗尽都交给 `core/diagnostics/llm_failover.py`
落一条记录（JSONL + 项目黑板事件 `llm.provider_failed` / `llm.failover` /
`llm.failover.exhausted`），category 与 `retry.classify_provider_error` 同源。
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Callable
from typing import Any

from core.llm.provider import LLMError
from core.llm.retry import (classify_provider_error, should_failover,
                            sleep_cancellable)

# 连续多少次「流式无帧超时」就把该供应商判为坏窗口、强制换家（2026-10-31）。
# 取 2：第 1 次挂起照旧按 partial 原样重发（保住「偶发抖动不丢半截增量」的
# 既有语义），第 2 次还挂说明不是抖动而是这一家的持续坏窗口——这时候继续
# 重发只会让前端每 2 分钟才动一次。最坏静默约 2×120s。
_IDLE_STREAK_FAILOVER = 2

# 全链循环轮询的总时长预算（2026-11-02 Nan 定稿）。一圈全失败 → 等一会再来
# 一圈，直到成功 / 取消 / 预算耗尽；默认 30 分钟（覆盖分钟级网关坏窗口）。
# 环境变量 CYBERSTRIKE_LLM_FAILOVER_BUDGET_S 可覆盖，0 = 只走一圈（旧行为）。
FAILOVER_TOTAL_BUDGET_S = float(
    os.environ.get("CYBERSTRIKE_LLM_FAILOVER_BUDGET_S", "1800") or 0)
# 一圈全失败后的轮间退避：30s 起、每轮翻倍，封顶 120s（避免持续打网关）。
FAILOVER_ROUND_BACKOFF_S = 30.0
FAILOVER_ROUND_BACKOFF_MAX_S = 120.0



def _is_stream_idle_error(e: BaseException) -> bool:
    """是不是看门狗抛的「流式无帧超时」（区别于上游自己断流）。"""
    return "流式响应无数据" in str(e)


log = logging.getLogger(__name__)

# 兜底链构建器：() -> [(provider_name, provider 实例), ...]（顺序即 providers.json 顺序）
AlternatesFactory = Callable[[], list[tuple[str, Any]]]


def _label_of(prov: Any, fallback: str = "") -> str:
    """供应商名（provider 实例没存名字，只能从 base_url 猜一个可读标签）。"""
    name = getattr(prov, "provider_name", None)
    if name:
        return str(name)
    url = str(getattr(prov, "base_url", "") or "")
    return fallback or (url or "primary")


def _has_images(messages: list[dict[str, Any]]) -> bool:
    """请求里是否带图片块（vision 通道）。只看 content 数组，纯文本消息零成本跳过。"""
    for m in messages or []:
        content = m.get("content") if isinstance(m, dict) else None
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "image":
                return True
    return False


class FallbackProvider:
    """主供应商 + 按序兜底链（鸭子类型实现 `LLMProvider`，其余属性透传当前供应商）。

    只由 `ProviderStore.build()` 构造；探活/自检路径用 `build(..., fallback=False)`。
    """

    def __init__(self, primary: Any, *, label: str = "",
                 alternates: AlternatesFactory | None = None,
                 timeout: float | None = None) -> None:
        self._primary = primary
        self._current = primary
        self._label = label or _label_of(primary)
        self._alternates = alternates
        self._timeout = timeout
        # 惰性构建：正常跑（不失败）时一次都不建兜底实例，零开销
        self._entries: list[tuple[str, Any]] | None = None
        self._idx = 0
        # 连续「流式挂起」计数（2026-10-31 静默期循环修复）。见 chat() 里的说明：
        # 同一家在 idle 掐断后原样重发，若还是挂（上游坏窗口），partial 的「不换
        # 家」规则会把会话钉死在这一家，表现为「每 2 分钟掐一次、永远不更新」。
        # 计数按「一次成功的 chat 调用」清零，只累计**同一实例内连续**的 idle 挂起。
        self._idle_streak = 0

    # ---------- 属性透传 ----------

    @property
    def model(self) -> str | None:
        """**当前**供应商的模型（兜底后随之变化，usage 记账才是真的）。"""
        return getattr(self._current, "model", None)

    @property
    def provider_name(self) -> str:
        return self._entries[self._idx][0] if self._entries else self._label

    def __getattr__(self, name: str) -> Any:
        # 下划线开头（_current/_entries/…）一律不转发：既防 __init__ 期间递归，
        # 也避免把包装器内部状态漏给调用方。
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._current, name)

    # ---------- 兜底链 ----------

    def chain(self) -> list[tuple[str, Any]]:
        """完整兜底链（含主供应商，已按序实例化；构建失败的项跳过）。"""
        if self._entries is None:
            entries: list[tuple[str, Any]] = [(self._label, self._primary)]
            if self._alternates is not None:
                try:
                    entries.extend(self._alternates())
                except Exception:  # noqa: BLE001 —— 兜底链构建失败不该拖垮主调用
                    log.exception("兜底供应商链构建失败（只用主供应商）")
            self._entries = entries
        return self._entries

    def chain_labels(self) -> list[str]:
        return [n for n, _ in self.chain()]

    # ---------- 调用 ----------

    def chat(self, messages: list[dict[str, Any]], *, system: Any = None,
             tools: list[dict[str, Any]] | None = None,
             max_tokens: int = 16384, temperature: float | None = None,
             model: str | None = None, on_thinking: Any = None,
             on_text: Any = None, should_cancel: Any = None,
             on_retry: Any = None, on_failover: Any = None):
        """同 `LLMProvider.chat`；额外 ``on_failover(info)`` 在换家前回调。

        ``on_failover`` 的用途是**清掉上游增量缓冲**（思考/回复 delta）：前端按
        「最新 seq 的累计全文」覆盖显示，缓冲从零重流即自愈；不清则会拼出
        「失败那家的半截 + 新家的全文」。
        """
        entries = self.chain()
        needs_vision = _has_images(messages)
        if not entries:
            raise LLMError("没有可用的供应商（兜底链为空）")
        # 可用集合：主供应商（当前粘住那家）总是先试——与旧行为一致；只有**兜底
        # 项**才按 vision 过滤（往不支持看图的网关塞图片块会被 400 打死，见
        # docstring 第 3 条）。
        start = self._idx if 0 <= self._idx < len(entries) else 0
        idx_order = list(range(start + 1, len(entries))) + list(range(0, start))
        if needs_vision:
            idx_order = [i for i in idx_order
                         if bool(getattr(entries[i][1], "supports_vision", False))]
        usable = [start] + idx_order

        # 循环条件（2026-11-02 Nan 定稿）：暂态错误 + ≥2 家可用 + 预算 > 0。
        # 只有一家可用时再绕一圈等于把传输层预算无限拉长——没有收益，
        # 还会让失败反馈拖到预算耗尽，故保持旧行为（一圈即抛）。
        cycling = len(usable) >= 2 and FAILOVER_TOTAL_BUDGET_S > 0
        first_started = time.monotonic()
        deadline = first_started + (FAILOVER_TOTAL_BUDGET_S if cycling else 0.0)

        last_err: BaseException | None = None
        prev_label = ""
        last_idx = self._idx
        round_no = 1
        while True:
            for pos, idx in enumerate(usable):
                label, prov = entries[idx]
                if should_cancel is not None and should_cancel():
                    # 每次尝试前判中止：用户在等退避/重试时点了停止
                    raise LLMError("已中断")
                if pos > 0 or round_no > 1:
                    # 真要换到这一家 → 先让调用方清掉上游增量缓冲
                    if on_failover is not None:
                        try:
                            on_failover({
                                "from": prev_label or self._label, "to": label,
                                "category": classify_provider_error(last_err)
                                if last_err is not None else "",
                                "error": str(last_err)[:300] if last_err else "",
                                "round": round_no})
                        except Exception:  # noqa: BLE001 —— 回调炸了不能拖垮主流程
                            log.exception("on_failover 回调失败")
                started = time.monotonic()
                try:
                    resp = self._call(prov, messages, system=system, tools=tools,
                                      max_tokens=max_tokens, temperature=temperature,
                                      model=model, on_thinking=on_thinking,
                                      on_text=on_text, should_cancel=should_cancel,
                                      on_retry=on_retry)
                except (LLMError, OSError) as e:
                    elapsed = int((time.monotonic() - started) * 1000)
                    last_err = e
                    prev_label = label
                    last_idx = idx
                    # 连续 idle 挂起升级（2026-10-31）：看门狗掐断后抛的是
                    # `partial=True`（已吐过增量），而 partial 属于「不换家」——
                    # 理由是换家重发会让半截答复重复上屏。但那只适用于**偶发**挂起：
                    # 实测「天天」网关处于坏窗口时，同一步每 120s 被掐一次、原样重发
                    # 又挂，循环下去前端看到的是「3 分钟没更新甚至更久」，比换家糟得多。
                    # 所以：连续挂到第 IDLE_STREAK_FAILOVER 次就把它当成「这家不能用了」，
                    # 临时降级 partial 标记 → 走正常兜底链换下一家（宁可作废半截增量）。
                    is_idle = _is_stream_idle_error(e)
                    if is_idle:
                        self._idle_streak += 1
                    if is_idle and self._idle_streak >= _IDLE_STREAK_FAILOVER:
                        prev = self._idle_streak
                        self._idle_streak = 0  # 换家后重新计数，避免影响下一家
                        log.warning("连续 %d 次流式挂起，判定 %s 处于坏窗口，强制换家",
                                    prev, label)
                        # 把 partial 降级掉 → should_failover 返回 True，走兜底链。
                        # 原文案保留，诊断里能一眼看出是「挂起累积触发」而非上游报错。
                        e = LLMError(
                            f"{e}（连续 {prev} 次挂起，判定该供应商不可用）",
                            partial=False)
                        last_err = e
                    # 本圈内的下一家（到链尾就绕回第一家，但真正「再绕一圈」
                    # 只在本圈全失败后再决定，见下方轮间退避）
                    nxt_idx = usable[pos + 1] if pos + 1 < len(usable) else usable[0]
                    nxt = entries[nxt_idx][0]
                    if not should_failover(e):
                        # 非暂态（参数/上下文/半截流/中止）：立刻交还上层自愈链
                        self._record_failure(label, prov, e, idx, entries, elapsed,
                                             next_label=None)
                        raise
                    self._record_failure(label, prov, e, idx, entries, elapsed,
                                         next_label=nxt)
                    log.warning("供应商 %s 调用失败（%s），切换到 %s 重试（第 %d 轮）",
                                label, classify_provider_error(e), nxt, round_no)
                    continue
                # 成功：粘住这一家（后续调用从它开始，不再回头烧前一家的预算）
                self._idx = idx
                self._current = prov
                self._idle_streak = 0   # 成功即清零，只累计「连续」挂起
                if idx != start or round_no > 1:
                    log.info("供应商兜底生效：%s → %s（%s，第 %d 轮）",
                             prev_label or self._label, label,
                             getattr(prov, "model", ""), round_no)
                return resp
            # 一圈全部失败：暂态错误才继续轮询，否则上面已 raise
            remaining = deadline - time.monotonic()
            if not cycling or remaining <= 0:
                self._record_exhausted(prev_label or self._label,
                                       last_err or LLMError("没有可用的供应商"),
                                       last_idx, entries)
                if last_err is not None:
                    if round_no > 1:
                        # 轮询过的场合把「试了几家几轮」写进文案：否则用户只看到
                        # 「已重试 2/2 次」，会误以为是单家 3 次就放弃（2026-11-02）。
                        raise LLMError(
                            f"{last_err}（已轮询 {len(usable)} 家供应商 "
                            f"{round_no} 轮、约 {int(time.monotonic() - first_started)}s；"
                            "可稍后重发，或在供应商设置里停用额度耗尽的那家）",
                            status=int(getattr(last_err, "status", 0) or 0),
                            body=str(getattr(last_err, "body", "") or ""),
                            truncated=bool(getattr(last_err, "truncated", False)),
                            partial=bool(getattr(last_err, "partial", False)))
                    raise last_err
                raise LLMError("没有可用的供应商（兜底链为空）")
            wait_s = min(FAILOVER_ROUND_BACKOFF_S * (2 ** (round_no - 1)),
                         FAILOVER_ROUND_BACKOFF_MAX_S, remaining)
            log.warning("本圈供应商全部失败，%.0fs 后开始第 %d 轮轮询（总预算剩余 %.0fs）",
                        wait_s, round_no + 1, remaining)
            sleep_cancellable(wait_s, should_cancel)
            round_no += 1


    @staticmethod
    def _call(prov: Any, messages: list[dict[str, Any]], **kw: Any):
        """把非 None 的可选参数交给 provider（保持与直接调用逐字等价）。"""
        kwargs = {k: v for k, v in kw.items() if v is not None}
        return prov.chat(messages, **kwargs)

    # ---------- 诊断 ----------

    def _record_failure(self, label: str, prov: Any, err: BaseException,
                        idx: int, entries: list[tuple[str, Any]],
                        elapsed_ms: int, *, next_label: str | None) -> None:
        try:
            from core.diagnostics import llm_failover as failover_log
            failover_log.record_attempt(
                provider=label,
                model=str(getattr(prov, "model", "") or ""),
                category=classify_provider_error(err),
                status=int(getattr(err, "status", 0) or 0),
                error=str(err),
                elapsed_ms=elapsed_ms,
                index=idx + 1,
                chain=self.chain_labels() if entries else [],
                next_provider=next_label,
                next_model=(str(getattr(entries[idx + 1][1], "model", "") or "")
                            if next_label and idx + 1 < len(entries) else ""),
            )
        except Exception:  # noqa: BLE001 —— 诊断绝不能影响调用
            log.exception("兜底失败记录写入异常 provider=%s", label)

    def _record_exhausted(self, label: str, err: BaseException, idx: int,
                          entries: list[tuple[str, Any]]) -> None:
        try:
            from core.diagnostics import llm_failover as failover_log
            failover_log.record_exhausted(
                chain=self.chain_labels() if entries else [label],
                last_provider=label,
                last_model=str(getattr(entries[idx][1], "model", "") or ""),
                category=classify_provider_error(err),
                status=int(getattr(err, "status", 0) or 0),
                error=str(err),
            )
        except Exception:  # noqa: BLE001
            log.exception("兜底耗尽记录写入异常")


def with_fallback(primary: Any, store: Any, *, label: str = "",
                  timeout: float | None = None,
                  thinking_effort: str | None = None) -> Any:
    """给已构建的主供应商挂上兜底链；没有其它启用供应商时**原样返回**（零开销）。

    ``thinking_effort``：线程级思考强度覆盖，**要一并传给兜底实例**。否则主供应商
    挂了切到兜底那家时，强度会悄悄回落到那家的配置值——用户明明拖到 max，切家之后
    变成该供应商的缺省档，且没有任何提示（切家已经够混乱了，不该再叠一层静默变化）。
    """
    try:
        targets = store.alternate_targets(exclude=label)
    except Exception:  # noqa: BLE001 —— 读配置失败就退化成单供应商
        log.exception("兜底候选读取失败（退化为单供应商）")
        return primary
    if not targets:
        return primary

    def _factory() -> list[tuple[str, Any]]:
        out: list[tuple[str, Any]] = []
        for pname, pmodel in targets:
            try:
                out.append((pname, store.build(pname, pmodel, timeout=timeout,
                                               fallback=False,
                                               thinking_effort=thinking_effort)))
            except Exception as e:  # noqa: BLE001 —— 缺 key/停用等：跳过这一家
                log.warning("兜底供应商 %s 不可构建（跳过）：%s", pname, e)
        return out

    return FallbackProvider(primary, label=label, alternates=_factory,
                            timeout=timeout)
