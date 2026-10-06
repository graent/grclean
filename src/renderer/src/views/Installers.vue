<script setup lang="ts">
import { PackageOpen, SearchX } from "@lucide/vue";
import { ref, computed, onMounted, watch } from "vue";
import {
  scanInstallers,
  cancelScanInstallers,
  deleteInstallers,
  formatSize,
  listDisks,
  buildScopeOptions,
  getLocal,
  setLocal,
  getCachedDisks,
  setCachedDisks,
  type InstallerItem,
  type DiskInfo,
} from "../api/electron";
import { recordScan } from "../stores/history";
import LastScan from "../components/LastScan.vue";
import Select from "../components/Select.vue";
import Modal from "../components/Modal.vue";
import EmptyState from "../components/EmptyState.vue";

const SCOPE_KEY = "grclean.scope.installers";

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

const items = ref<InstallerItem[]>([]);
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

/** 默认阈值：体积 ≥ 10MB 且存放 ≥ 30 天（设计：不自动删，需用户确认） */
const minSizeMb = ref(10);
const minDays = ref(30);

const selectedIds = computed(() =>
  items.value.filter((i) => selected.value[i.id]).map((i) => i.id),
);
const selectedBytes = computed(() =>
  items.value
    .filter((i) => selected.value[i.id])
    .reduce((a, b) => a + b.size, 0),
);
const totalBytes = computed(() => items.value.reduce((a, b) => a + b.size, 0));
const allChecked = computed(
  () => items.value.length > 0 && selectedIds.value.length === items.value.length,
);

function toggleAll(on: boolean) {
  for (const i of items.value) selected.value[i.id] = on;
}

function baseName(p: string) {
  return p.split("\\").pop() || p;
}

async function doScan() {
  loading.value = true;
  error.value = "";
  result.value = null;
  confirming.value = false;
  items.value = [];
  selected.value = {};
  try {
    const all = await scanInstallers(minSizeMb.value, minDays.value, scope.value, (it) => {
      items.value.unshift(it);
    });
    items.value = all.sort((a, b) => b.size - a.size);
    void recordScan('installers', `${items.value.length} 个 · ${formatSize(totalBytes.value)}`);
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
    error.value = "没有选择要清理的安装包。";
    return;
  }
  if (!confirming.value) {
    confirming.value = true;
    return;
  }
  if (
    !confirm(
      `确认将 ${ids.length} 个安装包（${formatSize(selectedBytes.value)}）移入回收站？\n` +
        `可从回收站还原。`,
    )
  ) {
    confirming.value = false;
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const res = await deleteInstallers(ids, false);
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
      <PackageOpen :size="22" class="title-icon" />
      安装包清理
    </h1>
    <p class="muted">
      扫描下载 / 桌面 / 文档中的
      <code>*.exe / *.msi / *.iso / *.zip / *.rar / *.7z</code>
      等安装包，按「体积 + 存放天数」过滤。<b>默认不勾选、不自动删</b>，确认后再清理。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="doScan">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "扫描中…" : "扫描安装包" }}
        </button>
        <button v-if="loading" class="btn" @click="cancelScanInstallers">
          取消
        </button>
        <label class="lbl">扫描范围</label>
        <Select v-model="scope" :options="scopeOptions" :width="180" />
        <label class="lbl">最小体积</label>
        <input v-model.number="minSizeMb" class="num" type="number" min="0" />
        <span class="muted">MB</span>
        <label class="lbl">存放超过</label>
        <input v-model.number="minDays" class="num" type="number" min="0" />
        <span class="muted">天</span>
        <span class="muted" v-if="items.length">
          共 {{ items.length }} 个 · {{ formatSize(totalBytes) }}
        </span>
        <LastScan module="installers" />
      </div>
      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="result" class="ok">
        已移入回收站 {{ result.deleted }} 个安装包，释放
        {{ formatSize(result.size) }}。
      </div>

      <div v-if="items.length" class="list fill-list">
        <div class="list-head">
          <label class="chk">
            <input
              type="checkbox"
              :checked="allChecked"
              @change="toggleAll(($event.target as HTMLInputElement).checked)"
            />
            <span class="muted small">全选</span>
          </label>
          <span class="spacer" />
          <span class="muted small">已选 {{ selectedIds.length }} 个</span>
        </div>
        <div v-for="it in items" :key="it.id" class="row">
          <label class="chk">
            <input type="checkbox" v-model="selected[it.id]" />
          </label>
          <span class="ext">{{ it.ext.toUpperCase() }}</span>
          <div class="info">
            <div class="name">
              {{ baseName(it.path) }}
              <span v-if="it.byName" class="tag">安装包特征</span>
            </div>
            <div class="path muted small" :title="it.path">{{ it.path }}</div>
          </div>
          <span class="spacer" />
          <span class="muted small">{{ it.days }} 天前</span>
          <span class="size">{{ formatSize(it.size) }}</span>
        </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="PackageOpen"
        title="扫描中……"
      />
      <EmptyState
        v-else-if="!scanned"
        :icon="PackageOpen"
        title="暂未扫描"
        desc="选择扫描范围与阈值，点击「开始扫描」查找安装包与压缩包。"
      />
      <EmptyState
        v-else
        :icon="SearchX"
        title="未发现对应记录"
        desc="当前范围内没有发现符合阈值的安装包。"
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
        <span class="muted">默认移入回收站，可从回收站还原。</span>
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
          已移入回收站 <b>{{ result.deleted }}</b> 个安装包，释放
          {{ formatSize(result.size) }}。
        </p>
        <p class="muted">默认移入回收站，可从回收站还原。</p>
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
  width: 72px;
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
}
.list-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(13px * var(--fs-scale));
  flex-shrink: 0;
}
.ext {
  flex-shrink: 0;
  font-size: calc(10px * var(--fs-scale));
  font-weight: 700;
  color: var(--primary);
  background: var(--primary-weak);
  border-radius: 5px;
  padding: 2px 7px;
  min-width: 42px;
  text-align: center;
}
.info {
  min-width: 0;
}
.name {
  font-size: calc(13px * var(--fs-scale));
}
.tag {
  font-size: calc(10px * var(--fs-scale));
  color: var(--success);
  border: 1px solid var(--success);
  border-radius: 5px;
  padding: 0 6px;
  margin-left: 6px;
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
