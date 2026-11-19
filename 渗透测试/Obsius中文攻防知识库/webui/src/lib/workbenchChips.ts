// 工作台快捷建议 chips（按轨配置，2026-10-30）：
// 智能体工作台底部输入区上方的「快捷建议」行，内容按场景轨分开配置——
// 渗透/红队轨给资产推进建议（去重、补测），CTF 轨换成做题环境反馈与
// 知识库迭代（2026-10-30 用户裁决）。
// 这是纯 UI 偏好：localStorage 持久化，改动即存，跨刷新保留；
// 不落 packs/后端——核心侧不消费这些文本，只是发给 agent 的快捷话术。

const KEY = "ui.workbench-chips"

/** 变更事件：设置页保存后广播，工作台即时刷新当前轨的 chips */
export const CHIPS_CHANGED_EVENT = "workbench-chips-changed"

/** 各轨默认快捷建议。`default` 是未登记轨的兜底（含 track 为空时）。 */
export const DEFAULT_CHIPS: Record<string, string[]> = {
  // 渗透/红队等资产轨：资产去重 + 补测未完资产
  pentest: ["对资产进行去重", "对未测尽的资产继续进行测试"],
  redteam: ["对资产进行去重", "对未测尽的资产继续进行测试"],
  // CTF 轨：做题环境反馈 + 知识库迭代（用户 2026-10-30 裁决：润色为祈使句）
  ctf: ["汇报做题过程中遇到的环境问题", "评估是否需要迭代知识库"],
  default: ["对资产进行去重", "对未测尽的资产继续进行测试"],
}

/** 轨道名规范化：空/未知轨落到 default 兜底 */
function norm(track?: string | null): string {
  const t = (track ?? "").trim().toLowerCase()
  return t || "default"
}

function readAll(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, string[]>
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, string[]>) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 存储受限时本次会话仍生效（设置页内 state 已更新）
  }
  window.dispatchEvent(new CustomEvent(CHIPS_CHANGED_EVENT))
}

/** 某轨生效的 chips：用户配置优先，未配置回落到该轨默认。 */
export function getChips(track?: string | null): string[] {
  const t = norm(track)
  const all = readAll()
  return all[t] ?? DEFAULT_CHIPS[t] ?? DEFAULT_CHIPS.default
}

/** 全部轨生效的 chips（含默认回落的合并视图）——设置页展示用。 */
export function getAllChips(): Record<string, string[]> {
  const all = readAll()
  const out: Record<string, string[]> = {}
  for (const t of new Set([...Object.keys(DEFAULT_CHIPS), ...Object.keys(all)])) {
    out[t] = all[t] ?? DEFAULT_CHIPS[t] ?? DEFAULT_CHIPS.default
  }
  return out
}

/** 保存某轨 chips 并广播变更。空列表 = 明确不显示该轨的建议（不回落到默认）。 */
export function setChips(track: string | null, chips: string[]) {
  const t = norm(track)
  const all = readAll()
  const cleaned = chips.map((s) => s.trim()).filter(Boolean)
  // 与默认一致就不落键：保持「未配置」语义，改动默认时无需清理存量
  if (JSON.stringify(cleaned) === JSON.stringify(DEFAULT_CHIPS[t] ?? DEFAULT_CHIPS.default)) {
    delete all[t]
  } else {
    all[t] = cleaned
  }
  writeAll(all)
}

/** 恢复某轨默认（删除该轨的自定义配置）。 */
export function resetChips(track: string | null) {
  const all = readAll()
  delete all[norm(track)]
  writeAll(all)
}
