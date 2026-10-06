import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'

/** 启动页展示时长（含淡出前停留）：3 秒 */
const SPLASH_MIN_MS = 3000

/**
 * 移除启动页（index.html 内联的 #splash）。
 * 挂载完成前 splash 一直盖在最上层；挂载后先补足最小展示时长，
 * 再加 .hide 淡出，过渡结束后从 DOM 移除。
 */
function dismissSplash(): void {
  const el = document.getElementById('splash')
  if (!el) return
  const waited = performance.now()
  const remain = Math.max(0, SPLASH_MIN_MS - waited)
  window.setTimeout(() => {
    el.classList.add('hide')
    el.addEventListener('transitionend', () => el.remove(), { once: true })
    // 兜底：transitionend 可能因 reduced-motion 等原因不触发
    window.setTimeout(() => el.remove(), 600)
  }, remain)
}

// 打包后禁止选中页面内容（开发模式不加此类，保留可选中以便复制错误提示排查）。
// 具体规则见 main.css 的 html.no-copy。
if (!import.meta.env.DEV) document.documentElement.classList.add('no-copy')

createApp(App).mount('#app')
dismissSplash()
