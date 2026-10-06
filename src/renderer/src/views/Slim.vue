<script setup lang="ts">
import { Minimize2, SearchX } from "@lucide/vue";
import { ref, computed } from "vue";
import {
  slimPlan,
  slimRun,
  formatSize,
  type SlimItem,
  type SlimOpResult,
} from "../api/electron";
import EmptyState from "../components/EmptyState.vue";

const emit = defineEmits<{ (e: "navigate", v: string): void }>();

const items = ref<SlimItem[]>([]);
const selected = ref<Record<string, boolean>>({});
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const confirming = ref(false);
const results = ref<SlimOpResult[]>([]);
/** 是否完成过一次统计（区分「尚未统计」与「无可瘦身项」）。 */
const loaded = ref(false);

const RISK_META = {
  safe: { label: "安全", color: "var(--success)", desc: "可逆 / 可重建" },
  caution: { label: "需确认", color: "var(--warn, #d98324)", desc: "建议到对应模块处理" },
  danger: { label: "不可逆", color: "var(--danger)", desc: "删除后无法恢复" },
} as const;

/** 可直接执行的项（其余需跳转到对应模块） */
const actionable = computed(() => items.value.filter((i) => i.actionable));
const selectedKinds = computed(() =>
  actionable.value.filter((i) => selected.value[i.kind]).map((i) => i.kind),
);
const selectedBytes = computed(() =>
  actionable.value
    .filter((i) => selected.value[i.kind])
    .reduce((a, b) => a + b.size, 0),
);
const selectedDanger = computed(() =>
  actionable.value.filter(
    (i) => selected.value[i.kind] && i.risk === "danger",
  ),
);
const totalBytes = computed(() => items.value.reduce((a, b) => a + b.size, 0));

async function load() {
  loading.value = true;
  error.value = "";
  results.value = [];
  confirming.value = false;
  try {
    const list = await slimPlan();
    items.value = list;
    selected.value = {};
    for (const i of list) {
      if (i.actionable && i.recommend) selected.value[i.kind] = true;
    }
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    loaded.value = true;
  }
}

// 不再进入页面自动统计，等待用户点击按钮触发

async function doRun() {
  const kinds = selectedKinds.value;
  if (!kinds.length) {
    error.value = "没有选择可执行的瘦身项。";
    return;
  }
  if (!confirming.value) {
    confirming.value = true;
    return;
  }
  let tip = `确认执行 ${kinds.length} 项 C 盘瘦身（预计释放 ${formatSize(selectedBytes.value)}）？`;
  if (selectedDanger.value.length) {
    tip =
      `⚠️ 其中包含不可逆操作：${selectedDanger.value
        .map((i) => i.name)
        .join("、")}\n删除后无法恢复（Windows.old 删除后不能回退旧系统）。\n\n` + tip;
  }
  tip += `\n\n清理系统目录需要管理员权限，失败会逐项回传原因。`;
  if (!confirm(tip)) {
    confirming.value = false;
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    results.value = await slimRun(kinds);
    confirming.value = false;
    // 执行完重新统计
    await load();
  } catch (e: any) {
    error.value = `执行失败：${String(e)}`;
    confirming.value = false;
  } finally {
    busy.value = false;
  }
}

function nameOfKind(kind: string) {
  return items.value.find((i) => i.kind === kind)?.name ?? kind;
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <Minimize2 :size="22" class="title-icon" />
      系统盘瘦身
    </h1>
    <p class="muted">
      向导式聚合：休眠文件 + 旧 Windows + 传递优化 + 更新缓存 + 社交缓存 + 大文件，
      给出<b>一键可释放总量</b>预估。不可逆项已标注，需二次确认。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading || busy" @click="load">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "统计中…" : items.length ? "重新评估" : "开始统计" }}
        </button>
        <span class="muted" v-if="items.length">
          共 {{ items.length }} 项 · 可释放 {{ formatSize(totalBytes) }}
        </span>
      </div>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div v-if="items.length" class="list fill-list">
        <div v-for="it in items" :key="it.kind" class="row">
          <label class="chk" :class="{ disabled: !it.actionable }">
            <input
              type="checkbox"
              v-model="selected[it.kind]"
              :disabled="!it.actionable"
            />
          </label>
          <span
            class="risk-tag"
            :style="{
              color: RISK_META[it.risk].color,
              borderColor: RISK_META[it.risk].color,
            }"
          >
            {{ RISK_META[it.risk].label }}
          </span>
          <div class="info">
            <div class="name">{{ it.name }}</div>
            <div class="path muted small">{{ it.desc }}</div>
          </div>
          <span class="spacer" />
          <button
            v-if="!it.actionable && it.goto"
            class="btn tiny"
            @click="emit('navigate', it.goto!)"
          >
            去处理
          </button>
          <span class="size">{{ formatSize(it.size) }}</span>
        </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="Minimize2"
        title="统计中……"
      />
      <EmptyState
        v-else-if="!loaded"
        :icon="Minimize2"
        title="暂未扫描"
        desc="点击「开始统计」评估 C 盘可释放空间（Windows.old、更新缓存等）。"
      />
      <EmptyState
        v-else
        :icon="SearchX"
        title="未发现对应记录"
        desc="未发现可瘦身项，或统计失败。"
      />

      <div v-if="results.length" class="results">
        <div
          v-for="(r, i) in results"
          :key="i"
          class="res-row"
          :class="{ bad: !r.ok }"
        >
          <span class="res-name">{{ nameOfKind(r.kind) }}</span>
          <span class="res-msg">{{ r.message }}</span>
        </div>
      </div>

      <div v-if="actionable.length" class="actions">
        <button
          class="btn"
          :class="confirming ? 'btn-danger' : 'btn-primary'"
          :disabled="busy || loading || selectedKinds.length === 0"
          @click="doRun"
        >
          <template v-if="busy">执行中…</template>
          <template v-else-if="confirming">再次点击确认执行</template>
          <template v-else>
            执行瘦身（{{ selectedKinds.length }} ·
            {{ formatSize(selectedBytes) }}）
          </template>
        </button>
        <span class="muted">
          清理系统目录需管理员权限；社交缓存与大文件建议跳转到对应模块逐项确认。
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
.list {
  margin-top: 14px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 2px;
  border-bottom: 1px solid var(--border);
}
.chk {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.chk.disabled {
  opacity: 0.4;
}
.risk-tag {
  flex-shrink: 0;
  font-size: calc(11px * var(--fs-scale));
  font-weight: 700;
  border: 1px solid;
  border-radius: 6px;
  padding: 1px 8px;
}
.info {
  min-width: 0;
}
.name {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
}
.path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 48vw;
}
.size {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  flex-shrink: 0;
  min-width: 82px;
  text-align: right;
}
.tiny {
  padding: 4px 10px;
  font-size: calc(12px * var(--fs-scale));
}
.results {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.res-row {
  display: flex;
  gap: 10px;
  padding: 9px 14px;
  font-size: calc(12px * var(--fs-scale));
}
.res-row:nth-child(even) {
  background: var(--bg);
}
.res-row.bad .res-msg {
  color: var(--danger);
}
.res-name {
  font-weight: 600;
  flex-shrink: 0;
  min-width: 170px;
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
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
</style>
