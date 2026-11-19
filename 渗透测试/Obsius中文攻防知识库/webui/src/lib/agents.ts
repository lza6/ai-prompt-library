// 智能体选择口径（2026-10-26 抽出）。
//
// 背景：原先 `pickAgent()` 是 `AgentWorkbenchView` 的内部函数，而 `App` 的项目首屏
// 闸门自己写了个 `availableAgents[0]?.id` —— 两者对同一项目会挑出**不同的**智能体。
// 实测 CTF 项目：agents 顺序是 `[aggressive-controller, artex-controller, …,
// ctf-controller, …]`，闸门预热 `aggressive`（0 条线程），工作台实际选
// `ctf`（7 条线程）—— 闸门等的是错的那个，等于白等，用户看到「进去后没有会话线程」。
//
// 所以这套口径必须是**单一来源**，任何要「提前猜会用哪个智能体」的地方
// （首屏预热、深链跳转、事件路由）都从这里取，不许再各自 `[0]`。
import type { ChatAgent } from "./types"

/** 默认智能体 = 渗透测试主控（原 chat-orchestrator，2026-10-25 改名）。 */
export const ORCHESTRATOR = "pentest-controller"

/** 控制器类智能体（与后端 CONTROLLER_IDS 同序同集合）：头像/图标按它们分档。
 *  dev-controller（软件开发主控）2026-10-30 归入——与后端一致，主控恒优先。 */
export const CONTROLLER_IDS = [ORCHESTRATOR, "ctf-controller", "aggressive-controller",
                               "artex-controller", "dev-controller"] as const

export const isControllerAgent = (id: string) => (CONTROLLER_IDS as readonly string[]).includes(id)

/**
 * 从列表里挑初始/回退智能体：优先渗透测试主控 → 其它控制器 → 首项。
 *
 * **为什么不能直接用 `list[0]`**：`GET /api/chat/agents` 的顺序由轨内专家池决定，
 * CTF 项目首项是 `aggressive-controller`（不是它的主控 `ctf-controller`）。挑错
 * 智能体不只是列表空 —— 发消息也会因为线程归属不符而对不上。
 */
export function pickAgent(list: ChatAgent[]): string {
  for (const id of CONTROLLER_IDS) {
    if (list.some((a) => a.id === id)) return id
  }
  return list[0]?.id ?? ORCHESTRATOR
}
