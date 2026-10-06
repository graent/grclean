<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  score: number
  level: string
  color: string
  /** 显示宽度（px），默认 200；高度按 200:120 比例缩放。 */
  size?: number
}>()

const size = computed(() => props.size ?? 200)
const R = 80
const CX = 100
const CY = 100

const frac = computed(() => Math.max(0, Math.min(1, props.score / 100)))

const bgPath = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`
const fgPath = computed(() => {
  if (frac.value <= 0) return ''
  const theta = Math.PI - frac.value * Math.PI
  const x = CX + R * Math.cos(theta)
  const y = CY - R * Math.sin(theta)
  return `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`
})
</script>

<template>
  <div class="gauge">
    <svg
      viewBox="0 0 200 120"
      class="gauge-svg"
      :style="{ width: size + 'px', height: size * 0.6 + 'px' }"
    >
      <path :d="bgPath" class="track" />
      <path v-if="fgPath" :d="fgPath" class="fill" :stroke="color" />
      <text x="100" y="84" class="score" :fill="color">{{ score }}</text>
      <text x="100" y="104" class="level">{{ level }}</text>
    </svg>
  </div>
</template>

<style scoped>
.gauge {
  width: 100%;
  display: flex;
  justify-content: center;
}
.gauge-svg {
  overflow: visible;
}
.track {
  fill: none;
  stroke: var(--border);
  stroke-width: 16;
  stroke-linecap: round;
}
.fill {
  fill: none;
  stroke-width: 16;
  stroke-linecap: round;
  transition: stroke-dasharray 0.6s ease;
}
.score {
  font-size: calc(36px * var(--fs-scale));
  font-weight: 800;
  text-anchor: middle;
}
.level {
  font-size: calc(13px * var(--fs-scale));
  text-anchor: middle;
  fill: var(--muted);
}
</style>
