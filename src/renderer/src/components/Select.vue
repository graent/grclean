<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, ChevronDown } from '@lucide/vue'

export interface SelectOption {
  value: string
  label: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: SelectOption[]
    /** 触发按钮宽度（px） */
    width?: number
    /** 禁用（如扫描进行中不可选） */
    disabled?: boolean
    /** 选项行高（px），默认 40；调大用于「行高需要更舒展」的下拉 */
    rowHeight?: number
  }>(),
  { width: 160, disabled: false, rowHeight: 0 },
)

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

const currentLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? '',
)

function toggle() {
  if (props.disabled) return
  open.value = !open.value
}

function pick(value: string) {
  emit('update:modelValue', value)
  open.value = false
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
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="root" class="sel-wrap" :style="{ width: width + 'px' }">
    <button
      type="button"
      class="sel-trigger"
      :class="{ open, disabled }"
      :disabled="disabled"
      @click="toggle"
      @keydown.esc="open = false"
    >
      <span class="sel-value">{{ currentLabel }}</span>
      <ChevronDown :size="15" class="sel-arrow" />
    </button>

    <div v-if="open" class="sel-menu" role="listbox">
      <div
        v-for="o in options"
        :key="o.value"
        class="sel-option"
        :class="{ active: o.value === modelValue }"
        :style="
          rowHeight
            ? { minHeight: rowHeight + 'px', padding: (rowHeight - 20) / 2 + 'px 12px' }
            : undefined
        "
        role="option"
        :aria-selected="o.value === modelValue"
        @click="pick(o.value)"
      >
        <span class="sel-option-label">{{ o.label }}</span>
        <Check v-if="o.value === modelValue" :size="15" class="sel-check" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sel-wrap {
  position: relative;
  flex-shrink: 0;
}

/* 触发按钮：高度与输入框/按钮保持一致，避免视觉不协调 */
.sel-trigger {
  width: 100%;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px 0 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel);
  color: var(--text);
  font-size: calc(14px * var(--fs-scale));
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.sel-trigger:hover {
  border-color: color-mix(in srgb, var(--muted) 55%, transparent);
}
/* 禁用态：扫描中不可选 */
.sel-trigger.disabled {
  opacity: 0.55;
  cursor: not-allowed;
  background: var(--bg);
}
/* 聚焦/展开时仅用极浅的主色描边，不喧宾夺主 */
.sel-trigger:focus-visible,
.sel-trigger.open {
  outline: none;
  border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
  box-shadow: 0 0 0 3px var(--primary-weak);
}
.sel-value {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.sel-arrow {
  flex-shrink: 0;
  color: var(--muted);
  transition: transform 0.15s;
}
.sel-trigger.open .sel-arrow {
  transform: rotate(180deg);
}

/* 弹出面板：淡入 + 轻微上滑，观感更顺滑 */
.sel-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.1), var(--shadow);
  transform-origin: top center;
  animation: sel-in 0.14s ease;
}
@keyframes sel-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 选项行：行高舒适（约 40px），不再挤成一条 */
.sel-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  min-height: 40px;
  border-radius: 6px;
  font-size: calc(14px * var(--fs-scale));
  line-height: 1.4;
  color: var(--text);
  cursor: pointer;
  transition: background 0.12s;
}
.sel-option:hover {
  background: var(--primary-weak);
}
/* 选中态：仅用极浅底色 + 对勾标识，不用彩色边框 */
.sel-option.active {
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  font-weight: 600;
}
.sel-option-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.sel-check {
  flex-shrink: 0;
  color: var(--primary);
}
</style>
