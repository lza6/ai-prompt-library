export {}

declare global {
  interface DesktopTab { id: string; sid: string; pid?: string; type: "browser" | "terminal"; title: string; url: string }
  interface MobileDevice { serial: string; status: "device" | "unauthorized" | "offline"; model: string }
  type MobileAction =
    | { type: "tap"; x: number; y: number }
    | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; duration?: number }
    | { type: "back" | "home" }
  /** 投屏流信息。width/height 是**流**尺寸（max_size 按长边缩放，1080×2158 → 544×1080），
   *  不是设备物理分辨率——坐标换算必须用这两个值。 */
  interface MobileStreamInfo {
    projectId: string
    codec: string
    width: number
    height: number
    deviceName: string
    mode: "scrcpy" | "screenrecord"
  }
  interface DesktopBrowserApi {
    createBrowserTab: (pid?: string, sid?: string) => Promise<DesktopTab | { error: string }>
    createTerminalTab: (pid?: string, cwd?: string) => Promise<DesktopTab | { error: string }>
    closeTab: (id: string) => Promise<void>
    activateTab: (id: string) => Promise<boolean>
    navigate: (id: string, url: string) => Promise<unknown>
    goBack: (id: string) => Promise<unknown>
    goForward: (id: string) => Promise<unknown>
    reload: (id: string) => Promise<unknown>
    openDevTools: (id: string) => Promise<void>
    setBounds: (id: string, rect: { x: number; y: number; width: number; height: number }) => void
    setBrowserVisible: (visible: boolean) => void
    listTabs: () => Promise<DesktopTab[]>
    discoverMobileDevices?: () => Promise<{ devices: MobileDevice[] }>
    mobileStatus?: (projectId: string) => Promise<{ projectId: string; serial: string; model: string; connected: boolean } | null>
    connectMobileDevice?: (projectId: string, serial: string) => Promise<{ projectId: string; serial: string; model: string; connected: boolean }>
    disconnectMobileDevice?: (projectId: string) => Promise<{ disconnected: boolean }>
    mobileScreenshot?: (projectId: string) => Promise<{ data: string; mimeType: string; model: string }>
    mobileAction?: (projectId: string, action: MobileAction) => Promise<{ ok: boolean }>
    /** 启动/停止 scrcpy 实时投屏；重复启动返回同一路流。 */
    startMobileStream?: (projectId: string) => Promise<MobileStreamInfo>
    stopMobileStream?: (projectId: string) => Promise<{ stopped: boolean }>
    onMobileDisconnected?: (callback: (event: { projectId: string; serial: string; error: string }) => void) => () => void
    /** SPS/PPS，喂给 VideoDecoder.configure({description})。 */
    onMobileStreamConfig?: (callback: (event: { projectId: string; data: Uint8Array; codec: string }) => void) => () => void
    /** 单个视频包（Annex-B 裸流）。 */
    onMobileStreamFrame?: (callback: (event: { projectId: string; data: Uint8Array; key: boolean }) => void) => () => void
    onMobileStreamError?: (callback: (event: { projectId: string; error: string }) => void) => () => void
    onTabUpdated: (callback: (tabs: DesktopTab[]) => void) => () => void
    onTerminalData: (callback: (data: { id: string; data: string }) => void) => () => void
    terminalWrite: (id: string, data: string) => void
    terminalResize: (id: string, cols: number, rows: number) => void
    terminalKill: (id: string) => Promise<void>
    /** 原生目录选择（仅桌面壳）：返回绝对路径，用户取消返回空串。 */
    pickDirectory?: (defaultPath?: string) => Promise<string>
    /** 交系统浏览器打开已算好的 http(s) 地址；拒绝非 http(s) 返回 false。 */
    openExternal?: (url: string) => Promise<boolean>
    fetchZhihuArticle?: (url: string) => Promise<unknown>
    loginZhihu?: () => Promise<{ opened: boolean }>
  }
  interface Window { desktopBrowser?: DesktopBrowserApi }
  interface DesktopWindowApi {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<boolean>
    isMaximized: () => Promise<boolean>
    close: () => Promise<void>
    onMaximizedChanged: (callback: (maximized: boolean) => void) => () => void
  }
  interface Window { desktopWindow?: DesktopWindowApi }
}
