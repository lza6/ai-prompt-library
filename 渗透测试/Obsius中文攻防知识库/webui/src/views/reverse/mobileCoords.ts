/**
 * 手机画面坐标换算（mobile-coords，2026-10-28）。
 *
 * 抽成纯函数的原因：这段算术只在**点偏了**的时候才暴露，而从「点偏」倒推不出
 * 是漏乘了缩放、还是取错了源尺寸。两个源尺寸必须分清楚：
 *   - scrcpy 流：用协议头的 width/height（max_size 按**长边**缩放，
 *     1080×2158 → **544×1080**）。误用设备物理分辨率，y 会被放大到 2 倍。
 *   - 降级截图：用 <img> 的 naturalWidth/naturalHeight。
 * 两种模式走同一份算术，只有源尺寸不同 —— 否则「流式点得准、降级点偏」这种
 * 只在一条路径出现的偏移极难复现。
 */

export type MobileSize = { width: number; height: number }
export type MobileRect = { left: number; top: number; width: number; height: number }

/**
 * 算出「画面完整可见」的等比显示尺寸（mobile-fit，2026-10-28）。
 *
 * 为什么必须自己算，不能交给 CSS：手机流是 **544×1080 的竖屏**，而工作台视口是
 * 横向宽幅。原本给媒体元素只写 `max-h-full max-w-full` + `object-contain`，但
 * `max-height: 100%` 在 flex 行容器里**解析不出来**（父高不确定），`object-contain`
 * 对 canvas（替换元素）也时灵时不灵 —— 结果元素按固有宽度铺开：宽撑满、高溢出，
 * 只能滚轮看，且纵向被放大近 2 倍。
 *
 * 三个必须成立的性质：
 *   1. **等比**：任何一边都不许单独缩放（否则点按位置全偏）。
 *   2. **完整可见**：宽高都 ≤ 容器，即 `scale = min(容器宽/源宽, 容器高/源高)`。
 *   3. **向下取整**：宁可少 1px 也不许超 1px —— 超出去就会长出一条滚动条，
 *      而滚动条本身又占宽度，形成「越滚越挤」。
 *
 * 返回 null 表示还没法算（容器或源尺寸未知），调用方应先不渲染/不接手势。
 */
export function fitSize(container: MobileSize, source: MobileSize): MobileSize | null {
  if (!container.width || !container.height) return null
  if (!source.width || !source.height) return null
  // min 是关键：竖屏流放进宽容器时**按高度贴合**，不是按宽度撑满。
  const scale = Math.min(container.width / source.width, container.height / source.height)
  return {
    width: Math.max(1, Math.floor(source.width * scale)),
    height: Math.max(1, Math.floor(source.height * scale)),
  }
}

/**
 * 视口坐标（clientX/clientY）→ 设备像素。
 *
 * 元素盒子由 `fitSize` 定成与画面**完全一致**的等比尺寸，所以这里不需要补偿
 * letterbox 留白：直接按「源尺寸 / 渲染尺寸」换算即可。返回 null 表示这一帧还
 * 不能点（元素没有尺寸、源尺寸未知），调用方应直接忽略本次手势而不是退回
 * (0,0)——点左上角比不点更糟。
 */
export function mapClientToDevice(
  clientX: number,
  clientY: number,
  rect: MobileRect,
  source: MobileSize | null,
): { x: number; y: number } | null {
  if (!source) return null
  if (!rect.width || !rect.height) return null
  if (!source.width || !source.height) return null
  // 夹到 [0, 源-1]：右/下边缘浮点误差会算出正好等于宽度的值，adb tap 到设备外
  // 会被系统忽略（表现为「点最右边没反应」）。
  const x = Math.max(0, Math.min(source.width - 1,
    Math.round((clientX - rect.left) * source.width / rect.width)))
  const y = Math.max(0, Math.min(source.height - 1,
    Math.round((clientY - rect.top) * source.height / rect.height)))
  return { x, y }
}
