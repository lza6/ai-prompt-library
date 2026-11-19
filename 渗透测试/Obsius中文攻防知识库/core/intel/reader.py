"""情报阅读器正文提取（阅读器模块，2026-10-27）：URL → 干净 Markdown 正文。

**为什么需要专用层**：情报页原来点文章直接 `openExternal` 交给系统浏览器，
结果是广告、弹窗、登录墙、WAF 滑块三件套。阅读器的目标是把「正文」从页面里
剥出来自己渲染，广告/弹窗/侧栏根本不存在，也就谈不上屏蔽。

**复用而非重造**（用户要求优先找开源实现）：
- 正文提取用 `trafilatura`（Apache-2.0，`adbar/trafilatura`）。它在 ScrapingHub 的
  article-extraction benchmark、Bevendorff 2023 的 ROUGE-LSum 评测里都是最佳
  单工具，被 HuggingFace / IBM / NVIDIA / Internet Archive 等使用。自带 jusText
  与 readability-lxml 作为 fallback，不必自己写密度算法。
- JS 渲染 / WAF 兜底用项目已有的 Playwright（`core/browser`），不引第三方 scraping API。

**分层策略**（`engine` 字段回报实际生效的那一层，便于前端解释）：
1. `http`     urllib 取 HTML → trafilatura 提取。覆盖绝大多数技术站，最快。
2. `render`   上一步正文过短或命中 WAF 特征 → Playwright 渲染后重取 HTML 再提取。
3. `failed`   两层都不够（登录墙 / 硬验证码 / 纯前端 SPA 且有反爬），回 errors 说明。

**绝不假装成功**：正文太短不给「成功」假象——返回 status="failed" 并带可读原因，
前端据此显示「原文阅读 / 用浏览器打开」的出口，而不是渲染一个空壳。

出站 HTTP 走标准库 urllib（与 `fetch.py` 同口径：平台自身可信出站，不经执行网关），
getter / renderer 均可注入，测试永不触网。
"""

from __future__ import annotations

import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

# 桌面浏览器 UA：不少技术站对默认 Python-urllib 直接 403。
UA_DESKTOP = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

#: 正文过短阈值（字符）。低于此值视为「没抓到正文」而触发渲染兜底。
MIN_CONTENT_CHARS = 400
#: 渲染兜底后仍低于此值 → 判定失败（有的站确实只有一句话，但概率极低，
#: 宁可在极短文章上误报一次，也不要把登录墙/JS 空壳当成正文给用户看）。
FAIL_CONTENT_CHARS = 120
#: 页面体量上限（字节）。超过直接判失败：8MB 的 HTML 要么是巨型列表页，
#: 要么是二进制假装 text/html，继续解析只会吃满内存。
MAX_HTML_BYTES = 8 * 1024 * 1024

#: **端到端预算**（秒）：HTTP 抓取 + 渲染兜底的总时长上限。
#: 用户点开一篇文章愿意等的时间是有上限的，而「网络层卡住」的耗时不可控——
#: 实测 GitHub 在某代理下 `RemoteDisconnected` 后又让渲染挂到 `ERR_CONNECTION_TIMED_OUT`，
#: 两者串起来 42 秒才失败。超预算就带着当前已有结果返回，把「再等等」变成「就这样」。
TOTAL_BUDGET_S = 35.0

# WAF / 反爬 / 验证页特征 —— **挑战页独占**。命中即认为「拿到的不是正文」：
# 这类页面往往 HTTP 200 + 十几 KB HTML，只看长度会误判成成功（FreeBuf 实测
# 返回阿里云滑块页 16KB，正文 0 字）。这些词在正常内容页里不会出现。
_WAF_MARKERS = (
    "aliyun_waf", "aliyunCaptcha", "CF_APP_WAF", "captcha-container",
    "acw_sc__v2", "cf-browser-verification", "challenge-platform",
    "Just a moment...", "Attention Required! | Cloudflare",
    "Enable JavaScript and cookies to continue",
)

# 「可嵌入组件类」特征：**正常页面也会带**，不能单凭它判风控。
#
# 2026-10-28 FreeBuf 实测：每篇文章的页头都有 `<div id="geetest-button">`
# （登录/注册的极验占位组件），原文里 `geetest` 命中一次 → 命中即判 failed，
# 于是**正文已经完整拿到（2612 字 / 6 个标题 / 12 张图）也照样报「站点启用了
# 人机验证」**。同理，「安全验证」这类中文短语在讲验证码/2FA 的文章里本就常见。
#
# 判据改成「命中 **且** 没取到正文」：真滑块页的正文恒为 0~474 字（实测 FreeBuf
# 渲染后 474 字全是 CF_APP_WAF 脚本片段），而能拿到 400 字以上正文的页面不可能
# 是它还停在挑战页。
_WAF_SOFT_MARKERS = (
    "g-recaptcha", "h-captcha", "geetest", "访问验证", "人机验证", "安全验证",
    # 知乎 zse-ck 挑战壳（2026-10-29 实测）：584B，`<meta id="zh-zse-ck">` + 一段
    # 算 `__zse_ck` cookie 的脚本。**故意放进软特征而不是硬挑战**——它正好是
    # 「渲染一层就能过」的类型，硬挑战会让阅读器跳过渲染、白白放弃唯一出路。
    "zh-zse-ck",
    # 知乎登录态校验失败时的 JSON 错误体（281B）：
    # `{"error":{"message":"您当前请求存在异常…","code":40362}}`。
    # 实测连「有头真实 Chrome + 持久 profile + 自然点击路径」都拿不到，
    # 只有带登录态才能过 —— 所以它必须能触发渲染兜底（软特征即可）。
    '"code":40362',
)

#: 已知站点的**可执行建议**：失败时把「怎么办」直接写进 errors，而不是只报现象。
#: 元组 = (特征词, 站点标识, 建议文案)。站点标识非空表示可能需要登录或人工访问，
#: 会写进 `ReadResult.login_hint`，前端据此提供登录入口和原文浏览选项——
#: **前端不解析文案**，改字不会让操作入口消失。
_SITE_ADVICE = (
    ("zh-zse-ck", "zhihu",
     "知乎专栏需要先过 zse-ck 校验。点「一键登录」扫码一次，之后自动复用登录态。"),
    ('"code":40362', "zhihu",
        "知乎拒绝了当前请求（code 40362）。这可能是文章级风控、账号权限或请求环境限制；"
        "请确认原文能在当前账号打开，或用浏览器打开原文。"),
    ('"code": 40362', "zhihu",
     "知乎拒绝了当前请求（code 40362）。这可能是文章级风控、账号权限或请求环境限制；"
     "请确认原文能在当前账号打开，或用浏览器打开原文。"),
)


def site_advice(html: str) -> tuple[str, str]:
    """命中已知站点时返回 `(站点标识, 建议文案)`；未命中返回 `("", "")`。"""
    low = (html or "")[:60000].lower()
    for marker, site, advice in _SITE_ADVICE:
        if marker.lower() in low:
            return site, advice
    return "", ""

#: **交互式挑战**特征：必须真人点/拖才能过，或页面本身就是一层纯挑战壳。
#:
#: 判据是**特征词 + 页面体量**一起看，单看特征词会误杀：
#: - NVD 的 `challenge-platform` 页只有 2.4KB（纯 JS 挑战脚本，无内容骨架）→ 硬挑战，
#:   渲染也过不去（实测 TLS 握手被挂 36 秒）；
#: - 先知社区的 `acw_sc__v2` 页有 23KB（真实内容骨架 + 一段算 cookie 的脚本）→
#:   渲染一层就过去了（实测直连 0 字 → 渲染后 13619 字），**必须让它走兜底**。
_HARD_CHALLENGE_MARKERS = (
    "cf-browser-verification", "challenge-platform", "acw_sc__v2",
    "g-recaptcha", "h-captcha", "geetest", "aliyunCaptcha",
    "Just a moment...",
)
#: 挑战页体量阈值（字符）：低于此值 + 命中挑战特征 = 纯挑战壳，渲染无意义。
#: 真实内容页即便带挑战脚本也远超这个数（导航/正文骨架本身就有几十 KB）。
_HARD_CHALLENGE_MAX_CHARS = 8000
# 登录墙特征：正文里反复出现这些短语，基本就是「要登录才能看全文」。
_LOGIN_MARKERS = ("请先登录", "登录后查看", "登录后阅读", "注册后查看",
                  "sign in to continue", "log in to continue",
                  "subscribe to continue", "members only")

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


@dataclass
class ReadResult:
    """一次提取的结果。status: ok | partial | failed。"""
    url: str
    final_url: str = ""
    title: str = ""
    markdown: str = ""
    text: str = ""                      # 纯文本（AI 上下文与字数统计用）
    site: str = ""
    author: str = ""
    published: str = ""
    engine: str = ""                    # http | render | failed
    status: str = "ok"
    chars: int = 0
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    #: 需要人工登录才可能读到时的站点标识（如 ``"zhihu"``），否则为空。
    #: 前端据此显示「一键登录」并调 `POST /api/intel/read/login`。
    login_hint: str = ""

    def to_dict(self) -> dict:
        return {
            "url": self.url, "final_url": self.final_url or self.url,
            "title": self.title, "markdown": self.markdown, "text": self.text,
            "site": self.site, "author": self.author, "published": self.published,
            "engine": self.engine, "status": self.status, "chars": self.chars,
            "errors": self.errors, "warnings": self.warnings,
            # 结构化提示：前端据此决定要不要显示「一键登录」按钮。
            # **不能靠 errors 里的文案匹配**——文案是可读的、会被改的，
            # 一旦改字按钮就悄悄消失，而且没有任何测试会红。
            "login_hint": self.login_hint,
        }


# ---------- 抓取 ----------

def normalize_url(raw: str) -> str:
    """校验并归一化目标 URL。只放行 http/https（防 file:// 读本地文件、
    javascript: 注入）。返回 '' 表示不可用。"""
    url = str(raw or "").strip()
    if not url:
        return ""
    # **先判有没有 scheme**：`javascript:alert(1)` 里 `://` 不存在，按「省略协议」
    # 补成 `https://javascript:alert(1)` 会把它变成一个合法 host —— 白名单被绕过。
    # 有 `scheme:` 前缀的一律先按原样解析，让下面的 scheme 校验去拒。
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:", url):
        url = "https://" + url
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return ""
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return ""
    return url


def is_public_host(url: str) -> bool:
    """目标主机是否是可安全出站的公网地址（防 SSRF）。

    阅读器的配图代理会把远端字节原样转给前端，等于给了一个「任意 URL 取回」
    的入口。必须挡住指向内网/回环/链路本地的目标——否则
    `http://127.0.0.1:8420/api/...`、`http://169.254.169.254/`（云元数据）
    这类地址就能被拿来做内网探测。

    **必须解析域名后再判 IP**：只做字符串匹配挡不住 `nip.io` / 自建 DNS
    这类把私网地址伪装成域名的写法。
    """
    import ipaddress
    import socket

    try:
        host = urllib.parse.urlsplit(url).hostname or ""
    except ValueError:
        return False
    h = host.strip().lower().rstrip(".")
    if not h or h in ("localhost",) or h.endswith((".localhost", ".local", ".internal")):
        return False
    try:
        infos = socket.getaddrinfo(h, None)
    except OSError:
        return False
    if not infos:
        return False
    for info in infos:
        addr = info[4][0] if len(info) > 4 else ""
        # IPv6 带 zone id（fe80::1%eth0）会让 ip_address 解析失败 → 直接判不安全
        addr = str(addr).split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return False
    return True


def default_fetch(url: str, timeout: float = 25.0) -> tuple[int, str, str]:
    """GET 页面 → (status, html, final_url)。

    用桌面 UA + 常见 Accept 头；跟随重定向（urllib 默认）。非 2xx 仍返回
    （调用方可能想据 403/429 给出更准确的原因），只有网络层异常才抛出。
    """
    req = urllib.request.Request(url, headers={
        "User-Agent": UA_DESKTOP,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read(MAX_HTML_BYTES + 1)
        charset = resp.headers.get_content_charset() or "utf-8"
        final = resp.geturl() or url
    if len(body) > MAX_HTML_BYTES:
        raise ValueError(f"页面超过 {MAX_HTML_BYTES // 1024 // 1024}MB 上限")
    try:
        html = body.decode(charset, errors="replace")
    except LookupError:            # 站点声明了不存在/非法的 charset
        html = body.decode("utf-8", errors="replace")
    return resp.status, html, final


def _client_hints(ua: str = UA_DESKTOP) -> dict[str, str]:
    """按 UA 生成**自洽的** client hints 头。

    **为什么必须有**（2026-10-28 FreeBuf 实测）：阿里云 WAF 会核对「UA 声称的浏览器」
    与 `sec-ch-ua` 是否一致。只改 UA 而不发 client hints / 发的还是 HeadlessChrome
    品牌 → 判定为伪装 → 返回 16KB 滑块壳页。无头 Chromium 的四组对照实验：
    仅 UA = 拦；**UA + sec-ch-ua = 过**；仅 stealth 补丁（抹 `navigator.webdriver`）
    = 拦；两者都加 = 过 —— 决定性变量是 client hints，不是 webdriver。
    """
    m = re.search(r"Chrome/(\d+)", ua or "")
    major = m.group(1) if m else "124"
    return {
        "sec-ch-ua": f'"Chromium";v="{major}", "Google Chrome";v="{major}", '
                     f'"Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    }


#: 阅读器专用浏览器 profile 目录（运行数据归口 data/）。
#: **为什么单独一个 profile 而不是复用 core/browser 的**：那边是每项目一份、
#: 由浏览器池长期持有（`user_data_dir` 是进程级排他锁），阅读器抢不到；而且
#: 阅读器的渲染是一次性短生命周期，混进项目 profile 只会互相干扰。
# Resolve from this module, not the process cwd: API, CLI and standalone callers
# must all address the same Chromium profile.
READER_PROJECT_ROOT = Path(__file__).resolve().parents[2]
READER_PROFILE_DIR = str(READER_PROJECT_ROOT / "data" / "browser" / "reader-profile")
#: 记录创建 profile 的浏览器实现，避免 Chrome/Chromium 交替打开导致 Windows Cookie 密钥不兼容。
READER_PROFILE_CHANNEL_FILE = str(
    READER_PROJECT_ROOT / "data" / "browser" / "reader-profile.channel")
#: 启用持久 profile 的开关文件。**存在才用**，不存在就走原来的临时 context。
#: 用「文件存在」而不是环境变量：登录态是一次性人工动作，开关跟着 profile 走
#: 才不会出现「换了个终端就失效」。`scripts/reader_login.py` 登录成功后写这个文件。
READER_PROFILE_ENABLED = str(
    READER_PROJECT_ROOT / "data" / "browser" / "reader-profile.ready")


def reader_profile_channel() -> str:
    """读取创建 profile 时的 browser channel；旧版 profile 按旧流程视为 Chrome。"""
    try:
        with open(READER_PROFILE_CHANNEL_FILE, encoding="utf-8") as f:
            value = f.read().strip().lower()
    except OSError:
        legacy_default = os.path.join(READER_PROFILE_DIR, "Default")
        value = "chrome" if os.path.isdir(legacy_default) else "chromium"
    return value if value in {"chrome", "chromium"} else "chromium"


def reader_profile_ready() -> bool:
    """profile 最近一次登录流程已通过在线认证检查；cookie 后续仍可能被撤销。"""
    return (os.path.exists(READER_PROFILE_ENABLED)
            and os.path.isdir(READER_PROFILE_DIR))


# ---------- 登录态采集（2026-10-29）----------
#
# 逻辑放这里而不是脚本里：API 的登录 Job 与 `scripts/reader_login.py` 必须是
# **同一份判定与落盘逻辑**——检测哪个 cookie 算登录成功、profile channel 如何固定、
# 开关文件写在哪、profile 被占用时怎么报错。两处各写一份，改一处漏一处就是
# 「命令行能登录、界面上永远失败」这类静默分叉。

#: 登录成功的判据：知乎把登录态放在 `z_c0`（httpOnly 长期凭证）。
#: `_zap`/`_xsrf` 未登录时也会下发，用它们判断会假阳性。**按域分流**：将来
#: 加别的站点就在这里扩一行，检测/开关逻辑自动跟着走。
LOGIN_COOKIE_BY_DOMAIN = {"zhihu.com": "z_c0"}
LOGIN_ORIGIN = "https://www.zhihu.com/"
LOGIN_VERIFY_URL = "https://www.zhihu.com/api/v4/me"
#: 登录入口页：从首页点「登录」最自然；直接开 /signin 会被重定向绕一圈。
LOGIN_START_URL = "https://www.zhihu.com/"
#: 等待人工登录的上限（秒）。扫码/短信通常 1~2 分钟，给足 5 分钟。
LOGIN_WAIT_S = 300


def login_cookie_name(url: str) -> str:
    """按站点返回登录凭证 cookie 名（'' = 未知的登录站）。"""
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    for domain, name in LOGIN_COOKIE_BY_DOMAIN.items():
        if host == domain or host.endswith("." + domain):
            return name
    return ""


def profile_locked() -> bool:
    """profile 是否被别的进程持有（Chromium 的进程级排他锁）。"""
    return os.path.exists(os.path.join(READER_PROFILE_DIR, "SingletonLock"))


async def _has_login_cookie(ctx, cookie_name: str) -> bool:
    for c in await ctx.cookies(LOGIN_ORIGIN):
        if c.get("name") == cookie_name and c.get("value"):
            return True
    return False


async def _verify_zhihu_login(ctx) -> bool:
    """用真实浏览器请求知乎认证接口，验证会话而不只看 cookie 名。"""
    page = ctx.pages[0] if ctx.pages else await ctx.new_page()
    try:
        if not page.url.startswith(LOGIN_ORIGIN):
            await page.goto(LOGIN_ORIGIN, timeout=20000,
                            wait_until="domcontentloaded")
        payload = await page.evaluate("""async (url) => {
            const response = await fetch(url, {credentials: 'include'});
            let body = {};
            try { body = await response.json(); } catch (_) {}
            return {status: response.status, id: body.id || null};
        }""", LOGIN_VERIFY_URL)
        return (isinstance(payload, dict) and payload.get("status") == 200
                and bool(payload.get("id")))
    except Exception:                           # noqa: BLE001
        return False


def _set_reader_profile_channel(channel: str) -> None:
    """记录 profile 的 browser channel；只保存非敏感的实现名称。"""
    value = channel if channel in {"chrome", "chromium"} else "chromium"
    os.makedirs(os.path.dirname(READER_PROFILE_CHANNEL_FILE), exist_ok=True)
    with open(READER_PROFILE_CHANNEL_FILE, "w", encoding="utf-8") as f:
        f.write(value + "\n")


def _set_reader_profile_ready(ready: bool) -> None:
    """更新 profile 可用标记；cookie 本体只留在 Chromium 持久 profile 内。"""
    if ready:
        os.makedirs(os.path.dirname(READER_PROFILE_ENABLED), exist_ok=True)
        with open(READER_PROFILE_ENABLED, "w", encoding="utf-8") as f:
            f.write("ok\n")
    else:
        try:
            os.remove(READER_PROFILE_ENABLED)
        except FileNotFoundError:
            pass


def _login_flow_result(*, ok: bool, reason: str, cookies: int,
                       channel: str, cookie_persisted: bool = False,
                       verified: bool = False) -> dict:
    """登录结果同时标明实际 profile、channel 与重开验证结论。"""
    return {
        "ok": ok,
        "reason": reason,
        "cookies": cookies,
        "profile_dir": os.path.abspath(READER_PROFILE_DIR),
        "channel": channel,
        "cookie_persisted": cookie_persisted,
        "verified": verified,
    }


async def run_login_flow(*, headless: bool = False, wait_s: int = LOGIN_WAIT_S,
                         progress: Callable[[str], None] | None = None
                         ) -> dict:
    """弹出浏览器让用户登录，重开 profile 并通过知乎认证后才启用。

    Cookie 保存在 Chromium 持久 profile 中；ready 标记只表示已通过在线认证检查，
    不是 cookie 的备份。登录窗口关闭后必须重开 profile 验证，确保落盘数据可复用。
    """
    import os

    def say(msg: str) -> None:
        if progress:
            progress(msg)

    channel = reader_profile_channel()
    if profile_locked():
        return _login_flow_result(
            ok=False,
            reason="浏览器 profile 正被占用（可能有文章正在读取），稍等几秒再试",
            cookies=0, channel=channel)
    _set_reader_profile_ready(False)
    os.makedirs(READER_PROFILE_DIR, exist_ok=True)

    import asyncio
    from playwright.async_api import async_playwright

    cookie = login_cookie_name(LOGIN_START_URL) or "z_c0"
    logged_in = False
    n = 0
    cookie_persisted = False
    profile_exists = os.path.isdir(os.path.join(READER_PROFILE_DIR, "Default"))

    async with async_playwright() as pw:
        # 登录窗口与文章渲染必须使用同一浏览器实现：Windows 上不同 Chrome
        # 构建可能用不同 DPAPI app-bound key，换 channel 会让加密 cookie 消失。
        async def _launch_login_context(selected: str):
            kwargs = {"headless": headless, "locale": "zh-CN",
                      "viewport": {"width": 1280, "height": 900},
                      "ignore_https_errors": True}
            if selected == "chrome":
                kwargs["channel"] = "chrome"
            return await pw.chromium.launch_persistent_context(
                READER_PROFILE_DIR, **kwargs)

        if profile_exists:
            try:
                ctx = await _launch_login_context(channel)
            except Exception as primary_error:  # noqa: BLE001
                # 这是用户显式发起的恢复登录，可以切换引擎并重新认证；自动文章
                # 渲染绝不切换。记录新 channel，后续读取会严格跟随这份 profile。
                fallback = "chromium" if channel == "chrome" else "chrome"
                try:
                    ctx = await _launch_login_context(fallback)
                except Exception:
                    return _login_flow_result(
                        ok=False,
                        reason=f"无法打开现有浏览器 profile（{type(primary_error).__name__}）；"
                                "请检查 Chrome/Chromium 是否仍在运行",
                        cookies=0, channel=channel)
                channel = fallback
                say(f"已用 {channel} 打开现有 profile，请重新完成知乎登录")
        else:
            try:
                ctx = await _launch_login_context("chrome")
                channel = "chrome"
                say("已启动本机 Chrome")
            except Exception:                   # noqa: BLE001
                ctx = await _launch_login_context("chromium")
                channel = "chromium"
                say("本机 Chrome 不可用，已使用 Playwright Chromium")
        _set_reader_profile_channel(channel)

        try:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            try:
                await page.goto(LOGIN_START_URL, timeout=40000,
                                wait_until="domcontentloaded")
            except Exception as e:            # noqa: BLE001
                say(f"打开首页失败（{type(e).__name__}），请在窗口里手动访问")

            say(f"请在弹出的浏览器里登录（最多等 {wait_s // 60} 分钟）…")
            waited = 0
            cookie_seen = False
            last_verify = -10
            while waited < wait_s:
                cookie_seen = await _has_login_cookie(ctx, cookie)
                if cookie_seen and waited - last_verify >= 10:
                    last_verify = waited
                    if await _verify_zhihu_login(ctx):
                        break
                await asyncio.sleep(2)
                waited += 2
                if waited % 30 == 0:
                    say(f"…已等待 {waited} 秒，仍未通过知乎认证")

            if not cookie_seen or last_verify < 0 or not await _verify_zhihu_login(ctx):
                if cookie_seen:
                    reason = "检测到登录 cookie，但知乎认证接口未确认登录成功；请在窗口中重新登录后重试"
                    cookies = len(await ctx.cookies(LOGIN_ORIGIN))
                else:
                    reason = f"{wait_s // 60} 分钟内没检测到登录凭证（窗口关了或没完成登录）"
                    cookies = 0
                return _login_flow_result(
                    ok=False, reason=reason, cookies=cookies, channel=channel)
            await asyncio.sleep(2)
            n = len(await ctx.cookies(LOGIN_ORIGIN))
            say(f"检测到登录凭证（{n} 个 cookie），正在保存 profile…")
        finally:
            await ctx.close()

        # 先关闭有头窗口释放 Chromium 锁，再用后续阅读器相同的 headless
        # profile 打开方式验证，避免把「窗口内看见 cookie」误当成可复用。
        try:
            probe_kwargs = {
                "headless": True, "locale": "zh-CN",
                "viewport": {"width": 1280, "height": 900},
                "ignore_https_errors": True,
            }
            if channel == "chrome":
                probe_kwargs["channel"] = "chrome"
            probe = await pw.chromium.launch_persistent_context(
                READER_PROFILE_DIR, **probe_kwargs)
        except Exception as e:                    # noqa: BLE001
            reason = f"登录数据已写入 profile，但重开验证失败：{type(e).__name__}"
        else:
            try:
                cookie_persisted = await _has_login_cookie(probe, cookie)
                logged_in = await _verify_zhihu_login(probe)
            finally:
                await probe.close()
            reason = ""
            if not cookie_persisted:
                reason = "profile 重开后未找到知乎登录凭证 z_c0，登录态没有可靠落盘；请重新登录"
            elif not logged_in:
                reason = "profile 已保存，但知乎认证接口仍未识别为已登录；请在窗口里确认登录成功后重试"

    ready = cookie_persisted and logged_in
    _set_reader_profile_ready(ready)
    if not ready:
        say(reason)
        return _login_flow_result(
            ok=False, reason=reason, cookies=n, channel=channel,
            cookie_persisted=cookie_persisted, verified=logged_in)
    say("重新打开 profile 后通过知乎认证，登录态已保存并启用")
    return _login_flow_result(
        ok=True, reason="", cookies=n, channel=channel,
        cookie_persisted=True, verified=True)


def default_render(url: str, timeout: float = 22.0) -> tuple[str, str]:
    """Playwright 渲染 → (html, final_url)。仅兜底路径调用。

    `domcontentloaded` + 短等待而非 `networkidle`：广告/统计脚本常驻长连接，
    networkidle 在真实站点上经常等到超时也不满足，白等 30 秒。

    **超时预算 22 秒**（实测依据，2026-10-27）：NVD 这类站对无头浏览器有
    TLS 层风控，握手能一直挂着不返回——默认 30 秒会让用户盯着「正在提取正文」
    半分钟才等到失败。22 秒 + 上一次 HTTP 的 25 秒，最坏仍是可接受的一分钟内。

    **必须滚动整页**（2026-10-27 实测）：语雀 / 飞书文档的代码块是**虚拟列表**，
    只有滚到可视区才挂载真实内容，否则 `<ne-card data-card-name="codeblock">`
    里只有一个带高度的空 div。实测同一篇文章：不滚动时 11 个代码块只挂载 1 个，
    滚动后 11/11 全部挂载。不滚就只能拿到一句「代码块在这里」的空壳。

    **UA 必须配 client hints**（2026-10-28）：只改 UA 等于自报「UA 是 Chrome、
    TLS/头部却没有 Chrome 的 client hints」——阿里云 WAF 直接判伪装。实测加
    `sec-ch-ua` 三件套后同一篇文章从「滑块页 / 0 字」变成「正文 2612 字 / 6 个标题 /
    12 张图」，成本 3.9 秒。详见 `_client_hints`。

    **有登录态时改用持久 profile**（2026-10-29）：知乎部分文章在未登录或请求被风控时
    返回 `code 40362`。人工登录后将 cookie 保存在浏览器 profile；channel 记录到
    非敏感文本文件，后续登录验证与文章渲染必须用同一浏览器实现，且保留该引擎的
    原生 UA/Client Hints。**没有 ready 文件时行为与以前完全一致**（临时 context，
    退出即销毁），不给不登录的站点多留任何痕迹。
    """
    import asyncio

    async def _run() -> tuple[str, str]:
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            use_profile = reader_profile_ready()
            ctx = None
            browser = None
            if use_profile:
                import os

                os.makedirs(READER_PROFILE_DIR, exist_ok=True)
                # 持久 profile 必须用创建它的同一浏览器实现，尤其 Windows 上
                # Chrome/Chromium 的 cookie 解密上下文可能不同。
                profile_kwargs = {
                    "headless": True,
                    "locale": "zh-CN",
                    "viewport": {"width": 1280, "height": 900},
                    "ignore_https_errors": True,
                }
                if reader_profile_channel() == "chrome":
                    profile_kwargs["channel"] = "chrome"
                ctx = await pw.chromium.launch_persistent_context(
                    READER_PROFILE_DIR, **profile_kwargs)
                page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            else:
                browser = await pw.chromium.launch(headless=True)
                ctx = await browser.new_context(
                    user_agent=UA_DESKTOP,
                    locale="zh-CN",
                    viewport={"width": 1280, "height": 900},
                    ignore_https_errors=True,
                    extra_http_headers=_client_hints(UA_DESKTOP),
                )
                page = await ctx.new_page()
            try:
                await page.goto(url, timeout=int(timeout * 1000),
                                wait_until="domcontentloaded")
                await page.wait_for_timeout(1600)   # 让首屏 JS 渲染完
                # 分步滚到底：一次跳到底部不会触发中间元素的懒挂载。
                # 单页最多滚 120 步（约 7 万像素），防止无限加载页把时间吃光。
                for _ in range(120):
                    done = await page.evaluate(
                        """() => {
                            const before = window.scrollY;
                            window.scrollBy(0, window.innerHeight * 0.9);
                            return window.scrollY === before
                                || window.scrollY + window.innerHeight
                                   >= document.body.scrollHeight - 2;
                        }""")
                    await page.wait_for_timeout(120)
                    if done:
                        break
                await page.wait_for_timeout(500)    # 末屏内容补挂
                html = await page.content()
                return html, page.url
            finally:
                # 持久 profile 没有 browser 句柄，只能关 context；两者都判空，
                # 否则「用了 profile 却去 browser.close()」会 AttributeError 把
                # 已经拿到的正文一起吞掉。
                if browser is not None:
                    await browser.close()
                elif ctx is not None:
                    await ctx.close()

    try:
        return asyncio.run(asyncio.wait_for(_run(), timeout=timeout + 10))
    except asyncio.TimeoutError as e:
        # 外层兜一道：goto 的超时只管导航，滚动/取内容不受它约束
        raise TimeoutError(f"渲染超时（>{timeout + 10:.0f}s）") from e


# ---------- 质量判定 ----------

def waf_marker_hit(html: str, text: str = "") -> str:
    """返回命中的 WAF/验证特征词（'' = 未命中）。

    `text` 是同一页面已提取出的正文。**软特征（可嵌入组件类）只在没取到正文时
    才算数**：FreeBuf 的每篇文章页头都有极验登录组件（`<div id="geetest-button">`），
    按「命中词」判会把 2612 字的完整正文判成风控（2026-10-28 实测）。
    默认 `text=""` 时软特征仍生效 —— 纯字符串调用（老测试、告警文案）语义不变。
    """
    low = html[:60000].lower()      # 特征都在头部；不必扫全页
    for marker in _WAF_MARKERS:
        if marker.lower() in low:
            return marker
    if len(text or "") >= MIN_CONTENT_CHARS:
        # 正文已经到手，页面不可能还停在挑战壳上 → 软特征是页面自带的组件
        return ""
    for marker in _WAF_SOFT_MARKERS:
        if marker.lower() in low:
            return marker
    return ""


def hard_challenge_hit(html: str, text: str = "") -> str:
    """返回命中的**交互式**挑战特征（'' = 可救 / 未命中）。

    判据是「命中特征词 **且** 页面是纯挑战壳（体量小于阈值）」：
    真实内容页也常带 `acw_sc__v2` 这类算 cookie 的脚本，渲染一层就过；只有那种
    2~4KB、除了挑战脚本什么都没有的页面才是真过不去。单看特征词会白白丢掉能读的站。

    **正文已到手时一律不算挑战壳**（2026-10-28）：`geetest` 也在软特征里，短文章
    （原页 <8KB）配一个页头极验登录组件就会命中「体量小 + 特征词」→ 被判成
    「渲染也没用」，明明正文就在手里。真挑战壳的正文恒为 0 字。
    """
    if len(text or "") >= MIN_CONTENT_CHARS:
        return ""
    low = html[:60000].lower()
    if len(html) > _HARD_CHALLENGE_MAX_CHARS:
        return ""
    for marker in _HARD_CHALLENGE_MARKERS:
        if marker.lower() in low:
            return marker
    return ""


def html_title(html: str) -> str:
    m = _TITLE_RE.search(html or "")
    if not m:
        return ""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1) or "")).strip()


def login_wall_hit(text: str) -> bool:
    """正文里反复出现登录引导 → 大概率是截断的预览段落。"""
    if not text or len(text) > 3000:      # 长文里偶现一句不算墙
        return False
    low = text.lower()
    return sum(1 for m in _LOGIN_MARKERS if m.lower() in low) >= 2


def absolutize_links(markdown: str, base_url: str) -> str:
    """把 markdown 里的相对链接/图片改成绝对 URL。

    阅读器不在原文域名下渲染，相对路径 `../img/a.png` 必然 404。trafilatura
    输出的链接已经是页内原样，这里统一按最终 URL 补全。
    """
    if not markdown or not base_url:
        return markdown

    def _fix(m: re.Match) -> str:
        lead, target, tail = m.group(1), m.group(2), m.group(3)
        t = target.strip()
        if not t or t.startswith(("#", "data:", "mailto:", "javascript:")):
            return m.group(0)
        if t.startswith("//"):
            return f"{lead}https:{t}{tail}"
        try:
            absolute = urllib.parse.urljoin(base_url, t)
        except ValueError:
            return m.group(0)
        # 只放行 http(s)，避免把 javascript: 之类拼进来
        if urllib.parse.urlsplit(absolute).scheme not in ("http", "https"):
            return m.group(0)
        return f"{lead}{absolute}{tail}"

    # 图片 ![alt](src) 与链接 [text](href) 共用同一形态
    return re.sub(r"(!?\[[^\]]*\]\()([^)\s]+)(\))", _fix, markdown)


# ---------- 富文本编辑器归一化 ----------
#
# **为什么需要这一层**（2026-10-27 实测）：语雀 / 飞书文档这类富文本编辑器把正文
# 写成一整套私有标签（`<ne-p>` / `<ne-h2>` / `<ne-card data-card-name="codeblock">`），
# 表格靠 `<colgroup>` 布局、代码块用 CodeMirror 虚拟列表、无 `<th>`。trafilatura 只认
# 标准标签，于是：
# - 标题全丢（`<ne-h2>` 不是 heading）→ 前端大纲为空；
# - 表格有行无表头 → markdown 缺 `|---|` 分隔行 → remark-gfm 不认，渲染成一堆竖线；
# - 代码块整块消失（`<pre>` 数为 0，语言与代码全在 div 里）；
# - 正文图 `img.ne-image` 提不到，反而把页头头像/分享图标当成正文图。
# 实测同一篇文章：归一化前 H=0/IMG=0/FENCE=0，归一化后 H=31/IMG=7/FENCE=20。
#
# 手法是**把非标准结构改写成标准结构**，而不是自己写提取器 —— 仍然让 trafilatura
# 做它擅长的正文判定。图片与代码块用「原子标记」占位（`⟦IMG0⟧` / `⟦CODE0⟧`），
# 这样位置与语言标识都能原样穿过 trafilatura，最后再替换回 Markdown 语法。

#: HTML 标准标签名。只有去掉 `ne-` 前缀后是真标签才改名，否则会把
#: `ne-card` 之类改成不存在的标签，等于没改。
_HTML_TAGS = frozenset("""
a abbr address article aside b bdi bdo blockquote br caption cite code col
colgroup dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4
h5 h6 header hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp
section small span strong sub summary sup table tbody td tfoot th thead time
tr u ul var wbr
""".split())

#: 私有标签别名：`ne-text` 是行内文字，改成 span；其余 `ne-*` 容器多是块级。
_TAG_ALIASES = {
    "ne-text": "span",
    "ne-heading-content": "span",
    "ne-hole": "div",
    "ne-card": "div",
    "ne-table-hole": "div",
    "ne-table-wrap": "div",
    "ne-table-inner-wrap": "div",
    "ne-table-box": "div",
}

#: 正文容器的 class 线索。富文本编辑器把整篇文章包在一个普通 `<div>` 里
#: （`ne-viewer-body` / `lark-doc-content` / `prosemirror`…），而 trafilatura 判断
#: 「这是标题还是正文」时会参考**语义容器**：`<article>`/`<main>` 里的 `<h2>`
#: 才会被输出成 Markdown 标题。实测同一段 HTML，只把外层 div 换成 `<article>`：
#: 标题数 0 → 2。所以归一化时必须补上这个语义，否则大纲永远是空的。
_BODY_CLASS_RE = re.compile(
    r"(ne-viewer-body|lark-doc|doc-content|article-content|post-content"
    r"|entry-content|rich-text|markdown-body|prosemirror)", re.I)

#: 纯 UI 噪声的 class 片段：代码行号栏、光标层、折叠箭头、复制按钮、
#: 图片放大按钮都在这里。不删的话它们会变成正文里的数字与图标字符。
_NOISE_CLASS = (
    "ne-viewer-b-filler", "cm-gutters", "cm-layer", "cm-announced",
    "ne-codeblock-copy-icon", "ne-ui-image-inner-button-wrap",
    "ne-heading-ext", "ne-heading-fold", "ne-td-break", "gutter-fold",
    "ne-viewer-header", "ne-ui-exit-max-view-btn",
)

#: 行内元素。它们内部不能出现块级元素（HTML 规范上就不合法），而编辑器常把
#: `<ne-code><ne-code-content><ne-text>` 这种结构丢进来，改名后就成了
#: `<code><div>…</div></code>`，trafilatura 会把整个 cell 的内容丢掉
#: （实测：带内联代码的表格单元格全变空）。
_INLINE_TAGS = frozenset("a span code strong em b i u s sub sup mark small kbd".split())
#: 段落级容器：它们内部**不允许**出现块级元素，同样要降级处理。
_PARA_TAGS = frozenset("p h1 h2 h3 h4 h5 h6".split())
_BLOCK_TAGS = frozenset("""address article aside blockquote details div dl dt dd
fieldset figcaption figure footer form header hr li main nav
ol pre section table tbody td tfoot th thead tr ul""".split())

#: 原子标记。用 `⟦⟧`（U+27E6/U+27E7 数学白括号）是因为它不会被 lxml 清洗，
#: 也不会和正文撞——普通字母串（如 IMGATOM1）在讲代码的文章里真可能出现。
_ATOM_RE = re.compile(r"⟦(IMG|CODE)(\d+)⟧")

#: 漏在行内/行尾的围栏，如 `<li><p>正文</p><pre>` 被 trafilatura 序列化成
#: 「正文 ```」——围栏不在行首时 remark-gfm 不当它是代码块，**后面所有围栏的
#: 配对全部错位**（实测 30 个围栏里 1 个错位，后半篇代码块变成正文行、正文变成
#: 灰色代码卡）。这里把每一处三反引号都拆到独立行。
_FENCE_RUN_RE = re.compile(r"(`{3,})")
#: 围栏后的语言串（```python / ```c++ / ```.env），跟着围栏留在同一行。
_FENCE_INFO_RE = re.compile(r"[A-Za-z0-9_+#.\-]*")

#: CSDN/简书等站把「外链图片转存失败」的告警**包住真实图片地址**输出：
#: `[外链图片转存失败,…(img-x)([img]https://host/a.png[/img])]`。整行替换成图片。
_BROKEN_IMG_RE = re.compile(
    r"(?m)^[^\n]*?外链图片转存失败[^\n]*?(https?://[^\s\\\[\]\)\}]+)[^\n]*$")

#: 明显是站点零件而非正文配图的图片：图标 / 头像 / 分享按钮 / 默认占位图。
_UI_IMG_RE = re.compile(r"(icon|logo|avatar|emoji|arrow|share|publish|qrcode"
                        r"|default_secret|default_content|blank|spacer"
                        r"|close|nav_)", re.I)
#: UI 图片的 class 线索（`gaiu_img` 是评论/作者头像，`nav_logo` 是站标）。
_UI_IMG_CLS_RE = re.compile(r"(logo|icon|avatar|close|share|nav_|gaiu|emoji)", re.I)

#: 小于这个宽度的图片是图标，不是配图。
_MIN_IMG_WIDTH = 48


def _clean_inline(text: str) -> str:
    return re.sub(r"[ \t\r\n]+", " ", (text or "").replace("\u200b", " ")
                  .replace("\xa0", " ")).strip()


def _is_ui_image(img) -> bool:
    """判定这张 `<img>` 是不是站点零件（站标/头像/分享按钮/占位图）。

    只看 src 不可靠：媒体站的图片和头像常在同一存储路径下（实测先知社区的正文图
    与默认头像都是 `/api/v2/files/<uuid>`）。所以按「强信号优先」判：

    1. `ne-image` class（语雀系正文配图专用）→ **一定是正文图**；
    2. class / src 命中 UI 关键词 → 零件；
    3. 有 alt 或有宽度 → 正文图（通用站点的配图几乎都带 alt）；
    4. 全无 → 零件（无 class / 无 alt / 无宽度的图九成是装饰）。
    """
    if "ne-image" in (img.get("class") or ""):
        return False
    if _UI_IMG_CLS_RE.search(img.get("class") or ""):
        return True
    if _UI_IMG_RE.search(img.get("src") or ""):
        return True
    width = (img.get("width") or "").strip()
    if width:
        try:
            return float(width) < _MIN_IMG_WIDTH
        except ValueError:
            pass
    return not (img.get("alt") or "").strip()


def _code_from_card(card) -> tuple[str, str]:
    """从代码块卡片里取 (语言, 代码原文)。

    CodeMirror 把代码按行放在 `.cm-line` 里，行号在 `.cm-gutters`（旁边，不在
    内部），所以按 `.cm-line` 取不会带上行号。未挂载的虚拟占位卡只有高度没有
    内容，这里返回空串，调用方据此丢弃。
    """
    lang = ""
    mode = card.xpath(".//*[@data-codeblock-mode]")
    if mode:
        lang = (mode[0].get("data-codeblock-mode") or "").strip()
    holder = card.xpath('.//*[contains(@class,"cm-content")]')
    if not holder:
        return lang, ""
    if not lang:
        lang = (holder[0].get("data-language") or "").strip()
    lines = [_clean_inline(ln.text_content().replace("\u200b", "").rstrip())
             for ln in holder[0].xpath('.//div[contains(@class,"cm-line")]')]
    # 行首缩进是代码语义，_clean_inline 会吃掉，所以这里用原始文本重取
    lines = [ln.text_content().replace("\u200b", "").replace("\xa0", " ")
             for ln in holder[0].xpath('.//div[contains(@class,"cm-line")]')]
    return lang, "\n".join(ln.rstrip() for ln in lines).rstrip("\n")


def _drop_keep_structure(el) -> None:
    """删掉一个元素，并向上清掉因这次删除而变空的纯容器。

    两个必须踩住的坑（都实测踩过）：
    1. **判空要看后代文字**，不能只看直接子节点——正文容器（`<div class=body>`
       里套着若干 `<p>`）在删掉唯一一张图后会被误判成空壳，整篇正文连带被删，
       最终 HTML 变成 `<html></html>`、提取结果为空。
    2. **清完一层就要换到它的父节点**（`cur = up`）。写成 `parent = up` 会让
       循环反复检查同一个节点，一路把祖先链全删掉。
    """
    parent = el.getparent()
    if parent is None:
        return
    parent.remove(el)
    cur = parent
    for _ in range(3):
        if cur is None or cur.tag not in ("div", "span", "figure", "p"):
            return
        if len(cur) or _clean_inline(cur.text_content()) != "":
            return
        up = cur.getparent()
        if up is None:
            return
        up.remove(cur)
        cur = up


def _unwrap_inline_blocks(doc) -> int:
    """把「块级元素被塞进行内/段落容器」的结构降级为行内元素，返回处理次数。

    典型来源：编辑器用 `<ne-code><ne-code-content><ne-text>dumpd()</ne-text>` 表示
    **行内代码**。这些私有标签去掉 `ne-` 前缀后，`ne-code` → `code`（行内），
    但 `ne-code-content` 不是标准标签 → 落到 `div`（块级），于是变成
    `<p>…（<code><div>dumpd()</div></code>）…</p>` —— `<div>` 套在 `<p>` 里，
    HTML 解析器与 trafilatura 都会在 `<p>` 处收尾，**后半段整句消失**
    （实测「合法的序列化器（」之后全丢）。

    行内代码本来就该是行内的，所以把这类块级元素一律降级成 `<span>` 保留文字与
    层级，而不是拆开重排。
    """
    n = 0
    for el in doc.iter():
        tag = el.tag if isinstance(el.tag, str) else ""
        if tag not in _INLINE_TAGS and tag not in _PARA_TAGS:
            continue
        for child in el:
            if isinstance(child.tag, str) and child.tag in _BLOCK_TAGS:
                child.tag = "span"
                n += 1
    return n


def _flatten_headings(doc) -> int:
    """把 `h1~h6` 压成纯文本，返回处理个数。

    **实测根因**（2026-10-27，CSDN 那篇内核 pwn）：trafilatura 的 markdown 序列化
    器只读标题元素的 **`.text`**，不看子节点也不看 tail。而 CSDN/WordPress/SMZ 系
    的标题一律长这样：

    ```html
    <h2><a id="0x03__186"></a>0x03 环境利用</h2>
    ```

    文字全在**空锚点的 tail** 上 → 标题被输出成 `## `（空标题）。30 条标题全空，
    前端大纲自然一条都没有（`extractHeadings` 会跳过空 slug）。压平成纯文本后
    标题文字回到 `h2.text`，问题消失。

    标题里的链接/锚点本来就只是跳转装饰，压平不损失任何正文语义。
    """
    n = 0
    for h in doc.xpath("//h1|//h2|//h3|//h4|//h5|//h6"):
        text = _clean_inline("".join(h.itertext()))
        if not text:
            continue
        if len(h) == 0 and (h.text or "") == text:
            continue
        had_children = len(h) > 0
        for child in list(h):
            h.remove(child)
        h.text = text
        n += 1 if had_children else 0
    return n


def _ensure_semantic_body(doc) -> str:
    """给正文补一个语义容器（`<article>`），返回实际做法（便于测试与日志）。

    trafilatura 只在 `<article>`/`<main>` 这类语义容器里把 `<h2>` 输出成 Markdown
    标题，否则标题会被当成普通段落——**大纲就永远是空的**。实测两个站：

    - 语雀系（先知社区）：正文包在 `<div class="ne-viewer-body">` → 按 class 认；
    - PortSwigger：整页没有 article/main，正文 div 也没有可辨认的 class
      （实测 9 个 h2、33 个 h3，提取结果里标题数为 0）。

    所以三级兜底：已有语义容器 → 不动；class 命中 → 改名；都没有 → 把
    「文字最多的那个大块」当正文容器。第三级只认 body 下三层内的候选，
    避免在几十万节点的页面上做全量文本统计。
    """
    if doc.xpath("//article") or doc.xpath("//main"):
        return "exists"
    for el in doc.xpath("//div[@class]"):
        if _BODY_CLASS_RE.search(el.get("class") or ""):
            el.tag = "article"
            return "class"
    best, best_len = None, 0
    for el in doc.xpath("//body/div | //body/section | //body/div/div | //body/div/section"):
        if el.tag in ("nav", "header", "footer", "aside"):
            continue
        # 块里得有标题才值得标成正文容器：没有 h1~h3 的页面（实测 xlab 的
        # 文章一个 h2/h3 都没有）改了也没用，白白改动提取路径
        if not el.xpath(".//h1|.//h2|.//h3"):
            continue
        n = sum(len(t) for t in el.itertext())
        if n > best_len:
            best, best_len = el, n
    if best is not None and best_len >= MIN_CONTENT_CHARS:
        best.tag = "article"
        return "largest"
    return "none"


def normalize_ui_html(raw: str) -> tuple[str, list[dict]]:
    """把富文本编辑器的私有结构改写成标准 HTML，返回 (html, 原子资产表)。

    只做「等价替换」，不改正文内容与顺序：trafilatura 拿到的仍是完整页面，
    它该丢的导航/页脚照旧会丢。资产表记录图片与代码块的内容，供后面把
    原子标记还原成 Markdown。
    """
    try:
        from lxml import etree, html as LH
    except ImportError:                 # lxml 缺席时退化为原样（不影响主流程）
        return raw, []
    try:
        doc = LH.fromstring(raw)
    except Exception:                   # noqa: BLE001 —— 畸形 HTML 不该炸掉阅读
        log.debug("HTML 解析失败，跳过归一化", exc_info=True)
        return raw, []

    assets: list[dict] = []

    # ---- 1) 代码块：CodeMirror 结构 → 原子标记 ----
    for card in doc.xpath('//*[@data-card-name="codeblock"]'):
        lang, code = _code_from_card(card)
        parent = card.getparent()
        if parent is None:
            continue
        if not code.strip():
            # 虚拟列表的空占位（只有 height 的 div）。留着会在正文里变成空行，
            # 直接摘掉；真正的代码靠渲染层滚动后重新取。
            parent.remove(card)
            continue
        atom = f"⟦CODE{len(assets)}⟧"
        assets.append({"kind": "code", "lang": lang, "text": code})
        holder = etree.Element("p")
        holder.text = atom
        parent.replace(card, holder)

    # ---- 2) 私有标签 → 标准标签 ----
    for el in doc.iter():
        tag = el.tag
        if not isinstance(tag, str) or not tag.startswith("ne-"):
            continue
        alias = _TAG_ALIASES.get(tag)
        if alias:
            el.tag = alias
            continue
        bare = tag[3:]
        el.tag = bare if bare in _HTML_TAGS else "div"

    # ---- 2.5) 内联元素里套块级元素的结构解开（否则表格单元格内容会被丢）----
    _unwrap_inline_blocks(doc)

    # ---- 2.6) 正文容器补语义：`<div class=ne-viewer-body>` → `<article>` ----
    # trafilatura 只在 `<article>`/`<main>` 语义容器里把 `<h2>` 当标题输出；
    # 富文本编辑器与不少技术站把整篇包在普通 div 里，标题就全被当成正文段落
    # （大纲空）。三级兜底见 `_ensure_semantic_body`。
    _ensure_semantic_body(doc)

    # ---- 2.7) 标题压平成纯文本：`<h2><a id="x"></a>标题</h2>` 的文字在 tail 上，
    #      trafilatura 只读 `.text` → 输出空标题 `## `（大纲一条都没有）----
    _flatten_headings(doc)

    # ---- 3) 正文配图 → 原子标记；站点零件图片直接删 ----
    # 原子必须落在 `<p>` 里：trafilatura 的块级清洗会把「只有几个字符的 div」
    # 当噪声整块丢掉（实测 span/div/figure 里的原子 0 保留，放 `<p>` 里 100% 保留）。
    for img in list(doc.xpath("//img")):
        parent = img.getparent()
        if parent is None:
            continue
        src = (img.get("src") or "").strip()
        if not src or src.startswith("data:") or _is_ui_image(img):
            _drop_keep_structure(img)
            continue
        atom = f"⟦IMG{len(assets)}⟧"
        assets.append({"kind": "img", "src": src,
                       "alt": _clean_inline(img.get("alt") or "")})
        holder = etree.Element("p")
        holder.text = atom
        parent.replace(img, holder)

    # ---- 4) 去 UI 噪声（行号栏/光标层/折叠箭头/复制按钮）----
    for pat in _NOISE_CLASS:
        for el in doc.xpath(f'//*[contains(@class,"{pat}")]'):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)

    try:
        return LH.tostring(doc, encoding="unicode"), assets
    except Exception:                   # noqa: BLE001
        return raw, []


def restore_atoms(markdown: str, assets: list[dict], *, plain: bool = False) -> str:
    """把原子标记换成真正的 Markdown（`plain=True` 时换成纯文本，供 AI 上下文用）。

    代码块包成围栏并带语言：语雀把语言写在 `data-codeblock-mode`，trafilatura
    不认这个属性，只能在这里补回来，否则前端没有语法高亮。
    """
    if not markdown or not assets:
        return markdown

    def _one(m: re.Match) -> str:
        kind, idx = m.group(1), int(m.group(2))
        if idx >= len(assets):
            return ""
        item = assets[idx]
        if item["kind"] == "code":
            code = item["text"]
            if plain:
                return f"\n{code}\n"
            lang = item.get("lang") or ""
            # 代码里若本身含 ``` 会提前闭合围栏 → 用更长的围栏包
            fence = "````" if "```" in code else "```"
            return f"\n\n{fence}{lang}\n{code}\n{fence}\n\n"
        alt = item.get("alt") or ""
        if plain:
            return f"\n[图片{('：' + alt) if alt else ''}]\n"
        return f"\n\n![{alt}]({item['src']})\n\n"

    return _ATOM_RE.sub(_one, markdown)


#: GFM 分隔行的合法形态（`|---|---|` / `| :-- | --: |`）。
_TABLE_SEP_RE = re.compile(r"^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$")


def fix_fences(markdown: str) -> str:
    """把不在行首的围栏拆到独立行，并补平到最后未闭合的围栏。

    **实测根因**（2026-10-27，CSDN 内核 pwn 那篇）：trafilatura 处理
    `<li><p>正文</p><pre><code>…</code></pre></li>` 时，把 pre 的围栏直接拼在
    段落行尾，得到 `…出现的文件 ```。remark-gfm 要求围栏必须从行首开始，于是
    这一处围栏变成行内代码，**后面 28 个围栏的奇偶全部反转**：真正的代码块被当成
    正文（每行一个段落、行间大空隙），真正的正文被当成代码（整段套灰卡）。用户看到
    的就是「排版全乱」。

    三个必须踩住的点（都实测踩过）：

    1. **围栏内的行一律不动**：代码里写 ``print('```')`` 是常态，一律拆分会把
       代码切断（````…```` 包住的块正是为此存在）。
    2. **语言串跟着围栏走**：``… 末尾 ```python`` 要拆成 ``… 末尾`` + ```python``，
       不能把语言后缀甩成单独一行。
    3. **配对要按 CommonMark 走**：闭合围栏不短于开启围栏才算闭合。只数「围栏行数
       奇偶」两头都会错——带语言的开启围栏数不进去，长围栏块内部的 ``` 反而数进去
       了（实测给先知社区那篇**凭空补了一个 ```** 在文末）。
    """
    if "`" not in markdown:
        return markdown
    lines: list[str] = []
    open_len = 0
    for raw in markdown.split("\n"):
        s = raw.lstrip()
        m = _FENCE_RUN_RE.match(s)
        if m:
            n = len(m.group(1))
            rest = s[n:].strip()
            if not open_len:
                open_len = n            # 开启：允许带语言串
            elif n >= open_len and not rest:
                open_len = 0            # 闭合：必须不短于开启围栏、且后面没别的字
            lines.append(raw.rstrip())
            continue
        if open_len:
            lines.append(raw.rstrip())  # 围栏内部：一个字都不动
            continue
        line, pieces = raw, []
        while True:
            hit = _FENCE_RUN_RE.search(line)
            if hit is None:
                break
            head, fence, rest = line[:hit.start()], hit.group(1), line[hit.end():]
            if head.strip():
                pieces.append(head.strip())
            info = _FENCE_INFO_RE.match(rest).group(0)
            pieces.append(fence + info)
            line = rest[len(info):]
            open_len = len(fence)       # 拆出来的围栏自此开启，后续行当代码内容
        if not pieces:
            lines.append(raw)
            continue
        if line.strip():
            pieces.append(line.strip())
        lines.extend(pieces)

    # 落单的围栏：在文末补一个闭合，别让最后一整段都被当成代码（比「截断」更伤，
    # 用户会以为全文到这儿就没了）。
    if open_len:
        lines.append("`" * max(3, open_len))
    return "\n".join(lines)


def recover_broken_images(markdown: str) -> str:
    """把「外链图片转存失败」告警行还原成图片，否则整篇一张图都没有。

    **实测根因**：CSDN 对防盗链外链图不渲染 `<img>`，而是输出一段告警文本，真实
    地址藏在文本里（`([img]https://…[/img])`）。于是归一化阶段根本找不到 `<img>`
    可原子化，正文 19 张配图全丢——用户只能看到 19 行"转存失败"。
    """
    if "外链图片转存失败" not in markdown:
        return markdown

    def _one(m: re.Match) -> str:
        url = m.group(1).rstrip(").,;")
        return f"![图片]({url})"

    return _BROKEN_IMG_RE.sub(_one, markdown)


def fix_tables(markdown: str) -> str:
    """给缺表头的表格补 GFM 分隔行。

    **实测根因**（2026-10-27）：trafilatura 只把带 `<th>` 的表格转成完整 GFM；
    表格若全是 `<td>`（语雀、飞书、多数 CMS 的「无表头表格」都这样），它照样输出
    `| a | b |` 行，但**不输出 `|---|` 分隔行**——而 remark-gfm 必须靠分隔行
    才能识别表格。于是前端把整张表渲染成一串带竖线的普通段落。
    这里按列数补一行分隔行，不动任何单元格内容。
    """
    if "|" not in markdown:
        return markdown
    lines = markdown.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        if not lines[i].lstrip().startswith("|"):
            out.append(lines[i])
            i += 1
            continue
        j = i
        while j < len(lines) and lines[j].lstrip().startswith("|"):
            j += 1
        block = lines[i:j]
        # 已有分隔行（trafilatura 对带 th 的表格会输出）就别重复插
        if len(block) >= 2 and _TABLE_SEP_RE.match(block[1]):
            out.extend(block)
        else:
            ncols = max(1, block[0].strip().strip("|").count("|") + 1)
            sep = "|" + "|".join([" --- "] * ncols) + "|"
            out.append(block[0])
            out.append(sep)
            out.extend(block[1:])
        i = j
    return "\n".join(out)


def tidy_markdown(markdown: str) -> str:
    """收尾清理：压掉多余空行与行尾空格，避免前端出现大片空白。"""
    if not markdown:
        return ""
    md = re.sub(r"[ \t]+\n", "\n", markdown)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip()


# ---------- 主流程 ----------

#: 一个 Markdown 标题行（`## 标题`）。用来量「结构完整度」。
_HEADING_RE = re.compile(r"(?m)^#{1,6} \S")


def _pick_richer(md_a: str, txt_a: str, md_b: str, txt_b: str) -> tuple[str, str]:
    """在 precision / recall 两档结果里挑「结构更完整」的那份。

    **实测根因**（2026-10-27）：`favor_precision` 会把**短文本块**当样板文字丢掉，
    而段落小标题往往正好很短、又没有句号——于是整篇的 `<h2>`/`<h3>` 全被删掉，
    正文还在、大纲却空了。实测三站：

    | 站点 | precision 标题数 | recall 标题数 | 正文长度差 |
    |---|--:|--:|--:|
    | CSDN 内核 pwn | 1 | 30 | 21820 → 22010 |
    | PortSwigger | 3 | 37 | 45025 → 46393 |
    | 安全客 | 9 | 9 | 4486 → 5320 |

    recall 档也有代价：导航/推荐位会多进来一些（安全客 +834 字）。所以只在
    「标题更多 **且** 长度没明显增加」时才换——多条导航的体量远超 10%。
    """
    ha, hb = len(_HEADING_RE.findall(md_a)), len(_HEADING_RE.findall(md_b))
    if hb > ha and len(txt_b) <= len(txt_a) * 1.10 + 300:
        return md_b, txt_b
    return md_a, txt_a


def _extract(html: str, url: str) -> tuple[str, str, dict]:
    """HTML → (markdown, plain_text, metadata)。trafilatura 缺席时降级为标签剥离。

    **两级提取**（实测 2026-10-27，两个方向都会踩）：

    - 只用默认平衡档：PortSwigger Research 会把整条顶部产品导航（Burp Scanner /
      Product comparison / Downloads…）当成正文前置段落塞进开头；
    - 只用 `favor_precision`：先知社区（xz.aliyun.com）直接提到 0 字——它的正文
      容器被判成可疑块，precision 全丢。

    故先 precision（拿干净的），**短到不合格再用 recall 重试**（拿全的）。这样
    大多数站点得到无导航的正文，而 precision 过严的站点也不会变成空白页。
    """
    try:
        from trafilatura import extract, extract_metadata
    except ImportError:                      # 依赖缺失不该让整个情报页 500
        md = _fallback_extract(html)
        return md, _strip_tags(md), {}

    # 富文本编辑器的私有标签先改写成标准标签，否则标题/表格/代码块/配图全丢
    # （实测：语雀系文章归一化前 H=0/IMG=0/FENCE=0，之后 H=31/IMG=7/FENCE=20）
    shaped, assets = normalize_ui_html(html)

    base = dict(include_links=True, include_images=True,
                include_tables=True, include_formatting=True, deduplicate=True)

    def _one(fmt: str, **kw) -> str:
        return extract(shaped, url=url, output_format=fmt, **kw) or ""

    md = _one("markdown", favor_precision=True, **base)
    text = _one("txt", include_tables=True, favor_precision=True)
    # 两档都跑：precision 干净但会丢短标题（大纲空），recall 结构全但会带点导航。
    # 取舍规则见 `_pick_richer`。
    md2 = _one("markdown", favor_recall=True, **base)
    text2 = _one("txt", include_tables=True, favor_recall=True)
    md, text = _pick_richer(md, text, md2, text2)
    if len(text) < MIN_CONTENT_CHARS and len(text2) > len(text):
        # precision 过严到正文都没了（先知社区实测 0 字）→ 无条件用 recall 档
        md, text = md2, text2

    # 原子标记还原成真正的 Markdown 语法；表格补 GFM 分隔行。
    # 纯文本侧用 `plain=True`：代码块给原文（AI 要读代码），图片给占位说明。
    md = tidy_markdown(fix_fences(recover_broken_images(
        fix_tables(restore_atoms(md, assets)))))
    text = tidy_markdown(fix_tables(restore_atoms(text, assets, plain=True)))
    if not text:
        text = _strip_tags(md)

    meta: dict = {}
    try:
        doc = extract_metadata(html, default_url=url)
        if doc is not None:
            meta = {"title": (doc.title or "").strip(),
                    "author": (doc.author or "").strip(),
                    "date": (doc.date or "").strip(),
                    "sitename": (doc.sitename or "").strip()}
    except Exception:                        # noqa: BLE001 —— 元数据拿不到不影响正文
        log.debug("trafilatura 元数据提取失败 %s", url, exc_info=True)
    return md, (text or _strip_tags(md)), meta


def _strip_tags(html: str) -> str:
    text = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html or "")
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
    return re.sub(r"[ \t\u00a0]+", " ", re.sub(r"\n{3,}", "\n\n", text)).strip()


def _fallback_extract(html: str) -> str:
    """trafilatura 缺席时的最低可用路径：剥掉脚本/样式后整页转文本。

    质量明显不如 trafilatura（导航、页脚都在），但**不会什么都不给**。
    """
    body = re.sub(r"(?is)<(script|style|nav|footer|aside)[^>]*>.*?</\1>", " ", html or "")
    m = re.search(r"(?is)<article[^>]*>(.*?)</article>", body)
    if not m:
        m = re.search(r"(?is)<main[^>]*>(.*?)</main>", body)
    return _strip_tags(m.group(1) if m else body)


def read_article(url: str, *,
                 fetch: Callable[[str], tuple[int, str, str]] | None = None,
                 render: Callable[[str], tuple[str, str]] | None = None,
                 allow_render: bool = True) -> ReadResult:
    """URL → 干净正文。两层策略见模块 docstring。

    `fetch` / `render` 可注入（测试永不触网）；`allow_render=False` 时只走
    HTTP 层（测试与「已知需要浏览器」的快速路径）。
    """
    normalized = normalize_url(url)
    if not normalized:
        return ReadResult(url=str(url or ""), engine="failed", status="failed",
                          errors=["只支持 http/https 链接"])

    result = ReadResult(url=normalized, final_url=normalized)
    fetch = fetch or default_fetch
    # 端到端预算：渲染兜底只在还有时间的情况下才做。网络层卡死的耗时不可控
    # （实测 GitHub 某代理下 fetch + render 串起来 42 秒），超预算就不再叠加。
    started = time.monotonic()

    status, html, final_url = 0, "", normalized
    try:
        status, html, final_url = fetch(normalized)
    except urllib.error.HTTPError as e:
        result.errors.append(f"HTTP {e.code}")
    except urllib.error.URLError as e:
        result.errors.append(f"网络错误：{getattr(e, 'reason', e)}")
    except Exception as e:                    # noqa: BLE001
        result.errors.append(f"{type(e).__name__}: {e}")
    else:
        result.final_url = final_url or normalized
        if status >= 400:
            result.errors.append(f"HTTP {status}")

    md = text = ""
    meta: dict = {}
    if html:
        md, text, meta = _extract(html, result.final_url)
        result.engine = "http"

    waf = waf_marker_hit(html, text) if html else ""
    # 交互式挑战：渲染也过不去，**跳过兜底**把失败立刻说清楚（省 20 秒干等）
    challenge = hard_challenge_hit(html, text) if html else ""
    if challenge:
        result.warnings.append(f"站点要求交互式验证（{challenge}），无头渲染无法通过")
    elif waf:
        result.warnings.append(f"页面命中验证/风控特征（{waf}）")

    elapsed = time.monotonic() - started
    out_of_budget = elapsed >= TOTAL_BUDGET_S
    if out_of_budget:
        result.warnings.append(f"抓取已耗时 {elapsed:.0f} 秒，跳过渲染兜底")

    # ---- 渲染兜底：正文不足或命中风控（交互式挑战、已超预算时不试）----
    need_render = (allow_render and not challenge and not out_of_budget
                   and (len(text) < MIN_CONTENT_CHARS or bool(waf)))
    if need_render:
        render = render or default_render
        try:
            rhtml, rfinal = render(result.final_url)
        except Exception as e:                # noqa: BLE001 —— 兜底失败就按已有结果判
            rhtml = ""
            result.errors.append(f"浏览器渲染失败：{type(e).__name__}: {e}")
        else:
            if rhtml:
                rmd, rtext, rmeta = _extract(rhtml, rfinal or result.final_url)
                if len(rtext) > len(text):
                    md, text, meta = rmd, rtext, rmeta
                    result.engine = "render"
                    result.final_url = rfinal or result.final_url
                    # **重新判定**渲染后的页面是否仍是风控页（FreeBuf 渲染后
                    # 仍是阿里云滑块，只清旧告警就等于把验证页当正文交付）。
                    # 正文一并传进去：软特征（极验登录组件）只有正文不足时才算数。
                    rwaf = waf_marker_hit(rhtml, text)
                    result.warnings = []
                    if rwaf:
                        waf = rwaf
                        result.warnings.append(f"页面仍停在验证页（{rwaf}）")
                    else:
                        waf = ""

    # ---- 落库前的收尾 ----
    result.markdown = absolutize_links(md or "", result.final_url)
    result.text = text or ""
    result.chars = len(result.text)
    result.title = (meta.get("title") or html_title(html) or "").strip()
    result.author = meta.get("author", "")
    result.published = meta.get("date", "")
    result.site = meta.get("sitename", "")

    # **WAF 优先于字数**：验证页往往有几百字（滑块说明、错误提示），按字数会
    # 被判成 partial 交付给用户 —— 实测 FreeBuf 渲染后 474 字全是 `CF_APP_WAF`
    # 脚本片段。命中风控就只能是 failed，别让「有几个字」掩盖「根本不是正文」。
    if waf or challenge:
        result.status = "failed"
        if not result.errors:
            result.errors.append(
                "站点要求交互式验证（滑块/人机验证），无法自动读取；"
                "请用「浏览器打开原文」" if challenge else
                "站点启用了人机验证/风控，无法直接读取正文")
        # 已知站点给可执行建议（知乎：点「一键登录」扫码即可复用登录态）。
        # 放在 errors 而不是 warnings：errors 是前端显示失败原因的那一栏，
        # 「怎么解决」必须和「为什么失败」出现在同一处。
        # 站点标识同时写进 login_hint —— 前端按**结构化字段**显示登录按钮，
        # 不解析这段文案（改字不会让按钮消失）。
        site = ""
        advice = ""
        if html:
            site, advice = site_advice(html)
        if not site and need_render and rhtml:
            site, advice = site_advice(rhtml)
        if advice and advice not in result.errors:
            result.errors.append(advice)
        if site:
            result.login_hint = site
    elif result.chars >= MIN_CONTENT_CHARS:
        result.status = "ok"
    elif result.chars >= FAIL_CONTENT_CHARS:
        result.status = "partial"
        if login_wall_hit(result.text):
            result.warnings.append("疑似登录墙，正文可能被截断")
        else:
            result.warnings.append("正文较短，可能未取到全文")
    else:
        result.status = "failed"
        if not result.errors:
            result.errors.append("未提取到正文（可能是纯前端页面或登录墙）")
    if not result.title:
        result.title = result.final_url
    # 40362 是这次文章请求被拒绝，不足以证明账号全局登出；保留已验证 profile，
    # 下一篇仍可继续用它，错误文案说明文章级风控/权限等可能性。
    return result


def build_ai_context(result: ReadResult, *, max_chars: int = 24000) -> str:
    """把文章压成给 AI 的上下文。

    **必须有上限**：技术长文动辄 5 万字，直接塞会把上下文吃满，且首尾才是有用
    信息。策略=保留开头（背景/结论通常在前面）与结尾（总结），中间按比例截断并
    显式标注——**绝不静默丢内容**，模型要知道「这里被剪过」才不会瞎猜。
    """
    text = (result.text or "").strip()
    if len(text) <= max_chars:
        return text
    head_len = int(max_chars * 0.72)
    tail_len = max_chars - head_len
    head = text[:head_len]
    tail = text[-tail_len:] if tail_len > 0 else ""
    dropped = len(text) - head_len - tail_len
    return f"{head}\n\n……（此处省略约 {dropped} 字，原文共 {len(text)} 字）……\n\n{tail}"
