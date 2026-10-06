<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import { MessageSquare, Send, RefreshCw, CheckCircle2, QrCode } from '@lucide/vue'
import Select from '../components/Select.vue'
import {
  fetchCommunity,
  submitFeedback,
  type Community,
  type FeedbackItem,
  type GroupInfo as FeedbackGroup,
} from '../api/electron'
import { t } from '../stores/i18n'

/** embedded=true：作为「设置」对话框里的一页，隐藏页面标题与副标题。 */
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const name = ref('')
const fbType = ref('other')
const contact = ref('')
const content = ref('')
const submitting = ref(false)
const submitMsg = ref('')
const submitOk = ref(false)

// 反馈类型：功能建议 / Bug 反馈 / 其他（默认其他）
const typeOptions = computed(() => [
  { value: 'suggest', label: t('feedback.typeSuggest') },
  { value: 'bug', label: t('feedback.typeBug') },
  { value: 'other', label: t('feedback.typeOther') },
])

const loading = ref(false)
const refreshing = ref(false)
const community = ref<Community>({ donations: [], groups: [], feedbacks: [], qrs: [] })
const error = ref('')

async function loadCommunity(isRefresh = false) {
  if (isRefresh) refreshing.value = true
  else loading.value = true
  error.value = ''
  try {
    community.value = await fetchCommunity()
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e)
  } finally {
    // 轮询会换掉整个 groups 数组；tip 正开着时同步一下引用，避免指向旧对象
    if (qrTip.value) {
      const cur = qrTip.value.group
      const next = (community.value.groups as FeedbackGroup[]).find((g) => g.name === cur.name)
      if (next) qrTip.value.group = next
    }
    loading.value = false
    refreshing.value = false
  }
}

// 群聊信息「实时」刷新：每 30 秒拉取一次远程
let timer = 0
function stopTimer() {
  if (timer) window.clearInterval(timer)
  timer = 0
}
onMounted(() => {
  void loadCommunity()
  timer = window.setInterval(() => void loadCommunity(true), 30000)
  // 页面滚动 / 窗口变化后锚点位置就失效了，直接收起 tip（capture 才能捕获滚动容器）
  window.addEventListener('scroll', hideTip, true)
  window.addEventListener('resize', hideTip)
})
// 页面被缓存（KeepAlive 切走）时也要停轮询，否则后台持续发请求
onDeactivated(() => {
  stopTimer()
  hideTip()
})
// 重新激活时恢复轮询
onActivated(() => {
  void loadCommunity(true)
  if (!timer) timer = window.setInterval(() => void loadCommunity(true), 30000)
})
onBeforeUnmount(() => {
  stopTimer()
  window.removeEventListener('scroll', hideTip, true)
  window.removeEventListener('resize', hideTip)
})

async function onSubmit() {
  if (!name.value.trim() || !content.value.trim() || submitting.value) return
  submitting.value = true
  submitMsg.value = ''
  submitOk.value = false
  try {
    const r = await submitFeedback({
      name: name.value.trim(),
      type: fbType.value,
      contact: contact.value.trim() || undefined,
      content: content.value.trim(),
    })
    submitOk.value = r.ok
    submitMsg.value = r.message
    if (r.ok) {
      name.value = ''
      fbType.value = 'other'
      content.value = ''
      contact.value = ''
    }
  } catch (e) {
    submitOk.value = false
    submitMsg.value = String(e instanceof Error ? e.message : e)
  } finally {
    submitting.value = false
  }
}

// 群类型 → 中文标签 / 颜色
function groupBadge(type: string): { label: string; cls: string } {
  switch (type) {
    case 'qq':
      return { label: 'QQ', cls: 'badge-qq' }
    case 'wechat':
      return { label: '微信', cls: 'badge-wx' }
    case 'telegram':
      return { label: 'Telegram', cls: 'badge-tg' }
    case 'discord':
      return { label: 'Discord', cls: 'badge-dc' }
    default:
      return { label: '群', cls: 'badge-other' }
  }
}

/** 哪些群类型的整张卡片可悬停弹出二维码 tip（远程提供 qr 则显示图片，否则占位示意）。 */
function hasQr(type: string): boolean {
  return type === 'qq' || type === 'wechat'
}

/**
 * 界面展示的群列表：过滤掉 hidden 的项。
 * 「隐藏」而非删除——数据里仍保留（如微信群），把 remote.ts 的 hidden 改回 false 即可恢复显示。
 */
const visibleGroups = computed(() =>
  (community.value.groups as FeedbackGroup[]).filter((g) => !g.hidden),
)

/**
 * 群二维码悬停 tip：鼠标移到缩略图上即显示加群二维码。
 *
 * ⚠️ 不要用普通 `position:absolute` 浮层——它会被祖先滚动容器裁掉（设置对话框
 * 的 `.sd-main{overflow-y:auto}` 就是坑，之前显示不全的根因）。这里用 Teleport
 * 到 body + `position:fixed` + 手动算坐标并夹进视口，任何容器都裁不到它。
 */
const qrTip = ref<{ group: FeedbackGroup; x: number; y: number } | null>(null)
const tipBox = ref<HTMLElement | null>(null)

/** 把浮层摆到锚点上方（放不下则下方），并夹进视口内。 */
function placeTip(anchor: DOMRect) {
  const w = tipBox.value?.offsetWidth ?? 200
  const h = tipBox.value?.offsetHeight ?? 250
  const gap = 8
  let x = anchor.left + anchor.width / 2 - w / 2
  let y = anchor.top - h - gap
  if (y < gap) y = anchor.bottom + gap
  x = Math.min(Math.max(gap, x), Math.max(gap, window.innerWidth - w - gap))
  y = Math.min(Math.max(gap, y), Math.max(gap, window.innerHeight - h - gap))
  if (qrTip.value) {
    qrTip.value.x = Math.round(x)
    qrTip.value.y = Math.round(y)
  }
}

async function showTip(g: FeedbackGroup, e: MouseEvent) {
  const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect()
  // 先离屏渲染，量出真实尺寸后再摆位，避免闪一下错误位置
  qrTip.value = { group: g, x: -9999, y: -9999 }
  await nextTick()
  placeTip(anchor)
}

function hideTip() {
  qrTip.value = null
}
</script>

<template>
  <div>
    <template v-if="!props.embedded">
      <h1>{{ t('feedback.title') }}</h1>
      <p class="muted">{{ t('feedback.subtitle') }}</p>
    </template>

    <div class="items">
    <!-- 反馈表单 -->
    <div class="item">
      <div class="block-title">{{ t('feedback.formTitle') }}</div>
      <div class="card">
        <div class="form">
          <div class="form-row">
            <div class="fld-col">
              <label class="fld-label">{{ t('feedback.name') }}</label>
              <input
                v-model="name"
                class="fld"
                :placeholder="t('feedback.namePh')"
                maxlength="30"
              />
            </div>
            <div class="fld-col">
              <label class="fld-label">{{ t('feedback.type') }}</label>
              <Select v-model="fbType" :options="typeOptions" :width="180" />
            </div>
          </div>
          <input
            v-model="contact"
            class="fld"
            :placeholder="t('feedback.contact')"
            maxlength="60"
          />
          <textarea
            v-model="content"
            class="fld area"
            rows="4"
            :placeholder="t('feedback.contentPh')"
            maxlength="1000"
          ></textarea>
          <div class="form-foot">
            <span
              v-if="submitMsg"
              class="submit-msg"
              :class="{ ok: submitOk, bad: !submitOk }"
            >
              <CheckCircle2 v-if="submitOk" :size="14" /> {{ submitMsg }}
            </span>
            <button
              class="btn btn-primary"
              :disabled="!name.trim() || !content.trim() || submitting"
              @click="onSubmit"
            >
              <span v-if="submitting" class="spinner"></span>
              <Send v-else :size="14" />
              {{ submitting ? t('feedback.submitting') : t('feedback.submit') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 已反馈列表（方便手机 / 桌面查看） -->
    <div class="item">
      <div class="block-title">{{ t('feedback.listTitle') }}</div>
      <div class="card">
        <p v-if="loading" class="muted">{{ t('feedback.loading') }}</p>
        <p v-else-if="error" class="err">{{ error }}</p>
        <p v-else-if="!community.feedbacks.length" class="muted">
          {{ t('feedback.empty') }}
        </p>
        <ul v-else class="fb-list">
          <li v-for="(f, i) in community.feedbacks as FeedbackItem[]" :key="i" class="fb-item">
            <div class="fb-head">
              <span class="fb-name">{{ f.name || t('feedback.anonymous') }}</span>
              <span class="fb-date muted">{{ f.date }}</span>
            </div>
            <div class="fb-content">{{ f.content }}</div>
            <div v-if="f.reply" class="fb-reply">
              <MessageSquare :size="12" /> {{ t('feedback.reply') }}：{{ f.reply }}
            </div>
          </li>
        </ul>
      </div>
    </div>

    <!-- 底部：群聊信息，可实时获取远程 -->
    <div class="item">
      <div class="block-title row">
        <span>{{ t('feedback.groupsTitle') }}</span>
        <button class="btn" :disabled="refreshing" @click="loadCommunity(true)">
          <RefreshCw :size="13" :class="{ spin: refreshing }" />
          {{ refreshing ? t('feedback.refreshing') : t('feedback.refresh') }}
        </button>
      </div>
      <div class="card">
        <p class="muted sub">{{ t('feedback.groupNote') }}</p>
        <div v-if="visibleGroups.length" class="group-grid">
          <!--
            整个群卡片都是悬停触发区：鼠标移到卡片任意位置（除链接）都弹出二维码。
            卡片内不再放缩略图 / 提示文字，加群方式写在 note 里。
            浮层 Teleport 到 body + fixed 定位（见 showTip 注释），不会被滚动容器裁剪。
          -->
          <div
            v-for="(g, i) in visibleGroups"
            :key="i"
            class="group-card"
            :class="{ 'qr-hoverable': hasQr(g.type) }"
            @mouseenter="hasQr(g.type) && showTip(g, $event)"
            @mouseleave="hideTip()"
          >
            <span class="g-badge" :class="groupBadge(g.type).cls">
              {{ groupBadge(g.type).label }}
            </span>
            <div class="g-name">{{ g.name }}</div>
            <div class="g-note muted">{{ g.note }}</div>
            <a v-if="g.link" class="g-link" :href="g.link" target="_blank" rel="noreferrer">
              {{ t('feedback.join') }}
            </a>
          </div>
        </div>
        <p v-else class="muted">{{ t('feedback.noGroups') }}</p>
      </div>
    </div>
    </div>

    <!-- 悬停浮层：Teleport 到 body，免受任何祖先 overflow 裁剪 -->
    <Teleport to="body">
      <div
        v-if="qrTip"
        ref="tipBox"
        class="qr-tip-pop"
        :style="{ left: qrTip.x + 'px', top: qrTip.y + 'px' }"
      >
        <div class="qr-tip-img" :class="{ 'qr-real': !!qrTip.group.qr }">
          <img v-if="qrTip.group.qr" class="qr-img" :src="qrTip.group.qr" :alt="qrTip.group.name" />
          <QrCode v-else :size="40" />
        </div>
        <p class="qr-tip-name">{{ qrTip.group.name }}</p>
        <p v-if="!qrTip.group.qr" class="qr-tip-note muted">{{ t('feedback.qrTip') }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.block-title {
  font-size: calc(15px * var(--fs-scale));
  font-weight: 600;
  color: var(--title);
  margin-bottom: 12px;
}
/* 各「项」之间的统一间距（标题在框外上方，框只包内容） */
.items {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.block-title.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sub {
  margin: 4px 0 14px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 560px;
}
/* 称呼 + 反馈类型一行两列 */
.form-row {
  display: flex;
  gap: 10px;
}
.fld-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.fld-label {
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
}
.fld {
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel);
  color: var(--text);
  font-family: inherit;
  font-size: calc(14px * var(--fs-scale));
  padding: 9px 11px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.fld:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
  box-shadow: 0 0 0 3px var(--primary-weak);
}
.area {
  resize: vertical;
  line-height: 1.55;
}
.form-foot {
  display: flex;
  align-items: center;
  gap: 12px;
}
.submit-msg {
  font-size: calc(13px * var(--fs-scale));
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.submit-msg.ok {
  color: var(--success);
}
.submit-msg.bad {
  color: var(--danger);
}
.fb-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.fb-item {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
}
.fb-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.fb-name {
  font-weight: 600;
  color: var(--text);
  font-size: calc(13px * var(--fs-scale));
}
.fb-date {
  font-size: calc(12px * var(--fs-scale));
}
.fb-content {
  margin-top: 4px;
  line-height: 1.55;
  font-size: calc(13px * var(--fs-scale));
}
.fb-reply {
  margin-top: 6px;
  font-size: calc(12px * var(--fs-scale));
  color: var(--primary);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.group-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.group-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.g-badge {
  align-self: flex-start;
  font-size: calc(11px * var(--fs-scale));
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  color: #fff;
}
.badge-qq {
  background: #12b7f5;
}
.badge-wx {
  background: #07c160;
}
.badge-tg {
  background: #229ed9;
}
.badge-dc {
  background: #5865f2;
}
.badge-other {
  background: var(--muted);
}
.g-name {
  font-weight: 600;
  color: var(--title);
  font-size: calc(14px * var(--fs-scale));
}
.g-note {
  font-size: calc(12px * var(--fs-scale));
  line-height: 1.5;
}
/* 带二维码的群：整张卡片可悬停，hover 给个描边提示这里可以扫出来二维码 */
.group-card.qr-hoverable {
  cursor: default;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.group-card.qr-hoverable:hover {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-weak);
}
/* 悬停浮层本体（Teleport 到 body，必须用 fixed + z-index 才压得住一切容器） */
.qr-tip-pop {
  position: fixed;
  /* 必须高于 Modal 的遮罩（9999）：本页也嵌在「设置」对话框里，
     z-index 低了会被对话框遮罩整个盖住，看起来就像没弹出来 */
  z-index: 10000;
  pointer-events: none;
  /* 无边框窗口：祖先若有 drag 区域会吞鼠标事件，这里显式关掉 */
  -webkit-app-region: no-drag;
  width: 190px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  animation: qr-pop-in 0.12s ease-out;
}
.qr-tip-img {
  width: 168px;
  height: 168px;
  border: 1.5px dashed var(--border);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: var(--bg);
}
.qr-tip-img.qr-real {
  border-style: solid;
  background: #fff;
  padding: 8px;
}
.qr-tip-name {
  margin: 0;
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  color: var(--title);
  text-align: center;
}
.qr-tip-note {
  margin: 0;
  font-size: calc(11px * var(--fs-scale));
  text-align: center;
  line-height: 1.4;
}
@keyframes qr-pop-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.qr-img {
  width: 100%;
  height: 100%;
  /* 用 contain：二维码多为带留白的方形图，cover 会把上下/左右裁掉导致扫不出来 */
  object-fit: contain;
  border-radius: 8px;
}
.g-link {
  margin-top: 2px;
  font-size: calc(12px * var(--fs-scale));
  color: var(--primary);
  text-decoration: none;
  font-weight: 600;
}
.g-link:hover {
  text-decoration: underline;
}
.spin {
  animation: spinner-rot 0.7s linear infinite;
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
}
@keyframes spinner-rot {
  to {
    transform: rotate(360deg);
  }
}
</style>
