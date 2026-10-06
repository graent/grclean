<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { settings, THEMES, FONT_SIZES, type FontSizeKey } from '../stores/settings'
import {
  getLocal,
  openI18nDir,
  setLocal,
  verifyIntegrity,
  type IntegrityResult,
} from '../api/electron'
import Switch from '../components/Switch.vue'
import Select from '../components/Select.vue'
import Modal from '../components/Modal.vue'
import { CheckCircle2, AlertTriangle } from '@lucide/vue'
import { locales, i18nDir, loadLocales, t } from '../stores/i18n'

/**
 * 支持两种用法：
 * - 整页模式（默认）：显示标题 + 全部设置分区；
 * - 嵌入模式（embedded=true，供「设置」对话框使用）：隐藏标题，并按 only 只显示指定分区。
 */
const props = withDefaults(defineProps<{ embedded?: boolean; only?: string }>(), {
  embedded: false,
  only: '',
})

/**
 * 分区显示判定：
 * - only 为空 = 全部显示（整页模式）；
 * - only = 'general' = 通用设置（主题 + 语言 + 字体三个分区一起显示）。
 *
 * 用 v-if 而非 v-show：隐藏的分区不进 DOM，对话框里「相邻区块加分隔线」的
 * CSS（`.card + .card`）才不会被隐藏元素干扰。
 */
function show(key: string): boolean {
  if (!props.only) return true
  if (props.only === 'general') {
    return key === 'appearance' || key === 'language' || key === 'font'
  }
  return props.only === key
}

const auditPath = `${'%LOCALAPPDATA%'}\\GrClean\\audit.jsonl`

// 语言包：目录即真相，点刷新可热加载新增/删除的 JSON 包
const langOptions = computed(() =>
  locales.value.map((l) => ({
    value: l.code,
    label: `${l.name}（${l.code}）· ${l.count} ${t('settings.languageEntries')}`,
  })),
)

async function refreshLocales() {
  await loadLocales()
}

async function openLangDir() {
  try {
    await openI18nDir()
  } catch {
    /* ignore */
  }
}

// 字体大小四档：小 / 标准 / 中 / 大（computed，切换语言后标签同步刷新）
const fontOptions = computed(() =>
  FONT_SIZES.map((f) => ({
    key: f.key as FontSizeKey,
    label: t(`settings.font.${f.key}`),
    px: f.px,
  })),
)

// ---------------- 程序完整性校验 ----------------
// 本机程序文件（app.asar / 主程序）的 SHA-256 与官方发布值比对，需联网。
//
// 展示约定（用户要求）：
// - 校验结果**只用对话框**呈现，卡片里不再直接铺开任何返回信息
//   （不做本地哈希表格、不显示 detail 诊断串如 packaged=1; mode=portable ……）；
// - 卡片里只保留按钮，以及「上次校验时间 + 结果图标」这条常驻记录
//   （通过=绿色对号，未通过=红色叹号，悬停提示"程序可能被篡改，请谨慎使用"）。
// 只有「通过 / 未通过」这类**确定结论**才写入记录；网络失败、官方未收录等
// 只弹对话框，不覆盖上次结论，避免误标成"未通过"。
const VERIFY_LAST_KEY = 'grclean.verify.last'
const verifying = ref(false)
const verifyResult = ref<IntegrityResult | null>(null)
const verifyDialog = ref(false)
/** 上次校验结论（仅 OK / MISMATCH），持久化到 localStorage 便于重启后仍可见 */
const lastVerify = ref<{ code: string; at: number } | null>(null)

function loadLastVerify() {
  try {
    const raw = getLocal(VERIFY_LAST_KEY)
    if (!raw) return
    const o = JSON.parse(raw) as { code?: string; at?: number }
    if ((o.code === 'OK' || o.code === 'MISMATCH') && o.at) {
      lastVerify.value = { code: o.code, at: o.at }
    }
  } catch {
    /* 记录损坏就当没校验过 */
  }
}

function saveLastVerify(code: string, at: number) {
  lastVerify.value = { code, at }
  setLocal(VERIFY_LAST_KEY, JSON.stringify({ code, at }))
}

/** 2026-10-06 01:52 形式；不用 toLocaleString，避免随系统区域变来变去 */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const lastVerifyText = computed(() =>
  lastVerify.value ? t('settings.verify.lastAt', { v: formatTime(lastVerify.value.at) }) : '',
)

async function runVerify() {
  verifying.value = true
  try {
    const r = await verifyIntegrity()
    verifyResult.value = r
    if (r.code === 'OK' || r.code === 'MISMATCH') {
      saveLastVerify(r.code, r.checkedAt || Date.now())
    }
  } catch {
    // 调用失败也给出明确反馈（而不是什么都不弹），统一按"无法连接官方服务器"处理
    verifyResult.value = {
      code: 'REMOTE_UNAVAILABLE',
      version: '',
      msg: '',
      files: [],
      checkedAt: Date.now(),
    }
  } finally {
    verifying.value = false
    // 无论成功失败都用对话框呈现结果，卡片里不铺开任何细节
    verifyDialog.value = true
  }
}

/** 结果码 → 颜色语义：通过=成功色，不一致=危险色，其余=谨慎色。 */
function codeClass(code: string): string {
  if (code === 'OK') return 'is-ok'
  if (code === 'MISMATCH') return 'is-bad'
  return 'is-warn'
}

/** 对话框里的一句话结论：优先用服务端返回的 msg，没有则用内置文案。 */
const dialogMsg = computed(() => {
  const r = verifyResult.value
  if (!r) return ''
  return r.msg || t('settings.verify.' + r.code)
})

onMounted(async () => {
  loadLastVerify()
  await loadLocales()
})
</script>

<template>
  <div :class="{ embedded }">
    <template v-if="!embedded">
      <h1>{{ t('settings.title') }}</h1>
      <p class="muted">{{ t('settings.subtitle') }}</p>
    </template>

    <!-- 主题 -->
    <div v-if="show('appearance')" class="item">
      <div class="block-title">{{ t('settings.appearance') }}</div>
      <div class="card sec">
        <p class="muted sub">{{ t('settings.themeDesc') }}</p>
        <div class="theme-grid">
          <button
            v-for="tt in THEMES"
            :key="tt.key"
            type="button"
            class="theme-card"
            :class="{ active: settings.theme === tt.key }"
            :aria-pressed="settings.theme === tt.key"
            @click="settings.theme = tt.key"
          >
            <div class="swatch">
              <span class="sw-side" :style="{ background: tt.sidebar }"></span>
              <span class="sw-content" :style="{ background: tt.bg }">
                <span
                  class="sw-card"
                  :style="{ background: tt.panel, borderColor: tt.key === 'sky' ? '#E7EBEE' : '' }"
                ></span>
                <span class="sw-btn" :style="{ background: tt.primary }"></span>
              </span>
            </div>
            <div class="sw-meta">
              <span class="sw-label">{{ tt.label }}</span>
              <span class="sw-desc">{{ tt.desc }}</span>
            </div>
            <span v-if="settings.theme === tt.key" class="sw-check" :style="{ color: tt.primary }">
              ✓
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- 语言 -->
    <div v-if="show('language')" class="item">
      <div class="block-title">{{ t('settings.language') }}</div>
      <div class="card sec">
        <p class="muted sub">{{ t('settings.languageDesc') }}</p>
        <div class="toolbar">
          <Select v-model="settings.locale" :options="langOptions" :width="260" />
          <button class="btn" @click="refreshLocales">
            {{ t('settings.languageRefresh') }}
          </button>
          <button class="btn" @click="openLangDir">
            {{ t('settings.languageOpen') }}
          </button>
          <span v-if="i18nDir" class="muted dir">{{ t('settings.languageDir') }}：{{ i18nDir }}</span>
        </div>
      </div>
    </div>

    <!-- 字体大小 -->
    <div v-if="show('font')" class="item">
      <div class="block-title">{{ t('settings.font') }}</div>
      <div class="card sec">
        <p class="muted sub">{{ t('settings.fontDesc') }}</p>
        <div class="font-grid">
          <button
            v-for="f in fontOptions"
            :key="f.key"
            type="button"
            class="font-card"
            :class="{ active: settings.fontSize === f.key }"
            :aria-pressed="settings.fontSize === f.key"
            @click="settings.fontSize = f.key"
          >
            <span class="font-sample" :style="{ fontSize: `${f.px}px` }">Aa</span>
            <span class="font-label">{{ f.label }}</span>
            <span class="font-px">{{ f.px }}px</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 高危偏好 -->
    <div v-if="show('advanced')" class="item">
      <div class="block-title">{{ t('settings.securityAudit') }}</div>
      <div class="card sec">
        <div class="row">
          <div>
            <div>{{ t('settings.purge') }}</div>
            <div class="muted">{{ t('settings.purgeDesc') }}</div>
          </div>
          <Switch v-model="settings.allowPurge" />
        </div>

        <div class="row">
          <div>
            <div>{{ t('settings.audit') }}</div>
            <div class="muted">{{ t('settings.auditDescPrefix') }}：{{ auditPath }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 程序完整性校验（需联网，与官方发布值比对） -->
    <div v-if="show('advanced')" class="item">
      <div class="block-title">{{ t('settings.verify') }}</div>
      <div class="card sec">
        <p class="muted sub">{{ t('settings.verifyDesc') }}</p>
        <div class="toolbar">
          <button class="btn btn-primary" :disabled="verifying" @click="runVerify">
            <span v-if="verifying" class="spinner"></span>
            {{ verifying ? t('settings.verifying') : t('settings.verifyBtn') }}
          </button>

          <!--
            上次校验记录：只在校验过（且拿到确定结论）时才出现。
            通过=绿色对号；未通过=红色叹号，悬停提示"程序可能被篡改，请谨慎使用"。
            这里刻意不展示哈希值 / 诊断明细，避免把内部信息铺在页面上。
          -->
          <span v-if="lastVerify" class="vlast">
            <span class="vlast-text">{{ lastVerifyText }}</span>
            <span
              v-if="lastVerify.code === 'OK'"
              class="vicon is-ok"
              :title="t('settings.verify.short.OK')"
            >
              <CheckCircle2 :size="17" />
            </span>
            <span
              v-else
              class="vicon is-bad"
              :title="t('settings.verify.tamperTip')"
            >
              <AlertTriangle :size="17" />
            </span>
          </span>
        </div>
      </div>
    </div>

    <!-- 校验结果对话框：所有返回信息都收敛到这里，页面上不再直接铺开 -->
    <Modal
      v-model:open="verifyDialog"
      :title="t('settings.verify.dialogTitle')"
      width="440px"
    >
      <div v-if="verifyResult" class="vdlg">
        <div class="vdlg-icon" :class="codeClass(verifyResult.code)">
          <CheckCircle2 v-if="verifyResult.code === 'OK'" :size="30" />
          <AlertTriangle v-else :size="30" />
        </div>
        <div class="vdlg-main">
          <div class="vdlg-title" :class="codeClass(verifyResult.code)">
            {{ t('settings.verify.' + verifyResult.code) }}
          </div>
          <div v-if="dialogMsg && dialogMsg !== t('settings.verify.' + verifyResult.code)" class="vdlg-sub">
            {{ dialogMsg }}
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-primary" @click="verifyDialog = false">
          {{ t('common.close') }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* 分区间距：整页模式用 margin；嵌入对话框用 flex gap ——
   这样 v-show 隐藏的分区不占位，多分区（如通用设置）之间也有间距。 */
/* 每项（标题 + 框）之间的间距：整页用 margin，嵌入对话框用 .embedded 的 flex gap */
.item {
  margin-top: 14px;
}
.embedded {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.embedded .item {
  margin-top: 0;
}
.block-title {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 600;
  color: var(--title);
  /* 标题在框外上方，与框之间留间距（不压边框线、无背景） */
  margin-bottom: 8px;
}
.sub {
  margin: 3px 0 10px;
  font-size: calc(12px * var(--fs-scale));
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dir {
  font-size: calc(12px * var(--fs-scale));
  word-break: break-all;
}
/* 字体大小：四档卡片，Aa 用各自等效字号预览 */
.font-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.font-card {
  position: relative;
  border: 1.5px solid var(--border);
  background: var(--panel);
  border-radius: 9px;
  padding: 10px 8px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  transition: border-color 0.15s, box-shadow 0.15s;
  font-family: inherit;
}
.font-card:hover {
  border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
}
.font-card.active {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 25%, transparent);
}
.font-sample {
  font-weight: 700;
  color: var(--primary);
  line-height: 1.2;
}
.font-label {
  font-size: calc(12px * var(--fs-scale));
  font-weight: 600;
  color: var(--text);
}
.font-px {
  font-size: calc(11px * var(--fs-scale));
  color: var(--muted);
}
.theme-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.theme-card {
  position: relative;
  border: 1.5px solid var(--border);
  background: var(--panel);
  border-radius: 9px;
  padding: 8px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.15s, box-shadow 0.15s;
  font-family: inherit;
}
.theme-card:hover {
  border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
}
.theme-card.active {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 25%, transparent);
}
.swatch {
  display: flex;
  height: 46px;
  border-radius: 7px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.sw-side {
  width: 22px;
  flex-shrink: 0;
}
.sw-content {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
}
.sw-card {
  flex: 1;
  height: 26px;
  border-radius: 4px;
  border: 1px solid transparent;
}
.sw-btn {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  flex-shrink: 0;
}
.sw-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}
.sw-label {
  font-size: calc(12px * var(--fs-scale));
  font-weight: 600;
  color: var(--text);
}
.sw-desc {
  font-size: calc(11px * var(--fs-scale));
  color: var(--muted);
}
.sw-check {
  position: absolute;
  top: 5px;
  right: 7px;
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
}
.row {
  font-size: calc(13px * var(--fs-scale));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 2px;
  border-bottom: 1px solid var(--border);
}
.row:last-child {
  border-bottom: none;
}
/* ---------------- 程序完整性校验 ---------------- */
.is-ok {
  color: var(--success);
}
.is-bad {
  color: var(--danger);
}
.is-warn {
  color: #d98324;
}
/* 上次校验记录：时间 + 结果图标，与按钮同一行 */
.vlast {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
}
.vlast-text {
  color: var(--muted);
}
.vicon {
  display: inline-flex;
  align-items: center;
  cursor: help;
}
/* 校验结果对话框：图标 + 一句话结论 */
.vdlg {
  display: flex;
  align-items: center;
  gap: 14px;
}
.vdlg-icon {
  display: inline-flex;
  flex: none;
}
.vdlg-main {
  min-width: 0;
}
.vdlg-title {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 600;
  line-height: 1.5;
}
.vdlg-sub {
  margin-top: 4px;
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
  line-height: 1.5;
}
</style>
