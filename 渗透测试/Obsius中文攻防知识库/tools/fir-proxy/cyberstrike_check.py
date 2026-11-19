"""cyberstrike 代理池验证 runner（平台侧宽松连通性检查）。

上游 ``cli.py validate`` 的判据过严：要求代理**同时**通过 ① HTTPS(CONNECT) 延迟检测
② httpbin 匿名检测 ③ cachefly 测速，任一抛异常即 ``Failed``——大量只会明文转发 HTTP
的免费代理被误判死（实测同批 120 条：宽松单目标过 52，上游完整三段只过 9）。

本 runner 换成**单目标连通性**判据：经代理 ``GET`` 一个可配置目标，拿到响应即 ``Working``，
并记录延迟。**复用上游** ``ProxyChecker.check_proxy_url``（本仓不改上游文件），只在
其外层计时得到 latency + 拼装 JSON。

用法（平台 ``core/proxy/pool.py::_validate_records`` 调用）::

    python cyberstrike_check.py -i proxies.json -o out.json \
        --target http://cp.cloudflare.com/generate_204 \
        --target-https https://cp.cloudflare.com/generate_204 \
        --timeout 5 --workers 50 --output-format json --quiet

输出：``-o`` 指向的 JSON 数组
``[{"protocol":..., "proxy":"host:port", "status":"Working|Failed", "latency":秒|None,
   "https_ok":bool|None, "error":...}, ...]``
（**含全部记录**，Failed 也写，供上层 ``_prune`` 剔除）；
``https_ok``（2026-10-11）：给了 ``--target-https`` 时，另经代理 GET 一个 https
目标（**走 CONNECT 隧道**）测「能否转发 HTTPS」，通即 True、不通 False；**只作能力
标注，不参与 status 判定**（免费代理普遍只转 HTTP，若并入 status 会把它们全判死）。
``hijacked``（2026-10-11 内容注入补丁）：给了 ``--target-b`` 时做**多目标一致性**交叉
验证——两个内容不同的目标经同一代理若返回**相同响应体指纹**，即判「内容注入/劫持型
出口」（对任意 host 回同一伪造页），``status`` 置 ``Failed``（附 ``hijacked=True``）。
stdout 另发**进度行** ``{"event":"progress","phase":"check","done":k,"total":N}``（平台流式解析）。

独立进程运行（cwd 应为 fir-proxy 目录），**不 import 平台任何模块**。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

# 默认验证基准（2026-10-15 由 i.zut.edu.cn 改）：原站整站 502（站点根与 https 均不可达），
# 会让全部代理被判 Failed；改用 Cloudflare 204 探测点——http 明文、无响应体、全球 CDN 最稳。
# 判据 `200 <= status_code < 400`（见上游 checker）认 204。平台侧一般经 --target 显式传入
# `config/proxy.json::validate_target`，此默认值仅独立运行/未传参时生效。
DEFAULT_TARGET = "http://cp.cloudflare.com/generate_204"
DEFAULT_TARGET_HTTPS = "https://cp.cloudflare.com/generate_204"
# 多目标一致性交叉验证（2026-10-11 内容注入/劫持型出口补丁）：默认第二个目标与首个
# 不同源，用于识破「对任意 host 的 / 都返回同一伪造页」的劫持代理。
DEFAULT_TARGET_B = "http://example.com"

#: 地区**未解析**时的占位值（与 `cyberstrike_serve.py` 的同名常量保持一致）。
#: 上游 `_get_proxy_location` 的兜底是 "未知"；池记录里压根没有 `location` 键时是 None。
#: `None` 也列进来是为了让 `_resolve_location` 自身语义自洽——调用点目前用
#: `if loc:` 兜住（所以去掉 `None` 是**等价变异**，不会有测试变红），但将来若改成
#: `if loc is not None:`，没有这一项就会把「没解析出来」当真实地区写进池记录。
_UNRESOLVED_LOCATIONS = frozenset({"", "Unknown", "未知", "N/A", "None", "null", None})


def _resolve_location(checker, record: dict) -> str | None:
    """解析代理出口 IP 的归属地（可选，2026-10-26）；未解析回 None。

    复用上游 ``ProxyChecker._get_proxy_location``（**不改上游文件**）：它自带
    ``location_cache``、多源回退（ip-api → ip.taobao）与中文国名映射，比在这里重写
    一份地理库靠谱。上游把它标成私有，故用 ``getattr`` 软取——将来上游改名只会让
    这里退化成「不解析」，绝不抛。

    **只在 ``--resolve-location`` 打开时调用**：这是每 IP 一次的**额外联网查询**，
    免费源有速率限制（ip-api 约 45 次/分），池规模大时既拖慢验证又容易 429。
    """
    resolver = getattr(checker, "_get_proxy_location", None)
    if not callable(resolver):
        return None
    ip = str(record.get("proxy") or "").rsplit(":", 1)[0].strip()
    if not ip:
        return None
    try:
        loc = resolver(ip)
    except Exception:  # noqa: BLE001 —— 解析失败不影响连通性结论
        return None
    if not isinstance(loc, str):
        return None
    loc = loc.strip()
    return None if loc in _UNRESOLVED_LOCATIONS else loc


def _content_fingerprint(status, body: bytes) -> str:
    """响应体指纹：状态码 + 长度 + 正文 sha256 前 16 hex。

    用于交叉验证——两个**真实内容不同**的目标经同一代理若得到相同指纹，说明代理
    对任意目标都回同一页（内容注入/劫持）。指纹含长度，避免「同前缀不同体」误判。
    """
    import hashlib
    digest = hashlib.sha256(body or b"").hexdigest()[:16]
    return f"{status}:{len(body or b'')}:{digest}"


def _probe_body(record: dict, url: str, timeout: int) -> dict:
    """经代理 GET ``url`` 并**读取响应体**（上游 check_proxy_url 用 stream 即关、
    读不到体，故独立实现）。返回 ``{ok, status, body, error}``。

    仅做原始读取，不含任何平台依赖；供 ``check_records`` 的内容探测调用。
    """
    proxy = record.get("proxy")
    protocol = (record.get("protocol") or "http").lower()
    proxy_url = f"{protocol}://{proxy}"
    try:
        import requests
    except ImportError as exc:  # noqa: BLE001 —— 缺依赖=不具备内容探测能力
        return {"ok": False, "status": None, "body": b"", "error": f"requests 缺失: {exc}"}
    try:
        connect_timeout = max(1, min(int(timeout), 5))
        read_timeout = max(connect_timeout, int(timeout))
        resp = requests.get(url, proxies={"http": proxy_url, "https": proxy_url},
                            timeout=(connect_timeout, read_timeout), allow_redirects=True)
        body = resp.content or b""
        return {"ok": True, "status": resp.status_code, "body": body, "error": ""}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "status": None, "body": b"", "error": str(exc)}


def check_records(records: list[dict], target: str, timeout: int, workers: int,
                  checker_factory=None, on_progress=None,
                  target_https: str | None = None,
                  https_checker_factory=None,
                  target_b: str | None = None,
                  probe_factory=None,
                  resolve_location: bool = False) -> list[dict]:
    """经代理 GET ``target``：通即 Working（记 latency 秒），否则 Failed。含全部记录。

    ``target_https`` 非空时（2026-10-11）额外经代理 GET 该 https 目标（CONNECT 隧道）
    定 ``https_ok``（True/False）；**不参与 status**，只是能力标注。``https_checker_factory``
    可单独注入（测试用），缺省复用 ``checker_factory``。

    ``target_b`` 非空时（2026-10-11 内容注入补丁）做**多目标一致性**交叉验证：对已通过
    连通性的记录，再经代理读 ``target`` 与 ``target_b`` 两个**内容不同**目标的响应体指纹；
    两者指纹相同 → 判定为内容注入/劫持型出口，``status`` 置 ``Failed`` 并标 ``hijacked=True``
    （附 ``error`` 说明）。``probe_factory`` 可注入（测试用），默认用 ``_probe_body``。

    ``checker_factory``/``probe_factory`` 为可注入工厂（测试传假件即可离线直测，不触网）。
    ``on_progress(payload)`` 每 ~20 条回调一次。
    """
    if not records:
        return []

    if checker_factory is None:
        from modules.checker import ProxyChecker
        checker_factory = lambda: ProxyChecker(timeout=timeout)  # noqa: E731
    checker = checker_factory()
    https_checker = (https_checker_factory or checker_factory)() if target_https else None
    probe = (probe_factory or _probe_body) if target_b else None

    def one(record: dict) -> dict:
        t0 = time.time()
        try:
            res = checker.check_proxy_url(record, target, timeout)
        except Exception as exc:  # noqa: BLE001
            res = {"ok": False, "error": str(exc)}
        dt = time.time() - t0
        ok = bool(res.get("ok"))
        out = {
            **record,
            "status": "Working" if ok else "Failed",
            "latency": dt if ok else None,
            "error": "" if ok else (res.get("error") or "不可达"),
        }
        if probe is not None and ok:
            # 内容注入交叉验证：两目标真实内容不同，同一代理若回相同体=伪造页。
            pa = probe(record, target, timeout)
            pb = probe(record, target_b, timeout)
            if not (pa.get("ok") and pb.get("ok")):
                # 探测本身失败不判死（可能只是第二个目标偶发不可达），保留连通结论。
                out["hijacked"] = False
            else:
                fp_a = _content_fingerprint(pa.get("status"), pa.get("body") or b"")
                fp_b = _content_fingerprint(pb.get("status"), pb.get("body") or b"")
                if fp_a == fp_b:
                    out["status"] = "Failed"
                    out["latency"] = None
                    out["hijacked"] = True
                    out["error"] = (f"内容注入/劫持型出口：对 {target} 与 {target_b} "
                                    f"返回同一响应（{fp_a}）")
                else:
                    out["hijacked"] = False
        if https_checker is not None:
            try:
                hres = https_checker.check_proxy_url(record, target_https, timeout)
            except Exception:  # noqa: BLE001 —— 探测失败=不具备 https 能力，不删记录
                hres = {"ok": False}
            out["https_ok"] = bool(hres.get("ok"))
        if resolve_location:
            # 归属地只对**通了的**记录有意义（Failed 的出口留着旧值即可）。
            # 解析失败不写键——上层据此区分「解析过但失败」与「从没解析过」。
            loc = _resolve_location(checker, record) if ok else None
            if loc:
                out["location"] = loc
        return out

    total = len(records)
    out: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(1, min(workers, total))) as ex:
        futures = [ex.submit(one, r) for r in records]
        done = 0
        for fut in as_completed(futures):
            out.append(fut.result())
            done += 1
            if on_progress is not None and (done % 20 == 0 or done == total):
                on_progress({"event": "progress", "phase": "check",
                             "done": done, "total": total})
    return out


# ---------- 指定网站可达性 / WAF 封禁检测（2026-10-12） ----------

# 被 WAF/封禁的典型状态码（需与直连基线指纹不同才判封禁）
BLOCK_STATUS = frozenset({403, 406, 429, 503})
# 拦截页特征词（小写比对）。
_BLOCK_MARKERS = (
    "cloudflare", "attention required", "access denied", "you have been blocked",
    "cf-ray", "safeline", "雷池", "安全狗", "拦截", "禁止访问", "请求过于频繁",
    "captcha", "验证码", "rate limit", "forbidden",
)


def _probe_direct(url: str, timeout: int) -> dict:
    """不挂代理直连 GET ``url``（做基线）。返回 ``{ok,status,body,error}``。

    直连若本身被拦（WAF 对所有人），则不应把「经代理也拿到拦截页」判为代理被封——
    故用基线指纹做对比。本机直连同时反映「平台自身出口是否被该站拦」。
    """
    try:
        import requests
    except ImportError as exc:  # noqa: BLE001
        return {"ok": False, "status": None, "body": b"", "error": f"requests 缺失: {exc}"}
    try:
        connect_timeout = max(1, min(int(timeout), 5))
        read_timeout = max(connect_timeout, int(timeout))
        resp = requests.get(url, timeout=(connect_timeout, read_timeout),
                            allow_redirects=True)
        return {"ok": True, "status": resp.status_code,
                "body": resp.content or b"", "error": ""}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "status": None, "body": b"", "error": str(exc)}


def _looks_blocked(status, body: bytes) -> bool:
    """状态码或响应体特征判定「疑似拦截页」。"""
    if isinstance(status, int) and status in BLOCK_STATUS:
        return True
    try:
        low = (body or b"").decode("utf-8", "ignore").lower()
    except Exception:  # noqa: BLE001
        low = ""
    return any(m in low for m in _BLOCK_MARKERS)


def check_urls(records: list[dict], url: str, timeout: int, workers: int,
               probe_factory=None, direct_factory=None,
               on_progress=None, confirm_anomalies: bool = True) -> dict:
    """经每个代理 GET ``url``，与**直连基线**对比判定「可达 / 被该站封禁」。

    判据（参考 M1「内容注入交叉验证」思路，但这里对**指定站点**）：
    - ``baseline``：直连一次得状态码 + 响应体指纹；
    - 每个代理：``ok``=拿到响应；``blocked``=有响应 且（状态码 ∈ ``BLOCK_STATUS``
      或体含拦截特征词）**且**该响应指纹与直连基线不同（直连本身就被拦时不误判）；
      ``latency``=秒；探测异常 → ``ok=False, blocked=False``（绝不误判）。

    ``probe_factory``/``direct_factory`` 可注入（测试离线直测，不触网）。
    返回 ``{"url","baseline","results":[{proxy,protocol,ok,status_code,latency,
    blocked,reason}]}``。``on_progress(payload)`` 每 ~20 条回调一次。
    """
    out: dict = {"url": url, "baseline": None, "baseline_valid": False,
                 "verdict": "indeterminate", "blocked": None, "results": []}
    if not records:
        return out

    probe = probe_factory or _probe_body
    direct = direct_factory or _probe_direct
    base = direct(url, timeout)
    base_fp = None
    if base.get("ok"):
        base_fp = _content_fingerprint(base.get("status"), base.get("body") or b"")
    out["baseline"] = {
        "ok": bool(base.get("ok")), "status_code": base.get("status"),
        "error": base.get("error") or "",
    }
    out["baseline_valid"] = base_fp is not None
    out["verdict"] = "comparable" if base_fp is not None else "indeterminate"

    def one(record: dict) -> dict:
        t0 = time.time()
        res = probe(record, url, timeout)
        dt = time.time() - t0
        ok = bool(res.get("ok"))
        status = res.get("status") if ok else None
        body = res.get("body") or b""
        blocked = False
        reason = ""
        if ok:
            fp = _content_fingerprint(status, body)
            if base_fp is None:
                reason = "直连基线失败，无法判定是否被该站拦截"
            elif fp == base_fp:
                reason = "与直连基线一致（正常内容）"
            elif _looks_blocked(status, body):
                blocked = True
                reason = f"疑似被该站拦截（HTTP {status}）" if isinstance(status, int) \
                    else "疑似被该站拦截"
            else:
                reason = "正常响应"
        else:
            reason = res.get("error") or "不可达"
        return {
            "proxy": record.get("proxy"), "protocol": record.get("protocol"),
            "ok": ok, "status_code": status,
            "latency": round(dt, 3) if ok else None,
            "blocked": blocked if base_fp is not None else None,
            "verdict": "comparable" if base_fp is not None else "indeterminate",
            "reason": reason,
        }

    total = len(records)
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(1, min(workers, total))) as ex:
        futures = [ex.submit(one, r) for r in records]
        done = 0
        for fut in as_completed(futures):
            results.append(fut.result())
            done += 1
            if on_progress is not None and (done % 20 == 0 or done == total):
                on_progress({"event": "progress", "phase": "check-url",
                             "done": done, "total": total})
    if confirm_anomalies:
        by_proxy = {r.get("proxy"): r for r in results}
        for row in results:
            if not (row.get("blocked") is True or row.get("ok") is False):
                continue
            alternatives = [r for r in records if r.get("proxy") != row.get("proxy")]
            if not alternatives:
                row["confirmation"] = {
                    "confirmed": None, "verdict": "unconfirmed",
                    "reason": "没有第二个不同出口可复测",
                }
                continue
            secondary = alternatives[0]
            secondary_result = by_proxy.get(secondary.get("proxy"))
            # Reuse an already collected result where possible; otherwise make a fresh probe.
            if secondary_result is None:
                secondary_result = one(secondary)
            confirmed = None
            if row.get("blocked") is True and secondary_result.get("blocked") is True:
                confirmed = True
            elif row.get("blocked") is True and secondary_result.get("blocked") is False:
                confirmed = False
            elif row.get("ok") is False and secondary_result.get("ok") is False:
                confirmed = True
            elif row.get("ok") is False and secondary_result.get("ok") is True:
                confirmed = False
            row["confirmation"] = {
                "proxy": secondary.get("proxy"),
                "ok": secondary_result.get("ok"),
                "status_code": secondary_result.get("status_code"),
                "latency": secondary_result.get("latency"),
                "blocked": secondary_result.get("blocked"),
                "confirmed": confirmed,
                "verdict": "confirmed" if confirmed is True else
                           "contradicted" if confirmed is False else "indeterminate",
            }
    out["results"] = results
    return out


def _write_output(path: str, data) -> None:
    """把结果写到 ``-o``（JSON，UTF-8），父目录按需创建。"""
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def main(argv: list[str] | None = None) -> int:
    # Windows 默认控制台代码页（GBK）会把中文日志写坏；两路强制 UTF-8。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(
        prog="cyberstrike_check.py",
        description="fir-proxy 代理池验证 runner（宽松单目标连通性）")
    parser.add_argument("-i", "--input", required=True, help="代理输入文件（JSON/TXT/CSV）")
    parser.add_argument("-o", "--output", required=True, help="输出 JSON 文件路径")
    parser.add_argument("--output-format", default="json", help="兼容 cli.py 接口（仅 json）")
    parser.add_argument("--target", default=DEFAULT_TARGET, help="验证目标 URL（HTTP 连通性）")
    parser.add_argument("--target-https", default=None,
                        help="HTTPS 能力探测目标（经 CONNECT）；省略/空=不探测")
    parser.add_argument("--target-b", default=None,
                        help="内容注入交叉验证的第二个目标（与 --target 内容不同）；"
                             "省略/空=不做多目标一致性校验")
    parser.add_argument("--url", default=None,
                        help="指定网站可达性/WAF 封禁检测模式：给了即对每个代理 GET 它，"
                             "并与直连基线对比；省略=常规单目标验证模式")
    parser.add_argument("--probe-waf", dest="probe_waf", action="store_true", default=True,
                        help="check-url 模式下做 WAF/封禁判定（默认开）")
    parser.add_argument("--no-probe-waf", dest="probe_waf", action="store_false",
                        help="check-url 模式只测连通性、不判封禁")
    parser.add_argument("--timeout", type=int, default=5, help="单代理检查超时（秒）")
    parser.add_argument("--workers", type=int, default=50, help="并发数")
    parser.add_argument("--resolve-location", dest="resolve_location",
                        action="store_true", default=False,
                        help="为通过的代理解析出口归属地（每 IP 一次额外联网查询，"
                             "免费源有速率限制；默认关，关了 location 就一直是空的）")
    parser.add_argument("--quiet", action="store_true", help="兼容 cli.py 接口")
    parser.add_argument("--log-file", help="兼容 cli.py 接口（本 runner 不落日志文件）")
    args = parser.parse_args(argv)

    import cli

    records, _invalid = cli.load_proxies(args.input)

    # check-url 模式（2026-10-12）：指定网站可达性/WAF 封禁检测，与直连基线对比。
    if args.url:
        if not args.probe_waf:
            # 不做封禁判定 → 退化为纯连通性（复用 check_records，目标即 args.url）。
            plain = check_records(records, args.url, args.timeout, args.workers,
                                  on_progress=_emit)
            summary = {
                "url": args.url,
                "baseline": None,
                "results": [{"proxy": r["proxy"], "protocol": r.get("protocol"),
                             "ok": r["status"] == "Working",
                             "status_code": None, "latency": r.get("latency"),
                             "blocked": False,
                             "reason": "" if r["status"] == "Working" else (r.get("error") or "不可达")}
                            for r in plain],
            }
        else:
            summary = check_urls(records, args.url, args.timeout, args.workers,
                                 on_progress=_emit)
        _write_output(args.output, summary)
        res = summary["results"]
        _emit({"ok": True, "command": "check-url", "url": args.url,
               "count": len(res),
               "reachable": sum(1 for r in res if r["ok"]),
               "blocked": sum(1 for r in res if r["blocked"]),
               "usable": sum(1 for r in res if r["ok"] and not r["blocked"])})
        return 0

    results = check_records(records, args.target, args.timeout, args.workers,
                            on_progress=_emit,
                            target_https=args.target_https or None,
                            target_b=args.target_b or None,
                            resolve_location=args.resolve_location)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    working = sum(1 for r in results if r["status"] == "Working")
    _emit({
        "ok": True,
        "command": "check",
        "target": args.target,
        "count": len(results),
        "working": working,
        "failed": len(results) - working,
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
