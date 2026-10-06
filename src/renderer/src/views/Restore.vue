<script setup lang="ts">
import { History, SearchX } from "@lucide/vue";
import EmptyState from "../components/EmptyState.vue";
import { ref, computed } from "vue";
import {
  rpStatus,
  rpDeleteOld,
  rpSetMax,
  rpSetProtection,
  formatSize,
  type RestoreStatus,
} from "../api/electron";

const status = ref<RestoreStatus | null>(null);
const loading = ref(false);
const busy = ref("");
const error = ref("");
const result = ref<{ ok: boolean; text: string } | null>(null);

const keep = ref(1);
const pct = ref(5);
const confirmProtection = ref(false);

/** 还原点合计占用（MB → 字节）。 */
const usedBytes = computed(() => (status.value?.totalUsedMb ?? 0) * 1024 * 1024);

const maxBytes = computed(() =>
  (status.value?.storage ?? []).reduce((n, s) => n + s.maxMb, 0) * 1024 * 1024,
);

const usedPercent = computed(() => {
  if (!maxBytes.value) return 0;
  return Math.min(100, (usedBytes.value / maxBytes.value) * 100);
});

/** 将被清理的还原点数量（保留最近 keep 个）。 */
const willDelete = computed(() => {
  const n = status.value?.points.length ?? 0;
  return Math.max(0, n - keep.value);
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    status.value = await rpStatus();
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function run(key: string, fn: () => Promise<{ ok: boolean; message: string }>) {
  busy.value = key;
  result.value = null;
  error.value = "";
  try {
    const r = await fn();
    result.value = { ok: r.ok, text: r.message };
    if (r.ok) await load();
  } catch (e: any) {
    result.value = { ok: false, text: String(e) };
  } finally {
    busy.value = "";
  }
}

function doDeleteOld() {
  run("delete", () => rpDeleteOld(keep.value));
}

function doSetMax() {
  run("max", () => rpSetMax(pct.value));
}

function doSetProtection(enable: boolean) {
  if (!enable && !confirmProtection.value) {
    error.value = "请先勾选「我已知悉风险」，关闭系统保护会删除全部还原点";
    return;
  }
  run("protect", () => rpSetProtection(enable));
}

// 不再进入页面自动读取，等待用户点击按钮触发
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <History :size="22" class="title-icon" />
      系统还原点
    </h1>
    <p class="muted">
      还原点会随系统更新不断累积，常占用数 GB 到数十 GB。按设计策略保留最近 1 个、
      清理更早的即可，既保留回滚能力又释放空间。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "读取中…" : status ? "重新读取" : "读取还原点" }}
        </button>
        <span class="muted" v-if="status">
          系统保护：{{ status.enabled ? "已启用" : "未启用" }} · 共
          {{ status.points.length }} 个还原点
        </span>
      </div>

      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="result" class="res" :class="{ ok: result.ok }">{{ result.text }}</div>

      <!-- 卡片高度固定，内容超出时在卡片内部滚动：
           否则 flex 列容器会把各 .block 一起压缩，最后一块（系统保护开关）
           的内容就会溢出到卡片边框外面。 -->
      <div v-if="status" class="body fill-list">
        <!-- 占用概览 -->
        <div class="overview">
          <div class="ov-item">
            <div class="ov-label">还原点占用</div>
            <div class="ov-value">{{ formatSize(usedBytes) }}</div>
          </div>
          <div class="ov-item">
            <div class="ov-label">配额上限</div>
            <div class="ov-value">
              {{ maxBytes ? formatSize(maxBytes) : "未知" }}
            </div>
          </div>
          <div class="ov-item">
            <div class="ov-label">系统盘</div>
            <div class="ov-value">{{ status.systemVolume }}</div>
          </div>
        </div>
        <div v-if="maxBytes" class="bar">
          <div
            class="bar-fill"
            :style="{
              width: usedPercent + '%',
              background: usedPercent >= 85 ? 'var(--danger)' : 'var(--success)',
            }"
          />
        </div>

        <!-- 清理更早的 -->
        <div class="block">
          <div class="block-title">清理较早的还原点</div>
          <div class="row">
            <span class="muted">保留最近</span>
            <input v-model.number="keep" type="number" class="inp" min="1" max="10" />
            <span class="muted">个（更早的将被清理）</span>
            <span class="spacer" />
            <button
              class="btn btn-primary"
              :disabled="busy === 'delete' || willDelete === 0"
              @click="doDeleteOld"
            >
              {{ willDelete ? `清理 ${willDelete} 个` : "无需清理" }}
            </button>
          </div>
          <div class="muted small">
            逐条删除最老的还原点，中途失败即停止，绝不会误删保留位。
          </div>
        </div>

        <!-- 配额调整 -->
        <div class="block">
          <div class="block-title">调整最大占用</div>
          <div class="row">
            <input v-model.number="pct" type="range" min="1" max="30" class="range" />
            <span class="pct-val">{{ pct }}%</span>
            <span class="spacer" />
            <button class="btn" :disabled="busy === 'max'" @click="doSetMax">
              应用配额
            </button>
          </div>
          <div class="muted small">
            建议 3%–10%。配额越小，系统能保留的还原点越少。
          </div>
        </div>

        <!-- 还原点列表 -->
        <div class="block">
          <div class="block-title">还原点列表（最新在前）</div>
          <div class="rp-list">
            <div v-for="(p, i) in status.points" :key="p.seq" class="rp-row">
              <span class="rp-idx" :class="{ keep: i < keep }">
                {{ i < keep ? "保留" : "可清理" }}
              </span>
              <div class="rp-main">
                <span class="rp-desc">{{ p.description || "(无描述)" }}</span>
                <span class="muted small">{{ p.type }} · {{ p.time }}</span>
              </div>
            </div>
            <EmptyState
              v-if="!status.points.length"
              :icon="SearchX"
              title="未发现对应记录"
              desc="当前没有还原点（可能未启用系统保护）。"
            />
          </div>
        </div>

        <!-- 系统保护开关 -->
        <div class="block danger-block">
          <div class="block-title">系统保护开关</div>
          <div class="row">
            <button
              class="btn btn-primary"
              :disabled="busy === 'protect' || status.enabled"
              @click="doSetProtection(true)"
            >
              启用系统保护
            </button>
            <button
              class="btn btn-danger"
              :disabled="busy === 'protect' || !status.enabled"
              @click="doSetProtection(false)"
            >
              关闭系统保护
            </button>
          </div>
          <label class="chk">
            <input v-model="confirmProtection" type="checkbox" />
            我已知悉：关闭系统保护会<b>立即删除全部还原点</b>且不可恢复
          </label>
        </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="History"
        title="读取中……"
      />
      <EmptyState
        v-else
        :icon="History"
        title="暂未扫描"
        desc="点击上方「读取还原点」按钮获取还原点信息。"
      />
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
.overview {
  display: flex;
  gap: 28px;
  margin-top: 14px;
  flex-wrap: wrap;
}
.ov-label {
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
}
.ov-value {
  font-size: calc(17px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
  margin-top: 2px;
}
.bar {
  height: 10px;
  border-radius: 5px;
  background: var(--border);
  overflow: hidden;
  margin: 10px 0 4px;
}
.bar-fill {
  height: 100%;
  border-radius: 5px;
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
.inp {
  width: 70px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: calc(13px * var(--fs-scale));
}
.range {
  width: 200px;
}
.pct-val {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
  min-width: 42px;
}
.rp-list {
  margin-top: 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  max-height: 240px;
  overflow-y: auto;
}
/* 卡片内滚动区：占满剩余高度，内容多时内部滚动，避免块被压缩后溢出卡片 */
.body {
  margin-top: 14px;
  padding-right: 4px;
}
.rp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.rp-row:last-child {
  border-bottom: none;
}
.rp-idx {
  font-size: calc(11px * var(--fs-scale));
  font-weight: 700;
  border-radius: 10px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  color: var(--muted);
  flex-shrink: 0;
}
.rp-idx.keep {
  color: var(--success);
  border-color: var(--success);
}
.rp-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.rp-desc {
  font-size: calc(13px * var(--fs-scale));
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.danger-block {
  border-top-color: var(--danger);
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(12px * var(--fs-scale));
  color: var(--text);
  margin-top: 8px;
}
.res {
  margin-top: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: calc(13px * var(--fs-scale));
  background: #fdecec;
  color: var(--danger);
  white-space: pre-wrap;
}
.res.ok {
  background: #e9f7ee;
  color: #2f7d2f;
}
.err {
  margin-top: 10px;
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
}
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
</style>
