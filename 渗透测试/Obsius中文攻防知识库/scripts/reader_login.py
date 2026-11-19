"""阅读器登录态采集（2026-10-29）：人工登录一次，之后阅读器自动复用。

**核心逻辑在 `core/intel/reader.py` 的 `run_login_flow`**——API 的「一键登录」
Job 与本脚本共用同一份判定与落盘逻辑。浏览器关闭后会重开持久 profile，调用知乎
认证接口验证用户；只有认证通过才写 ready 标记。Cookie 保留在 Chromium profile，
不会另存明文文件。这里只是命令行壳：解析参数 + 打印进度。

**为什么必须有这一步**：知乎专栏对未登录请求一律返回 `code 40362`。实测
「有头真实 Chrome + 持久 profile + 自然点击路径」都拦——只有带登录态才放行。

用法::

    E:/Miniconda3/python.exe scripts/reader_login.py            # 登录知乎
    E:/Miniconda3/python.exe scripts/reader_login.py --check    # 只看登录态
    E:/Miniconda3/python.exe scripts/reader_login.py --logout   # 清掉登录态

界面上的「一键登录」按钮走的是同一套逻辑（`POST /api/intel/read/login`）。

数据落在 `data/browser/`（运行数据归口 data/）：
- `reader-profile/` 浏览器 profile 本体（含 cookie）
- `reader-profile.ready` 开关文件；**存在**才启用持久 profile
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core.intel.reader import (          # noqa: E402
    LOGIN_COOKIE_BY_DOMAIN, LOGIN_ORIGIN, READER_PROFILE_DIR,
    READER_PROFILE_ENABLED, _verify_zhihu_login,
    profile_locked, reader_profile_channel, reader_profile_ready, run_login_flow,
)


def report_profile_location() -> None:
    """Show the canonical profile and any cwd-relative legacy location, read-only."""
    canonical = Path(READER_PROFILE_DIR).resolve()
    cwd_candidate = (Path.cwd() / "data" / "browser" / "reader-profile").resolve()
    print(f"[profile] {canonical}")
    print(f"[channel] {reader_profile_channel()}")
    if cwd_candidate != canonical and cwd_candidate.is_dir():
        print(f"[发现旧位置] {cwd_candidate}（未读取、未迁移）")


async def cmd_check() -> int:
    """只读检查：分别报告登录 cookie 与知乎在线认证状态。"""
    report_profile_location()
    if not Path(READER_PROFILE_DIR).is_dir():
        print(f"[未登录] 还没有 profile 目录：{READER_PROFILE_DIR}")
        print("         运行 `python scripts/reader_login.py`，或在阅读器失败提示里点「一键登录」。")
        return 1
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        try:
            kwargs = {
                "headless": True, "locale": "zh-CN",
                "ignore_https_errors": True,
            }
            if reader_profile_channel() == "chrome":
                kwargs["channel"] = "chrome"
            ctx = await pw.chromium.launch_persistent_context(
                READER_PROFILE_DIR, **kwargs)
        except Exception as e:                      # noqa: BLE001
            print(f"[不可用] profile 打不开：{type(e).__name__}: {e}")
            return 1
        try:
            enabled = Path(READER_PROFILE_ENABLED).exists()
            verified = await _verify_zhihu_login(ctx)
            cookies = await ctx.cookies(LOGIN_ORIGIN)
            cookies_found = True
            print(f"[开关]   {Path(READER_PROFILE_ENABLED).resolve()} → {'存在（已启用）' if enabled else '不存在（未启用）'}")
            for domain, name in sorted(LOGIN_COOKIE_BY_DOMAIN.items()):
                found = any(c.get("name") == name and c.get("value") for c in cookies)
                cookies_found = cookies_found and found
                print(f"[Cookie] {domain} 的 {name} → {'存在' if found else '不存在'}")
            print(f"[知乎认证] {'通过' if verified else '未通过'}")
            return 0 if reader_profile_ready() and enabled and cookies_found and verified else 1
        finally:
            await ctx.close()


def cmd_login() -> int:
    report_profile_location()
    if profile_locked():
        print(f"[占用] {READER_PROFILE_DIR} 正被另一进程持有（可能有文章正在读）。")
        print("       等几秒后重试；或先停掉平台再运行本脚本。")
        return 2

    print()
    print("=" * 66)
    print("  请在弹出的浏览器窗口里登录（扫码 / 手机号 / 密码均可）")
    print("  登录成功后无需操作，脚本会自动检测并保存。")
    print("=" * 66)
    print()

    result = asyncio.run(run_login_flow(headless=False, progress=print))
    if not result["ok"]:
        print(f"\n[失败] {result['reason']}")
        print(f"[profile] {result['profile_dir']}")
        print(f"[channel] {result['channel']}")
        print(f"[重开验证] cookie={'存在' if result['cookie_persisted'] else '不存在'}；"
              f"知乎认证={'通过' if result['verified'] else '未通过'}")
        return 1
    print(f"\n[成功] 已保存登录态（{result['cookies']} 个 cookie）")
    print(f"[profile] {result['profile_dir']}")
    print(f"[channel] {result['channel']}")
    print(f"[重开验证] cookie={'存在' if result['cookie_persisted'] else '不存在'}；"
          f"知乎认证={'通过' if result['verified'] else '未通过'}")
    print(f"[启用] 已写开关 {Path(READER_PROFILE_ENABLED).resolve()}")
    print("       之后阅读器渲染会自动复用该登录态，无需再登录。")
    return 0


def cmd_logout() -> int:
    """删除登录态（profile + 开关）。"""
    removed = []
    if Path(READER_PROFILE_ENABLED).exists():
        Path(READER_PROFILE_ENABLED).unlink()
        removed.append("开关文件")
    if Path(READER_PROFILE_DIR).is_dir():
        if profile_locked():
            print(f"[占用] {READER_PROFILE_DIR} 正被占用，无法删除。先停平台再试。")
            return 2
        shutil.rmtree(READER_PROFILE_DIR, ignore_errors=True)
        removed.append("profile 目录")
    print("[完成] 已清除：" + ("、".join(removed) if removed else "本来就没有登录态"))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="阅读器登录态采集（知乎等需登录的站点）")
    ap.add_argument("--check", action="store_true", help="只检查登录态，不开窗口")
    ap.add_argument("--logout", action="store_true", help="清除已保存的登录态")
    args = ap.parse_args()
    if args.logout:
        return cmd_logout()
    if args.check:
        return asyncio.run(cmd_check())
    return cmd_login()


if __name__ == "__main__":
    raise SystemExit(main())
