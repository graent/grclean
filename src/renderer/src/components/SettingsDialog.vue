<script setup lang="ts">
/**
 * 「设置」对话框：左侧分区菜单 + 右侧对应内容。
 *
 * 右侧一律复用已有视图，不重复实现逻辑：
 * - 设置分区 → Settings.vue（embedded + only）
 * - 意见反馈 → Feedback.vue（embedded）
 * - 捐赠     → Donate.vue（embedded）
 * - 关于     → About.vue
 */
import { computed, ref, watch } from 'vue'
import {
  Gift,
  Info,
  MessageSquareHeart,
  ShieldAlert,
  SlidersHorizontal,
} from '@lucide/vue'
import Modal from './Modal.vue'
import Settings from '../views/Settings.vue'
import Feedback from '../views/Feedback.vue'
import Donate from '../views/Donate.vue'
import About from '../views/About.vue'
import { t } from '../stores/i18n'

const props = defineProps<{
  open: boolean
  /** 打开时定位到的菜单项（右上角下拉入口传入），默认回到第一个分区 */
  section?: string
}>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const innerOpen = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

/**
 * 设置分区（key 与 Settings.vue 的 show() 判定对应）。
 * 'general' = 通用设置：主题 + 语言 + 字体合并为一页。
 */
const sections = computed(() => [
  { key: 'general', label: t('settings.general'), icon: SlidersHorizontal },
  { key: 'advanced', label: t('settings.advanced'), icon: ShieldAlert },
])

/** 其余内容页（原右上角下拉入口 / 关于弹窗，现统一收进这里） */
const pages = computed(() => [
  { key: 'feedback', label: t('nav.feedback'), icon: MessageSquareHeart },
  { key: 'donate', label: t('nav.donate'), icon: Gift },
  { key: 'about', label: t('settings.about'), icon: Info },
])

const cur = ref('general')
/** 打开时定位：右上角下拉点「捐赠」就停在捐赠，点「设置」则回到外观 */
function initial(key?: string) {
  const all = [...sections.value, ...pages.value]
  return key && all.some((x) => x.key === key) ? key : 'general'
}

const isSetting = computed(() => sections.value.some((s) => s.key === cur.value))
/** 标题跟随当前菜单项（切到捐赠 / 反馈 / 关于时标题同步变化） */
const curLabel = computed(
  () =>
    [...sections.value, ...pages.value].find((x) => x.key === cur.value)?.label ??
    t('nav.settings'),
)

// 打开时定位到指定菜单项（或回到第一个分区）
watch(
  () => [props.open, props.section] as const,
  ([v]) => {
    if (v) cur.value = initial(props.section)
  },
)
</script>

<template>
  <!-- 固定宽高：内容再长也不撑大对话框，右侧内容区内部纵向滚动 -->
  <Modal v-model:open="innerOpen" :title="curLabel" width="880px" height="620px">
    <div class="sd">
      <nav class="sd-nav" role="tablist">
        <button
          v-for="s in sections"
          :key="s.key"
          type="button"
          class="sd-item"
          :class="{ active: cur === s.key }"
          role="tab"
          :aria-selected="cur === s.key"
          @click="cur = s.key"
        >
          <component :is="s.icon" :size="14" />
          <span>{{ s.label }}</span>
        </button>

        <div class="sd-sep"></div>

        <button
          v-for="p in pages"
          :key="p.key"
          type="button"
          class="sd-item"
          :class="{ active: cur === p.key }"
          role="tab"
          :aria-selected="cur === p.key"
          @click="cur = p.key"
        >
          <component :is="p.icon" :size="14" />
          <span>{{ p.label }}</span>
        </button>
      </nav>

      <div class="sd-main">
        <Settings v-if="isSetting" embedded :only="cur" />
        <Feedback v-else-if="cur === 'feedback'" embedded />
        <Donate v-else-if="cur === 'donate'" embedded />
        <About v-else-if="cur === 'about'" embedded />
      </div>
    </div>
    <template #footer>
      <button class="btn btn-primary" @click="innerOpen = false">
        {{ t('common.close') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.sd {
  display: flex;
  gap: 16px;
  /* 撑满固定高度对话框的内容区，使右侧可独立滚动 */
  height: 100%;
  min-height: 0;
}
.sd-nav {
  width: 136px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-right: 12px;
  border-right: 1px solid var(--border);
}
.sd-item {
  display: flex;
  align-items: center;
  gap: 9px;
  /* 明确撑满整行（块级）：hover / 点击热区覆盖整条菜单，不留空隙 */
  position: relative;
  width: 100%;
  align-self: stretch;
  box-sizing: border-box;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-family: inherit;
  font-size: calc(12px * var(--fs-scale));
  padding: 8px 9px;
  min-height: 32px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  /* 无边框窗口：显式声明不可拖拽。-webkit-app-region 会继承，
     一旦某祖先是 drag 区域，鼠标事件会被窗口拖动逻辑吞掉（点不动）。 */
  -webkit-app-region: no-drag;
}
/* 让图标 / 文字不吃鼠标事件，事件 target 永远是按钮本身，
   避免出现「点在文字上没反应、点空白处正常」。 */
.sd-item > * {
  pointer-events: none;
}
/* hover 与 active 都走主色，只是深浅不同 —— 原来 hover 用 --bg，
   与面板底色差别太小，看着像没反应 */
.sd-item:hover,
.sd-item:focus-visible {
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  color: var(--primary);
  outline: none;
}
.sd-item.active {
  background: color-mix(in srgb, var(--primary) 22%, transparent);
  color: var(--primary);
  font-weight: 600;
  /* 左侧色条：选中态与 hover 一眼区分 */
  box-shadow: inset 2px 0 0 var(--primary);
}
.sd-sep {
  height: 1px;
  background: var(--border);
  margin: 6px 8px;
}
.sd-main {
  flex: 1;
  min-width: 0;
  /* 右侧内容区纵向滚动；顶部留白避免首行贴边被裁 */
  overflow-y: auto;
  padding-right: 6px;
}
/* 对话框内：所有「项」容器统一加边框 + 淡主色底色，与相邻项明显区分。
   （标题已在模板中置于 .card 之外、框的上方，故此处只负责框本身。） */
.sd-main :deep(.card) {
  position: relative;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--primary) 5%, var(--panel));
  border-radius: 10px;
  padding: 16px 14px 14px;
  box-shadow: none;
}
/* 项标题在框外上方：普通文字、无背景、不压边框线。统一字号与间距，避免各页不一。 */
.sd-main :deep(.block-title) {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 600;
  color: var(--title);
  margin-bottom: 8px;
}
</style>
