# Cybersecurity Skill Router — Kali Linux 专供版

> 针对 Kali Linux 深度优化的安全技能路由系统

## 快速开始

```bash
# 克隆项目
git clone https://github.com/YOUR_USERNAME/cybersec-skill-router.git
cd cybersec-skill-router

# 一键初始化
bash kali/scripts/quick-setup.sh

# 验证工具状态
bash kali/scripts/tool-discovery.sh
```

## Kali 特点

- **大量工具预装**：nmap、sqlmap、hashcat、hydra、metasploit、radare2、binwalk 等
- **apt 统一管理**：`sudo apt install xxx` 即可
- **bash 原生脚本**：无 PowerShell 依赖
- **路径规范**：`/usr/bin/`

## 工具自举

缺失工具自动安装：
```bash
bash kali/scripts/bootstrap-reverse.sh --capability jadx,frida,pwntools
```

## 查看所有支持的工具

```bash
bash kali/scripts/bootstrap-reverse.sh --list
```

## 注入 AI 规则

在 `~/.bashrc` 或 AI 客户端配置中添加：
```
读取 /你的路径/kali/RULES-kali.md 并执行
```
