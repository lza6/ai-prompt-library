// Dragged folder -> a bounded flat list of real files.

export const MAX_DROPPED_FILES = 500
const MAX_VISITED_ENTRIES = 5000
const MAX_DIRECTORY_DEPTH = 12
const MAX_SCAN_MS = 30_000

/** Read DataTransfer items synchronously before the browser invalidates the drop event. */
export async function collectDroppedFiles(
  dt: DataTransfer,
  opts?: { onProgress?: (found: number) => void },
): Promise<{ files: File[]; skipped: string[]; overflow: number }> {
  const files: File[] = []
  const skipped: string[] = []
  let overflow = 0
  let visited = 0
  let limitReported = false
  const deadline = Date.now() + MAX_SCAN_MS
  const items = Array.from(dt.items ?? [])
  const entries: FileSystemEntry[] = []
  const plainFiles: File[] = []

  // Capture all entries/files before the first await; DataTransferItemList is event-scoped.
  for (const item of items) {
    if (item.kind !== "file") continue
    const entry = item.webkitGetAsEntry()
    const file = item.getAsFile()
    if (entry) entries.push(entry)
    else if (file) plainFiles.push(file)
  }

  // Some browsers expose files but no DataTransfer.items. Keep ordinary file drops working.
  if (!items.length) plainFiles.push(...Array.from(dt.files ?? []))
  if (!entries.length && !plainFiles.length) plainFiles.push(...Array.from(dt.files ?? []))

  const reportLimit = () => {
    if (limitReported) return
    limitReported = true
    skipped.push("目录过大或扫描超时，后续条目未读取")
  }
  const walk = async (entry: FileSystemEntry, prefix: string, depth: number): Promise<void> => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (Date.now() >= deadline || visited >= MAX_VISITED_ENTRIES) {
      reportLimit()
      return
    }
    visited += 1
    if (depth > MAX_DIRECTORY_DEPTH) {
      skipped.push(`${path}（目录层级过深）`)
      return
    }
    if (entry.isFile) {
      if (files.length >= MAX_DROPPED_FILES) {
        overflow += 1
        return
      }
      const fileEntry = entry as FileSystemFileEntry
      const file = await new Promise<File | null>((resolve) => {
        let settled = false
        const finish = (value: File | null) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
        const timer = setTimeout(
          () => finish(null), Math.max(1, Math.min(5000, deadline - Date.now())),
        )
        fileEntry.file((value) => finish(value), () => finish(null))
      })
      if (file) {
        files.push(file)
        opts?.onProgress?.(files.length)
      } else {
        skipped.push(`${path}（读取失败或超时）`)
      }
      return
    }
    if (!entry.isDirectory) {
      skipped.push(`${path}（不支持的文件类型）`)
      return
    }

    const directoryEntry = entry as FileSystemDirectoryEntry
    const reader = directoryEntry.createReader()
    for (;;) {
      if (Date.now() >= deadline) {
        reportLimit()
        return
      }
      const result = await new Promise<{ batch: FileSystemEntry[]; failed: boolean }>((resolve) => {
        let settled = false
        const finish = (batch: FileSystemEntry[], failed: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ batch, failed })
        }
        const timer = setTimeout(
          () => finish([], true), Math.max(1, Math.min(10_000, deadline - Date.now())),
        )
        reader.readEntries((batch) => finish(batch ?? [], false), () => finish([], true))
      })
      if (result.failed) {
        skipped.push(`${path}（读取目录失败或超时）`)
        return
      }
      if (!result.batch.length) return
      for (let i = 0; i < result.batch.length; i += 1) {
        await walk(result.batch[i], path, depth + 1)
        if (Date.now() >= deadline || visited >= MAX_VISITED_ENTRIES) {
          reportLimit()
          return
        }
      }
    }
  }

  for (const entry of entries) {
    if (files.length >= MAX_DROPPED_FILES) {
      overflow += 1
      continue
    }
    await walk(entry, "", 0)
    if (Date.now() >= deadline || visited >= MAX_VISITED_ENTRIES) {
      reportLimit()
      break
    }
  }
  for (const file of plainFiles) {
    if (files.length >= MAX_DROPPED_FILES) {
      overflow += 1
      continue
    }
    files.push(file)
    opts?.onProgress?.(files.length)
  }
  return { files, skipped, overflow }
}
