<script setup lang="ts">
import { FolderOpen } from '@lucide/vue'
import { openPath } from '../api/electron'

const props = withDefaults(
  defineProps<{ path: string; title?: string }>(),
  { title: '在资源管理器中打开' },
)

/** 打开结果：ok=false 时把原因抛给父级（由其决定弹窗 / 行内提示）。 */
const emit = defineEmits<{ (e: 'error', message: string): void }>()

async function open() {
  if (!props.path) return
  try {
    const r = await openPath(props.path)
    if (!r?.ok) emit('error', r?.error || '打开失败：未知错误')
  } catch (e: any) {
    emit('error', String(e))
  }
}
</script>

<template>
  <button
    class="open-folder"
    type="button"
    :title="title"
    no-drag
    @click.stop="open"
  >
    <FolderOpen :size="15" />
  </button>
</template>

<style scoped>
.open-folder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  flex: none;
  transition: color 0.15s;
}
.open-folder:hover {
  color: var(--primary);
}
</style>
