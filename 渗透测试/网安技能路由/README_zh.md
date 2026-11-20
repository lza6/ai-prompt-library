# 逆向/渗透/安全技能路由包

> AI 自动路由 + 按需自举工具链 + 自动进化经验库
>
> 支持 Claude Code / Kiro / Cursor / Cline / Windsurf / Codex CLI

[English](README.md) | [中文](README_zh.md)

---

## 这是什么

一套给代码 AI 客户端使用的**网络安全技能路由包**。不是单个工具，而是完整的方法论 + 工具链 + 经验进化系统。

解决两件事：
1. **AI 路由**：让 AI 遇到逆向/渗透/CTF 任务时走对方法论，不乱猜
2. **工具编排**：把本机工具、MCP、脚本、工作流收敛成可复用目录

## 快速开始

```bash
git clone https://github.com/xiarongwen/cybersec-skill-router.git
cd cybersec-skill-router
```

注入规则到 AI 客户端：

| 客户端 | 位置 | 方式 |
|--------|------|------|
| Claude Code | `~/.claude/CLAUDE.md` | 追加：`读取 /你的路径/RULES_zh.md 并执行` |
| Kiro | `~/.kiro/steering/` | 复制 `.kiro/steering/reverse-routing.md` |
| Cursor | Settings → Rules | 粘贴精简版规则 |
| Cline | Settings → Custom Instructions | 粘贴精简版规则 |

然后直接说安全任务，AI 自动路由。

## 目录结构

```
cybersec-skill-router/
├── RULES.md / RULES_zh.md       # 核心行为链规则
├── ARCHITECTURE.md              # 系统架构图
├── skills/                      # 主技能目录
│   ├── SKILL.md                 # 总控入口
│   ├── routing.md               # 路由矩阵
│   ├── scripts/                 # 自举脚本
│   ├── field-journal/           # 经验库
│   ├── reverse-engineering/     # 通用逆向
│   ├── apk-reverse/             # APK 逆向
│   ├── ida-reverse/             # IDA Pro MCP
│   ├── js-reverse/              # JS 逆向
│   ├── radare2/                 # radare2 CLI
│   ├── pentest-tools/           # 渗透测试
│   ├── pwn-chain/               # RE→exploit
│   ├── attack-chain/            # 攻击链编排
│   ├── firmware-pentest/        # 固件渗透
│   ├── edr-bypass-re/           # EDR 绕过
│   ├── binary-diff/             # 符号迁移
│   ├── patch-diff-exploit/      # N-day
│   ├── browser-automation/      # 浏览器自动化
│   ├── mobile-reverse/          # 移动逆向
│   ├── malware-analysis/        # 恶意软件
│   ├── llm-security/            # LLM 安全
│   ├── api-security/            # API 安全
│   ├── supply-chain-security/   # 供应链安全
│   ├── docs-generator/          # 报告生成
│   └── diagram-generator/       # 图表生成
├── CTF-Sandbox-Orchestrator/    # CTF 全栈 (40+)
├── burp-mcp-full/               # BurpSuite MCP
└── kali/                        # Kali 适配层
```

## 核心设计

```
用户任务 → 关键词触发 → 路由矩阵 → 工具检查 → 按需安装 → 执行 → 经验沉淀
```

### 路由矩阵（三维匹配）

| 维度 | 示例 |
|------|------|
| 目标类型 | APK / 二进制 / JS / 固件 / CTF / Web |
| 用户意图 | 反编译 / Hook / 抓包 / 渗透 / 写报告 |
| 工具链 | IDA / radare2 / Frida / Nmap / Playwright |

### 自动进化

```
完成任务 → 写 field-journal → 更新索引
下次同类任务 → 查经验库 → 复用方案
```

### 按需自举

不需要预装所有工具。AI 执行中发现缺失时自动调 bootstrap 安装。

## License

[MIT License](LICENSE)
