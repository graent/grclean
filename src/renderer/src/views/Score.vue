<script setup lang="ts">
import { computed } from 'vue'
import ScoreGauge from '../components/ScoreGauge.vue'
import { health, runHealth } from '../stores/health'
import type { FactorResult } from '../api/electron'
import { Activity, BarChart3, Lightbulb } from '@lucide/vue'

const r = computed(() => health.report)

function ratioColor(f: FactorResult): string {
  const ratio = f.max > 0 ? f.score / f.max : 1
  if (ratio >= 0.85) return '#3a9d3a'
  if (ratio >= 0.7) return '#5a9bd4'
  if (ratio >= 0.5) return '#e6c200'
  if (ratio >= 0.3) return '#e08a2b'
  return '#d33333'
}
</script>

<template>
  <div>
    <h1 class="h-with-icon"><Activity :size="20" class="title-icon" />健康度评分详情</h1>
    <p class="muted">综合 11 项因素，满分 100</p>

    <div class="card gauge-card">
      <ScoreGauge
        v-if="r"
        :score="r.score"
        :level="r.level"
        :color="r.levelColor"
      />
      <div v-else class="empty">
        <p class="muted">尚未体检，请先运行一键体检。</p>
        <button class="btn btn-primary" :disabled="health.loading" @click="runHealth()">
          <span v-if="health.loading" class="spinner"></span>
          {{ health.loading ? '体检中…' : '一键体检' }}
        </button>
        <div v-if="health.loading" class="progress empty-progress">
          <div class="bar indeterminate"></div>
        </div>
      </div>
      <p v-if="r" class="scanned muted">
        系统盘 {{ r.stats.systemTotalGB.toFixed(0) }} GB ·
        剩余 {{ r.stats.systemFreeGB.toFixed(1) }} GB ·
        {{ r.stats.diskType }} · {{ r.stats.diskHealthy }}
      </p>
      <button v-if="r" class="btn btn-primary recheck" :disabled="health.loading" @click="runHealth()">
        <span v-if="health.loading" class="spinner"></span>
        {{ health.loading ? '体检中…' : '重新体检' }}
      </button>
    </div>

    <template v-if="r">
      <h2 class="section-title h-with-icon"><BarChart3 :size="16" class="title-icon" />因素得分</h2>
      <div class="card">
        <div v-for="f in r.factors" :key="f.key" class="factor">
          <div class="factor-top">
            <span class="f-label">{{ f.label }}</span>
            <span class="f-weight">权重 {{ f.weight }}</span>
          </div>
          <div class="f-bar">
            <div
              class="f-fill"
              :style="{ width: (f.score / f.max) * 100 + '%', background: ratioColor(f) }"
            ></div>
          </div>
          <div class="factor-bottom">
            <span class="f-detail muted">{{ f.detail }}</span>
            <span class="f-score">{{ f.score }}/{{ f.max }}</span>
          </div>
        </div>
      </div>

      <h2 class="section-title h-with-icon"><Lightbulb :size="16" class="title-icon" />针对性建议</h2>
      <div class="card suggest">
        <ul>
          <li v-for="(s, i) in r.suggestions" :key="i">{{ s }}</li>
        </ul>
      </div>
    </template>
  </div>
</template>

<style scoped>
.gauge-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: 14px;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
}
.scanned {
  font-size: calc(12px * var(--fs-scale));
  margin-top: 4px;
}
.recheck {
  margin-top: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.h-with-icon {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title-icon {
  flex-shrink: 0;
}
.section-title {
  margin: 20px 0 4px;
}
.factor {
  padding: 12px 2px;
  border-bottom: 1px solid var(--border);
}
.factor:last-child {
  border-bottom: none;
}
.factor-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.f-label {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 600;
  color: var(--text);
}
.f-weight {
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
}
.f-bar {
  height: 8px;
  background: var(--border);
  border-radius: 4px;
  overflow: hidden;
  margin: 8px 0 6px;
}
.f-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s ease;
}
.factor-bottom {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.f-detail {
  font-size: calc(12px * var(--fs-scale));
}
.f-score {
  font-size: calc(12px * var(--fs-scale));
  font-weight: 600;
  color: var(--text);
}
.suggest ul {
  margin: 0;
  padding-left: 18px;
}
.suggest li {
  font-size: calc(13px * var(--fs-scale));
  line-height: 1.7;
  color: var(--text);
}
.btn {
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 9px;
  padding: 9px 18px;
  font-size: calc(14px * var(--fs-scale));
  cursor: pointer;
  transition: all 0.15s;
}
.btn-primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
