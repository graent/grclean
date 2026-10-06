<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { QrCode, Heart } from '@lucide/vue'
import {
  fetchCommunity,
  fetchDonateQr,
  type DonationItem,
  type DonateQrResult,
} from '../api/electron'
import Modal from '../components/Modal.vue'
import { t } from '../stores/i18n'

/** embedded=true：作为「设置」对话框里的一页，隐藏页面标题与副标题。 */
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const loading = ref(false)
const donations = ref<DonationItem[]>([])
const error = ref('')

/**
 * 收款码：不内置在安装包里（asar 可被解包替换后二次分发），也不由渲染层直接请求图片。
 * 走主进程 fetchDonateQr：远程下发的 url + sha256 → 下载 → 校验哈希 → 返回 base64，
 * 校验不通过只回错误码，界面显示占位，绝不显示未经验证的图片。
 */
const qrMap = ref<Record<string, DonateQrResult>>({})

/** 放大查看：当前被点开的平台 key（null = 弹窗关闭）。 */
const zoomKey = ref<string | null>(null)
const zoomOpen = ref(false)
const zoomItem = computed(() => payPlatforms.value.find((p) => p.key === zoomKey.value) ?? null)

const payPlatforms = computed(() => [
  { key: 'alipay', label: t('donate.alipay') },
  { key: 'wechat', label: t('donate.wechat') },
])

/** 点击二维码查看大图（仅已通过哈希校验的图片可放大）。 */
function zoom(k: string) {
  if (!qrMap.value[k]?.ok) return
  zoomKey.value = k
  zoomOpen.value = true
}

const qrOf = (p: string) => qrMap.value[p]

/** 二维码下方文案：有码则展示可核对的收款方，否则说明原因 / 占位提示。 */
function qrTip(p: string): string {
  const r = qrOf(p)
  if (!r) return t('common.loading')
  if (r.ok) {
    const info = [r.payee, r.account].filter(Boolean).join(' · ')
    return info ? `${t('donate.payee')}：${info}` : t('donate.qrHint')
  }
  return t('donate.err.' + r.message)
}

/** 除「尚未配置」外的失败都视为异常（校验失败等），用警示色提示。 */
function qrBad(p: string): boolean {
  const r = qrOf(p)
  return !!r && !r.ok && r.message !== 'NOT_CONFIGURED'
}

async function loadQrs() {
  const list = payPlatforms.value.map((p) =>
    fetchDonateQr(p.key).catch(
      () => ({ ok: false, platform: p.key, message: 'DOWNLOAD_FAILED' }) as DonateQrResult,
    ),
  )
  for (const r of await Promise.all(list)) qrMap.value[r.platform] = r
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const c = await fetchCommunity()
    donations.value = c.donations ?? []
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e)
    donations.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  void loadQrs()
})

// 累计收到金额
const totalAmount = () =>
  donations.value.reduce((s, d) => s + (d.amount || 0), 0)
</script>

<template>
  <div>
    <template v-if="!props.embedded">
      <h1>{{ t('donate.title') }}</h1>
      <p class="muted">{{ t('donate.subtitle') }}</p>
    </template>

    <div class="items">
    <!-- 收款码：远程下发 + SHA-256 校验，校验不通过则显示占位 -->
    <div class="item">
      <div class="block-title">
        {{ t('donate.qrTitle') }}<span class="sub-hint">{{ t('donate.qrTitleTip') }}</span>
      </div>
      <div class="card pay-card">
        <div class="pay-grid">
          <div v-for="p in payPlatforms" :key="p.key" class="qr">
            <div
              class="qr-box"
              :class="{ 'qr-real': qrOf(p.key)?.ok, 'qr-click': qrOf(p.key)?.ok }"
              :title="qrOf(p.key)?.ok ? t('donate.qrHint') : undefined"
              @click="zoom(p.key)"
            >
              <img
                v-if="qrOf(p.key)?.ok"
                class="qr-img"
                :src="qrOf(p.key)?.dataUrl"
                :alt="p.label"
              />
              <template v-else>
                <QrCode :size="64" />
                <span class="qr-label">{{ p.label }}</span>
              </template>
            </div>
            <p class="qr-tip" :class="{ 'qr-bad': qrBad(p.key) }">{{ qrTip(p.key) }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 捐赠记录 -->
    <div class="item">
      <div class="block-title">
        {{ t('donate.listTitle') }}
        <span v-if="donations.length" class="sum">
          · {{ t('donate.total') }} ¥{{ totalAmount() }}
        </span>
      </div>
      <div class="card">
        <div v-if="loading" class="progress toolbar-progress">
          <div class="bar indeterminate"></div>
        </div>

        <p v-else-if="error" class="err">{{ error }}</p>
        <p v-else-if="!donations.length" class="muted">{{ t('donate.empty') }}</p>

        <table v-else class="donate-table">
          <thead>
            <tr>
              <th>{{ t('donate.name') }}</th>
              <th class="num">{{ t('donate.amount') }}</th>
              <th>{{ t('donate.method') }}</th>
              <th>{{ t('donate.date') }}</th>
              <th>{{ t('donate.message') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(d, i) in donations" :key="i">
              <td>{{ d.name }}</td>
              <td class="num">¥{{ d.amount }}</td>
              <td class="muted">{{ d.method || '—' }}</td>
              <td class="muted">{{ d.date }}</td>
              <td class="muted">{{ d.message || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

      <p class="foot muted">
        <Heart :size="13" /> {{ t('donate.thanks') }}
      </p>
    </div>

    <!-- 收款码放大查看 -->
    <Modal v-model:open="zoomOpen" :title="zoomItem?.label ?? ''" width="380px">
      <div class="qr-view">
        <div class="qr-big qr-real">
          <img
            v-if="zoomKey && qrOf(zoomKey)?.dataUrl"
            class="qr-img"
            :src="qrOf(zoomKey)?.dataUrl"
            :alt="zoomItem?.label"
          />
        </div>
        <p class="qr-name">{{ zoomItem?.label }}</p>
        <p class="qr-tip muted">{{ zoomKey ? qrTip(zoomKey) : '' }}</p>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.block-title {
  font-size: calc(15px * var(--fs-scale));
  font-weight: 600;
  color: var(--title);
  margin-bottom: 12px;
}
/* 标题里的小字提示：淡色、常规字重，不喧宾夺主 */
.sub-hint {
  font-size: calc(12px * var(--fs-scale));
  font-weight: 400;
  color: var(--muted);
  margin-left: 2px;
}
.sum {
  font-size: calc(13px * var(--fs-scale));
  color: var(--primary);
  font-weight: 600;
}
.pay-card .pay-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.qr-box {
  width: 160px;
  height: 160px;
  border: 1.5px dashed var(--border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--muted);
  background: var(--bg);
}
.qr-box.qr-real {
  border-style: solid;
  background: #fff;
  padding: 6px;
}
/* 已通过校验的收款码可点击放大 */
.qr-box.qr-click {
  cursor: zoom-in;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.qr-box.qr-click:hover {
  border-color: var(--primary);
  box-shadow: 0 4px 14px rgba(20, 26, 33, 0.14);
}
.qr-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 6px;
}
.qr-label {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  color: var(--text);
}
.qr-tip {
  font-size: calc(11px * var(--fs-scale));
  color: var(--muted);
  text-align: center;
  margin: 0;
  line-height: 1.5;
}
.qr-tip.qr-bad {
  color: var(--danger);
}
/* 弹窗里的放大二维码 */
.qr-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.qr-big {
  width: 260px;
  height: 260px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
  padding: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.qr-big .qr-img {
  border-radius: 8px;
}
.qr-name {
  margin: 0;
  font-size: calc(15px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
}
.donate-table {
  width: 100%;
  border-collapse: collapse;
  font-size: calc(13px * var(--fs-scale));
}
.donate-table th {
  text-align: left;
  color: var(--muted);
  font-weight: 600;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.donate-table td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--border);
}
.donate-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--primary);
  font-weight: 600;
}
/* 各「项」之间的统一间距（标题在框外上方，框只包内容） */
.items {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.foot {
  display: flex;
  align-items: center;
  gap: 6px;
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
}
</style>
