import { reactive } from 'vue'
import { checkUpdate, type UpdateInfo } from '../api/electron'

/**
 * 检查更新的全局状态。
 *
 * 原先这段逻辑写死在 WindowControls.vue 里，弹窗也挂在那儿，"关于"页里的
 * 「检查更新」按钮就没法复用同一个弹窗（中间隔着 SettingsDialog，emit 要传两级）。
 * 抽成 store 后：**任何地方**只要调 `checkForUpdates()` 即可，`UpdateDialog`
 * 统一挂在 App.vue 顶层负责展示，两处入口看到的是完全相同的弹窗。
 */
export const update = reactive({
  /** 正在请求 Update */
  checking: false,
  /** 最近一次检查结果（初次为 null） */
  info: null as UpdateInfo | null,
  /** 当前显示的弹窗：none / found（有新版）/ latest（已是最新） */
  dialog: 'none' as 'none' | 'found' | 'latest',
})

/** 拉取远程版本信息，并按结果弹出对应对话框。 */
export async function checkForUpdates(): Promise<void> {
  if (update.checking) return
  update.checking = true
  try {
    const info = await checkUpdate()
    update.info = info
    update.dialog = info.hasUpdate ? 'found' : 'latest'
  } catch {
    // 静默失败：checkUpdate 本身带本地示例回退，这里只是兜底
  } finally {
    update.checking = false
  }
}

/** 关闭弹窗（两个 Modal 都用它）。 */
export function closeUpdateDialog(): void {
  update.dialog = 'none'
}
