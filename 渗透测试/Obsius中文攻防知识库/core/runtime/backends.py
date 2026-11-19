"""执行后端：host / wsl / docker / sandbox 的命令执行实现。

统一约定：execute() 返回 (exit_code, stdout, stderr, timed_out)。
超时必须 kill（挂死的样本进程不允许遗留）。
■ 即点即停（2026-09-19）：execute 支持 abort_event（threading.Event）——
Popen 轮询等待，置位即杀进程树返回 interrupted，不等命令自然结束。
排水线程（2026-09-23）：stdout/stderr=PIPE 时由 `_execute_piped` 的 daemon
线程持续消费，防 64KB 管道缓冲写阻塞死锁（见 docs/plans/exec-gateway-pipe-deadlock.md）。
"""

import os
import platform
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any

#: 中断/超时轮询间隔（秒）——即 ■ 中断的最大响应延迟
POLL_INTERVAL = 0.2

# Windows 子进程统一隐藏窗口（2026-09-23）：窗口模式（pythonw/打包 exe）下父进程
# 无控制台可继承，不带标志则每条命令弹 PowerShell 窗；POSIX 传 0 合法无副作用。
# 实测定论：CREATE_NO_WINDOW 对孙进程链生效，只需覆盖平台自身创建点。
NO_WINDOW_FLAGS = (
    subprocess.CREATE_NO_WINDOW if platform.system() == "Windows" else 0
)

# ---------------------------------------------------------------- Windows 作业对象
#
# run_cmd 进程树收编（2026-10-12 事故）：`_kill_tree`（taskkill /T /F）只在命令
# **超时/abort** 时触发——命令正常返回时从不清理进程树。实测 agent 用 PowerShell
# `Start-Process -WindowStyle Hidden cmd.exe ...` 起一个独立进程（父化到
# explorer.exe）跑无限 `goto loop` 心跳，命令返回后继续常驻近 2 天，锁死项目
# 目录（删除 422）、占端口、烧 CPU。根因：host 侧命令默认无进程树边界，
# 「正常退出但留子进程」这条路径完全没兜住。
#
# 修法：给每条 host/wsl 命令包一个 KILL_ON_JOB_CLOSE 作业对象——命令返回即
# TerminateJobObject 收编整棵树（含子孙）。`Start-Process` 起的进程默认继承
# 作业，一并被杀；要脱管必须显式 CREATE_BREAKAWAY_FROM_JOB（本初版不暴露，
# 有需要再加）。`AssignProcessToJobObject` 失败（如父进程已在他人作业）静默
# 降级为既有杀树语义，**绝不**让命令失败。
if platform.system() == "Windows":
    import ctypes

    _JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800
    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    _JobObjectExtendedLimitInformation = 9
    _JOB_OBJECT_TERMINATE = 0x0001
    _K32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", ctypes.c_uint32),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", ctypes.c_uint32),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", ctypes.c_uint32),
            ("SchedulingClass", ctypes.c_uint32),
        ]

    class _IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_uint64),
            ("WriteOperationCount", ctypes.c_uint64),
            ("OtherOperationCount", ctypes.c_uint64),
            ("ReadTransferCount", ctypes.c_uint64),
            ("WriteTransferCount", ctypes.c_uint64),
            ("OtherTransferCount", ctypes.c_uint64),
        ]

    class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", _IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    _K32.CreateJobObjectW.restype = ctypes.c_void_p
    _K32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    _K32.SetInformationJobObject.restype = ctypes.c_int
    _K32.SetInformationJobObject.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    _K32.AssignProcessToJobObject.restype = ctypes.c_int
    _K32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    _K32.TerminateJobObject.restype = ctypes.c_int
    _K32.TerminateJobObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    _K32.CloseHandle.restype = ctypes.c_int
    _K32.CloseHandle.argtypes = [ctypes.c_void_p]

    def create_kill_on_close_job() -> int | None:
        """建 KILL_ON_JOB_CLOSE 作业对象；失败返回 None（命令照常执行，仅不收编）。"""
        try:
            handle = _K32.CreateJobObjectW(None, None)
            if not handle:
                return None
            info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            info.BasicLimitInformation.LimitFlags = (
                _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | _JOB_OBJECT_LIMIT_BREAKAWAY_OK)
            if not _K32.SetInformationJobObject(
                    ctypes.c_void_p(handle), _JobObjectExtendedLimitInformation,
                    ctypes.byref(info), ctypes.sizeof(info)):
                _K32.CloseHandle(ctypes.c_void_p(handle))
                return None
            return int(handle)
        except Exception:  # noqa: BLE001 —— 作业不可用绝不阻断执行
            return None

    def assign_to_job(job: int, proc: subprocess.Popen) -> bool:
        """把进程纳入作业；失败（父进程已在他人作业等）返回 False 供调用方降级。"""
        try:
            return bool(_K32.AssignProcessToJobObject(
                ctypes.c_void_p(job), ctypes.c_void_p(int(proc._handle))))  # noqa: SLF001
        except Exception:  # noqa: BLE001
            return False

    def kill_job(job: int) -> None:
        """终止作业内全部进程（收编整棵进程树）。"""
        try:
            _K32.TerminateJobObject(ctypes.c_void_p(job), _JOB_OBJECT_TERMINATE)
        except Exception:  # noqa: BLE001
            pass

    def close_job(job: int) -> None:
        """关闭作业句柄（KILL_ON_JOB_CLOSE 下关闭即焚毁残留）。"""
        try:
            _K32.CloseHandle(ctypes.c_void_p(job))
        except Exception:  # noqa: BLE001
            pass

else:  # POSIX：无作业对象原语；进程树收编依赖进程组（本初版不启用，保持现状）
    def create_kill_on_close_job() -> int | None:
        return None

    def assign_to_job(job: int, proc: subprocess.Popen) -> bool:
        return False

    def kill_job(job: int) -> None:
        return None

    def close_job(job: int) -> None:
        return None


def _kill_tree(proc: subprocess.Popen) -> None:
    """杀进程树：Windows 用 taskkill /T /F（PowerShell/bash 会拉起子进程，
    单杀 proc 会留尸）；POSIX 直接 SIGKILL。失败兜底再 proc.kill()。"""
    try:
        if platform.system() == "Windows":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, timeout=10,
                           creationflags=NO_WINDOW_FLAGS)
        else:
            proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


@dataclass
class ExecOutcome:
    exit_code: int = -1
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    interrupted: bool = False
    meta: dict[str, Any] = field(default_factory=dict)


def _execute_piped(proc: subprocess.Popen, timeout: float,
                   abort_event: threading.Event | None,
                   job: int | None = None) -> ExecOutcome:
    """Popen 全生命周期（2026-09-23 管道死锁修复）：排水 daemon 线程持续消费
    stdout/stderr——stdout=PIPE + poll() 轮询不读管道时，输出超 Windows 管道
    缓冲（64KB）子进程写阻塞、父进程等退出 = 双方死锁到超时杀树（实验复现，
    见 docs/plans/exec-gateway-pipe-deadlock.md）。排水后轮询语义不变：
    正常结束 join 排水线程取输出；abort → interrupted；超时 → 杀树 timed_out。

    job（2026-10-12 作业对象收编）：非 None 时命令返回后（正常/超时/中断）
    一律 TerminateJobObject 收编整棵树——兜住「命令正常退出但用 Start-Process
    留了常驻子进程」的逃逸路径（既有 `_kill_tree` 只管超时/abort）。"""
    def _drain(pipe, sink: list) -> None:
        try:
            for chunk in pipe:
                sink.append(chunk)
        except Exception:  # noqa: BLE001 —— 排水绝不反向影响执行
            pass

    out_buf: list[str] = []
    err_buf: list[str] = []
    threads: list[threading.Thread] = []
    for pipe, sink in ((getattr(proc, "stdout", None), out_buf),
                       (getattr(proc, "stderr", None), err_buf)):
        if pipe is not None:
            t = threading.Thread(target=_drain, args=(pipe, sink), daemon=True)
            t.start()
            threads.append(t)

    interrupted = False
    timed_out = False
    deadline = time.monotonic() + timeout
    while proc.poll() is None:
        if abort_event is not None and abort_event.is_set():
            interrupted = True
            _kill_tree(proc)
            break
        if time.monotonic() >= deadline:
            timed_out = True
            _kill_tree(proc)
            break
        time.sleep(POLL_INTERVAL)
    for t in threads:
        t.join(timeout=5)
    try:
        proc.wait(timeout=5)
    except Exception:  # noqa: BLE001
        pass
    # 作业收编（Windows）：命令返回即收编整棵树，清掉 Start-Process 等留下的
    # 常驻子进程（不给它们逃逸成孤儿的机会）。run_once/docker 路径 job=None 跳过。
    if job is not None:
        kill_job(job)
        try:
            proc.wait(timeout=3)
        except Exception:  # noqa: BLE001
            pass
    rc = proc.returncode if proc.returncode is not None else -1
    meta: dict[str, Any] = {}
    if interrupted:
        meta["interrupted"] = True
    if timed_out:
        meta["killed"] = True
    return ExecOutcome(exit_code=-1 if timed_out else rc,
                       stdout="".join(out_buf), stderr="".join(err_buf),
                       timed_out=timed_out, interrupted=interrupted,
                       meta=meta)


class BackendError(RuntimeError):
    pass


class NativeBackend:
    """L0 宿主执行。Windows 走 PowerShell，POSIX 走 bash。"""

    name = "host"

    def execute(self, cmd: str, timeout: float = 120.0, cwd: str | None = None,
                env: dict[str, str] | None = None,
                abort_event: threading.Event | None = None) -> ExecOutcome:
        if platform.system() == "Windows":
            argv = ["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd]
        else:
            argv = ["/bin/bash", "-c", cmd]
        return self._run(argv, timeout, cwd, env, abort_event)

    def _run(self, argv: list[str], timeout: float, cwd: str | None,
             env: dict[str, str] | None,
             abort_event: threading.Event | None = None) -> ExecOutcome:
        # 作业对象（2026-10-12）：托管进程树，命令返回即收编 Start-Process 等
        # 留下的常驻子进程。Assign 失败（父进程已在他人作业）→ job 置 None 降级。
        job = create_kill_on_close_job()
        try:
            proc = subprocess.Popen(
                argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                cwd=cwd, encoding="utf-8", errors="replace",
                env={**env} if env else None,
                creationflags=NO_WINDOW_FLAGS,
            )
        except FileNotFoundError as e:
            if job is not None:
                close_job(job)
            raise BackendError(f"后端解释器不可用: {e}") from e
        except Exception:
            if job is not None:
                close_job(job)
            raise
        if job is not None and not assign_to_job(job, proc):
            close_job(job)  # 纳不进作业：降级为无收编（既有杀树语义不变）
            job = None
        try:
            return _execute_piped(proc, timeout, abort_event, job=job)
        finally:
            # 关闭句柄：KILL_ON_JOB_CLOSE 下即便上面漏杀，关句柄也兜底焚毁残留
            if job is not None:
                close_job(job)


class WSLBackend(NativeBackend):
    """L1 WSL 执行：wsl bash -lc（与宿主同级信任，不跑不可信代码）。

    cwd 为 WSL 侧路径（网关经 windows_to_wsl_path 换算）→ wsl --cd 落点；
    env 不透传 Windows 进程环境（无意义），TMPDIR 重定向由网关前缀进 cmd。
    中断语义（2026-09-19）：杀 wsl.exe 客户端进程——WSL 侧残留进程由
    distro 生命周期兜底（已知局限，宁误杀勿悬挂）。
    """

    name = "wsl"

    def __init__(self, distro: str | None = None):
        self.distro = distro

    def execute(self, cmd: str, timeout: float = 120.0, cwd: str | None = None,
                env: dict[str, str] | None = None,
                abort_event: threading.Event | None = None) -> ExecOutcome:
        argv = ["wsl.exe"]
        if self.distro:
            argv += ["-d", self.distro]
        if cwd:
            argv += ["--cd", cwd]
        # --exec argv 直通（2026-09-23）：默认包装层重新引用命令行时会剥引号，
        # bash 拿到裸命令把 $var/awk $1/$$ 按 Linux 环境展开吞掉（实验实锤，
        # 见 docs/plans/wsl-dollar-swallow.md）；--exec 后参数不经包装层，引号保真。
        argv += ["--exec", "bash", "-lc", cmd]
        return self._run(argv, timeout, None, None, abort_event)


#: L2 默认容器镜像（pentest-tools-container-m0）：Debian slim + CTF 全向工具箱。
#: 构建脚本 scripts/build_pentest_box.py（tools/pentest-box/Dockerfile：apt 三层 →
#: pip 六组 → gem → pwndbg/gef → GitHub release 二进制）。tag 改版两处同步。
DEFAULT_PENTEST_IMAGE = "cyberstrike/pentest-box:0.5"


def docker_network(net: str) -> str:
    """网关网络模式 → docker `--network` 值（L2/L3 单一映射出处）。

    real → bridge：容器走 NAT 出网（可 run_cmd 直接指定，见 DESIGN §7）。
    **曾漏 real 落 else 分支变 none**——docker+real 实际断网，而事件/审计仍记 real，
    与「显式要真网」语义相反（pen-test 项目 docker 出口不通、wsl 却能通的根因）。
    """
    return {"none": "none", "bridge": "bridge", "real": "bridge"}.get(net, "none")


# 解题能力相关、**所有容器形态都必须带**的参数（一次性沙箱 + 会话常驻容器）。
# 2026-10-24 实测得出，两条缺一都在特定题型上直接卡死：
#
# 1. `--ulimit core=-1`：默认 `ulimit -c=0` 导致 core dump 恒不落盘（pwn 题拿不到
#    crash 现场）。实测抬高后 `core.N` 能正常产出。`core_pattern=core` 是**相对
#    路径**、落在进程 cwd，所以容器内可修 —— 这条曾被误判成「宿主内核参数改不了」。
# 2. `--security-opt seccomp=unconfined`：Docker 默认 profile 是**按参数值**过滤
#    `personality`：0x0/0x8/0x20000/0x20008 放行，**只拒 0x40000**
#    （`ADDR_NO_RANDOMIZE`，正是 `setarch -R` 传的值），导致关不掉 ASLR。
#    精确解法是自定义 profile 只补这一个掩码，但实测 Windows + Docker Desktop 下
#    `--security-opt seccomp=<宿主路径>` 加载失败（`string is not a valid action`，
#    盘符不共享），跨平台不可靠，故退用 unconfined。
#
# **安全性依据（实测对照，改这两行前必须先读）**：
#     | 配置                      | ASLR 可关 | mount | 他进程 ptrace | sysctl |
#     | 默认 seccomp              | 否        | 否    | 否            | 否     |
#     | unconfined + cap-drop ALL | 是        | 否    | 否            | 否     |
#     | `--privileged`            | 是        | **是**| 是            | 是     |
# 隔离的真正来源是 `--cap-drop ALL`（`CapEff=0`），**不是 seccomp**。
# 放开 seccomp ≠ 拆沙箱；只有 `--privileged` 才等于拆沙箱，绝不能那样换 ASLR。
SANDBOX_CAPABILITY_ARGS: list[str] = [
    "--ulimit", "core=-1",
    "--security-opt", "seccomp=unconfined",
]


#: 内核 VM 硬件加速（2026-10-27：pentest-box 补内核 pwn 能力）。
#: **只加设备，不加任何 capability**。实测（Docker Desktop/WSL2）：
#: `--device /dev/kvm` 且 `--cap-drop ALL` 时 `KVM_GET_API_VERSION=12`、
#: `KVM_CREATE_VM`/`KVM_CREATE_VCPU` 全通，`CapEff` 仍是 0000000000000000。
#: 所以 `--privileged` 完全没必要 —— 它会把 mount/ptrace/sysctl 一起放开，
#: 等于拆掉沙箱（对照表见 docker-env-vs-manual-2026-10-24.md §三）。
KVM_DEVICE_ARGS: list[str] = ["--device", "/dev/kvm"]

#: 这台宿主到底有没有 /dev/kvm。None=还没试过，False=确认没有（此后不再重试）。
#: **不能用宿主 os.path.exists 判**：Windows 宿主根本没有这条路径，真正的设备在
#: Docker 的 Linux VM 里；平台侧唯一的可靠判据就是「带参数真创建一次容器」。
_KVM_STATE: bool | None = None

#: 「这台宿主没有 KVM」的 docker 报错特征。设备缺失在 **create 阶段**就失败
#: （`error gathering device information while adding custom device`），
#: 容器根本没建出来，所以重试一次不会留下第二个容器。
_DEVICE_ERROR_MARKERS = ("error gathering device information",
                         "no such file or directory")


# ---------------------------------------------------------------- daemon 熔断
#
# 2026-10-29：Docker Desktop 没启动时，**每次** docker 调用都要付一次
# 「CLI 冷启 + 连不上 npipe」的代价 —— 实测 2.5~3.1s（3 次：3092/2901/2462ms）。
# 这个开销发生在 `_docker` 里面，也就是**在 environment_recovery 之前**：
# daemon 类是 recoverable=False（recovery.py），恢复器一个动作都不做，只回
# 「不允许自动恢复」；但为走到那一步，调用方已经白等了 3s。
#
# 为什么这才是指标「12 次 / 整段时间无法执行命令」的真实成因：
#   · recovery 侧 denied 时会 `_release()` 回滚计数 → 同一 key 永远不 exhausted，
#     所以每次都会重新走一遍；
#   · 而真正贵的不是 recovery 的判定（纯内存），是它前面那 3s 的 docker CLI。
#
# 修法：在 `_docker` 入口加**按 daemon 的短路窗口**——一旦确认 daemon 连不上，
# 后续 N 秒内的 docker 调用直接抛同一类 BackendError，不再 fork CLI。
#
# 安全边界（这条必须守住）：熔断**不改变任何判定结果**，只是把「必然失败的
# 结论」提前。它不禁用 docker、不降级到 host、不吞异常 —— 抛的还是同一个
# BackendError，上层 classify 出来的还是 docker_daemon_unavailable。
# 窗口有上限（默认 15s），且 `reset_docker_daemon_circuit()` 可在用户显式
# 说「我起了 Docker」时立刻探测，不会一断就锁死。
_DOCKER_DAEMON_OPEN_SECONDS = 15.0

#: 熔断状态：(open_until_monotonic, 最后一条原始错误)。None=当前没有熔断。
_DAEMON_BREAKER: tuple[float, str] | None = None
_DAEMON_BREAKER_LOCK = threading.Lock()
# 窗口过期后只允许一个请求试探，避免并发请求一起冷启 docker CLI。
_DAEMON_PROBE_LOCK = threading.Lock()

#: 判定「daemon 连不上」的 stderr 特征。`DockerBackend._docker` 直接复用这一份
#: —— 判据与「开熔断」必须同源，否则会出现「熔断了但错误不匹配」这类静默错位。
_DAEMON_DOWN_MARKERS = (
    "failed to connect to the docker api",
    "is the docker daemon running",
    "dockerdesktoplinuxengine",
    "cannot connect to the docker daemon",
)


def reset_docker_daemon_circuit() -> None:
    """清掉 daemon 熔断（显式诊断/测试时调用）。"""
    global _DAEMON_BREAKER
    with _DAEMON_BREAKER_LOCK:
        _DAEMON_BREAKER = None


def docker_daemon_circuit_open() -> bool:
    """只读探测：熔断当前是否开着（供诊断/测试断言，不产生副作用）。"""
    with _DAEMON_BREAKER_LOCK:
        if _DAEMON_BREAKER is None:
            return False
        return time.monotonic() < _DAEMON_BREAKER[0]


def _daemon_down_message(detail: str) -> str:
    # 文案与 DockerBackend._docker 里抛的保持完全一致：上层靠子串
    # "docker daemon 不可用" 分类（classify_backend_error），不能分叉。
    return ("Docker daemon 不可用：请启动 Docker Desktop（Linux engine），"
            f"或在 threat_class 允许时改用 host/wsl；当前命令未执行。{detail}")


def _mark_daemon_down(detail: str) -> None:
    global _DAEMON_BREAKER
    with _DAEMON_BREAKER_LOCK:
        _DAEMON_BREAKER = (time.monotonic() + _DOCKER_DAEMON_OPEN_SECONDS, detail)


def _clear_daemon_breaker(expected: tuple[float, str] | None) -> None:
    """成功的 docker 探测清除同一代熔断，不覆盖探测期间新开的状态。"""
    global _DAEMON_BREAKER
    with _DAEMON_BREAKER_LOCK:
        if _DAEMON_BREAKER == expected:
            _DAEMON_BREAKER = None



def _is_kvm_device_error(outcome: "ExecOutcome") -> bool:
    if outcome.exit_code == 0:
        return False
    err = (outcome.stderr or "").lower()
    return "/dev/kvm" in err and any(m in err for m in _DEVICE_ERROR_MARKERS)


def sandbox_docker_args(net: str) -> list[str]:
    """L3 加固参数（DESIGN.md §7）：无挂载、限额、降权。fakenet 下一里程碑实现。"""
    if net not in {"none", "real"}:
        raise NotImplementedError(f"网络模式 {net} 尚未实现（fakenet=INetSim sidecar，下一里程碑）")
    docker_net = docker_network(net)
    args = [
        "--rm",                       # 一次性生命周期：跑完即焚
        "--network", docker_net,
        "--memory", "512m",
        "--pids-limit", "64",
        "--cpus", "1.0",
        "--security-opt", "no-new-privileges",
        "--cap-drop", "ALL",
        *SANDBOX_CAPABILITY_ARGS,
    ]
    return args


class DockerBackend:
    """L2/L3 Docker 执行。sandbox 模式自动附加加固参数并禁止挂载。"""

    name = "docker"

    def __init__(self, docker_cmd: str = "docker", proxy: str | None = None):
        self.docker_cmd = docker_cmd
        # Docker runtime 强制直连。保留 proxy 参数仅为兼容旧调用方，但绝不读取
        # CYBERSTRIKE_DOCKER_PROXY，也不把代理变量注入容器；browser_replay 和
        # 代理池属于独立网络能力，不应改变 run_cmd 的网络路径。
        self.proxy = None

    def proxy_env(self) -> dict[str, str]:
        """Docker 构建/运行不使用代理；返回空环境，保留接口兼容性。"""
        return {}

    def _proxy_args(self, net: str) -> list[str]:
        """Docker 容器始终直连，不注入 HTTP_PROXY/HTTPS_PROXY。"""
        return []

    def _docker(self, argv: list[str], timeout: float,
                abort_event: threading.Event | None = None) -> ExecOutcome:
        # daemon 熔断（2026-10-29）：已知连不上就直接抛，不再 fork CLI 白等 2.5~3.1s。
        # 抛的仍是同一个 BackendError，上层分类结果不变 —— 只省时间，不改语义。
        with _DAEMON_BREAKER_LOCK:
            breaker = _DAEMON_BREAKER
        probe_owner = False
        if breaker is not None:
            now = time.monotonic()
            if now < breaker[0]:
                raise BackendError(_daemon_down_message(
                    f"（{int(breaker[0] - now)}s 内不再重试 CLI）"))
            # 半开窗口：一个请求持探测锁并重新连接；并发请求不再各 fork 一次。
            probe_owner = _DAEMON_PROBE_LOCK.acquire(blocking=False)
            if not probe_owner:
                raise BackendError(_daemon_down_message("（daemon 恢复探测正在进行）"))
        try:
            try:
                proc = subprocess.Popen(
                    [self.docker_cmd, *argv], stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, text=True, encoding="utf-8",
                    errors="replace", creationflags=NO_WINDOW_FLAGS,
                )
            except OSError as e:
                raise BackendError(
                    f"Docker CLI 不可用: {e}。请启动 Docker Desktop，或改用允许的 host/wsl runtime"
                ) from e
            outcome = _execute_piped(proc, timeout, abort_event)
            daemon_error = (outcome.stderr or "").lower()
            if outcome.exit_code != 0 and any(
                    marker in daemon_error for marker in _DAEMON_DOWN_MARKERS):
                detail = (outcome.stderr or "").strip().splitlines()
                _mark_daemon_down(detail[0][:200] if detail else "")
                raise BackendError(_daemon_down_message(""))
            # 任何非 daemon-down 响应（包括容器命令自己的非零退出）说明
            # CLI 已不再报告连接故障；只清除探测启动前见到的同一代状态。
            _clear_daemon_breaker(breaker)
            return outcome
        finally:
            if probe_owner:
                _DAEMON_PROBE_LOCK.release()

    def _run_container(self, build, timeout: float,
                       abort_event: threading.Event | None = None,
                       kvm: bool = True) -> ExecOutcome:
        """起容器；带 `--device /dev/kvm` 失败（宿主没有该设备）就裸跑一次并记住结论。

        为什么「先探测再决定」不可行：设备在 Docker 的 Linux VM 里，而平台跑在
        Windows 宿主上 —— `os.path.exists('/dev/kvm')` 永远是 False。唯一可靠判据
        就是真创建一次容器。失败发生在 **create 阶段**，容器不会被建出来，
        所以「一个会话一个容器」的语义不受影响。

        KVM 只影响内核 VM 的速度（5~20×），**不是可用性前提**：拿不到就回落 TCG，
        命令照跑。
        """
        global _KVM_STATE
        if not kvm:
            return self._docker(build(False), timeout, abort_event)
        want = _KVM_STATE is not False
        out = self._docker(build(want), timeout, abort_event)
        if want and _is_kvm_device_error(out):
            _KVM_STATE = False
            out = self._docker(build(False), timeout, abort_event)
        elif want and _KVM_STATE is None:
            # 容器起来了（哪怕命令本身非 0）→ 设备确实可用。
            _KVM_STATE = True
        return out

    def run_once(self, image: str, cmd: str, *, net: str = "none", sandbox: bool = False,
                 timeout: float = 300.0, abort_event: threading.Event | None = None,
                 mounts: list[tuple[str, str]] | None = None,
                 cwd: str | None = None,
                 name: str | None = None,
                 labels: dict[str, str] | None = None) -> ExecOutcome:
        """一次性容器执行。sandbox=True 时强制 L3 加固参数（忽略 mounts——L3 零挂载）。
        mounts=[(宿主路径, 容器路径), ...]（L2 workspace 卷挂载，pentest-tools-container-m0）；
        cwd=容器内工作目录（网关固定 /workspace/scratch，对齐 host/wsl 相对路径习惯）。
        name/labels（P1，2026-10-07）：固定容器名 + 标签使残留可识别可回收（默认 None=现状）。
        **两条路径均带 --rm 一次性生命周期**——L2 曾漏 --rm 致「已停容器残留堆积」
        （container-execution-architecture §2 已知小坑），每次 docker run 留一个 exited
        容器，累积上千拖垮 Docker Desktop 仪表盘。中断杀 docker CLI 客户端属已知局限，
        由 SessionContainerManager 的对账/reaper 兜底。"""
        def build(with_kvm: bool) -> list[str]:
            argv = ["run"]
            if sandbox:
                argv += sandbox_docker_args(net)
            else:
                argv += ["--rm", "--network", docker_network(net)]
                argv += self._proxy_args(net)
                # L3 沙箱不接 KVM：它零挂载、跑不到题目文件，多开一个设备只是
                # 平白扩大攻击面（内核题一律跑会话容器，见 KVM_DEVICE_ARGS）。
                if with_kvm:
                    argv += KVM_DEVICE_ARGS
                for host_path, cpath in (mounts or []):
                    # 宿主路径转正斜杠：docker -v 在 Windows 上两种斜杠都收，正斜杠免转义
                    argv += ["-v", f"{str(host_path).replace(chr(92), '/')}:{cpath}"]
                if cwd:
                    argv += ["-w", cwd]
            if name:
                argv += ["--name", name]
            for k, v in (labels or {}).items():
                argv += ["--label", f"{k}={v}"]
            # pentest-box 提供 bash；常驻/普通 Docker 用 bash -lc 支持 CTF 脚本
            # 的 pipefail 等语义。sandbox 默认镜像可能只有 sh，保留其兼容性。
            shell = "sh" if sandbox else "bash"
            argv += [image, shell, "-lc" if shell == "bash" else "-c", cmd]
            return argv

        return self._run_container(build, timeout, abort_event, kvm=not sandbox)

    def run_detached(self, image: str, cmd: str, *, name: str,
                     labels: dict[str, str], net: str = "none",
                     timeout: float = 60.0,
                     mounts: list[tuple[str, str]] | None = None,
                     cwd: str | None = None) -> ExecOutcome:
        """常驻容器（会话级 P3，2026-10-07）：`docker run -d` 起长驻容器，后续命令走
        exec_in。与 run_once 的区别：detached（-d）、固定 name、必带 labels、
        **绝不带 --rm**（常驻容器自毁会毁掉复用语义）。生命周期由
        SessionContainerManager 管理（冻结/删除/对账/reap）。"""

        def build(with_kvm: bool) -> list[str]:
            argv = ["run", "-d", "--name", name,
                    "--network", docker_network(net)]
            argv += self._proxy_args(net)
            # 常驻容器是 CTF 实际跑题的那个，**必须**带能力参数（core dump / 可关 ASLR）。
            # 与 sandbox_docker_args 共用同一常量，避免两条路径再次漂移 ——
            # 曾出现「一次性沙箱加固了、常驻容器完全裸奔」的分叉。
            argv += SANDBOX_CAPABILITY_ARGS
            # 内核 pwn 的 qemu 就跑在这个容器里：KVM 设备只加在这里（会话容器
            # 有 workspace 挂载，题目文件才进得来）。
            if with_kvm:
                argv += KVM_DEVICE_ARGS
            for k, v in labels.items():
                argv += ["--label", f"{k}={v}"]
            for host_path, cpath in (mounts or []):
                argv += ["-v", f"{str(host_path).replace(chr(92), '/')}:{cpath}"]
            if cwd:
                argv += ["-w", cwd]
            argv += [image, "bash", "-lc", cmd]
            return argv

        return self._run_container(build, timeout, kvm=True)

    def exec_in(self, container: str, cmd: str, timeout: float = 120.0,
                abort_event: threading.Event | None = None,
                cwd: str | None = None) -> ExecOutcome:
        """在已运行容器内执行（会话级常驻容器 / pwn 题目交互等场景）。
        cwd=容器内工作目录（会话级路径固定 /workspace/scratch，对齐 L2 习惯）。"""
        argv = ["exec"]
        if cwd:
            argv += ["-w", cwd]
        argv += [container, "bash", "-lc", cmd]
        return self._docker(argv, timeout, abort_event)

    # ---------- 容器生命周期原语（会话级常驻容器 P3） ----------

    def stop(self, container: str, timeout: float = 30.0) -> ExecOutcome:
        """停止容器（保留 FS，可 start 恢复）。冻结语义，非销毁。"""
        return self._docker(["stop", "-t", "2", container], timeout)

    def start(self, container: str, timeout: float = 30.0) -> ExecOutcome:
        return self._docker(["start", container], timeout)

    def restart(self, container: str, timeout: float = 30.0) -> ExecOutcome:
        """重启容器——清空容器内残留进程（exec 被 abort 后子进程可能挂住）。"""
        return self._docker(["restart", "-t", "2", container], timeout)

    def rm(self, container: str, timeout: float = 30.0) -> ExecOutcome:
        """强制删除容器（-f 兼容运行中，一并释放卷挂载句柄——Windows 删目录前必做）。"""
        return self._docker(["rm", "-f", container], timeout)

    def inspect_running(self, container: str, timeout: float = 15.0) -> bool:
        """容器是否存在且处于运行中。inspect 对不存在的容器非零退出 → False。"""
        o = self._docker(["inspect", "-f", "{{.State.Running}}", container], timeout)
        return o.exit_code == 0 and o.stdout.strip() == "true"

    def ps_by_label(self, selector: str, timeout: float = 15.0) -> list[str]:
        """按 label 选择器列出容器名（含已停止）。selector 形如 "csp.managed=1"。

        只用 {{.Names}} 做 format——`.Label "k"` 需在 argv 内嵌引号，Windows 下
        CreateProcess 引号转义易被 docker CLI 曲解；会话/项目归属改由容器名
        `csp_<pid>_<sid>` 编码（管理器解析），label 仅作 --filter 选择器。"""
        o = self._docker(["ps", "-a", "--filter", f"label={selector}",
                          "--format", "{{.Names}}"], timeout)
        if o.exit_code != 0:
            return []
        return [ln.strip() for ln in o.stdout.splitlines() if ln.strip()]
