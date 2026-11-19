import { Clock3, Loader2, RotateCcw, X } from "lucide-react"
import { FILE_ICONS, FILE_TONE_BG, FILE_TONES } from "@/components/chat/FileCard"
import { fileBadge } from "@/lib/fileTargets"
import { cn } from "@/lib/utils"

// 待发附件胶囊（2026-10-20 重做）：工作台 composer 与直播间插话框**共用**。
//
// 旧版问题（Nan 反馈「不够高级、太简陋、不协调」）：手写 `<span>` 拼方角小方块
// （`rounded-md border px-2 py-1`），图标一律 paperclip、尺寸与文件名/字节挤在一行
// 同字号——而 composer 里其它控件（agent 选择、`.wb-cap` 能力钮、用量环、发送键）
// 全是**圆胶囊**，只有附件是方角，形态自成一族；且不看扩展名，任何文件长得一样。
//
// 现方案：对齐 composer 的胶囊语言（`rounded-full` + 发丝边 + 半透明底），
// 图标按**文件类型**取（复用 FileCard 的 FILE_ICONS/FILE_TONES，与文件卡同一套语义色），
// 信息分三层：类型图标（色）→ 文件名（主）→ 字节（等宽弱化）。三态共用同一骨架，
// 只换状态位，避免「上传中/失败」时胶囊宽度跳变。
//
// 刻意不依赖 `.wb-*` CSS（本目录约定，见 components/chat/CLAUDE.md）：
// 直播间与工作台都能直接复用；颜色一律走语义 token，玻璃模式下自动跟随。

export type AttachmentChipStatus = "queued" | "uploading" | "ready" | "error"

export interface AttachmentChipItem {
  key: string
  name: string
  size: number
  status: AttachmentChipStatus
  /** 已上传字节（0..size）。有值就画进度条与百分比——几个 G 的文件最需要
   *  「还在动」的反馈，只转个圈用户没法判断是卡住还是在走。 */
  loaded?: number
  /** 失败原因（来自 ApiError.message）。此前一律只显示「上传失败」，用户
   *  分不清是超限、断网还是权限问题。 */
  error?: string
  /** 本地校验失败不可通过重新请求解决 */
  retryable?: boolean
}

export function AttachmentChip({ item, onRemove, onRetry }: {
  item: AttachmentChipItem
  onRemove: (key: string) => void
  onRetry?: (key: string) => void
}) {
  const { badge, icon } = fileBadge(item.name)
  const Icon = FILE_ICONS[icon]
  const isError = item.status === "error"
  const isQueued = item.status === "queued"
  const isUploading = item.status === "uploading"
  // 进度：只在真正知道总量时算百分比（size=0 的极端情况退化成不确定态转圈）
  const pct = isUploading && item.size > 0 && item.loaded != null
    ? Math.min(100, Math.round((item.loaded / item.size) * 100))
    : null
  const errorText = item.error?.trim() || ""

  return (
    <span
      className={cn(
        "group relative inline-flex h-8 max-w-[17.5rem] min-w-0 items-center gap-2 overflow-hidden rounded-full border pr-1.5 pl-1",
        "text-[11px] shadow-[0_1px_2px_rgba(0,0,0,0.05)] transition-all duration-150",
        isError
          ? "border-destructive/45 bg-destructive/8 hover:border-destructive/60"
          : "border-border/70 bg-card/70 hover:-translate-y-px hover:border-(--brand-border) hover:bg-card/90 hover:shadow-[0_3px_10px_rgba(0,0,0,0.08)]",
      )}
      title={isError
        ? `${item.name}\n上传失败${errorText ? `：${errorText}` : ""}${item.retryable === false ? "" : "\n右侧「重试」可再传一次"}`
        : isQueued
          ? `${item.name}\n${badge} · ${fmtBytes(item.size)} · 等待上传`
          : isUploading
            ? `${item.name}\n${badge} · ${fmtBytes(item.size)}${pct != null ? ` · 已传 ${pct}%` : " · 上传中"}`
            : `${item.name}\n${badge} · ${fmtBytes(item.size)}`}
    >
      {/* 上传进度条：贴胶囊内底部的 2px 细线，**不占额外高度**——胶囊必须保持
          h-8 定高，否则待发区会在开始/结束上传时上下跳一下（旧版为不跳变刻意
          让三态共用同一骨架，这个约束继续守）。transition 让跨分片的推进连续。 */}
      {isUploading && pct != null && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-(--brand)/15"
        >
          <span
            className="block h-full bg-(--brand) transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        </span>
      )}
      {/* 类型图标：圆角方牌 + 「类型色 / 类型色 12% 底」。
          底不能用 --accent：五套配色里 accent 与背景同色系，亮底上图标块整块消失
          （rose-light 实测：灰牌溶进白底）。用类型色自己的淡底 = 有色彩身份且两套底色都立得住。 */}
      <span className={cn(
        "grid size-6 shrink-0 place-items-center rounded-[7px]",
        isError
          ? "bg-destructive/12 text-destructive"
          : cn(FILE_TONE_BG[icon], icon === "file" || icon === "doc" ? "text-foreground/55" : FILE_TONES[icon]),
      )}>
        <Icon className="size-3.5" />
      </span>

      <span className={cn(
        "min-w-0 truncate font-medium tracking-[-0.01em]",
        isError ? "text-destructive/90" : "text-foreground/90",
      )}>
        {item.name}
      </span>

      {/* 第三层：字节数 / 上传百分比 / 失败原因。
          **不用 font-mono**——等宽字体在 9.5px 下字距散（"4 . 0  K B" 观感），
          且这里是「弱提示」不是要对齐的数字列；改 sans + tabular-nums 稳列宽不散字。
          大文件（几 GB）走分片上传时，这里显示百分比而不是「上传中」——只看转圈
          无法判断是卡死还是在走，几十分钟的传输里这一点很要命。 */}
      {isQueued ? (
        <span className="flex shrink-0 items-center gap-1 text-[9.5px] text-muted-foreground">
          <Clock3 className="size-2.5" />排队中
        </span>
      ) : isUploading ? (
        <span className="flex shrink-0 items-center gap-1 text-[9.5px] tabular-nums text-muted-foreground">
          <Loader2 className="size-2.5 animate-spin" />
          {pct != null ? `${pct}%` : "上传中"}
        </span>
      ) : isError && errorText ? (
        <span className="max-w-[9rem] shrink-0 truncate text-[9.5px] text-destructive/80" title={errorText}>
          {errorText}
        </span>
      ) : (
        <span className="shrink-0 text-[9.5px] tabular-nums text-muted-foreground/75">
          {fmtBytes(item.size)}
        </span>
      )}

      {isError && onRetry && item.retryable !== false && (
        <button
          type="button"
          onClick={() => onRetry(item.key)}
          title="重新上传"
          className="grid size-5 shrink-0 place-items-center rounded-full text-destructive/80 transition-colors hover:bg-destructive/15 hover:text-destructive"
        >
          <RotateCcw className="size-2.5" />
        </button>
      )}

      {/* 移除键：常态就带一层淡底，让它成为明确可点的目标；
          悬停才抬到前景色。hover 前不给底色是因为整颗胶囊已有 hover 反馈。 */}
      <button
        type="button"
        onClick={() => onRemove(item.key)}
        title="移除附件"
        aria-label={`移除附件 ${item.name}`}
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground/60",
          "transition-colors hover:bg-foreground/8 hover:text-foreground",
        )}
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

/** 一组附件胶囊。空列表渲染 null（调用方无需自己判空）。
 *
 *  方案 A 精修（2026-11-01 Nan 选定）：头行「待发附件 N 个 · 上传中」+「全部
 *  移除」+ 虚线托盘收拢胶囊——胶囊不再悬浮在输入框上方像贴纸。头行只在有
 *  附件时出现；`onClearAll` 不给（直播间等无批量语义场景）则隐藏「全部移除」。 */
export function AttachmentChipRow({ items, onRemove, onRetry, trailing, className, onClearAll, header = "待发附件" }: {
  items: AttachmentChipItem[]
  onRemove: (key: string) => void
  onRetry?: (key: string) => void
  /** 行尾补充说明（如直播间「与编排对话不支持附件」） */
  trailing?: React.ReactNode
  className?: string
  /** 头行「全部移除」；不给 = 不显示（无批量语义的场景） */
  onClearAll?: () => void
  /** 头行标题（默认「待发附件」） */
  header?: string
}) {
  if (!items.length && !trailing) return null
  const uploading = items.filter((it) => it.status === "uploading").length
  const queued = items.filter((it) => it.status === "queued").length
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {items.length > 0 && (
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[10px] font-semibold tracking-[0.02em] text-muted-foreground">
            {header}
            <span className="ml-1 font-normal text-muted-foreground/70">
              {items.length} 个{uploading > 0 && ` · ${uploading} 上传中`}{queued > 0 && ` · ${queued} 排队`}
            </span>
          </span>
          {onClearAll && (
            <button type="button" onClick={onClearAll}
              className="rounded px-1 py-0.5 text-[10px] text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground">
              全部移除
            </button>
          )}
        </div>
      )}
      {items.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-dashed border-border/60 px-2 py-1.5">
          {items.map((it) => (
            <AttachmentChip key={it.key} item={it} onRemove={onRemove} onRetry={onRetry} />
          ))}
          {trailing}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">{trailing}</div>
      )}
    </div>
  )
}

/** 字节 → 人类可读。原先工作台与直播间各粘一份且**小数口径不同**（一个 1.5 KB、
 *  一个 15KB），现统一到本件内部，别再各自复制。 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
