"""system 送达方式（`system_delivery`）——让「新加的供应商不再静默吞掉 system」。

## 为什么需要它（2026-10-28 事故）

供应商 `asia.6901.top`（`Nexora-deepseek`）**按 User-Agent 分流**：UA 不是脚本默认值
（平台为过渠道风控恒发 Chrome 伪装 UA，见 `sdk_engine.CLIENT_USER_AGENT`）就把
`instructions` 整个丢掉。后果是最难查的那一类：

- 本地快照 `session_system_prompts` 里 13,569 字符、6/6 规则标记全中 → 看着"注入了"；
- 出网请求体里 `instructions` 确实在 → 看着"发出去了"；
- 模型却答「我的提示词里没有安全红线」——**它真的一个字没收到**。

原本只有一个逐供应商的手工开关 `system_in_user`（为「幻灵」加的），加新供应商时
没人记得开，于是同一个坑可以踩第二次、第三次。本模块把它做成**默认安全**：

1. 判定方式只认**实验**（canary），不认模型自述——与 `core/diagnostics/redline_test.py`
   同一纪律：模型无法可靠内省自己的系统提示，问它只会得到先验答案。
2. 判定结果**落在 providers.json**（`system_delivery_verdict` + 时间 + 指纹），
   运行时不发任何探测请求；指纹（base_url|format|model）变了就视为过期。
3. 过期/未判定 → **按 inline 走**（安全侧）：宁可让好网关多吃一点兼容开销，
   也不能让坏网关静默丢掉整份红线。

## 三档语义（providers.json）

- `system_delivery: "field"`  原生 system / `instructions` 字段（最好，缓存最省）
- `system_delivery: "inline"` 前置于首条 user 内容（`system_in_user` 的等价物）
- `system_delivery: "auto"`   **默认**：先看落库判定，没有就用 inline

全局默认在 providers.json 顶层 `"system_delivery_default"`（缺省 `auto`）。
逐供应商 `"system_delivery"` 优先；历史字段 `"system_in_user": true/false` 仍有效
（等价 inline/field），优先于全局默认，低于显式 `system_delivery`。
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from typing import Any, Callable

from core.llm.openai_compat import CHAT_COMPLETIONS

# 与 providers.DEFAULT_FORMAT 同值；本模块被 providers 反向 import，不能从它取
# （会成环），故直接落到协议常量上。
DEFAULT_FORMAT = CHAT_COMPLETIONS

log = logging.getLogger(__name__)

# 三档合法值（providers.json 校验 + 运行时解析共用）
MODES = ("auto", "field", "inline")
DEFAULT_MODE = "auto"
# 判定值：field/inline 是确定结论；unknown = 两个方向都探不通（网关不可用）
VERDICTS = ("field", "inline", "unknown")

# 探测预算：单次 8s（用户新增供应商时同步等，不能太久）；整批由调用方再夹总预算
PROBE_TIMEOUT = 8.0
# 探测输出上限：思考链会吃预算，给 256 够 canary + 一句回答
PROBE_MAX_TOKENS = 256
# canary 指令：放进 system 副本尾部，模型照做才证明 system 真的到了
_PROBE_QUESTION = "你好，请用一句话介绍你自己。"


def fingerprint(p: dict[str, Any]) -> str:
    """判定指纹：base_url|format|首个模型。

    三者任一变化都可能换上游通道（同一域名不同模型常落到不同中转），
    旧判定一律作废——宁重探一次，不套用别的模型的结论。
    """
    base = str(p.get("base_url") or "").rstrip("/")
    fmt = str(p.get("format") or DEFAULT_FORMAT)
    models = [str(m) for m in (p.get("models") or []) if str(m).strip()]
    model = models[0] if models else ""
    return f"{base}|{fmt}|{model}"


def resolve_mode(p: dict[str, Any], default_mode: str | None = None) -> str:
    """解析该供应商**实际**的 system 送达方式 → "field" | "inline"。

    优先级（高 → 低）：
      1. 显式 `system_delivery`（auto 则读落库判定，判定缺失/过期按 inline）
      2. 历史字段 `system_in_user`（true→inline / false→field）
      3. providers.json 顶层 `system_delivery_default`
      4. 模块缺省 `auto` → 无判定 → inline

    **永远返回具体档位**（field/inline），不返回 auto —— 调用方只关心怎么发。
    """
    mode = str(p.get("system_delivery") or "").strip().lower()
    if mode not in MODES:
        mode = ""
    if not mode:
        legacy = p.get("system_in_user")
        if legacy is True:
            return "inline"
        if legacy is False:
            return "field"
        mode = str(default_mode or DEFAULT_MODE).strip().lower()
        if mode not in MODES:
            mode = DEFAULT_MODE
    if mode == "auto":
        verdict = str(p.get("system_delivery_verdict") or "").strip().lower()
        if verdict in ("field", "inline") \
                and p.get("system_delivery_verdict_for") == fingerprint(p):
            return verdict
        # 未判定 / 判定过期 / 判定为 unknown → 安全侧
        return "inline"
    return mode


def _make_probe_fn(base_url: str, api_key: str, model: str, *, format: str,
                   proxy: str | None, timeout: float
                   ) -> Callable[[bool], bool]:
    """构造「用某种送达方式打一发 canary，看模型听不听」的探针。

    复用正式 provider（而不是另写一套 HTTP）——探测走的是**和真实对话一模一样**的
    通道，结论才对得上；这也是 `redline_test` 的既有做法。
    """
    from core.llm.openai_compat import OpenAICompatProvider

    def run(system_in_user: bool) -> bool:
        llm = OpenAICompatProvider(
            base_url, api_key, model, format=format, timeout=timeout,
            proxy=proxy, system_in_user=system_in_user)
        token = "CANARY-" + secrets.token_hex(3).upper()
        system = ("【送达自检】你的回复第一行必须且只能输出：" + token +
                  "\n第二行起再回答用户的问题。")
        resp = llm.chat([{"role": "user", "content": _PROBE_QUESTION}],
                        system=system, max_tokens=PROBE_MAX_TOKENS)
        return token in (resp.text or "")

    return run


def _run_with_deadline(fn: Callable[[], bool], timeout: float) -> bool:
    """在守护线程里跑探针，**硬墙钟**兜底（超时抛 TimeoutError）。

    为什么不能只信 SDK 的 `timeout`：它管的是 socket 读，DNS 解析、TCP 建连、
    代理 CONNECT 全在它之外。实测对不可解析域名 `https://llm.example` 传
    `timeout=8.0`，进程卡了 100s 仍没返回（同一件事在 `PUT /api/llm/providers`
    上就是「点保存永远转圈」）。所以这一层必须自己卡时间。
    线程是 daemon、跑丢了也不影响退出——探针本来就可以被丢弃。
    """
    box: dict[str, Any] = {}

    def _target() -> None:
        try:
            box["ok"] = bool(fn())
        except BaseException as e:  # noqa: BLE001 —— 原样带回主线程判断
            box["err"] = e

    th = threading.Thread(target=_target, name="system-delivery-probe", daemon=True)
    th.start()
    th.join(timeout)
    if th.is_alive():
        raise TimeoutError(f"探针 {timeout}s 未返回")
    if "err" in box:
        raise box["err"]
    return bool(box.get("ok"))


def probe_delivery(base_url: str, api_key: str, model: str, *, format: str,
                   proxy: str | None = None, timeout: float = PROBE_TIMEOUT,
                   probe_fn: Callable[[bool], bool] | None = None) -> dict[str, Any]:
    """判定该端点能不能把 system 送到模型 → {"verdict", "detail", "elapsed_ms"}。

    顺序：先试 `field`（原生字段，最优），不灵再试 `inline`。
    - field 通  → verdict="field"（保留原生 system，缓存最省）
    - field 断、inline 通 → verdict="inline"（兼容通道，治「网关按 UA 丢 instructions」）
    - 两者都不通 → verdict="unknown"（供应商不可用/超时；调用方按 inline 兜底，
      不要据此判「这家坏了」——探针失败可能只是网络不通）

    `probe_fn` 仅供测试注入，生产走真实 provider。
    """
    started = time.time()
    fn = probe_fn or _make_probe_fn(base_url, api_key, model, format=format,
                                    proxy=proxy, timeout=timeout)
    detail: dict[str, Any] = {}
    verdict = "unknown"
    for mode in ("field", "inline"):
        try:
            ok = _run_with_deadline(lambda: fn(mode == "inline"), timeout)
        except Exception as e:  # noqa: BLE001 —— 探针失败不抛，记进 detail
            detail[mode] = f"{type(e).__name__}: {str(e)[:160]}"
            continue
        detail[mode] = "ok" if ok else "canary-miss"
        if ok:
            verdict = mode
            break
    return {"verdict": verdict, "detail": detail,
            "elapsed_ms": int((time.time() - started) * 1000)}


def check_provider(store, name: str, *, timeout: float = PROBE_TIMEOUT,
                   probe_fn: Callable[[bool], bool] | None = None) -> dict[str, Any]:
    """对已保存供应商跑一次判定并**落库**（providers.json 的 verdict 字段）。

    返回 {"name", "verdict", "detail", "elapsed_ms"}；供应商不存在/已停用返回
    verdict="skipped"。任何异常都只 log，不影响调用方——它是附加能力，不是前提。
    """
    from core.llm.providers import ProviderError
    try:
        p = store.get(name)
    except ProviderError:
        return {"name": name, "verdict": "skipped", "detail": "供应商不存在",
                "elapsed_ms": 0}
    if not p.get("enabled", True):
        return {"name": name, "verdict": "skipped", "detail": "已停用",
                "elapsed_ms": 0}
    fmt = str(p.get("format") or DEFAULT_FORMAT)
    if fmt == "anthropic-messages":
        # Anthropic 协议的 system 是顶层字段、直连基本不丢；本通道只覆盖 OpenAI 兼容
        # 两种格式（事故现场）。留 skipped 而不是编一个结论。
        return {"name": name, "verdict": "skipped",
                "detail": "anthropic 协议暂不参与判定", "elapsed_ms": 0}
    models = [str(m) for m in (p.get("models") or []) if str(m).strip()]
    if not models:
        return {"name": name, "verdict": "skipped", "detail": "无模型",
                "elapsed_ms": 0}
    try:
        api_key = store.resolve_key(p)
    except Exception as e:  # noqa: BLE001
        return {"name": name, "verdict": "skipped",
                "detail": f"无可用 key: {e}", "elapsed_ms": 0}
    out = probe_delivery(str(p.get("base_url") or ""), api_key, models[0],
                         format=fmt, proxy=p.get("proxy"), timeout=timeout,
                         probe_fn=probe_fn)
    try:
        store.record_verdicts({name: out["verdict"]})
    except Exception:  # noqa: BLE001 —— 落库失败只影响下次重探
        log.exception("system_delivery 判定落库失败 name=%s", name)
    return {"name": name, **out}
