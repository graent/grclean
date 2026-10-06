<script setup lang="ts">
import { Rocket, SearchX } from "@lucide/vue";
import { ref, computed } from "vue";
import {
  scanStartup,
  setStartupEnabled,
  cancelScan,
  type StartupEntry,
} from "../api/electron";
import { recordScan } from "../stores/history";
import LastScan from "../components/LastScan.vue";
import EmptyState from "../components/EmptyState.vue";

const entries = ref<StartupEntry[]>([]);
const loading = ref(false);
/** 是否已执行过一次扫描（区分「暂未扫描」与「已扫描无结果」两种空态） */
const scanned = ref(false);
const error = ref("");
const busyId = ref("");

const sourceLabel: Record<string, string> = {
  registry: "注册表",
  folder: "启动文件夹",
  task: "任务计划",
};

const grouped = computed(() => {
  const g: Record<string, StartupEntry[]> = {};
  for (const e of entries.value) {
    (g[e.source] ||= []).push(e);
  }
  return g;
});

const counts = computed(() => {
  let enabled = 0;
  let disabled = 0;
  for (const e of entries.value) {
    if (e.enabled) enabled++;
    else disabled++;
  }
  return { total: entries.value.length, enabled, disabled };
});

async function doScan() {
  loading.value = true;
  error.value = "";
  entries.value = [];
  try {
    // 后端逐条发送启动项（从上方插入），前端边扫边显示；
    // 返回的权威结果用于最终补全。
    // seen 用 Set 去重：避免每来一项都对整表 some() 扫描（O(n²) → O(n)）
    const seen = new Set<string>();
    entries.value = await scanStartup((item) => {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        entries.value.unshift(item);
      }
    });
    void recordScan('startup', `${counts.value.total} 项 · 启用 ${counts.value.enabled} · 禁用 ${counts.value.disabled}`);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    scanned.value = true;
  }
}

async function toggle(e: StartupEntry) {
  busyId.value = e.id;
  error.value = "";
  try {
    const res = await setStartupEnabled(e.id, !e.enabled);
    if (!res.ok) {
      error.value = `操作失败：${res.error}（HKLM 项需以管理员身份运行）`;
      return;
    }
    e.enabled = !e.enabled;
  } catch (err: any) {
    error.value = `操作失败：${String(err)}（HKLM 项需以管理员身份运行）`;
  } finally {
    busyId.value = "";
  }
}

function truncate(s: string, n = 90) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <Rocket :size="22" class="title-icon" />
      启动项管理
    </h1>
    <p class="muted">
      读取注册表 Run/RunOnce、启动文件夹与任务计划。仅做启用 / 禁用，不删除任何数据，随时可恢复。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="doScan">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "扫描中…" : "扫描启动项" }}
        </button>
        <button v-if="loading" class="btn" @click="cancelScan">取消</button>
        <span class="muted" v-if="loading">已扫描 {{ entries.length }} 项</span>
        <span class="muted" v-else-if="counts.total">
          共 {{ counts.total }} 项 · 启用 {{ counts.enabled }} · 禁用
          {{ counts.disabled }}
        </span>
        <span v-if="error" class="err">{{ error }}</span>
        <LastScan module="startup" />
      </div>
      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div v-if="Object.keys(grouped).length" class="groups fill-list">
        <div v-for="(list, src) in grouped" :key="src" class="group">
          <div class="group-head">
            <span class="badge">{{ sourceLabel[src] || src }}</span>
            <span class="muted">{{ list.length }} 项</span>
          </div>
          <div v-for="e in list" :key="e.id" class="row">
            <div class="info">
              <div class="name">{{ e.name }}</div>
              <div class="cmd muted" :title="e.command">
                {{ truncate(e.command) }}
              </div>
              <div class="loc muted">{{ e.location }}</div>
            </div>
            <div class="row-actions">
              <button
                class="btn toggle"
                :class="e.enabled ? 'on' : 'off'"
                :disabled="busyId === e.id"
                @click="toggle(e)"
              >
                {{ e.enabled ? "启用中" : "已禁用" }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="Rocket"
        title="扫描中……"
      />
      <EmptyState
        v-else-if="!scanned"
        :icon="Rocket"
        title="暂未扫描"
        desc="点击「扫描启动项」检测注册表、启动文件夹与任务计划中的自启程序。"
      />
      <EmptyState
        v-else
        :icon="SearchX"
        title="未发现对应记录"
        desc="当前账户下没有发现启动项。"
      />
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.groups {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
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
  justify-content: space-between;
  gap: 16px;
  padding: 10px 2px;
  border-bottom: 1px solid var(--border);
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.info {
  min-width: 0;
}
.name {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 600;
}
.cmd {
  font-size: calc(12px * var(--fs-scale));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60vw;
}
.loc {
  font-size: calc(11px * var(--fs-scale));
}
.toggle {
  flex-shrink: 0;
  min-width: 84px;
}
.toggle.on {
  border-color: var(--success);
  color: var(--success);
}
.toggle.off {
  border-color: var(--border);
  color: var(--muted);
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
}
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
</style>
