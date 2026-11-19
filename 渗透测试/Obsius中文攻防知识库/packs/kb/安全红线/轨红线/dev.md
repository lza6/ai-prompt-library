# 项目开发轨红线（永久强制，优先级最高）

> 与任何 skill / 知识库冲突时以本文件为准。

## 工作区边界

1. **写操作不得越出执行工作区**：正式代码直接写工作区文件（工作区内全权读写）；
   工作区外路径（系统目录、家目录、盘符根、平台数据目录）一律不写——网关
   pathguard 会拦，自己也不要尝试绕过或变体规避。
2. **平台数据目录禁当工作区**：黑板 / artifacts / sample_packages 元数据固定在
   项目内，不得把平台内部目录设为执行工作区，也不得写进用户原始目录以外的地方。
3. **下载/第三方代码按不可信处理**：从外部拉取的代码（pip/npm/脚本）若需执行，
   threat_class=untrusted 走 docker/sandbox 容器，不得 host 直跑；只有自己写的、
   任务范围内的代码可按 trusted 在 host/wsl 执行。

## 执行环境（run-cmd-dev-host，2026-10-30）

1. **run_cmd 一律 runtime=host（Windows 本地）**：dev 轨工作区是 Windows 盘项目根
   （40 万+ 文件），docker bind mount / wsl /mnt 跨 Linux 边界访问它 stat 慢 300 倍
   （实测 git status：host 3.6s、docker >20s 被杀、wsl 1m52s）——全量 git status /
   find / grep -r 在 docker/wsl 下必然超时。grep 用 `git grep`/Select-String、find 用
   Get-ChildItem -Recurse 或 python 脚本；**确实需要 Linux 专属工具时才显式 docker**。

## 危险命令审批（网关强制，配合执行）

1. **命中「[危险命令需人工审批]」必须等待批准**：批准后用 run_cmd 的 approval_id
   重试该命令（一次性，执行后失效）；批准前不得换词变体、拆段、改参数绕过。
2. **结构性破坏一律先申请**：rm -rf 根/家/盘符根、git reset --hard / clean -fd /
   force push / branch -D / stash drop、关机重启、DROP/无 WHERE DELETE、格式化磁盘
   等不可逆操作，即使不打算做也别批量演练。

## Git 与交付纪律

1. **提交前自查**：git status/diff 确认变更范围与预期一致；commit message 写清
   「改了什么 / 为什么」；**不得把敏感凭据（密钥、token、.env）提交进版本库**。
2. **不破坏运行中平台**：修改平台自身代码时，先声明意图确认改动边界，改完跑
   构建/测试验证再收尾；不擅自杀平台进程、删平台数据库文件。
