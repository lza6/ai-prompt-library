# 逆向/渗透/安全任务自动路由规则（Kali Linux 版）

> 本文件是 Kali Linux 平台的规则源。核心逻辑与根目录 RULES.md 一致，但针对 Kali 环境做了适配。

---

## 与 Windows 版的差异

1. **大量工具预装**：nmap、sqlmap、hashcat、hydra、metasploit、radare2、binwalk、burpsuite 等无需 bootstrap
2. **apt 统一管理**：不需要 winget，不需要手动解压 ZIP
3. **bash 原生**：脚本更简洁，无 PowerShell 依赖
4. **路径规范**：`/usr/bin/`、`/usr/local/bin/`

## CRITICAL: 读完本文件后立即执行

```
0. NOW: 读取 <包根目录>/skills/field-journal/precedent-auth.md
1. NOW: 检测本文件所在目录 → 包根目录，记住路径
2. NEXT: 读 <包根目录>/skills/routing.md → 匹配用户意图 → 确定入口 skill
3. ACT: 开始执行任务
```

## 工具自举（Kali 版）

```bash
bash <包根目录>/kali/scripts/bootstrap-reverse.sh --capability 工具名
```

## 快速初始化

```bash
bash <包根目录>/kali/scripts/quick-setup.sh
```

## 其他规则

与根目录 RULES.md 相同，包括：
- 触发关键词
- 行为链（步骤 0-14）
- 安全边界
- 指令语义级别
