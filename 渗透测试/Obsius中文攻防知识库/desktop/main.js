const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session, shell, nativeTheme, dialog, nativeImage } = require("electron")
const { spawn, execFile } = require("child_process")
const path = require("path")
const fs = require("fs")

const ROOT = path.resolve(__dirname, "..")
const API_PORT = Number(process.env.CS_API_PORT || 8420)
const CDP_PORT = Number(process.env.CS_ELECTRON_CDP_PORT || 9222)
const API_BASE = `http://127.0.0.1:${API_PORT}`
const UI_URL = process.env.CS_UI_URL || `${API_BASE}/`
// Electron session API is only available after app readiness.
function zhihuSession() { return session.fromPartition("persist:cyberstrike-zhihu") }
const tabs = new Map()
const mobileSessions = new Map()
const readerFetches = new Map()
let readerFetchTail = Promise.resolve()
let readerLoginTabId = null
let mobileHeartbeat = null
let mainWindow = null
let pythonProcess = null
let pythonOwner = false
let activeId = null

app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT))
app.commandLine.appendSwitch("remote-allow-origins", "*")

// 应用壳只允许停在 UI 自身源。此前无守卫：任何顶层导航（误点外链、拖放、重定向、
// 页面里第三方库发起的导航）都会把无边框窗口带走——没有地址栏/后退键，用户被永久
// 卡在空白页，整窗只剩 BrowserWindow 的 backgroundColor（2026-10-06 实测：主窗停在
// https://adc.zzuli.edu.cn/ 的 39 字节空文档）。外链一律交系统浏览器。
function uiOrigin() {
  try { return new URL(UI_URL).origin } catch { return API_BASE }
}

function guardTopLevelNavigation(webContents) {
  const allow = uiOrigin()
  const block = (event, url) => {
    if (url === "about:blank") return
    let target
    try { target = new URL(url) } catch { event.preventDefault(); return }
    if (target.origin === allow) return
    event.preventDefault()
    if (target.protocol === "http:" || target.protocol === "https:") {
      void shell.openExternal(url)
    }
  }
  webContents.on("will-navigate", block)
  webContents.on("will-redirect", block)
  // target="_blank" / window.open：不要在壳里再开一个裸窗（无 preload、无窗控），
  // 交系统浏览器打开。
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
}

/** URL 是否属于 UI 自身源（主窗唯一允许停留的地方）。 */
function isUiUrl(url) {
  if (!url || url === "about:blank") return true
  try {
    const target = new URL(url)
    // ws/wss 与 http/https 视为同源——前端事件流走 ws://<ui-host>/ws/...，
    // 不折算会把主窗自己的 WebSocket 也一起拦掉。
    if (target.protocol === "ws:") target.protocol = "http:"
    else if (target.protocol === "wss:") target.protocol = "https:"
    return target.origin === uiOrigin()
  } catch { return false }
}

// ---- 主窗内容守卫（2026-10-08 事故）----
// 事故：壳把自己注册成项目浏览器（/browser/desktop/attach，cdp_url=壳的 9222），平台
// 浏览器池 connect_over_cdp 后取 contexts[0]——主窗与各 WebContentsView 同在该默认
// context 内，且主窗页排在最前（应用启动最早创建）。Playwright MCP（非 isolated）的
// _currentTab 因此落在主窗上，一次 browser_navigate 就把平台 UI 导航成了目标站（实测
// 主窗停在 m.ys7.com 萤石商城，用户看到「前端变成浏览器」）。
// guardTopLevelNavigation 拦不住：CDP Page.navigate / loadURL 属浏览器侧发起，不触发
// will-navigate。故在此做两道兜底——
//   ① 网络层：按 webContentsId 只放行主窗的 UI 源请求，目标页**永不加载**（preload 的
//      IPC 面也就不会暴露给外部站点：desktopBrowser 能 createTerminalTab 起 PowerShell）。
//   ② 导航看门狗：did-start-navigation / did-navigate 发现主文档离开 UI 源立即回跳。
function guardMainWindowContent(win) {
  const wc = win.webContents
  const wcId = wc.id
  let restoreUntil = 0
  const restore = (reason, url) => {
    if (Date.now() < restoreUntil) return  // 一次导航会连发多个事件，防回跳风暴
    restoreUntil = Date.now() + 2000
    logLine(`主窗被导航离开 UI（${reason}）: ${url} → 回跳 ${UI_URL}`)
    try { wc.stop() } catch (_) { /* 已停止 */ }
    void wc.loadURL(UI_URL).catch(() => { /* UI 不可达时不循环重试 */ })
  }
  try {
    wc.session.webRequest.onBeforeRequest((details, callback) => {
      if (details.webContentsId !== wcId) return callback({})  // 同一 session 还有浏览器标签页
      if (isUiUrl(details.url)) return callback({})
      logLine(`主窗拦截外部请求: ${details.url}`)
      callback({ cancel: true })
    })
  } catch (error) { logLine(`主窗请求过滤挂载失败: ${error}`) }
  wc.on("did-start-navigation", (details, url, _isInPlace, isMainFrame) => {
    const target = (details && details.url) || url
    const main = details && typeof details.isMainFrame === "boolean" ? details.isMainFrame : isMainFrame
    if (main && !isUiUrl(target)) restore("did-start-navigation", target)
  })
  wc.on("did-navigate", (_event, url) => {
    if (!isUiUrl(url)) restore("did-navigate", url)
  })
}

// ---- 壳级日志（logs/desktop.log）----
// 此前壳没有任何日志落盘：主窗渲染进程静默死亡时（render-process-gone 未挂主窗、
// Windows 事件日志也无记录）事后完全无法定位，用户只能看到一片空白。壳级异常与
// 自愈动作一律落此文件。
const LOG_PATH = path.join(ROOT, "logs", "desktop.log")

function logLine(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`)
  } catch (_) { /* 日志写失败绝不阻断主流程 */ }
  console.log("[desktop]", message)
}

// ---- 主窗渲染进程死亡自愈（2026-10-07 白屏事故）----
// 主窗渲染进程一旦退出，窗口就只剩 BrowserWindow.backgroundColor（无边框、无地址栏、
// 无菜单），用户看到的正是「白屏」且无从自救；而重启应用也救不回来（见下 second-instance）。
// 挂 render-process-gone 做退避重载，任何死因都能自愈；连续崩溃设上限防重载风暴——
// 只有加载成功后稳定 60s 才清零计数。
let mainCrashed = false
let reloadAttempts = 0
let reloadResetTimer = null

function noteMainLoaded() {
  mainCrashed = false
  clearTimeout(reloadResetTimer)
  reloadResetTimer = setTimeout(() => { reloadAttempts = 0 }, 60000)
}

function recoverMainWindow(reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (reloadAttempts >= 5) {
    logLine(`主窗自动重载已达上限(5)，停止恢复，请手动重启应用。last=${reason}`)
    return
  }
  const delay = Math.min(1000 * 2 ** reloadAttempts, 15000)
  reloadAttempts += 1
  logLine(`主窗将于 ${delay}ms 后重载（第 ${reloadAttempts} 次）reason=${reason}`)
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.reload() } catch (error) { logLine(`主窗重载失败: ${error}`) }
    }
  }, delay)
}

function attachMainWindowRecovery(win) {
  const wc = win.webContents
  wc.on("render-process-gone", (_event, details) => {
    mainCrashed = true
    logLine(`主窗渲染进程退出 reason=${details && details.reason} exitCode=${details && details.exitCode}`)
    recoverMainWindow((details && details.reason) || "unknown")
  })
  wc.on("unresponsive", () => logLine("主窗无响应（unresponsive）"))
  wc.on("responsive", () => logLine("主窗恢复响应（responsive）"))
  wc.on("did-finish-load", () => noteMainLoaded())
  // 无边框窗口 Menu 置空后，Electron 默认的 Ctrl+R / F5 重载加速键随菜单一起消失，
  // 窗口里没有任何刷新入口——手工补回，兼作渲染进程卡死时的人工逃生口。
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return
    const key = String(input.key || "").toLowerCase()
    if ((input.control && !input.shift && key === "r") || key === "f5") {
      event.preventDefault()
      logLine("人工触发重载（Ctrl+R / F5）")
      wc.reload()
    } else if (input.control && input.shift && key === "i") {
      event.preventDefault()
      wc.openDevTools({ mode: "detach" })
    }
  })
}

function sendTabs() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send("tabs:updated", Array.from(tabs.values()).map((tab) => ({
    id: tab.id, type: tab.type, sid: tab.sid, pid: tab.pid || "", title: tab.title, url: tab.url,
  })))
}

async function apiReady() {
  try {
    const response = await fetch(`${API_BASE}/api/browser/status`)
    return response.ok
  } catch (_) { return false }
}

async function ensurePython() {
  if (await apiReady()) return
  const configuredPython = process.env.CS_PYTHON || "E:\\Miniconda3\\python.exe"
  const python = process.env.CS_PYTHON || (fs.existsSync(configuredPython) ? configuredPython : "python")
  pythonProcess = spawn(python, [path.join(ROOT, "scripts", "serve.py"), String(API_PORT)], {
    cwd: ROOT, windowsHide: true, stdio: "ignore",
  })
  pythonOwner = true
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (await apiReady()) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`Python API did not start on ${API_BASE}`)
}

async function postAttach(tab) {
  if (tab.type !== "browser") return
  try {
    const response = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(tab.pid)}/browser/desktop/attach`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cdp_url: `http://127.0.0.1:${CDP_PORT}`, sid: tab.sid, owner: tab.sid === "human-main" ? "human" : tab.sid }),
    })
    if (response.ok) tab.attached = true
    else tab.error = await response.text()
  } catch (error) { tab.error = String(error) }
  sendTabs()
}

function setTabBounds(id, rect) {
  const tab = tabs.get(id)
  if (!tab || tab.type !== "browser") return
  tab.rect = rect
  const view = tab.view
  const isActive = activeId === id
  view.setBounds(isActive ? {
    x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)),
    width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)),
  } : { x: 0, y: 0, width: 1, height: 1 })
  view.setVisible(isActive)
}

function activateTab(id) {
  if (!tabs.has(id)) return false
  activeId = id
  for (const tab of tabs.values()) {
    if (tab.type !== "browser") continue
    tab.view.setVisible(tab.id === id)
    if (tab.id === id && tab.rect) setTabBounds(tab.id, tab.rect)
  }
  sendTabs()
  return true
}

// 原生浏览器页是覆盖在窗口上的 WebContentsView：前端切走浏览器模块时组件卸载，
// 但原生视图不会自动消失，会留在原位浮在新视图之上。前端挂载/卸载时调用此接口
// 显式显示/隐藏全部浏览器原生视图（隐藏时保持 activeId，重新显示仍用同一页）。
function setBrowserViewsVisible(visible) {
  for (const tab of tabs.values()) {
    if (tab.type !== "browser") continue
    tab.view.setVisible(visible && tab.id === activeId)
  }
  if (visible) {
    const active = tabs.get(activeId)
    if (active?.type === "browser" && active.rect) setTabBounds(activeId, active.rect)
  }
}

// ---- 标签页画布底色（2026-10-22 发暗事故）----
// 这里原先写死成 UI 的深色 `#111419`，但标签页渲染的是**任意外站/文件**，不是平台的
// 深色主题：Chromium 的纯文本视图（直接打开 .js/.txt/.json）和未自绘背景的网页都是
// **透明画布**，文字颜色只跟 `prefers-color-scheme` 走。本机该值为浅色 → 文字是黑的
// → 黑字画在近黑底上，整页「阴暗看不清」（实测底 sum=62、文字 sum≈0，对比度趋近 0；
// 同一 URL 用 Chrome/Edge 打开是白底黑字）。
// 修法：画布底色与文字颜色**同源**——取页面自己的 `prefers-color-scheme`（取不到时
// 退回 `nativeTheme.shouldUseDarkColors`，二者正常一致）。写死任一端都会在另一种系统
// 配色下翻车：深色系统下白底会变成白底白字，一样看不见。
const CANVAS_DARK = "#111419"
const CANVAS_LIGHT = "#ffffff"

async function syncTabCanvas(tab) {
  if (tab.type !== "browser" || !tab.view) return
  let dark = nativeTheme.shouldUseDarkColors
  try {
    const pageDark = await tab.view.webContents.executeJavaScript(
      "matchMedia('(prefers-color-scheme: dark)').matches")
    if (typeof pageDark === "boolean") dark = pageDark
  } catch (_) { /* 页面未就绪/已销毁：沿用 nativeTheme 判定 */ }
  const color = dark ? CANVAS_DARK : CANVAS_LIGHT
  if (tab.canvasColor === color) return
  tab.canvasColor = color
  try { tab.view.setBackgroundColor(color) } catch (_) { /* 视图已销毁 */ }
}

/** 系统配色切换时重算全部标签页画布（只影响透明画布页面，带背景的站不受影响）。 */
function syncAllTabCanvas() {
  for (const tab of tabs.values()) void syncTabCanvas(tab)
}

function createBrowserTab(pid, requestedSid, { browserSession } = {}) {
  const id = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const hasHuman = Array.from(tabs.values()).some((tab) => tab.type === "browser" && tab.sid === "human-main")
  const sid = requestedSid || (!hasHuman ? "human-main" : id)
  const webPreferences = { contextIsolation: true, sandbox: true }
  if (browserSession) webPreferences.session = browserSession
  const view = new WebContentsView({ webPreferences })
  // 首帧先用系统判定（避免白闪），dom-ready 后按页面实际配色校正。
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? CANVAS_DARK : CANVAS_LIGHT)
  mainWindow.contentView.addChildView(view)
  const tab = { id, sid, pid, type: "browser", title: "新标签页", url: "about:blank", view, attached: false }
  tabs.set(id, tab); activateTab(id)
  view.webContents.on("did-navigate", (_event, url) => { tab.url = url; sendTabs() })
  view.webContents.on("did-navigate-in-page", (_event, url) => { tab.url = url; sendTabs() })
  view.webContents.on("page-title-updated", (_event, title) => { tab.title = title || tab.url; sendTabs() })
  // 协议守卫（2026-10-07）：网页里的自定义深链（如抖音的 bytedance://）此前无拦截，
  // Chromium 把它当外部协议交给 OS → Windows 弹「获取打开此'bytedance'链接的应用」系统窗。
  // 标签只浏览 web：非 http(s)/about 一律不动作；_blank/window.open 的 http(s) 改在
  // 当前标签打开（避免冒出裸 BrowserWindow），其余 deny。
  const blockProto = (event, url) => {
    if (url === "about:blank") return
    if (/^https?:/i.test(url)) return
    event.preventDefault()
  }
  view.webContents.on("will-navigate", blockProto)
  view.webContents.on("will-redirect", blockProto)
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void view.webContents.loadURL(url)
    return { action: "deny" }
  })
  view.webContents.on("dom-ready", async () => {
    try { await view.webContents.executeJavaScript(`window.name = ${JSON.stringify(sid)}`) } catch (_) {}
    void syncTabCanvas(tab)   // 画布底色按页面实际配色校正（发暗事故）
    await postAttach(tab)
  })
  view.webContents.on("render-process-gone", () => { tab.error = "页面渲染进程已退出"; sendTabs() })
  view.webContents.loadURL("about:blank")
  sendTabs()
  return { id, sid, type: tab.type, title: tab.title, url: tab.url }
}

function withTimeout(promise, timeoutMs, message, onTimeout) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { onTimeout?.() } catch (_) {}
        reject(new Error(message))
      }, timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

// 知乎抓取策略（2026-10-30 重写）：**隐藏 1x1 抓取窗被知乎识别为异常环境，请求被挂起，
// 实测 loadURL 20 秒超时**；而「可见标签页」是真实浏览器环境，探针实测（含全局 CDP 时）
// 直接拿到 392KB 完整文章页。因此抓取改为：
//   1. 打开**可见标签页**（zhihuSession 专用会话分区）；
//   2. 轮询等待正文出现：正常 → 提取 HTML 导入后端；40362/安全验证/登录墙 →
//      标签页保持可见，等用户手动处理（刷新/验证/登录）后自动续读；
//   3. 超时 → 明确报错并提示可手动完成。
async function fetchZhihuArticle(url) {
  let target
  try { target = new URL(url) } catch { throw new Error("知乎文章地址无效") }
  if (target.protocol !== "https:" || target.hostname !== "zhuanlan.zhihu.com" || !/^\/p\/\d+\/?$/.test(target.pathname)) {
    throw new Error("只支持知乎专栏文章")
  }

  const key = target.href
  if (readerFetches.has(key)) return readerFetches.get(key)
  const task = readerFetchTail.catch(() => {}).then(async () => {
    // createBrowserTab 只返回轻量摘要（id/sid/type/title/url），内部 tab 从
    // tabs 表取（含 view）——与 openZhihuLogin 用法一致。
    const created = createBrowserTab(process.env.CS_PROJECT_ID || "", undefined, { browserSession: zhihuSession() })
    const tab = tabs.get(created.id)
    if (!tab || !tab.view) throw new Error("知乎标签页创建失败")
    const wc = tab.view.webContents
    try {
      await withTimeout(
        wc.loadURL(key), 20000, "知乎文章页面加载超时（20 秒）",
        () => { if (!wc.isDestroyed() && wc.isLoading()) wc.stop() },
      )
      const pageInfo = await pollZhihuArticle(wc, 90000)
      const html = pageInfo.html
      if (typeof html !== "string" || html.length < 100) {
        logLine(`知乎桌面抓取无有效 HTML expected=${key} actual=${pageInfo.url || ""} title=${String(pageInfo.title || "").slice(0, 100)} htmlBytes=${html?.length || 0}`)
        throw new Error("知乎没有返回可读取的文章页面")
      }
      logLine(`知乎桌面抓取页面已加载 expected=${key} actual=${pageInfo.url || ""} title=${String(pageInfo.title || "").slice(0, 100)} htmlBytes=${html.length}`)
      const result = await withTimeout(fetch(`${API_BASE}/api/intel/read/import-browser`, {
        method: "POST", headers: { "content-type": "application/json", "x-cyberstrike-reader": "electron" },
        body: JSON.stringify({ url: key, html }),
      }), 15000, "本地正文导入接口超时（15 秒）")
      const payload = await result.json().catch(() => ({}))
      if (!result.ok) {
        logLine(`知乎桌面抓取导入失败 expected=${key} actual=${pageInfo.url || ""} http=${result.status} detail=${String(payload.detail || "").slice(0, 160)} htmlBytes=${html.length}`)
        throw new Error(payload.detail || `正文解析失败 HTTP ${result.status}`)
      }
      logLine(`知乎桌面抓取导入成功 expected=${key} chars=${payload.chars || 0} status=${payload.status || ""}`)
      return payload
    } finally {
      // 抓取完成（成功或失败）后关掉专用标签页，避免在标签栏堆积。用户手动操作
      // 期间标签页保持可见；只有本轮结束才清理。
      try { tabs.delete(tab.id); tab.view.webContents.close(); sendTabs() } catch (_) { /* 已销毁 */ }
    }
  })
  readerFetchTail = task.catch(() => {})
  readerFetches.set(key, task)
  try { return await task }
  finally { readerFetches.delete(key) }
}

// 轮询知乎标签页直到拿到正文，或遇到需要人工的场景（40362/验证/登录墙）。
// 返回 { url, title, html }；超时抛明确错误。
async function pollZhihuArticle(wc, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  // **为什么不用 executeJavaScript**：Electron 的 `executeJavaScript` 会等页面
  // `did-finish-load` 完成才执行，而知乎的 load 事件实测要 20s+（慢资源拖累），
  // 正文在 `dom-ready`（不到 1s）时已渲染。改用 CDP `Runtime.evaluate`：dom-ready
  // 后立即可执行，正文一出现马上提取——抓取从 20s+ 降到 2~3s。
  await new Promise((resolve) => {
    if (wc.isDestroyed()) return resolve()
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve() } }
    const timer = setTimeout(finish, 2000)
    wc.once("dom-ready", () => { clearTimeout(timer); finish() })
  })
  const dbg = wc.debugger
  if (!wc.isDestroyed() && dbg && !dbg.isAttached()) {
    try { dbg.attach("1.3") } catch (_) { /* 页面已销毁等场景直接跳过 */ }
  }
  const evalJs = async (expression) => {
    const res = await dbg.sendCommand("Runtime.evaluate", { expression, returnByValue: true })
    if (res?.exceptionDetails) throw new Error("知乎页面脚本执行异常")
    return res?.result?.value
  }
  let sawChallenge = false
  while (Date.now() < deadline) {
    if (wc.isDestroyed()) throw new Error("知乎文章标签页已关闭，请重试")
    let info
    try {
      info = await withTimeout(evalJs(`(() => {
        const body = (document.body ? document.body.innerText : "").slice(0, 5000);
        const richtext = document.querySelector(".Post-RichText, .RichText");
        const url = location.href;
        return {
          url: url,
          title: document.title || "",
          len: document.documentElement.outerHTML.length,
          richtextLen: richtext ? richtext.innerText.length : 0,
          is40362: /"code":40362|code 40362/i.test(body),
          isUnhuman: /unhuman|安全验证|人机验证/i.test(body + " " + url),
          isLogin: /请先登录|登录后查看|登录后阅读|sign in/i.test(body) || /\\/signin/.test(url),
        };
      })()`), 1500, "读取知乎页面状态超时")
    } catch (_) {
      await new Promise((r) => setTimeout(r, 300))
      continue
    }
    if (info.is40362 || info.isUnhuman || info.isLogin) {
      // 知乎风控/验证/登录墙：标签页保持可见，等用户手动处理后自动续读。
      if (!sawChallenge) {
        sawChallenge = true
        logLine(`知乎桌面抓取遇到人工场景 expected=${info.url} 40362=${info.is40362} unhuman=${info.isUnhuman} login=${info.isLogin}`)
      }
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    if (info.richtextLen >= 200) {
      const html = await withTimeout(
        evalJs('"<!doctype html>" + document.documentElement.outerHTML'),
        3000, "读取知乎文章页面超时（3 秒）")
      return { url: info.url, title: info.title, html }
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(sawChallenge
    ? "知乎要求安全验证或登录，请在弹开的标签页中手动完成，再点击重试"
    : "等待知乎文章加载超时，请重试")
}

async function openZhihuLogin() {
  const existing = readerLoginTabId && tabs.get(readerLoginTabId)
  const tab = existing || createBrowserTab(process.env.CS_PROJECT_ID || "", undefined, { browserSession: zhihuSession() })
  readerLoginTabId = tab.id
  const entry = tabs.get(tab.id)
  entry.title = "知乎登录"
  entry.view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(?:www\\.)?zhihu\\.com\//i.test(url)) void entry.view.webContents.loadURL(url)
    return { action: "deny" }
  })
  await withTimeout(entry.view.webContents.loadURL("https://www.zhihu.com/signin"),
    20000, "知乎专用登录页加载超时", () => entry.view.webContents.stop())
  activateTab(tab.id)
  sendTabs()
  // Wait for actual online authentication, not mere existence of a cookie.
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    if (entry.view.webContents.isDestroyed()) throw new Error("知乎登录页已关闭")
    try {
      const authenticated = await withTimeout(entry.view.webContents.executeJavaScript(`
        fetch("https://www.zhihu.com/api/v4/me", { credentials: "include" })
          .then(async (r) => r.ok && !!(await r.json()).id).catch(() => false)
      `), 5000, "知乎认证检查超时")
      if (authenticated) {
        await zhihuSession().cookies.flushStore()
        await zhihuSession().flushStorageData()
        return { opened: true, tab_id: tab.id, authenticated: true }
      }
    } catch (error) {
      if (entry.view.webContents.isDestroyed()) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error("知乎专用会话登录等待超时，请完成登录后重试")
}

function createTerminalTab(pid, cwd) {
  const id = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  let pty
  try {
    const nodePty = require("node-pty")
    pty = nodePty.spawn("powershell.exe", ["-NoLogo", "-NoProfile"], {
      name: "xterm-color", cols: 120, rows: 32, cwd: cwd && fs.existsSync(cwd) ? cwd : ROOT,
      env: { ...process.env, TERM: "xterm-256color" },
    })
  } catch (error) {
    return { error: `node-pty unavailable: ${error}` }
  }
  const tab = { id, sid: id, pid: pid || "", type: "terminal", title: "终端", url: "", pty }
  tabs.set(id, tab); activateTab(id)
  pty.onData((data) => mainWindow?.webContents.send("terminal:data", { id, data }))
  pty.onExit(() => { if (tabs.has(id)) { tabs.delete(id); sendTabs() } })
  sendTabs()
  return { id, sid: id, type: tab.type, title: tab.title, url: tab.url }
}

async function closeTab(id) {
  const tab = tabs.get(id)
  if (!tab) return
  if (tab.pty) { try { tab.pty.kill() } catch (_) {} }
  if (tab.view) {
    try {
      await fetch(`${API_BASE}/api/projects/${encodeURIComponent(tab.pid)}/browser/desktop/detach`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sid: tab.sid, paused: false }),
      })
    } catch (_) {}
    try { mainWindow.contentView.removeChildView(tab.view); tab.view.webContents.close() } catch (_) {}
  }
  tabs.delete(id)
  if (activeId === id) activeId = tabs.keys().next().value || null
  sendTabs()
}

function getTab(id) { return tabs.get(id) }

// Mobile operations stay in the trusted desktop main process. The renderer only
// receives structured device metadata, screenshots, and bounded touch actions.
const ADB = process.env.CS_ADB_PATH || path.join(process.env.ANDROID_HOME || "D:\\AndroidSdk", "platform-tools", "adb.exe")
const ADB_TIMEOUT_MS = 10000
const MOBILE_HEARTBEAT_MS = 5000
const MOBILE_STATE_TTL_MS = 15000

function runAdb(args, { timeout = ADB_TIMEOUT_MS, encoding = "utf8" } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ADB, args, { windowsHide: true, timeout, encoding, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || "ADB 命令失败").trim()
        reject(new Error(detail.slice(0, 600)))
        return
      }
      resolve(stdout)
    })
  })
}

function mobileDeviceArg(serial) {
  const value = String(serial || "").trim()
  if (!value || value.length > 128 || /[\s\0]/.test(value)) throw new Error("设备序列号无效")
  return value
}

function parseAdbDevices(output) {
  return String(output || "").split(/\r?\n/).slice(1).flatMap((line) => {
    const match = /^([^\s]+)\s+(device|unauthorized|offline)(?:\s+(.*))?$/.exec(line.trim())
    if (!match) return []
    const [, serial, status, details = ""] = match
    const model = /(?:^|\s)model:([^\s]+)/.exec(details)?.[1]?.replace(/_/g, " ") || ""
    return [{ serial, status, model }]
  })
}

async function syncMobileState(projectId, state) {
  const pid = String(projectId || "").trim()
  if (!pid) return
  try {
    await fetch(`${API_BASE}/api/projects/${encodeURIComponent(pid)}/mobile/state`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify(state), signal: AbortSignal.timeout(3000),
    })
  } catch (error) { logLine(`Android 状态同步失败 pid=${pid} ${error}`) }
}

async function refreshMobileDevice(projectId, serial, { publish = true } = {}) {
  const pid = String(projectId || "").trim()
  const device = mobileSessions.get(pid)
  if (!device || device.serial !== serial) return null
  try {
    const [stateOut, modelOut] = await Promise.all([
      runAdb(["-s", serial, "get-state"], { timeout: 4000 }),
      runAdb(["-s", serial, "shell", "getprop", "ro.product.model"], { timeout: 4000 }),
    ])
    if (String(stateOut).trim() !== "device") throw new Error("设备已离线或未授权")
    device.connected = true
    device.lastSeen = Date.now()
    device.model = String(modelOut || device.model || "").trim().slice(0, 80)
    if (publish) void syncMobileState(pid, { connected: true, serial, model: device.model })
    return { projectId: pid, serial, model: device.model, connected: true }
  } catch (error) {
    device.connected = false
    mobileSessions.delete(pid)
    if (publish) void syncMobileState(pid, { connected: false })
    mainWindow?.webContents.send("mobile:disconnected", { projectId: pid, serial, error: String(error.message || error) })
    return null
  }
}

async function discoverMobileDevices() {
  const output = await runAdb(["devices", "-l"])
  return parseAdbDevices(output)
}

async function connectMobileDevice(projectId, serial) {
  const pid = String(projectId || "").trim()
  const selected = mobileDeviceArg(serial)
  if (!pid) throw new Error("缺少项目 ID")
  const devices = await discoverMobileDevices()
  const device = devices.find((item) => item.serial === selected)
  if (!device || device.status !== "device") {
    throw new Error(device?.status === "unauthorized" ? "设备未授权，请在手机上确认 USB 调试授权" : "所选设备不可用，请重新查询")
  }
  const session = { serial: selected, model: device.model, connected: true, lastSeen: Date.now() }
  mobileSessions.set(pid, session)
  try {
    const current = await refreshMobileDevice(pid, selected, { publish: false })
    if (!current) throw new Error("设备连接校验失败")
    await syncMobileState(pid, { connected: true, serial: selected, model: current.model })
    return current
  } catch (error) {
    mobileSessions.delete(pid)
    await syncMobileState(pid, { connected: false })
    throw error
  }
}

// 截图降采样（mobile-frame-budget，2026-10-28）：1080×2158 的 PNG 有 137KB，
// base64 后 182KB 要过 IPC、再被渲染进程按全尺寸解码。实测同一帧：
//   PNG 1080      136860 B  base64 182480 B  解码 7ms
//   JPEG 540/q70   29984 B  base64  39978 B  解码 2ms
// 载荷降到 1/4.5、解码降到 1/3，而控制面板里 540 宽视觉上够用。
// 用 Electron 内置 nativeImage，零新依赖；转换失败就原样回 PNG（功能不受影响）。
const MOBILE_FRAME_WIDTH = Number(process.env.CS_MOBILE_FRAME_WIDTH || 540)
const MOBILE_FRAME_QUALITY = Number(process.env.CS_MOBILE_FRAME_QUALITY || 70)

function encodeMobileFrame(pngBuffer) {
  const fallback = { data: Buffer.from(pngBuffer).toString("base64"), mimeType: "image/png" }
  try {
    const image = nativeImage.createFromBuffer(pngBuffer)
    if (image.isEmpty()) return fallback
    const size = image.getSize()
    if (!size.width || !size.height) return fallback
    const resized = size.width > MOBILE_FRAME_WIDTH
      ? image.resize({ width: MOBILE_FRAME_WIDTH, quality: "good" })
      : image
    const jpeg = resized.toJPEG(MOBILE_FRAME_QUALITY)
    if (!jpeg || !jpeg.length) return fallback
    return { data: jpeg.toString("base64"), mimeType: "image/jpeg" }
  } catch (error) {
    logLine(`截图转码失败，回落 PNG: ${error}`)
    return fallback
  }
}

async function mobileScreenshot(projectId) {
  const device = mobileSessions.get(String(projectId || ""))
  if (!device?.connected || Date.now() - device.lastSeen > MOBILE_STATE_TTL_MS) throw new Error("设备连接已过期，请重新连接")
  // 不再每次取帧都跑 refreshMobileDevice（mobile-frame-budget，2026-10-28）：
  // 那是一次并发的 get-state + getprop，稳态也要 ~110ms，而 5s 心跳 + 15s TTL
  // 已经覆盖了断连判定——重复检查只是给每帧白加延迟。截图自己失败时报的错
  // 也比「健康检查失败」更准（原先两种错混在一条消息里）。
  const data = await runAdb(["-s", device.serial, "exec-out", "screencap", "-p"], { timeout: 8000, encoding: "buffer" })
  device.lastSeen = Date.now()
  const frame = encodeMobileFrame(data)
  return { ...frame, model: device.model }
}

async function mobileTouch(projectId, action) {
  const device = mobileSessions.get(String(projectId || ""))
  if (!device?.connected || Date.now() - device.lastSeen > MOBILE_STATE_TTL_MS) throw new Error("设备连接已过期，请重新连接")
  // 同上：健康检查交给心跳，触控只做触控（省 ~110ms，点击响应更快）。
  const int = (value, name) => {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 0 || n > 10000) throw new Error(`${name} 坐标无效`)
    return n
  }
  if (action?.type === "tap") {
    await runAdb(["-s", device.serial, "shell", "input", "tap", String(int(action.x, "X")), String(int(action.y, "Y"))])
  } else if (action?.type === "swipe") {
    const x1 = int(action.x1, "起点 X"), y1 = int(action.y1, "起点 Y")
    const x2 = int(action.x2, "终点 X"), y2 = int(action.y2, "终点 Y")
    const duration = Math.max(80, Math.min(1500, Number(action.duration) || 300))
    await runAdb(["-s", device.serial, "shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(duration)])
  } else if (action?.type === "back") {
    await runAdb(["-s", device.serial, "shell", "input", "keyevent", "4"])
  } else if (action?.type === "home") {
    await runAdb(["-s", device.serial, "shell", "input", "keyevent", "3"])
  } else {
    throw new Error("不支持的手机操作")
  }
  return { ok: true }
}

async function disconnectMobileDevice(projectId) {
  const pid = String(projectId || "").trim()
  stopMobileStream(pid)
  const device = mobileSessions.get(pid)
  mobileSessions.delete(pid)
  await syncMobileState(pid, { connected: false })
  return { disconnected: Boolean(device) }
}

// ---------------- 实时投屏（scrcpy-server，2026-10-28） ----------------
//
// 为什么不用 screencap 逐帧：实测 1080×2158 一次 456–549ms，吞吐硬顶 2.3fps。
// 为什么不用 screenrecord：`--time-limit` 上限 180s，到点自退，循环重启每次约
//   400ms 黑屏（实测逐帧亮度会掉到 0），调参无解。
// scrcpy-server 实测：动态 25.9fps、连续 21.4s 共 423 帧**零黑帧**、无时间限制。
//
// 协议（3.3.4，实测确认，改动前务必重测）：
//   dummy(1B) → device name(64B, NUL 补齐) → codec(4B)+width(4B)+height(4B)
//   → 循环 { pts_flags(8B, big-endian) + size(4B) + payload(size) }
//   pts_flags 高位是标志位：bit63=CONFIG(SPS/PPS)、bit62=KEY(关键帧)。
//   注意 `max_size=1080` 是**按长边缩放**，1080×2158 会变成 544×1080 —— 坐标换算
//   必须用流里的 width/height，不能用 `wm size`。
const SCRCPY_SERVER_VERSION = "3.3.4"
const SCRCPY_SERVER_JAR = path.join(ROOT, "tools", "android", "scrcpy-server")
const SCRCPY_DEVICE_JAR = "/data/local/tmp/scrcpy-server.jar"
const SCRCPY_PACKET_FLAG_CONFIG = 1n << 63n
const SCRCPY_PACKET_FLAG_KEY = 1n << 62n
// 单包上限：一帧 544×1080 的 H.264 关键帧实测 < 200KB，8MB 是「明显不对」的闸。
// 没有这道闸时，一个错位的 size 字段会让缓冲区无限增长直到进程 OOM。
const SCRCPY_MAX_PACKET_BYTES = 8 * 1024 * 1024
const MOBILE_STREAM_MAX_FPS = Number(process.env.CS_MOBILE_MAX_FPS || 30)
const MOBILE_STREAM_BITRATE = Number(process.env.CS_MOBILE_BITRATE || 8000000)

const mobileStreams = new Map()

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = require("net").createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function readExact(socket, length) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length >= length) {
        cleanup()
        // **不能 pause()**：后续的 readExact 依赖 socket 处于 flowing 模式，
        // pause 之后 data 事件不再触发，下一个 readExact 会永久挂住（握手卡死）。
        // 多读到的字节 unshift 回去，交给下一次读取。
        if (buffer.length > length) socket.unshift(buffer.subarray(length))
        resolve(buffer.subarray(0, length))
      }
    }
    const onError = (error) => { cleanup(); reject(error) }
    const onClose = () => { cleanup(); reject(new Error("视频流已关闭")) }
    const cleanup = () => {
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    socket.on("data", onData)
    socket.on("error", onError)
    socket.on("close", onClose)
  })
}

async function startMobileStream(projectId) {
  const pid = String(projectId || "").trim()
  const device = mobileSessions.get(pid)
  if (!device?.connected) throw new Error("设备未连接")
  if (mobileStreams.has(pid)) return mobileStreams.get(pid).info
  if (!fs.existsSync(SCRCPY_SERVER_JAR)) throw new Error("缺少 scrcpy-server（tools/android/scrcpy-server）")

  const serial = device.serial
  await runAdb(["-s", serial, "push", SCRCPY_SERVER_JAR, SCRCPY_DEVICE_JAR], { timeout: 20000 })

  const server = spawn(ADB, ["-s", serial, "shell",
    `CLASSPATH=${SCRCPY_DEVICE_JAR} app_process / com.genymobile.scrcpy.Server ${SCRCPY_SERVER_VERSION}`,
    `log_level=error max_size=1080 max_fps=${MOBILE_STREAM_MAX_FPS}`,
    `video_bit_rate=${MOBILE_STREAM_BITRATE} tunnel_forward=true audio=false control=false`,
  ], { windowsHide: true })
  server.on("error", () => {})
  // server 的输出只用于判启动失败；正常路径不解析它（协议走 socket）。
  let serverLog = ""
  server.stdout?.on("data", (d) => { serverLog = (serverLog + d).slice(-800) })
  server.stderr?.on("data", (d) => { serverLog = (serverLog + d).slice(-800) })

  const port = await freeTcpPort()
  const forward = () => runAdb(["-s", serial, "forward", `tcp:${port}`, "localabstract:scrcpy"], { timeout: 8000 })
  // server 起来要 ~400ms，forward 目标不存在会立刻失败，故重试。
  let forwarded = false
  for (let attempt = 0; attempt < 20 && !forwarded; attempt += 1) {
    try {
      await forward()
      forwarded = true
    } catch (error) {
      if (server.exitCode !== null) throw new Error(`scrcpy-server 启动失败: ${serverLog.trim() || error.message}`)
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  if (!forwarded) {
    server.kill()
    throw new Error(`scrcpy-server 端口转发失败: ${serverLog.trim()}`)
  }

  // 连 server 并完成握手，整段重试（mobile-stream-retry，2026-10-28）。
  //
  // 为什么整段重试而不是只重试 connect：`adb forward` 对**尚未 listen** 的
  // abstract socket 也会成功（它只登记转发规则），所以 connect 也可能「成功」，
  // 随后 server 才真正起来 —— 表现为连上后立刻 close（实测 "视频流已关闭"）。
  // 判据是**握手完成**（读到 12 字节 codec 头），不是 connect 成功。
  const HANDSHAKE_ATTEMPTS = 20
  let socket = null
  let deviceName = ""
  let codec = ""
  let width = 0
  let height = 0
  let lastError = null

  for (let attempt = 0; attempt < HANDSHAKE_ATTEMPTS && !socket; attempt += 1) {
    const conn = await new Promise((resolve) => {
      const c = require("net").createConnection({ port, host: "127.0.0.1" })
      let settled = false
      const done = (value) => { if (!settled) { settled = true; resolve(value) } }
      c.once("connect", () => done(c))
      c.once("error", (error) => { lastError = error; c.destroy(); done(null) })
      c.setTimeout(2000, () => { lastError = new Error("连接超时"); c.destroy(); done(null) })
    })
    if (!conn) {
      await new Promise((r) => setTimeout(r, 200))
      continue
    }
    try {
      conn.setTimeout(3000)
      await readExact(conn, 1)  // dummy 字节
      const nameBuf = await readExact(conn, 64)
      const meta = await readExact(conn, 12)
      conn.setTimeout(0)
      deviceName = nameBuf.toString("utf8").split("\x00")[0]
      codec = meta.subarray(0, 4).toString("latin1")
      width = meta.readUInt32BE(4)
      height = meta.readUInt32BE(8)
      socket = conn
    } catch (error) {
      lastError = error
      try { conn.destroy() } catch (_) {}
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  if (!socket) {
    server.kill()
    throw new Error(`scrcpy-server 握手失败: ${lastError?.message || serverLog.trim() || "超时"}`)
  }

  try {
    const info = { projectId: pid, codec, width, height, deviceName, mode: "scrcpy" }
    const state = { server, socket, port, serial, info, stopped: false }
    mobileStreams.set(pid, state)
    pumpMobileStream(pid, state)
    logLine(`投屏已启动 pid=${pid} ${width}x${height} codec=${codec}`)
    return info
  } catch (error) {
    try { socket.destroy() } catch (_) {}
    server.kill()
    throw error
  }
}

// 持续把包转发给渲染进程。config 包（SPS/PPS）单独带出去——WebCodecs 的
// VideoDecoder.configure({description}) 需要它，丢掉就解不出画面。
//
// 切包逻辑抽成 drainScrcpyPackets 纯函数（不碰 socket），这样协议头解析可以被
// 判据测试直接驱动——否则只能靠「真机跑起来看有没有画面」，一旦 size 字段的
// 偏移写错，症状是花屏/黑屏，从现象倒推不出是哪 4 个字节错了。
function drainScrcpyPackets(pending, onPacket) {
  let offset = 0
  while (pending.length - offset >= 12) {
    const flags = pending.readBigUInt64BE(offset)
    const size = pending.readUInt32BE(offset + 8)
    if (size > SCRCPY_MAX_PACKET_BYTES) {
      return { pending: Buffer.alloc(0), error: `帧长度异常: ${size}` }
    }
    if (pending.length - offset < 12 + size) break
    const payload = pending.subarray(offset + 12, offset + 12 + size)
    onPacket(payload, (flags & SCRCPY_PACKET_FLAG_CONFIG) === SCRCPY_PACKET_FLAG_CONFIG,
      (flags & SCRCPY_PACKET_FLAG_KEY) === SCRCPY_PACKET_FLAG_KEY)
    offset += 12 + size
  }
  // 已消费的字节必须切掉：Buffer.subarray 只是视图，不切会让 pending 一直指向
  // 整条累积缓冲，几秒后就变成几百 MB 的常驻内存。
  return { pending: offset ? pending.subarray(offset) : pending, error: null }
}

function pumpMobileStream(pid, state) {
  const { socket } = state
  let pending = Buffer.alloc(0)
  let frames = 0
  let lastReport = Date.now()

  const fail = (reason) => {
    if (state.stopped) return
    stopMobileStream(pid)
    mainWindow?.webContents.send("mobile:stream-error", { projectId: pid, error: String(reason) })
  }

  socket.on("data", (chunk) => {
    if (state.stopped) return
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    const result = drainScrcpyPackets(pending, (payload, isConfig, isKey) => {
      if (isConfig) {
        mainWindow?.webContents.send("mobile:stream-config", {
          projectId: pid, data: new Uint8Array(payload), codec: state.info.codec,
        })
      } else {
        frames += 1
        mainWindow?.webContents.send("mobile:stream-frame", {
          projectId: pid, data: new Uint8Array(payload), key: isKey,
        })
      }
    })
    pending = result.pending
    if (result.error) fail(result.error)
    if (Date.now() - lastReport > 5000) {
      lastReport = Date.now()
      logLine(`投屏 pid=${pid} 帧数=${frames}`)
    }
  })
  socket.on("close", () => fail("视频流已关闭"))
  socket.on("error", (error) => fail(error))
}

function stopMobileStream(projectId) {
  const pid = String(projectId || "").trim()
  const state = mobileStreams.get(pid)
  if (!state) return { stopped: false }
  state.stopped = true
  mobileStreams.delete(pid)
  try { state.socket.destroy() } catch (_) {}
  try { state.server.kill() } catch (_) {}
  if (state.port) {
    void runAdb(["-s", state.serial, "forward", "--remove", `tcp:${state.port}`], { timeout: 5000 })
      .catch(() => {})
  }
  logLine(`投屏已停止 pid=${pid}`)
  return { stopped: true }
}

async function createWindow() {
  await ensurePython()
  mainWindow = new BrowserWindow({
    width: 1500, height: 960, minWidth: 1100, minHeight: 680,
    backgroundColor: "#111419",
    frame: false,
    autoHideMenuBar: true,
    // partition（2026-10-08）：主窗独占一个 StoragePartition，即在 CDP 里独占一个
    // browser context——否则平台浏览器池 connect_over_cdp 后的 contexts[0]（Electron
    // 默认 context）里既有各浏览器标签页、也有平台 UI 主窗，Playwright MCP 的
    // _currentTab 会挑中主窗并把前端导航走。代价：UI 的 localStorage 随 partition
    // 走，换 partition 后外观/导航折叠等前端偏好会重置一次。
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      partition: "persist:cyberstrike-ui",
    },
  })
  const url = UI_URL
  guardTopLevelNavigation(mainWindow.webContents)
  attachMainWindowRecovery(mainWindow)
  guardMainWindowContent(mainWindow)
  await mainWindow.loadURL(url)
  // 下载默认落到项目 workspaces/downloads。主窗换 partition 后与浏览器标签页不再共用
  // session，故两处都要挂（标签页的下载在 default session）。
  const setDownloadPath = (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(ROOT, "workspaces", "downloads", item.getFilename()) })
  }
  session.defaultSession.on("will-download", setDownloadPath)
  mainWindow.webContents.session.on("will-download", setDownloadPath)
  mainWindow.on("resize", () => {
    mainWindow.webContents.send("desktop:resize")
    mainWindow.webContents.send("window:maximized", mainWindow.isMaximized())
  })
  mainWindow.on("maximize", () => mainWindow.webContents.send("window:maximized", true))
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window:maximized", false))
  mainWindow.on("closed", () => { mainWindow = null })
}

// 单实例锁：两个实例共用同一 Chromium user-data-dir（CDP 端口 / 缓存 / 存储互相踩，
// 后启动的那个连 remote-debugging-port 都绑不上），且用户看到空白窗时再双击启动只会
// 再叠一个窗，无从判断该关哪个。第二次启动改为聚焦已有窗口；若它已被导航离开 UI
// （旧版本无守卫时可能发生）**或渲染进程已死**（窗口只剩背景色 = 白屏），一律重载自愈。
// —— 2026-10-07：自愈条件原先只比对 URL origin，而渲染进程死亡后 getURL() 仍报 UI
// 源，同源判断直接漏掉白屏；于是「重启后端 / 再双击启动器」全成了空操作，用户被永久
// 卡在空白窗（新实例拿到不到锁就 app.quit，实测 exit=0 立即退出）。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    let away = false
    try {
      away = new URL(mainWindow.webContents.getURL()).origin !== uiOrigin()
    } catch (_) { away = true }  // 取 URL 失败按「已离开 UI」处理
    if (mainCrashed || away) {
      logLine(`二次启动自愈：重载主窗（crashed=${mainCrashed} away=${away}）`)
      reloadAttempts = 0
      void mainWindow.webContents.reload()
    }
  })
}

app.whenReady().then(async () => {
  if (!app.hasSingleInstanceLock()) return  // 第二实例：已 quit，不再建窗
  logLine(`壳启动 v${app.getVersion()} UI=${UI_URL} cdp=${CDP_PORT} api=${API_BASE}`)
  // The renderer owns the title bar in the frameless window. Keep the native
  // application menu out of the content area on every desktop platform.
  Menu.setApplicationMenu(null)
  ipcMain.handle("tabs:list", () => Array.from(tabs.values()).map((tab) => ({ id: tab.id, sid: tab.sid, pid: tab.pid || "", type: tab.type, title: tab.title, url: tab.url })))
  ipcMain.handle("mobile:discover", async () => ({ devices: await discoverMobileDevices() }))
  ipcMain.handle("mobile:status", async (_event, projectId) => {
    const device = mobileSessions.get(String(projectId || ""))
    return device ? await refreshMobileDevice(projectId, device.serial) : null
  })
  ipcMain.handle("mobile:connect", (_event, { projectId, serial }) => connectMobileDevice(projectId, serial))
  ipcMain.handle("mobile:disconnect", (_event, projectId) => disconnectMobileDevice(projectId))
  ipcMain.handle("mobile:screenshot", (_event, projectId) => mobileScreenshot(projectId))
  ipcMain.handle("mobile:action", (_event, { projectId, action }) => mobileTouch(projectId, action))
  ipcMain.handle("mobile:stream-start", (_event, projectId) => startMobileStream(projectId))
  ipcMain.handle("mobile:stream-stop", (_event, projectId) => stopMobileStream(projectId))
  mobileHeartbeat = setInterval(() => {
    for (const [pid, device] of mobileSessions) {
      if (device.connected) void refreshMobileDevice(pid, device.serial)
    }
  }, MOBILE_HEARTBEAT_MS)
  mobileHeartbeat.unref?.()
  // 系统配色切换（亮/暗）时重算标签页画布，见 syncTabCanvas 注释。
  nativeTheme.on("updated", () => {
    logLine(`系统配色变化 shouldUseDark=${nativeTheme.shouldUseDarkColors} → 重算标签页画布`)
    syncAllTabCanvas()
  })
  ipcMain.handle("window:minimize", () => mainWindow?.minimize())
  ipcMain.handle("window:toggle-maximize", () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle("window:is-maximized", () => Boolean(mainWindow?.isMaximized()))
  ipcMain.handle("window:close", () => mainWindow?.close())
  // 显式外链通道（2026-10-25）：渲染进程不能靠 window.open 承接异步结果——
  // guardTopLevelNavigation 的 setWindowOpenHandler 对**任何** window.open（含
  // about:blank）都返回 deny，调用方拿到的是 null（曾误报成「浏览器拦截弹窗」）。
  // 情报检索需要「先把 Google News 中转 token 解析成真实地址，再打开」，故提供
  // 这个入口。只放行 http(s)；其余返回 false，绝不把任意 scheme 交给系统。
  ipcMain.handle("shell:open-external", async (_event, url) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      logLine(`shell:open-external 拒绝非法 url=${String(url).slice(0, 80)}`)
      return false
    }
    try {
      // 成功也留痕：此前只记失败，成功路径在主进程完全不可见，
      // 排查「点了没反应」时拿不到任何证据。
      await shell.openExternal(url)
      logLine(`shell:open-external 已交系统浏览器 url=${url}`)
      return true
    } catch (error) {
      logLine(`shell:open-external 失败 url=${url} ${error}`)
      return false
    }
  })
  ipcMain.handle("browser:create", (_event, args) => createBrowserTab(args?.pid || process.env.CS_PROJECT_ID || "", args?.sid))
  ipcMain.handle("reader:fetch-zhihu", (_event, url) => fetchZhihuArticle(String(url || "")))
  ipcMain.handle("reader:login-zhihu", () => openZhihuLogin())
  ipcMain.handle("terminal:create", (_event, args) => createTerminalTab(args?.pid, args?.cwd))
  ipcMain.handle("tab:close", (_event, id) => closeTab(id))
  ipcMain.handle("tab:activate", (_event, id) => activateTab(id))
  ipcMain.handle("browser:navigate", (_event, { id, url }) => { const tab = getTab(id); if (tab?.view) return tab.view.webContents.loadURL(url); return false })
  ipcMain.handle("browser:back", (_event, id) => getTab(id)?.view?.webContents.goBack())
  ipcMain.handle("browser:forward", (_event, id) => getTab(id)?.view?.webContents.goForward())
  ipcMain.handle("browser:reload", (_event, id) => getTab(id)?.view?.webContents.reload())
  ipcMain.handle("browser:devtools", (_event, id) => { const view = getTab(id)?.view; if (view) view.webContents.openDevTools({ mode: "detach" }) })
  ipcMain.on("browser:bounds", (_event, { id, rect }) => setTabBounds(id, rect))
  ipcMain.on("browser:visible", (_event, visible) => setBrowserViewsVisible(Boolean(visible)))
  ipcMain.on("terminal:write", (_event, { id, data }) => getTab(id)?.pty?.write(data))
  ipcMain.on("terminal:resize", (_event, { id, cols, rows }) => { try { getTab(id)?.pty?.resize(cols, rows) } catch (_) {} })
  ipcMain.handle("terminal:kill", (_event, id) => closeTab(id))
  // 原生目录选择（「选择分析包」2026-10-24）：选一个**已存在的目录**作为分析包
  // （同时也是执行工作区）。返回绝对路径；用户取消返回空串。
  // createDirectory 允许新建（有些人是「先建个空目录再往里拷」），但默认不新建。
  ipcMain.handle("dialog:pick-directory", async (_event, defaultPath) => {
    if (!mainWindow || mainWindow.isDestroyed()) return ""
    const options = {
      title: "选择分析包目录（同时也是执行工作区）",
      buttonLabel: "选择此目录",
      properties: ["openDirectory", "createDirectory"],
    }
    if (defaultPath && fs.existsSync(defaultPath)) options.defaultPath = defaultPath
    const result = await dialog.showOpenDialog(mainWindow, options)
    if (result.canceled || !result.filePaths.length) return ""
    return result.filePaths[0]
  })
  try { await createWindow() } catch (error) { logLine(`主窗创建失败: ${error}`); app.quit() }
})

app.on("window-all-closed", async () => {
  // 先停投屏：screenrecord/scrcpy 的 server 进程与 adb forward 都是外部资源，
  // 不显式收掉会留在设备与 adb server 里。
  for (const pid of Array.from(mobileStreams.keys())) stopMobileStream(pid)
  for (const id of Array.from(tabs.keys())) await closeTab(id)
  if (pythonOwner) { try { await fetch(`${API_BASE}/api/admin/shutdown`, { method: "POST" }) } catch (_) {} }
  if (process.platform !== "darwin") app.quit()
})
