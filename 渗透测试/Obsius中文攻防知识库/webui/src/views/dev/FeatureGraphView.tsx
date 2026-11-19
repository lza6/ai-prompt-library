import { useCallback, useEffect, useMemo, useState } from "react"
import { ReactFlow, Background, Controls, Handle, Position,
  type Edge, type Node } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { ArrowLeft, Check, Folder, FileText, Sparkles } from "lucide-react"
import { api } from "@/lib/api"
import type { FeatureTree, FeatureTreeNode } from "@/lib/types"
import { Button } from "@/components/ui/button"

// 功能图节点尺寸与间距（LR 方向：x=层级，y=同层序号）
const NODE_W = 200
const NODE_H = 56
const GAP_X = 60
const GAP_Y = 24

// 节点类型展示优先级：folder 优先，其次 file，最后 feature（「图内优先显示文件夹节点」）
const TYPE_PRIORITY: Record<string, number> = { folder: 0, file: 1, feature: 2 }

const TYPE_META = {
  folder: { Icon: Folder, label: "文件夹", cls: "text-sky-500" },
  file: { Icon: FileText, label: "文件", cls: "text-slate-500" },
  feature: { Icon: Sparkles, label: "子功能", cls: "text-amber-500" },
} as const

interface GraphNodeData extends Record<string, unknown> {
  node: FeatureTreeNode
  onToggle: (n: FeatureTreeNode) => void
}

type FlowNode = Node<GraphNodeData, "graph">

function GraphNode({ data }: { data: GraphNodeData }) {
  const { node } = data
  const passed = node.status === "passed"
  const type = node.node_type ?? "feature"
  const meta = TYPE_META[type as keyof typeof TYPE_META] ?? TYPE_META.feature
  const Icon = meta.Icon
  return (
    <div
      className={[
        "group relative flex h-[56px] w-[200px] flex-col justify-center rounded-md border px-2.5",
        passed
          ? "border-(--status-ok) bg-(--status-ok-bg) text-(--status-ok)"
          : "border-border bg-card text-foreground",
      ].join(" ")}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2" />
      <div className="flex items-center gap-1.5">
        <Icon className={`h-3 w-3 shrink-0 ${meta.cls}`} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{node.name}</span>
        {passed && <Check className="h-3 w-3 shrink-0 text-(--status-ok)" />}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
        {node.node_type === "file" && node.path ? node.path : (node.desc || meta.label)}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2" />
      <div className="absolute -right-1 -top-1 hidden gap-0.5 group-hover:flex">
        <button
          type="button"
          title={passed ? "取消通过" : "标记通过（人类验收）"}
          onClick={(e) => { e.stopPropagation(); data.onToggle(node) }}
          className={[
            "rounded border bg-background p-0.5 hover:bg-accent",
            passed && "border-(--status-ok) text-(--status-ok)",
          ].join(" ")}
        >
          <Check className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}

const nodeTypes = { graph: GraphNode }

function layoutTree(nodes: FeatureTreeNode[]): { nodes: FlowNode[]; edges: Edge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const n of nodes) {
    const p = n.parent_id
    if (p && byId.has(p)) {
      if (!children.has(p)) children.set(p, [])
      children.get(p)!.push(n.id)
    } else {
      roots.push(n.id)
    }
  }
  const sortNodes = (ids: string[]) =>
    ids.sort((a, b) =>
      (TYPE_PRIORITY[byId.get(a)?.node_type ?? "feature"] ?? 9) -
      (TYPE_PRIORITY[byId.get(b)?.node_type ?? "feature"] ?? 9) ||
      byId.get(a)!.name.localeCompare(byId.get(b)!.name))
  for (const [p, ids] of children) children.set(p, sortNodes(ids))
  sortNodes(roots)

  const width = new Map<string, number>()
  const dfs = (id: string): number => {
    const kids = children.get(id) ?? []
    if (kids.length === 0) { width.set(id, 1); return 1 }
    let w = 0
    for (const k of kids) w += dfs(k)
    w = Math.max(1, w)
    width.set(id, w)
    return w
  }
  const yCursor = { v: 0 }
  const pos = new Map<string, { x: number; y: number }>()
  const place = (id: string, depth: number, yStart: number) => {
    const kids = children.get(id) ?? []
    const w = width.get(id) ?? 1
    const yCenter = yStart + (w * (NODE_H + GAP_Y) - GAP_Y) / 2
    pos.set(id, { x: depth * (NODE_W + GAP_X), y: yCenter })
    let y = yStart
    for (const k of kids) {
      const kw = width.get(k) ?? 1
      place(k, depth + 1, y)
      y += kw * (NODE_H + GAP_Y)
    }
  }
  for (const r of roots) {
    const rw = dfs(r)
    place(r, 0, yCursor.v)
    yCursor.v += rw * (NODE_H + GAP_Y)
  }
  const flowNodes: FlowNode[] = nodes
    .filter((n) => pos.has(n.id))
    .map((n) => {
      const p = pos.get(n.id)!
      return {
        id: n.id, type: "graph", position: { x: p.x, y: p.y },
        data: { node: n } as GraphNodeData, draggable: false,
      }
    })
  const edges: Edge[] = nodes
    .filter((n) => n.parent_id && byId.has(n.parent_id))
    .map((n) => ({
      id: `${n.parent_id}->${n.id}`,
      source: n.parent_id!, target: n.id,
      type: "smoothstep",
      style: { stroke: "var(--viz-edge)", strokeWidth: 1.5 },
    }))
  return { nodes: flowNodes, edges }
}

/** dev 轨主视图：功能图工作台（v53）。一张图=一个功能；已完成/未完成图以颜色区分，
 *  通过验收（passed）仅人类 UI 可标，Agent 无改 status 工具。 */
export function FeatureGraphView({ pid }: { pid: string }) {
  const [trees, setTrees] = useState<FeatureTree[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [filter, setFilter] = useState<"all" | "passed" | "pending">("all")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setTrees(await api.featureTrees(pid))
    } catch (e) { setError(String(e)) }
  }, [pid])

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  const open = useMemo(
    () => trees.find((t) => t.id === openId) ?? null, [trees, openId])

  const toggleTree = async (t: FeatureTree) => {
    setBusy(true)
    try {
      await api.patchFeatureTree(pid, t.id,
        { status: t.status === "passed" ? "pending" : "passed" })
      await load()
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  const toggleNode = async (n: FeatureTreeNode) => {
    if (!open) return
    setBusy(true)
    try {
      await api.patchFeatureNode(pid, open.id, n.id,
        { status: n.status === "passed" ? "pending" : "passed" })
      await load()
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  const { nodes, edges } = useMemo(() => layoutTree(open?.nodes ?? []), [open])

  const filtered = useMemo(() => trees
    .filter((t) => filter === "all" || t.status === filter)
    .sort((a, b) => Number(a.status === "passed") - Number(b.status === "passed") || b.updated_at.localeCompare(a.updated_at)),
  [trees, filter])

  if (open) {
    const passedNodes = open.nodes.filter((n) => n.status === "passed").length
    const graphPassed = open.status === "passed"
    const enriched = nodes.map((nd) => ({
      ...nd,
      data: { ...nd.data, onToggle: toggleNode },
    }))
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => setOpenId(null)}>
            <ArrowLeft className="mr-1 h-3 w-3" />返回列表
          </Button>
          <span
            className={[
              "rounded px-1.5 py-0.5 text-[10px] font-medium",
              graphPassed ? "bg-(--status-ok-bg) text-(--status-ok)" : "bg-accent text-muted-foreground",
            ].join(" ")}
          >
            {graphPassed ? "已完成（人类验收）" : "未完成"}
          </span>
          <h2 className="truncate text-sm font-medium">{open.name || open.binary_sha256 || "未命名功能图"}</h2>
          <span className="flex-1" />
          <span className="text-[10px] text-muted-foreground">
            {open.nodes.length} 节点 · {passedNodes} 通过
          </span>
          <Button size="sm" variant="outline"
                  onClick={() => toggleTree(open)} disabled={busy}>
            <Check className="mr-1 h-3 w-3" />
            {graphPassed ? "取消通过" : "通过验收"}
          </Button>
        </div>
        {error && <p className="px-4 py-1 text-xs text-(--status-error)">{error}</p>}
        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <div className="h-full rounded-lg border">
            {open.nodes.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                该功能图还没有节点——Agent 规划时会用 bb_feature_node 挂上文件夹/文件/子功能
              </div>
            ) : (
              <ReactFlow
                nodes={enriched}
                edges={edges}
                nodeTypes={nodeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                fitView
                minZoom={0.3}
                maxZoom={1.5}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={16} size={1} />
                <Controls showInteractive={false} />
              </ReactFlow>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-medium">功能图工作台</h2>
        <span className="text-[10px] text-muted-foreground">
          一张图 = 一个功能（Agent 规划即建新图）；绿色=已通过人类验收，灰=未完成
        </span>
        <span className="flex-1" />
        {(["all", "pending", "passed"] as const).map((f) => (
          <button
            key={f} type="button"
            onClick={() => setFilter(f)}
            className={[
              "rounded px-2 py-0.5 text-[10px]",
              filter === f ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
            ].join(" ")}
          >
            {f === "all" ? "全部" : f === "pending" ? "未完成" : "已完成"}
          </button>
        ))}
      </div>
      {error && <p className="mb-2 text-xs text-(--status-error)">{error}</p>}
      {filtered.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-xs text-muted-foreground">
          暂无功能图——对话主控收到开发需求后会自动建图（bb_feature_tree_create）
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((t) => {
            const passed = t.status === "passed"
            const passedNodes = t.nodes.filter((n) => n.status === "passed").length
            return (
              <div
                key={t.id}
                onClick={() => setOpenId(t.id)}
                className={[
                  "cursor-pointer rounded-lg border p-3 transition-colors hover:bg-accent/50",
                  passed ? "border-(--status-ok) bg-(--status-ok-bg)" : "border-border bg-card",
                ].join(" ")}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      "rounded px-1.5 py-0.5 text-[10px] font-medium",
                      passed ? "bg-(--status-ok) text-white" : "bg-accent text-muted-foreground",
                    ].join(" ")}
                  >
                    {passed ? "✓ 已完成" : "未完成"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {t.name || t.binary_sha256 || "未命名功能图"}
                  </span>
                  <button
                    type="button"
                    title={passed ? "取消通过" : "标记通过（人类验收）"}
                    onClick={(e) => { e.stopPropagation(); toggleTree(t) }}
                    disabled={busy}
                    className={[
                      "rounded border p-1 hover:bg-accent",
                      passed ? "border-(--status-ok) text-(--status-ok)" : "border-border text-muted-foreground",
                    ].join(" ")}
                  >
                    <Check className="h-3 w-3" />
                  </button>
                </div>
                {t.binary_sha256 && (
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                    {t.binary_sha256}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{t.nodes.length} 节点</span>
                  <span>·</span>
                  <span className="text-(--status-ok)">{passedNodes} 通过</span>
                  <span className="flex-1" />
                  <span>{new Date(t.updated_at).toLocaleString()}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {t.nodes.slice(0, 6).map((n) => {
                    const meta = TYPE_META[(n.node_type ?? "feature") as keyof typeof TYPE_META] ?? TYPE_META.feature
                    const Icon = meta.Icon
                    return (
                      <span key={n.id}
                            className={[
                              "inline-flex max-w-[9rem] items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px]",
                              n.status === "passed" ? "bg-(--status-ok-bg) text-(--status-ok)" : "bg-accent text-muted-foreground",
                            ].join(" ")}
                            title={n.path || n.desc}>
                        <Icon className={`h-2.5 w-2.5 shrink-0 ${meta.cls}`} />
                        <span className="truncate">{n.name}</span>
                      </span>
                    )
                  })}
                  {t.nodes.length > 6 && <span className="text-[10px] text-muted-foreground">+{t.nodes.length - 6}</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default FeatureGraphView
