"""fir-proxy 代理池 MCP server（stdio，平台控制面）。

**薄客户端**：不自己管池、不起 serve——只把平台 API（默认 127.0.0.1:8420）的
代理池端点暴露成 MCP 工具，让 AI 能查端点/IP 列表、起停服务、轮换、抓取验证。

设计依据 `docs/plans/proxy-pool-integration.md`：
- **平台托管 + MCP 控制面**：serve 生命周期归平台（`core/proxy/pool.py`），
  人类 UI 与 AI 共享同一池；MCP 子进程随会话起停，不该持有长驻状态。
- **甲（AI 用轮换代理）**：`proxy_status` 给 http/socks5 端点、`proxy_list` 给可用 IP，
  AI 自行在 `run_cmd` 里 `curl -x socks5://127.0.0.1:<port> ...`；平台不注入。

环境变量：
- ``CYBERSTRIKE_API`` 平台基址（默认 ``http://127.0.0.1:8420``）。

代理池已**全局化（2026-10-11）**：工具打 ``/api/proxy/*``（无 pid），不再需要 project_id。

**全部工具必须 `async def` + `asyncio.to_thread`（2026-10-26 事故修复）**
----------------------------------------------------------------------
FastMCP 的 `func_metadata.py` 对工具函数只有两条分支：
``if fn_is_async: await fn(...)`` / ``else: return fn(...)``——**同步工具直接在当前
事件循环里跑**（不丢线程池）。于是任何一个工具里的阻塞调用（HTTP 请求、
`_poll_job` 的 ``time.sleep`` 轮询）都会把**整个 server** 卡住：同一 server 的
其它工具全部排队无响应，桥侧 60s 超时后统一翻成「server 离线或协议错误」。
`proxy_check_url` 内部等 Job 终态最长 ``900s``，一次调用就足以打死整个 server
（实测 2026-10-26：一个会话内 fir-proxy 全部 12 个工具连续 60s 超时，
`proxy_status`/`proxy_list`/`proxy_start`/`proxy_stop` 无一幸免）。

**故：任何工具都不得在事件循环里做阻塞 IO。** 一律 ``async def`` + 把阻塞体丢进
``asyncio.to_thread``。新增工具照此办理；改动后务必确认函数是 ``async def``。
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

API_BASE = os.getenv("CYBERSTRIKE_API", "http://127.0.0.1:8420").rstrip("/")
TIMEOUT = float(os.getenv("FIR_PROXY_MCP_TIMEOUT", "120"))

#: `proxy_check_url` 等「提交 Job 再等终态」的工具的轮询上限（秒）。
#: 必须与平台侧 MCP 桥的调用预算对齐，见 `core/chat/mcp_bridge.py` 的
#: `MCP_TOOL_CALL_TIMEOUT`——桥先超时就会翻成「server 离线或协议错误」。
POLL_CAP_S = float(os.getenv("FIR_PROXY_POLL_CAP_S", "900"))

mcp = FastMCP("fir-proxy")


def _call(method: str, path: str, body: dict | None = None) -> Any:
    """打平台 API；非 2xx 抛出带 detail 的 RuntimeError（供 MCP 回结构化错误）。

    **阻塞**——只可在工作线程里调用（见 `_a_call` / `asyncio.to_thread`）。
    """
    url = f"{API_BASE}{path}"
    try:
        resp = httpx.request(method, url, json=body, timeout=TIMEOUT)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"平台 API 不可达（{API_BASE}）: {exc}") from exc
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail")
        except ValueError:
            detail = resp.text[:300]
        raise RuntimeError(f"HTTP {resp.status_code}: {detail}")
    return resp.json()


def _poll_job(job_id: str, interval: float = 1.5,
              cap_s: float | None = None) -> dict:
    """轮询平台 Job 至终态，返回其 ``result``（失败抛 RuntimeError 带 error）。

    代理检测是 202 Job（联网慢），工具同步等它完成再回结果供 AI 直接使用。

    **阻塞**——只可在工作线程里调用。
    """
    cap = POLL_CAP_S if cap_s is None else cap_s
    deadline = time.monotonic() + cap
    while True:
        job = _call("GET", f"/api/jobs/{job_id}")
        status = job.get("status")
        if status != "running":
            if status == "error":
                raise RuntimeError(f"任务失败: {job.get('error') or '未知错误'}")
            return job.get("result") or {}
        if time.monotonic() >= deadline:
            raise RuntimeError(f"等待任务超时（{cap:.0f}s）: {job_id}")
        time.sleep(interval)


async def _a_call(method: str, path: str, body: dict | None = None) -> Any:
    """`_call` 的异步版：阻塞 HTTP 丢工作线程，**绝不占事件循环**。"""
    return await asyncio.to_thread(_call, method, path, body)


@mcp.tool()
async def proxy_status() -> dict:
    """查代理池状态：服务是否在跑、本地入口端点（http/socks5）、当前代理、池计数与地区分布。

    服务未启动时 `running=false`（池文件仍在，可 `proxy_list` 看存量）。

    计数口径：`working` = `status=='Working'`（**只保证 HTTP 可达**）；
    `working_https` = 其中 `https_ok==true` 的条数（能做 CONNECT 隧道）。
    **HTTPS 目标请优先挑 `working_https` 里的**——`https_ok=false` 的出口做不了
    CONNECT，`curl -x <入口> https://…` 必 TLS 失败。
    """
    return await _a_call("GET", "/api/proxy/status")


@mcp.tool()
async def proxy_list() -> dict:
    """列可用代理（proxy/protocol/location/latency/score/status/https_ok）。

    `source=serve` 为运行中实时池；`source=file` 为池文件存量。AI 据此挑代理。
    `https_ok=false` 的代理**做不了 HTTPS**（不能 CONNECT），只能访问明文 http 目标。
    """
    return await _a_call("GET", "/api/proxy/proxies")


@mcp.tool()
async def proxy_start() -> dict:
    """启动代理池本地服务（HTTP + SOCKS5 入口，内建轮换/故障切换）。池空或依赖缺失会报错。"""
    return await _a_call("POST", "/api/proxy/start")


@mcp.tool()
async def proxy_stop() -> dict:
    """停止代理池本地服务（池记录保留）。"""
    return await _a_call("POST", "/api/proxy/stop")


@mcp.tool()
async def proxy_rotate() -> dict:
    """手动轮换到下一个代理，返回新的当前代理。需服务在跑。

    轮换优先挑 `https_ok==true` 的代理（池里有的话）；池内全无 https 能力时才退回
    按分数顺拣，此时返回的 `current.https_ok` 会是 false——HTTPS 目标仍会失败。
    """
    return await _a_call("POST", "/api/proxy/rotate")


@mcp.tool()
async def proxy_use(proxy: str) -> dict:
    """**精确切换到指定代理**（host:port），返回新的当前代理。需服务在跑。

    与 `proxy_rotate`（顺拣下一个，碰运气）互补：`proxy_check_url` 判出某个 IP 对
    目标站点**可达/未被封禁**后，直接把它钉死为当前代理，后续 `curl -x <入口>` 全走它。
    地址不在池或非 Working 会报错。

    若该代理 `https_ok=false`，返回里会带 `warning` 提示它做不了 HTTPS。
    """
    return await _a_call("POST", "/api/proxy/use", {"proxy": proxy})


@mcp.tool()
async def proxy_select(limit: int = 1, region: str | None = None,
                       max_latency_ms: float | None = None,
                       https_only: bool = False) -> dict:
    """按评分挑最合适的代理（可选地区 / 延迟上限 / 只要 HTTPS 可用）。不启服务也可用。

    `https_only=true` 只回 `https_ok==true` 的代理（能 CONNECT 隧道）——**访问 HTTPS
    目标时应当用它**。缺省 `false` 时不筛，但结果里 `https_ok=true` 的排前面。
    """
    return await _a_call("POST", "/api/proxy/select",
                         {"limit": limit, "region": region,
                          "max_latency_ms": max_latency_ms,
                          "https_only": https_only})


@mcp.tool()
async def proxy_add(records: list[dict]) -> dict:
    """把代理记录并入池（每条含 `proxy`（host:port），可选 `protocol`/`location` 等）。"""
    return await _a_call("POST", "/api/proxy/add", {"records": records})


@mcp.tool()
async def proxy_remove(addresses: list[str]) -> dict:
    """按地址（host:port）从池中移除代理。"""
    return await _a_call("POST", "/api/proxy/remove", {"addresses": addresses})


@mcp.tool()
async def proxy_fetch(protocols: list[str] | None = None) -> dict:
    """从在线源抓取代理入池（联网，较慢）。`protocols` 可选 http/socks4/socks5，空=全部。

    返回 `{job_id}`；抓取完成后用 `proxy_list` 查看。
    """
    return await _a_call("POST", "/api/proxy/fetch",
                         {"protocols": protocols or []})


@mcp.tool()
async def proxy_validate(workers: int = 50) -> dict:
    """批量验证池内全部代理（联网，慢）：回写 status/latency/score/https_ok。返回 `{job_id}`。"""
    return await _a_call("POST", "/api/proxy/validate", {"workers": workers})


@mcp.tool()
async def proxy_check_url(url: str, limit: int = 10, workers: int = 50,
                          probe_waf: bool = True) -> dict:
    """对**指定网站**用池内代理做可达性 + WAF/封禁检测，返回可用的代理。

    场景：拿到一个目标站，想知道「用哪些代理能正常访问它、哪些被它的 WAF 拦了」。
    做法：用池内每个代理 GET `url`，与平台**直连基线**对比——直连能过、经代理却拿到
    403/429/Cloudflare/雷池等拦截页者判「被该站封禁」；直连本身就被拦时不误判。

    参数：`probe_waf=False` 只测连通性、不判封禁。返回 `{url,total,reachable,blocked,
    usable,results,baseline}`，其中 **`usable` = 未被封禁的可用代理**（按延迟升序，
    最多 `limit` 个，每项 `{proxy,protocol,latency,status_code}`）——AI 直接据此
    `curl -x http://<proxy> <url>` 访问目标。

    **本工具是长轮询**（提交 Job 后等终态，最长 ``POLL_CAP_S`` 秒）。阻塞体已在
    工作线程里跑，调用它期间同 server 的其它工具仍可正常响应。
    """
    def _work() -> dict:
        job_id = _call("POST", "/api/proxy/check-url",
                       {"url": url, "workers": workers, "limit": limit,
                        "probe_waf": probe_waf})["job_id"]
        return _poll_job(job_id)

    return await asyncio.to_thread(_work)


if __name__ == "__main__":
    mcp.run()
