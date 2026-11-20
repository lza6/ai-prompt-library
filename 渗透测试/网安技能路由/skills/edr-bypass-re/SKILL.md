# EDR 绕过逆向

## 适用场景（红队）

- 逆向 EDR 的 hook 表和回调
- unhook / direct syscall / indirect syscall
- ETW patch / AMSI patch
- call stack spoofing

## 技术栈

| 技术 | 说明 |
|------|------|
| Direct Syscall | 直接调用 syscall，绕过 ntdll hook |
| Indirect Syscall | 从 ntdll 的 syscall 指令跳转 |
| Hell's Gate | 动态解析 SSN |
| Halo's Gate | Hell's Gate 变种 |
| SysWhispers | 自动生成 syscall 代码 |
| ETW Patch | 禁用事件追踪 |
| AMSI Patch | 绕过反恶意软件扫描接口 |
| pe-sieve | 进程内存扫描 |
| Call Stack Spoofing | 伪造调用栈 |

## 参考文档

- `references/unhook-techniques.md` — unhook 技术
- `references/hook-survey.md` — hook 表调查
- `references/telemetry-blinding.md` — 遥测致盲
