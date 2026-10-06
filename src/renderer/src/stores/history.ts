import { reactive } from 'vue'
import { getScanHistory, recordScanHistory, type ScanRecord } from '../api/electron'

/**
 * 扫描记录（上次扫描时间 + 结果摘要），按模块 key 缓存。
 *
 * 主流程：视图 onMounted 调 `loadScan(module)` 拉取展示；
 * 扫描完成后调 `recordScan(module, summary)` 落盘并刷新缓存，
 * 实现「再次体检则更新上次扫描记录」。
 */

/** 模块 key → 最近一次扫描记录。 */
export const scanHistory = reactive<Record<string, ScanRecord>>({})

/** 拉取并缓存某模块的最近一次扫描记录。 */
export async function loadScan(module: string): Promise<void> {
  try {
    const r = await getScanHistory(module)
    if (r) scanHistory[module] = r
  } catch {
    /* ignore */
  }
}

/** 落盘记录并刷新缓存。 */
export async function recordScan(module: string, summary: string): Promise<void> {
  try {
    const r = await recordScanHistory(module, summary)
    scanHistory[module] = r
  } catch {
    /* ignore */
  }
}
