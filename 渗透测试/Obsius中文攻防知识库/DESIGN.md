# cyberstrike-pro 设计文档（索引）

> 2026-11-02 起按功能模块拆分，并对照代码压缩更新。**具体契约以各分册为准**，本文只保留定位、架构、硬约束与索引。
>
> 旧版单文件 1,019 行 / 232KB（最后更新 2026-10-25，已落后 10-31~11-02 的 CTF 主控 / 线程模型 / LLM 故障转移等改动）已拆到 `docs/design/`。

## 项目定位

AI 驱动的全能安全平台：CTF 解题 / 渗透测试 SRC / 红队 / 逆向 Pwn / IoT 工控车联网 / 恶意样本分析。

**核心差异点**：原生 Windows 优先，按能力自动降级 Docker / WSL2。

## 总体架构

```
WebUI (React + TS + Vite)
      │ HTTP / WS
core API (FastAPI, 127.0.0.1:8420)
  ├─ chat      对话主控 + 专家子线程（现行主线）
  ├─ agent     会话引擎（单步流水线 / 卡死升级 / 收尾）
  ├─ ctf       CTF 主控内核（方向台账 / flag 台账 / 线程池）
  ├─ blackboard SQLite WAL 单一写入口
  ├─ llm       供应商路由 + 跨供应商故障转移
  ├─ skills    场景轨 × 知识方向 / 专家池 / 提案
  ├─ runtime   执行网关（host / wsl / docker）
  └─ intel     情报抓取与周计划
```

`core/team`、任务队列（`tasks` / `resource_leases`）已于 2026-10-06 退役，仅保留遗留执行载体与存量数据读取。

## 开发硬约束

| 约束 | 说明 |
|---|---|
| 单一写入口 | 黑板所有写操作必须经 core API / Blackboard，禁止旁路直写 |
| 执行隔离 | 不可信代码只允许 Docker 执行（WSL 信任级 = 宿主机）|
| 安全默认 | 未知样本默认恶意处理（L3 沙箱 + fakenet）|
| 网关拦截 | Agent 无裸 shell，一切命令经 `run(cmd, runtime)` + 服务端策略校验 |
| 工具面双边 | schema 可见 ↔ 白名单可执行，必须同时有/同时无 |
| 文档随代码 | 改行为必须同步对应分册；本文不写细节 |

## 模块索引

| 分册 | 内容 | 关键真源 |
|---|---|---|
| [00-overview.md](docs/design/00-overview.md) | 定位、架构、技术栈、目录、部署形态 | 本文同源 |
| [01-agent-system.md](docs/design/01-agent-system.md) | 单步流水线、SessionState、卡死升级、收尾、思考流快照 | `core/agent/`、`core/chat/runtime.py` |
| [02-blackboard.md](docs/design/02-blackboard.md) | 数据模型（SCHEMA_VERSION=54）、单一写入口、并发、事件流 | `core/blackboard/` |
| [03-orchestrator.md](docs/design/03-orchestrator.md) | 五类主控、调度/审批/饿死、子线程上限与台账、池脉冲 | `core/chat/runtime.py`、`core/orchestrator/` |
| [04-ctf.md](docs/design/04-ctf.md) | CTF 内核、主控分诊、方向/flag 台账、子线程纪律、前端退役项 | `core/ctf/`、`packs/experts/ctf-controller.yaml` |
| [05-pentest.md](docs/design/05-pentest.md) | 意图/链路图、发现格式、资产导入与三态、回收站 | `core/blackboard/`、`core/agent/tools.py` |
| [06-skills.md](docs/design/06-skills.md) | 场景轨 × 知识方向、技能清单 + `skill_open`、专家池、提案制 | `core/skills/`、`packs/` |
| [07-runtime.md](docs/design/07-runtime.md) | 隔离模型、容器/代理/浏览器、网关流水线、双层权限 | `core/runtime/` |
| [08-llm.md](docs/design/08-llm.md) | 协议统一、ProviderStore、三角色路由、**跨供应商轮询兜底**、思考流 | `core/llm/` |
| [09-frontend.md](docs/design/09-frontend.md) | 骨架、实时层、事件渲染、链路画布、CTF tab 退役与滚动修复 | `webui/src/` |
| [10-deployment.md](docs/design/10-deployment.md) | 三种部署形态、脚本、端口、数据目录、测试与文档制度 | `scripts/` |
| [11-reverse.md](docs/design/11-reverse.md) | 逆向工作台、`analyze_sample`、IDA-MCP 仅工作台、蓝图 | `core/tools/decompiler.py` |
| [12-tools.md](docs/design/12-tools.md) | 工具注册表、MCP 接入、反编译双通道、双向写回 | `core/agent/tool_registry.py`、`config/mcp.json` |
| [13-intel.md](docs/design/13-intel.md) | 情报存储/抓取/打分/vault/周计划 | `core/intel/` |

## 维护约定

1. 新功能 / 机制变更：先改对应分册，再按需在模块 `CLAUDE.md` 留实现细节。
2. 单册控制在 ~150 行以内；事故复盘只留「结论 + 真源」，长故事放 `docs/plans/` 或提交说明。
3. 已退役机制只保留一行「退役时间 + 替代方案」，不要继续展开。
