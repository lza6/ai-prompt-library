// 分析包（sample package）的共享口径：内容树构造 + 拖拽载荷。
//
// 抽出来的原因：这些规则此前只活在 SampleAnalysisView 里，而右侧抽屉的「样本」
// 页要显示同一棵内容树、拖出的条目又要和对话输入框认识同一个 MIME。键名/路径
// 拼接/排序一旦两处各写一份，必然漂移（改一处、另一处静默失配——拖过去得到
// 空字符串，看起来像「拖拽没反应」）。这里是唯一出处。

import type { SamplePackage, SamplePackageEntry } from "@/lib/types"

export type SampleTreeNode = {
  name: string
  path: string
  directory: boolean
  entry?: SamplePackageEntry
  children: SampleTreeNode[]
}

/** 可直接提交给分析引擎的二进制格式（其余格式只在本页看预览）。 */
export const binaryFormats = new Set(["pe", "elf", "mach-o"])

export const sizeText = (n: number) =>
  n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB"

// 绝对磁盘路径 = 内容树根（tree_ref，项目内 trees/ 绝对路径）+ 包内相对路径。
// 分隔符跟随 tree_ref（Windows 反斜杠 / POSIX 斜杠），避免混合分隔符。
export const sampleAbsPath = (treeRef: string, relPath: string) => {
  const sep = treeRef.includes("\\") ? "\\" : "/"
  const base = treeRef.replace(/[\\/]+$/, "")
  return base + sep + (sep === "\\" ? relPath.replace(/\//g, "\\") : relPath)
}

export function buildTree(entries: SamplePackageEntry[]): SampleTreeNode {
  const root: SampleTreeNode = { name: "分析包", path: "", directory: true, children: [] }
  for (const entry of entries) {
    let parent = root
    const parts = entry.path.split("/").filter(Boolean)
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/")
      let child = parent.children.find((node) => node.name === part)
      if (!child) { child = { name: part, path, directory: index < parts.length - 1, children: [] }; parent.children.push(child) }
      if (index === parts.length - 1) { child.directory = false; child.entry = entry }
      parent = child
    })
  }
  const sort = (node: SampleTreeNode) => {
    node.children.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    node.children.forEach(sort)
  }
  sort(root)
  return root
}

export function canOpenSampleApk(pkg: SamplePackage | null, path: string, directory: boolean): boolean {
  if (!pkg || !path.toLowerCase().endsWith(".apk")) return false
  if (directory) return !!pkg.apk_sources?.[path]?.original_upload
  return !!pkg.entries?.some((entry) => entry.path === path && entry.format === "apk")
}

// ---------- 拖拽载荷 ----------

/** 包内相对路径。SampleAnalysisView 页内移动目录也在用，**别改键名**。 */
export const SAMPLE_PATH_MIME = "text/sample-path"
/** 拖到对话输入框的完整引用（JSON）。自定义类型，避免和 text/plain 的文件名冲突。 */
export const SAMPLE_REF_MIME = "application/x-sample-ref"
/** 本项目分析包发生上传/编辑后通知已挂载视图刷新当前树。 */
export const SAMPLE_PACKAGE_CHANGED_EVENT = "sample-package-changed"

export function notifySamplePackageChanged(pid: string): void {
  window.dispatchEvent(new CustomEvent(SAMPLE_PACKAGE_CHANGED_EVENT, { detail: { pid } }))
}

export type SampleDragRef = {
  path: string
  absPath: string
  name: string
  format: string
  size: number
  sha256?: string
  packageId?: string
}

export function buildSampleDragRef(pkg: Pick<SamplePackage, "tree_ref" | "package_id"> | null, entry: SamplePackageEntry): SampleDragRef {
  const treeRef = pkg?.tree_ref || ""
  return {
    path: entry.path,
    // tree_ref 缺失（老包 / 手工登记）时退回相对路径：宁可给一个需要追问的
    // 相对路径，也不要给一个把相对路径当绝对路径拼错的、看起来能用的路径。
    absPath: treeRef ? sampleAbsPath(treeRef, entry.path) : entry.path,
    name: entry.path.split("/").pop() || entry.path,
    format: entry.format,
    size: entry.size,
    sha256: entry.sha256,
    packageId: pkg?.package_id,
  }
}

/**
 * 从 drop 事件里取样本引用。**必须在事件同步段内调用**——DataTransfer 只在
 * drop 处理器的同步执行期间有效，一旦 await 让出，getData 一律返回空串。
 */
export function readSampleDrop(dt: DataTransfer | null | undefined): SampleDragRef | null {
  if (!dt) return null
  let raw = ""
  try { raw = dt.getData(SAMPLE_REF_MIME) || "" } catch { raw = "" }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SampleDragRef>
      if (parsed && typeof parsed.path === "string" && parsed.path) {
        return {
          path: parsed.path,
          absPath: typeof parsed.absPath === "string" && parsed.absPath ? parsed.absPath : parsed.path,
          name: typeof parsed.name === "string" && parsed.name ? parsed.name : parsed.path.split("/").pop() || parsed.path,
          format: typeof parsed.format === "string" ? parsed.format : "",
          size: typeof parsed.size === "number" ? parsed.size : 0,
          sha256: typeof parsed.sha256 === "string" && parsed.sha256 ? parsed.sha256 : undefined,
          packageId: typeof parsed.packageId === "string" && parsed.packageId ? parsed.packageId : undefined,
        }
      }
    } catch { /* 坏载荷交给下面的兜底 */ }
  }
  // 只有相对路径（页内移动用的旧键）：没有 tree_ref 就没法还原绝对路径，
  // 仍然接受——给一个相对路径引用，比完全丢掉用户的拖拽强。
  let rel = ""
  try { rel = dt.getData(SAMPLE_PATH_MIME) || "" } catch { rel = "" }
  if (!rel) return null
  return {
    path: rel,
    absPath: rel,
    name: rel.split("/").pop() || rel,
    format: "",
    size: 0,
  }
}

/** 落进对话输入框的文本：一行「[样本] 绝对路径」，agent 拿到就能直接读。 */
export function sampleRefText(ref: SampleDragRef): string {
  return `[样本] ${ref.absPath || ref.path}\n`
}

/**
 * 把引用文本插到 value 的 [start,end) 处，返回新文本与插入后的光标位置。
 * 抽成纯函数是为了能被判据直接驱动：光标夹取、换行补齐、caret 落点这几件事
 * 在组件里只能靠「拖一下看看」验证，而它们恰恰是最容易写错的部分。
 */
export function insertSampleRefText(
  value: string, ref: SampleDragRef, start: number, end: number,
): { value: string; caret: number } {
  const text = sampleRefText(ref)
  // 这里的 `Math.max(0, …)` / `Math.max(from, …)` 是**防御性冗余**：slice 自己就会
  // 夹取（slice(0,9999) 等同 slice(0,len)，slice(-5) 等同 slice(0)）。留着是为了
  // 让「越界/反向选区」在代码上写明白，别指望它当判据——实测把这行改成
  // `const from = start` 全绿（等价变异）。
  const from = Math.max(0, Math.min(start, value.length))
  const to = Math.max(from, Math.min(end, value.length))
  const before = value.slice(0, from)
  const after = value.slice(to)
  // 前一行有内容且没有换行时补一个换行：粘在上一句尾巴上会让 "[样本]" 变成句中
  // 文本，agent 读到的是半句话。
  const glue = before && !before.endsWith("\n") ? "\n" : ""
  return { value: before + glue + text + after, caret: before.length + glue.length + text.length }
}
