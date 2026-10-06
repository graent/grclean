<script setup lang="ts">
import type { Component } from 'vue'

/**
 * 全站通用占位态：图标 + 标题 + 说明。
 * 三种用法：
 *  - 未扫描：「暂未扫描」+ 引导说明
 *  - 已扫描无结果：「未发现对应记录」
 *  - 正在扫描/分析：`loading` = true，图标换成旋转 loading，标题如「扫描中……」
 * 容器在父级剩余空间内水平、垂直居中；文字与图标一律淡色小字，不喧宾夺主。
 */
withDefaults(
  defineProps<{
    icon: Component
    title: string
    desc?: string
    /** 加载中：显示旋转 loading 图标，隐藏说明文字 */
    loading?: boolean
  }>(),
  { loading: false },
)
</script>

<template>
  <div class="empty-state">
    <span v-if="loading" class="empty-spinner" aria-hidden="true" />
    <component v-else :is="icon" :size="32" :stroke-width="1.4" class="empty-icon" />
    <p class="empty-title">{{ title }}</p>
    <p v-if="desc && !loading" class="empty-desc">{{ desc }}</p>
  </div>
</template>

<style scoped>
.empty-state {
  /* 撑满父级剩余空间并居中：父为 flex 容器时靠 flex:1，
     父为普通块（如 .fill-list）时靠 min-height:100% */
  flex: 1 1 auto;
  min-height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 32px 16px;
  text-align: center;
}
.empty-icon {
  color: var(--muted);
  opacity: 0.5;
}
.empty-spinner {
  width: 30px;
  height: 30px;
  border: 3px solid color-mix(in srgb, var(--muted) 22%, transparent);
  border-top-color: color-mix(in srgb, var(--primary) 70%, transparent);
  border-radius: 50%;
  animation: spinner-rot 0.85s linear infinite;
}
.empty-title {
  margin-top: 8px;
  font-size: calc(13px * var(--fs-scale));
  font-weight: 500;
  color: var(--muted);
}
.empty-desc {
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
  opacity: 0.78;
  line-height: 1.6;
  max-width: 460px;
}
</style>
