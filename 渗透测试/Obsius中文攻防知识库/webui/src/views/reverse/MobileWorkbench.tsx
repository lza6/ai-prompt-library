import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeft, House, LoaderCircle, RefreshCw, Smartphone, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { MobileStreamDecoder } from "./mobileStream"
import { fitSize, mapClientToDevice } from "./mobileCoords"

type MobileConnection = { projectId: string; serial: string; model: string; connected: boolean }
type Device = MobileDevice
type StreamMode = "connecting" | "scrcpy" | "poll"

// 轮询节拍（mobile-frame-budget，2026-10-28）：原先固定 1400ms 且每帧 ~600ms，
// 实际约 2.0s 一帧（0.5fps）；且 `busy` 会打断轮询 effect，点一下屏幕后要再等
// 一轮 1400ms 才刷新。改成「按本帧耗时补足目标周期」的串行轮询：
//   帧耗时 ~600ms → 下一帧延迟 ~300ms → 约 1.1~1.2fps（screencap 460ms 是硬顶）
// 这是**降级路径**的节拍：scrcpy 流可用时不轮询。
const MOBILE_FRAME_PERIOD_MS = 900
const MOBILE_MIN_FRAME_GAP_MS = 150

export function MobileWorkbench({ pid, active }: { pid: string; active: boolean }) {
  const desktop = window.desktopBrowser
  const [connection, setConnection] = useState<MobileConnection | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [screenshot, setScreenshot] = useState<string>("")
  // 投屏模式：connecting → 试 scrcpy；失败回落 poll（screencap 轮询）。
  const [mode, setMode] = useState<StreamMode>("connecting")
  // busy = 连接生命周期（连接/断开/查询设备）；acting = 触控动作进行中。
  // 拆开的原因：原先一个 busy 同时管两件事，取帧也会把它置真，于是画面刷新期间
  // 所有按钮都是禁用的，连点无效、手感发滞。
  const [busy, setBusy] = useState(false)
  const [acting, setActing] = useState(false)
  const [querying, setQuerying] = useState(false)
  const [error, setError] = useState("")
  const [lastUpdated, setLastUpdated] = useState("")
  const imageRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const decoderRef = useRef<MobileStreamDecoder | null>(null)
  // 流尺寸（scrcpy 的 max_size 按长边缩放，1080×2158 → 544×1080）。坐标换算
  // 必须用它，不能用设备物理分辨率——两者不等，混用会整体偏移。
  // 用 state 而非 ref：它要参与「显示尺寸」的渲染计算（ref 变化不触发重渲染，
  // 画面会停在旧尺寸上直到下一次无关渲染 —— 表现为「第一次连上总是错的比例」）。
  const [streamSize, setStreamSize] = useState<{ width: number; height: number } | null>(null)
  const pointerRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null)
  // 画面适配（mobile-fit，2026-10-28）：容器实际尺寸 + 当前要显示的源尺寸，
  // 用 fitSize 算出「完整可见」的等比像素尺寸。JS 算而不是交给 CSS 的原因见
  // mobileCoords.fitSize 的注释（max-height:100% 在 flex 行容器里解析不出来）。
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  // 源尺寸：scrcpy 用流的 width/height，降级用截图的 naturalWidth/Height。
  // 放进 state 是因为它要参与「显示尺寸」的渲染计算（ref 变化不触发重渲染）。
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null)
  const [shotNatural, setShotNatural] = useState<{ width: number; height: number } | null>(null)
  // 取帧序号：轮询与「动作后刷新」会并发取帧（adb 本身并行不排队），回来的顺序
  // 不保证。只让序号更大的结果落地，避免旧帧覆盖新帧。
  const seqRef = useRef(0)
  const appliedRef = useRef(0)

  const loadScreenshot = useCallback(async () => {
    if (!desktop?.mobileScreenshot) return 0
    const seq = ++seqRef.current
    const startedAt = performance.now()
    try {
      const shot = await desktop.mobileScreenshot(pid)
      if (seq > appliedRef.current) {
        appliedRef.current = seq
        setScreenshot(`data:${shot.mimeType};base64,${shot.data}`)
        setLastUpdated(new Date().toLocaleTimeString())
        setError("")
      }
    } catch (e) {
      if (seq >= appliedRef.current) setError(String(e))
    }
    return performance.now() - startedAt
  }, [desktop, pid])

  const queryDevices = useCallback(async () => {
    if (!desktop?.discoverMobileDevices) return
    setQuerying(true)
    setError("")
    try {
      const result = await desktop.discoverMobileDevices()
      setDevices(result.devices)
      if (!result.devices.length) setError("未发现设备，请检查 USB 连接与 USB 调试授权")
    } catch (e) {
      setError(String(e))
    } finally {
      setQuerying(false)
    }
  }, [desktop])

  useEffect(() => {
    if (!active || !desktop?.mobileStatus) return
    let alive = true
    void (async () => {
      setBusy(true)
      setError("")
      try {
        const current = await desktop.mobileStatus!(pid)
        if (!alive) return
        if (current?.connected) {
          setConnection(current)
          await loadScreenshot()
        } else {
          setConnection(null)
          setScreenshot("")
          await queryDevices()
        }
      } catch (e) {
        if (alive) setError(String(e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    const off = desktop.onMobileDisconnected?.((event) => {
      if (event.projectId !== pid) return
      setConnection(null)
      setScreenshot("")
      setError(`手机已断开：${event.error}`)
    })
    return () => { alive = false; off?.() }
  }, [active, desktop, pid, loadScreenshot, queryDevices])

  // 投屏流生命周期（mobile-stream，2026-10-28）：连接存在且 tab 激活时尝试起
  // scrcpy；起不来（设备 ROM 禁用 app_process / 缺 jar）就回落 screencap 轮询。
  // 只切 tab 不重连：`active` 变 false 时停流，变 true 时重启，连接本身保留。
  useEffect(() => {
    if (!active || !connection || !desktop?.startMobileStream) {
      setMode("poll")
      return
    }
    let alive = true
    setMode("connecting")
    setError("")
    const canvas = canvasRef.current
    if (!canvas) return

    const decoder = new MobileStreamDecoder({
      canvas,
      onFirstFrame: () => {
        if (!alive) return
        setMode("scrcpy")
        setLastUpdated(new Date().toLocaleTimeString())
        setError("")
      },
      onError: (message) => { if (alive) setError(message) },
    })
    decoderRef.current = decoder

    const offConfig = desktop.onMobileStreamConfig?.((event) => {
      if (event.projectId !== pid) return
      decoder.setConfig(event.data)
    })
    const offFrame = desktop.onMobileStreamFrame?.((event) => {
      if (event.projectId !== pid) return
      decoder.pushFrame(event.data, event.key)
    })
    const offError = desktop.onMobileStreamError?.((event) => {
      if (event.projectId !== pid) return
      // 流断了不报错弹窗，静默回落轮询（用户仍能看到画面，只是变慢）。
      setMode("poll")
    })

    void (async () => {
      try {
        const info = await desktop.startMobileStream!(pid)
        if (!alive) return
        setStreamSize({ width: info.width, height: info.height })
        if (canvas.width !== info.width || canvas.height !== info.height) {
          canvas.width = info.width
          canvas.height = info.height
        }
      } catch (e) {
        // 起不来就降级：不打扰用户，画面改由轮询刷新。
        if (alive) setMode("poll")
        console.warn("scrcpy 投屏不可用，回落 screencap 轮询:", e)
      }
    })()

    return () => {
      alive = false
      offConfig?.()
      offFrame?.()
      offError?.()
      decoder.close()
      decoderRef.current = null
      setStreamSize(null)
      void desktop.stopMobileStream?.(pid)
    }
  }, [active, connection, desktop, pid])

  useEffect(() => {
    // 轮询只作降级路径（mobile-frame-budget，2026-10-28）：scrcpy 流可用时不跑，
    // 否则两路同时刷屏会互相抢带宽。依赖里不再放 busy——原先把 busy 放进依赖，
    // 触控一开始 effect 就被卸载、结束后才重启计时器，等于每次点击都要重新等
    // 一轮 1400ms。
    if (!active || !connection || mode !== "poll") return
    let timer: number | undefined
    let alive = true
    const refresh = async () => {
      const cost = await loadScreenshot()
      if (!alive) return
      // 按本帧实际耗时补足目标周期：快就多等、慢就立刻再来，避免固定间隔
      // 与帧耗时叠加成 2 秒一帧。
      const gap = Math.max(MOBILE_MIN_FRAME_GAP_MS, MOBILE_FRAME_PERIOD_MS - cost)
      if (alive) timer = window.setTimeout(refresh, gap)
    }
    timer = window.setTimeout(refresh, MOBILE_MIN_FRAME_GAP_MS)
    return () => { alive = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [active, connection, mode, loadScreenshot])

  const connect = async (device: Device) => {
    if (!desktop?.connectMobileDevice || device.status !== "device") return
    setBusy(true)
    setError("")
    try {
      const result = await desktop.connectMobileDevice(pid, device.serial)
      setConnection(result)
      await loadScreenshot()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (!desktop?.disconnectMobileDevice) return
    setBusy(true)
    try {
      await desktop.disconnectMobileDevice(pid)
      setConnection(null)
      setScreenshot("")
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const sendAction = async (action: MobileAction) => {
    if (!desktop?.mobileAction || busy || acting) return
    setActing(true)
    setError("")
    try {
      await desktop.mobileAction(pid, action)
      // 动作后立刻取一帧，但**不阻塞解锁**：画面由轮询持续刷新，这里只是让
      // 结果更早出现。此前是 await 完才 setBusy(false)，等于点击后按钮要
      // 锁到下一帧回来（~1.1s）才能再点。
      void loadScreenshot()
    } catch (e) {
      setError(String(e))
    } finally {
      setActing(false)
    }
  }

  // 量容器（mobile-fit，2026-10-28）。用 ResizeObserver 而不是 window resize：
  // 侧栏折叠、tab 切换、以及「连上设备后画面区才出现」都不会触发 window resize，
  // 那三种情况正是首帧尺寸算成 0 的典型场景。
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      const rect = stage.getBoundingClientRect()
      setStageSize((prev) => (
        Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
          ? prev   // 尺寸没变就不更新，避免 ResizeObserver 抖动引发无限重渲染
          : { width: rect.width, height: rect.height }
      ))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [connection, active])

  // 源尺寸跟随当前显示的那一路：scrcpy 用流尺寸，降级用截图原始尺寸。
  // 两者不能混（差近 2 倍），切换时也要跟着换，否则点按会整体偏移。
  useEffect(() => {
    setSourceSize(mode === "scrcpy" ? streamSize : shotNatural)
  }, [mode, streamSize, shotNatural])

  const stageStyle = sourceSize ? fitSize(stageSize, sourceSize) : null

  // 屏幕坐标 → 设备像素（mobile-stream，2026-10-28）：元素盒子由 fitSize 定成与
  // 画面完全一致的等比尺寸，所以直接按「源尺寸 / 渲染尺寸」换算即可。
  //
  // 两个源尺寸不能混用：
  //   - scrcpy 流：用协议头里的 width/height（max_size=1080 按**长边**缩放，
  //     1080×2158 实际是 544×1080）。若误用设备物理分辨率，y 会被放大 2 倍。
  //   - 降级截图：用 <img> 的 naturalWidth/naturalHeight。
  // 换算基准必须与**当前显示的那一路**一致，所以按 mode 分叉。
  const pointFromClient = (clientX: number, clientY: number) => {
    const element = mode === "scrcpy" ? canvasRef.current : imageRef.current
    if (!element) return null
    const source = mode === "scrcpy" ? streamSize : shotNatural
    return mapClientToDevice(clientX, clientY, element.getBoundingClientRect(), source)
  }

  // 指针手势（canvas 与 img 共用）：按下记起点，移动超 8px 判滑动，抬起派发。
  // 抽成一份的原因：两路画面必须走**完全相同**的坐标换算与派发逻辑，否则
  // 「流式点得准、降级点偏」这种只在特定路径出现的偏移极难复现。
  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (busy || acting) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const pointer = pointerRef.current
    if (pointer?.id === event.pointerId
      && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8) pointer.moved = true
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const pointer = pointerRef.current
    pointerRef.current = null
    if (!pointer || pointer.id !== event.pointerId) return
    const start = pointFromClient(pointer.x, pointer.y)
    const end = pointFromClient(event.clientX, event.clientY)
    if (!start || !end) return
    if (pointer.moved) void sendAction({ type: "swipe", x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration: 300 })
    else void sendAction({ type: "tap", ...end })
  }

  const handlePointerCancel = () => { pointerRef.current = null }

  if (!desktop?.discoverMobileDevices) {
    return <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
      手机连接需要在桌面客户端中使用
    </div>
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Smartphone className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {connection ? `${connection.model || "Android 手机"} · ${connection.serial}` : "未连接手机"}
        </span>
        {lastUpdated && connection && <span className="text-[10px] text-muted-foreground">更新于 {lastUpdated}</span>}
        <Button variant="outline" size="xs" onClick={() => void queryDevices()} disabled={querying || busy} title="重新查询设备">
          {querying ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          查询设备
        </Button>
        {connection && <>
          <Button variant="ghost" size="icon-xs" onClick={() => void sendAction({ type: "back" })} disabled={busy || acting} title="返回">
            <ArrowLeft />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={() => void sendAction({ type: "home" })} disabled={busy || acting} title="主页">
            <House />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={() => void loadScreenshot()} disabled={busy || acting} title="刷新画面">
            <RefreshCw />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={() => void disconnect()} disabled={busy || acting} title="断开手机">
            <Unplug />
          </Button>
        </>}
      </div>

      {error && <div role="status" className="shrink-0 border-b border-(--status-error)/30 bg-(--status-error)/5 px-3 py-2 text-[11px] text-(--status-error)">{error}</div>}

      {!connection ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <p className="mb-2 text-[11px] text-muted-foreground">可用设备</p>
          {querying && <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在查询 ADB 设备…</div>}
          {!querying && devices.length === 0 && <p className="py-3 text-xs text-muted-foreground">没有待连接的设备</p>}
          <div className="max-w-2xl divide-y rounded border">
            {devices.map((device) => (
              <div key={device.serial} className="flex min-w-0 items-center gap-3 px-3 py-2">
                <Smartphone className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">{device.model || "Android 设备"}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">{device.serial}</div>
                </div>
                <span className={cn("shrink-0 text-[10px]", device.status === "device" ? "text-(--status-ok)" : "text-(--status-warning)")}>
                  {device.status === "device" ? "可用" : device.status === "unauthorized" ? "待授权" : "离线"}
                </span>
                <Button size="xs" variant="outline" onClick={() => void connect(device)} disabled={busy || device.status !== "device"}>
                  连接
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        // 画面区（mobile-fit，2026-10-28）：**不能滚动**，也不许出现滚动条。
        // 原先这里是 `overflow-auto` + 媒体元素 `max-h-full max-w-full`，结果
        // 竖屏流按宽度撑满、高度溢出 → 只能滚轮看，且纵向被放大近 2 倍。
        // 现在改成：外层 overflow-hidden，内层按 fitSize 算出的**精确像素尺寸**
        // 摆放，画面永远完整可见。滚动条一旦出现还会吃掉宽度，形成「越滚越挤」。
        //
        // 量尺寸的容器必须**由父级定高**（h-full），不能靠内容撑开——否则
        // 容器高度跟着画面高度走，「画面比容器高」这件事永远测不出来。
        <div className="relative min-h-0 flex-1 overflow-hidden bg-black/5 p-3">
          <div
            ref={stageRef}
            className="flex h-full w-full items-center justify-center"
          >
            {/* 两路画面叠在同一容器：canvas（scrcpy 流）与 img（降级截图）。
                用 hidden 而不是条件渲染——条件渲染会丢掉 canvas 的已解码内容，
                切回来要重新等首帧。
                尺寸显式写成 style 的 px（不是 max-*）：见 mobileCoords.fitSize。 */}
            <canvas
              ref={canvasRef}
              aria-label="已连接 Android 手机的实时画面"
              className={cn(
                "select-none shadow",
                mode === "scrcpy" ? "block" : "hidden",
              )}
              style={{
                touchAction: "none",
                width: stageStyle?.width ?? 0,
                height: stageStyle?.height ?? 0,
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
            />
            {mode !== "scrcpy" && (screenshot ? (
              <img
                ref={imageRef}
                src={screenshot}
                alt="已连接 Android 手机的实时画面"
                draggable={false}
                className="select-none shadow"
                style={{
                  touchAction: "none",
                  width: stageStyle?.width ?? 0,
                  height: stageStyle?.height ?? 0,
                }}
                onLoad={(event) => {
                  // 截图原始尺寸只有 onLoad 之后才准（src 变化时 naturalWidth 是旧值）。
                  const image = event.currentTarget
                  if (image.naturalWidth && image.naturalHeight) {
                    setShotNatural({ width: image.naturalWidth, height: image.naturalHeight })
                  }
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
              />
            ) : (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                {mode === "connecting" ? "正在启动实时投屏…" : "正在读取手机画面…"}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
