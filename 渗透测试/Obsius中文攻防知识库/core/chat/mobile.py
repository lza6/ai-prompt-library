"""Short-lived, project-scoped desktop Android connection snapshots."""
from __future__ import annotations

import threading
import time
from typing import Any

_STATE_TTL_SECONDS = 18.0
_lock = threading.Lock()
_states: dict[str, dict[str, Any]] = {}


def update_mobile_state(project_id: str, *, connected: bool,
                        serial: str = "", model: str = "") -> dict[str, Any]:
    """Record a desktop-reported device state; serial is never exposed to prompts."""
    pid = str(project_id or "").strip()
    if not pid:
        raise ValueError("project_id is required")
    state = {
        "connected": bool(connected),
        "serial": str(serial or "").strip()[:128] if connected else "",
        "model": str(model or "").strip()[:80] if connected else "",
        "updated_at": time.monotonic(),
    }
    with _lock:
        _states[pid] = state
    return {"connected": state["connected"], "model": state["model"]}


def mobile_state_for(project_id: str, *, now: float | None = None) -> dict[str, Any] | None:
    """Return only a fresh connected snapshot, isolated to the requested project."""
    pid = str(project_id or "").strip()
    current = time.monotonic() if now is None else float(now)
    with _lock:
        state = _states.get(pid)
        if state is None:
            return None
        if current - float(state["updated_at"]) > _STATE_TTL_SECONDS:
            _states.pop(pid, None)
            return None
        if not state["connected"]:
            return None
        return {"connected": True, "model": state["model"]}


def mobile_prompt_context(project_id: str, *, now: float | None = None) -> str:
    state = mobile_state_for(project_id, now=now)
    if state is None:
        return ""
    model = state.get("model")
    suffix = f"（型号：{model}）" if model else ""
    return (
        "## Android 设备状态\n"
        f"桌面 ADB 已连接一台 Android 设备{suffix}。\n\n"
        "- adb 在宿主 PATH 中可用，用 run_cmd(runtime=\"host\") 直接调用，例如\n"
        "  run_cmd(\"adb devices -l\", runtime=\"host\")\n"
        "  run_cmd(\"adb shell pm list packages\", runtime=\"host\")\n"
        "- **调用前先 `adb devices -l` 确认设备在线**。只有一台设备时可省略 -s；"
        "多台设备必须带 `-s <序列号>`，否则 adb 报 more than one device。\n"
        "- 序列号**不在**本提示里，从 `adb devices -l` 的输出里取。\n\n"
        "**边界**：只操作已连接的这台设备。这是真人设备，相册、短信、登录态都在里面——"
        "不要 install/uninstall、pm clear、settings put、reboot、adb root，"
        "这类操作不可逆；确需装应用或清数据，先问人类。\n"
        "这是连接状态，不代表已确认设备上的应用、页面或数据状态。"
    )


def _clear_mobile_states_for_tests() -> None:
    with _lock:
        _states.clear()
