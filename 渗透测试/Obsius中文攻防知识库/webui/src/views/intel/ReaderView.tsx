import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "@/lib/api"
import type { IntelReadAction, IntelReadResult } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { extractHeadings, headingId, MarkdownView } from "@/components/settings/MarkdownView"
import { cn } from "@/lib/utils"
import { errText } from "@/lib/api"

// 情报阅读器（阅读器模块，2026-10-27）。
//
// 为什么要有它：原来点文章直接 `openExternal` 交给系统浏览器，结果是广告、
// 弹窗、登录墙三件套。这里改为由后端把正文剥出来（core/intel/reader.py），
// 前端只渲染文本——**广告在这种渲染方式下根本不存在**，不需要写屏蔽规则。
//
// 三个交互要点：
// 1. 划词（左键选中）→ 选区旁浮出小按钮条 → 点「问 AI」或固定动作；
// 2. 右侧常驻 AI 侧栏，自动携带当前文章上下文，可连续追问；
// 3. 正文取不到时（WAF/登录墙）显示明确出口，不假装读到内容。
//
// 版式（2026-10-27 用户反馈「排版丑、没有大纲」后重做）：
// 左侧大纲 + 中间长文版式 + 右侧 AI 侧栏，顶栏下方一条阅读进度。
// 大纲直接由 Markdown 标题派生（与渲染器共用 extractHeadings/headingId），
// 不额外维护目录数据，也就不会出现「目录与正文对不上」。

interface SelectionAnchor {
  text: string
  /** 相对视口坐标（fixed 定位），弹在选区正上方 */
  top: number
  left: number
}

interface ChatTurn {
  role: "user" | "assistant"
  content: string
  /** 该轮附带的划线片段（仅展示用，回答时不重复作为上下文） */
  selection?: string
  pending?: boolean
  error?: string
}

type LoadState = "loading" | "ready" | "failed"

/** 「一键登录」Job 的前端状态：idle=没在登录，polling=浏览器已弹出等扫码 */
type LoginState = "idle" | "polling" | "success" | "failed"

export function ReaderView({ url, title, onClose, onOpenExternal }: {
  url: string
  /** 列表里已知的标题：先显示，避免抓取期间空白 */
  title?: string
  onClose: () => void
  /** 兜底出口：抓不到正文 / 用户想看原文时交给系统浏览器 */
  onOpenExternal: (url: string) => void
}) {
  const [article, setArticle] = useState<IntelReadResult | null>(null)
  const [state, setState] = useState<LoadState>("loading")
  const [error, setError] = useState("")
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null)
  const [actions, setActions] = useState<IntelReadAction[]>([])
  const [loginState, setLoginState] = useState<LoginState>("idle")
  const [loginMsg, setLoginMsg] = useState("")
  const [alreadyLoggedIn, setAlreadyLoggedIn] = useState(false)
  const [browserImportState, setBrowserImportState] = useState<"idle" | "loading" | "failed">("idle")
  const [browserImportMsg, setBrowserImportMsg] = useState("")
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [question, setQuestion] = useState("")
  const [busy, setBusy] = useState(false)
  const [pendingSelection, setPendingSelection] = useState("")
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [tocOpen, setTocOpen] = useState(true)
  const [fontScale, setFontScale] = useState(100)
  const [progress, setProgress] = useState(0)
  const [activeSlug, setActiveSlug] = useState("")

  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const browserFetchAttempted = useRef("")

  const load = useCallback(async (refresh = false): Promise<IntelReadResult | null> => {
    setState("loading")
    setError("")
    setLoginMsg("")
    try {
      const isZhihu = /^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+\/?(?:[?#].*)?$/.test(url)
      let r: IntelReadResult
      if (isZhihu && window.desktopBrowser?.fetchZhihuArticle) {
        browserFetchAttempted.current = url
        setBrowserImportState("loading")
        setBrowserImportMsg("正在使用 CyberStrike 专用知乎会话读取文章…")
        await window.desktopBrowser.fetchZhihuArticle(url)
        r = await api.intelReadImported(url)
        setBrowserImportState("idle")
        setBrowserImportMsg("")
      } else {
        r = await api.intelRead(url, refresh)
      }
      setArticle(r)
      // 后端明确回报 failed（WAF/登录墙/无正文）→ 不当正文渲染
      setState(r.status === "failed" ? "failed" : "ready")
      if (r.status === "failed") setError(r.errors.join("；") || "未能提取正文")
      return r
    } catch (e) {
      if (/^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+/.test(url)) {
        setArticle({ url, final_url: url, title: title || "", markdown: "", text: "", site: "知乎",
          author: "", published: "", engine: "failed", status: "failed", chars: 0,
          errors: [errText(e)], warnings: [], cached: false, login_hint: "zhihu" })
      }
      setBrowserImportState("failed")
      setBrowserImportMsg("")
      setState("failed")
      setError(errText(e))
      return null
    }
  }, [url])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (state !== "failed" || !article?.login_hint || !window.desktopBrowser?.fetchZhihuArticle) return
    if (browserFetchAttempted.current === url) return
    browserFetchAttempted.current = url
    let cancelled = false
    setBrowserImportState("loading")
    setBrowserImportMsg("正在使用 CyberStrike 专用知乎会话读取文章…")
    window.desktopBrowser.fetchZhihuArticle(url)
      .then(() => api.intelReadImported(url))
      .then((result) => {
        if (cancelled) return
        setArticle(result)
        setState(result.status === "failed" ? "failed" : "ready")
        setError(result.status === "failed" ? result.errors.join("；") : "")
        setBrowserImportState(result.status === "failed" ? "failed" : "idle")
        setBrowserImportMsg(result.status === "failed" ? "专用会话页面未提取到可读正文。" : "")
      })
      .catch((error) => {
        if (cancelled) return
        setBrowserImportState("failed")
        setBrowserImportMsg(errText(error))
      })
    return () => { cancelled = true }
  }, [article?.login_hint, state, url])

  useEffect(() => {
    api.intelReadActions().then((r) => setActions(r.actions)).catch(() => {})
  }, [])

  // 「一键登录」（2026-10-29）：知乎这类站未登录访问专栏文章一律 40362，
  // 界面上给「弹浏览器 → 人工扫码 → 成功自动重抓」的一条龙，而不是让用户
  // 开终端跑脚本。
  // 判据用后端返回的**结构化字段** `login_hint`，不匹配 errors 文案——
  // 文案是可读的、会被改的，一旦改字按钮就悄悄消失且没有测试会红。
  const needsLogin = state === "failed" && !!article?.login_hint

  useEffect(() => {
    if (!needsLogin) return
    let gone = false
    api.intelReadLoginStatus()
      .then((r) => { if (!gone) setAlreadyLoggedIn(r.ready) })
      .catch(() => {})
    return () => { gone = true }
  }, [needsLogin])

  const startLogin = useCallback(async () => {
    if (loginState === "polling") return
    setLoginState("polling")
    setLoginMsg("正在弹出浏览器…")
    try {
      if (window.desktopBrowser?.loginZhihu && window.desktopBrowser.fetchZhihuArticle) {
        await window.desktopBrowser.loginZhihu()
        setLoginMsg("知乎登录页已在 CyberStrike 专用隔离会话中打开；登录后将读取正文…")
        await window.desktopBrowser.fetchZhihuArticle(url)
        const articleResult = await api.intelReadImported(url)
        setArticle(articleResult)
        setState(articleResult.status === "failed" ? "failed" : "ready")
        setError(articleResult.status === "failed" ? articleResult.errors.join("；") : "")
        setBrowserImportState(articleResult.status === "failed" ? "failed" : "idle")
        setBrowserImportMsg(articleResult.status === "failed" ? "专用会话已打开，但知乎仍未返回可读正文。" : "")
        setLoginState(articleResult.status === "failed" ? "failed" : "idle")
        setLoginMsg(articleResult.status === "failed"
          ? "登录后抓取仍失败；请确认登录已完成，再点击重试桌面读取。"
          : "")
        return
      }
      const { job_id } = await api.intelReadLogin()
      // 轮询登录 Job：登录要等真人扫码（最多 5 分钟），2s 一次足够。
      const deadline = Date.now() + 6 * 60_000
      for (;;) {
        if (Date.now() > deadline) {
          setLoginState("failed")
          setLoginMsg("登录等待超时，请重试")
          return
        }
        await new Promise((r) => setTimeout(r, 2000))
        const job = await api.job(job_id)
        if (job.status === "running") {
          setLoginMsg("浏览器已弹出，请在窗口里登录…")
          continue
        }
        const result = (job.result ?? {}) as { ok?: boolean; reason?: string }
        if (job.status === "done" && result.ok) {
          setLoginState("success")
          setLoginMsg("登录已通过，正在重新读取文章…")
          const articleResult = await load(true) // 登录态已验证，强制重抓
          if (!articleResult) {
            setLoginState("failed")
            setLoginMsg("文章重抓请求失败，请检查网络后重试")
          } else if (articleResult.status === "failed") {
            setLoginState("failed")
            const stillLoggedIn = articleResult.errors.some((message) =>
              message.includes("文章级风控"))
            setLoginMsg(stillLoggedIn
              ? "登录已通过，但知乎拒绝了这篇文章的读取。请确认当前账号可在浏览器中访问原文，或打开原文继续阅读。"
              : "登录后仍无法读取正文，请重新登录后重试，或用浏览器打开原文。")
          } else {
            setLoginState("idle")
            setLoginMsg("")
          }
          return
        }
        setLoginState("failed")
        setLoginMsg(job.error || result.reason || "登录未完成")
        return
      }
    } catch (e) {
      setLoginState("failed")
      setLoginMsg(errText(e))
    }
  }, [loginState, load, url])

  // 划词浮层：只在左键拖选产生非空选区时出现；点别处/滚动即刻收起。
  // 用 mouseup 而非 selectionchange：后者每次光标移动都触发，浮层会闪。
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      // 点在**浮层自身/侧栏/顶栏**时忽略（否则按钮的 click 先被清掉）。
      // 注意不能把正文容器也打上 data-reader-chrome —— 划词的 mouseup 目标正是
      // 正文内部的元素，`closest` 会一路命中到正文容器，导致浮层永远不出现。
      const el = e.target as HTMLElement | null
      if (el?.closest("[data-reader-chrome]")) return
      const sel = window.getSelection()
      const text = sel?.toString().trim() ?? ""
      if (!sel || sel.isCollapsed || !text || text.length < 2 || !bodyRef.current) {
        setAnchor(null)
        return
      }
      // 选区必须在正文容器内，避免选中侧栏里的回答文字也弹「问 AI」
      if (!bodyRef.current.contains(sel.anchorNode)) return
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      setAnchor({
        text: text.length > 4000 ? text.slice(0, 4000) : text,
        // 选区上方 44px（浮层高约 36px + 间隙）；贴顶时翻到下方
        top: rect.top > 56 ? rect.top - 44 : rect.bottom + 8,
        left: Math.min(Math.max(rect.left + rect.width / 2 - 110, 12),
                       Math.max(window.innerWidth - 240, 12)),
      })
    }
    const onScroll = () => setAnchor(null)
    document.addEventListener("mouseup", onUp)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("mouseup", onUp)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: "end" }) }, [turns])

  useEffect(() => () => abortRef.current?.abort(), [])

  // 大纲：直接从 Markdown 标题派生（与渲染器共用同一套 slug，不会对不上）。
  // 用 `reader` 前缀，和正文里 MarkdownView 的 prefix 保持一致。
  const headings = useMemo(
    () => (article?.markdown ? extractHeadings(article.markdown) : []),
    [article?.markdown])

  // 阅读进度 + 当前所在小节：滚动时按「最后一个越过顶部参考线的标题」判定，
  // 比 IntersectionObserver 更稳（标题密集时 observer 会在多个标题间抖）。
  useEffect(() => {
    const root = scrollRef.current
    if (!root || !headings.length) return
    let raf = 0
    const measure = () => {
      raf = 0
      const max = root.scrollHeight - root.clientHeight
      setProgress(max > 0 ? Math.min(1, Math.max(0, root.scrollTop / max)) : 0)
      const line = root.getBoundingClientRect().top + 72   // 参考线：顶栏下方
      let cur = headings[0]?.slug ?? ""
      for (const h of headings) {
        const el = document.getElementById(headingId("reader", h.slug))
        if (!el) continue
        if (el.getBoundingClientRect().top <= line) cur = h.slug
        else break
      }
      setActiveSlug(cur)
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure) }
    measure()
    root.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      root.removeEventListener("scroll", onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [headings])

  const gotoHeading = useCallback((slug: string) => {
    document.getElementById(headingId("reader", slug))
      ?.scrollIntoView({ block: "start", behavior: "smooth" })
    setActiveSlug(slug)
  }, [])

  const ask = useCallback(async (text: string, selection: string, action?: string) => {
    if (busy || !text.trim()) return
    const asked = text.trim()
    setAnchor(null)
    setBusy(true)
    setQuestion("")
    setPendingSelection("")
    // 先落 user 轮与空的 assistant 轮，增量按 index 回填
    setTurns((cur) => [...cur, { role: "user", content: asked, selection },
      { role: "assistant", content: "", pending: true }])
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const patchLast = (patch: (t: ChatTurn) => ChatTurn) =>
      setTurns((cur) => {
        const next = [...cur]
        const i = next.length - 1
        if (i < 0 || next[i].role !== "assistant") return cur
        next[i] = patch(next[i])
        return next
      })
    try {
      // 历史只带已完成的轮次（最后两轮是本次提问与占位回答）
      const history = turns.filter((t) => !t.pending && !t.error)
        .map((t) => ({ role: t.role, content: t.content }))
      await api.intelReadAsk({
        url,
        question: asked,
        selection: selection || undefined,
        selection_action: action,
        history,
        text: article?.text ?? "",
        title: article?.title || title || "",
        site: article?.site ?? "",
        published: article?.published ?? "",
      }, {
        onDelta: (chunk) => patchLast((t) => ({ ...t, content: t.content + chunk, pending: false })),
        onFinal: (full) => patchLast((t) => ({
          ...t,
          // 只有增量确实流过来才用全文覆盖，否则会把已渲染内容清空
          content: t.content || full,
          pending: false,
        })),
        onError: (message) => patchLast((t) => ({ ...t, pending: false, error: message })),
      }, ctrl.signal)
    } catch (e) {
      const msg = (e as Error)?.name === "AbortError" ? "已停止" : errText(e)
      patchLast((t) => ({ ...t, pending: false, error: msg }))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [article, busy, title, turns, url])

  const wordCount = article?.chars ?? 0
  const readMinutes = useMemo(() => Math.max(1, Math.round(wordCount / 420)), [wordCount])

  const statusNote = useMemo(() => {
    if (!article) return ""
    const parts: string[] = []
    if (article.status === "partial") parts.push(...article.warnings)
    if (article.engine === "render") parts.push("该站需浏览器渲染后才取到正文")
    return parts.join(" · ")
  }, [article])

  return (
    <div className="reader-panel flex h-full min-h-0 flex-col bg-(--surface-0)">
      {/* ---- 顶栏 ----
          `reader-panel` / `reader-topbar` 是给玻璃模式留的钩子：底色由外层
          `.reader-shell` 统一画一次（见 IntelView 与 index.css 的 reader 段），
          面板和顶栏在这里都是透明的，三层不再各透各的。
          非玻璃模式下 `--surface-0` 本来就是实色，钩子类不起任何作用。 */}
      <div className="reader-topbar flex shrink-0 items-center gap-2 border-b px-3 py-1.5" data-reader-chrome>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onClose}>← 返回</Button>
        <Button size="sm" variant={tocOpen ? "secondary" : "ghost"}
                className="h-7 px-2 text-[10px]"
                title={headings.length ? "显示/隐藏大纲" : "本篇未识别到标题"}
                disabled={!headings.length}
                onClick={() => setTocOpen((v) => !v)}>
          大纲{headings.length ? ` ${headings.length}` : ""}
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{article?.title || title || "加载中…"}</p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {[
              article?.site,
              article?.published,
              // author 常带站点附加的「发表于 上海」之类尾巴，单独截断，
              // 免得把后面的字数挤掉（曾出现「约 75 分 分钟」的叠字）
              article?.author ? article.author.slice(0, 24) : "",
            ].filter(Boolean).join(" · ") || "—"}
            {wordCount > 0 && (
              <span className="ml-1.5 whitespace-nowrap">
                {wordCount} 字 · 约 {readMinutes} 分钟
              </span>
            )}
          </p>
        </div>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-xs"
                  title="缩小字号" onClick={() => setFontScale((s) => Math.max(80, s - 10))}>A-</Button>
          <span className="font-mono">{fontScale}%</span>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-xs"
                  title="放大字号" onClick={() => setFontScale((s) => Math.min(160, s + 10))}>A+</Button>
        </span>
        <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]"
                onClick={() => onOpenExternal(article?.final_url || url)}>浏览器打开</Button>
        <Button size="sm" variant={sidebarOpen ? "default" : "outline"}
                className="h-7 px-2 text-[10px]" onClick={() => setSidebarOpen((v) => !v)}>
          AI 侧栏
        </Button>
      </div>

      {/* ---- 阅读进度 ---- */}
      {state === "ready" && (
        <div className="h-0.5 shrink-0 bg-transparent" data-reader-chrome>
          <div className="h-full bg-primary/70 transition-[width] duration-150"
               style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* ---- 大纲 ---- */}
        {tocOpen && state === "ready" && headings.length > 0 && (
          <nav data-reader-chrome
               className="hidden w-56 shrink-0 overflow-y-auto border-r px-2 py-3 lg:block">
            <p className="mb-2 px-1.5 text-[10px] font-medium tracking-wide text-muted-foreground">
              目录
            </p>
            <ul className="space-y-px">
              {headings.map((h) => (
                <li key={h.slug}>
                  <button onClick={() => gotoHeading(h.slug)}
                          title={h.text}
                          className={cn(
                            "block w-full truncate rounded px-1.5 py-1 text-left text-[11px] leading-snug transition-colors",
                            h.level === 1 && "pl-1.5",
                            h.level === 2 && "pl-1.5 font-medium",
                            h.level >= 3 && "pl-4 text-[10.5px]",
                            activeSlug === h.slug
                              ? "bg-primary/15 text-primary"
                              : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                          )}>
                    {h.text}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {/* ---- 正文 ---- */}
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 py-8">
            {state === "loading" && (
              <div className="flex flex-col items-center gap-2 py-20 text-xs text-muted-foreground">
                <span className="animate-pulse">正在提取正文…</span>
                <span className="text-[10px] opacity-70">
                  部分站点需要浏览器渲染，请稍候
                </span>
              </div>
            )}

            {state === "failed" && (
              <div className="mx-auto max-w-md space-y-3 rounded border border-amber-500/40 bg-amber-500/5 p-4 text-xs">
                <p className="font-medium text-amber-600 dark:text-amber-500">未能提取到正文</p>
                <p className="text-muted-foreground">{error || "站点可能有验证或登录限制。"}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" className="h-7 text-[10px]" onClick={() => void load(true)}>重试</Button>
                  <Button size="sm" variant="outline" className="h-7 text-[10px]"
                          onClick={() => onOpenExternal(article?.final_url || url)}>
                    {needsLogin ? "在已登录浏览器打开原文" : "用浏览器打开原文"}
                  </Button>
                  {needsLogin && (
                    <>
                      {window.desktopBrowser?.fetchZhihuArticle && (
                        <Button size="sm" variant="outline" className="h-7 text-[10px]"
                                disabled={browserImportState === "loading"}
                                onClick={() => {
                                  browserFetchAttempted.current = ""
                                  setBrowserImportState("idle")
                                  setBrowserImportMsg("")
                                  void load(true)
                                }}>
                          {browserImportState === "loading" ? "桌面读取中…" : "重试桌面读取"}
                        </Button>
                      )}
                      <Button size="sm" variant="outline"
                              className="h-7 border-emerald-500/50 text-[10px] text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-500"
                              disabled={loginState === "polling"}
                              onClick={() => void startLogin()}>
                        {loginState === "polling" ? "等待登录…"
                          : alreadyLoggedIn ? "重新登录" : "一键登录"}
                      </Button>
                    </>
                  )}
                </div>
                  {needsLogin && !window.desktopBrowser?.fetchZhihuArticle && (
                    <p className="text-[10px] text-muted-foreground">
                      当前平台版本不支持隔离桌面会话读取，请在 CyberStrike 桌面版完成知乎登录。
                    </p>
                  )}
                {browserImportMsg && (
                  <p className={cn("text-[10px]",
                      browserImportState === "failed" ? "text-red-500" : "text-muted-foreground")}>
                    {browserImportMsg}
                  </p>
                )}
                {loginMsg && (
                  <p className={cn("text-[10px]",
                      loginState === "failed" ? "text-red-500" : "text-muted-foreground")}>
                    {loginMsg}
                  </p>
                )}
              </div>
            )}

            {state === "ready" && article && (
              <>
                <h1 className="mb-2 text-2xl font-semibold leading-tight">{article.title}</h1>
                <div className="mb-6 flex flex-wrap items-center gap-2 border-b pb-3 text-[10px] text-muted-foreground">
                  {article.site && <Badge variant="outline" className="text-[9px]">{article.site}</Badge>}
                  {article.cached && <Badge variant="outline" className="text-[9px]">缓存</Badge>}
                  <a href={article.final_url} target="_blank" rel="noreferrer"
                     className="truncate hover:text-primary">{article.final_url}</a>
                  <button className="ml-auto hover:text-primary" title="强制重抓正文"
                          onClick={() => void load(true)}>重抓</button>
                </div>
                {statusNote && <p className="mb-3 text-[10px] text-amber-600 dark:text-amber-500">{statusNote}</p>}
                <div ref={bodyRef} style={{ fontSize: `${fontScale}%` }} className="select-text">
                  <MarkdownView content={article.markdown} prefix="reader" variant="reader" />
                </div>
                <p className="mt-10 border-t pt-3 text-center text-[10px] text-muted-foreground">
                  选中文字可「问 AI」 · 正文来自 {article.engine === "render" ? "浏览器渲染" : "直连抓取"}
                </p>
              </>
            )}
          </div>
        </div>

        {/* ---- AI 侧栏 ---- */}
        {sidebarOpen && (
          <aside className="flex w-80 shrink-0 flex-col border-l" data-reader-chrome>
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
              <span className="text-xs font-medium">AI 阅读助手</span>
              <span className="text-[10px] text-muted-foreground">已载入全文</span>
              <span className="flex-1" />
              {turns.length > 0 && (
                <button className="text-[10px] text-muted-foreground hover:text-foreground"
                        onClick={() => { abortRef.current?.abort(); setTurns([]) }}>清空</button>
              )}
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {turns.length === 0 && (
                <div className="space-y-2 text-[11px] text-muted-foreground">
                  <p>选中正文任意一句 → 浮出按钮提问；也可以直接在下面输入。</p>
                  <div className="flex flex-wrap gap-1">
                    {["概括这篇文章", "结论是什么", "有哪些可复现细节"].map((q) => (
                      <button key={q} onClick={() => void ask(q, "")}
                              className="rounded border px-2 py-0.5 text-[10px] hover:bg-accent/40">{q}</button>
                    ))}
                  </div>
                </div>
              )}
              {turns.map((t, i) => (
                <div key={i} className={cn("rounded p-2 text-[11px]",
                  t.role === "user" ? "bg-secondary/60" : "border")}>
                  {t.role === "user" ? (
                    <>
                      {t.selection && (
                        <p className="mb-1 line-clamp-2 border-l-2 border-primary/50 pl-1.5 text-[10px] text-muted-foreground">
                          划线：{t.selection}
                        </p>
                      )}
                      <p className="whitespace-pre-wrap">{t.content}</p>
                    </>
                  ) : (
                    <>
                      {t.pending && !t.content && (
                        <p className="animate-pulse text-muted-foreground">思考中…</p>
                      )}
                      {t.content && <MarkdownView content={t.content} prefix={`reader-ai-${i}`} />}
                      {t.error && <p className="text-(--status-error)">{t.error}</p>}
                    </>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {pendingSelection && (
              <div className="shrink-0 border-t px-3 py-1.5">
                <p className="line-clamp-2 border-l-2 border-primary/50 pl-1.5 text-[10px] text-muted-foreground">
                  引用：{pendingSelection}
                </p>
                <button className="mt-0.5 text-[9px] text-muted-foreground hover:text-foreground"
                        onClick={() => setPendingSelection("")}>取消引用</button>
              </div>
            )}

            <form className="flex shrink-0 gap-1.5 border-t p-2"
                  onSubmit={(e) => { e.preventDefault(); void ask(question, pendingSelection) }}>
              <textarea value={question} rows={2}
                        onChange={(e) => setQuestion(e.target.value)}
                        onKeyDown={(e) => {
                          // Enter 发送、Shift+Enter 换行（侧栏空间小，回车更顺手）
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault()
                            void ask(question, pendingSelection)
                          }
                        }}
                        placeholder="问关于这篇文章的问题…（Enter 发送）"
                        className="min-h-0 min-w-0 flex-1 resize-none rounded border bg-background px-2 py-1 text-[11px]" />
              <div className="flex flex-col gap-1">
                <Button size="sm" type="submit" className="h-7 px-2 text-[10px]"
                        disabled={busy || !question.trim()}>发送</Button>
                {busy && (
                  <Button size="sm" type="button" variant="outline" className="h-7 px-2 text-[10px]"
                          onClick={() => abortRef.current?.abort()}>停止</Button>
                )}
              </div>
            </form>
          </aside>
        )}
      </div>

      {/* ---- 划词浮层 ---- */}
      {anchor && (
        <div data-reader-chrome
             style={{ position: "fixed", top: anchor.top, left: anchor.left, zIndex: 60 }}
             className="flex items-center gap-0.5 rounded-md border bg-popover px-1 py-0.5 shadow-lg">
          <button className="rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-accent"
                  onClick={() => {
                    setPendingSelection(anchor.text)
                    void ask("解释我划选的这段内容。", anchor.text)
                  }}>问 AI</button>
          {actions.filter((a) => a.key !== "explain").map((a) => (
            <button key={a.key} title={a.prompt}
                    className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => void ask(a.prompt, anchor.text, a.key)}>{a.label}</button>
          ))}
          <button className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
                  title="复制" onClick={() => {
                    navigator.clipboard.writeText(anchor.text).catch(() => {})
                    setAnchor(null)
                  }}>复制</button>
        </div>
      )}
    </div>
  )
}
