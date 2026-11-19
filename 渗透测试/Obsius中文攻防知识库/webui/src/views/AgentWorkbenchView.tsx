import {
  useCallback, useEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { createPortal } from "react-dom"
import {
  AlertTriangle, Bot, Check, ChevronDown, ChevronRight, CircleSlash, Clock3, Cpu, FolderOpen, Gauge, Globe,
  Loader2, Plug, Plus, RefreshCw, RotateCcw, Send, Sparkles, Square, Trash2,
  Wrench, X, Zap,
} from "lucide-react"
import { api, ApiError, errText } from "@/lib/api"
import { MAX_DROPPED_FILES, collectDroppedFiles } from "@/lib/folderDrop"
import { insertSampleRefText, readSampleDrop } from "@/lib/samples"
import type { SampleDragRef } from "@/lib/samples"
import { ORCHESTRATOR, isControllerAgent, pickAgent } from "@/lib/agents"
import type {
  AttachmentInfo, ChatAgent, ChatMcpServer, ChatMessage, ChatThread, ChatThreadChild,
  ChatThreadError,
  ModelInfo, Asset, ChallengeFlag,
} from "@/lib/types"
import type { Approval, DecideApprovalResult, ProjectDetail } from "@/lib/types"
import { MarkdownView } from "@/components/settings/MarkdownView"
import { WorkbenchContextRail } from "@/components/workbench/WorkbenchContextRail"
import { ActivityGroup } from "@/components/chat/ActivityGroup"
import { ApprovalCard } from "@/components/chat/ApprovalCard"
import { DirectoryPickerDialog } from "@/views/reverse/DirectoryPickerDialog"
import { AttachmentChipRow } from "@/components/chat/AttachmentChip"
import { CandidateFlagCard } from "@/components/chat/CandidateFlagCard"
import { FileCardList } from "@/components/chat/FileCard"
import { ChatStats } from "@/components/chat/ChatStats"
import { SystemNote } from "@/components/chat/SystemNote"
import { ThinkingBlock } from "@/components/chat/ThinkingBlock"
import { useCandidateFlags } from "@/lib/useCandidateFlags"
import { usePendingApprovals } from "@/lib/usePendingApprovals"
import { mergeTargets, targetsFromProse, targetsFromTool, type FileTarget } from "@/lib/fileTargets"
import type { ActivityStep } from "@/lib/activity"
import { parseTs, fmtDateTime } from "@/lib/datetime"
import { EFFORT_GEARS, EFFORT_DEFAULT, EFFORT_HINT, EFFORT_LABEL, gearIndex,
         normalizeGear, type EffortGear } from "@/lib/effort"
import { cn } from "@/lib/utils"
import { paneMaxWidth } from "@/lib/paneWidth"
import {
  chatDraftKey, chatWorkbenchDraft, chatWorkbenchStateForProject,
  saveChatWorkbenchDraft, selectChatWorkbenchAgent, selectChatWorkbenchThread,
  type ChatWorkbenchState,
} from "@/lib/chatWorkbenchDrafts"
import { useNavRailSlot } from "@/lib/navRail"
import { useEvents, type ThinkingFrame } from "@/lib/useEvents"
import { CHIPS_CHANGED_EVENT, getChips } from "@/lib/workbenchChips"

// 智能体工作台（K9，2026-09-29）：对话式挖洞入口（蛙池式）。
// K9-UI（2026-09-29）：蛙池式结构语言 × 深色黑客风精修——左栏 agent 切换 +
// 线程列表、中栏时间线、底部输入大卡片（agent pill + 胶囊能力钮 + 渐变发送/停止）。
// **会话流改造（2026-10-03，cc-haha 风格）**：中栏时间线由「气泡 + 卡片 + 逐个工具块」
// 改为**无气泡 prose + 折叠活动摘要 + 文件卡**——用户消息一行 `❯`、agent 叙述平铺
// markdown、一轮内连续工具调用折成一行灰色摘要（`components/chat/ActivityGroup`）、
// 叙述提到的文件渲染为卡片（`components/chat/FileCard`）、顶部统计行
// （`components/chat/ChatStats`）。左栏/底部 dock/右栏不动。样式集中在
// index.css `.wb-*` 段（会话流部分已迁至 Tailwind 工具类，见 components/chat/CLAUDE.md）；
// 动效尊重 prefers-reduced-motion。左栏分割线可拖宽（180–420px，键盘 ←/→ 微调）。
// 数据链路不变：REST 2s 轮询为主，chat.delta 事件做实时输入行增强。

// 默认智能体 / 控制器集合 / `pickAgent()` 已抽到 `@/lib/agents`（2026-10-26）：
// 项目首屏闸门（App.bootstrap）和工作台必须用**同一套口径**，否则闸门预热的是
// `list[0]`、工作台选的是控制器，两者对 CTF 项目不是同一个智能体 —— 闸门等于白等，
// 用户看到「进去后没有会话线程」。见 lib/agents.ts 的文件头注释。
type PanelTab = "agents" | "skills" | "mcp" | null
type SlashState = { mode: "menu" | "skills" | "mcp" }
/** 待发附件（粘贴/拖拽即上传；chip 三态 + 分片进度） */
type PendingFile = {
  key: string
  status: "queued" | "uploading" | "ready" | "error"
  name: string
  size: number
  file: File
  att?: AttachmentInfo
  /** 已上传字节（分片通道逐片推进；小文件一次到位=size） */
  loaded?: number
  error?: string
  retryable?: boolean
}

// 斜杠命令（K9-C）；CTX_LIMIT：上下文窗口分母，默认按 256K 计
const CTX_LIMIT = 256 * 1024
const SLASH_COMMANDS = [
  { cmd: "/context", desc: "查看当前上下文用量明细" },
  { cmd: "/skill", desc: "选择技能，人类本轮指定优先使用" },
  { cmd: "/mcp", desc: "指定 MCP server，本轮优先使用其工具" },
]

const ASIDE_MIN = 180
const ASIDE_DEFAULT = 236
// 左栏最大宽动态取「容器 − 主区保底 − 右栏占位」（见 lib/paneWidth）
const ASIDE_RESERVE = [".wb-rail, .wb-rail-handle"]
const ASIDE_RESERVE_EXTRA = 16

export function AgentWorkbenchView({ pid, meta, focusThread, onFocusConsumed, onThreadChange,
                                    workbenchState, onWorkbenchStateChange }: {
  pid: string; meta: ProjectDetail | null
  /** 外部（蓝图产出入口 goto-agents）指定要打开的线程 id；消费后回调清空 */
  focusThread?: string | null
  onFocusConsumed?: () => void
  /** 当前选中线程 id 上报顶栏。 */
  onThreadChange?: (tid: string | null) => void
  /** App 壳内存态；跨工作台卸载保留草稿与选择，不跨页面刷新。 */
  workbenchState?: ChatWorkbenchState | null
  onWorkbenchStateChange?: (state: ChatWorkbenchState) => void
}) {
  const [agents, setAgents] = useState<ChatAgent[]>([])
  // 初值只是**猜测**（本轨可能没有 pentest-controller）。真正的选择由下面
  // `chatAgents` 回来后按 `pickAgent()` 定；在 `agentConfirmed` 之前不发任何
  // 线程请求，否则会拿猜的 id 打一次必空的请求（见 agentConfirmed 处注释）。
  const [agentId, setAgentId] = useState<string>(() => workbenchState?.pid === pid
    ? workbenchState.agentId : ORCHESTRATOR)
  const [threads, setThreads] = useState<ChatThread[]>([])
  // 会话线程列表是否**至少完成过一次请求**（2026-10-26）：用来区分「还在加载」与
  // 「确实没有线程」。缺了它，首屏那几十~几百毫秒会把空数组直接渲染成
  // 「暂无线程，发送消息或点『新建』」——那是一句断言，不是过程提示，用户读到的
  // 就是「进去了但没有会话」。失败也算「已尝试」（否则骨架屏永远转）。
  const [threadsLoaded, setThreadsLoaded] = useState(false)
  const [tid, setTid] = useState<string | null>(() => workbenchState?.pid === pid
    ? workbenchState.tid : null)
  const [thread, setThread] = useState<ChatThread | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  // 快捷建议 chips（按轨配置，2026-10-30）：设置页「快捷建议」按轨维护；
  // 这里读当前项目轨的生效值，并监听设置页改动即时刷新。渲染在 flag 卡
  // 下方、输入框上方（用户 2026-10-30 裁决排版：flag 卡在上、建议在下）。
  const [chips, setChips] = useState<string[]>(() => getChips(meta?.track))
  useEffect(() => {
    const refresh = () => setChips(getChips(meta?.track))
    refresh()
    window.addEventListener(CHIPS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(CHIPS_CHANGED_EVENT, refresh)
  }, [meta?.track])
  // 当前线程 id 上报顶栏（2026-10-26，顶栏「会话 ID」胶囊）。
  // App 侧传的是 setActiveTid，引用恒定，不会因重渲反复触发。
  useEffect(() => { onThreadChange?.(tid) }, [tid, onThreadChange])
  const [workDir, setWorkDir] = useState<string | null>(null)
  // 打开项目/切换主控即拉当前生效执行工作区（2026-10-30；2026-11-02 线程级）：
  // 带 tid 请求，避免同一项目里第二个主控改目录后，切回第一个仍显示别人的路径。
  useEffect(() => {
    let alive = true
    api.workspacePath(pid, tid).then((r) => {
      if (alive) setWorkDir(r.exec_workspace || null)
    }).catch(() => { /* 后端未通先保持 null，轮询/设置后自会补上 */ })
    return () => { alive = false }
  }, [pid, tid])
  // 2026-10-30：对话框「工作区」弹层（选择外部目录为执行工作区 / 恢复默认）
  const [wsOpen, setWsOpen] = useState(false)
  const applyWorkspace = useCallback(async (dir: string | null) => {
    try {
      const r = await api.setWorkspaceDir(pid, dir, tid)
      setWorkDir(r.exec_workspace ? r.exec_workspace : null)
      setWsOpen(false)
      setErr(null)
      // 有线程则重拉 chatThread（其 work_dir 与后端一致）；无线程直接靠上面的 set 已更新
      reloadRef.current?.()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [pid, tid])
  const [input, setInput] = useState(() => workbenchState?.pid === pid
    ? chatWorkbenchDraft(workbenchState, workbenchState.agentId, workbenchState.tid) : "")
  // 草稿绑定的同步 ref（2026-11-01 bug 修复）：切换会话/待办跳转/发送等异步
  // 路径保存草稿时读它，避免读到 React 状态未刷新的旧 input——否则插话内容会
  // 串进别的会话草稿，切回来又显示在输入框。
  const inputStateRef = useRef(input)
  useEffect(() => { inputStateRef.current = input }, [input])
  const workbenchStateRef = useRef(workbenchState)
  useEffect(() => { workbenchStateRef.current = workbenchState }, [workbenchState])
  const publishWorkbenchState = useCallback((next: ChatWorkbenchState) => {
    workbenchStateRef.current = next
    onWorkbenchStateChange?.(next)
  }, [onWorkbenchStateChange])
  useEffect(() => {
    if (!onWorkbenchStateChange) return
    const base = chatWorkbenchStateForProject(workbenchStateRef.current, pid, agentId)
    const currentDraft = chatWorkbenchDraft(base, agentId, tid)
    if (base.agentId !== agentId || base.tid !== tid || currentDraft !== input) {
      publishWorkbenchState(saveChatWorkbenchDraft(base, agentId, tid, inputStateRef.current))
    }
  }, [pid, agentId, tid, input, workbenchState, onWorkbenchStateChange, publishWorkbenchState])
  const [sending, setSending] = useState(false)
  // 停止请求已发出、但后端轮次尚未退出（2026-10-20）：此前点「停止」后按钮
  // 原样不动，而传输层重试退避最长要等 30s 才生效，用户以为按钮失灵。
  // 现置 stopping 让按钮立刻变「停止中…」并禁用，直到 running 转 false。
  const [stopping, setStopping] = useState(false)
  const [pendingIn, setPendingIn] = useState<string | null>(null)
  // 已投递但还没被读到的人类插话（chat-hit，2026-10-21）：主控正在跑，
  // 消息进了通知箱等它自己读。展示成一条淡提示，让用户知道「收下了」而不是
  // 「没发出去」——此前这里会 409 报错，用户以为功能坏了。
  const [hitQueued, setHitQueued] = useState<string | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [err, setErr] = useState<string | null>(null)
  /** 拖拽文件夹时的「正在扫描…」提示（不是错误态，单独存，不挤 err） */
  const [dropping, setDropping] = useState<string | null>(null)
  const [panel, setPanel] = useState<PanelTab>(null)
  const [refsDraft, setRefsDraft] = useState<{ skills: string[]; mcps: string[] }>({ skills: [], mcps: [] })
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [slash, setSlash] = useState<SlashState | null>(null)
  const [usageOpen, setUsageOpen] = useState(false)
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const [mcpServers, setMcpServers] = useState<ChatMcpServer[]>([])
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  // 线程级模型（v37，2026-10-13）：modelInfo=全局供应商/模型清单（懒拉一次）；
  // modelDraft=新建态（tid=null）的选择，创建线程时随 ChatThreadIn 带上。
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null)
  const [modelPopOpen, setModelPopOpen] = useState(false)
  // 浮层内的供应商/模型列表是否展开（v48）：默认收起，只显示当前模型一行，
  // 点它才展开——浮层主角是深度滑块，模型列表是次级操作。
  const [modelListOpen, setModelListOpen] = useState(false)
  const [popProvider, setPopProvider] = useState("")
  const [modelDraft, setModelDraft] = useState<{ provider: string; model: string } | null>(null)
  // 思考深度草稿（v48，thinking-effort，2026-10-21）：新建态（尚未建线程）时先存
  // 在这里，建线程一并带上——与 modelDraft 同口径。''=跟随供应商配置。
  const [effortDraft, setEffortDraft] = useState<string>("")
  // 联网搜索开关（v43，web-search-toggle，2026-10-19）：线程级；新建态草稿
  // （同 modelDraft 口径，创建线程时带上）。开 = 本线程主控 + spawn 子代理
  // 默认可用 web_search（SearXNG/ddgs 双后端）；不进专家工具勾选。
  const [webSearchDraft, setWebSearchDraft] = useState(false)
  const [asideWidth, setAsideWidth] = useState(ASIDE_DEFAULT)
  const [dragging, setDragging] = useState(false)
  const dragOrigin = useRef<{ x: number; w: number } | null>(null)
  const splitterRef = useRef<HTMLDivElement>(null)

  // 左栏停靠（2026-10-16）：左导航列下半留了空槽位时，把 agent 切换器 + 会话线程列表
  // portal 过去，与左导航共用同一列（主区因此多出整列宽，见 lib/navRail.ts）。
  // 槽位不存在（窄栏 / 侧栏收起 / 非 agents 视图）→ docked=false，走原来的两列布局。
  const railSlot = useNavRailSlot()
  const docked = !!railSlot

  // 左栏可拖到的最大宽（动态：容器 − 主区保底 − 右栏占位）
  const maxAside = useCallback(
    () => paneMaxWidth(splitterRef.current, ASIDE_RESERVE, ASIDE_RESERVE_EXTRA), [])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 思考瞬时帧（v51，thinking-delta-snapshot）：后端已把 `chat.thinking.delta`
  // 从事件流降级为 `chat_delta_state` 状态快照（每线程每步一行，覆盖语义），
  // 流式内容改由无 id 的 `ws.thinking` 帧推送——不进事件窗口、不写缓存。
  // 这里只收当前线程的帧；别家子代理的帧直接丢，避免无关重渲。
  const [thinkFrame, setThinkFrame] = useState<ThinkingFrame | null>(null)
  const onThinking = useCallback((f: ThinkingFrame) => {
    if (f.thread_id !== tid || !f.text) return
    setThinkFrame(f)
  }, [tid])
  // 切线程丢弃旧帧：帧是**状态**不是记录，跨线程复用会让新线程短暂显示别人的思考。
  useEffect(() => { setThinkFrame(null) }, [tid])
  // flushMs=50（≈20Hz）：工作台流式期要跟得上后端 ~20Hz 的 delta 投递，否则前端
  // 100ms 批合并会把输出压成「一顿顿的」（2026-10-04 顺滑化）。
  const { events } = useEvents(pid, null, { flushMs: 50, onThinking })

  // 待审批（2026-10-04）：工作台时间线是 ChatMessage[]，审批事件不在其中 → 用「贴 composer
  // 的悬浮卡」呈现项目待审批单；新 approval.requested 到达即唤醒重拉。
  const aprWake = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === "approval.requested") return events[i].id
    return 0
  }, [events])
  const { items: pendingApprovals } = usePendingApprovals(pid, aprWake)

  const decideApproval = useCallback(async (approval: Approval, decision: "approved" | "rejected", note: string): Promise<DecideApprovalResult> => {
    const text = note.trim()
    if (text && approval.session_id) {
      try { await api.sessionNote(approval.session_id, text) } catch { /* 引导失败不阻断决策 */ }
    }
    return api.decideApproval(approval.id, decision)
  }, [])

  const currentAgent = agents.find((a) => a.id === agentId)

  // ---- 线程级模型（v37，2026-10-13）----
  // 当前生效的模型 = 已选线程的覆写 → 未选（新建态）取草稿；空=跟随全局 executor。
  const enabledProviders = useMemo(
    () => (modelInfo?.providers ?? []).filter((p) => p.enabled), [modelInfo])
  const activeModel = useMemo(
    () => (tid
      ? { provider: thread?.provider ?? "", model: thread?.model ?? "" }
      : modelDraft ?? { provider: "", model: "" }),
    [tid, thread?.provider, thread?.model, modelDraft])
  // chip 上「供应商 / 模型 / 深度」三段同行（用户要求）。供应商与模型分开渲染而
  // 不是拼成一个字符串——拼起来整串同色，扫视时分不出哪段是家、哪段是型号。
  // 空模型名是合法值（= 用该供应商的默认模型），显示「默认」而不是空。
  const modelName = activeModel.provider ? (activeModel.model || "默认") : "默认模型"
  const openModelPop = () => {
    setPopProvider(activeModel.provider || enabledProviders[0]?.name || "")
    // 每次打开都收起模型列表：浮层主角是深度滑块，上次展开的列表不该留着
    setModelListOpen(false)
    setModelPopOpen((v) => !v)
  }
  // 选定即切：已选线程走 PUT（坏值 422 不落盘），新建态先存草稿、创建线程时带上。
  const chooseModel = useCallback(async (provider: string, model: string) => {
    setModelPopOpen(false)
    if (!tid) { setModelDraft({ provider, model }); return }
    try {
      const t = await api.chatThreadLlm(tid, provider, model)
      setThread((cur) => (cur ? { ...cur, provider: t.provider, model: t.model } : cur))
      setThreads((ts) => ts.map((x) => (x.id === tid
        ? { ...x, provider: t.provider, model: t.model } : x)))
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "切换模型失败")
    }
  }, [tid])

  // 当前生效的思考深度 = 已选线程的覆写 → 未选（新建态）取草稿。
  // 空值不是「最低」而是「没覆写」——显示上要回落到该供应商配置缺省（high），
  // 但**不能**把 high 写回去（那会把「跟随供应商」悄悄钉死成「固定 high」）。
  const activeEffort = tid ? (thread?.thinking_effort ?? "") : effortDraft
  const effortGear = normalizeGear(activeEffort)
  const chooseEffort = useCallback(async (gear: string) => {
    // 拖到中间默认档 = 清除覆写（回跟随供应商）。这是刻意的：用户把滑块拖回
    // 「高」往往是想恢复默认，而不是想钉死一个刚好等于默认值的手动档。
    const next = gear === EFFORT_DEFAULT ? "" : gear
    if (!tid) { setEffortDraft(next); return }
    // 乐观更新：滑块要跟手（拖完立刻回位），失败再回滚
    const prev = thread?.thinking_effort ?? ""
    setThread((cur) => (cur ? { ...cur, thinking_effort: next } : cur))
    setThreads((ts) => ts.map((x) => (x.id === tid ? { ...x, thinking_effort: next } : x)))
    try {
      const t = await api.chatThreadEffort(tid, next)
      setThread((cur) => (cur ? { ...cur, thinking_effort: t.thinking_effort } : cur))
      setThreads((ts) => ts.map((x) => (x.id === tid
        ? { ...x, thinking_effort: t.thinking_effort } : x)))
    } catch (e) {
      setThread((cur) => (cur ? { ...cur, thinking_effort: prev } : cur))
      setThreads((ts) => ts.map((x) => (x.id === tid
        ? { ...x, thinking_effort: prev } : x)))
      setErr(e instanceof ApiError ? e.message : "切换思考深度失败")
    }
  }, [tid, thread?.thinking_effort])

  // ---- 联网搜索开关（v43，web-search-toggle）----
  // 当前生效 = 已选线程的落盘值 → 未选（新建态）取草稿。
  const webSearchOn = tid ? !!thread?.web_search : webSearchDraft
  const toggleWebSearch = useCallback(async () => {
    const next = !webSearchOn
    if (!tid) { setWebSearchDraft(next); return }
    try {
      const t = await api.chatThreadWebSearch(tid, next)
      setThread((cur) => (cur ? { ...cur, web_search: t.web_search } : cur))
      setThreads((ts) => ts.map((x) => (x.id === tid
        ? { ...x, web_search: t.web_search } : x)))
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "切换联网搜索失败")
    }
  }, [tid, webSearchOn])

  // ---- 线程池脉冲开关（v54，ctf-pool-pulse-toggle，2026-10-31）：仅 CTF 主控。
  // 开（默认）= 池脉冲每 5 分钟检查该主控的池目标（分诊未决 1 / 决后 5 条
  // running），未满则软提示/补派；关 = 该主控跳过检查、不再被打扰。开关按
  // 线程落盘（后端 chat_threads.pool_pulse_on），选中不同主控线程各自生效。
  const ctfController = agentId === "ctf-controller"
  const poolPulseOn = tid ? (thread?.pool_pulse_on ?? true) : true
  const togglePoolPulse = useCallback(async () => {
    const next = !poolPulseOn
    if (!tid) return
    try {
      const t = await api.chatThreadPoolPulse(tid, next)
      setThread((cur) => (cur ? { ...cur, pool_pulse_on: t.pool_pulse_on } : cur))
      setThreads((ts) => ts.map((x) => (x.id === tid
        ? { ...x, pool_pulse_on: t.pool_pulse_on } : x)))
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "切换线程池脉冲失败")
    }
  }, [tid, poolPulseOn])

  // 分割线拖宽：mousedown 记起点，document mousemove 调宽，mouseup 收尾
  const onSplitterDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragOrigin.current = { x: e.clientX, w: asideWidth }
    setDragging(true)
  }
  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent) => {
      const o = dragOrigin.current
      if (o) setAsideWidth(Math.max(ASIDE_MIN, Math.min(maxAside(), o.w + (e.clientX - o.x))))
    }
    const up = () => setDragging(false)
    document.addEventListener("mousemove", move)
    document.addEventListener("mouseup", up)
    document.body.classList.add("wb-dragging")
    return () => {
      document.removeEventListener("mousemove", move)
      document.removeEventListener("mouseup", up)
      document.body.classList.remove("wb-dragging")
      dragOrigin.current = null
    }
  }, [dragging, maxAside])

  // ---- 加载 ----
  // **agent 是否已确定**（2026-10-26，本次「进去后没有会话线程」的真正病根之一）：
  // `agentId` 初值 `ORCHESTRATOR` 只是**猜测**——CTF/逆向项目的 agents 列表里
  // 根本没有 pentest-controller。而项目首屏闸门（ProjectLoadingScreen）是
  // **absolute 覆盖层**，不是条件渲染：工作台在闸门还在转圈时就已经挂载并跑 effect。
  // 于是它顶着猜出来的 id 发一次请求 → 拿到 `200 []` → 列表为空 → 渲染
  // 「暂无线程」。等 chatAgents 回来才改 id 重发，用户已经看到「没有会话」了。
  // 现在：未确定前**一个线程请求都不发**，侧栏显示「加载中」。
  const [agentConfirmed, setAgentConfirmed] = useState(false)
  useEffect(() => {
    let alive = true
    api.chatAgents(pid).then((as) => {
      if (!alive) return
      // 主控排最上（controller-first，2026-10-30）：后端 `_chat_agents` 已把控制器
      // 类排前，这里再做一次稳定排序兜底（旧后端/顺序漂移时选择器里主控也最显眼）。
      const sorted = [...as].sort((a, b) =>
        Number(isControllerAgent(b.id)) - Number(isControllerAgent(a.id)))
      setAgents(sorted)
      // 服务轨过滤后「默认主控」可能不在本轨列表里（2026-10-25）：initial
      // state 恒是渗透测试主控，若本轨不移它（如 CTF 项目）就必须落到真实
      // 存在的那个控制器上，否则首屏 agentId 指向不存在的智能体——发消息 422、
      // 线程列表也永远空。**只在当前选择不在列表里时改**，不覆盖用户已选项。
      const currentAgentId = workbenchStateRef.current?.pid === pid
        ? workbenchStateRef.current.agentId : agentId
      const nextAgentId = as.some((a) => a.id === currentAgentId)
        ? currentAgentId : pickAgent(as)
      if (nextAgentId !== currentAgentId) {
        const base = chatWorkbenchStateForProject(workbenchStateRef.current, pid, currentAgentId)
        const saved = saveChatWorkbenchDraft(base, currentAgentId, tid, inputStateRef.current)
        const nextState = selectChatWorkbenchAgent(saved, nextAgentId)
        publishWorkbenchState(nextState)
        setTid(nextState.tid)
        setInput(chatWorkbenchDraft(nextState, nextAgentId, nextState.tid))
      }
      setAgentId(nextAgentId)
      setAgentConfirmed(true)
    }).catch(() => { setAgentConfirmed(true) })
    api.assets(pid).then((as) => { if (alive) setAssets(as) }).catch(() => {})
    return () => { alive = false }
  }, [pid])

  // **这里刻意没有「闸门预热接管」**（2026-10-26 删除）：App 的闸门是 absolute
  // 覆盖层，工作台在它底下**同帧挂载**并自己发 chatAgents → reloadThreads。
  // 闸门的 await 完成时工作台早已拿到数据，此时再「应用预热」是幂等空操作——
  // 实测把闸门改回 `availableAgents[0]`（预热到另一个智能体）验证依然全绿，
  // 正说明这条链路对用户零收益。留着它只会让人误以为「有预热所以首屏更快」。
  // 真正起作用的是下面 `agentConfirmed` 闸门 + `reloadThreads` 的序号保护。

  // 供应商/模型清单（线程级模型选择浮层的数据源，v37）：全局口径，拉一次即可
  useEffect(() => {
    let alive = true
    api.models().then((m) => { if (alive) setModelInfo(m) }).catch(() => {})
    return () => { alive = false }
  }, [])

  // 会话线程列表加载（2026-10-26 重构）：
  //
  // 旧实现是 `api.chatThreads(pid, aid).then(setThreads).catch(() => setThreads([]))`，
  // 三个缺陷叠在一起，表现为「进项目后会话线程不显示」：
  //  ① **无请求序号**：谁后到谁覆盖。切 agent / 轮询 / 事件补拉会并发发请求，
  //     过期响应能把刚拿到的列表盖掉。
  //  ② **catch 清空**：一次瞬态 500 直接把侧栏打成「暂无线程」，要等下一个 5s
  //     轮询才恢复（实测清空 5s 才回来，用户以为列表丢了）。
  //  ③ **无加载态**：`threads=[]` 分不清「还在加载」和「真的没有」，首屏那几十到
  //     几百毫秒直接渲染成「暂无线程，发送消息或点『新建』」——这句是断言，不是
  //     过程，观感上就是「没有会话」。
  // 现改为：序号防覆盖 + 失败保留旧列表 + `threadsLoaded` 区分加载态。
  const threadsSeq = useRef(0)
  const reloadThreads = useCallback((aid: string) => {
    const seq = ++threadsSeq.current
    api.chatThreads(pid, aid)
      .then((rows) => {
        // 只有最新一次请求有权写入；过期响应直接丢（保留更新鲜的结果）
        if (seq !== threadsSeq.current) return
        setThreads(rows)
        setThreadsLoaded(true)
        // 首次自动选主控第一个会话（open-project-pick-first-thread，2026-10-30）：
        // 进入项目且该智能体**从未选过线程**（selectedThreads 无记录 = 首次）且当前
        // 没有选中线程、但存在历史会话 → 自动选中第一个，打开项目即有对话入口。
        // 之后用户手动切线程/新建（selectedThreads 有记录）不会再触发；主控无会话
        // 时保持空态（不擅自创建）。
        const st = workbenchStateRef.current
        const neverPicked = st?.pid === pid && st.selectedThreads?.[aid] === undefined
        if (neverPicked && st?.tid === null && rows.length > 0) {
          const base = chatWorkbenchStateForProject(st, pid, aid)
          const nextState = selectChatWorkbenchThread(base, aid, rows[0].id)
          publishWorkbenchState(nextState)
          setTid(rows[0].id)
          setInput(chatWorkbenchDraft(nextState, aid, rows[0].id))
        }
      })
      .catch(() => {
        // **报错不清空**：宁可显示几秒前的旧列表，也比闪成「暂无线程」好。
        // 但要把「已尝试过」标出来，否则加载骨架会一直转（真实失败该收尾）。
        if (seq !== threadsSeq.current) return
        setThreadsLoaded(true)
      })
  }, [pid, publishWorkbenchState])

  // 外部聚焦线程（goto-agents，M2）：agentId 切换会触发下面的重置 effect，故先存
  // ref、切到主控，由重置 effect 消费 ref 选中；agentId 已是主控时直接 setTid
  // （重置 effect 不重跑）。
  // **切到哪个主控要按列表挑**（2026-10-25 服务轨过滤后）：蓝图页从逆向工作台
  // 跳进来时项目可能是 research 轨，那里没有渗透主控而有 ctf/artex，硬切
  // ORCHESTRATOR 会把 agentId 钉在一个列表里不存在的 id 上。
  const focusTidRef = useRef<string | null>(null)
  useEffect(() => {
    if (!focusThread) return
    if (isControllerAgent(agentId)) {
      // 已经是某个控制器（含非渗透主控）：线程归属该控制器时别乱切
      if (agents.some((a) => a.id === agentId)) {
        const base = chatWorkbenchStateForProject(workbenchStateRef.current, pid, agentId)
        const nextState = selectChatWorkbenchThread(
          saveChatWorkbenchDraft(base, agentId, tid, inputStateRef.current), agentId, focusThread,
        )
        publishWorkbenchState(nextState)
        setTid(focusThread)
        setInput(chatWorkbenchDraft(nextState, agentId, focusThread))
        onFocusConsumed?.()
        return
      }
    }
    focusTidRef.current = focusThread
    const nextAgentId = pickAgent(agents)
    const base = chatWorkbenchStateForProject(workbenchStateRef.current, pid, agentId)
    const saved = saveChatWorkbenchDraft(base, agentId, tid, inputStateRef.current)
    const nextState = selectChatWorkbenchAgent(saved, nextAgentId)
    publishWorkbenchState(nextState)
    setAgentId(nextAgentId)
    setTid(nextState.tid)
    setInput(chatWorkbenchDraft(nextState, nextAgentId, nextState.tid))
    onFocusConsumed?.()
  }, [focusThread, agentId, agents, pid, tid, input, publishWorkbenchState, onFocusConsumed])

  // agentId 变化 → 重置选中态并重拉列表（**唯一的 agentId 触发点**）。
  //
  // 2026-10-26：此前这里和下面「线程状态变化时重拉」的 effect **都依赖 agentId**，
  // 于是每次切 agent 固定发 2 次相同请求（实测 `[REQ] pentest ×2 → [REQ] ctf ×2`）。
  // 现在 agentId 只在这里触发；下面那条只负责 `thread?.status` 变化。
  //
  // **agent 未确定前一个请求都不发**（2026-10-26，本次病根）：初值 `agentId` 是
  // 猜的（恒 ORCHESTRATOR），CTF 项目里压根没这个 id → 必拿 `200 []` → 侧栏
  // 先渲染成「暂无线程」。等 `chatAgents` 回来确认真正的控制器再拉。
  useEffect(() => {
    const focused = focusTidRef.current
    focusTidRef.current = null
    const savedTid = workbenchState?.pid === pid
      ? (workbenchState.selectedThreads[agentId] ?? null) : null
    const nextTid = focused ?? savedTid
    setTid(nextTid)
    if (workbenchState?.pid === pid) {
      setInput(chatWorkbenchDraft(workbenchState, agentId, nextTid))
    }
    setThread(null); setMessages([])
    if (!agentConfirmed) return          // 等确认，别拿猜的 id 去问
    reloadThreads(agentId)
  }, [agentId, reloadThreads, agentConfirmed])

  // 换 agent 时把加载态打回 false（2026-10-26）：否则上一个 agent 的「已加载」
  // 会带过来，切到新 agent 的瞬间列表还是空、却又被当成「确实没有」渲染成
  // 「暂无线程」——和首屏同一个假断言。
  // **必须跳过首次**：预热命中时初值就是 true，这里无条件置 false 会把「已拿到
  // 列表」打回「加载中」，反而闪一下骨架。
  const agentIdSeenRef = useRef(agentId)
  useEffect(() => {
    if (agentIdSeenRef.current === agentId) return
    agentIdSeenRef.current = agentId
    setThreadsLoaded(false)
  }, [agentId])

  // 轮询拉线程详情（2s）。load 存进 ref，供「用户消息事件到达」时即时补拉。
  // **2026-10-04 修「发送后空白」**：乐观行 pendingIn 只在「持久化的 user 消息
  // 真的进了 messages」时清除——此前 WS 的 chat.message(user) 事件一到就清，
  // 而 messages 只靠 2s 轮询刷新，事件先于轮询到达时时间线会空一段。
  const reloadRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!tid) { setThread(null); setMessages([]); setLoaded(false); reloadRef.current = null; return }
    let alive = true
    setLoaded(false)
    const load = () => api.chatThread(tid).then((d) => {
      if (!alive) return
      setThread(d.thread)
      setMessages(d.messages)
      setWorkDir(d.work_dir ?? null)
      setLoaded(true)
      // 对账乐观行：持久化的 user 消息出现后才移除本地占位。**带附件时后端会把
      // 「附件：\n- 路径」段拼在正文后**（core/chat/runtime.py run()），故不能用
      // 全等匹配——否则带附件的消息 pendingIn 永不清除，正文会在时间线尾部重影
      // 一次（2026-10-13 修用户实测「用户消息重复渲染」）。取最近一条 user 消息，
      // 允许其后追加附件段（`cur + "\n"` 前缀）。
      setPendingIn((cur) => {
        if (!cur) return cur
        for (let i = d.messages.length - 1; i >= 0; i--) {
          const m = d.messages[i]
          if (m.role !== "user") continue
          return m.content === cur || m.content.startsWith(`${cur}\n`) ? null : cur
        }
        return cur
      })
    }).catch(() => {})
    reloadRef.current = load
    load()
    const timer = setInterval(load, 2000)
    return () => { alive = false; clearInterval(timer); reloadRef.current = null }
  }, [tid])

  // 线程自身状态变化（running/idle/error）→ 重拉列表，让侧栏圆点与待办计数跟上。
  // **依赖里不能有 agentId**（2026-10-26）：agentId 的变化已由上面那条 effect 处理，
  // 重复依赖会让每次切 agent 发两次一模一样请求。这里用 `thread?.status` 作为
  // 触发条件，并把最近一次 status 存 ref 比对，避免 agentId 变化后 thread 被清空
  // （`setThread(null)`）引发的多余一次重拉。
  const lastThreadStatusRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const st = thread?.status
    if (st === lastThreadStatusRef.current) return
    lastThreadStatusRef.current = st
    if (!st) return   // 线程被清空（切 agent/切线程）不是「状态变化」，别多打一次
    reloadThreads(agentId)
  }, [thread?.status, agentId, reloadThreads])

  // 会话列表 5s 轮询（2026-10-22，候选 flag 徽章）。
  //
  // **为什么不能只靠上面那条 effect**：它只在 `thread?.status` 变化时重拉，而
  // 「有待确认的 flag」这件事**不改变任何线程状态**——worker 在后台提交候选
  // （主控此刻 idle，`ctf_wake` 只唤醒主控说话，状态 idle→running→idle 会变，
  // 但**人工确认/否决**之后状态纹丝不动）。只靠它，徽章在「确认完了」之后会
  // 一直挂着，比不显示更糟（人以为还有事没处理）。
  //
  // **为什么不挂事件 bump**：事件流在流式期约 2.5 次/秒，挂上去会把线程列表
  // 全量请求放大到同频（顶栏统计踩过同一个坑，见 memory/MEMORY.md）。5s 足够
  // ——徽章是「有空去处理」的提示，不要求秒级。
  useEffect(() => {
    if (!agentId || !agentConfirmed) return   // 未确认前别轮询（会拿猜的 id 每 5s 打一次空请求）
    const t = setInterval(() => reloadThreads(agentId), 5000)
    return () => clearInterval(t)
  }, [agentId, agentConfirmed, reloadThreads])

  // 候选 flag 确认卡（ctf-flag-wake，2026-10-20）：子代理提交候选 flag 时后端会
  // 唤醒 CTF 解题主控说一段话（`core/chat/ctf_wake.py`），本卡贴 composer 上方，
  // 让人类一键复制 flag、一键确认（accepted）或标记为错误（rejected）。
  // **只在本线程绑定了 CTF 题目时启用**：challengeId 为空 → hook 空转、零请求，
  // 非 CTF 项目/普通专家线程完全不受影响。
  const challengeId = thread?.challenge_asset_id || null
  const flagWake = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const k = events[i].kind
      if (k === "challenge.flag.recorded" || k === "challenge.flag.updated"
          || k === "challenge.flag.decided") return events[i].id
    }
    return 0
  }, [events])
  const { flags: candidateFlags, quota: flagQuota, accepted: flagAccepted,
          hints: flagHints, refresh: refreshCandidates } =
    useCandidateFlags(challengeId, flagWake)
  const [decideFlagBusy, setDecideFlagBusy] = useState(false)
  const decideCandidateFlag = useCallback(
    async (flag: ChallengeFlag, verdict: "accepted" | "rejected", reason?: string) => {
      if (!challengeId) return
      setDecideFlagBusy(true)
      try {
        await api.decideChallengeFlag(challengeId, flag.id, { verdict, reason })
        refreshCandidates()
        reloadRef.current?.()
        // 立刻刷新会话列表徽章（2026-10-22）：确认/否决**不会改变线程状态**，
        // 靠 5s 轮询要多等一拍，观感是「我点了确认但黄点还在」。
        reloadThreads(agentId)
      } finally {
        setDecideFlagBusy(false)
      }
    }, [challengeId, refreshCandidates, reloadThreads, agentId])

  useEffect(() => {
    if ((panel !== "skills" && slash?.mode !== "skills") || skills.length) return
    api.skills()
      .then((list) => setSkills(list.map((s) => ({
        name: s.name, description: (s as { description?: string }).description ?? "",
      }))))
      .catch(() => {})
  }, [panel, slash, skills.length])
  // MCP 面板：结果**缓存**，反复点开不再每次重新请求（后端 status() 会逐 server
  // 探活 tools/list，点一次刷一次既慢又闪）。首次点开拉一次，之后复用；需要时点
  // 面板内「刷新」强制重探（MCP 进程后起时用）。切项目（pid 变）即失效重拉。
  const mcpLoadedRef = useRef(false)
  useEffect(() => { mcpLoadedRef.current = false; setMcpServers([]) }, [pid])
  const loadMcp = useCallback((force = false) => {
    if (mcpLoadedRef.current && !force) return
    api.chatMcp(pid)
      .then((r) => { setMcpServers(r.servers); mcpLoadedRef.current = true })
      .catch(() => {})
  }, [pid])
  useEffect(() => {
    if (panel !== "mcp" && slash?.mode !== "mcp") return
    loadMcp()
  }, [panel, slash, loadMcp])

  // ---- 流式 delta / 工具活动（事件管道增强） ----
  // 只消费**当前用户消息之后**的事件（与 liveThinking 同款守卫，2026-10-12 修）：
  // 新一轮开始时上一轮的 chat.delta 仍留在事件流里，若不设起点会被当作本轮流式
  // 文本，以**原始 markdown** 渲染在时间线尾部——上一轮正文明明已落库、按 prose
  // 走 MarkdownView 渲染，却又以 raw 重影出现在末尾（用户实测「新一轮时上一轮
  // 输出不渲染」）。chat.delta 携带**累计全文**，故必须整段丢弃而非只丢最新一条。
  const liveDelta = useMemo(() => {
    let text = ""
    let started = false
    for (const e of events) {
      const p = e.payload as { thread_id?: string; role?: string; text?: string }
      if (e.kind === "chat.message" && p?.thread_id === tid && p.role === "user") {
        started = true
        text = ""
        continue
      }
      if (!started || e.kind !== "chat.delta" || p?.thread_id !== tid) continue
      if (typeof p.text === "string") text = p.text
    }
    return text
  }, [events, tid])
  // chat.tool 按 tool_call_id 累积：同一批并行专家共享主控 thread_id，不能只取
  // 最新一条事件，否则后一个 start 会覆盖先完成的 done。旧事件没有 id 时保留
  // name + args_head 回退匹配，兼容历史事件缓存。
  const liveTools = useMemo(() => {
    type LiveTool = {
      tool_call_id?: string; phase?: string; name?: string; args_head?: string
      ok?: boolean; duration_s?: number; result_head?: string; created_at?: string
    }
    const byId = new Map<string, LiveTool>()
    const legacy: LiveTool[] = []
    // start 事件时刻（2026-10-13 修「已运行 0s」）：会话流里的挂起工具行靠它计时，
    // 之前只有底部实时行带时刻、持久化行没传 startedAt → 挂起工具永远显示 0s。
    const startAtById = new Map<string, string>()
    const legacyStarts: { name?: string; args_head?: string; created_at: string }[] = []
    for (const e of events) {
      if (e.kind !== "chat.tool") continue
      const p = e.payload as LiveTool & { thread_id?: string }
      if (p?.thread_id !== tid) continue
      const eventTool = { ...p, created_at: e.created_at }
      if (p.tool_call_id) byId.set(p.tool_call_id, eventTool)
      else legacy.push(p)
      if (p.phase === "start") {
        if (p.tool_call_id) startAtById.set(p.tool_call_id, e.created_at)
        else legacyStarts.push({ name: p.name, args_head: p.args_head, created_at: e.created_at })
      }
    }
    return { byId, legacy, startAtById, legacyStarts }
  }, [events, tid])
  // 运行中的子代理：call_expert 可能并发派发多个调用，按 tool_call_id 分组后
  // 只保留最近状态仍为 start 的调用；收到 done、失败或取消事件后自然移除。
  // 再和已落库的 tool 消息交叉排除，避免重连/事件窗口裁剪造成幽灵状态。
  const runningCallExperts = useMemo(() => {
    const answered = new Set<string>()
    for (const m of messages) {
      if (m.role === "tool" && m.tool_use_id) answered.add(m.tool_use_id)
    }
    return [...liveTools.byId.entries()]
      .filter(([id, tool]) => tool.name === "call_expert"
        && tool.phase === "start" && !answered.has(id))
      .map(([id, tool]) => ({ id, tool }))
  }, [liveTools.byId, messages])
  // 底部实时工具行（「运行中」）判据（2026-10-13 修「重启后幽灵运行中」）：只认
  // 「本线程最近一条 chat.tool 事件是 start」且该 tool_call_id **尚无持久化结果行**。
  // 旧实现取 byId 里最后一条 phase=start 的事件——中断/重启遗留的孤儿 start（后端
  // 只补 chat_messages 结果行、没补 done 事件）在 Map 里永久驻留，被当成本轮正在跑
  // 的工具（用户实测：中断前的 list_symbols 重启后仍显示「运行中」）。改按事件流
  // 最后一条判定 + 已落库结果行交叉排除孤儿。
  // 2026-10-20：**找不到 start 时不能直接判「没有工具在跑」**——窗口里可能压根没有
  // 这条 start（流式增量挤占窗口，见 useEvents 的 DELTA_KEEP）。此时退到持久化
  // 消息判据：本轮仍有 assistant(tool_calls) 未落结果行 = 确实有工具在跑。
  const liveToolStart = useMemo(() => {
    type LiveTool = { tool_call_id?: string; phase?: string; name?: string; args_head?: string }
    const answered = new Set<string>()
    for (const m of messages) {
      if (m.role === "tool" && m.tool_use_id) answered.add(m.tool_use_id)
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.kind !== "chat.tool") continue
      const p = e.payload as LiveTool & { thread_id?: string }
      if (p?.thread_id !== tid) continue
      if (p.phase !== "start") return null            // 最近一条已 done → 无工具在跑
      if (p.tool_call_id && answered.has(p.tool_call_id)) return null  // 结果已落库=遗留
      // 带上 start 事件时刻 → 工具行显示「已运行 Ns」（逐秒刷新，2026-10-13）
      return { ...p, created_at: e.created_at }
    }
    // 窗口内没有任何本线程的 chat.tool：不编造实时行（消息判据只决定「有没有」，
    // 无法给出可靠的起始时刻，交给时间线上的持久化行去计时）。
    return null
  }, [events, tid, messages])
  // 传输层 524 重试进度：provider 通过 chat.retry 事件实时上报，避免长时间
  // 只显示「思考中」让人误以为请求已经卡死。
  //
  // **清除条件（2026-10-31 修复）**：旧实现只认「遇到更新的 user 消息」才
  // 清——倒序扫描时把 chat.delta / chat.thinking / chat.tool / chat.usage 等
  // 「连接已恢复」的进展事件全部跳过，导致重试成功后 UI 仍挂着「正在第 1/3 次
  // 重试」直到本轮结束。实测：子线程 16:28:51 发 empty_response 重试，16:28:55
  // 起已恢复 thinking/tool（连接已回复），但提示一直不清。
  // 现在：扫描中遇到**本线程的进展事件**（流式增量 / 思考 / 工具 / 用量 /
  // assistant 落库）即视为「连接已恢复」→ 返回 null。chat.retry 仍是本线程
  // 最新事件时才显示「正在重试」。
  const liveRetry = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      const p = e.payload as { thread_id?: string; role?: string }
      if (p?.thread_id !== tid) continue
      if (e.kind === "chat.retry") {
        const rp = e.payload as { attempt?: number; total?: number; status?: number }
        return rp
      }
      // 进展事件 = 连接已恢复：重试提示该消失（即使更早还有 chat.retry）。
      // chat.message（非 user）也在其列：重试成功后模型返回**整块终稿**（非流式
      // 供应商/一次性响应）时没有增量事件，只有 assistant 落库——它同样是
      // 「连接已回复」的铁证（2026-10-31）。
      if (e.kind === "chat.delta" || e.kind === "chat.thinking"
          || e.kind === "chat.thinking.delta" || e.kind === "chat.tool"
          || e.kind === "chat.usage"
          || (e.kind === "chat.message" && p.role !== "user")) {
        return null
      }
      if (e.kind === "chat.message" && p.role === "user") break
    }
    return null
  }, [events, tid])
  // 跨供应商兜底（provider-failover，2026-10-21）：某家重试 11 次仍失败会自动换
  // 下一家，此时 chat.retry 的次数会从 1 重新数——**不解释一句会像回归**（用户只
  // 看到「又从头重试了」）。这里把本轮最近一次换家摆出来。
  //
  // 进展事件 = 连接已恢复（2026-10-31，与 liveRetry 同款修复）：倒序扫描跨过
  // delta/thinking/tool/usage/assistant 命中更早的 llm.failover，会让提示在
  // 换家后**已经恢复输出**时仍挂着（用户实测：连接已恢复还显示「已切到 …
  // 继续重试」）。assistant 落库也在其列——非流式供应商/一次性响应没有增量
  // 事件，只有整块终稿落库，它同样是「连接已回复」的铁证。
  const liveFailover = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      const p = e.payload as { thread_id?: string; role?: string }
      if (p?.thread_id !== tid) continue
      if (e.kind === "llm.failover") {
        const fp = e.payload as { from?: string; to?: string; category?: string }
        return fp
      }
      if (e.kind === "chat.delta" || e.kind === "chat.thinking"
          || e.kind === "chat.thinking.delta" || e.kind === "chat.tool"
          || e.kind === "chat.usage"
          || (e.kind === "chat.message" && p.role !== "user")) {
        return null
      }
      if (e.kind === "chat.message" && p.role === "user") break
    }
    return null
  }, [events, tid])
  // 思考内容与回复分开组装：后端发送的是累计全文，因此每个新事件直接覆盖。
  // 只消费当前用户消息之后的事件，避免上一轮思考在新消息等待时短暂闪现。
  //
  // v51（thinking-delta-snapshot）：流式增量已不在事件表里，走 `ws.thinking`
  // 瞬时帧（见上面的 thinkFrame）。两路合流靠**新鲜度水位** mark：
  //   本轮 user 消息时间 → 每条 chat.thinking(.delta) 的 created_at → 逐次抬升；
  //   帧带服务端 ts（浮点秒），比水位新就用帧，否则用已落库的终稿。
  // 帧与终稿携带的是同一段文本的累计前缀，帧更旧时让位给终稿才不会「越显示越短」。
  // created_at 是秒级精度（store.now 的 timespec="seconds"），所以同一秒内的
  // 先后可能判反——影响只在这一秒的显示，下一帧/终稿立即纠正。
  const liveThinking = useMemo(() => {
    let text = ""
    let started = false
    let mark = 0
    for (const e of events) {
      const p = e.payload as { thread_id?: string; role?: string; text?: string; thinking?: string }
      if (e.kind === "chat.message" && p?.thread_id === tid && p.role === "user") {
        started = true
        text = ""
        mark = Date.parse(e.created_at) || 0
        continue
      }
      if (!started || p?.thread_id !== tid) continue
      if (e.kind === "chat.thinking.delta" && typeof p.text === "string") {
        text = p.text
        mark = Math.max(mark, Date.parse(e.created_at) || 0)
      } else if (e.kind === "chat.thinking" && typeof p.thinking === "string") {
        text = p.thinking
        mark = Math.max(mark, Date.parse(e.created_at) || 0)
      }
    }
    if (started && thinkFrame && thinkFrame.thread_id === tid
        && thinkFrame.ts * 1000 > mark) {
      return thinkFrame.text
    }
    return text
  }, [events, tid, thinkFrame])
  // assistant(tool_calls) 已落库但部分调用尚无结果行 → 锚定转圈块（轮询滞后 ≤2s）
  const hasPendingCall = useMemo(() => messages.some((m) =>
    m.role === "assistant" && (m.tool_calls ?? []).some((tc) =>
      !messages.some((x) => x.role === "tool" && x.tool_use_id === tc.id))), [messages])
  const running = thread?.status === "running"
  // 线程最近被停止（最后一条 assistant 是中断墓碑，2026-11-01）——即使 status
  // 仍僵尸 running（线程异常退出/对账未归位），实时行也不该再渲染：否则主控
  // 被停止后 liveDelta 卡住的半截白字一直显示。与后端 `is_interrupt_note` 同口径。
  const stoppedRecent = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "assistant") continue
      const c = m.content ?? ""
      return /已按人类要求停止|Worker 已按控制指令终止/.test(c)
    }
    return false
  }, [messages])
  // 插话提示的自动清理：本轮结束（running 转 false）就该消失——那时它要么已被
  // 读到、要么随轮末一起收尾。另外后端读到时会发 chat.notice 事件，看到就清。
  useEffect(() => {
    if (!running) { setHitQueued(null); return }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.kind === "chat.hit") continue
      if (e.kind === "chat.notice") {
        const p = e.payload as { thread_id?: string }
        if (p?.thread_id === tid) { setHitQueued(null); return }
      }
      break
    }
  }, [running, events, tid])

  // 上下文用量（K9-C / ct-8）：分母=后端下发的真实硬窗口（缺省回落 256K）；
  // 软上限=有效工作窗口（支持 1M≠在 1M 最好），超此会触发压缩，作为警戒线。
  const usage = thread?.usage ?? null
  const ctxLimit = usage?.ctx_limit ?? CTX_LIMIT
  const ctxSoft = usage?.ctx_soft ?? ctxLimit
  const usagePct = Math.min(100, Math.round(((usage?.input ?? 0) / ctxLimit) * 100))
  const softPct = ctxSoft > 0 ? (usage?.input ?? 0) / ctxSoft : 0
  // 档位按软上限（警戒线）判定：<70% 青 / 70~90% 琥珀 / >90% 红（接近压缩）
  const usageLevel = softPct >= 0.9 ? "is-high" : softPct >= 0.7 ? "is-warn" : "is-ok"
  const softLeftPct = ctxLimit > 0 ? Math.min(100, (ctxSoft / ctxLimit) * 100) : 100
  const showSoftLine = ctxSoft < ctxLimit
  // 上下文构成（Claude Code /context 式）：后端估算+真值归一的分类 breakdown
  const bk = usage?.breakdown
  const usageFree = Math.max(0, ctxLimit - (usage?.input ?? 0))
  const usageSegs = bk
    ? ([
        { key: "system", label: "系统提示", tokens: bk.system, cls: "seg-sys" },
        { key: "tools", label: "工具定义", tokens: bk.tools, cls: "seg-tools" },
        { key: "refs", label: "本轮注入", tokens: bk.refs, cls: "seg-refs" },
        { key: "messages", label: "会话消息", tokens: bk.messages, cls: "seg-msgs" },
      ] as const).filter((s) => s.tokens > 0)
    : []
  // 缓存命中（2026-10-13）：口径 = **累计**（跨步自加，见 core/chat/runtime.py）——
  // 命中率 = cache_read_total / input_total，分段 token 同样取累计读/写/未缓存。
  // 首步冷缓存必 0%，显「首步」而非 0%。
  const cache = (() => {
    const total = usage?.input_total ?? 0
    if (!usage || total <= 0) return null
    const read = usage.cache_read_total ?? 0
    const write = usage.cache_creation_total ?? 0
    const uncached = Math.max(0, total - read - write)
    const pct = (n: number) => Math.round((n / total) * 100)
    const hitPct = pct(read)
    return {
      hitPct,
      cold: (usage.steps ?? 0) <= 1,
      level: hitPct >= 60 ? "is-ok" : hitPct >= 30 ? "is-warn" : "is-high",
      segs: [
        { key: "read", label: "缓存读", tokens: read, pct: pct(read), cls: "seg-cache-read" },
        { key: "write", label: "缓存写", tokens: write, pct: pct(write), cls: "seg-cache-write" },
        { key: "uncached", label: "未缓存", tokens: uncached, pct: pct(uncached), cls: "seg-uncached" },
      ],
    }
  })()

  // 切线程时收起斜杠面板与用量浮层；模型浮层同理，且新建态草稿由线程自身接管
  useEffect(() => {
    setUsageOpen(false); setSlash(null); setModelPopOpen(false); setModelDraft(null)
  }, [tid])

  // chat.message(user) 事件到达 → 立即补拉一次线程详情（比 2s 轮询快）。
  // **不在这里清 pendingIn**——清除只发生在 load() 确认该消息已进 messages 之后，
  // 否则事件先到、轮询未到时会闪空白（2026-10-04 修）。
  useEffect(() => {
    if (!pendingIn || !tid) return
    for (const e of events) {
      if (e.kind !== "chat.message") continue
      const p = e.payload as { thread_id?: string; role?: string }
      if (p?.thread_id === tid && (p.role === "user" || p.role === "assistant")) { reloadRef.current?.(); return }
    }
  }, [events, tid, pendingIn])

  // ---- 动作 ----
  // 线程切换统一入口：草稿以智能体和线程为键存于 App 壳内存态。
  const selectThread = useCallback((nextId: string | null) => {
    if (tid === nextId) return
    const base = chatWorkbenchStateForProject(workbenchStateRef.current, pid, agentId)
    const saved = saveChatWorkbenchDraft(base, agentId, tid, inputStateRef.current)
    const nextState = selectChatWorkbenchThread(saved, agentId, nextId)
    publishWorkbenchState(nextState)
    setTid(nextId)
    setInput(chatWorkbenchDraft(nextState, agentId, nextId))
    setRefsDraft({ skills: [], mcps: [] })
  }, [tid, pid, agentId, publishWorkbenchState])

  // 删除一条子会话（2026-10-31）：主控 spawn 名额上限 8，而左栏只列本智能体
  // 的线程（子线程的 agent_id 是专家名，那里根本看不到）——没有这个入口，
  // 到顶后的主控就永远开不出新线程。运行中的删不掉（后端 409，按钮也不出现）。
  const deleteChildThread = useCallback((id: string) => {
    if (!window.confirm("删除这条会话？它的消息记录会一并清掉（不可恢复）。")) return
    void api.chatThreadDelete(id).then(() => {
      if (tid === id) selectThread(thread?.children_parent_id ?? null)
      reloadThreads(agentId)
    }).catch((e: unknown) => setErr(errText(e)))
  }, [tid, thread?.children_parent_id, selectThread, reloadThreads, agentId])

  // 附件随发（2026-10-08）：粘贴/拖拽即上传为 artifact（服务端同 sha 去重），
  // chip 三态 + 进度。2026-10-25：**不再有大小限制**——大于 32MB 自动走分片续传
  // （16MB/片），几 GB 的 pcapng/内存 dump 也能传，进度实时显示在 chip 上。
  const uploadQueueRef = useRef<Array<{ key: string; pid: string; file: File }>>([])
  const activeUploadsRef = useRef(0)
  const uploadControllersRef = useRef(new Map<string, { pid: string; controller: AbortController }>())
  const pumpUploadQueue = useCallback(() => {
    while (activeUploadsRef.current < 3 && uploadQueueRef.current.length) {
      const next = uploadQueueRef.current.shift()!
      if (next.pid !== pid) continue
      const controller = new AbortController()
      uploadControllersRef.current.set(next.key, { pid: next.pid, controller })
      activeUploadsRef.current += 1
      setPendingFiles((fs) => fs.map((x) => x.key === next.key
        ? { ...x, status: "uploading", error: undefined } : x))
      void api.uploadAttachmentAuto(next.pid, next.file, {
        signal: controller.signal,
        onProgress: (sent) => setPendingFiles((fs) =>
          fs.map((x) => x.key === next.key ? { ...x, loaded: sent } : x)),
      })
        .then((att) => setPendingFiles((fs) => fs.map((x) =>
          x.key === next.key ? { ...x, status: "ready", att, loaded: att.size } : x)))
        .catch((e: unknown) => {
          if (!controller.signal.aborted) {
            setPendingFiles((fs) => fs.map((x) =>
              x.key === next.key ? { ...x, status: "error", error: errText(e), retryable: true } : x))
          }
        })
        .finally(() => {
          if (uploadControllersRef.current.get(next.key)?.controller === controller) {
            uploadControllersRef.current.delete(next.key)
          }
          activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1)
          pumpUploadQueueRef.current()
        })
    }
  }, [pid])
  const pumpUploadQueueRef = useRef(pumpUploadQueue)
  useEffect(() => { pumpUploadQueueRef.current = pumpUploadQueue }, [pumpUploadQueue])
  const uploadOne = (key: string, file: File) => {
    uploadQueueRef.current.push({ key, pid, file })
    pumpUploadQueue()
  }
  const pickFiles = (files: FileList | File[] | null) => {
    for (const f of Array.from(files ?? [])) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      if (f.size === 0) {
        setPendingFiles((fs) => [...fs, {
          key, status: "error", name: f.name, size: 0, file: f, retryable: false,
          error: "空文件或文件夹——文件夹请展开后选择具体文件，或用「样本包」上传整个目录",
        }])
        continue
      }
      setPendingFiles((fs) => [...fs, { key, status: "queued", name: f.name, size: f.size, file: f }])
      uploadOne(key, f)
    }
  }
  // 样本条目拖进输入框 = 插入一行引用文本（**不是**上传附件）：分析包里的文件
  // 通常是成品固件/游戏（几十 GB），传一份副本既慢又没意义；agent 手上有宿主文件
  // 工具，给它绝对路径就够了。按光标位置插入，连续拖多个样本是追加而非覆盖。
  const insertSampleRef = (ref: SampleDragRef) => {
    const el = inputRef.current
    // 没聚焦时 selectionStart 往往是 0——那不是「用户把光标放在开头」，而是「没有
    // 光标」。这种情况一律追加到末尾，否则拖进来的引用会悄悄跑到整段文字最前面。
    const focused = !!el && document.activeElement === el
    const { value: next, caret } = insertSampleRefText(
      input, ref, focused ? el.selectionStart : input.length, focused ? el.selectionEnd : input.length)
    setInput(next)
    setErr(null)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }
  // Directory entries must be consumed from the original drop event. Reconstructing a new
  // DataTransfer from its DataTransferItems is browser-dependent and silently drops entries.
  const dropFiles = async (dt: DataTransfer | null) => {
    if (!dt) return
    // 样本引用（右侧抽屉「样本」页拖过来的文件）**必须在第一个 await 之前读**：
    // DataTransfer 只在 drop 处理器的同步段内有效，一旦让出（collectDroppedFiles
    // 要读目录项）再 getData 一律返回空串——表现为「拖了没反应」且不报错。
    const sample = readSampleDrop(dt)
    if (sample) { insertSampleRef(sample); return }
    setDropping("正在读取拖入内容…")
    try {
      const { files, skipped, overflow } = await collectDroppedFiles(dt, {
        onProgress: (found) => setDropping(`正在展开文件夹…已发现 ${found} 个文件`),
      })
      if (files.length) pickFiles(files)
      const notes: string[] = []
      if (skipped.length) notes.push(`${skipped.length} 项未能读取（目录过大、超时或无权限）`)
      if (overflow) notes.push(`超过 ${MAX_DROPPED_FILES} 个文件，仅处理前 ${MAX_DROPPED_FILES} 个`)
      if (!files.length && !notes.length) notes.push("没有找到可上传的文件")
      if (notes.length) setErr(notes.join("；"))
      else setErr(null)
    } catch (e) {
      setErr(`读取拖入内容失败：${errText(e)}`)
    } finally {
      setDropping(null)
    }
  }
  const retryFile = (key: string) => {
    const f = pendingFiles.find((x) => x.key === key)
    if (!f?.file) return
    setPendingFiles((fs) => fs.map((x) => x.key === key
      ? { ...x, status: "queued", error: undefined, retryable: undefined, loaded: 0 } : x))
    uploadOne(key, f.file)
  }
  const removeFile = (key: string) => {
    uploadQueueRef.current = uploadQueueRef.current.filter((x) => x.key !== key)
    uploadControllersRef.current.get(key)?.controller.abort()
    setPendingFiles((fs) => fs.filter((x) => x.key !== key))
  }
  // 全部移除（方案 A 头行「全部移除」，2026-11-01）：与 removeFile 同语义——
  // 清掉排队项 + abort 在飞控制器 + 清列表；上传中的文件被 abort 后不会回填。
  const clearFiles = () => {
    const keys = new Set(pendingFiles.map((x) => x.key))
    uploadQueueRef.current = uploadQueueRef.current.filter((x) => !keys.has(x.key))
    for (const [k, c] of uploadControllersRef.current) {
      if (keys.has(k)) c.controller.abort()
    }
    setPendingFiles([])
  }
  useEffect(() => {
    const queue = uploadQueueRef.current
    const controllers = uploadControllersRef.current
    return () => {
      uploadQueueRef.current = queue.filter((x) => x.pid !== pid)
      for (const item of controllers.values()) {
        if (item.pid === pid) item.controller.abort()
      }
    }
  }, [pid])

  // 发送 = 乐观上屏（用户气泡 + 思考占位先行）；POST 为 202 异步起线程，
  // 上屏由事件/轮询对账驱动，不再阻塞等全量 GET（修「发送后卡一下」）
  const send = useCallback(async (text?: string) => {
    const body = (text ?? input).trim()
    const readyIds = pendingFiles.filter((f) => f.status === "ready" && f.att).map((f) => f.att!.id)
    if ((!body && !readyIds.length) || sending) return
    setSending(true)
    setInput(""); setErr(null); setPendingIn(body)
    const draftState = chatWorkbenchStateForProject(workbenchStateRef.current, pid, agentId)
    publishWorkbenchState(saveChatWorkbenchDraft(draftState, agentId, tid, ""))
    const refs = refsDraft.skills.length || refsDraft.mcps.length ? refsDraft : null
    try {
      let id = tid
      if (!id) {
        // 新建线程时带上新建态选的模型（v37；空=跟随全局默认）与联网开关
        // （v43；主控开 = spawn 子代理默认继承）
        const t = await api.chatThreadCreate(pid, agentId, undefined,
                                             modelDraft?.provider, modelDraft?.model,
                                             webSearchDraft, effortDraft)
        id = t.id
        const createdState = chatWorkbenchStateForProject(workbenchStateRef.current, pid, agentId)
        const withDraft = saveChatWorkbenchDraft(createdState, agentId, null, "")
        const withThread = saveChatWorkbenchDraft(withDraft, agentId, id, "")
        publishWorkbenchState(withThread)
        setTid(id)
      }
      const r = await api.chatSend(id, body, refs, readyIds)
      // 插话（chat-hit，2026-10-21）：本轮仍在跑时后端不再 409，而是把这条消息
      // 投进该线程的通知箱，由正在跑的那一轮自己读进去。**call_expert 不受影响**
      // ——已派出的专家照旧跑完，结果以「[后台并发结果]」补达。
      // 此时不能清 pendingIn（乐观行会让用户以为起了新一轮），也不该清空输入
      // 草稿以外的东西：消息确实被收下了，只是还没被读到。
      if (r?.status === "queued") {
        // 清掉乐观行：这条消息**没有**起新轮，主控仍在跑（时间线由事件流驱动，
        // 插话本身会以 chat.hit 事件出现在流里）。
        setPendingIn(null)
        setHitQueued(body)
        setRefsDraft({ skills: [], mcps: [] })
        const sentQ = new Set(pendingFiles.filter((f) => f.status === "ready").map((f) => f.key))
        setPendingFiles((fs) => fs.filter((f) => !sentQ.has(f.key)))
        return
      }
      setRefsDraft({ skills: [], mcps: [] })
      const sent = new Set(pendingFiles.filter((f) => f.status === "ready").map((f) => f.key))
      setPendingFiles((fs) => fs.filter((f) => !sent.has(f.key)))
    } catch (e) {
      setPendingIn(null)
      setInput(body)
      const failedState = chatWorkbenchStateForProject(workbenchStateRef.current, pid, agentId)
      publishWorkbenchState(saveChatWorkbenchDraft(failedState, agentId, tid, body))
      setErr(e instanceof Error ? e.message : String(e))
    }
    finally { setSending(false); inputRef.current?.focus() }
  }, [input, sending, tid, pid, agentId, refsDraft, pendingFiles, modelDraft, workbenchState, onWorkbenchStateChange, publishWorkbenchState])

  const removeThread = useCallback(async (id: string) => {
    try {
      await api.chatThreadDelete(id)
      const draftState = chatWorkbenchStateForProject(workbenchStateRef.current, pid, agentId)
      const drafts = { ...draftState.drafts }
      delete drafts[chatDraftKey(agentId, id)]
      publishWorkbenchState({ ...draftState, drafts })
      if (id === tid) selectThread(null)
      reloadThreads(agentId)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [tid, agentId, pid, publishWorkbenchState, reloadThreads, selectThread])

  const stop = useCallback(async () => {
    if (!tid || !running || stopping) return
    setStopping(true)                 // 立刻给反馈，别等后端退出
    try {
      await api.chatStop(tid)
      reloadRef.current?.()
    } catch (e) {
      setStopping(false)              // 请求本身失败 → 恢复可点
      if (e instanceof ApiError && e.status === 409) {
        reloadRef.current?.()
        return
      }
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [tid, running, stopping])

  // 轮次真的退出后复位（后端落「已停止」说明 → status 不再是 running）
  useEffect(() => { if (!running) setStopping(false) }, [running])

  // 自动滚底（含思考增量——此前漏 liveThinking，思考增长时不跟滚，观感「卡住」）。
  // **2026-11-01 修复**：活跃会话里人向上翻历史不该被强制拽回底部——只有仍
  // 「钉在底部」时才跟滚（距底 <60px，与 OrchChatPane 同口径）。滚动事件维护
  // `pinned`；切线程时复位为钉底（新线程默认从最新开始）。
  const pinned = useRef(true)
  const onStreamScroll = () => {
    const el = scrollRef.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }
  useEffect(() => { pinned.current = true }, [tid])
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages.length, liveDelta, liveThinking, running])

  // 输入框自适应高度（2026-10-14）：下限 rows=2、上限 180px（≈8 行），超出内部滚动。
  // 必须先置 height:auto 再读 scrollHeight——否则读到上一轮写死的固定高度，删字时无法回缩；
  // 置 auto 后按 rows=2 取固有高，故空内容自然停在 2 行。用 effect（非 onChange）是为了
  // 程序化清空（发送 / /context / 点引用 chip）时也能回缩。与 LiveRoom.autoResize 同款口径。
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [input])

  const agentInitial = (a: ChatAgent | undefined) =>
    (a?.name ?? "?").slice(0, 1)

  // ---- 斜杠命令 / 引用 chips（K9-C） ----
  const runSlash = (cmd: string) => {
    if (cmd === "/context") { setUsageOpen(true); setSlash(null); setInput(""); inputRef.current?.focus() }
    else if (cmd === "/skill") { setSlash({ mode: "skills" }); setInput("") }
    else if (cmd === "/mcp") { setSlash({ mode: "mcp" }); setInput("") }
  }
  const addRef = (kind: "skills" | "mcps", name: string) => {
    setRefsDraft((r) => (r[kind].includes(name) ? r : { ...r, [kind]: [...r[kind], name] }))
    setSlash(null); setInput(""); inputRef.current?.focus()
  }
  const removeRef = (kind: "skills" | "mcps", name: string) =>
    setRefsDraft((r) => ({ ...r, [kind]: r[kind].filter((x) => x !== name) }))
  const onInputChange = (v: string) => {
    setInput(v)
    if (slash?.mode === "menu") {
      if (!v.startsWith("/") || v.includes(" ")) setSlash(null)
    } else if (!slash && v.startsWith("/") && !v.includes(" ")) {
      setSlash({ mode: "menu" })
    }
  }

  // 斜杠面板候选项：菜单按「/后文本」过滤，二级模式按输入框文本过滤
  const slashQuery = (slash?.mode === "menu" ? input.replace(/^\//, "") : slash ? input : "").trim().toLowerCase()
  const slashCmds = SLASH_COMMANDS.filter((c) => c.cmd.slice(1).includes(slashQuery))
  const slashSkills = skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(slashQuery))
  const slashMcps = mcpServers.filter((s) => `${s.name} ${s.domains.join("/")}`.toLowerCase().includes(slashQuery))

  // ---- 渲染 ----
  // 会话流渲染项（cc-haha 风格）：连续工具调用折成一行活动摘要。**memo 化**——
  // messages 只在轮询（2s）时换新数组，避免每个事件帧都重算整条时间线（卡顿源之一）。
  const items = useMemo(() => buildWbItems(messages), [messages])
  // 空态判定（2026-10-04）：无线程且无乐观行、或线程已加载但确实为空 → 回退 Hero，
  // 不再留一片空白（此前选中空线程 / 发送后竞态窗口会全空）。
  const showHero = !tid
    ? !pendingIn
    : loaded && messages.length === 0 && !pendingIn && !running
      && !(thread?.todo?.length) && !thread?.error
  // 左栏内容（会话线程列表）：停靠时不再自定宽（由左导航列给宽），未停靠时维持原宽度与拖拽调宽。
  // **智能体切换入口已从本栏移除（2026-10-16，Nan 需求）**：此前栏顶有一张 .wb-agent-trigger
  // 卡片 + 下拉，与 composer 里的 agent 药丸重复；现在全应用只在 composer 处切换
  // （.wb-composer-agent 药丸 + composer-bar 的 Agents 面板两个入口）。
  const rail = (
    <aside className={cn("wb-aside", docked && "is-docked")}
           style={docked ? undefined : { width: asideWidth, flexBasis: asideWidth }}>
      <div className="wb-aside-sub">
        会话线程
        <button className="wb-thread-new" onClick={() => selectThread(null)}>
          <Plus size={11} /> 新建
        </button>
      </div>
      <div className="wb-thread-list">
        {threads.map((t) => (
          <div key={t.id} className={cn("wb-thread", t.id === tid && "is-active")}
            onClick={() => selectThread(t.id)} title={t.title || "(未命名)"}>
            <span className={cn("wb-dot", t.status === "running" && "is-running",
              t.status === "error" && "is-error")} />
            <span className="min-w-0 flex-1">
              <span className="wb-thread-title">{t.title || "(未命名)"}</span>
              <span className="wb-thread-meta">
                {t.parent_thread_id && <span>↳ spawn</span>}
                <Clock3 size={9} />
                {fmtTime(t.updated_at)}
                <span>·</span>
                {t.todo.filter((x) => x.status === "completed").length}/{t.todo.length} 待办
              </span>
            </span>
            {/* 候选 flag 徽章（2026-10-22）：台账里有待人工确认的 flag → 黄色点
                提示「这个会话有事等你裁决」。计数随 threads 列表轮询刷新；点进
                会话后由 composer 上方的候选卡完成确认/否决。 */}
            {!!t.pending_flags && (
              <span className="wb-thread-flag" title={`有 ${t.pending_flags} 条候选 flag 待人工确认`}>
                <span className="wb-dot is-pending" />
                {t.pending_flags}
              </span>
            )}
            <button className="wb-thread-del" title="删除线程"
              onClick={(ev) => { ev.stopPropagation(); void removeThread(t.id) }}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {!threads.length && (
          // 加载态 vs 真空态（2026-10-26）：`threads=[]` 有两种含义，旧版一律
          // 渲染「暂无线程，发送消息或点『新建』」——这是一句**断言**。首屏那几十
          // 到几百毫秒（慢网/大项目可达整秒）用户读到它，就是「进去了但没有会话」。
          // 现在首次请求没回来之前只给中性提示，不替用户下结论。
          //
          // **只判 `threadsLoaded` 就够，不要再 `&& agentConfirmed`**：后者是
          // 死条件（变异测试发现）。`threadsLoaded` 只可能在三条路径变 true——
          // ① reloadThreads 成功/失败（它本身受 `agentConfirmed` 闸控）；
          // ② 预热命中（此时 agentConfirmed 同时为 true）。所以「loaded 且未确认」
          // 不可达，写上只是让人以为多了一层保护。
          threadsLoaded
            ? <div className="wb-aside-empty">暂无线程，发送消息或点「新建」</div>
            : <div className="wb-aside-loading" aria-live="polite">
                <Loader2 size={11} className="animate-spin" />加载中…
              </div>
        )}
      </div>
    </aside>
  )

  return (
    <div className="wb-shell">
      {/* 左栏：停靠进左导航列（portal）或留在原位 */}
      {docked ? createPortal(rail, railSlot) : rail}
      {/* 分割线只在未停靠时存在——停靠后本列宽度统一由左导航自己的分割线管 */}
      {!docked && (
        <div
          ref={splitterRef}
          className={cn("wb-splitter", dragging && "is-dragging")}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整侧栏宽度"
          tabIndex={0}
          onMouseDown={onSplitterDown}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setAsideWidth((w) => Math.max(ASIDE_MIN, w - 16))
            if (e.key === "ArrowRight") setAsideWidth((w) => Math.min(maxAside(), w + 16))
          }}
        />
      )}

      {/* 中栏：时间线 + 输入大卡片；标题栏信息并入统计行 */}
      <main className="wb-main">
        {/* 统计行（会话流改造 2026-10-03）：token/最后更新/条数——工作台侧取精确值 */}
        {tid && (
          <ChatStats
            tokens={(usage?.input ?? 0) + (usage?.output ?? 0)
              + (usage?.cache_read ?? 0) + (usage?.cache_creation ?? 0)}
            cachedTokens={(usage?.cache_read ?? 0) + (usage?.cache_creation ?? 0)}
            updatedAt={thread?.updated_at}
            count={messages.length}
            endAdornment={
              <>
                {thread?.challenge_asset_id && (
                  <span className="wb-badge" title="该线程绑定的 CTF 题目">
                    题目 · {assets.find((a) => a.id === thread.challenge_asset_id)?.value ?? "…"}
                  </span>
                )}
                {running && <span className="wb-badge"><span className="wb-dot is-running" />执行中</span>}
                {thread?.status === "error" && (
                  <span className="wb-badge is-error"
                    title={thread.error ? `${thread.error.title}：${thread.error.hint}` : undefined}>出错</span>
                )}
                {thread?.parent_thread_id && <span className="wb-badge is-ghost">子专家线程</span>}
              </>
            }
          />
        )}

        <div ref={scrollRef} className="wb-stream" onScroll={onStreamScroll}>
          {showHero ? (
            <Hero agentName={currentAgent?.name} isOrch={isControllerAgent(agentId)} />
          ) : (
            <div className="wb-timeline">
              {thread && (thread.todo.length > 0 || (thread.children?.length ?? 0) > 0) && (
                <TodoCard todo={thread.todo} sessions={thread.children}
                  activeId={tid} onOpen={selectThread}
                  onDelete={deleteChildThread}
                  parentId={thread.children_parent_id ?? null}
                  parentLabel={currentAgent?.name ?? agentId} />
              )}
              {runningCallExperts.length > 0 && (
                <RunningCallExperts calls={runningCallExperts} />
              )}
              {items.map((it) => {
                if (it.kind === "user") {
                  return <HumanNote key={it.m.id} m={it.m} />
                }
                // 系统注入消息（2026-10-24）：折叠 + Markdown 渲染 + 非人类视觉。
                // 正文取 `origin.body`（已剥 `〔标签〕`），标签单独显示——原文里的
                // 标签是给模型认的，不该在展开后的正文里重复一遍。
                if (it.kind === "system") {
                  return <SystemNote key={it.m.id}
                    label={it.m.origin?.label ?? "系统"}
                    body={it.m.origin?.body ?? it.m.content}
                    at={it.m.created_at ? fmtDateTime(it.m.created_at) : ""} />
                }
                if (it.kind === "thinking") {
                  return <ThinkingBlock key={it.id} content={it.content} className="wb-anim" />
                }
                if (it.kind === "prose") {
                  const stopped = it.m.content.includes("已按人类要求停止")
                  return (
                    <div key={it.m.id} className="wb-anim py-0.5">
                      <div className="flex items-baseline gap-2">
                        <MarkdownView content={it.m.content} prefix={`chat-${it.m.id}`}
                          className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-foreground/90" />
                        {stopped && <span className="wb-badge is-ghost shrink-0">已停止</span>}
                      </div>
                      <FileCardList targets={mergeTargets(it.targets, it.known)}
                        pid={pid} />
                    </div>
                  )
                }
                // activity：一轮内连续工具调用折成一行摘要，展开看逐条明细
                return (
                  <ActivityGroup key={it.id} steps={it.steps} live={running}
                    failedCount={it.steps.filter((s) => s.failed).length}
                    className="wb-anim">
                    {it.rows.map((r, idx) => {
                      if (r.kind === "thinking") return <ThinkingBlock key={r.id} content={r.content} />
                      // start 事件时刻：**串行**工具只有真正轮到的那个才有 start
                      // 事件（2026-10-14 修「同批第二个工具恒显静态运行中」）；
                      // `call_expert` 是并发的，同批会一次性全拿到 start。
                      const started = liveTools.startAtById.get(r.id)
                        ?? liveTools.legacyStarts.find((p) => p.name === r.name
                          && p.args_head === JSON.stringify(r.args ?? {}).slice(0, 300))?.created_at
                      // 激进主控的先返先触发会先落一条「[后台继续]」占位结果，
                      // 但对应 call_expert 仍在后台执行。占位不能进入完成态，否则
                      // ToolBlock 会只显示静态「Ns」，而不是「已运行 Ns」计时。
                      const pendingBackground = (r.result ?? "").startsWith("[后台继续]")
                      const rowDone = !pendingBackground
                        && (r.done || liveTools.byId.get(r.id)?.phase === "done")
                      // 「排队」判据（2026-10-21 重写，第二版）：
                      //
                      // 前两版都错了，根因是**把并发工具当成串行工具**：
                      // ① 第一版 `queued = !started && !rowDone && running`：`started`
                      //    靠事件窗口查，而窗口只有 300 条、thinking.delta 峰值 76 条/秒
                      //    → start 几十秒就被挤出去 → 所有在跑的工具全被判「排队中」。
                      // ② 第二版改成「同组内更早的 tool 行是否仍未收尾」。这**只对串行
                      //    工具有效**：`call_expert` 走 `_parallel_expert_dispatch`，
                      //    同批全部**并发**执行（见该方法 docstring：「只要有专家调用就
                      //    走并发路径（含单个）」）。三个 call_expert 同时跑、都还没结果
                      //    → 后两个被「前面还没完成」判成排队中（用户 2026-10-21 实测）。
                      //
                      // 正确判据：**`call_expert` 永不排队**（并发派发，start 即开跑）；
                      // 其余工具才按串行语义看「前面是否还有没跑完的」。
                      const isExpertCall = r.name === "call_expert"
                      const blockedByEarlier = !isExpertCall && it.rows
                        .slice(0, idx).some((p) => p.kind === "tool" && !p.done
                                            && p.name !== "call_expert")
                      const queued = !rowDone && running && blockedByEarlier
                      // 计时起点：有 start 用 start；在跑但 start 已滑出窗口 → 退到
                      // 调用发起时刻（r.at）照样计时，别退化成静态「运行中」；本轮
                      // 已停且无 start（孤儿行）不给时刻，不编造。
                      const startedAt = started
                        ?? (rowDone ? undefined : (running ? r.at : undefined))
                      return <ToolBlock key={r.id} name={r.name} args={r.args}
                        result={r.result}
                        startedAt={startedAt}
                        queued={queued}
                        running={running}
                        done={rowDone}
                        live={liveTools.byId.get(r.id)
                          ?? liveTools.legacy.find((p) => p.name === r.name
                            && p.args_head === JSON.stringify(r.args ?? {}).slice(0, 300))
                          ?? null} />
                    })}
                  </ActivityGroup>
                )
              })}
              {pendingIn && <HumanNote m={null} text={pendingIn} />}
              {/* 实时叠加层（会话流改造后统一为平铺 prose + 光标，无气泡无卡片） */}
              {(running && !stoppedRecent || !!pendingIn) && liveDelta && liveDelta !== lastAssistantText(messages) && (
                <div className="wb-anim py-0.5 text-[12.5px] leading-relaxed text-foreground/90">
                  <span className="whitespace-pre-wrap break-words">{liveDelta.slice(-600)}</span>
                  <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-primary align-middle" />
                </div>
              )}
              {(running && !stoppedRecent || !!pendingIn) && liveThinking
                && liveThinking !== lastPersistedThinking(messages) && (
                <ThinkingBlock content={liveThinking} active={running && !liveDelta}
                  className="wb-anim" />
              )}
              {running && liveToolStart && !hasPendingCall && (
                <div className="wb-anim">
                  <ToolBlock name={liveToolStart.name ?? "?"}
                    argsHead={liveToolStart.args_head} done={false}
                    startedAt={liveToolStart.created_at} />
                </div>
              )}
              {(running && !stoppedRecent || !!pendingIn) && liveFailover && !liveDelta && (
                <div className="wb-anim py-0.5 text-[11px] text-(--status-approval)">
                  🔀 供应商 {liveFailover.from ?? "?"} 失败
                  {liveFailover.category ? `（${liveFailover.category}）` : ""}
                  ，已切到 {liveFailover.to ?? "?"} 继续重试
                </div>
              )}
              {(running && !stoppedRecent || !!pendingIn) && !liveDelta && !liveThinking && !liveToolStart && !hasPendingCall && (
                <div className="wb-anim py-0.5 text-[12px] text-muted-foreground">
                  {stopping
                    ? "正在停止…"
                    : liveRetry
                      ? `正在第 ${liveRetry.attempt ?? "?"}/${liveRetry.total ?? "?"} 次重试`
                      : "思考中"}
                  <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-primary align-middle" />
                </div>
              )}
              {thread?.status === "error" && thread.error && !running && (
                <div className="wb-anim">
                  <ThreadErrorCard error={thread.error} />
                </div>
              )}
            </div>
          )}
        </div>

        {err && <div className="wb-err">{err}</div>}

        {/* 底部 dock：输入大卡片 + 能力面板 */}
        <div className="wb-dock">
          {(refsDraft.skills.length > 0 || refsDraft.mcps.length > 0) && (
            <div className="wb-refs">
              {refsDraft.skills.map((s) => (
                <button key={`sk:${s}`} className="wb-ref-chip" title="点击移除"
                  onClick={() => removeRef("skills", s)}>
                  <Zap size={10} /> {s} <X size={10} />
                </button>
              ))}
              {refsDraft.mcps.map((m) => (
                <button key={`mcp:${m}`} className="wb-ref-chip" title="点击移除"
                  onClick={() => removeRef("mcps", m)}>
                  <Cpu size={10} /> {m} <X size={10} />
                </button>
              ))}
            </div>
          )}

          {slash && (
            <div className="wb-panel wb-anim">
              <div className="wb-panel-inner">
                {slash.mode === "menu" && (
                  <>
                    {slashCmds.map((c) => (
                      <button key={c.cmd} className="wb-slash-item" onClick={() => runSlash(c.cmd)}>
                        <b>{c.cmd}</b>
                        <span>{c.desc}</span>
                      </button>
                    ))}
                    {!slashCmds.length && <div className="wb-kv">无匹配命令（Esc 关闭后可直接发送）</div>}
                  </>
                )}
                {slash.mode === "skills" && (
                  <>
                    {slashSkills.map((s) => (
                      <button key={s.name} className="wb-slash-item" onClick={() => addRef("skills", s.name)}>
                        <b>{s.name}</b>
                        <span>{s.description}</span>
                      </button>
                    ))}
                    {!skills.length && <div className="wb-kv">技能清单加载中或为空</div>}
                    {!!skills.length && !slashSkills.length && <div className="wb-kv">无匹配技能</div>}
                  </>
                )}
                {slash.mode === "mcp" && (
                  <>
                    {slashMcps.map((s) => (
                      <button key={s.name} className="wb-slash-item" onClick={() => addRef("mcps", s.name)}>
                        <b>{s.name}</b>
                        <span>{s.transport} · {s.domains.join("/")} · {s.tools.length} 工具</span>
                      </button>
                    ))}
                    {!mcpServers.length && <div className="wb-kv">无启用的 MCP server（设置页可配置）</div>}
                    {!!mcpServers.length && !slashMcps.length && <div className="wb-kv">无匹配 MCP server</div>}
                  </>
                )}
              </div>
            </div>
          )}

          {usageOpen && (
            <div className="wb-panel wb-anim">
              <div className="wb-panel-inner">
                <div className="wb-usage-head">
                  <Gauge size={12} className="text-primary" />
                  <b>上下文用量</b>
                  <span className="wb-thread-meta">{usage ? `分母 ${Math.round(ctxLimit / 1024)}K${showSoftLine ? ` · 软上限 ${Math.round(ctxSoft / 1024)}K` : ""}` : "暂无数据"}</span>
                  <button className="wb-usage-close" title="关闭" onClick={() => setUsageOpen(false)}>
                    <X size={12} />
                  </button>
                </div>
                {usage ? (
                  <>
                    <div className="wb-usage-head-row">
                      <b className="wb-usage-total">{fmtTokens(usage.input ?? 0)} / {Math.round(ctxLimit / 1024)}K</b>
                      <span className={cn("wb-usage-pct-big", usageLevel)}>{usagePct}%</span>
                    </div>
                    {bk ? (
                      <>
                        <div className="wb-usage-segs" role="img" aria-label="上下文构成分段条">
                          {usageSegs.map((s) => (
                            <i key={s.key} className={s.cls}
                              style={{ width: `${(s.tokens / ctxLimit) * 100}%` }}
                              title={`${s.label} ${fmtTokens(s.tokens)}（${Math.round((s.tokens / ctxLimit) * 100)}%）`} />
                          ))}
                          {usageFree > 0 && <i className="seg-free" style={{ width: `${(usageFree / ctxLimit) * 100}%` }} title={`剩余 ${fmtTokens(usageFree)}`} />}
                          {showSoftLine && <i className="seg-soft" style={{ left: `${softLeftPct}%` }} title={`软上限警戒线 ${Math.round(ctxSoft / 1024)}K`} />}
                        </div>
                        <div className="wb-usage-legend">
                          {usageSegs.map((s) => (
                            <div className="wb-usage-li" key={s.key}>
                              <i className={cn("wb-usage-dot", s.cls)} />
                              <b className="shrink-0">{s.label}</b>
                              <span className="wb-usage-num">{fmtTokens(s.tokens)} · {Math.round((s.tokens / ctxLimit) * 100)}%</span>
                            </div>
                          ))}
                          <div className="wb-usage-li">
                            <i className={cn("wb-usage-dot", "seg-free")} />
                            <b className="shrink-0">剩余空间</b>
                            <span className="wb-usage-num">{fmtTokens(usageFree)} · {Math.max(0, 100 - usagePct)}%</span>
                          </div>
                          {showSoftLine && (
                            <div className="wb-usage-li">
                              <i className={cn("wb-usage-dot", "seg-soft")} />
                              <b className="shrink-0">软上限</b>
                              <span className="wb-usage-num">{Math.round(ctxSoft / 1024)}K 起触发压缩</span>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="wb-usage-bar"><i className={usageLevel} style={{ width: `${usagePct}%` }} />{showSoftLine && <i className="seg-soft" style={{ left: `${softLeftPct}%` }} />}</div>
                    )}
                    {/* 缓存命中（2026-10-13）：第二根分段条——口径为**累计**（跨步自加）
                        的缓存读/写/未缓存；大号命中率 = cache_read_total / input_total，
                        右附累计步数。首步冷缓存显「首步」。 */}
                    {cache && (
                      <div className="mt-2 border-t border-border/50 pt-2">
                        <div className="wb-usage-head-row">
                          <b className="wb-usage-total">总缓存命中
                            <span className={cn("wb-usage-pct-big ml-1", cache.level)}>{cache.hitPct}%</span>
                          </b>
                          <span className="wb-thread-meta">
                            {cache.cold ? "首步（冷缓存）" : `累计 ${usage.steps ?? 0} 步`}
                          </span>
                        </div>
                        <div className="wb-usage-segs" role="img" aria-label="缓存构成分段条">
                          {cache.segs.map((s) => (
                            <i key={s.key} className={s.cls}
                              style={{ width: `${s.pct}%` }}
                              title={`${s.label} ${fmtTokens(s.tokens)}（${s.pct}%）`} />
                          ))}
                        </div>
                        <div className="wb-usage-legend">
                          {cache.segs.map((s) => (
                            <div className="wb-usage-li" key={s.key}>
                              <i className={cn("wb-usage-dot", s.cls)} />
                              <b className="shrink-0">{s.label}</b>
                              <span className="wb-usage-num">{fmtTokens(s.tokens)} · {s.pct}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="wb-kv"><b className="shrink-0">输出（累计）</b><span className="wb-usage-num">{fmtTokens(usage.output ?? 0)}</span></div>
                    <div className="wb-kv"><b className="shrink-0">模型步数</b><span className="wb-usage-num">{usage.steps ?? 0}</span></div>
                    {!bk && <div className="wb-kv is-hint">发送一条消息后生成分类构成（系统提示/工具/消息占比）</div>}
                  </>
                ) : (
                  <div className="wb-kv">本轮会话还没有用量数据，发送一条消息后生成</div>
                )}
              </div>
            </div>
          )}

          {/* 候选 flag 确认卡（ctf-flag-wake）：子代理提交候选后主控会先解释一段，
              这里给人类复制/确认的入口。与审批卡同一区块，但语义独立——
              审批卡是「要不要执行」，本卡是「这串是不是答案」。
              quota/accepted/hints 一起传：确认按钮的后果取决于「这题几条 flag」，
              多 flag 题确认一条只是 1/N、探索继续（flag-hint，2026-10-21）。 */}
          <CandidateFlagCard key={challengeId || "no-challenge"}
            flags={candidateFlags} onDecide={decideCandidateFlag}
            busy={decideFlagBusy} quota={flagQuota} accepted={flagAccepted}
            hints={flagHints} />

          {/* 待审批问答卡（贴 composer；本页即对话页 → 隐藏「和 Agent 聊聊」）。
              2026-11-01 修复：**渲染全部 pending 卡**（此前只取 [0]）——同线程
              连续触发多条审批时第二张被顶掉只留角标，用户看不到也批不到（实测
              两条 format-drive 卡：批了可见的，另一条浮出后误以为「批了没生效」）。
              每张卡按 approval.id 隔离 state（key），审批切换/移除不串状态。 */}
          {pendingApprovals.length > 0 && (
            <div className="mb-2 space-y-2">
              {pendingApprovals.map((a) => (
                <ApprovalCard key={a.id} approval={a} onDecide={decideApproval} showChat={false} />
              ))}
            </div>
          )}

          {/* 快捷建议 chips（按轨配置，2026-10-30）：贴在 flag/审批卡下方、
              输入框上方——flag 卡在上、建议在下（用户 2026-10-30 裁决排版）。
              内容来自设置页「快捷建议」（workbenchChips.ts），按项目轨区分。 */}
          {chips.length > 0 && (
            <div className="wb-chips">
              {chips.map((c) => (
                <button key={c} className="wb-chip" onClick={() => void send(c)}>{c}</button>
              ))}
            </div>
          )}

          <div className="wb-composer-wrap">
          <div className="wb-composer"
               onDragOver={(e) => { e.preventDefault() }}
               onDrop={(e) => { e.preventDefault(); void dropFiles(e.dataTransfer) }}>
            <div className="wb-composer-head">
              <button className="wb-composer-agent" onClick={() => setAgentMenuOpen(true)}>
                <span className={cn("wb-avatar is-sm", isControllerAgent(agentId) && "is-orch")}>
                  {isControllerAgent(agentId) ? <Bot size={11} /> : agentInitial(currentAgent)}
                </span>
                {currentAgent?.name ?? agentId}
                <ChevronDown size={11} className="opacity-70" />
              </button>
              <span className="wb-composer-status">
                {(running || !!pendingIn || sending)
                  ? <><span className="wb-dot is-running" />正在执行 · 可插话</>
                  : <><span className="wb-dot" />待命</>}
              </span>
            </div>
            {/* 插话已投递（chat-hit）：主控正在等专家返回，消息进了通知箱，
                它会在下一个可读点自己读进去。明确写「专家不受影响」，否则用户
                会以为这句话会打断正在跑的 call_expert。
                「立刻发送」（2026-11-01）：点击中断主控当前 LLM 调用，让它
                立刻回步边界读插话——不落墓碑、并行子代理照常跑。 */}
            {hitQueued && running && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[10.5px] text-muted-foreground">
                <span className="min-w-0 flex-1">💬 补充信息已投递，当前轮次读到后会据此调整（已派出的并行任务继续运行，结果会补达）</span>
                <button type="button"
                  className="shrink-0 rounded border border-border/70 px-1.5 py-px text-[10px] text-foreground/80 hover:bg-accent/50 disabled:opacity-60"
                  disabled={!running || sending}
                  onClick={() => {
                    if (!tid) return
                    void api.chatHitImmediate(tid).then(() => setHitQueued(null))
                      .catch((e) => setErr(e instanceof ApiError ? e.message : "打断失败"))
                  }}>
                  立刻发送
                </button>
              </div>
            )}
            {dropping && (
              <div className="mb-2 px-0.5 text-[10.5px] text-muted-foreground" aria-live="polite">
                <Loader2 size={10} className="mr-1 inline animate-spin" />{dropping}
              </div>
            )}
            {pendingFiles.length > 0 && (
              <AttachmentChipRow
                className="mb-2 px-0.5"
                items={pendingFiles.map((f) => ({
                  key: f.key, name: f.name, size: f.size, status: f.status,
                  loaded: f.loaded, error: f.error, retryable: f.retryable,
                }))}
                onRemove={removeFile}
                onRetry={retryFile}
                onClearAll={clearFiles}
              />
            )}
            <textarea
              ref={inputRef}
              rows={2}
              value={input}
              placeholder={running
                ? "当前轮次执行中：输入补充信息或纠偏，回车发送——不会中断正在运行的工具或并行任务…"
                : "描述测试意图，回车发送（Shift+回车 换行，/ 唤出命令，可粘贴或拖入附件）"}
              onChange={(e) => onInputChange(e.target.value)}
              onPaste={(e) => {
                const files = e.clipboardData?.files
                if (files && files.length) { e.preventDefault(); pickFiles(files) }
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && slash) { setSlash(null); e.preventDefault(); return }
                if (e.key !== "Enter" || e.shiftKey) return
                e.preventDefault()
                if (slash) {
                  if (slash.mode === "menu") { if (slashCmds[0]) runSlash(slashCmds[0].cmd) }
                  else if (slash.mode === "skills") { if (slashSkills[0]) addRef("skills", slashSkills[0].name) }
                  else if (slashMcps[0]) addRef("mcps", slashMcps[0].name)
                  return
                }
                void send()
              }}
            />
            <div className="wb-composer-bar">
              {(["agents", "skills", "mcp"] as const).map((t) => {
                const Icon = t === "agents" ? Bot : t === "skills" ? Zap : Plug
                return (
                  <button key={t} className={cn("wb-cap", panel === t && "is-active")}
                    onClick={() => setPanel(panel === t ? null : t)}>
                    <Icon size={12} />
                    {t === "agents" ? "Agents" : t === "skills" ? "Skills" : "MCP"}
                  </button>
                )
              })}
              <button className={cn("wb-cap", wsOpen && "is-active")}
                title={workDir
                  ? `执行工作区：${workDir}\n点击更换目录或恢复默认（立即对运行中会话生效）`
                  : "设置执行工作区目录（Agent 的 cwd / 写边界根，立即生效）"}
                onClick={() => setWsOpen(true)}>
                <FolderOpen size={12} />
                工作区
              </button>
              <button className={cn("wb-usage", usageLevel)}
                title="上下文用量（点击看明细，或输入 /context）" onClick={() => setUsageOpen((v) => !v)}>
                <UsageRing pct={usagePct} />
                <span className="wb-usage-pct">{usagePct}%</span>
              </button>
              {/* 联网搜索开关（v43，web-search-toggle，2026-10-19）：MCP/上下文
                  右侧。线程级——开 = 本线程主控与 spawn 的子代理默认可用
                  web_search（SearXNG/ddgs 双后端查公开信息）；独立于专家工具
                  勾选（不进 Agents/Skills 面板）。下一轮生效。 */}
              <button type="button" className={cn("wb-cap", webSearchOn && "is-active")}
                aria-pressed={webSearchOn}
                title={webSearchOn
                  ? "联网搜索已开启：主控与子代理可用 web_search 查公开信息（CVE/EXP/情报；SearXNG 优先、ddgs 备用，免 Key）"
                  : "联网搜索已关闭：点击开启后，本线程主控与其派出的子代理默认可用 web_search 查公开信息"}
                onClick={() => void toggleWebSearch()}>
                <Globe size={12} />
                联网
              </button>
              {/* 线程池脉冲开关（v54，ctf-pool-pulse-toggle，2026-10-31）：仅 CTF
                  主控线程显示。开（默认）= 池脉冲每 5 分钟检查该主控池目标
                  （分诊未决 1 / 决后 5 条 running），未满软提示/补派（软提示，
                  非强制）；关 = 该主控跳过检查。按线程落盘，选中哪个主控管哪个。 */}
              {ctfController && (
                <button type="button" className={cn("wb-cap", poolPulseOn && "is-active")}
                  aria-pressed={poolPulseOn}
                  title={poolPulseOn
                    ? "线程池脉冲已开启：每 5 分钟检查池目标（分诊未决 1 / 决后 5 条 running），未满软提示/自动补派（软提示，非强制）"
                    : "线程池脉冲已关闭：该主控不再每 5 分钟被池目标检查打扰"}
                  onClick={() => void togglePoolPulse()}>
                  <Gauge size={12} />
                  池脉冲
                </button>
              )}
              <span className="wb-spacer" />
              {/* 线程级模型按钮（v37，2026-10-13）：发送键左侧，点开供应商→模型浮层 */}
              <button type="button" className={cn("wb-model", modelPopOpen && "is-active")}
                title={activeModel.provider
                  ? `当前线程模型：${activeModel.provider}/${activeModel.model || "（供应商默认）"}（点击更换）`
                  : "当前线程跟随全局默认模型（点击指定）"}
                onClick={openModelPop}>
                <Cpu size={11} />
                {/* 供应商 · 模型 · 深度（用户要求三者同行可见）。供应商用弱色、
                    模型用等宽字体：整串同色时会变成一坨长文本，扫视时分不出哪段
                    是家、哪段是型号。 */}
                {activeModel.provider && (
                  <span className="wb-model-prov">{activeModel.provider}</span>
                )}
                <span className="wb-model-name">{modelName}</span>
                {/* 思考深度（v48，thinking-effort）：与模型名同行显示，让人一眼看到
                    「哪个模型 + 多深」。这跟参考图一致，也避免为了看深度再点一次。 */}
                <span className="wb-model-effort" title={`思考深度：${EFFORT_HINT[effortGear]}`}>
                  {EFFORT_LABEL[effortGear]}
                </span>
                <ChevronDown size={10} className="opacity-70" />
              </button>
              {running ? (
                <button className="wb-send is-stop" disabled={stopping}
                  onClick={() => void stop()}>
                  <Square size={11} /> {stopping ? "停止中…" : "停止"}
                </button>
              ) : (
                <button className="wb-send" disabled={!input.trim() || sending} onClick={() => void send()}>
                  {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} 发送
                </button>
              )}
            </div>
          </div>

          {/* 模型 + 深度浮层（v48，thinking-effort，2026-10-21）：
              上半部 = 当前模型（点它切供应商/模型）+ 深度名 + 重置；
              下半部 = 七档滑块，拖动即改本线程思考深度。
              浮层挂在 composer 外层 wrap（.wb-composer 有 overflow:hidden，不能内嵌）。 */}
          {modelPopOpen && (
            <>
              <div className="wb-model-backdrop" onClick={() => setModelPopOpen(false)} />
              <div className={cn("wb-model-pop", "is-effort")}>
                {/* ---- 模型行（点它切供应商/模型，用户核心诉求）+ 右侧重置 ---- */}
                <div className="wb-effort-modelrow">
                  <button type="button" className="wb-effort-switch"
                    title={activeModel.provider
                      ? `当前：${activeModel.provider}/${activeModel.model || "（供应商默认模型）"}——点击切换供应商与模型`
                      : "当前跟随全局默认模型——点击指定供应商与模型"}
                    onClick={() => setModelListOpen((v) => !v)}>
                    <Cpu size={11} className="wb-effort-switch-ico" />
                    {activeModel.provider && (
                      <span className="wb-effort-prov">{activeModel.provider}</span>
                    )}
                    <span className="wb-effort-model">{modelName}</span>
                    <ChevronRight size={11} className={cn("wb-effort-switch-arrow",
                      modelListOpen && "is-open")} />
                  </button>
                  {/* 重置入口的显示条件必须「模型有覆写 **或** 深度有覆写」——
                      只判 provider 的话，用户只调了深度（没选供应商）就永远
                      看不到重置按钮，只能靠再点一次默认档名才知道怎么回去。 */}
                  {(activeModel.provider || activeEffort) && (
                    <button type="button" className="wb-effort-reset"
                      title={activeModel.provider
                        ? "恢复默认：模型跟随全局、深度跟随供应商配置"
                        : "恢复默认深度（跟随供应商配置）"}
                      onClick={() => {
                        if (activeModel.provider) void chooseModel("", "")
                        void chooseEffort(EFFORT_DEFAULT)
                      }}>
                      <RotateCcw size={11} />
                    </button>
                  )}
                </div>

                {/* ---- 下半部：档位名 + 说明 + 七档轨道 + 可点刻度 ---- */}
                <EffortSlider value={effortGear} onChange={(g) => void chooseEffort(g)} />

                {/* ---- 供应商/模型列表（默认收起，点上方模型名展开）---- */}
                {modelListOpen && (
                  <div className="wb-effort-models">
                    <button type="button"
                      className={cn("wb-model-opt", !activeModel.provider && "is-current")}
                      onClick={() => { void chooseModel("", ""); setModelListOpen(false) }}>
                      <span>默认模型（跟随全局）</span>
                      {!activeModel.provider && <Check size={12} />}
                    </button>
                    {!enabledProviders.length && (
                      <div className="wb-model-hint">无启用的供应商（请在设置页配置）</div>
                    )}
                    {enabledProviders.map((p) => (
                      <div key={p.name}>
                        <button type="button"
                          className={cn("wb-model-opt", popProvider === p.name && "is-open")}
                          onClick={() => setPopProvider(popProvider === p.name ? "" : p.name)}>
                          <span className="min-w-0 truncate">{p.name}</span>
                          {activeModel.provider === p.name
                            ? <span className="wb-model-tag">当前</span>
                            : <ChevronDown size={11} className={cn("shrink-0 opacity-60",
                                popProvider === p.name && "rotate-180")} />}
                        </button>
                        {popProvider === p.name && (
                          <div className="wb-model-sub">
                            {(p.models ?? []).map((m) => (
                              <button key={m} type="button"
                                className={cn("wb-model-opt",
                                  activeModel.provider === p.name && activeModel.model === m && "is-current")}
                                onClick={() => { void chooseModel(p.name, m); setModelListOpen(false) }}>
                                <span className="wb-model-opt-m min-w-0 truncate">{m}</span>
                                {activeModel.provider === p.name && activeModel.model === m
                                  && <Check size={12} className="shrink-0" />}
                              </button>
                            ))}
                            <button type="button"
                              className={cn("wb-model-opt",
                                activeModel.provider === p.name && !activeModel.model && "is-current")}
                              onClick={() => { void chooseModel(p.name, ""); setModelListOpen(false) }}>
                              <span className="wb-model-opt-m">供应商默认模型</span>
                              {activeModel.provider === p.name && !activeModel.model
                                && <Check size={12} className="shrink-0" />}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* 智能体选择浮层（2026-10-16 从左栏迁来）：由 composer 的 .wb-composer-agent 药丸
              触发，向上弹出。必须挂在 composer 外层 wrap —— .wb-composer 自身 overflow:hidden，
              内嵌会被裁掉（与上面的模型浮层同理）。backdrop 负责点外部关闭。 */}
          {agentMenuOpen && (
            <>
              <div className="wb-model-backdrop" onClick={() => setAgentMenuOpen(false)} />
              <div className="wb-agent-menu">
                <div className="wb-agent-menu-label">智能体</div>
                {agents.map((a) => (
                  <button key={a.id}
                    className={cn("wb-agent-option", a.id === agentId && "is-current")}
                    onClick={() => {
                      const base = chatWorkbenchStateForProject(workbenchStateRef.current, pid, agentId)
                      const saved = saveChatWorkbenchDraft(base, agentId, tid, inputStateRef.current)
                      const nextState = selectChatWorkbenchAgent(saved, a.id)
                      publishWorkbenchState(nextState)
                      setAgentId(a.id); setTid(nextState.tid)
                      setInput(chatWorkbenchDraft(nextState, a.id, nextState.tid))
                      setAgentMenuOpen(false)
                    }}>
                    <span className={cn("wb-avatar", isControllerAgent(a.id) && "is-orch")}>
                      {isControllerAgent(a.id) ? <Bot size={13} /> : agentInitial(a)}
                    </span>
                    <span className="wb-agent-option-body">
                      <span className="wb-agent-option-name">
                        {a.name}
                        {a.id === agentId && <Check size={12} className="wb-check" />}
                      </span>
                      <span className="wb-agent-option-desc">{a.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          </div>

          {panel && (
            <div className="wb-panel wb-anim">
              <div className="wb-panel-inner">
                {panel === "agents" && (
                  <div className="wb-panel-grid">
                    {agents.map((a) => (
                      <button key={a.id}
                        className={cn("wb-panel-card", a.id === agentId && "is-current")}
                        onClick={() => {
                          const base = chatWorkbenchStateForProject(workbenchStateRef.current, pid, agentId)
                          const saved = saveChatWorkbenchDraft(base, agentId, tid, inputStateRef.current)
                          const nextState = selectChatWorkbenchAgent(saved, a.id)
                          publishWorkbenchState(nextState)
                          setAgentId(a.id); setTid(nextState.tid)
                          setInput(chatWorkbenchDraft(nextState, a.id, nextState.tid))
                          setPanel(null)
                        }}>
                        <div className="flex items-center gap-1.5 text-[11.5px] font-semibold">
                          {isControllerAgent(a.id) ? <Bot size={11} className="text-primary" /> : <Sparkles size={11} className="text-muted-foreground" />}
                          {a.name}
                        </div>
                        <div className="wb-panel-line mt-0.5">{a.description}</div>
                      </button>
                    ))}
                  </div>
                )}
                {panel === "skills" && (
                  <div>
                    {skills.map((s) => (
                      <button key={s.name} className="wb-kv wb-kv-click" title="点击添加到本轮（仅当轮生效）"
                        onClick={() => addRef("skills", s.name)}>
                        <b className="shrink-0">{s.name}</b>
                        <span className="truncate">{s.description}</span>
                        <Plus size={11} className="wb-kv-add" />
                      </button>
                    ))}
                    {!skills.length && <div className="wb-kv">技能清单加载中或为空</div>}
                  </div>
                )}
                {panel === "mcp" && (
                  <div className="grid gap-2">
                    <div className="flex items-center justify-between">
                      <span className="wb-thread-meta">MCP 服务器（点选加入本轮）</span>
                      <button className="wb-cap" title="重新探测 MCP 工具"
                        onClick={() => loadMcp(true)}>
                        <RefreshCw size={11} /> 刷新
                      </button>
                    </div>
                    {mcpServers.map((s) => (
                      <button key={s.name} className="wb-mcp-row" title="点击添加到本轮（仅当轮生效）"
                        onClick={() => addRef("mcps", s.name)}>
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                          <Cpu size={11} className="text-primary" />
                          {s.name}
                          <span className={cn("wb-dot", s.online && "is-running")} />
                          <span className="wb-thread-meta">{s.transport} · {s.domains.join("/")}</span>
                          {s.session_scoped && <span className="wb-thread-meta">项目内嵌</span>}
                          <Plus size={11} className="wb-kv-add" />
                        </div>
                        <div className="wb-panel-line mt-0.5 pl-5">
                          {s.tools.length
                            ? `已发现 ${s.tools.length} 个工具：${s.tools.map((t) => t.name).join("、")}`
                            : "（工具发现失败或为空，请检查 MCP 进程）"}
                        </div>
                      </button>
                    ))}
                    {!mcpServers.length && <div className="wb-kv">无启用的 MCP server（设置页可配置）</div>}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 右栏：会话上下文 + 漏洞/发现（默认收起） */}
      <WorkbenchContextRail pid={pid} tid={tid} workDir={workDir} track={meta?.track} />

      {/* 工作区目录弹层（2026-10-30，全轨显示）：选择外部目录为执行工作区 / 恢复默认 */}
      <DirectoryPickerDialog
        pid={pid}
        open={wsOpen}
        onClose={() => setWsOpen(false)}
        title="选择工作区目录"
        desc={<>选中的目录将作为 Agent 的<b className="font-semibold text-foreground">执行工作区</b>（cwd / 写边界根），不复制不扫描，设置后立即对运行中会话生效；平台数据（黑板 / 产物）仍留在项目内。</>}
        confirmLabel="设为工作区"
        clearLabel="恢复默认工作区"
        hint={workDir ? `当前执行工作区：${workDir}` : null}
        onClear={workDir ? () => void applyWorkspace(null) : undefined}
        onPick={(path) => void applyWorkspace(path)}
      />
    </div>
  )
}

// 用量圆环（K9-C）：环形进度，颜色档位由外层 .wb-usage.is-* 控制
function UsageRing({ pct }: { pct: number }) {
  const r = 6.5
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 18 18" width={16} height={16} aria-hidden>
      <circle className="wb-ring-bg" cx="9" cy="9" r={r} fill="none" strokeWidth="2.6" />
      {pct > 0 && (
        <circle className="wb-ring-fg" cx="9" cy="9" r={r} fill="none" strokeWidth="2.6"
          strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round"
          transform="rotate(-90 9 9)" />
      )}
    </svg>
  )
}

function fmtTokens(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}K` : String(n)
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso.endsWith("Z") || iso.includes("T") ? iso : iso.replace(" ", "T") + "Z")
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
  } catch { return "" }
}

// 轮次失败错误卡片（2026-10-01）：分类标题 + 友好原因/建议 + 可折叠技术细节。
// 后端在 round 失败时落 chat_threads.error（status=error），此处渲染于时间线末尾。
function ThreadErrorCard({ error }: { error: ChatThreadError }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-(--status-error)/40 bg-(--status-error)/5 px-3.5 py-2.5 text-[12.5px]">
      <div className="mb-1.5 flex items-center gap-2">
        <AlertTriangle size={13} className="shrink-0 text-(--status-error)" />
        <span className="text-[12.5px] font-semibold text-(--status-error)">本轮执行失败 · {error.title}</span>
        <span className="ml-auto shrink-0 rounded-full border border-(--status-error)/35 px-2 py-0.5 font-mono text-[9px] tracking-wide text-(--status-error)/90">
          {error.category}
        </span>
      </div>
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">{error.hint}</p>
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="mt-2 inline-flex items-center gap-1 text-[10px] text-primary hover:underline">
        <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} />
        {open ? "收起技术细节" : "展开技术细节"}
      </button>
      {open && (
        <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-background/70 p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-words text-(--status-error)/80">
          {error.message}
        </pre>
      )}
    </div>
  )
}

function Hero({ agentName, isOrch }: { agentName?: string; isOrch: boolean }) {
  return (
    <div className="wb-hero">
      <div className="wb-hero-mark"><Bot size={24} /></div>
      <h2>{agentName ? `与 ${agentName} 开始对话` : "选择智能体开始对话"}</h2>
      <p>
        {isOrch
          ? "主控会把测试意图拆解为待办并委派专家执行；专家线程全程留档，可随时回看与追问。"
          : "直接下达该专家负责范围内的测试任务；过程与结论都会落档。"}
      </p>
      <div className="wb-hero-hint"><Wrench size={10} /> AGENTS · SKILLS · MCP · 输入 / 唤出命令</div>
    </div>
  )
}

// ---------- 会话流装配（2026-10-03 cc-haha 风格） ----------
// ChatMessage[] → 渲染项：连续 assistant(tool_calls) + tool(result) 归入同一
// activity 组（折成一行摘要）；有正文的 assistant 走 prose 行 + 文件卡。
// 纯函数，不碰 React——与直播间 lib/turnStream.ts 的 buildStreamItems 同思路，
// 但消息模型不同（ChatMessage[] vs BBEvent[]）故各自实现。

// 活动组内一行：工具调用 或 该步的思考（思考折进行内，摘要也能带上「思考」计数）
// `at` = 发起该调用的 assistant 消息时刻（2026-10-14）：**串行**工具由后端逐个执行，
// `chat.tool` 的 start 事件只在真正轮到它时才发 → 排队中的工具没有 start 时刻，前端
// 只能退到「调用发起时刻」计时（显示「排队中 Ns」），否则只能挂一个静态「运行中」。
// **`call_expert` 例外**：同批全部并发派发（`_parallel_expert_dispatch`），start 即
// 开跑，永不排队——见渲染处的排队判据（2026-10-21 修正）。
type GroupRow =
  | { kind: "tool"; id: string; name: string; args?: Record<string, unknown>
      result?: string; done: boolean; at?: string }
  | { kind: "thinking"; id: string; content: string }

type WbItem =
  | { kind: "user"; m: ChatMessage }
  | { kind: "system"; m: ChatMessage }
  | { kind: "thinking"; id: string; content: string }
  | { kind: "activity"; id: string; steps: ActivityStep[]; rows: GroupRow[] }

/** 时间戳解析：与 lib/datetime.ts parseTs 同口径（含 packs 紧凑形态） */
function tsOf(iso: string): number {
  const t = parseTs(iso).getTime()
  return Number.isFinite(t) ? t : 0
}

// 叙述段（prose）——含所属轮的工具目标（文件卡对账用，渲染时才合并，保持纯函数）
type WbProse = { kind: "prose"; m: ChatMessage; targets: FileTarget[]; known: FileTarget[] }

/** ChatMessage[] → 渲染项。连续 assistant(tool_calls)+tool(result) 归入同一 activity 组。 */
function buildWbItems(messages: ChatMessage[]): (WbItem | WbProse)[] {
  const out: (WbItem | WbProse)[] = []
  let pending: { steps: ActivityStep[]; rows: GroupRow[]; known: FileTarget[] } | null = null
  const flush = () => {
    if (!pending) return
    out.push({ kind: "activity", id: `act-${pending.rows[0]?.id ?? out.length}`,
               steps: pending.steps, rows: pending.rows })
    pending = null
  }
  for (const m of messages) {
    // 系统注入的 user 行单独成行（2026-10-24）：后端在 `origin` 字段里标了它是
    // 「系统补达」这类背景事实，不是人说的话。**必须在 flush 前分流**——否则它
    // 会和人类提问混在同一视觉族里（此前一律渲染成 `❯ 我说的话`）。
    if (m.role === "user" && m.origin) { flush(); out.push({ kind: "system", m }); continue }
    if (m.role === "user") { flush(); out.push({ kind: "user", m }); continue }
    if (m.role === "tool") continue  // 结果挂在对应 tool_call 上，不单独出行
    const calls = m.tool_calls ?? []
    const thinking = (m.thinking ?? "").trim() ? (m.thinking as string) : ""
    if (!calls.length) {
      flush()
      // 思考先于正文成行（cc-haha 风格：单行折叠，展开看全文）
      if (thinking) out.push({ kind: "thinking", id: `th-${m.id}`, content: thinking })
      out.push({ kind: "prose", m, targets: targetsFromProse(m.content, []), known: [] })
      continue
    }
    // 有工具调用的 assistant：正文（若有）先出 prose，工具并进当前 activity 组
    if (m.content) {
      flush()
      // 有正文时思考单独成行（先于正文）——否则并进后面的活动组会落到正文下方
      if (thinking) out.push({ kind: "thinking", id: `th-${m.id}`, content: thinking })
      out.push({ kind: "prose", m: { ...m, tool_calls: [] },
                 targets: targetsFromProse(m.content, []), known: [] })
    }
    if (!pending) pending = { steps: [], rows: [], known: [] }
    // 无正文时思考并进活动组：摘要能带上「思考」计数（对齐 cc-haha）
    if (thinking && !m.content) {
      pending.rows.push({ kind: "thinking", id: `th-${m.id}`, content: thinking })
      pending.steps.push({ kind: "thinking", name: "thinking", ts: tsOf(m.created_at) })
    }
    for (const tc of calls) {
      // 同 tool_use_id 可能有两行 tool 结果（激进主控先返先触发：主线程先落
      // 「[后台继续]」占位，worker 完成后以同 id 续写真实结果）——取最后一
      // 行，探针卡从「后台继续」平滑更新为真实结果。单结果行历史等价。
      const trs = messages.filter((x) => x.role === "tool" && x.tool_use_id === tc.id)
      const tr = trs.length ? trs[trs.length - 1] : undefined
      pending.rows.push({ kind: "tool", id: tc.id, name: tc.name, args: tc.args,
                          result: tr?.content, done: !!tr, at: m.created_at })
      pending.steps.push({
        kind: tc.name === "run_cmd" ? "command" : "tool",
        name: tc.name,
        ts: tsOf(m.created_at),
        dedupKey: tc.name === "read_file" ? String(tc.args?.path ?? "") : undefined,
        failed: !!tr && (tr.content ?? "").startsWith("[错误"),
      })
      pending.known.push(...targetsFromTool(tc.name, tc.args, tr?.content))
    }
    // 该轮的工具目标回填给「轮内叙述」——同 basename 时叙述文件卡指向真实路径
    if (pending.known.length) {
      for (let i = out.length - 1; i >= 0; i--) {
        const it = out[i]
        // `system` 与 `user` 同为「消息行边界」：文件卡只回填给**本轮的**叙述，
        // 跨过一条系统注入消息去回填上一轮的 prose 会把文件卡挂错地方。
        if (it.kind === "activity" || it.kind === "user" || it.kind === "system") break
        if (it.kind === "prose") { it.known = pending.known; break }
      }
    }
  }
  flush()
  return out
}

/** 最后一条已持久化的思考正文——实时思考尾块据此去重（持久化后不再重复显示）。 */
function lastPersistedThinking(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "assistant" && m.thinking) return m.thinking
  }
  return ""
}

/** 思考深度滑块（v48，thinking-effort，2026-10-21）。
 *
 * 七档**等距吸附**：拖动时实时显示最近的档位名，松手才提交（`onChange`）。
 * 用 pointer 事件而非 HTML range——range 在 7 档这种「离散 + 要大点击热区」
 * 的场景下手感很差（拇指宽度跨两个档位，拖起来像坏了一样）。
 *
 * 不在这里存本地状态：`value` 完全受控于父级（父级做了乐观更新 + 失败回滚），
 * 组件自己再存一份会在回滚时与父级打架。
 *
 * 布局三行（用户反馈「很粗糙」后的重做，2026-10-22）：
 *   ① 当前档名 + 一行说明（左对齐，读得顺；不再单独居中占一行重复显示）
 *   ② 轨道：底色 + 渐隐填充 + 滑钮（带光晕）
 *   ③ 七个**可点**刻度标签（此前只有 3px 小圆点，用户根本看不出每格是什么档）
 */
// 滑钮直径（px）。首尾格的钮心要内缩半个钮宽，否则白点压在圆角外面。
// 与 index.css 里 `.wb-effort-knob { width/height }` 必须一致；
// `.wb-effort-rail` 的左右 inset 也用它（CSS 里写死 8px，同步改）。
const KNOB = 16
const KNOB_HALF = KNOB / 2

function EffortSlider({ value, onChange }: {
  value: EffortGear
  onChange: (g: EffortGear) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  // 拖动过程中的预览档位（未提交）。松手前只改显示，不发请求。
  const [preview, setPreview] = useState<EffortGear | null>(null)
  const shown = preview ?? value
  const idx = gearIndex(shown)
  const pct = idx / (EFFORT_GEARS.length - 1)

  // 换算基准必须与视觉一致：滑钮/刻点定位在内缩 8px 的 rail 上，若这里用
  // 整条轨道的矩形换算，点最右端会落在第 6 段中点偏左 → 拖到末尾却停在前一档。
  const gearAt = useCallback((clientX: number): EffortGear => {
    const el = trackRef.current
    if (!el) return value
    const r = el.getBoundingClientRect()
    const inner = r.width - KNOB
    if (inner <= 0) return value
    const ratio = Math.min(1, Math.max(0, (clientX - r.left - KNOB_HALF) / inner))
    // 四舍五入到最近档：7 档 6 段，0.5 段宽为分界
    const i = Math.round(ratio * (EFFORT_GEARS.length - 1))
    return EFFORT_GEARS[Math.min(EFFORT_GEARS.length - 1, Math.max(0, i))]
  }, [value])

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    // preventDefault 会连带阻止「按下即聚焦」的默认行为——不手动 focus 的话
    // tabIndex=0 形同虚设，`onKeyDown` 永远收不到事件（键盘用户完全用不了）。
    // 实测踩过：Home/End/方向键全无反应，而 aria 属性看起来一切正常。
    e.preventDefault()
    e.currentTarget.focus()
    // setPointerCapture 让指针移出轨道后仍能收到 move/up——否则拖快一点就断
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    setPreview(gearAt(e.clientX))
  }
  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setPreview(gearAt(e.clientX))
  }
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const g = gearAt(e.clientX)
    setDragging(false)
    setPreview(null)
    if (g !== value) onChange(g)
  }

  const step = (dir: -1 | 1) => {
    const next = gearIndex(value) + dir
    if (next >= 0 && next < EFFORT_GEARS.length) onChange(EFFORT_GEARS[next])
  }

  return (
    <div className="wb-effort-slider">
      {/* ① 当前档：名字在前、说明跟随。左对齐而非居中——居中会让「高 + 默认档位
          平衡之选」读成两截，左对齐时它是完整一句话。 */}
      <div className="wb-effort-cur" title={EFFORT_HINT[shown]}>
        <span className="wb-effort-cur-name">{EFFORT_LABEL[shown]}</span>
        <span className="wb-effort-hint">{EFFORT_HINT[shown]}</span>
        <span className="wb-effort-count">{idx + 1}/{EFFORT_GEARS.length}</span>
      </div>

      {/* ② 轨道 */}
      <div className={cn("wb-effort-track", dragging && "is-drag")}
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-valuemin={0}
        aria-valuemax={EFFORT_GEARS.length - 1}
        aria-valuenow={idx}
        aria-valuetext={EFFORT_HINT[shown]}
        aria-label="思考深度"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => {
          // 键盘可达：方向键/Home/End，拖不动的人也能调
          if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); step(-1) }
          else if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); step(1) }
          else if (e.key === "Home") { e.preventDefault(); onChange(EFFORT_GEARS[0]) }
          else if (e.key === "End") {
            e.preventDefault(); onChange(EFFORT_GEARS[EFFORT_GEARS.length - 1])
          }
        }}>
        {/* 内层 rail 左右各缩 KNOB_HALF：滑钮按 0..100% 定位在 rail 内，
            首尾两格自然贴住轨道圆角内侧，不会溢出。用嵌套容器而不是 calc
            ——`calc((100% - 16px) * 1)` 这种「长度乘数字」在实测里没有按预期
            生效（滑钮跑到了最左），嵌套容器的百分比基准是确定的。 */}
        <div className="wb-effort-rail">
          {/* fill 的 left 是 -KNOB_HALF（见 index.css），所以宽度要
              `2 * KNOB_HALF + pct*100%` 才能从「轨道左端」铺到「滑钮外沿」：
              起点已经左移了半个钮宽，再加一个钮宽才覆盖到滑钮右侧。
              `pct*100%` 的基准就是 rail 宽，而 rail 宽 = track 宽 - KNOB，
              于是两端都不留裸底色——右端那半个钮宽由滑钮自己压住。
              （不能写成 `calc((100% - 16px) * pct)`：实测那种「长度乘数字」在
              这个嵌套结构里不按预期生效，滑钮/填充会跑到最左端。） */}
          <div className="wb-effort-fill"
            style={{ width: `calc(${KNOB}px + ${pct * 100}%)` }} />
          <div className="wb-effort-knob" style={{ left: `${pct * 100}%` }} />
        </div>
      </div>

      {/* ③ 七档刻度标签：既可点跳档，也是唯一的「每格是什么」的说明。
          此前只有 3px 圆点，用户看不出档位分布——这就是「粗糙」的主因。
          用与填充条同一套内缩公式（rail inset + 等分），保证标签与滑钮共线。 */}
      <div className="wb-effort-ticks">
        {EFFORT_GEARS.map((g, i) => (
          <button key={g} type="button"
            className={cn("wb-effort-tick", i === idx && "is-on", i < idx && "is-past")}
            style={{ left: `${(i / (EFFORT_GEARS.length - 1)) * 100}%` }}
            title={EFFORT_HINT[g]}
            aria-label={`${EFFORT_LABEL[g]}——${EFFORT_HINT[g]}`}
            aria-current={i === idx ? "true" : undefined}
            // 点刻度直接跳档；按钮自身不参与 tab 序（滑块本体已可键盘操作，
            // 再塞 7 个 tab 停靠点会让 Tab 走不动路）
            tabIndex={-1}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => { if (g !== value) onChange(g) }}>
            {EFFORT_LABEL[g]}
          </button>
        ))}
      </div>
    </div>
  )
}

// 人类消息行（会话流改造 2026-10-03）：单行 `❯ <text>`——去气泡，对齐 cc-haha。
// m=null 时用 text（乐观上屏的 pendingIn 占位）。
function HumanNote({ m, text }: { m: ChatMessage | null; text?: string }) {
  const body = text ?? m?.content ?? ""
  // 发送时刻（2026-10-21 用户需求）：贴在消息正文**后面**，一眼能看出这条是什么
  // 时候发的——排查「等了多久才被主控读到」「两条插话的先后」时都要用。
  // 走 fmtDateTime（YYYY-MM-DD HH:mm:ss）：它内部用 parseTs 把后端 naive ISO
  // 按 UTC 解析再转本地，裸 new Date 会按本地时区算出偏移（本仓既有坑）。
  // 乐观行（pendingIn，m=null）没有真实时刻——不编造，整段时间戳都不渲染。
  const at = m?.created_at ? fmtDateTime(m.created_at) : ""
  return (
    <div className="wb-anim py-1 text-[13px] leading-relaxed">
      <span className="mr-1.5 select-none font-mono text-primary">❯</span>
      <span className="whitespace-pre-wrap break-words text-foreground">{body}</span>
      {at && (
        <span className="ml-2 shrink-0 select-none font-mono text-[10px] text-muted-foreground/70">
          {at}
        </span>
      )}
    </div>
  )
}

function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === "assistant" && messages[i].content) return messages[i].content
  return ""
}

const CHILD_VISIBLE_MAX = 12

function TodoCard({ todo, sessions = [], activeId, onOpen, onDelete, parentId = null, parentLabel = "" }: {
  todo: { id: string; title: string; status: string }[]
  /** 本线程（或其父主控）spawn 过的子会话（`ChatThread.children`），不是 React 的 children */
  sessions?: ChatThreadChild[]
  /** 当前打开的线程 id（在 sessions 里时高亮，看子线程时可认位置） */
  activeId?: string | null
  onOpen?: (id: string) => void
  /** 删掉一条子会话（= 释放一个 spawn 名额；运行中的不给删，后端也会 409） */
  onDelete?: (id: string) => void
  /** 当前主控线程 id（= `ChatThread.children_parent_id`；看子线程时才有，点它跳回主控） */
  parentId?: string | null
  /** 当前主控显示名（选中智能体名；看子线程时它仍是主控） */
  parentLabel?: string
}) {
  const [collapsed, setCollapsed] = useState(false)
  const done = todo.filter((t) => t.status === "completed").length
  const pct = todo.length ? Math.round((done / todo.length) * 100) : 0
  return (
    <div className={cn("wb-todo", collapsed && "is-collapsed")}>
      <div className="wb-todo-head">
        <CircleSlash size={11} /> 待办
        {todo.length > 0 && (
          <span className="wb-todo-count">{done}/{todo.length} 完成 · {pct}%</span>
        )}
        <button type="button" className="wb-todo-toggle"
          aria-label={collapsed ? "展开待办清单" : "折叠待办清单"}
          aria-expanded={!collapsed}
          title={collapsed ? "展开待办清单" : "折叠待办清单"}
          onClick={() => setCollapsed((value) => !value)}>
          <ChevronDown size={13} className={cn(collapsed && "-rotate-90")} />
        </button>
      </div>
      {!collapsed && (
        <>
          {todo.length > 0 && (
            <div className="wb-todo-bar"><i style={{ width: `${pct}%` }} /></div>
          )}
          {todo.map((t) => (
            <div key={t.id} className={cn("wb-todo-item",
              t.status === "completed" && "is-done",
              t.status === "in_progress" && "is-doing")}>
              <span className="wb-todo-glyph">
                {t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"}
              </span>
              <span>{t.title}</span>
            </div>
          ))}
          {/* 本会话开启过的子会话（2026-10-31）：专家是主控的手脚，点一条直接
              跳进去看全过程。只在该主控线程确实 spawn 过子线程时出现。
              长任务可能开过几十条 → 只摊最近 12 条（按派发序），其余折叠成一行提示
              以免 sticky 卡片吃掉整个视野。 */}
          {sessions.length > 0 && (
            <div className="wb-todo-sessions">
              <div className="wb-todo-sessions-head">
                <span>会话线程</span>
                <span className="wb-todo-sessions-count">{sessions.length}</span>
              </div>
              {/* 当前主控（2026-11-01 Nan 要求）：待办里一眼知道这批会话归谁；
                  看子线程时这一行就是跳回主控的快捷入口（parentId=children_parent_id），
                  点它切回主控线程；本线程就是主控时置灰高亮（无跳转）。 */}
              {parentLabel && (
                <button type="button" disabled={!parentId}
                  className={cn("wb-todo-session is-parent", !parentId && "is-active")}
                  title={parentId ? `回到主控：${parentLabel}` : `当前主控：${parentLabel}`}
                  onClick={() => parentId && onOpen?.(parentId)}>
                  <Bot size={11} className="shrink-0" />
                  <span className="wb-todo-session-agent">主控</span>
                  <span className="wb-todo-session-title">{parentLabel}</span>
                </button>
              )}
              {sessions.slice(-CHILD_VISIBLE_MAX).map((c) => (
                // 任务文本取**最近一次派发**（后端 ask_expert 会刷新 title/
                // spawned_task，2026-11-03）；悬浮显示完整消息，行内由 CSS 截断。
                <button key={c.id} type="button"
                  className={cn("wb-todo-session", c.id === activeId && "is-active")}
                  title={`${c.id} · ${c.spawned_task || c.title || ""}`}
                  onClick={() => onOpen?.(c.id)}>
                  <span className={cn("wb-dot",
                    c.status === "running" && "is-running",
                    c.status === "error" && "is-error")} />
                  <span className="wb-todo-session-agent">{c.agent_id}</span>
                  <span className="wb-todo-session-title">
                    {c.title || c.spawned_task || "(未命名)"}
                  </span>
                  {c.status !== "idle" && (
                    <span className={cn("wb-todo-session-status",
                      c.status === "running" ? "is-running" : "is-error")}>
                      {c.status}
                    </span>
                  )}
                  {onDelete && c.status !== "running" && (
                    <span role="button" className="wb-todo-session-del"
                      title="删除该会话（释放一个子线程名额）"
                      aria-label="删除该会话"
                      onClick={(e) => { e.stopPropagation(); onDelete(c.id) }}>
                      <X size={11} />
                    </span>
                  )}
                </button>
              ))}
              {sessions.length > CHILD_VISIBLE_MAX && (
                <div className="wb-todo-sessions-note">
                  仅列最近 {CHILD_VISIBLE_MAX} 条（共 {sessions.length}）
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function RunningCallExperts({ calls }: {
  calls: { id: string; tool: { args_head?: string; created_at?: string } }[]
}) {
  const [, redraw] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => redraw((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <section className="wb-running-experts" aria-label="运行中的子代理">
      <div className="wb-running-experts-head">
        <span className="wb-dot is-running" />
        <span>子代理运行中</span>
        <span className="wb-running-experts-count">{calls.length}</span>
      </div>
      {calls.map(({ id, tool }) => {
        let task = ""
        if (tool.args_head) {
          try {
            const args = JSON.parse(tool.args_head) as Record<string, unknown>
            task = String(args.task ?? args.prompt ?? args.goal ?? "")
          } catch { /* 截断或非 JSON 参数时仅显示调用状态。 */ }
        }
        const startedAt = tool.created_at ? parseTs(tool.created_at).getTime() : NaN
        const seconds = Number.isNaN(startedAt)
          ? 0 : Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
        return (
          <div key={id} className="wb-running-expert">
            <Loader2 size={12} className="wb-running-expert-spinner animate-spin" />
            <span className="wb-running-expert-name">子代理</span>
            <span className="wb-running-expert-task" title={task}>{task || "正在执行委派任务"}</span>
            <span className="wb-running-expert-time">{seconds}s</span>
          </div>
        )
      })}
    </section>
  )
}

// 工具明细行（会话流改造 2026-10-03）：折在 ActivityGroup 展开态里的一行，
// 点开看参数/结果原文（Tailwind 工具类，不再用 .wb-tool 卡片样式）。
function ToolBlock({ name, args, argsHead, result, done, live, startedAt, queued, running }: {
  name: string; args?: Record<string, unknown>; argsHead?: string
  result?: string; done: boolean
  live?: { ok?: boolean; duration_s?: number; result_head?: string } | null
  startedAt?: string
  /** 已发起但尚未轮到执行（**仅串行工具**会排队；`call_expert` 并发，恒不排队） */
  queued?: boolean
  /** 本轮是否仍在跑：区分「运行中」与「已中断」孤儿行（无计时起点时用） */
  running?: boolean
}) {
  const [open, setOpen] = useState(false)
  // 运行中逐秒刷新「已运行 Ns」（2026-10-13）：替代静态「运行中」，长工具（MCP 全量
  // 分诊可达数十秒）能看出在跑而非卡死。结束/无起始时刻即停表。起始时刻必须走
  // parseTs（后端 naive ISO 按 UTC 解析），裸 new Date 会按本地时区算出负差 → 恒 0s。
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (done || !startedAt) return
    const t0 = parseTs(startedAt).getTime()
    const tick = () => setElapsed(
      Number.isNaN(t0) ? 0 : Math.max(0, Math.floor((Date.now() - t0) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [done, startedAt])
  // ok 三态来源：持久化结果行 → 「[错误]」前缀约定；事件实时态 → 后端结构化 ok
  const ok = done
    ? live ? live.ok !== false : !(result ?? "").startsWith("[错误")
    : live ? live.ok !== false : true
  return (
    <div className="rounded-md border border-border/50 bg-card/40">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left">
        <span className={cn("shrink-0", !done ? "text-primary" : ok ? "text-muted-foreground" : "text-(--status-error)")}>
          {!done ? <Loader2 size={10} className="animate-spin" />
            : ok ? <Wrench size={10} /> : <CircleSlash size={10} />}
        </span>
        <span className="shrink-0 font-mono text-[11px] font-semibold text-foreground/85">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/70">
          {args ? JSON.stringify(args).slice(0, 140) : argsHead ?? ""}
        </span>
        {!done && <span className={cn("shrink-0 font-mono text-[9px]",
          queued ? "text-muted-foreground" : "text-primary")}>
          {/* 三种态各自说真话：有起点=在计时（排队/已运行）；无起点但在跑=「运行中」；
              无起点且本轮已停=孤儿行（被中断，没落结果也没 start），**不冒充在跑**。 */}
          {startedAt ? `${queued ? "排队中" : "已运行"} ${elapsed}s`
            : running ? "运行中" : "已中断"}
        </span>}
        {done && live && <span className="shrink-0 font-mono text-[9px] text-muted-foreground/60">{live.duration_s ?? "?"}s</span>}
        {done && <ChevronDown size={12} className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />}
      </button>
      {open && (
        <div className="border-t border-border/50">
          {args != null && (
            <>
              <div className="px-3 pt-1.5 font-mono text-[8px] uppercase tracking-widest text-muted-foreground/70">参数</div>
              <pre className="max-h-56 overflow-auto px-3 pb-2.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-words text-foreground/80">
                {JSON.stringify(args, null, 2).slice(0, 2000)}
              </pre>
            </>
          )}
          {args == null && argsHead != null && (
            <>
              <div className="px-3 pt-1.5 font-mono text-[8px] uppercase tracking-widest text-muted-foreground/70">参数</div>
              <pre className="max-h-56 overflow-auto px-3 pb-2.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-words text-foreground/80">
                {argsHead}
              </pre>
            </>
          )}
          <div className="px-3 pt-1.5 font-mono text-[8px] uppercase tracking-widest text-muted-foreground/70">结果</div>
          <pre className="max-h-56 overflow-auto px-3 pb-2.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-words text-foreground/80">
            {done ? (result ?? live?.result_head ?? "").slice(0, 6000)
              : live?.result_head ? live.result_head.slice(0, 600) : "执行中…"}
          </pre>
        </div>
      )}
    </div>
  )
}
