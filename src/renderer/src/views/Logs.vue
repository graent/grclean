<script setup lang="ts">
import { FileText, SearchX } from "@lucide/vue";
import { ref, computed, onMounted, watch } from "vue";
import {
  scanLogs,
  cancelScanLogs,
  deleteLogs,
  formatSize,
  listDisks,
  buildScopeOptions,
  getLocal,
  setLocal,
  getCachedDisks,
  setCachedDisks,
  type LogItem,
  type DiskInfo,
} from "../api/electron";
import { recordScan } from "../stores/history";
import LastScan from "../components/LastScan.vue";
import Select from "../components/Select.vue";
import Modal from "../components/Modal.vue";
import EmptyState from "../components/EmptyState.vue";

/** 三组日志（与 engine/logs.ts 的 LOG_GROUP_META 一致）。 */
const GROUPS = [
  { key: "app", label: "应用日志", desc: "软件运行产生的 .log，可安全清理", recommend: true, color: "var(--success)" },
  { key: "temp", label: "临时日志", desc: "临时目录下的日志与调试输出", recommend: true, color: "var(--primary)" },
  {
    key: "crash",
    label: "崩溃转储 / 错误报告",
    desc: "*.dmp 与 WER 报告，体积大但不影响系统",
    recommend: false,
    color: "var(--warn, #d98324)",
  },
] as const;

const SCOPE_KEY = "grclean.scope.logs";

const items = ref<LogItem[]>([]);
const selected = ref<Record<string, boolean>>({});
const loading = ref(false);
/** 是否已执行过一次扫描（区分「暂未扫描」与「已扫描无结果」两种空态） */
const scanned = ref(false);
const busy = ref(false);
const error = ref("");
const result = ref<{ deleted: number; size: number } | null>(null);
const confirming = ref(false);
/** 清理完成提示对话框（重新扫描 / 暂不） */
const showDone = ref(false);
const minDays = ref(0);

/** 扫描范围：'C'/'D'…=指定盘符；'all'=全部盘符。默认系统盘，已持久化记忆。 */
const scope = ref(getLocal(SCOPE_KEY) || "");
/** 盘符列表：先用缓存瞬时填充，再后台刷新并缓存。 */
const disks = ref<DiskInfo[]>(getCachedDisks());
const scopeOptions = computed(() => buildScopeOptions(disks.value));

function ensureScope() {
  const valid = scopeOptions.value.some((o) => o.value === scope.value);
  if (!valid) scope.value = scopeOptions.value[0]?.value ?? "all";
}

watch(scope, (v) => setLocal(SCOPE_KEY, v));

onMounted(async () => {
  try {
    const list = await listDisks();
    disks.value = list;
    setCachedDisks(list);
  } catch {
    /* 保留缓存值 */
  }
  ensureScope();
});

const groups = computed(() =>
  GROUPS.map((g) => {
    const list = items.value.filter((i) => i.group === g.key);
    return {
      ...g,
      items: list.sort((a, b) => b.size - a.size),
      total: list.reduce((a, b) => a + b.size, 0),
      checked: list.filter((i) => selected.value[i.id]).length,
    };
  }),
);

/** 当前扫描范围的展示名（空态里提示用户实际扫了哪里） */
const scopeLabel = computed(() => {
  const o = scopeOptions.value.find((x) => x.value === scope.value);
  return o ? o.label : "全部磁盘";
});
/** 无结果时的说明：带上实际扫描范围，便于判断是「真没有」还是盘符没扫到 */
const emptyDesc = computed(() =>
  scope.value && scope.value !== "all"
    ? `已扫描「${scopeLabel.value}」，未发现可清理的日志。若该盘不可访问、或日志位于更深层的目录，可改用「全部磁盘（较慢）」再试。`
    : "当前范围内没有发现可清理的日志。",
);

const selectedIds = computed(() =>
  items.value.filter((i) => selected.value[i.id]).map((i) => i.id),
);
const selectedBytes = computed(() =>
  items.value.filter((i) => selected.value[i.id]).reduce((a, b) => a + b.size, 0),
);
const totalBytes = computed(() => items.value.reduce((a, b) => a + b.size, 0));

function toggleGroup(key: string, on: boolean) {
  for (const i of items.value) {
    if (i.group === key) selected.value[i.id] = on;
  }
}

async function doScan() {
  loading.value = true;
  error.value = "";
  result.value = null;
  confirming.value = false;
  items.value = [];
  selected.value = {};
  try {
    const all = await scanLogs(minDays.value, scope.value, (it) => {
      items.value.unshift(it);
      if (GROUPS.find((g) => g.key === it.group)?.recommend) {
        selected.value[it.id] = true;
      }
    });
    items.value = all;
    selected.value = {};
    for (const it of all) {
      if (GROUPS.find((g) => g.key === it.group)?.recommend) {
        selected.value[it.id] = true;
      }
    }
    void recordScan('logs', `${items.value.length} 项 · ${formatSize(totalBytes.value)}`);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    scanned.value = true;
  }
}

async function doDelete() {
  const ids = selectedIds.value;
  if (!ids.length) {
    error.value = "没有选择要清理的日志。";
    return;
  }
  if (!confirming.value) {
    confirming.value = true;
    return;
  }
  if (
    !confirm(
      `确认将 ${ids.length} 项日志（${formatSize(selectedBytes.value)}）移入回收站？\n` +
        `系统关键日志不会被清理。`,
    )
  ) {
    confirming.value = false;
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const res = await deleteLogs(ids, false);
    result.value = { deleted: res.deleted_count, size: res.deleted_size };
    if (res.errors.length) error.value = res.errors.slice(0, 3).join("；");
    const done = new Set(ids);
    items.value = items.value.filter((i) => !done.has(i.id));
    confirming.value = false;
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
    <h1 class="h-with-icon">
      <FileText :size="22" class="title-icon" />
      日志清理
    </h1>
    <p class="muted">
      清理应用级与临时级日志：<code>*.log</code>、崩溃转储
      <code>*.dmp</code>、WER 报告。<b>系统关键日志默认跳过</b>（扫描根仅为用户级目录，
      删除时再经受保护路径拦截）。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="doScan">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "扫描中…" : "扫描日志" }}
        </button>
        <button v-if="loading" class="btn" @click="cancelScanLogs">取消</button>
        <label class="lbl">扫描范围</label>
        <Select v-model="scope" :options="scopeOptions" :width="180" />
        <label class="lbl">仅列出</label>
        <input v-model.number="minDays" class="num" type="number" min="0" />
        <span class="muted">天前的文件（0 = 不限）</span>
        <span v-if="loading" class="muted">
          <span class="spinner"></span>
          扫描中… 已发现 {{ items.length }} 项
        </span>
        <span class="muted" v-else-if="items.length">
          共 {{ items.length }} 项 · {{ formatSize(totalBytes) }}
        </span>
        <LastScan module="logs" />
      </div>
      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="result" class="ok">
        已移入回收站 {{ result.deleted }} 个文件，释放
        {{ formatSize(result.size) }}。
      </div>

      <div v-if="items.length" class="list fill-list">
        <div v-for="g in groups" :key="g.key" class="grp">
          <div class="grp-head">
            <span class="dot" :style="{ background: g.color }" />
            <span class="grp-title">{{ g.label }}</span>
            <span class="muted small">{{ g.desc }}</span>
            <span class="spacer" />
            <span class="muted small">{{ formatSize(g.total) }}</span>
            <label class="chk">
              <input
                type="checkbox"
                :checked="g.checked > 0 && g.checked === g.items.length"
                :disabled="g.items.length === 0"
                @change="toggleGroup(g.key, ($event.target as HTMLInputElement).checked)"
              />
              <span class="muted small">{{ g.checked }} / {{ g.items.length }}</span>
            </label>
          </div>
          <div v-for="it in g.items" :key="it.id" class="row">
            <label class="chk">
              <input type="checkbox" v-model="selected[it.id]" />
            </label>
            <div class="info">
              <div class="name">{{ it.name }}</div>
              <div class="path muted small" :title="it.path">{{ it.path }}</div>
            </div>
            <span class="spacer" />
            <span class="size">{{ formatSize(it.size) }}</span>
          </div>
        </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="FileText"
        title="扫描中……"
      />
      <EmptyState
        v-else-if="!scanned"
        :icon="FileText"
        title="暂未扫描"
        desc="选择扫描范围，点击「开始扫描」检测应用日志、临时日志与崩溃转储。"
      />
      <EmptyState
        v-else
        :icon="SearchX"
        title="未发现对应记录"
        :desc="emptyDesc"
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
            清理选中（{{ selectedIds.length }} ·
            {{ formatSize(selectedBytes) }}）
          </template>
        </button>
        <span class="muted">默认移入回收站；崩溃转储默认不勾，需自行确认。</span>
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
          {{ formatSize(result.size) }}。
        </p>
        <p class="muted">系统关键日志不会被清理。</p>
      </template>
      <template #footer>
        <button class="btn" @click="showDone = false">暂不</button>
        <button class="btn btn-primary" @click="doneRescan">重新扫描</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.lbl {
  font-size: calc(13px * var(--fs-scale));
  color: var(--muted);
}
.num {
  width: 64px;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 6px 10px;
  font-size: calc(13px * var(--fs-scale));
  background: var(--bg);
  color: var(--text);
}
.spacer {
  flex: 1;
}
.small {
  font-size: calc(11px * var(--fs-scale));
}
.list {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.grp {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 14px;
}
.grp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}
.grp-title {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 2px;
  border-top: 1px solid var(--border);
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(13px * var(--fs-scale));
  flex-shrink: 0;
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
  max-width: 52vw;
}
.size {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  flex-shrink: 0;
  min-width: 78px;
  text-align: right;
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
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
</style>
