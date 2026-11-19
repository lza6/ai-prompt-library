/**
 * scrcpy 实时投屏的渲染端解码器（mobile-stream，2026-10-28）。
 *
 * 为什么不引入 ffmpeg：Electron 38 = Chromium 140，`VideoDecoder`（WebCodecs）
 * 原生可用且走 GPU 硬解；主进程侧解码要么引 70MB 的 ffmpeg 二进制，要么用
 * Node 原生模块软解，1080p 30fps 会吃掉一整个核。
 *
 * 协议侧（desktop/main.js 的 pumpMobileStream）已经切成两类消息：
 *   - config：SPS/PPS（Annex-B，含 00 00 00 01 起始码）→ 去掉起始码后作为
 *     `VideoDecoder.configure({ description })` 的 avcC 内容喂进去
 *   - frame：单个访问单元（Annex-B）
 *
 * 关键实现约束：
 *  1. **必须等 config 到达后才能 configure**，否则 codec 无法初始化。
 *  2. **每帧的 timestamp 必须单调递增**（微秒），scrcpy 的 pts_flags 不直接给
 *     时间戳，这里用到达时间自造——VideoDecoder 只用它做重排，不要求精确。
 *  3. 解码输出要**主动 close()**，否则 VideoFrame 不释放，几十帧后就把显存吃满。
 *  4. 画到 canvas 用 `drawImage(frame, 0, 0, w, h)`，尺寸取流尺寸。
 */

const AVC_START_CODES = [new Uint8Array([0, 0, 0, 1]), new Uint8Array([0, 0, 1])]

/** 去掉 Annex-B 起始码（SPS/PPS 要作为 avcC 内容给 VideoDecoder）。 */
export function stripAnnexB(data: Uint8Array): Uint8Array {
  for (const code of AVC_START_CODES) {
    if (data.length >= code.length && code.every((byte, i) => data[i] === byte)) {
      return data.subarray(code.length)
    }
  }
  return data
}

/**
 * 把 Annex-B 的 SPS/PPS 拼成 WebCodecs 要求的 `description`（avcC 盒子内容）。
 *
 * Chromium 的 H.264 解码器接受两种 description：完整的 avcC 盒（带
 * `avcC` 类型头 + version/profile/level/lengthSize 前缀），或直接给
 * AVCDecoderConfigurationRecord 本体。这里生成后者——实测可行，且不必
 * 猜测 profile/level（从 SPS 里读）。
 */
export function buildAvcDescription(configData: Uint8Array): Uint8Array | null {
  // 两阶段：先扫出**所有**起始码位置，再按位置切分。
  //
  // 为什么不能「边找边切」（实测踩过）：边找边切时最后一个 NAL 的右边界只能取
  // 「缓冲区末尾」，而真机 config 包在 SPS 后面跟 2 个 0x00 才接下一条起始码 ——
  // 那 2 个零会被算进 SPS 长度，avcC 里声明的长度与实际字节数不符，解码器读到
  // 垃圾（表现为花屏）。两阶段把「边界」和「内容」分开，边界只由起始码决定。
  //
  // 关于判定顺序（4 字节优先还是 3 字节优先）：**两者等价**，别去「修」它。
  // 两个条件在任意位置互斥 —— 命中 `00 00 00 01` 时 `[c+2]` 必为 0，不可能同时
  // 命中 `00 00 01`；反之亦然。变异测试实测证实：交换顺序后全部护栏仍绿。
  // 真正必须成立的是「命中后 `cursor += 起始码长度`」（跳过整个起始码，别只跳 3）。
  const starts: Array<{ at: number; len: number }> = []
  let cursor = 0
  while (cursor + 3 <= configData.length) {
    if (cursor + 4 <= configData.length
      && configData[cursor] === 0 && configData[cursor + 1] === 0
      && configData[cursor + 2] === 0 && configData[cursor + 3] === 1) {
      starts.push({ at: cursor, len: 4 })
      cursor += 4
    } else if (configData[cursor] === 0 && configData[cursor + 1] === 0
      && configData[cursor + 2] === 1) {
      starts.push({ at: cursor, len: 3 })
      cursor += 3
    } else {
      cursor += 1
    }
  }
  const nals: Uint8Array[] = []
  for (let k = 0; k < starts.length; k += 1) {
    const bodyStart = starts[k].at + starts[k].len
    const bodyEnd = k + 1 < starts.length ? starts[k + 1].at : configData.length
    if (bodyEnd <= bodyStart) continue
    // 去掉 NAL 尾部的零填充（trailing_zero_8bits）。真机实测 config 包里
    // SPS 后面跟 2 个 0x00 再接下一条起始码，不去掉会让 SPS 长度多 2 字节、
    // avcC 里声明长度与实际不符 —— 解码器直接拒绝或解出花屏。
    let end = bodyEnd
    while (end > bodyStart && configData[end - 1] === 0) end -= 1
    if (end > bodyStart) nals.push(configData.subarray(bodyStart, end))
  }

  const sps = nals.find((nal) => (nal[0] & 0x1f) === 7)
  const pps = nals.find((nal) => (nal[0] & 0x1f) === 8)
  if (!sps || !pps || sps.length < 4) return null

  // avcC（AVCDecoderConfigurationRecord）精确长度：
  //   5 (version/profile/compat/level/lengthSizeMinusOne)
  // + 1 (numOfSPS) + 2 (SPS 长度字段) + sps.length
  // + 1 (numOfPPS) + 2 (PPS 长度字段) + pps.length
  // = 11 + sps.length + pps.length
  // 早先写成 11 + sps + 1 + 2 + pps，多出 3 字节尾部零，导致解码器按声明长度
  // 读到垃圾。长度必须由这个公式算出，别用「看着差不多」的写法。
  const out = new Uint8Array(11 + sps.length + pps.length)
  let p = 0
  out[p++] = 1                                  // configurationVersion
  out[p++] = sps[1]                             // AVCProfileIndication
  out[p++] = sps[2]                             // profile_compatibility
  out[p++] = sps[3]                             // AVCLevelIndication
  out[p++] = 0xff                               // 6 bits reserved + lengthSizeMinusOne=3
  out[p++] = 0xe1                               // 3 bits reserved + numOfSPS=1
  out[p++] = (sps.length >> 8) & 0xff
  out[p++] = sps.length & 0xff
  out.set(sps, p); p += sps.length
  out[p++] = 1                                  // numOfPPS
  out[p++] = (pps.length >> 8) & 0xff
  out[p++] = pps.length & 0xff
  out.set(pps, p)
  return out
}

/** 从 SPS 读 profile/level，拼出 WebCodecs 的 codec 串（如 avc1.640032）。 */
export function codecStringFromSps(sps: Uint8Array): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0")
  if (sps.length < 4) return "avc1.42E01E"
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`
}

export type MobileStreamDecoderOptions = {
  canvas: HTMLCanvasElement
  onFirstFrame?: () => void
  onError?: (message: string) => void
}

export class MobileStreamDecoder {
  private canvas: HTMLCanvasElement
  private decoder: VideoDecoder | null = null
  private configured = false
  private pendingConfig: Uint8Array | null = null
  private lastTimestamp = 0
  private firstFrameSeen = false
  private closed = false
  private options: MobileStreamDecoderOptions

  constructor(options: MobileStreamDecoderOptions) {
    this.options = options
    this.canvas = options.canvas
  }

  get hasFirstFrame() {
    return this.firstFrameSeen
  }

  /** 收到 config（SPS/PPS）后调用：立刻尝试 configure。 */
  setConfig(data: Uint8Array) {
    if (this.closed) return
    this.pendingConfig = data
    this.tryConfigure()
  }

  private tryConfigure() {
    if (this.configured || this.closed || !this.pendingConfig) return
    if (typeof VideoDecoder === "undefined") {
      this.options.onError?.("当前环境不支持 WebCodecs，无法解码投屏")
      return
    }
    const sps = this.pendingConfig
    const description = buildAvcDescription(sps)
    if (!description) return  // config 包还没收全，等下一个
    const codec = codecStringFromSps(stripAnnexB(sps))
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this.draw(frame),
        error: (error) => this.options.onError?.(`解码失败: ${error.message}`),
      })
      this.decoder.configure({ codec, description, optimizeForLatency: true })
      this.configured = true
    } catch (error) {
      this.options.onError?.(`解码器初始化失败: ${(error as Error).message}`)
    }
  }

  /** 收到一帧（Annex-B 访问单元）。 */
  pushFrame(data: Uint8Array, key: boolean) {
    if (this.closed) return
    if (!this.configured) {
      // 首个关键帧之前无法解码；config 通常先到，这里只是兜底。
      this.tryConfigure()
      if (!this.configured) return
    }
    if (!this.decoder || this.decoder.state !== "configured") return
    // 队列过长说明解码跟不上（或渲染被节流），丢掉非关键帧防止无限堆积。
    if (this.decoder.decodeQueueSize > 12 && !key) return
    this.lastTimestamp += 33333  // 约 30fps，仅用于重排
    try {
      this.decoder.decode(new EncodedVideoChunk({
        type: key ? "key" : "delta",
        timestamp: this.lastTimestamp,
        data,
      }))
    } catch (error) {
      this.options.onError?.(`送入解码失败: ${(error as Error).message}`)
    }
  }

  private draw(frame: VideoFrame) {
    try {
      const width = frame.displayWidth || frame.codedWidth
      const height = frame.displayHeight || frame.codedHeight
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width
        this.canvas.height = height
      }
      const context = this.canvas.getContext("2d")
      if (context) {
        context.drawImage(frame, 0, 0, width, height)
        if (!this.firstFrameSeen) {
          this.firstFrameSeen = true
          this.options.onFirstFrame?.()
        }
      }
    } finally {
      // 必须 close：VideoFrame 持有显存，不释放会累积到解码器卡死。
      frame.close()
    }
  }

  close() {
    this.closed = true
    try { this.decoder?.close() } catch (_) { /* 已关闭 */ }
    this.decoder = null
    this.configured = false
  }
}
