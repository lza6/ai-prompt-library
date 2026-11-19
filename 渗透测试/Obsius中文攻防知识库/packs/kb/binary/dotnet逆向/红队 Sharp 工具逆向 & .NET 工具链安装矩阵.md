---
title: 红队 Sharp 工具逆向与 .NET 工具链安装
summary: Rubeus/SharpHound/Seatbelt 等 C# 红队工具的分析套路、内嵌配置提取；Windows/Linux 工具安装矩阵；dnSpy MCP 集成索引
phase: reverse
vuln_class: [dotnet, redteam-tools]
---

# 红队 Sharp 工具逆向 & .NET 工具链安装矩阵

> 来源：reverse-skill 1.0.1 收编改编（2026-09-30，MIT，见 `../../licenses/`）。
> 红队工具大量用 C# 写（Sharp* 系列），逆向它们是常见场景：理解检测逻辑、改特征、
> 提取内嵌配置。配合技能 [[skills/04-专项/NET逆向手法/SKILL.md|NET逆向手法]]。

## 常见 Sharp* 工具速查

| 工具 | 功能 | 逆向关注点 |
|------|------|-----------|
| **Rubeus** | Kerberos 攻击（AS-REP roast / Kerberoast / S4U / pass-the-ticket） | 工程结构固定，找 `Interop.*` P/Invoke 段看 native 调用 |
| **SharpHound** | BloodHound 数据采集器 | LDAP 查询逻辑、采集的属性集合 |
| **SharpShell / SharpWS** | 远程执行、横向 | WMI / WinRM 调用、命令混淆 |
| **Seatbelt** | 信息收集 | 收集项清单、判断逻辑 |
| **SharpRoast** | Kerberoasting | 票据请求/解析 |
| **Inveigh / SharpSploit** | 中间人 / 通用利用框架 | 反射加载、API 调用链 |

## 通用分析套路

```text
1. dnSpyEx 打开（通常没混淆，少数团队会加 ConfuserEx）
2. 看 Program.Main 或入口命令分发（Rubeus 是 switch(command) 结构）
3. 找目标命令的实现类/方法
4. 看 P/Invoke 段（Interop.* 命名空间）—— native API 调用在这里
5. 提取内嵌资源（有些工具嵌配置/模板）
6. 如需改特征（EDR 规避）：改命令字符串、API 调用、字符串常量
```

### Rubeus 结构示例

```text
入口: Rubeus.CommandLineParser → 解析 args
分派: switch(command) → "kerberoast" → 执行 Ask.TGS(...)
P/Invoke: Rubeus.Interop.Lsa* / Native.cs → native Kerberos API
关键: LsaCallAuthenticationPackage (KERB_RETRIEVE_TKT_REQUEST)
```

改特征（规避）：把命令字符串 `"kerberoast"` 改成自定义名、把 `Rubeus` banner
字符串改掉、改 P/Invoke 调用顺序。

### 内嵌配置提取

很多 loader/工具把 C2、密钥、证书加密嵌在资源或字段：

```powershell
# dnSpyEx 里看 Resources（资源树）
# 或命令行列资源名
powershell -c "[System.Reflection.Assembly]::LoadFile('target.exe').GetManifestResourceNames()"
# 找到资源后 dnSpyEx 右键 → 提取 / Save
```

运行时解密的配置 → 动态断在解密方法返回点 dump 明文（见
[[binary/dotnet逆向/.NET 逆向通用工作流（六阶段 + IL patch）.md|common-workflow.md]]）。

## 工具安装矩阵

### 项目容器（`pentest-box:0.5+`，已内置，无需安装）

CTF / 红队演练绝大多数在项目容器里跑。0.4 起这三件已预装，0.5 增加图像/科学计算栈；**先确认再谈降级**：

| 工具 | 用途 | 调用 |
|---|---|---|
| `monodis` | IL 反汇编（等价 ildasm），纯静态解析 | `monodis target.dll` |
| `pedump` | 元数据/表结构 dump | `pedump --verify metadata target.dll` |
| `ilspycmd` | 直接出 C# 源码，最快 | `ilspycmd target.dll` |
| `dnfile` + `dncil` | 程序化取元数据 / 解全部 opcode | `python3 -c 'import dnfile'` |

三个容易踩的坑（都是实测出来的，不是理论）：

1. **`E: Unable to locate package` ≠ 源里没有**。镜像构建末尾 `rm -rf
   /var/lib/apt/lists/*` 让容器处于无索引态。先 `apt-get update`（国内约 3 分钟，
   要单独给足超时），再装。`mono-utils` 里是 `monodis` + `pedump`；
   **`monop` 在 bookworm 里不存在**。
2. **`dotnet tool install` 在 runtime-only 环境必失败**（`sdk-not-found`）。
   要么装 SDK（+1.2GB），要么直拉 NuGet nupkg 解压后 `dotnet <ilspycmd.dll>` 跑
   —— 后者是镜像采用的做法。
3. **pypi.org 在国内超时**，装 Python 包加 `-i https://pypi.tuna.tsinghua.edu.cn/simple`。
   另外 `recovery.py` 的 pip 白名单**只管宿主 tools/venv**，不约束容器；
   容器内 `pip3 install --break-system-packages` 直接可装。

### Windows（首选，dnSpyEx 是 GUI）

```powershell
# 方式 A：Chocolatey
choco install dnspy ilspy de4dot detect-it-easy

# 方式 B：手动下载 release（推荐，版本可控）
# dnSpyEx:    https://github.com/dnSpyEx/dnSpy/releases
# de4dot:     https://github.com/de4dot/de4dot/releases
# ILSpy:      https://github.com/icsharpcode/ILSpy/releases
# DIE:        https://github.com/horsicq/Detect-It-Easy/releases
# dnlib:      dotnet add package dnlib  (NuGet)
```

### Linux / macOS（无 dnSpyEx GUI，用 CLI）

```bash
# ILSpy CLI 反编译 —— **需要 SDK**；runtime-only 会报 sdk-not-found
dotnet tool install -g ilspycmd
ilspycmd target.exe -p -o outdir/         # 反编译到目录

# 只有 runtime 时的替代：直拉 nupkg 解压后直接跑（镜像用的就是这个办法）
curl -fsSL -o /tmp/i.nupkg \
  https://api.nuget.org/v3-flatcontainer/ilspycmd/9.1.0.7988/ilspycmd.9.1.0.7988.nupkg
unzip -qo /tmp/i.nupkg -d /opt/ilspy
dotnet /opt/ilspy/tools/net8.0/any/ilspycmd.dll target.exe

# mono 系的 monodis（不需要 dotnet，纯静态）
sudo apt install mono-utils             # 先 apt-get update，否则 "Unable to locate"

# de4dot 跨平台（需 mono 或 dotnet）
dotnet de4dot.dll target.exe -o target-clean.exe

# dnlib（脚本化，需 dotnet SDK）
dotnet new console -o dnclean && cd dnclean
dotnet add package dnlib

# DIE CLI (diec)：从 https://github.com/horsicq/Detect-It-Easy 装
diec target.exe

# .NET runtime 前置
sudo apt install dotnet-runtime-8.0       # Linux；macOS: brew install --cask dotnet-sdk
```

> dnSpyEx（带 IL 编辑器 + 调试器）只有 Windows GUI 版。Linux/macOS 做 .NET 逆向
> 只能 `ilspycmd` 反编译 + `dnlib` 脚本 patch，无等价交互调试 GUI。需要 patch 时
> 优先上 Windows。

## dnSpy MCP 集成索引

社区已有多个 dnSpy MCP 项目，把 dnSpy 的反编译/IL 检查暴露成 MCP 工具：

| 项目 | 特点 |
|------|------|
| soufianetahiri/dnspy-mcp | 核心 MCP Server，暴露 decompile、IL inspection 等 |
| AgentSmithers/DnSpy-MCPserver-Extension | 作为 dnSpyEx 扩展运行，深度集成 GUI |
| malwarecakefactory/dnspy-mcp-extension | 33 个工具，覆盖 triage → deobfuscation 全流程 |

注册方式（按对应项目 README 装 dnSpyEx 扩展后在 MCP 配置注册，command/args 以
项目 README 为准）：

```json
{
  "mcpServers": {
    "dnspy": {
      "command": "dotnet",
      "args": ["path/to/dnspy-mcp.dll"]
    }
  }
}
```

> dnSpy MCP 需用户手动安装扩展并注册；平台侧若注册了对应 MCP 后端，可在
> MCPBackend 别名表加 `dnspy_decompile` / `dnspy_inspect_il` 接入工具面。

## 社区资源索引

- **Washi 博客** — https://blog.washi.dev/posts/misconceptions-about-dotnet/
  （核心观点：不要过度依赖 dnSpy 的 C# 反编译器，要熟悉 IL 编辑器）
- **dnSpyEx** — https://github.com/dnSpyEx/dnSpy（dnSpy 活跃维护分支）
- **de4dot** — https://github.com/de4dot/de4dot；**dnlib** — https://github.com/dnlib/dnlib
- Medium《De-obfuscating and reversing a .NET/C# spyware》— info-stealer 脱混淆实战
- 看雪论坛 .NET 逆向版块、Guided Hacking《Top 5 .NET Reverse Engineering Tools》
