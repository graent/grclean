<script setup lang="ts">
/**
 * 「关于」页：作为「设置」对话框左侧菜单的一项显示（原先是右上角下拉里的独立弹窗）。
 * 同时可作为整页使用（无 embedded 时显示标题）。
 */
import { onMounted, ref } from 'vue'
import { Sparkles, ExternalLink, QrCode, RefreshCw } from '@lucide/vue'
import { getVersion, fetchDonateQr, openExternal, type DonateQrResult } from '../api/electron'
import Modal from '../components/Modal.vue'
import { t } from '../stores/i18n'
import { update, checkForUpdates } from '../stores/update'

withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const version = ref('')

/** 作者信息：博客外链 + 微信公众号（二维码走远程校验通道下发）。 */
const BLOG_URL = 'https://gr.graent.cn/grclean'
const MP_NAME = '极志猿'
const AUTHOR_EMAIL = 'graent.hu@qq.com'
/** 公众号二维码在远程 community.json 里的 qrs platform 键（与收款码同一套校验通道）。 */
const MP_PLATFORM = 'mp'

const mpQr = ref<DonateQrResult | null>(null)
const qrOpen = ref(false)

async function openBlog() {
  try {
    await openExternal(BLOG_URL)
  } catch {
    /* ignore */
  }
}

/** 邮箱：mailto 唤起系统默认邮件客户端（主进程白名单已放行 mailto:）。 */
async function openMail() {
  try {
    await openExternal(`mailto:${AUTHOR_EMAIL}`)
  } catch {
    /* ignore */
  }
}

/** 二维码不下内置进安装包（asar 可被解包替换后二次分发），由主进程下载 + 校验哈希后返回。 */
async function loadMpQr() {
  try {
    mpQr.value = await fetchDonateQr(MP_PLATFORM)
  } catch {
    mpQr.value = { ok: false, platform: MP_PLATFORM, message: 'DOWNLOAD_FAILED' }
  }
}

/** 二维码未就绪时的提示：有错误码则按 i18n 映射，否则显示加载中。 */
function qrTip(): string {
  const r = mpQr.value
  if (!r) return t('common.loading')
  if (r.ok) return t('about.qrHint')
  return t('donate.err.' + r.message)
}

onMounted(async () => {
  try {
    version.value = await getVersion()
  } catch {
    version.value = ''
  }
  void loadMpQr()
})
</script>

<template>
  <div class="items">
    <!-- 关于本程序 -->
    <div class="item">
      <div class="block-title">{{ t('settings.about') }}</div>
      <div class="card">
        <div class="ab">
          <div class="ab-brand">
            <span class="ab-logo"><Sparkles :size="22" /></span>
            <div>
              <div class="ab-name">GrClean</div>
              <div class="ab-slogan muted">{{ t('app.slogan') }}</div>
            </div>
          </div>

          <p class="ab-text">{{ t('settings.aboutText') }}</p>

          <div class="ab-row">
            <span class="ab-key muted">{{ t('settings.version') }}</span>
            <div class="ab-ver">
              <span class="ab-val">v{{ version || '—' }}</span>
              <!-- 检查更新：与右上角下拉里的「检查更新」是同一个弹窗（stores/update.ts） -->
              <button class="ver-check" :disabled="update.checking" @click="void checkForUpdates()">
                <RefreshCw :size="13" :class="{ spin: update.checking }" />
                {{ update.checking ? t('update.checking') : t('nav.update') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 作者信息：博客外链 + 公众号二维码（独立一项，与「关于」分开） -->
    <div class="item">
      <div class="block-title">{{ t('about.authorTitle') }}</div>
      <div class="card">
        <div class="ab">
          <div class="ab-row ab-row-first">
            <span class="ab-key muted">{{ t('about.blog') }}</span>
            <a class="ab-link" href="#" @click.prevent="openBlog">
              {{ BLOG_URL }}
              <ExternalLink :size="13" />
            </a>
          </div>

          <div class="ab-row">
            <span class="ab-key muted">{{ t('about.email') }}</span>
            <a class="ab-link" href="#" @click.prevent="openMail">
              {{ AUTHOR_EMAIL }}
              <ExternalLink :size="13" />
            </a>
          </div>

          <div class="ab-row">
            <span class="ab-key muted">{{ t('about.mp') }}</span>
            <div class="ab-mp">
              <span class="ab-val">{{ MP_NAME }}</span>
              <button
                class="qr-thumb"
                :class="{ 'qr-real': mpQr?.ok }"
                :title="t('about.qrTitle')"
                @click="qrOpen = true"
              >
                <img v-if="mpQr?.ok" class="qr-img" :src="mpQr.dataUrl" :alt="MP_NAME" />
                <QrCode v-else :size="20" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 公众号二维码放大查看 -->
    <Modal v-model:open="qrOpen" :title="t('about.qrTitle')" width="360px">
      <div class="qr-view">
        <div class="qr-big" :class="{ 'qr-real': mpQr?.ok }">
          <img v-if="mpQr?.ok" class="qr-img" :src="mpQr.dataUrl" :alt="MP_NAME" />
          <template v-else>
            <QrCode :size="72" />
          </template>
        </div>
        <p class="qr-name">{{ MP_NAME }}</p>
        <p class="qr-tip muted">{{ qrTip() }}</p>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
/* 各「项」之间统一间距（标题在框外上方，框只包内容） */
.items {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ab {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ab-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ab-logo {
  width: 44px;
  height: 44px;
  border-radius: 11px;
  background: var(--primary);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.ab-name {
  font-size: calc(17px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
  letter-spacing: 0.5px;
}
.ab-slogan {
  font-size: calc(12px * var(--fs-scale));
  margin-top: 2px;
}
.ab-text {
  margin: 0;
  font-size: calc(13px * var(--fs-scale));
  line-height: 1.6;
  color: var(--text);
}
.ab-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
  font-size: calc(13px * var(--fs-scale));
}
/* 作者信息框的第一行上方不再画线（框顶已有边框） */
.ab-row-first {
  border-top: none;
}
.ab-key {
  font-size: calc(12px * var(--fs-scale));
}
.ab-val {
  color: var(--text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
/* 版本号 + 检查更新按钮 */
.ab-ver {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.ver-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--primary);
  border-radius: 7px;
  padding: 4px 9px;
  font-size: calc(12px * var(--fs-scale));
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.ver-check:hover:not(:disabled) {
  background: var(--primary-weak);
  border-color: var(--primary);
}
.ver-check:disabled {
  opacity: 0.6;
  cursor: default;
}
.spin {
  animation: vp-spin 0.7s linear infinite;
}
@keyframes vp-spin {
  to {
    transform: rotate(360deg);
  }
}
/* 博客外链：主色 + 下划线，鼠标悬停加深 */
.ab-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--primary);
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  text-decoration: none;
  border-bottom: 1px dashed color-mix(in srgb, var(--primary) 55%, transparent);
  cursor: pointer;
  word-break: break-all;
  text-align: right;
}
.ab-link:hover {
  color: color-mix(in srgb, var(--primary) 80%, #000);
}
.ab-mp {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
/* 缩略二维码按钮：点开大图 */
.qr-thumb {
  width: 38px;
  height: 38px;
  border: 1.5px dashed var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
}
.qr-thumb.qr-real {
  border-style: solid;
  background: #fff;
  padding: 3px;
}
.qr-thumb:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.qr-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 4px;
}
/* 二维码弹窗内容 */
.qr-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 4px 0 2px;
}
.qr-big {
  width: 220px;
  height: 220px;
  border: 1.5px dashed var(--border);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: var(--bg);
}
.qr-big.qr-real {
  border-style: solid;
  background: #fff;
  padding: 8px;
}
.qr-name {
  margin: 0;
  font-size: calc(14px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
}
.qr-tip {
  margin: 0;
  font-size: calc(12px * var(--fs-scale));
  text-align: center;
  line-height: 1.5;
}
</style>
