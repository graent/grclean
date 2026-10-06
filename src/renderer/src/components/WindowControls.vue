<script setup lang="ts">
// 主窗体固定尺寸工具窗口：不支持最大化（maximizable: false），仅最小化 / 关闭
// 最小化左侧为下拉入口：设置（弹出左菜单对话框，内含意见反馈 / 捐赠 / 关于）→（分隔）→ 检查更新（动作）
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  Settings,
  Gift,
  MessageSquareHeart,
  Info,
  RefreshCw,
  Pin,
  PinOff,
} from '@lucide/vue'
import { t } from '../stores/i18n'
import SettingsDialog from './SettingsDialog.vue'
import { update, checkForUpdates } from '../stores/update'

defineEmits<{ (e: 'navigate', v: string): void }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

// 下拉项：意见反馈 → 捐赠 → 设置 → （分隔）→ 检查更新（动作）→ （分隔）→ 关于
const menuItems = [
  { key: 'feedback', icon: MessageSquareHeart, labelKey: 'nav.feedback' },
  { key: 'donate', icon: Gift, labelKey: 'nav.donate' },
  { key: 'settings', icon: Settings, labelKey: 'nav.settings' },
]
const updateItem = { key: 'update', icon: RefreshCw, labelKey: 'nav.update' }
const aboutItem = { key: 'about', icon: Info, labelKey: 'settings.about' }

// 设置对话框（左右结构：左菜单 / 右内容）；反馈 / 捐赠 / 关于都是打开它并定位到对应菜单
const showSettings = ref(false)
/** 打开时定位的左侧菜单项：settings 表示回到默认（外观） */
const settingsSection = ref('')

function go(key: string) {
  open.value = false
  if (key === 'update') {
    void checkForUpdates()
    return
  }
  settingsSection.value = key === 'settings' ? 'general' : key
  showSettings.value = true
}

function onDocClick(e: MouseEvent) {
  if (!open.value) return
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onKey)
  // 同步一次真实置顶状态（避免图标与窗口实际状态不一致）
  void window.api.windowControls
    .isAlwaysOnTop()
    .then((v) => (alwaysOnTop.value = v))
    .catch(() => {})
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKey)
})

function minimize() {
  window.api.windowControls.minimize()
}
function close() {
  window.api.windowControls.close()
}

// ---------------- 窗口置顶 ----------------
const alwaysOnTop = ref(false)

async function toggleAlwaysOnTop() {
  try {
    alwaysOnTop.value = await window.api.windowControls.toggleAlwaysOnTop()
  } catch {
    // 静默失败：保持原状态
  }
}

// ---------------- 检查更新 ----------------
// 逻辑在 stores/update.ts，弹窗由 App.vue 顶层的 UpdateDialog 统一展示
// （"关于"页里的检查更新按钮走同一套，两处看到的是同一个弹窗）
const checking = computed(() => update.checking)
</script>

<template>
  <div ref="root" class="win-controls">
    <button
      class="wc"
      :class="{ 'wc-on': alwaysOnTop }"
      :title="alwaysOnTop ? '取消置顶' : '窗口置顶'"
      :aria-label="alwaysOnTop ? '取消置顶' : '窗口置顶'"
      :aria-pressed="alwaysOnTop"
      @click="toggleAlwaysOnTop"
    >
      <component :is="alwaysOnTop ? PinOff : Pin" :size="16" />
    </button>
    <div class="menu-anchor">
      <button
        class="wc"
        :class="{ active: open }"
        :title="t('nav.settings')"
        :aria-label="t('nav.settings')"
        @click="open = !open"
      >
        <Settings :size="16" />
      </button>
      <div v-if="open" class="menu" role="menu">
        <button
          v-for="it in menuItems"
          :key="it.key"
          class="menu-item"
          role="menuitem"
          @click="go(it.key)"
        >
          <span class="mi-ico"><component :is="it.icon" :size="15" /></span>
          {{ t(it.labelKey) }}
        </button>

        <div class="menu-sep"></div>

        <button
          class="menu-item"
          role="menuitem"
          :disabled="checking"
          @click="go(updateItem.key)"
        >
          <span class="mi-ico"><component :is="updateItem.icon" :size="15" /></span>
          {{ checking ? t('update.checking') : t(updateItem.labelKey) }}
        </button>

        <button class="menu-item" role="menuitem" @click="go(aboutItem.key)">
          <span class="mi-ico"><component :is="aboutItem.icon" :size="15" /></span>
          {{ t(aboutItem.labelKey) }}
        </button>
      </div>
    </div>
    <button class="wc" title="最小化" aria-label="最小化" @click="minimize">
      <svg viewBox="0 0 12 12" width="12" height="12">
        <rect x="2" y="5.5" width="8" height="1.2" rx="0.6" fill="currentColor" />
      </svg>
    </button>
    <button class="wc wc-close" title="关闭" aria-label="关闭" @click="close">
      <svg viewBox="0 0 12 12" width="12" height="12">
        <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </button>

    <!-- 设置对话框（左菜单 / 右内容）：下拉里的反馈 / 捐赠 / 设置 / 关于都打开它并定位到对应菜单 -->
    <SettingsDialog v-model:open="showSettings" :section="settingsSection" />
  </div>
</template>

<style scoped>
.win-controls {
  position: fixed;
  top: 0;
  right: 0;
  display: flex;
  z-index: 200;
  -webkit-app-region: no-drag;
}

.wc {
  width: 44px;
  height: 34px;
  border: none;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.wc:hover,
.wc.active {
  background: var(--primary-weak);
}

/* 置顶开启态：主色底 + 白字，与 hover 的浅底明确区分 */
.wc.wc-on {
  background: var(--primary);
  color: #fff;
}
.wc.wc-on:hover {
  background: var(--primary);
  filter: brightness(1.08);
}

.wc-close:hover {
  background: var(--danger);
  color: #fff;
}

/* 下拉菜单：右对齐挂在齿轮按钮下方 */
.menu-anchor {
  position: relative;
  display: flex;
}
.menu {
  position: absolute;
  top: 38px;
  right: 4px;
  min-width: 160px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.12), var(--shadow);
  animation: menu-in 0.14s ease;
  transform-origin: top right;
}
@keyframes menu-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text);
  text-align: left;
  padding: 9px 11px;
  min-height: 36px;
  border-radius: 7px;
  font-size: calc(13px * var(--fs-scale));
  cursor: pointer;
  transition: background 0.12s;
}
.menu-item:hover:not(:disabled) {
  background: var(--primary-weak);
}
.menu-item:disabled {
  opacity: 0.55;
  cursor: default;
}
.menu-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 8px;
}
.mi-ico {
  display: inline-flex;
  color: var(--muted);
}
.menu-item:hover .mi-ico {
  color: var(--primary);
}

</style>
