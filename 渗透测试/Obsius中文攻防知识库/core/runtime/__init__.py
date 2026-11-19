"""core.runtime —— 执行环境层（DESIGN.md §7）。

对外入口：
    from core.runtime import ExecutionGateway, GatewayDenied, HostDetector, allowed_runtimes
"""

from core.runtime.backends import (
    BackendError,
    DockerBackend,
    NativeBackend,
    WSLBackend,
    docker_daemon_circuit_open,
    reset_docker_daemon_circuit,
)
from core.runtime.detector import CapabilityInventory, HostDetector
from core.runtime.gateway import (
    DEFAULT_CMD_TIMEOUT,
    MAX_CMD_TIMEOUT,
    ExecutionGateway,
    ExecutionResult,
    GatewayDenied,
    load_runtime_config,
    resolve_default_timeout,
    write_runtime_config,
)
from core.runtime.policy import allowed_runtimes
from core.runtime.recovery import (
    EnvironmentErrorCategory,
    EnvironmentErrorKind,
    EnvironmentIssue,
    EnvironmentRecovery,
    EnvironmentRecoveryManager,
    EnvironmentUnavailable,
    RecoveryRequest,
    RecoveryResult,
    classify_backend_error,
    classify_execution_failure,
    environment_issue_from_dict,
)

__all__ = [
    "ExecutionGateway",
    "ExecutionResult",
    "GatewayDenied",
    "HostDetector",
    "DEFAULT_CMD_TIMEOUT",
    "MAX_CMD_TIMEOUT",
    "load_runtime_config",
    "resolve_default_timeout",
    "write_runtime_config",
    "CapabilityInventory",
    "NativeBackend",
    "WSLBackend",
    "DockerBackend",
    "BackendError",
    "docker_daemon_circuit_open",
    "reset_docker_daemon_circuit",
    "allowed_runtimes",
    "EnvironmentErrorCategory",
    "EnvironmentErrorKind",
    "EnvironmentIssue",
    "EnvironmentUnavailable",
    "RecoveryRequest",
    "RecoveryResult",
    "EnvironmentRecovery",
    "EnvironmentRecoveryManager",
    "classify_backend_error",
    "classify_execution_failure",
    "environment_issue_from_dict",
]
