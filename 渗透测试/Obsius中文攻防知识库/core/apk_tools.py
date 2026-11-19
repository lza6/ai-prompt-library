"""固定的本机 APK 桌面分析器启动入口，不执行样本。"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path


APK_TOOLS = {
    "jeb": (Path("D:/Tools/JEB-5.40/bin/jeb.exe"), Path("D:/Tools/JEB-5.40")),
    "jadx": (Path("E:/Tools/jadx-gui-1.5.6-win/jadx-gui-1.5.6.exe"),
             Path("E:/Tools/jadx-gui-1.5.6-win")),
}


class ApkToolError(RuntimeError):
    pass


def launch_apk_tool(tool: str, apk: Path) -> int:
    if tool not in APK_TOOLS:
        raise ApkToolError("不支持的 APK 工具")
    if os.name != "nt":
        raise ApkToolError("APK 桌面工具仅支持 Windows 宿主机")
    executable, cwd = APK_TOOLS[tool]
    if not executable.is_file():
        raise ApkToolError(f"工具未安装：{executable}")
    try:
        process = subprocess.Popen(
            [str(executable), str(apk)], cwd=str(cwd), shell=False,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except OSError as exc:
        raise ApkToolError(f"启动 {tool} 失败：{exc}") from exc
    return process.pid
