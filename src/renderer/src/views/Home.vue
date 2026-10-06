<script setup lang="ts">
import {
  Activity,
  ClipboardList,
  Gauge,
  Home,
  Layers,
  MonitorCog,
  RefreshCw,
  SlidersHorizontal,
} from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import ScoreGauge from '../components/ScoreGauge.vue'
import { health, runHealth } from '../stores/health'
import { formatSize, getSystemInfo, type SystemInfo } from '../api/electron'
import { t } from '../stores/i18n'
import { scanHistory, loadScan } from '../stores/history'

defineEmits<{ (e: 'navigate', v: string): void }>()

const r = computed(() => health.report)

// ---- 系统属性信息 ----
// 主进程会把采集结果存到 %LOCALAPPDATA%/GrClean/sysinfo.json：
// 下次启动直接返回上次结果（秒出），点右上角刷新才真正重新采集（force=true）。
const sys = ref<SystemInfo | null>(null)
const sysErr = ref('')
const sysLoading = ref(false)

async function loadSys(force = false) {
  if (sysLoading.value) return
  sysLoading.value = true
  sysErr.value = ''
  try {
    sys.value = await getSystemInfo(force)
  } catch (e) {
    sysErr.value = String(e instanceof Error ? e.message : e)
  } finally {
    sysLoading.value = false
  }
}

onMounted(() => {
  // 拉取「健康体检」的历史记录：重启后也能显示上次体检时间 / 判断是否显示「重新体检」
  void loadScan('health')
  void loadSys()
})

/** 系统信息行：标签 + 组装好的展示值（单位/语序按当前语言）。 */
const sysRows = computed(() => {
  const s = sys.value
  if (!s) return []
  return [
    { label: t('home.osName'), value: s.os },
    { label: t('home.arch'), value: s.arch },
    { label: t('home.processor'), value: s.processor },
    {
      label: t('home.cpu'),
      value: `${s.cpuCores} ${t('home.cores')} / ${s.cpuThreads} ${t('home.threads')} @ ${s.cpuGHz} GHz`,
    },
    {
      label: t('home.memory'),
      value: `${s.memTotalGB.toFixed(1)} GB / ${t('home.free')} ${s.memFreeGB.toFixed(1)} GB`,
    },
    { label: t('home.computer'), value: s.computerName },
    { label: t('home.user'), value: s.user },
  ]
})

/** 上次体检时间：优先当前报告，其次历史记录。 */
const lastCheckAt = computed(
  () => r.value?.stats.scannedAt ?? scanHistory.health?.scannedAt ?? '',
)
const hasHistory = computed(() => !!lastCheckAt.value)

/** 评分因素（与 score.ts 的 11 项一一对应，仅用于「评分标准」说明面板）。 */
const scoreFactors = computed(() => [
  { key: 'free', weight: 28 },
  { key: 'cap', weight: 5 },
  { key: 'junk', weight: 12 },
  { key: 'dup', weight: 8 },
  { key: 'social', weight: 8 },
  { key: 'reg', weight: 4 },
  { key: 'startup', weight: 7 },
  { key: 'disk', weight: 11 },
  { key: 'fs', weight: 7 },
  { key: 'upd', weight: 5 },
  { key: 'rel', weight: 5 },
])

/** 等级划分（与 score.ts levelOf 阈值一致）。 */
const levels = computed(() => [
  { label: t('level.excellent'), range: '≥ 85', color: '#3a9d3a' },
  { label: t('level.good'), range: '70 – 84', color: '#5a9bd4' },
  { label: t('level.fair'), range: '50 – 69', color: '#e6c200' },
  { label: t('level.poor'), range: '30 – 49', color: '#e08a2b' },
  { label: t('level.danger'), range: '< 30', color: '#d33333' },
])
</script>

<template>
  <div>
    <h1 class="h-with-icon"><Home :size="20" /> {{ t('nav.home') }}</h1>
    <p class="muted">{{ t('app.slogan') }}</p>

    <div class="dash">
      <!-- 健康度评分卡 -->
      <div class="card score-card">
        <div class="score-head">
        <div class="score-head-left">
          <Gauge :size="16" class="title-icon" />
          <span>{{ t('home.score') }}</span>
          <span v-if="lastCheckAt" class="last-check">
            {{ t('home.lastCheck') }}：{{ new Date(lastCheckAt).toLocaleString() }}
          </span>
        </div>
          <span
            v-if="r"
            class="badge"
            :style="{ color: r.levelColor, borderColor: r.levelColor }"
            >{{ r.level }}</span
          >
        </div>
        <ScoreGauge
          v-if="r"
          :score="r.score"
          :level="r.level"
          :color="r.levelColor"
          :size="130"
        />
        <div v-else class="gauge-empty">
          <Activity :size="36" />
          <p class="muted">{{ t('home.never') }}</p>
        </div>
        <p v-if="r" class="score-sub muted">
          系统盘剩余 {{ r.stats.systemFreeGB.toFixed(1) }} GB ·
          可清理 {{ formatSize(r.stats.junkBytes + r.stats.socialBytes) }}
        </p>
        <button class="btn btn-primary checkup" :disabled="health.loading" @click="runHealth()">
          <span v-if="health.loading" class="spinner"></span>
          <span v-if="!health.loading">{{ hasHistory ? t('home.recheck') : t('home.checkup') }}</span>
          <span v-else>{{ t('home.checking') }}</span>
        </button>
        <p v-if="health.error" class="err">{{ health.error }}</p>
      </div>

      <!-- 系统属性信息 -->
      <div class="card sys-card">
        <!-- 刷新图标固定在卡片右上角，点刷新才重新采集 -->
        <button
          class="sys-refresh"
          type="button"
          :title="t('home.sysRefresh')"
          :aria-label="t('home.sysRefresh')"
          :disabled="sysLoading"
          @click="loadSys(true)"
        >
          <RefreshCw :size="14" :class="{ 'sys-spin': sysLoading }" />
        </button>
        <div class="sys-head">
          <MonitorCog :size="15" />
          <span>{{ t('home.sysTitle') }}</span>
          <!-- 缓存结果会显示采集时间，点刷新才重新采集 -->
          <span v-if="sys?.updatedAt" class="sys-time muted">
            {{ t('home.sysUpdated') }} {{ new Date(sys.updatedAt).toLocaleString() }}
          </span>
        </div>

        <div v-if="sysRows.length" class="sys-rows">
          <div v-for="row in sysRows" :key="row.label" class="sys-row">
            <span class="sys-label">{{ row.label }}</span>
            <!-- 值单行省略（CPU 型号等可能很长），完整内容用 title 悬浮查看 -->
            <span class="sys-value" :title="row.value">{{ row.value }}</span>
          </div>
        </div>
        <p v-else-if="sysErr" class="err">{{ sysErr }}</p>
        <p v-else class="muted">{{ t('common.loading') }}</p>
      </div>
    </div>

    <!-- 评分标准说明（design.md §4） -->
    <h2 class="section-title h-with-icon"><ClipboardList :size="16" /> {{ t('home.scoreStd') }}</h2>
    <div class="std">
      <div class="card std-factors">
        <div class="card-title"><SlidersHorizontal :size="15" /> {{ t('home.factorsTitle') }}</div>
        <p class="std-desc muted">{{ t('home.scoreStdDesc') }}</p>
        <div class="factor-rows">
          <div v-for="f in scoreFactors" :key="f.key" class="frow">
            <span class="fname">{{ t('score.' + f.key) }}</span>
            <span class="fbar"><span class="fbar-fill" :style="{ width: f.weight * 3 + '%' }"></span></span>
            <span class="fweight muted">{{ f.weight }}</span>
          </div>
        </div>
      </div>
      <div class="card std-levels">
        <div class="card-title"><Layers :size="15" /> {{ t('home.levelStd') }}</div>
        <div class="lrow" v-for="lv in levels" :key="lv.label">
          <span class="ldot" :style="{ background: lv.color }"></span>
          <span class="lname">{{ lv.label }}</span>
          <span class="lrange muted">{{ lv.range }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dash {
  display: flex;
  gap: 16px;
  margin: 12px 0 6px;
  flex-wrap: wrap;
}
.score-card {
  flex: 1 1 300px;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14px 18px;
}
.score-head {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: calc(14px * var(--fs-scale));
  font-weight: 600;
  color: var(--title);
}
.score-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.last-check {
  font-size: calc(11px * var(--fs-scale));
  font-weight: 400;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  font-size: calc(12px * var(--fs-scale));
  font-weight: 700;
  border: 1px solid;
  border-radius: 999px;
  padding: 1px 10px;
}
.gauge-empty {
  height: 90px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--muted);
}
.score-sub {
  font-size: calc(12px * var(--fs-scale));
  margin: 2px 0 12px;
  text-align: center;
}
.checkup {
  width: 160px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.err {
  color: var(--danger);
  font-size: calc(12px * var(--fs-scale));
  margin-top: 8px;
}
.sys-card {
  flex: 1 1 300px;
  min-width: 280px;
  padding: 12px 16px;
  align-content: start;
  position: relative;
}
.sys-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  color: var(--title);
  margin-bottom: 8px;
  min-height: 24px;
  padding-right: 30px;
}
/* 采集时间：缓存结果才显示，避免用户误以为是实时值 */
.sys-time {
  font-size: calc(11px * var(--fs-scale));
  font-weight: 400;
  white-space: nowrap;
}
.sys-refresh {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.sys-refresh:hover:not(:disabled) {
  background: var(--primary-weak);
  color: var(--primary);
}
.sys-refresh:disabled {
  opacity: 0.55;
  cursor: default;
}
.sys-spin {
  animation: sys-rot 0.9s linear infinite;
}
@keyframes sys-rot {
  to {
    transform: rotate(360deg);
  }
}
.sys-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sys-row {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 8px;
  align-items: baseline;
}
.sys-label {
  font-size: calc(11px * var(--fs-scale));
  color: var(--muted);
  white-space: nowrap;
}
.sys-value {
  font-size: calc(12px * var(--fs-scale));
  color: var(--text);
  line-height: 1.35;
  /* 单行省略，避免超长 CPU 型号换行把卡片撑高导致页面出现滚动条 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.section-title {
  margin: 14px 0 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 标题前置图标的统一对齐：h1/h2 与卡片小标题都复用 */
.h-with-icon {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title-icon {
  flex-shrink: 0;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(14px * var(--fs-scale));
  font-weight: 600;
  color: var(--title);
  margin-bottom: 10px;
}

/* ---- 评分标准说明面板 ---- */
.std {
  display: flex;
  gap: 16px;
  margin: 0 0 8px;
  flex-wrap: wrap;
}
.std-factors {
  flex: 2 1 420px;
}
.std-levels {
  flex: 1 1 200px;
}
.std-desc {
  font-size: calc(12px * var(--fs-scale));
  margin: 0 0 12px;
}
.factor-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.frow {
  display: flex;
  align-items: center;
  gap: 10px;
}
.fname {
  width: 200px;
  flex-shrink: 0;
  font-size: calc(13px * var(--fs-scale));
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fbar {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: var(--border);
  overflow: hidden;
}
.fbar-fill {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: var(--primary);
  opacity: 0.85;
}
.fweight {
  width: 26px;
  text-align: right;
  font-size: calc(12px * var(--fs-scale));
  font-weight: 600;
}
.lrow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.lrow:last-child {
  border-bottom: none;
}
.ldot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.lname {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  color: var(--text);
}
.lrange {
  margin-left: auto;
  font-size: calc(12px * var(--fs-scale));
  font-variant-numeric: tabular-nums;
}
</style>
