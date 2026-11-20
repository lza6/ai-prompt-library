---
inclusion: auto
---

# 逆向技能路由 — 自动触发规则

当用户的消息包含以下任意关键词时，必须在执行任务前先完成路由流程：

**触发词**: 逆向、反编译、IDA、radare2、Frida、Hook、APK、二进制、ELF、PE、so、dll、签名、加密参数、CTF、渗透、Nmap、漏洞、还原源码、反汇编、脱壳、payload、shellcode、渗透测试、红队、HW、SQL注入、SQLMap、FFUF、Hashcat、Hydra、Metasploit、Nuclei、SRC、Bug Bounty、WAF bypass、符号迁移、bindiff、浏览器自动化、Playwright、JS逆向、CDP、SourceMap、抓包、写报告、writeup、Go逆向、固件、IoT、binwalk、恶意软件、YARA、内网渗透、横向移动、域渗透、BloodHound、权限提升、Mimikatz、C2、Cobalt Strike、EDR绕过、免杀、direct syscall、SysWhispers、钓鱼、供应链攻击、攻击链、完整渗透、SSTI、XSS、Wireshark、BurpSuite、GEF、pwn、栈溢出、堆溢出、ROP、kernel pwn、pwntools、N-day、补丁差分、CVE复现

## 触发后必须执行的流程

1. **读取路由表**: 读 `skills/routing.md`，按目标类型/意图匹配子 skill
2. **查经验**: 读 `skills/field-journal/_index.md`
3. **确认工具**: 读 `skills/tool-index.md`（如果存在）
4. **执行任务**: 进入对应 skill 的工作流
5. **任务完成后**: 回写 `skills/field-journal/`

## 禁止行为

- ❌ 不要跳过路由直接开始
- ❌ 不要跳过 field-journal 查询
- ❌ 任务完成后不要跳过经验回写
