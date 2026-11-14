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
  Bot,
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
  { key: 'aicache', icon: Bot },
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
        <span v-if="it.key === 'aicache'" class="nav-new">NEW</span>
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
  /* 角标绝对定位的参照系 */
  position: relative;
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

/* 新功能角标：绝对定位浮在菜单项右上角，**不参与 flex 布局**。
   ⚠️ 不能用 margin-left:auto 做成 flex 子项——会占掉文字宽度，导致「AI 软件专清」换行。
   top 取负值骑在按钮上边缘：既不占空间，也不会压到垂直居中的菜单文字。
   固定英文 NEW（营销式标签，不走多语言包）。
   动画：入场弹性弹出一次，之后每 3.2s 一次「脉冲 + 扫光」，其余时间静止
   （避免持续抖动干扰阅读）。光晕取 var(--danger) 跟随主题，动画只改
   transform / filter / background-position，不触发重排、不影响布局。 */
.nav-new {
  position: absolute;
  top: -4px;
  right: 6px;
  z-index: 1;
  font-size: calc(9px * var(--fs-scale));
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0.5px;
  color: #fff;
  background-color: var(--danger);
  /* 斜向高光带：用 background-position 扫过，无需伪元素 */
  background-image: linear-gradient(
    100deg,
    transparent 38%,
    rgba(255, 255, 255, 0.55) 50%,
    transparent 62%
  );
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position: 130% 0;
  border-radius: 4px;
  padding: 2px 4px;
  pointer-events: none;
  transform-origin: center;
  animation:
    new-badge-in 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) backwards,
    new-badge-pop 3.2s ease-in-out 0.5s infinite,
    new-badge-shine 3.2s linear 0.5s infinite;
}

/* 入场：从小弹到略大再回落，只播一次 */
@keyframes new-badge-in {
  from { opacity: 0; transform: scale(0.3); }
  70%  { opacity: 1; transform: scale(1.18); }
  to   { opacity: 1; transform: scale(1); }
}

/* 每轮只在前 20% 时间「叮」一下：短促放大 + 同色光晕，之后完全静止 */
@keyframes new-badge-pop {
  0%, 62%, 100% { transform: scale(1); filter: none; }
  70%           { transform: scale(1.14); filter: drop-shadow(0 0 4px var(--danger)); }
  82%           { transform: scale(1); filter: none; }
}

/* 高光带与脉冲同步，从左侧划到右侧后停在界外 */
@keyframes new-badge-shine {
  0%, 60%   { background-position: 130% 0; }
  82%, 100% { background-position: -30% 0; }
}

/* 系统开启「减少动态效果」时退化为静态角标 */
@media (prefers-reduced-motion: reduce) {
  .nav-new {
    animation: none;
    background-image: none;
  }
}
</style>
