<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getVersion } from '../api/electron'
import { t } from '../stores/i18n'
import {
  Home,
  Trash2,
  Package,
  Rocket,
  PackageX,
  Copy,
  FileSearch,
  Activity,
  MessageCircle,
  HardDrive,
  PackageOpen,
  FileText,
  Minimize2,
  MousePointerClick,
  Cpu,
  ArrowLeftRight,
  Wrench,
  FolderTree,
  GitCompareArrows,
  History,
  Sparkles,
} from '@lucide/vue'

defineProps<{ current: string }>()
const emit = defineEmits<{ (e: 'navigate', v: string): void }>()

const version = ref('')
onMounted(async () => {
  try {
    version.value = await getVersion()
  } catch {
    version.value = ''
  }
})

// label 走 i18n：key 形如 nav.<视图键>，语言包缺失时回退到 key 本身
const items = [
  { key: 'home', icon: Home },
  { key: 'score', icon: Activity },
  { key: 'clean', icon: Trash2 },
  { key: 'social', icon: MessageCircle },
  { key: 'disk', icon: HardDrive },
  { key: 'big', icon: Package },
  { key: 'startup', icon: Rocket },
  { key: 'uninstall', icon: PackageX },
  { key: 'duplicates', icon: Copy },
  { key: 'registry', icon: FileSearch },
  { key: 'installers', icon: PackageOpen },
  { key: 'logs', icon: FileText },
  { key: 'slim', icon: Minimize2 },
  { key: 'contextmenu', icon: MousePointerClick },
  { key: 'drivers', icon: Cpu },
  { key: 'migrate', icon: ArrowLeftRight },
  { key: 'optimize', icon: Wrench },
  { key: 'treemap', icon: FolderTree },
  { key: 'snapshot', icon: GitCompareArrows },
  { key: 'restore', icon: History },
]
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <Sparkles :size="18" class="brand-ico" />
      GrClean<span class="ver" v-if="version">v{{ version }}</span>
    </div>
    <nav>
      <button
        v-for="it in items"
        :key="it.key"
        class="nav-item"
        :class="{ active: current === it.key }"
        @click="emit('navigate', it.key)"
      >
        <span class="ico"><component :is="it.icon" :size="18" /></span>{{ t('nav.' + it.key) }}
      </button>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 196px;
  flex-shrink: 0;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--sidebar-border);
  display: flex;
  flex-direction: column;
  padding: 18px 12px;
  -webkit-app-region: drag;
  /* 侧栏是拖拽区域，保持不可选，避免拖动时误选文字 */
  -webkit-user-select: none;
  user-select: none;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(20px * var(--fs-scale));
  font-weight: 700;
  color: var(--sidebar-brand);
  padding: 6px 10px 18px;
  letter-spacing: 0.5px;
  user-select: none;
  -webkit-app-region: no-drag;
}

/* 品牌星芒图标：颜色跟随主题侧栏品牌色（白底侧栏=品牌蓝 / 深色侧栏=白） */
.brand-ico {
  color: var(--sidebar-brand);
  flex-shrink: 0;
}

.ver {
  font-size: calc(12px * var(--fs-scale));
  font-weight: 500;
  color: var(--sidebar-muted);
  letter-spacing: 0;
}

nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  /* 模块增至 13 项后可能超出窗口高度，允许侧栏内滚动（min-height:0 是 flex 滚动的必要条件） */
  min-height: 0;
  overflow-y: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  border: none;
  background: transparent;
  color: var(--sidebar-muted);
  text-align: left;
  padding: 9px 12px;
  border-radius: 9px;
  font-size: calc(14px * var(--fs-scale));
  cursor: pointer;
  transition: all 0.15s;
  -webkit-app-region: no-drag;
}

.nav-item:hover {
  background: var(--sidebar-hover);
  color: var(--sidebar-text);
}

.nav-item.active {
  background: var(--sidebar-active-bg);
  color: var(--sidebar-active-text);
}

.ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  flex-shrink: 0;
}
</style>
