import { reactive } from 'vue'
import { healthScan, type HealthReport } from '../api/electron'
import { recordScan } from './history'

interface HealthState {
  report: HealthReport | null
  loading: boolean
  error: string | null
}

export const health = reactive<HealthState>({
  report: null,
  loading: false,
  error: null,
})

const STORE_KEY = 'grclean.healthReport'

/**
 * 启动时恢复最近一次体检报告（localStorage 持久化）。
 * 概览页 / 健康评分页因此「查过就显示上次结果 + 重新体检」，重启应用也生效。
 */
export function initHealth(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as HealthReport
    // 简单结构校验，防止旧版本数据形状不符
    if (parsed && typeof parsed.score === 'number' && Array.isArray(parsed.factors)) {
      health.report = parsed
    }
  } catch {
    /* 数据损坏则忽略，回到「从未体检」 */
  }
}

/** 执行一次一键体检（编排各扫描 + 评分）。结果存入共享 store，Home/Score 共用。 */
export async function runHealth(): Promise<void> {
  health.loading = true
  health.error = null
  try {
    health.report = await healthScan()
    // 持久化完整报告，重启后仍可展示上次结果
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(health.report))
    } catch {
      /* 存储失败不影响本次结果展示 */
    }
    // 体检也是一种「检查」：记录时间与结果，供各处「上次体检」展示
    void recordScan('health', `${health.report.score} 分 · ${health.report.level}`)
  } catch (e) {
    health.error = String(e instanceof Error ? e.message : e)
  } finally {
    health.loading = false
  }
}
