"""危险命令静态规则库（2026-10-30，项目开发轨配套）。

供执行网关做「危险命令 → 一次性人工审批」闸门（DESIGN §7 执行网关新增防线）。
判据=静态正则，宁精勿泛：开发轨日常迭代（rm 单文件、rm -rf 工作区子目录、
git checkout 单文件、pip install、Remove-Item 相对路径清理）不该被误拦；
只拦**结构性破坏 / 不可逆 / 系统级**类命令。命中后不硬拒死路——网关自动
提交人工审批（approvals 表），人类批准后携带 approval_id 重试一次即消费。

诚实边界：PowerShell/bash 任意构造无法静态穷尽，本模块是**强护栏不是沙箱**
（与 pathguard 同一认知）；真文件系统边界由持久 workspace 容器承载。
"""

import re

# 规则：(id, 危险说明, 编译后正则)。匹配按序首中即返。
# 前缀边界统一吃 (^|[;\n|&(`])——防止多行命令/脚本正文里的字面量 rm 误触发。
_B = r"(^|[\s;|&(`])"
# 删除类规则的边界更严：rm 前是 echo/printf/print/cat 时只是字面量输出，
# 不是真删除（`echo rm -rf / | cat` 实测误报，2026-10-30）。lookbehind 必须
# 放在边界组**之后**（锚在 rm 起始位），才能看到边界字符本身（echo + 空白）。
_RM_B = r"(^|[\s;|&(`])(?<!echo\s)(?<!printf\s)(?<!print\s)(?<!cat\s)"

DANGER_RULES: list[tuple[str, str, re.Pattern]] = [
    # ---------- 递归删除根/家目录/盘符根 ----------
    ("rm-root",
     "递归删除根目录/家目录/盘符根（rm -rf /、rm -rf ~、rm -rf C:\\ 等）",
     re.compile(
         rf"{_RM_B}rm(?:dir)?\s+(?:-\S+\s+)*(?:-r[a-z0-9]*|-fr|[a-z0-9]*rf)\s+"
         rf"(/|\\|~/?|~/|\$HOME/?|%USERPROFILE%/?|[a-z]:[\\/])(\s*$|[\s;&|)`])",
         re.IGNORECASE)),
    ("rm-system-dir",
     "递归删除系统关键目录（/etc /usr /var /boot /bin /lib、C:\\Windows 等）",
     re.compile(
         rf"{_RM_B}rm(?:dir)?\s+(?:-\S+\s+)*(?:-r[a-z0-9]*|-fr|[a-z0-9]*rf)\s+"
         rf"(/etc|/usr|/var|/boot|/bin|/lib|/sbin|/sys|/proc|/dev|/System|/Library|"
         rf"[a-z]:[\\/](windows|program files( \(x86\))?))([\\/][^\s;|&]*)?(\s*$|[\s;&|)`])",
         re.IGNORECASE)),
    # ---------- PowerShell / cmd 递归删除盘符根 ----------
    ("ps-remove-root",
     "递归删除盘符根/系统目录（Remove-Item -Recurse C:\\、del /s /q C:\\Windows 等）",
     re.compile(
         rf"{_B}(remove-item|del|erase|rd)\s+(?=.*(recurse|\s*-r|\s*-s|/s|/q))(?=.*[a-z]:[\\/])"
         rf"(?:[-/]\S+\s+)*[a-z]:[\\/][^\s;|&`]*(\s*$|[\s;&|)`])",
         re.IGNORECASE | re.DOTALL)),
    # ---------- git 破坏性操作 ----------
    ("git-reset-hard",
     "git 硬重置丢弃工作区/暂存区全部改动（git reset --hard）",
     re.compile(rf"{_B}git\s+reset\s+(?:-\S+\s+)*(--hard|-h)", re.IGNORECASE)),
    ("git-clean-force",
     "git 强制清理未跟踪文件（git clean -f -d / -fd）",
     re.compile(rf"{_B}git\s+clean\s+(?=.*d)(?=.*f)(?:-\S+\s*)+",
                re.IGNORECASE | re.DOTALL)),
    ("git-checkout-discard",
     "git checkout/restore 丢弃全部改动（git checkout -- .、git restore . 等）",
     re.compile(
         rf"{_B}git\s+(checkout\s+(?:--\S+|\S+\s+)*--\s+(\.|/)|restore\s+(?:-\S+\s+)*\.)\s*$",
         re.IGNORECASE)),
    ("git-push-force",
     "git 强制推送覆盖远端历史（git push --force / -f / --force-with-lease）",
     re.compile(rf"{_B}git\s+push\s+(?:-\S+\s+)*(-f|--force|--force-with-lease)", re.IGNORECASE)),
    ("git-branch-delete",
     "git 强制删除分支（git branch -D）",
     re.compile(rf"{_B}git\s+branch\s+(?:-\S+\s+)*-D")),
    ("git-stash-drop",
     "git 丢弃 stash（git stash drop / clear）",
     re.compile(rf"{_B}git\s+stash\s+(drop|clear)", re.IGNORECASE)),
    # ---------- 系统控制 ----------
    ("system-shutdown",
     "关机/重启/停机（shutdown/reboot/halt/poweroff）",
     re.compile(
         rf"{_B}(shutdown|reboot|halt|poweroff)(\s+(?:-\S+\s*)*(?:now|/s|/r|/p|--now))?\s*$",
         re.IGNORECASE)),
    ("systemctl-stop",
     "停用系统服务（systemctl stop/disable/mask）",
     re.compile(rf"{_B}systemctl\s+(stop|disable|mask)\s+[a-z0-9_.-]+", re.IGNORECASE)),
    ("ps-computer-stop",
     "重启/停止计算机或服务（Restart-Computer/Stop-Computer/Stop-Service）",
     re.compile(rf"{_B}(restart-computer|stop-computer|stop-service)\s*(?:-\S+\s+)*",
                re.IGNORECASE)),
    # ---------- 数据库破坏 ----------
    ("db-drop",
     "删除数据库/表（DROP TABLE/DATABASE、TRUNCATE）",
     re.compile(rf"{_B}(drop|truncate)\s+(table|database)\s+[a-z0-9_.\"'`-]+", re.IGNORECASE)),
    ("db-delete-all",
     "无 WHERE 条件的 DELETE 全表（DELETE FROM ... 不带 WHERE）",
     re.compile(rf"{_B}delete\s+from\s+(?>[a-z0-9_.\"'`-]+)(?!\s+where)",
                re.IGNORECASE)),
    # ---------- 磁盘/文件系统 ----------
    ("format-drive",
     "格式化磁盘/建文件系统（format C: / mkfs / mkswap）",
     re.compile(rf"{_B}(format\s+[a-z]:[\\/]?|mkfs(?:\.\w+)?\s+|mkswap\s+)",
                re.IGNORECASE)),
    ("dd-device",
     "直接写块设备（dd if=... of=/dev/sdX 等）",
     re.compile(rf"\bdd\s+(?=[^;|&]*if=)(?=[^;|&]*of=/dev/)", re.IGNORECASE)),
    # ---------- 权限风暴 ----------
    ("chmod-root",
     "递归放开根/家目录权限（chmod -R 777 /、chown -R ... /）",
     re.compile(
         rf"{_B}(chmod|chown)\s+-r\s+(777|\S+)\s+"
         rf"(/|~/?|\$HOME|%USERPROFILE%|[a-z]:[\\/])(\s*$|[\s;&|)`])",
         re.IGNORECASE)),
    # ---------- 项目自身安全 ----------
    ("rm-git-dir",
     "删除 .git 目录（摧毁版本历史）",
     re.compile(rf"{_RM_B}rm\s+(?:-\S+\s+)*(?:\.git|\.git/?)\s*$", re.IGNORECASE)),
]


def check_dangerous(cmd: str) -> tuple[str, str] | None:
    """扫描命令是否命中危险规则。返回 (规则 id, 危险说明)；未命中返 None。

    首中即返（规则按危险程度排序，最该拦的排最前）。超长/空命令不做
    静态判定（宁可漏判不可误伤大段脚本——其写目标已被 pathguard 兜住）。
    """
    if not cmd or len(cmd) > 20000:
        return None
    for rid, desc, pat in DANGER_RULES:
        if pat.search(cmd):
            return rid, desc
    return None
