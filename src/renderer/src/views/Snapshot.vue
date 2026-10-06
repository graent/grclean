<script setup lang="ts">
import { GitCompareArrows, Camera, SearchX } from "@lucide/vue";
import EmptyState from "../components/EmptyState.vue";
import { ref, computed, onMounted } from "vue";
import {
  snapTake,
  snapList,
  snapDelete,
  snapDiff,
  snapCancel,
  formatSize,
  type Snapshot,
  type SnapshotDiff,
} from "../api/electron";

const list = ref<Snapshot[]>([]);
const baseId = ref("");
const targetId = ref("");
const diff = ref<SnapshotDiff | null>(null);
const loading = ref(false);
const taking = ref(false);
const error = ref("");
const tip = ref("");

/** 增长最多的目录（Top 15，只看增量为正的）。 */
const grown = computed(() =>
  (diff.value?.dirs ?? []).filter((d) => d.delta > 0).slice(0, 15),
);

/** 体积减少最多的目录（清理生效的证据）。 */
const shrunk = computed(() =>
  (diff.value?.dirs ?? [])
    .filter((d) => d.delta < 0)
    .slice()
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 8),
);

const maxDelta = computed(() =>
  Math.max(1, ...grown.value.map((d) => Math.abs(d.delta))),
);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    list.value = await snapList();
    // 默认选最近两次：较新的作为对比终点
    if (list.value.length >= 2) {
      targetId.value = list.value[0].id;
      baseId.value = list.value[1].id;
    } else if (list.value.length === 1) {
      targetId.value = list.value[0].id;
      baseId.value = list.value[0].id;
    }
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function take() {
  taking.value = true;
  error.value = "";
  tip.value = "正在采集各盘占用与系统盘顶层目录体积…";
  try {
    const s = await snapTake();
    tip.value = `快照已保存：${s.time}`;
    await load();
  } catch (e: any) {
    error.value = String(e);
    tip.value = "";
  } finally {
    taking.value = false;
  }
}

async function doDiff() {
  error.value = "";
  diff.value = null;
  if (!baseId.value || !targetId.value) {
    error.value = "请选择两次快照（基准为较早的一次）";
    return;
  }
  if (baseId.value === targetId.value) {
    error.value = "请选择两次不同的快照";
    return;
  }
  try {
    diff.value = await snapDiff(baseId.value, targetId.value);
    if (!diff.value) error.value = "对比失败：快照不存在";
  } catch (e: any) {
    error.value = String(e);
  }
}

async function remove(id: string) {
  try {
    await snapDelete(id);
    diff.value = null;
    await load();
  } catch (e: any) {
    error.value = String(e);
  }
}

function usedOf(s: Snapshot): string {
  const v = s.volumes.find((x) => x.letter.toUpperCase() === "C") || s.volumes[0];
  if (!v) return "—";
  return `${v.letter}: 已用 ${formatSize(v.totalBytes - v.freeBytes)}`;
}

function deltaColor(d: number): string {
  if (d > 0) return "var(--danger)";
  if (d < 0) return "var(--success)";
  return "var(--muted)";
}

function deltaText(d: number): string {
  if (d === 0) return "±0";
  return (d > 0 ? "+" : "-") + formatSize(Math.abs(d));
}

onMounted(load);
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <GitCompareArrows :size="22" class="title-icon" />
      磁盘空间变化
    </h1>
    <p class="muted">
      保存容量快照，随时对比两次快照找出「到底是谁吃掉了空间」：
      先看各盘增减，再看系统盘顶层目录的膨胀 Top 与新增目录。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="taking" @click="take">
          {{ taking ? "采集…" : "创建快照" }}
        </button>
        <button class="btn" :disabled="!taking" @click="snapCancel">取消</button>
        <button class="btn" :disabled="loading" @click="load">刷新列表</button>
        <span class="muted">共 {{ list.length }} 个快照</span>
      </div>

      <div v-if="tip" class="tip">{{ tip }}</div>
      <div v-if="error" class="err">{{ error }}</div>

      <!-- 快照列表 -->
      <div class="block">
        <div class="block-title">快照列表</div>
        <div class="fill-list snap-list">
          <div v-for="s in list" :key="s.id" class="snap-row">
            <div class="snap-main">
              <span class="snap-time">{{ s.time }}</span>
              <span class="muted small">{{ usedOf(s) }}</span>
            </div>
            <span class="spacer" />
            <button class="btn tiny" @click="remove(s.id)">删除</button>
          </div>
          <EmptyState
            v-if="(loading || taking) && !list.length"
            loading
            :icon="Camera"
            title="读取中……"
          />
          <EmptyState
            v-else-if="!list.length"
            :icon="Camera"
            title="暂未扫描"
            desc="还没有快照，点「创建快照」记录当前占用作为基线。"
          />
        </div>
      </div>

      <!-- 对比选择 -->
      <div class="block">
        <div class="block-title">对比两次快照</div>
        <div class="row">
          <span class="muted">基准（较早）</span>
          <select v-model="baseId" class="sel">
            <option v-for="s in list" :key="s.id" :value="s.id">{{ s.time }}</option>
          </select>
          <span class="muted">对比到（较晚）</span>
          <select v-model="targetId" class="sel">
            <option v-for="s in list" :key="s.id" :value="s.id">{{ s.time }}</option>
          </select>
          <button class="btn btn-primary" :disabled="list.length < 2" @click="doDiff">
            开始对比
          </button>
        </div>
      </div>

      <!-- 对比结果 -->
      <template v-if="diff">
        <div class="block">
          <div class="block-title">
            各盘增减（相隔 {{ diff.days }} 天）
          </div>
          <div class="vol-grid">
            <div v-for="v in diff.volumes" :key="v.letter" class="vol-card">
              <div class="vol-letter">{{ v.letter }}:</div>
              <div class="vol-delta" :style="{ color: deltaColor(v.delta) }">
                {{ deltaText(v.delta) }}
              </div>
              <div class="muted small">
                {{ formatSize(v.usedBefore) }} → {{ formatSize(v.usedAfter) }}
              </div>
            </div>
          </div>
        </div>

        <div class="block">
          <div class="block-title">膨胀最多的目录（Top 15）</div>
          <div class="fill-list grow-list">
            <div v-for="(d, i) in grown" :key="d.path + i" class="grow-row">
              <div class="grow-head">
                <span class="grow-name ellipsis">{{ d.path }}</span>
                <span v-if="d.isNew" class="new-tag">新增</span>
                <span class="spacer" />
                <span class="grow-delta" :style="{ color: 'var(--danger)' }">
                  +{{ formatSize(d.delta) }}
                </span>
              </div>
              <div class="grow-bar">
                <div
                  class="grow-fill"
                  :style="{ width: (Math.abs(d.delta) / maxDelta) * 100 + '%' }"
                />
              </div>
              <div class="muted small">
                {{ formatSize(d.before) }} → {{ formatSize(d.after) }}
              </div>
            </div>
            <EmptyState
              v-if="!grown.length"
              :icon="SearchX"
              title="未发现对应记录"
              desc="没有检测到增长的目录（可能两次快照相隔太短）。"
            />
          </div>
        </div>

        <div v-if="shrunk.length" class="block">
          <div class="block-title">体积减少的目录（清理生效）</div>
          <div class="fill-list grow-list">
            <div v-for="(d, i) in shrunk" :key="d.path + i" class="grow-row">
              <div class="grow-head">
                <span class="grow-name ellipsis">{{ d.path }}</span>
                <span class="spacer" />
                <span class="grow-delta" :style="{ color: 'var(--success)' }">
                  -{{ formatSize(Math.abs(d.delta)) }}
                </span>
              </div>
              <div class="muted small">
                {{ formatSize(d.before) }} → {{ formatSize(d.after) }}
              </div>
            </div>
          </div>
        </div>
      </template>
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
.pad {
  padding: 12px 14px;
}
.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.block {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px dashed var(--border);
}
.block-title {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
  margin-bottom: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.sel {
  max-width: 180px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: calc(13px * var(--fs-scale));
}
.btn.tiny {
  padding: 4px 10px;
  font-size: calc(12px * var(--fs-scale));
}
.tip {
  margin-top: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--primary-weak);
  color: var(--title);
  font-size: calc(13px * var(--fs-scale));
}
.err {
  margin-top: 10px;
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
}
.snap-list {
  max-height: 200px;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.snap-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.snap-row:last-child {
  border-bottom: none;
}
.snap-main {
  display: flex;
  flex-direction: column;
}
.snap-time {
  font-size: calc(13px * var(--fs-scale));
  color: var(--text);
}
.vol-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.vol-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--bg);
}
.vol-letter {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
}
.vol-delta {
  font-size: calc(15px * var(--fs-scale));
  font-weight: 700;
  margin: 2px 0;
}
.grow-list {
  max-height: 280px;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.grow-row {
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
}
.grow-row:last-child {
  border-bottom: none;
}
.grow-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.grow-name {
  font-size: calc(13px * var(--fs-scale));
  color: var(--text);
  min-width: 0;
}
.new-tag {
  font-size: calc(10px * var(--fs-scale));
  font-weight: 700;
  color: var(--primary);
  border: 1px solid var(--primary);
  border-radius: 8px;
  padding: 0 6px;
  flex-shrink: 0;
}
.grow-delta {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
  flex-shrink: 0;
}
.grow-bar {
  margin: 5px 0 3px;
  height: 6px;
  border-radius: 3px;
  background: var(--border);
  overflow: hidden;
}
.grow-fill {
  height: 100%;
  background: var(--danger);
}
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
</style>
