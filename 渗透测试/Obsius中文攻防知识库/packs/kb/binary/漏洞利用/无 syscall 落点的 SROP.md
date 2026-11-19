---
phase: binary
vuln_class: [pwn, srop, seccomp, rop, partial-overwrite, stack-dump]
title: 无 syscall 落点的 SROP
summary: 二进制里一条 syscall 指令都没有、也没有 pop rdi/rsi/rdx 系列 gadget 时，如何靠「栈上残留 libc 指针部分覆写」造出裸 syscall 落点，再用 read 返回值控 rax 触发 rt_sigreturn，最后经 environ 到启动栈取 ENV 里的 flag。
---

# 无 syscall 落点的 SROP

基础链、ret2csu、`xchg` 枢轴见 [[binary/漏洞利用/ROP 与 shellcode.md|ROP 与 shellcode]]；SROP 省 gadget 的用法见 [[binary/漏洞利用/ROP 进阶.md|ROP 进阶]] §2；seccomp 通用打法见 [[binary/漏洞利用/Pwn 进阶手法.md|语义误用与 seccomp]]。

## 判据速查

| 现象 | 首选手法 | 去哪节 |
|---|---|---|
| `ROPgadget` 一条 `pop rdi` 都没有，但栈上能拿到 libc 指针 | 部分覆写该指针低位，落到 libc 内 `mov eax,edx; syscall` 之类片段 | §1 |
| `read` 返回值可控，但只能把长度写进内存、拿不到目标 syscall 号 | 用返回值本身当 `rax`（控制发送长度），不靠写内存 | §2 |
| 找到的落点是裸 `syscall`，后面没有 `ret`，跑完就崩 | 「加立即数」gadget 把裸 `syscall` 抬到 libc 的 `syscall; ret` | §3 |
| 无输出原语、flag 由 `ENV` 注入而非文件 | 泄露 `environ` → dump envp 指针数组 → 再 dump 字符串页 | §4 |
| dump 任意内存时返回 0 字节且无报错 | 必须按页内剩余长度切分，跨页即 EFAULT | §4 |

## 1. 部分覆写栈上残留的 libc 指针（适用条件与步骤）

**前置**：能拿一次栈溢出且能栈迁移（`leave; ret` 控 `rbp`）；栈或 bss 上存在某处残留值指向 libc；ASLR 只随机页基址，页内低位固定。

**判据**：`ROPgadget` 输出里 `pop rdi`/`pop rsi`/`pop rdx`/`pop rax` 计数为 0，且 `readelf -rW` 的 `.rela.plt` 里没有 `syscall`/`mmap`/`mprotect` 这类能顺带带出 syscall 的导入。此时不要继续搜 gadget，转向「已有的 libc 指针改几个字节」。

**动作**：先让程序把栈迁到已知可写区（bss），再把控制流送回入口重跑一次，使 bss 上的栈帧里出现由 libc 写入的残留槽（典型是 `_start` 之后的返回地址链、`__libc_start_main` 相关槽）。gdb 里对 bss 范围 `x/64gx` 找出形如 `0x7f....` 的槽，记下该值与 libc 基址之差（记为 `SLOT_OFF`），并记下目标片段相对基址的偏移（记为 `FRAG_OFF`）：

```python
payload = b'A' * PAD + p64(CNT_ADDR) + p64(BSS_FRAME) + p64(RE_READ_ENTRY)
# 第二段只发低位那几个字节，覆盖低两字节
payload2 = p16((LIBC_BASE + FRAG_OFF) & LOW16_MASK)
```

低位覆写的命中率随页内随机位数量呈 2 的幂倒数（常见量级是十几次重连内命中），必须写成重连爆破循环，别指望一发命中；同时要在脚本里写死命中判据（例如泄露值页内偏移是否等于目标片段页内偏移），否则分不清「没命中」和「链写错」。

**不成立**：bss/栈上找不到任何指向 libc 的残留值（例如程序不经过 `__libc_start_main`，或迁移后那段区域被 `read` 覆盖成纯输入）→ 转 §2 的「靠返回值控 rax」，或回到基础 ROP 找 vDSO（`AT_SYSINFO_EHDR`）。

**降级**：无 gdb 时用 `strings`/`objdump -d` 静态定位 `__libc_start_main` 调用点，按调用约定推栈布局；无 libc 文件时先泄一页 libc 内容，按字节特征（ELF 头、`0f 05` 位置）自识别版本。

## 2. 用 read 返回值控 rax 触发 rt_sigreturn

**前置**：能重入 `read`（`read@plt` 或程序里那段 `read` 都行）；`rax` 在返回后未被立刻覆盖；seccomp 白名单包含 `rt_sigreturn`（`seccomp-tools dump` 确认）。

**判据**：`read` 返回后紧跟的指令序列是「跳到某处」而不是「先把 `rax` 清零/改掉」。若 `read` 之后是 `mov edx, eax` 这类只取低半部分的搬运，仍然可用——`rax` 的完整值还在，只要确认下一步转移不吃 `rax`。

**动作**：让 `read` 的**发送字节数**正好等于 `__NR_rt_sigreturn`，`read` 返回值即该 syscall 号，随后的 `syscall` 就进入 `rt_sigreturn`：

```python
frame = SigreturnFrame()
frame.rax = __NR_write
frame.rdi = STDOUT_FD
frame.rsi = LEAK_ADDR
frame.rdx = WORD_SIZE
frame.rip = SYSCALL_RET      # §3 得到的落点
frame.rsp = NEXT_STAGE
```

注意长度与内容耦合：那次 `read` 的载荷必须正好等于目标 syscall 号，帧就得分两次读（先发这么多个字节触发，再用帧里的 `rsp` 指回缓冲继续读剩余字节）。

**不成立**：seccomp 白名单不含 `rt_sigreturn`（只留 `read`/`write`/`exit_group`）→ SROP 整条断，改走 §4 的纯 `write` 泄露 + 一次性输出，或考虑计时侧信道。

**降级**：无 `SigreturnFrame`（pwntools 缺失）时手写 `struct.pack` 拼帧，字段顺序固定：`uc_flags, &uc, r8..rdi, rsi, rbp, rbx, rdx, rax, rcx, rsp, rip, eflags, cs/gs/fs/ss, err, trapno, oldmask, cr2, fpstate, reserved`。

## 3. 用「加立即数」gadget 把裸 syscall 升级成 syscall;ret

**前置**：§1 拿到的片段是 `mov eax,edx; syscall; <jmp 或崩溃>`，没有 `ret`；程序里有形如 `add dword ptr [rbp - X], ebx` 的算术 gadget（`ROPgadget` 搜 `add dword`）。

**判据**：`objdump` 里裸 `syscall` 后面紧跟的指令不写回栈、也不是 `ret`。此时直接把 `rip` 设成该片段，`syscall` 执行完就掉进无意义指令。同时 `ROPgadget` 里能搜到一条「对 `[rbp-off]` 做 `add`」的 gadget，且 `rbx` 由 SigreturnFrame 可控。

**动作**：把帧的 `rip` 指向那条 `add` gadget，让它在**帧自己占的那块内存**上做加法，把「裸 syscall 片段地址」加上一个差值，抬到 libc 里真正的 `syscall; ret`：

```python
frame.rbp = SLOT_ADDR - GADGET_DISP   # 让 [rbp+disp] 正好是存放片段地址的槽
frame.rbx = (LIBC_BASE + SRET_OFF) - (LIBC_BASE + FRAG_OFF)   # 差值
frame.rip = ADD_GADGET
```

关键点：那条 gadget 的位移常常不是字长对齐的，它把「槽的低半部分」当作 dword 加，从而只改低位、保住高位。落地前先在 gdb 里确认 `[rbp+disp]` 指向的确实是那个槽，否则加完值会落到无意义地址。

**不成立**：找不到任何 `add [reg-off], reg` 类 gadget → 改用「二次部分覆写」：先靠 §2 拿到一次 `write` 泄露，算出 libc 基址后重连，这次直接把槽覆写成完整的 `syscall; ret`（代价是重连后 ASLR 变化，需在同一次连接内完成两段操作）。

**降级**：`ROPgadget` 不可用时用 `objdump -d libc.so.6 | grep -n 'add.*%e'` 粗筛，再用 `ropper --search "add dword [rbp-"` 复核。

## 4. 经 environ dump 启动栈取 ENV 里的 flag

**前置**：已能任意读（§3 之后 `write(fd, addr, n)` 可用）；flag 由容器 `ENV` 注入而非落文件（`Dockerfile` 里 `ENV FLAG=...`，且 seccomp 封了 `open`/`execve`，读文件的路子根本走不通）。

**判据**：`strings chall | grep -i flag` 无命中、Dockerfile 只有 `ENV FLAG`、`seccomp-tools dump` 里 `open/openat/execve` 全部 KILL。此时 flag 一定在进程启动栈的 `envp` 字符串区。

**动作**：三步解引用，一步都不能省：

1. `write(1, libc + environ_off, n)` 拿到 `envp` 指针数组的地址（形如 `0x7ffc...`）；
2. dump `envp` 所在页，**长度必须是「本页末尾 − envp」**，跨页直接 EFAULT、返回 0 字节且无任何报错——这是最容易误判成「泄露失败」的坑。解析出每个字长的指针，直到遇到 0 结尾；
3. 对每个指针再 dump 其所在页（同样按页内剩余长度），在字符串区里找 `FLAG=`/`flag{`。

```python
envp = u64(recvn(WORD_SIZE))
page_start = envp - (envp % PAGE_SIZE)
first = dump(envp, PAGE_SIZE - (envp % PAGE_SIZE))
ptrs = [u64(first[i:i+WORD_SIZE]) for i in range(0, len(first), WORD_SIZE)
        if STACK_LO <= u64(first[i:i+WORD_SIZE]) <= STACK_HI]
for p in ptrs:
    s = dump(p - (p % PAGE_SIZE), PAGE_SIZE - (p % PAGE_SIZE))
    m = FLAG_RE.search(s)
```

**不成立**：dump 出来的只有指针、没有字符串 → 说明还停在第一层（`environ` 指向的是指针数组，不是字符串本身），继续按指针解一层；若 `environ` 泄露值不像栈地址（高半部分不是栈段特征），说明 libc 版本偏移取错，回 §1 重新标定。

**降级**：`environ` 符号不可用时，直接从栈上找：泄露一次 `rsp` 附近（SigreturnFrame 里 `rsp` 已知），在 dump 里搜连续可打印串，或搜 `PATH=`/`PWD=` 这类常见前缀反推字符串区起点。

## 5. 复现步骤与已知坑

已验证路径（按顺序，每步都要留下可核对的输出）：

1. `checksec` + `readelf -rW` + `ROPgadget` 三连，先确认「无 gadget、无 syscall 指令、无 mmap」这三条约束是否同时成立；
2. 栈迁移到 bss，重跑入口，`x/64gx` 找 libc 残留槽并标定偏移；
3. 低位爆破部分覆写，命中判据写死在脚本里（泄露值页内偏移校验）；
4. SigreturnFrame 触发 `rt_sigreturn`，`write` 泄 libc 基址；
5. `write(environ)` → 按页 dump envp 页 → 按指针再 dump 字符串页。

已知坑：

- **泄露不能用 `recvuntil(b'\x7f')`**：ASLR 高位可能是别的字节，会把后续数据一起吞掉，一律 `recvn(字长)`；
- **跨页 dump 静默 EFAULT**：返回 0 字节、无报错，看起来像「原语没打通」，实际只是长度算错；
- **`environ` 是两级指针**：只 dump 第一页几乎永远看不到 flag；
- **爆破命中率与页内随机位绑定**：不要因为前几次失败就换手法，先把重连循环跑满。

## 6. 纪律

- **先 `seccomp-tools dump` 再决定手法**。白名单里有没有 `rt_sigreturn`，直接决定 SROP 是否成立；有没有 `write`，决定能不能泄。
- **gadget 计数为 0 时不要继续搜 gadget**，改去找「已有的 libc 指针 + 部分覆写」，这是同一枚硬币的另一面。
- **任何 `write` 任意读都要按页切分**，跨页 EFAULT 静默返回 0，很容易被当成「泄露没打通」而白绕一圈。
