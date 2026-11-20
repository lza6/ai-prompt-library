# RE→Exploit 利用链

## 适用场景

- 从逆向分析到编写可用 exploit
- 栈溢出、堆利用、内核 pwn
- CTF Pwn 题
- 真实漏洞利用开发

## 工具链

| 工具 | 用途 |
|------|------|
| pwntools | exploit 开发框架 |
| GDB + GEF/pwndbg | 调试 |
| one_gadget | 一键 getshell gadget |
| libc-database | libc 版本识别 |
| ROPgadget | ROP 链构造 |

## 工作流程

### 1. 漏洞识别
- 逆向分析目标程序
- 识别漏洞类型（栈溢出/堆溢出/UAF/格式化字符串）
- 确定安全机制（NX/ASLR/PIE/Canary/Full RELRO）

### 2. 漏洞利用
- 计算偏移
- 构造 payload（ROP chain / shellcode / heap feng shui）
- 绕过安全机制

### 3. 稳定化
- 处理 ASLR 泄露
- 多次利用的稳定性
- 从 CTF 到真实远程的适配

## 参考文档

- `references/stack-pwn.md` — 栈利用
- `references/heap-pwn.md` — 堆利用
- `references/kernel-pwn.md` — 内核利用
