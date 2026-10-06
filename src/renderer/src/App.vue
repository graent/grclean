<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import Sidebar from './components/Sidebar.vue'
import WindowControls from './components/WindowControls.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import Home from './views/Home.vue'
import Clean from './views/Clean.vue'
import BigFiles from './views/BigFiles.vue'
import Startup from './views/Startup.vue'
import Uninstall from './views/Uninstall.vue'
import Duplicates from './views/Duplicates.vue'
import Registry from './views/Registry.vue'
import Rules from './views/Rules.vue'
import Schedule from './views/Schedule.vue'
import Settings from './views/Settings.vue'
import Score from './views/Score.vue'
import Social from './views/Social.vue'
import Disk from './views/Disk.vue'
import Installers from './views/Installers.vue'
import Logs from './views/Logs.vue'
import Slim from './views/Slim.vue'
import ContextMenu from './views/ContextMenu.vue'
import Drivers from './views/Drivers.vue'
import Migrate from './views/Migrate.vue'
import Optimize from './views/Optimize.vue'
import Treemap from './views/Treemap.vue'
import Snapshot from './views/Snapshot.vue'
import Restore from './views/Restore.vue'
import Donate from './views/Donate.vue'
import Feedback from './views/Feedback.vue'
import { applyTheme } from './stores/settings'
import { initI18n } from './stores/i18n'
import { initHealth } from './stores/health'
import { assertApiKeys } from './api/electron'

type ViewKey =
  | 'home'
  | 'score'
  | 'clean'
  | 'social'
  | 'disk'
  | 'big'
  | 'startup'
  | 'uninstall'
  | 'duplicates'
  | 'registry'
  | 'installers'
  | 'logs'
  | 'slim'
  | 'contextmenu'
  | 'drivers'
  | 'migrate'
  | 'optimize'
  | 'treemap'
  | 'snapshot'
  | 'restore'
  | 'rules'
  | 'schedule'
  | 'settings'
  | 'donate'
  | 'feedback'
const views: Record<ViewKey, any> = {
  home: Home,
  score: Score,
  clean: Clean,
  social: Social,
  disk: Disk,
  big: BigFiles,
  startup: Startup,
  uninstall: Uninstall,
  duplicates: Duplicates,
  registry: Registry,
  installers: Installers,
  logs: Logs,
  slim: Slim,
  contextmenu: ContextMenu,
  drivers: Drivers,
  migrate: Migrate,
  optimize: Optimize,
  treemap: Treemap,
  snapshot: Snapshot,
  restore: Restore,
  rules: Rules,
  schedule: Schedule,
  settings: Settings,
  donate: Donate,
  feedback: Feedback,
}
const current = ref<ViewKey>('home')

/**
 * 页面切换遮罩：
 * 结果较多的页面（KeepAlive 切回也要重建上千行 DOM）在「旧页淡出 → 新页挂载」
 * 之间会短暂白屏，且挂载重活会阻塞主线程让画面停住。导航时先显示遮罩并
 * 等它真正绘制出来（双 rAF + 任务队列），再执行切换，把白屏换成 loading。
 */
const switching = ref(false)
let switchGen = 0

/** 等待遮罩被实际绘制：rAF 两帧 + 一个宏任务 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.setTimeout(resolve, 0))
    })
  })
}

/** 所有导航统一走这里：先遮罩、再切页，新页首帧绘制完成后撤遮罩 */
async function navigateTo(v: string) {
  const key = v as ViewKey
  if (key === current.value) return
  const gen = ++switchGen
  switching.value = true
  // 1) 等遮罩真正绘制出来，再切页（否则切页的同步渲染会把遮罩一起挡住）
  await nextPaint()
  if (gen !== switchGen) return
  current.value = key
  // 兜底：新页挂载异常 / 极慢时也要收起遮罩，不能一直盖着
  window.setTimeout(() => {
    if (gen === switchGen) switching.value = false
  }, 1500)
  // 2) 等新页 DOM 挂载（nextTick）并完成首帧绘制（双 rAF），再撤遮罩
  await nextTick()
  await nextPaint()
  if (gen === switchGen) switching.value = false
}

onMounted(() => {
  applyTheme()
  // 语言包（JSON 文件）异步读取；失败时 t() 回退到 key，界面仍可用
  void initI18n()
  // 恢复最近一次体检报告（有历史则概览/评分页直接显示上次结果 +「重新体检」）
  initHealth()
  // 开发期自检：preload 漏更新时立刻在控制台报警（preload 不随 HMR 更新）
  if (import.meta.env.DEV) assertApiKeys()

  // 滚动条「滚动时才显示」：捕获阶段监听所有滚动，给滚动元素临时加 .is-scrolling，
  // 停止滚动 900ms 后移除（CSS 里默认滑块透明，只有 .is-scrolling 才显示）。
  let scrollTimer = 0
  const scrollingEls = new Set<Element>()
  document.addEventListener(
    'scroll',
    (e) => {
      const el = e.target
      if (!(el instanceof Element)) return
      el.classList.add('is-scrolling')
      scrollingEls.add(el)
      window.clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => {
        scrollingEls.forEach((x) => x.classList.remove('is-scrolling'))
        scrollingEls.clear()
      }, 900)
    },
    { capture: true, passive: true },
  )
})
</script>

<template>
  <div class="app">
    <Sidebar :current="current" @navigate="navigateTo" />
    <main class="content" :class="{ 'home-view': current === 'home' }">
      <!-- KeepAlive：切走再切回时保留页面状态（扫描结果 / 勾选 / 分页等），
           直到「处理过」或重启应用才清空，避免重复扫描。
           页面切换不再做淡入淡出，改由 .view-loading 遮罩接管过渡
           （结果多的页重建 DOM 会让动画卡顿，遮罩更稳）。 -->
      <KeepAlive>
        <component :is="views[current]" @navigate="(v: string) => navigateTo(v)" />
      </KeepAlive>
    </main>
    <!-- 页面切换遮罩：盖住内容区（避开侧栏），loading 状态提示 -->
    <div v-if="switching" class="view-loading" aria-hidden="true">
      <span class="spinner"></span>
      <span class="view-loading-text">加载中…</span>
    </div>
    <div class="drag-strip"></div>
    <WindowControls @navigate="navigateTo" />
    <!-- 检查更新弹窗：顶层单例，右上角下拉与「关于」页共用同一个 -->
    <UpdateDialog />
  </div>
</template>

<style>
/* 页面切换的淡入淡出已移除：结果多的页重建 DOM 会让动画掉帧，
   过渡改由 .view-loading 遮罩（见 main.css）承担。 */
</style>
