<script setup lang="ts">
import { ref, computed } from "vue";
import {
  scanSocial,
  cancelScanSocial,
  deleteSocial,
  formatSize,
  type SocialItem,
  type SocialLevel,
} from "../api/electron";
import { recordScan } from "../stores/history";
import LastScan from "../components/LastScan.vue";
import OpenFolder from "../components/OpenFolder.vue";
import Modal from "../components/Modal.vue";
import EmptyState from "../components/EmptyState.vue";
import { MessageCircle, SearchX } from "@lucide/vue";

/** 四级风险元信息（与 engine/social.ts 的 LEVEL_META 保持一致）。 */
const LEVELS: Record<
  SocialLevel,
  {
    order: number;
    label: string;
    desc: string;
    color: string;
    recommend: boolean;
    locked: boolean;
  }
> = {
  safe: {
    order: 1,
    label: "① 安全 · 临时缓存",
    desc: "可自动重建，放心删（Cache / Temp）",
    color: "var(--success)",
    recommend: true,
    locked: false,
  },
  advise: {
    order: 2,
    label: "② 建议 · 图片缓存",
    desc: "通常可释放，软件会按需重新拉取（图片）",
    color: "var(--primary)",
    recommend: true,
    locked: false,
  },
  caution: {
    order: 3,
    label: "③ 谨慎 · 视频/接收文件",
    desc: "可能还有用（聊天视频 / 接收的文件），默认不勾",
    color: "var(--warn, #d98324)",
    recommend: false,
    locked: false,
  },
  locked: {
    order: 4,
    label: "④ 锁定 · 聊天记录",
    desc: "永久不可选，绝不提供删除入口（Msg*.db）",
    color: "var(--danger)",
    recommend: false,
    locked: true,
  },
};

const LEVEL_ORDER: SocialLevel[] = ["safe", "advise", "caution", "locked"];

/**
 * 支持的社交软件（固定顺序，与 engine/social.ts 的 APPS 保持一致：微信在最前）。
 * 用于扫描结果「按软件排列」—— 未检测到缓存的软件也占位显示「0」。
 */
const SOCIAL_APPS: string[] = [
  "微信",
  "QQ",
  "钉钉",
  "企业微信",
  "飞书",
  "微博桌面",
  "抖音聊天",
  "YY语音",
  "陌陌",
  "Soul",
  "千牛",
];

/**
 * 各社交软件对应的品牌代表图标（emoji）。
 * 说明：项目图标库 @lucide/vue 不含任何品牌 Logo（微信/QQ 等均无），
 * 故这里用「品牌代表性 emoji」做区分 —— 在 Windows Chromium 上会渲染为彩色表情。
 * 微信用 💬（对话气泡）、QQ 🐧（企鹅）、微博 🐦、YY 🎤、Soul 💜 等，一眼可辨。
 */
const APP_ICON: Record<string, string> = {
  微信: "💬",
  QQ: "🐧",
  钉钉: "🔔",
  企业微信: "💼",
  飞书: "🪶",
  微博桌面: "🐦",
  抖音聊天: "🎵",
  YY语音: "🎤",
  陌陌: "📍",
  Soul: "💜",
  千牛: "🛒",
};

const items = ref<SocialItem[]>([]);
const selected = ref<Record<string, boolean>>({});
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const result = ref<{ deleted: number; size: number; skipped: number } | null>(
  null,
);
/** 两步确认：第一次点击进入待确认态 */
const confirming = ref(false);
/** 清理完成提示对话框（重新扫描 / 暂不） */
const showDone = ref(false);
/** 是否已执行过一次扫描（控制「按软件排列」列表的显隐，避免未扫描时列出一堆 0） */
const scanned = ref(false);

/** 按全部软件固定排列：微信在最前，未检测到的软件也占位显示「0」。 */
const appGroups = computed(() => {
  const map = new Map<string, SocialItem[]>();
  for (const it of items.value) {
    const arr = map.get(it.app);
    if (arr) arr.push(it);
    else map.set(it.app, [it]);
  }
  return SOCIAL_APPS.map((app) => {
    const list = map.get(app) ?? [];
    const sorted = [...list].sort(
      (a, b) =>
        LEVELS[a.level].order - LEVELS[b.level].order || b.size - a.size,
    );
    return {
      app,
      items: sorted,
      total: list.reduce((a, b) => a + b.size, 0),
      lockedSize: list
        .filter((i) => i.locked)
        .reduce((a, b) => a + b.size, 0),
      empty: list.length === 0,
    };
  });
});

const selectedIds = computed(() =>
  items.value.filter((i) => selected.value[i.id] && !i.locked).map((i) => i.id),
);
const selectedBytes = computed(() =>
  items.value
    .filter((i) => selected.value[i.id] && !i.locked)
    .reduce((a, b) => a + b.size, 0),
);
const lockedBytes = computed(() =>
  items.value.filter((i) => i.locked).reduce((a, b) => a + b.size, 0),
);
const totalBytes = computed(() =>
  items.value.reduce((a, b) => a + b.size, 0),
);

async function doScan() {
  loading.value = true;
  error.value = "";
  result.value = null;
  confirming.value = false;
  scanned.value = false;
  items.value = [];
  selected.value = {};
  try {
    const all = await scanSocial((it) => {
      items.value.unshift(it);
      // 默认勾选规则：安全 / 建议 默认勾，谨慎默认不勾，锁定项永不可勾
      if (!it.locked && LEVELS[it.level].recommend) {
        selected.value[it.id] = true;
      }
    });
    items.value = all;
    selected.value = {};
    for (const it of all) {
      if (!it.locked && LEVELS[it.level].recommend) selected.value[it.id] = true;
    }
    void recordScan('social', `${items.value.length} 项 · ${formatSize(totalBytes.value)}`);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    scanned.value = true;
  }
}

function toggleLevel(level: SocialLevel, on: boolean) {
  for (const it of items.value) {
    if (it.locked || it.level !== level) continue;
    selected.value[it.id] = on;
  }
}

function levelSelectedCount(level: SocialLevel) {
  return items.value.filter(
    (i) => i.level === level && !i.locked && selected.value[i.id],
  ).length;
}

function levelTotalCount(level: SocialLevel) {
  return items.value.filter((i) => i.level === level && !i.locked).length;
}

async function doDelete() {
  const ids = selectedIds.value;
  if (!ids.length) {
    error.value = "没有选择要清理的缓存项。";
    return;
  }
  if (!confirming.value) {
    confirming.value = true;
    return;
  }
  const hasCaution = items.value.some(
    (i) => selected.value[i.id] && i.level === "caution",
  );
  const tip = hasCaution
    ? `注意：勾选中包含「谨慎 · 视频/接收文件」，其中的聊天视频、接收的文档等删除后无法恢复。\n\n确认将 ${ids.length} 项（${formatSize(selectedBytes.value)}）移入回收站？`
    : `确认将 ${ids.length} 项（${formatSize(selectedBytes.value)}）移入回收站？聊天记录不会被触碰。`;
  if (!confirm(tip)) {
    confirming.value = false;
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const res = await deleteSocial(ids, false);
    result.value = {
      deleted: res.deleted_count,
      size: res.deleted_size,
      skipped: res.skipped.length,
    };
    if (res.errors.length) {
      error.value = res.errors.slice(0, 3).join("；");
    }
    // 清理后移除已成功的条目，保留剩余
    const done = new Set(
      items.value
        .filter((i) => ids.includes(i.id))
        .filter((i) => !res.skipped.some((s) => s.id === i.id))
        .map((i) => i.id),
    );
    items.value = items.value.filter((i) => !done.has(i.id));
    confirming.value = false;
    // 清理完成弹出「重新扫描 / 暂不」提示
    showDone.value = true;
  } catch (e: any) {
    error.value = `清理失败：${String(e)}`;
    confirming.value = false;
  } finally {
    busy.value = false;
  }
}

function doneRescan() {
  showDone.value = false;
  doScan();
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon"><MessageCircle :size="20" class="title-icon" />社交软件专清</h1>
    <p class="muted">
      支持 {{ SOCIAL_APPS.join(' / ') }} 共 {{ SOCIAL_APPS.length }} 款，默认路径自动搜寻。缓存按四级风险分级，<b>聊天记录数据库（Msg*.db）永久锁死，绝不提供删除入口</b>。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="doScan">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "扫描中…" : "扫描社交软件缓存" }}
        </button>
        <button v-if="loading" class="btn" @click="cancelScanSocial">
          取消
        </button>
        <span class="muted" v-if="items.length">
          共 {{ items.length }} 项 · 合计 {{ formatSize(totalBytes) }} ·
          聊天记录 {{ formatSize(lockedBytes) }}（已锁定）
        </span>
        <LastScan module="social" />
      </div>
      <div v-if="loading || busy" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <!-- 四级风险图例 -->
      <div class="legend">
        <div v-for="lv in LEVEL_ORDER" :key="lv" class="legend-item">
          <span class="dot" :style="{ background: LEVELS[lv].color }" />
          <div class="legend-text">
            <div class="legend-title" :style="{ color: LEVELS[lv].color }">
              {{ LEVELS[lv].label }}
            </div>
            <div class="muted small">{{ LEVELS[lv].desc }}</div>
          </div>
          <span class="spacer" />
          <label v-if="!LEVELS[lv].locked" class="chk">
            <input
              type="checkbox"
              :checked="
                levelSelectedCount(lv) > 0 &&
                levelSelectedCount(lv) === levelTotalCount(lv)
              "
              :disabled="levelTotalCount(lv) === 0"
              @change="toggleLevel(lv, ($event.target as HTMLInputElement).checked)"
            />
            <span class="muted small">
              {{ levelSelectedCount(lv) }} / {{ levelTotalCount(lv) }}
            </span>
          </label>
          <span v-else class="lock-tag">永不可选</span>
        </div>
      </div>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="result" class="ok">
        已移入回收站 {{ result.deleted }} 个文件，释放
        {{ formatSize(result.size) }}<span v-if="result.skipped">
          ；受保护或已拦截 {{ result.skipped }} 项</span
        >。聊天记录未受影响。
      </div>

      <div v-if="scanned && items.length" class="list fill-list">
        <div v-for="g in appGroups" :key="g.app" class="app-card">
          <div class="app-head">
            <span class="app-emoji">{{ APP_ICON[g.app] }}</span>
            <span class="app-name">{{ g.app }}</span>
            <span class="badge">{{ g.items.length }} 项</span>
            <span class="muted">{{ formatSize(g.total) }}</span>
            <span v-if="g.lockedSize" class="muted small">
              其中聊天记录 {{ formatSize(g.lockedSize) }} 已锁定
            </span>
          </div>
          <template v-if="!g.empty">
            <div v-for="it in g.items" :key="it.id" class="row">
              <label class="chk" :class="{ disabled: it.locked }">
                <input
                  type="checkbox"
                  v-model="selected[it.id]"
                  :disabled="it.locked"
                />
              </label>
              <span
                class="lv-tag"
                :style="{
                  color: LEVELS[it.level].color,
                  borderColor: LEVELS[it.level].color,
                }"
              >
                {{ it.locked ? "锁定" : LEVELS[it.level].label.slice(0, 2) }}
              </span>
              <div class="info">
                <div class="name">
                  {{ it.name }}
                  <span class="muted small">{{ it.fileCount }} 个文件</span>
                </div>
                <div class="path muted small" :title="it.path">{{ it.path }}</div>
              </div>
              <span class="spacer" />
              <span class="size">{{ formatSize(it.size) }}</span>
              <OpenFolder :path="it.path" />
            </div>
          </template>
          <p v-else class="muted small empty-note">未检测到可清理缓存（0）</p>
        </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="MessageCircle"
        title="扫描中……"
      />
      <EmptyState
        v-else-if="!scanned"
        :icon="MessageCircle"
        title="暂未扫描"
        desc="点击「开始扫描」检测微信、QQ 等社交软件的可清理缓存。"
      />
      <EmptyState
        v-else
        :icon="SearchX"
        title="未发现对应记录"
        desc="未检测到上述社交软件的可清理缓存。"
      />

      <div v-if="items.length" class="actions">
        <button
          class="btn"
          :class="confirming ? 'btn-danger' : 'btn-primary'"
          :disabled="busy || selectedIds.length === 0"
          @click="doDelete"
        >
          <template v-if="busy">清理中…</template>
          <template v-else-if="confirming">再次点击确认清理</template>
          <template v-else>
            清理选中缓存（{{ selectedIds.length }} ·
            {{ formatSize(selectedBytes) }}）
          </template>
        </button>
        <span class="muted">默认移入回收站，可从回收站还原；聊天记录永不被清理。</span>
      </div>
    </div>

    <!-- 清理完成提示：重新扫描 / 暂不 -->
    <Modal
      :open="showDone"
      title="清理完成"
      width="420px"
      @update:open="showDone = $event"
    >
      <template v-if="result">
        <p>
          已移入回收站 <b>{{ result.deleted }}</b> 个文件，释放
          {{ formatSize(result.size) }}
        </p>
        <p v-if="result.skipped" class="muted">
          受保护或已拦截 {{ result.skipped }} 项
        </p>
        <p class="muted">聊天记录未受影响。</p>
      </template>
      <template #footer>
        <button class="btn" @click="showDone = false">暂不</button>
        <button class="btn btn-primary" @click="doneRescan">重新扫描</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.h-with-icon {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title-icon {
  flex-shrink: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.spacer {
  flex: 1;
}
.small {
  font-size: calc(11px * var(--fs-scale));
}
.legend {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--bg);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.legend-text {
  min-width: 0;
}
.legend-title {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
}
.lock-tag {
  font-size: calc(11px * var(--fs-scale));
  color: var(--danger);
  border: 1px dashed var(--danger);
  border-radius: 6px;
  padding: 2px 8px;
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(13px * var(--fs-scale));
  flex-shrink: 0;
}
.chk.disabled {
  opacity: 0.4;
}
.list {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.app-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
}
.app-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.empty-note {
  margin: 2px 2px 4px;
}
.app-name {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
}
.app-emoji {
  font-size: calc(16px * var(--fs-scale));
  line-height: 1;
  flex-shrink: 0;
}
.badge {
  background: var(--primary-weak);
  color: var(--primary);
  border-radius: 6px;
  padding: 2px 10px;
  font-size: calc(12px * var(--fs-scale));
  font-weight: 600;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 2px;
  border-top: 1px solid var(--border);
}
.lv-tag {
  flex-shrink: 0;
  font-size: calc(11px * var(--fs-scale));
  font-weight: 700;
  border: 1px solid;
  border-radius: 6px;
  padding: 1px 7px;
}
.info {
  min-width: 0;
}
.name {
  font-size: calc(13px * var(--fs-scale));
}
.path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 46vw;
}
.size {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  flex-shrink: 0;
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
  margin-top: 10px;
}
.ok {
  color: var(--success);
  font-size: calc(13px * var(--fs-scale));
  margin-top: 10px;
}
</style>
