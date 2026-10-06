<script setup lang="ts">
import { onMounted } from 'vue'
import { loadScan, scanHistory } from '../stores/history'
import { t } from '../stores/i18n'

const props = defineProps<{ module: string }>()

onMounted(() => {
  void loadScan(props.module)
})
</script>

<template>
  <span v-if="scanHistory[module]" class="last-scan">
    <span class="dot"></span>
    {{ t('history.lastScan') }}：{{
      new Date(scanHistory[module].scannedAt).toLocaleString()
    }}
    <span class="sep">·</span>
    <span class="summary">{{ scanHistory[module].summary }}</span>
  </span>
</template>

<style scoped>
.last-scan {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
  white-space: nowrap;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
}
.sep {
  opacity: 0.5;
}
.summary {
  color: var(--text);
  font-weight: 600;
}
</style>
