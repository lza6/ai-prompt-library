import { memo } from "react"
import type { ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

// 只读 Markdown 渲染（深色黑客风）。标题带 slug id 供大纲 scrollIntoView；
// idPrefix 防同页技能正文与 kb 文档撞 id。链接分三路（2026-09-19）：#锚点=页内
// scrollIntoView（原实现一律 target=_blank，点目录会新开首页页签）；.md 相对链接
// =解析相对当前文档路径后经 onOpenKb 打开该 kb 文件；其余（http/https）才新开页签。

/** 解析 md 相对链接为源内 posix 路径（剥 #锚点，. / .. 逐段归一） */
export function resolveKbRel(currentPath: string, href: string): string {
  const segs = currentPath.split("/").slice(0, -1)
  for (const seg of decodeURIComponent(href.split("#")[0]).split("/")) {
    if (seg === "." || seg === "") continue
    if (seg === "..") segs.pop()
    else segs.push(seg)
  }
  return segs.join("/")
}

export function slugify(text: string): string {
  return text.toLowerCase()
    .replace(/[`*_~[\]()>#+.!！？?，,。；;：:、"'“”‘’]/g, "")
    .trim()
    .replace(/\s+/g, "-")
}

const CLS = {
  h1: "mb-1.5 mt-2 border-b border-border/60 pb-1 text-base font-semibold text-primary",
  h2: "mb-1 mt-2.5 text-sm font-semibold text-foreground",
  h3: "mb-0.5 mt-2 text-[13px] font-semibold text-foreground/90",
  h4: "mb-0.5 mt-2 text-[12.5px] font-semibold text-foreground/85",
  h5: "mb-0.5 mt-1.5 text-[12px] font-medium text-foreground/80",
  h6: "mb-0.5 mt-1.5 text-[11.5px] font-medium text-foreground/70",
  p: "my-1 leading-relaxed",
  ul: "my-1 list-disc pl-5 leading-relaxed",
  ol: "my-1 list-decimal pl-5 leading-relaxed",
  li: "my-0.5",
  a: "text-primary underline decoration-dotted underline-offset-2",
  code: "rounded bg-card/60 px-1 py-0.5 font-mono text-[11px] text-(--viz-code)",
  pre: "my-1.5 overflow-x-auto rounded border bg-card/60 p-2 font-mono text-[11px] leading-relaxed",
  blockquote: "my-1.5 border-l-2 border-primary/50 pl-2 text-muted-foreground",
  table: "my-1.5 border-collapse text-[12px]",
  th: "border bg-card/60 px-2 py-0.5 text-left font-semibold",
  td: "border px-2 py-0.5",
  hr: "my-2 border-border/60",
  strong: "font-semibold text-foreground",
}

// 阅读器（长文）变体：情报文章动辄几千字、带表格与配图，紧凑版式读不下去。
// 只调间距与容器，不改颜色语义；kb 文档预览仍走 compact，不受影响。
const CLS_READER = {
  h1: "mb-3 mt-8 scroll-mt-4 border-b border-border/60 pb-2 text-[22px] font-semibold leading-snug text-foreground",
  h2: "mb-2.5 mt-8 scroll-mt-4 text-[19px] font-semibold leading-snug text-foreground",
  h3: "mb-2 mt-6 scroll-mt-4 text-[16px] font-semibold leading-snug text-foreground/95",
  h4: "mb-1.5 mt-5 scroll-mt-4 text-[14.5px] font-semibold leading-snug text-foreground/90",
  h5: "mb-1 mt-4 scroll-mt-4 text-[13.5px] font-semibold leading-snug text-foreground/85",
  h6: "mb-1 mt-3.5 scroll-mt-4 text-[13px] font-medium leading-snug text-foreground/75",
  p: "my-3 leading-[1.9]",
  ul: "my-3 list-disc pl-6 leading-[1.85]",
  ol: "my-3 list-decimal pl-6 leading-[1.85]",
  // `[&>p]:my-0`：trafilatura 偶尔输出「松列表」（`<li>` 里包 `<p>`），内层段落
  // 会吃到 `p` 的 my-3，条目之间被撑出大片空隙 —— 长文里看着就像排版断了。
  li: "my-1 [&>p]:my-0 [&>p]:leading-[1.85]",
  a: "text-primary underline decoration-dotted underline-offset-2 break-words",
  code: "rounded bg-card/70 px-1.5 py-0.5 font-mono text-[0.88em] text-(--viz-code)",
  pre: "my-4 overflow-x-auto rounded-lg border bg-card/50 p-3 font-mono text-[12.5px] leading-relaxed",
  blockquote: "my-4 border-l-[3px] border-primary/50 pl-3 text-muted-foreground",
  table: "w-full border-collapse text-[13px]",
  th: "border border-border/70 bg-card/60 px-2.5 py-1.5 text-left font-semibold",
  td: "border border-border/70 px-2.5 py-1.5 align-top",
  hr: "my-7 border-border/60",
  strong: "font-semibold text-foreground",
}

/** 标题在文档内的最终 id（与渲染器的去重策略保持一致：仅首次 slug） */
export function headingId(prefix: string, slug: string): string {
  return `md-${prefix}-${slug}`
}

/**
 * 取 React 子节点的**纯文本**。
 *
 * 必须递归，不能 `String(children)`：标题里只要含行内格式（`` `lc` `` / **加粗** /
 * 链接），children 就是一个数组，`String()` 会把 React 元素变成 `[object Object]`，
 * 算出来的 slug 与 `extractHeadings` 对不上——大纲点了不跳（实测「2.2 LangChain
 * 的 `lc` 标记体系」就是这样失效的）。
 */
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join("")
  const props = (node as { props?: { children?: ReactNode } }).props
  return props ? nodeText(props.children) : ""
}

export function extractHeadings(markdown: string): { level: number; text: string; slug: string }[] {
  const out: { level: number; text: string; slug: string }[] = []
  const seen = new Map<string, number>()
  let inFence = false
  for (const line of markdown.split(/\r?\n/)) {
    // 围栏开关（``` 或 ~~~，可带语言后缀）；围栏内 # 注释不是标题
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    // 与渲染端 nodeText 对齐：链接/图片只留可见文字，再去掉行内格式符号
    const text = m[2]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~[\]]/g, "").trim()
    let slug = slugify(text)
    const n = (seen.get(slug) ?? 0) + 1
    seen.set(slug, n)
    if (n > 1) slug = `${slug}-${n}`
    out.push({ level: m[1].length, text, slug })
  }
  return out
}

export const MarkdownView = memo(function MarkdownView(
  { content, prefix = "doc", className, currentPath, onOpenKb, variant = "compact" }:
  { content: string; prefix?: string; className?: string;
    /** `reader` = 情报阅读器的长文版式（大行距、宽表格、自适应配图） */
    variant?: "compact" | "reader"
    /** 当前文档源内路径（.md 相对链接解析基准，kb 预览传入） */
    currentPath?: string
    /** 相对 .md 链接点击时打开目标 kb 文件（不传则退化为新开页签） */
    onOpenKb?: (path: string) => void },
) {
  const C = variant === "reader" ? CLS_READER : CLS
  // 标题 id 去重表：必须与 extractHeadings 用同一套编号规则（重名标题加 -2/-3），
  // 否则同页出现两个「总结」时，大纲第二条会指向不存在/第一条的 id。
  const seenSlug = new Map<string, number>()
  const hid = (text: string) => {
    let slug = slugify(text)
    const n = (seenSlug.get(slug) ?? 0) + 1
    seenSlug.set(slug, n)
    if (n > 1) slug = `${slug}-${n}`
    return headingId(prefix, slug)
  }
  return (
    <div className={className ?? (variant === "reader"
      ? "text-[15px] text-foreground/90"
      : "text-[13px] text-foreground/90")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 id={hid(nodeText(children))} className={C.h1}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 id={hid(nodeText(children))} className={C.h2}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 id={hid(nodeText(children))} className={C.h3}>{children}</h3>
          ),
          // h4~h6 必给样式：Tailwind preflight 把标题的 font-size/weight 全清了，
          // 不映射就渲染成和正文一样的普通段落（CSDN 那篇的「4. gbb调试qemu中
          // 内核基本方法」是 h4、下面一句是 h5，全看不出来是标题）。
          h4: ({ children }) => (
            <h4 id={hid(nodeText(children))} className={C.h4}>{children}</h4>
          ),
          h5: ({ children }) => (
            <h5 id={hid(nodeText(children))} className={C.h5}>{children}</h5>
          ),
          h6: ({ children }) => (
            <h6 id={hid(nodeText(children))} className={C.h6}>{children}</h6>
          ),
          p: ({ children }) => <p className={C.p}>{children}</p>,
          ul: ({ children }) => <ul className={C.ul}>{children}</ul>,
          ol: ({ children }) => <ol className={C.ol}>{children}</ol>,
          li: ({ children }) => <li className={C.li}>{children}</li>,
          // 配图必须限宽：原文常带 width=992 这类内联宽高，直接渲染会撑破阅读栏
          img: ({ src, alt }) => (
            <img src={src ?? ""} alt={alt ?? ""} loading="lazy"
                 className={variant === "reader"
                   ? "my-4 h-auto max-w-full rounded-lg border border-border/70 bg-card/30"
                   : "my-1.5 h-auto max-w-full rounded border border-border/60"} />
          ),
          a: ({ href, children }) => {
            const h = href ?? ""
            // #锚点：页内滚动到同 slug 标题（与 extractHeadings/headingId 同口径）
            if (h.startsWith("#")) {
              return (
                <a href={h} className={C.a}
                   onClick={(e) => {
                     e.preventDefault()
                     document.getElementById(headingId(prefix, h.slice(1)))
                       ?.scrollIntoView({ block: "start" })
                   }}>
                  {children}
                </a>
              )
            }
            // .md 相对链接：kb 内跳转（交父组件打开目标文件）；
            // 排除带协议/协议相对/纯锚点形态
            if (currentPath && onOpenKb && /\.md($|#)/.test(h) && !/^(#|[a-z][a-z0-9+.-]*:|\/\/)/i.test(h)) {
              const target = resolveKbRel(currentPath, h)
              return (
                <a href={h} className={C.a} title={target}
                   onClick={(e) => { e.preventDefault(); onOpenKb(target) }}>
                  {children}
                </a>
              )
            }
            return <a href={h} className={C.a} target="_blank" rel="noreferrer">{children}</a>
          },
          code: ({ children }) => <code className={C.code}>{children}</code>,
          pre: ({ children }) => <pre className={C.pre}>{children}</pre>,
          blockquote: ({ children }) => <blockquote className={C.blockquote}>{children}</blockquote>,
          // 表格套横向滚动容器：技术文章列多，窄窗口下必须能横滚，
          // 否则整页被撑宽、正文被挤出视野（截图里「表格渲染失败」的另一半原因）。
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto rounded-lg border border-border/70">
              <table className={C.table}>{children}</table>
            </div>
          ),
          th: ({ children }) => <th className={C.th}>{children}</th>,
          td: ({ children }) => <td className={C.td}>{children}</td>,
          hr: () => <hr className={C.hr} />,
          strong: ({ children }) => <strong className={C.strong}>{children}</strong>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
