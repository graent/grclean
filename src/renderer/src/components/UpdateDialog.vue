<script setup lang="ts">
/**
 * 更新提示弹窗：挂在 App.vue 顶层（不在任何对话框内部）。
 *
 * 「检查更新」有四个入口时（右上角下拉、"关于"页版本号旁），靠
 * `stores/update.ts` 派发状态、这里统一展示，保证两处看到的是同一个弹窗。
 * ⚠️ 不要把它塞进 WindowControls 或 SettingsDialog —— 那样在设置对话框里
 * 弹更新框时会被对话框的遮罩/滚动容器影响层级。
 */
import { Download } from '@lucide/vue'
import { computed } from 'vue'
import Modal from './Modal.vue'
import { t } from '../stores/i18n'
import { closeUpdateDialog, update } from '../stores/update'

const info = computed(() => update.info)
const found = computed({
  get: () => update.dialog === 'found',
  set: (v: boolean) => {
    if (!v) closeUpdateDialog()
  },
})
const latest = computed({
  get: () => update.dialog === 'latest',
  set: (v: boolean) => {
    if (!v) closeUpdateDialog()
  },
})
</script>

<template>
  <!-- 发现新版本 -->
  <Modal v-model:open="found" :title="t('update.found')" width="440px">
    <div v-if="info" class="up-body">
      <p class="up-line">
        {{ t('update.current') }} <b>v{{ info.current }}</b>
        → {{ t('update.latest') }} <b class="up-new">v{{ info.latest }}</b>
      </p>
      <ul v-if="info.notes.length" class="up-notes">
        <li v-for="(n, i) in info.notes" :key="i">{{ n }}</li>
      </ul>
      <p v-else class="muted">{{ t('update.noNotes') }}</p>
    </div>
    <template #footer>
      <button class="btn" @click="closeUpdateDialog()">{{ t('update.later') }}</button>
      <a class="btn btn-primary" :href="info?.url" target="_blank" rel="noreferrer">
        <Download :size="14" /> {{ t('update.download') }}
      </a>
    </template>
  </Modal>

  <!-- 已是最新 -->
  <Modal v-model:open="latest" :title="t('update.title')" width="380px">
    <p class="up-line">{{ t('update.upToDate', { v: info?.current ?? '' }) }}</p>
    <template #footer>
      <button class="btn btn-primary" @click="closeUpdateDialog()">
        {{ t('common.close') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.up-body {
  font-size: calc(14px * var(--fs-scale));
}
.up-line {
  margin: 0 0 10px;
  line-height: 1.6;
}
.up-line b {
  font-variant-numeric: tabular-nums;
}
.up-new {
  color: var(--primary);
}
.up-notes {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text);
  font-size: calc(13px * var(--fs-scale));
  line-height: 1.5;
}
</style>
