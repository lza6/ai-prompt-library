import { useState } from "react"
import { Check, ChevronDown, Copy, Flag, ShieldAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { ChallengeFlag } from "@/lib/types"

/** 对话内联「候选 flag 确认卡」（ctf-flag-wake，2026-10-20）。
 *
 *  场景：CTF 解题主控的子代理提交 flag（verdict=pending）→ 后端唤醒主控说一段
 *  话（解释这条 flag 怎么来的、证据够不够）→ 本卡片贴在主控那段话下面，让人类
 *  **一键复制**去靶场提交、**一键确认**（accepted）或**标记为错误**（rejected）。
 *
 *  三条刻意的设计：
 *  1. **默认隐藏所有 flag，展开后完整显示 + 独立复制钮**：避免对话视图直接暴露答案；
 *     需要核对时再展开，仍可一键复制完整 flag。徽章式点复制（`Blackboard.FlagBadge`）
 *     在对话流里不好发现——那里没有台账表格的上下文提示。
 *  2. **确认按钮写明后果**：确认 = 题目判为解出 + **通知这道题所有在跑的轮次
 *     （含子 agent）尽快收工**（`app._notify_project_chat_turns` →
 *     `core/chat/inbox.py`）。
 *     注意用词：是「通知收工」不是「中止」——轮次会在下一个步边界读到这条
 *     事实、写完手上的结论再停，不会被掐在半个工具调用里。写成「中止」会让
 *     用户以为结论会丢。
 *     范围是**这道题**不是整个项目：同一项目里并行跑的另一道题不受影响
 *     （按 pid 全量投递会让别题的 worker 停掉自己正在做的事）。
 *     **多 flag 题必须分叉**（flag-hint，2026-10-21）：quota > 1 时确认一条只是
 *     `accepted+1/quota`，题目远未解出、探索继续。此前卡片一律写「确认 = 该题
 *     判为解出」，6 flag 题里用户点完以为题目已完，而 agent 还在找剩下的——
 *     反过来也正是「确认一条 flag，子进程就被取消」这个 bug 的界面侧成因。
 *  3. **标记为错误要填理由**：理由写进台账后，同一串再提交会被 `is_rejected`
 *     拦下（`ctf_submit_flag` 直接拒收）。不填理由等于让模型反复提交同一串。
 *  4. **已裁决的条目也显示**（2026-10-26 用户裁决：「取消过滤相关内容，只要提交
 *     必须在前端显示」）。2026-11-02 起：待确认排在最上（富卡片，含证据）；
 *     已裁决的压在下方、压缩成**单行** `✓/✗ 题面要求：flag`，无题面要求时写
 *     「未标注题面」；顺序按题面文本里的编号自然排序（手机取证1/2、题目一/二）。
 *     展开开关固定在列表**上方**，flag 再多也能收起（此前开关在列表末尾，
 *     长列表会把它挤出可视区）。
 */
export function CandidateFlagCard({ flags, onDecide, busy = false,
                                    quota = 1, accepted = 0, hints = [] }: {
  flags: ChallengeFlag[]
  /** verdict: accepted（确认）/ rejected（标记为错误） */
  onDecide: (flag: ChallengeFlag, verdict: "accepted" | "rejected", reason?: string) => Promise<void>
  busy?: boolean
  /** 本题要几条 flag（`meta.flag_count`）——决定「确认」的后果文案 */
  quota?: number
  /** 已确认条数（accepted，不含候选） */
  accepted?: number
  /** 题目级「每条 flag 的题面提示」，与 flag 序号 0 基对齐 */
  hints?: string[]
}) {
  const [showAllFlags, setShowAllFlags] = useState(false)
  if (!flags.length) return null

  const hintOf = new Map<string, string>()
  for (const f of flags) hintOf.set(f.id, flagHint(f, hints))
  const pending = flags.filter((f) => f.verdict === "pending")
    .sort((a, b) => cmpFlag(a, b, hintOf))
  const decided = flags.filter((f) => f.verdict !== "pending")
    .sort((a, b) => cmpFlag(a, b, hintOf))
  const pendingCount = pending.length
  const decidedCount = decided.length

  return (
    <div className="mb-2 space-y-1.5">
      {/* 开关必须**在列表之前**（2026-11-02 修复）：此前放在展开列表下面，
          flag 一多（取证题十几条）就把「收起」挤出可视区，页面又不可滚——
          点不到收起，只能刷新。 */}
      <button type="button"
        className="flex w-full items-center justify-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        onClick={() => setShowAllFlags((value) => !value)}
        aria-expanded={showAllFlags}>
        <ChevronDown className={`size-3 transition-transform ${showAllFlags ? "rotate-180" : ""}`} />
        {showAllFlags
          ? "收起所有 flag"
          : `展开 ${flags.length} 条 flag（待确认 ${pendingCount} · 已裁决 ${decidedCount}）`}
      </button>
      {showAllFlags && (
        <div className="max-h-[50vh] space-y-1.5 overflow-y-auto pr-1">
          {pending.map((f) => (
            <OneFlag key={f.id} flag={f} hint={hintOf.get(f.id) || ""}
                     onDecide={onDecide} busy={busy}
                     quota={quota} accepted={accepted} />
          ))}
          {decided.length > 0 && (
            <div className="flex items-center gap-1.5 pt-1 text-[10px] text-muted-foreground">
              <span className="h-px flex-1 bg-border/60" />
              已裁决 {decided.length} 条
              <span className="h-px flex-1 bg-border/60" />
            </div>
          )}
          {/* 已裁决行压缩成单行（2026-11-02 Nan 要求）：待确认优先、已裁决靠下，
              有效/无效只留「题面要求：flag」+ 复制，理由进悬浮提示。 */}
          {decided.map((f) => (
            <DecidedFlagRow key={f.id} flag={f} hint={hintOf.get(f.id) || ""} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 台账序号的题面提示 → 展示文本。
 *
 *  `hint_index >= 0`：以台账为准（题目登记提示时写入，人工也可在台账改绑）。
 *  `-1`：不猜——统一显示「未标注题面」（2026-11-03）。此前待确认行会按
 *  「已确认条数」猜下一个序号，那正是「B 题面的要求贴到 A 题面答案」的
 *  成因（服务器取证整题偏移 2 条）。
 */
function flagHint(flag: ChallengeFlag, hints: string[]): string {
  const i = Number(flag.hint_index ?? -1)
  if (i >= 0) return (hints[i] ?? "").trim()
  return ""
}

/** 题面文本里的次序（「手机取证1」「题目二」「第3题」）。
 *  识别阿拉伯数字与中文数字；没有数字 → Infinity（排在有次序的后面）。 */
function seqOf(text: string): number {
  if (!text) return Number.POSITIVE_INFINITY
  const m = text.match(/[0-9]+|[一二三四五六七八九十]+/)
  if (!m) return Number.POSITIVE_INFINITY
  const s = m[0]
  if (/^\d+$/.test(s)) return Number(s)
  const cn: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9,
  }
  let n = 0
  let cur = 0
  for (const ch of s) {
    if (ch === "十") { n += (cur || 1) * 10; cur = 0 }
    else cur = cn[ch] ?? 0
  }
  return n + cur
}

/** 排序：按题面要求自然次序（数字/中文数字）；同序或无次序时按时间。 */
function cmpFlag(a: ChallengeFlag, b: ChallengeFlag,
                 hintOf: Map<string, string>): number {
  const sa = seqOf(hintOf.get(a.id) || "")
  const sb = seqOf(hintOf.get(b.id) || "")
  if (sa !== sb) return sa - sb
  const ha = hintOf.get(a.id) || ""
  const hb = hintOf.get(b.id) || ""
  if (ha !== hb) return ha.localeCompare(hb, "zh")
  return String(a.created_at || "").localeCompare(String(b.created_at || ""))
}

/** 已裁决 flag 的单行紧凑行（2026-11-02）：`✓ 手机取证1：flag{...}`。
 *  超长省略 + 悬浮看完整；无效行的否决理由放进 row 的 title。 */
function DecidedFlagRow({ flag, hint }: { flag: ChallengeFlag; hint: string }) {
  const [copied, setCopied] = useState(false)
  const isAccepted = flag.verdict === "accepted"
  const copy = () => {
    navigator.clipboard.writeText(flag.flag).catch(() => { /* 无剪贴板权限时静默 */ })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const title = [
    hint || "未标注题面",
    flag.flag,
    !isAccepted && flag.verdict_reason?.trim()
      ? `否决理由：${flag.verdict_reason}` : "",
  ].filter(Boolean).join("\n")
  return (
    <div title={title}
      className={cn("flex items-center gap-1.5 rounded border px-2 py-1 text-[11px]",
        isAccepted
          ? "border-(--status-ok)/35 bg-(--status-ok)/5"
          : "border-(--status-error)/35 bg-(--status-error)/5")}>
      <span className="shrink-0">
        {isAccepted
          ? <Check size={12} className="text-(--status-ok)" />
          : <X size={12} className="text-(--status-error)" />}
      </span>
      <span className="max-w-[42%] min-w-0 shrink-0 truncate text-muted-foreground">
        {hint || "未标注题面"}
      </span>
      <span className="shrink-0 text-muted-foreground/70">：</span>
      <code className="min-w-0 flex-1 select-all truncate font-mono text-[11px] text-foreground">
        {flag.flag}
      </code>
      <button type="button"
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        onClick={copy} title={copied ? "已复制" : "复制 flag"}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  )
}


function OneFlag({ flag, hint, onDecide, busy, quota, accepted }: {
  flag: ChallengeFlag
  hint: string
  onDecide: (flag: ChallengeFlag, verdict: "accepted" | "rejected", reason?: string) => Promise<void>
  busy: boolean
  quota: number
  accepted: number
}) {
  const [copied, setCopied] = useState(false)
  const [working, setWorking] = useState<"accepted" | "rejected" | null>(null)
  const [err, setErr] = useState("")
  // 否决理由行内收集（2026-10-21）：桌面壳里 `window.prompt` 是 `throw new Error`，
  // 而 `decide` 是 async——同步抛错变成 rejected promise 被 `void` 丢掉，
  // 用户看到的是「点了没反应」。`confirm`/`alert` 正常，坏的只有 `prompt`。
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState("")

  const copy = () => {
    navigator.clipboard.writeText(flag.flag).catch(() => { /* 无剪贴板权限时静默 */ })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const decide = async (verdict: "accepted" | "rejected") => {
    if (busy || working) return
    if (verdict === "rejected" && !asking) {
      // 第一次点：展开理由输入，**不提交**。
      setErr(""); setReason(""); setAsking(true); return
    }
    // 理由不是可选项：它决定「模型之后还能不能重提这串」。
    const r = verdict === "rejected" ? reason.trim() : ""
    if (verdict === "rejected" && !r) { setErr("标记为错误必须填理由"); return }
    setErr(""); setWorking(verdict)
    try {
      await onDecide(flag, verdict, r)
      setAsking(false); setReason("")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(null)
    }
  }

  const conf = Number.isFinite(flag.confidence) ? flag.confidence.toFixed(1) : "—"
  const hasRoundtrip = !!(flag.transform || "").trim()
  // 多 flag 题：确认一条 ≠ 解出（flag-hint，2026-10-21）
  const multi = quota > 1
  return (
    <div className="rounded-lg border border-(--status-approval)/40 bg-(--status-approval)/5 p-3">
      <div className="flex items-center gap-2">
        <Flag size={14} className="shrink-0 text-(--status-approval)" />
        <span className="text-xs font-semibold text-foreground">候选 flag 待确认</span>
        <span className={cn("shrink-0 rounded border px-1 font-mono text-[10px]",
          hasRoundtrip
            ? "border-(--status-ok)/50 text-(--status-ok)"
            : "border-(--status-approval)/50 text-(--status-approval)")}>
          {hasRoundtrip ? "可回环复算" : "仅形态判定"}
        </span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-muted-foreground/70">
          {multi ? `进度 ${accepted}/${quota} · ` : ""}置信 {conf}
        </span>
      </div>

      {/* flag 本体：完整、等宽、可选中；右边独立复制钮 */}
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded bg-card/70 px-2 py-1.5 font-mono text-[12px] text-foreground">
          {flag.flag}
        </code>
        <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 text-[11px]"
          onClick={copy} title="复制 flag">
          {copied ? <><Check size={12} /> 已复制</> : <><Copy size={12} /> 复制</>}
        </Button>
      </div>

      {/* 题面提示：判断「这串是不是答案」的关键依据，比 flag 原文有信息量得多
          （flag 串本身看不出方向）。题目没登记提示时不显示空行。 */}
      {hint && (
        <div className="mt-2 flex gap-1.5 rounded bg-card/60 p-2 text-[11px]">
          <span className="shrink-0 text-muted-foreground">题面要求</span>
          <span className="min-w-0 break-words text-foreground/85">{hint}</span>
        </div>
      )}

      {/* 证据：解题路径 + 变换链。空也要显示（「没有」本身是判断依据） */}
      <div className="mt-2 grid gap-1 rounded bg-card/60 p-2 text-[11px]">
        <div className="flex gap-1.5">
          <span className="shrink-0 text-muted-foreground">解题路径</span>
          <span className="min-w-0 break-words text-foreground/85">
            {flag.source?.trim() || <em className="text-muted-foreground/70">worker 未写路径</em>}
          </span>
        </div>
        <div className="flex gap-1.5">
          <span className="shrink-0 text-muted-foreground">变换链</span>
          <span className="min-w-0 break-words text-foreground/85">
            {hasRoundtrip
              ? flag.transform
              : <em className="text-muted-foreground/70">无——没跑变换回环，只是形态像</em>}
          </span>
        </div>
      </div>

      <p className="mt-2 flex items-start gap-1.5 rounded border border-(--status-approval)/40 bg-(--status-approval)/10 p-2 text-[11px] text-(--status-approval)">
        <ShieldAlert size={13} className="mt-0.5 shrink-0" />
        {multi ? (
          <>
            本题要 <b className="mx-0.5">{quota}</b> 条 flag，确认这条只是
            <b className="mx-0.5">{accepted + 1}/{quota}</b>，
            <b className="mx-0.5">题目仍未解出、探索会继续</b>
            （其它在跑的 agent 会收到「已拿到哪一条」的通知，由它自己判断方向，
            不会整体收工）。拿满 {quota} 条才判解出。候选不计解出，所以这一步
            只能由你来做。
          </>
        ) : (
          <>
            确认 = 该题判为解出，并<b className="mx-0.5">通知这道题所有在跑的轮次（含子 agent）尽快收工</b>
            （含仍在探索的其他方向；它们会先把手上的结论写回再停）。之后调度层不再为
            这道题派新方向。候选不计解出，所以这一步只能由你来做。
          </>
        )}
      </p>

      {asking && (
        <div className="mt-2 rounded border border-(--status-error)/40 bg-(--status-error)/5 p-2">
          <Textarea className="min-h-[52px] resize-y bg-background text-[11px]" autoFocus
                    value={reason}
                    onChange={(e) => { setReason(e.target.value); setErr("") }}
                    placeholder="为什么这串是错的？（必填，会写进台账——AI 之后不会再提交它）" />
          <div className="mt-1 flex items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground"
              disabled={!!working}
              onClick={() => { setAsking(false); setReason(""); setErr("") }}>取消</Button>
            <Button size="sm" variant="outline"
              className="h-6 border-(--status-error)/50 text-[10px] text-(--status-error)"
              disabled={!!working} onClick={() => void decide("rejected")}>
              {working === "rejected" ? "提交中…" : "确认否决"}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center justify-end gap-2">
        {!asking && (
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-[11px] text-muted-foreground"
            disabled={busy || !!working} onClick={() => void decide("rejected")}>
            <X size={12} /> {working === "rejected" ? "提交中…" : "标记为错误"}
          </Button>
        )}
        <Button size="sm" className="h-7 gap-1 text-[11px]"
          disabled={busy || !!working} onClick={() => void decide("accepted")}>
          <Check size={12} /> {working === "accepted" ? "提交中…" : "确认有效"}
        </Button>
      </div>

      {err && <p className="mt-1.5 text-[11px] text-(--status-error)">{err}</p>}
    </div>
  )
}
