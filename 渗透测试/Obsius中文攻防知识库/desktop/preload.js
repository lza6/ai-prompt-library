const { contextBridge, ipcRenderer } = require("electron")

const listen = (channel, callback) => {
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld("desktopBrowser", {
  createBrowserTab: (pid, sid) => ipcRenderer.invoke("browser:create", { pid, sid }),
  createTerminalTab: (pid, cwd) => ipcRenderer.invoke("terminal:create", { pid, cwd }),
  closeTab: (id) => ipcRenderer.invoke("tab:close", id),
  activateTab: (id) => ipcRenderer.invoke("tab:activate", id),
  navigate: (id, url) => ipcRenderer.invoke("browser:navigate", { id, url }),
  goBack: (id) => ipcRenderer.invoke("browser:back", id),
  goForward: (id) => ipcRenderer.invoke("browser:forward", id),
  reload: (id) => ipcRenderer.invoke("browser:reload", id),
  openDevTools: (id) => ipcRenderer.invoke("browser:devtools", id),
  setBounds: (id, rect) => ipcRenderer.send("browser:bounds", { id, rect }),
  setBrowserVisible: (visible) => ipcRenderer.send("browser:visible", visible),
  listTabs: () => ipcRenderer.invoke("tabs:list"),
  discoverMobileDevices: () => ipcRenderer.invoke("mobile:discover"),
  mobileStatus: (projectId) => ipcRenderer.invoke("mobile:status", projectId),
  connectMobileDevice: (projectId, serial) => ipcRenderer.invoke("mobile:connect", { projectId, serial }),
  disconnectMobileDevice: (projectId) => ipcRenderer.invoke("mobile:disconnect", projectId),
  mobileScreenshot: (projectId) => ipcRenderer.invoke("mobile:screenshot", projectId),
  mobileAction: (projectId, action) => ipcRenderer.invoke("mobile:action", { projectId, action }),
  startMobileStream: (projectId) => ipcRenderer.invoke("mobile:stream-start", projectId),
  stopMobileStream: (projectId) => ipcRenderer.invoke("mobile:stream-stop", projectId),
  onMobileDisconnected: (callback) => listen("mobile:disconnected", callback),
  // 投屏（scrcpy）：config 是 SPS/PPS（喂 VideoDecoder.configure），frame 是视频包。
  // 两者都带 projectId，多项目并存时前端要自己筛。
  onMobileStreamConfig: (callback) => listen("mobile:stream-config", callback),
  onMobileStreamFrame: (callback) => listen("mobile:stream-frame", callback),
  onMobileStreamError: (callback) => listen("mobile:stream-error", callback),
  onTabUpdated: (callback) => listen("tabs:updated", callback),
  onTerminalData: (callback) => listen("terminal:data", callback),
  terminalWrite: (id, data) => ipcRenderer.send("terminal:write", { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.send("terminal:resize", { id, cols, rows }),
  terminalKill: (id) => ipcRenderer.invoke("terminal:kill", id),
  // 原生目录选择（「选择分析包」2026-10-24）：只有桌面壳有系统对话框；
  // 浏览器里这个能力不存在，前端据此回落应用内目录浏览器。
  pickDirectory: (defaultPath) => ipcRenderer.invoke("dialog:pick-directory", defaultPath || ""),
  /** 把已算好的 http(s) 地址交系统浏览器打开（异步解析后才能跳转时用）。 */
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  fetchZhihuArticle: (url) => ipcRenderer.invoke("reader:fetch-zhihu", url),
  loginZhihu: () => ipcRenderer.invoke("reader:login-zhihu"),
})

contextBridge.exposeInMainWorld("desktopWindow", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  close: () => ipcRenderer.invoke("window:close"),
  onMaximizedChanged: (callback) => listen("window:maximized", callback),
})
