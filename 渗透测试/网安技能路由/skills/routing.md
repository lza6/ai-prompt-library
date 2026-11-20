# 安全技能路由矩阵

按目标类型、用户意图、工具链三个维度将任务路由到最合适的技能模块。

## CRITICAL: 路由执行协议

1. **MUST** 在执行前完成路由，不要"先做再说"
2. **MUST** 匹配全部三个维度后再进入 skill
3. 未命中 → 提议新增 skill，不要硬塞
4. 跨模块任务 → 按"路径交叉"章节组合
5. 路由完成后，先读目标 skill 的 SKILL.md 再行动

---

## 按目标类型

| 目标类型 | 推荐入口 | 备选 |
|----------|----------|------|
| APK / Android 应用 | `apk-reverse/` — jadx 反编译 + apktool 解包 | 核心在 .so → `ida-reverse/` 或 `radare2/` |
| 二进制 exe/dll/so/elf | `ida-reverse/` — IDA Pro 反编译 | `radare2/` CLI 分析 |
| JavaScript / 前端 | `js-reverse/` — 5 阶段工作流 | jshookmcp CDP/Hook |
| HTTP 抓包 / 请求重放 | `js-reverse/` 或 browser-automation | — |
| 固件 / IoT | `firmware-pentest/` — OWASP FSTM | `reverse-engineering/tools.md` — Ghidra |
| WASM / Python 字节码 / .NET | `reverse-engineering/languages.md` | — |
| macOS / iOS | `mobile-reverse/` | `reverse-engineering/platforms.md` |
| 恶意软件 / 病毒样本 | `malware-analysis/` — YARA/沙箱 | `ida-reverse/` 深入分析 |
| 密码学 / 加密算法 | `reverse-engineering/crypto-decode-tools.md` | — |
| 协议逆向 / 自定义协议 | `reverse-engineering/platforms.md` | `js-reverse/` (HTTP/WebSocket) |
| Go / Rust 二进制 | `reverse-engineering/go-reverse.md` + `languages-compiled.md` | `ida-reverse/` |
| LLM / AI 应用 | `llm-security/` — OWASP LLM Top 10 | — |
| API / REST / GraphQL | `api-security/` — BOLA/JWT/OAuth | `pentest-tools/` |
| 供应链 / SBOM / CI-CD | `supply-chain-security/` | — |
| 完整渗透 / 多阶段攻击 | `attack-chain/` — 攻击链编排 | `pentest-tools/` |
| CTF 竞赛 | `../CTF-Sandbox-Orchestrator/ctf-sandbox-orchestrator/SKILL.md` | — |
| 云 / 容器 / K8s | `../CTF-Sandbox-Orchestrator/competition-agent-cloud/SKILL.md` | — |
| Windows / AD / 域 | `../CTF-Sandbox-Orchestrator/competition-identity-windows/SKILL.md` | — |
| 取证 / PCAP / 隐写 | `../CTF-Sandbox-Orchestrator/competition-forensic-timeline/SKILL.md` | — |

## 按用户意图

| 用户说 | 路由到 |
|--------|--------|
| "反编译 / IDA 分析" | `ida-reverse/SKILL.md` |
| "还原源码 / 反汇编" | `reverse-engineering/SKILL.md` + `ida-reverse/` |
| "Frida hook / 动态注入" | `reverse-engineering/tools-dynamic.md` — Frida 章节 |
| "radare2 / r2 分析" | `radare2/SKILL.md` |
| "找前端签名 / 加密参数" | `js-reverse/SKILL.md` |
| "APK 解包 / 重打包 / 改 smali" | `apk-reverse/SKILL.md` |
| "绕过反调试 / 反检测" | `reverse-engineering/anti-analysis.md` |
| "Go/Rust/Swift 逆向" | `reverse-engineering/go-reverse.md` |
| "内核驱动 / Rootkit" | `reverse-engineering/kernel-driver-reverse.md` |
| "Python 字节码 / pyc" | `reverse-engineering/languages.md` |
| "符号执行 / angr" | `reverse-engineering/tools-dynamic.md` — angr 章节 |
| "CTF 题 / 竞赛逆向" | `reverse-engineering/patterns-ctf.md` |
| "写报告 / 写文档" | `docs-generator/` |
| "渗透测试" | `pentest-tools/SKILL.md` |
| "端口扫描 / 信息收集" | `pentest-tools/SKILL.md` — Nmap 章节 |
| "SQL 注入" | `pentest-tools/SKILL.md` — SQLMap 章节 |
| "密码破解" | `pentest-tools/SKILL.md` — Hashcat/Hydra 章节 |
| "漏洞扫描" | `pentest-tools/SKILL.md` — Nuclei 章节 |
| "供应链安全检查" | `supply-chain-security/SKILL.md` |
| "完整渗透 / 从外打到内" | `attack-chain/SKILL.md` |
| "HW / 攻防演练" | `attack-chain/SKILL.md` |
| "画图 / 流程图 / 架构图" | `diagram-generator/SKILL.md` |
| "符号迁移 / 跨版本对比" | `binary-diff/SKILL.md` |
| "补丁差分 / N-day" | `patch-diff-exploit/SKILL.md` |
| "固件分析 / IoT" | `firmware-pentest/SKILL.md` |
| "EDR 绕过 / 免杀" | `edr-bypass-re/SKILL.md` |
| "Pwn / exploit" | `pwn-chain/SKILL.md` |
| "恶意软件分析" | `malware-analysis/SKILL.md` |
| "移动安全 / APP 测试" | `mobile-reverse/SKILL.md` |
| "API 安全测试" | `api-security/SKILL.md` |
| "LLM 安全 / Prompt 注入" | `llm-security/SKILL.md` |

## 路径交叉（跨模块组合）

| 场景 | 组合方式 |
|------|----------|
| APK 中的 .so 文件需要深入分析 | `apk-reverse/` → `ida-reverse/` 或 `radare2/` |
| 补丁差分后写出 PoC | `patch-diff-exploit/` → `pwn-chain/` |
| 固件中发现 crash | `firmware-pentest/` → `pwn-chain/` |
| JS 逆向需要浏览器操作 | `js-reverse/` → `browser-automation/` |
| 渗透中遇到二进制提权 | `pentest-tools/` → `pwn-chain/` |
| 任务完成后写报告 | 任意 skill → `docs-generator/` |
| 需要画攻击路径图 | 任意 skill → `diagram-generator/` |

## 未命中处理

如果路由矩阵无法匹配用户任务：

1. 联网搜索该领域的方法论和工具
2. 提议新增一个 skill 目录
3. 按 `CONTRIBUTING.md` 的标准创建
4. 更新本路由矩阵

**禁止**将任务硬塞到不匹配的模块中。
