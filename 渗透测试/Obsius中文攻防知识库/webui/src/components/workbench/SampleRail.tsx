// 右侧抽屉的「样本」页：当前项目分析包（sample package）内容树，**只读**。
//
// 与左侧「样本分析」整页的分工：那边是管理工作流（上传/关联目录/删除/分析/
// 登记资产），这边只做一件事——把条目拖到下方的 agent 对话框当引用。因此这里
// 刻意不提供任何写操作：抽屉只有 360px，误触删除的代价远大于便利。
//
// 拖拽契约在 lib/samples.ts（唯一出处）：拖出 SAMPLE_REF_MIME 的 JSON 引用，
// 由 AgentWorkbenchView 的 dropFiles 同步段读走并落成「[样本] 绝对路径」文本。

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronRight, FileCode2, FileText, FolderOpen, Loader2, RefreshCw } from "lucide-react"
import { api, ApiError } from "@/lib/api"
import type { SamplePackage } from "@/lib/types"
import { buildSampleDragRef, buildTree, binaryFormats, sizeText, SAMPLE_PATH_MIME, SAMPLE_REF_MIME, SAMPLE_PACKAGE_CHANGED_EVENT } from "@/lib/samples"
import type { SampleTreeNode } from "@/lib/samples"

export function SampleRail({ pid }: { pid: string }) {
  const [pkg, setPkg] = useState<SamplePackage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]))
  const requestSequence = useRef(0)

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current
    setLoading(true); setError(null)
    try {
      const current = await api.currentSamplePackage(pid)
      if (sequence === requestSequence.current) setPkg(current)
    }
    catch (reason) {
      // 没有分析包时后端返回 404，等同于「空」，不算错误；其他网络/API 错误要留给
      // 用户看见，否则上传后刷新失败就会伪装成「分析包空了」。
      if (sequence !== requestSequence.current) return
      if (reason instanceof ApiError && reason.status === 404) setPkg(null)
      else {
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(`刷新失败：${message}`)
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }, [pid])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ pid?: string }>).detail
      if (detail?.pid === pid) void refresh()
    }
    window.addEventListener(SAMPLE_PACKAGE_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(SAMPLE_PACKAGE_CHANGED_EVENT, onChanged)
  }, [pid, refresh])

  const tree = useMemo(() => buildTree(pkg?.entries || []), [pkg])
  const toggle = (path: string) => setExpanded((previous) => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path); else next.add(path)
    return next
  })

  const renderNode = (node: SampleTreeNode, depth: number): React.ReactNode => {
    const open = expanded.has(node.path)
    const ref = node.entry && pkg ? buildSampleDragRef(pkg, node.entry) : null
    return (
      <div key={node.path || "root"}>
        <div
          className="wb-context-tree-row"
          // 目录不可拖：拖一个目录进去，agent 拿到的是路径前缀，没有意义且容易误用。
          draggable={!!ref}
          title={ref ? `${ref.absPath} · 拖到下方对话框引用` : node.path}
          onDragStart={(event) => {
            if (!ref) return
            event.dataTransfer.setData(SAMPLE_REF_MIME, JSON.stringify(ref))
            // 兼容页内移动（SampleAnalysisView）与任意纯文本落点：拖进浏览器地址栏
            // /记事本也能得到绝对路径，而不是一片空白。
            event.dataTransfer.setData(SAMPLE_PATH_MIME, ref.path)
            event.dataTransfer.setData("text/plain", ref.absPath)
            event.dataTransfer.effectAllowed = "copy"
          }}
          onClick={() => { if (node.directory) toggle(node.path) }}
          style={{ paddingLeft: 4 + depth * 13 }}
        >
          {node.directory
            ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)
            : <span style={{ width: 12, flex: "0 0 12px" }} />}
          {node.directory
            ? <FolderOpen size={13} />
            : node.entry && binaryFormats.has(node.entry.format) ? <FileCode2 size={13} /> : <FileText size={13} />}
          <span>{node.name}</span>
          {node.entry && <em className="wb-sample-fmt">{node.entry.format.toUpperCase()}</em>}
        </div>
        {node.directory && open && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  const entries = pkg?.entries || []
  return (
    <>
      <button className="wb-context-refresh" onClick={() => void refresh()} disabled={loading}>
        {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}刷新分析包
      </button>
      {error && <p className="wb-context-error">{error}</p>}
      {pkg && (
        <p className="wb-context-muted wb-sample-meta">
          {pkg.file_count} 文件 · {sizeText(pkg.total_bytes)}
          {pkg.linked ? " · 关联目录" : ""}
        </p>
      )}
      {/* 空态给出去处：这个抽屉里不能上传，用户得知道该去哪儿。 */}
      {!pkg && !loading && <p className="wb-context-muted">当前项目还没有分析包。到左侧「样本分析」页上传文件或关联目录后，这里会列出内容树。</p>}
      {pkg && !entries.length && <p className="wb-context-muted">分析包为空</p>}
      {!!entries.length && <>
        <div className="wb-context-tree wb-sample-tree">{renderNode(tree, 0)}</div>
        <p className="wb-context-muted wb-sample-hint">把文件拖到下方对话框即可引用（插入其磁盘路径）</p>
      </>}
    </>
  )
}
