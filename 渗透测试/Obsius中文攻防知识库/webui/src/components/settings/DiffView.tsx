import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { MarkdownView } from "./MarkdownView"

// 渲染型 unified diff 只读视图（历史版本/提案实时 diff 共用，2026-10-30 改版）。
// 行内融合批注式：文档结构原样渲染 md，删除内容以红色删除线嵌在原位置、新增内容
// 仅字体标绿（都无背景色），像在文档上直接批注；diff 元信息行（---/+++、@@）以弱化
// 等宽小字保留。围栏不闭合的片段（代码块被 diff 切碎）回退原始 pre 避免渲染崩坏。

type Run = { kind: "hdr" | "hunk" | "ctx" | "del" | "add"; text: string }

function parseDiff(diff: string): Run[] {
  const runs: Run[] = []
  let cur: Run | null = null
  for (const line of diff.split(/\r?\n/)) {
    let kind: Run["kind"]
    if (line.startsWith("+++") || line.startsWith("---")) kind = "hdr"
    else if (line.startsWith("@@")) kind = "hunk"
    else if (line.startsWith("-")) kind = "del"
    else if (line.startsWith("+")) kind = "add"
    else kind = "ctx"
    if (kind === "hdr" || kind === "hunk") {
      // diff 元信息行独立成段，不并入内容片段
      if (cur) { runs.push(cur); cur = null }
      runs.push({ kind, text: line })
    } else {
      // 剥掉 unified diff 的行前缀（-/+/(空格)），正文原样交给 md 渲染
      const body = line.slice(1)
      if (cur && cur.kind === kind) cur.text += "\n" + body
      else { if (cur) runs.push(cur); cur = { kind, text: body } }
    }
  }
  if (cur) runs.push(cur)
  return runs
}

function fencesBalanced(text: string): boolean {
  const m = text.match(/```|~~~/g)
  return !m || m.length % 2 === 0
}

function RunView({ run }: { run: Run }) {
  if (run.kind === "hdr" || run.kind === "hunk") {
    return <p className="font-mono text-[10px] leading-relaxed text-muted-foreground/80">{run.text}</p>
  }
  const del = run.kind === "del"
  const add = run.kind === "add"
  if (!fencesBalanced(run.text)) {
    return (
      <pre className={cn("my-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed",
        del && "text-red-300 line-through",
        add && "text-emerald-300")}>
        {run.text || " "}
      </pre>
    )
  }
  return (
    <div className={cn(
      del && "[&_*]:!text-inherit [&_a]:!line-through text-red-300 line-through",
      add && "[&_*]:!text-inherit text-emerald-300",
    )}>
      <MarkdownView content={run.text || ""} variant="compact" />
    </div>
  )
}

export function DiffView({ diff, className }: { diff: string; className?: string }) {
  const runs = useMemo(() => parseDiff(diff), [diff])
  if (!diff) return <p className="text-xs text-muted-foreground">无差异（当前内容与该版本/提案一致）。</p>
  return (
    <div className={cn("rounded border bg-card/40 p-2", className)}>
      {runs.map((r, i) => <RunView key={i} run={r} />)}
    </div>
  )
}
