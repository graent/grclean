<script setup lang="ts">
import { PackageX, SearchX } from "@lucide/vue";
import { ref, computed } from "vue";
import {
  scanUninstall,
  uninstall,
  cancelScan,
  scanResidue,
  cancelScanResidue,
  deleteResidue,
  formatSize,
  type UninstallEntry,
  type UninstallResult,
  type ResidueItem,
  type CleanResult,
} from "../api/electron";
import { recordScan } from "../stores/history";
import LastScan from "../components/LastScan.vue";
import EmptyState from "../components/EmptyState.vue";

/** 模块两个入口：已安装程序卸载 / 卸载残留清理（§3.11）。 */
type TabKey = "app" | "residue";
const tab = ref<TabKey>("app");

const entries = ref<UninstallEntry[]>([]);
const loading = ref(false);
/** 是否已执行过一次扫描（区分「暂未扫描」与「已扫描无结果」两种空态） */
const scanned = ref(false);
const error = ref("");
const busyId = ref("");
const lastResult = ref<UninstallResult | null>(null);

// 搜索过滤
const keyword = ref("");
const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return entries.value;
  return entries.value.filter(
    (e) =>
      e.name.toLowerCase().includes(k) ||
      e.publisher.toLowerCase().includes(k),
  );
});

const totalSize = computed(() =>
  entries.value.reduce((a, e) => a + e.size_kb, 0),
);

// 待确认卸载的项
const pending = ref<UninstallEntry | null>(null);
const quiet = ref(false);

async function doScan() {
  loading.value = true;
  error.value = "";
  entries.value = [];
  try {
    // 后端逐条发送已安装程序（从上方插入），前端边扫边显示；seen 去重（O(n²) → O(n)）
    const seen = new Set<string>();
    entries.value = await scanUninstall((item) => {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        entries.value.unshift(item);
      }
    });
    void recordScan('uninstall', `${entries.value.length} 个 · ${formatSize(totalSize.value * 1024)}`);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    scanned.value = true;
  }
}

function askUninstall(e: UninstallEntry) {
  if (!e.can_uninstall) {
    error.value = "该项标记为不可卸载（NoRemove），已跳过。";
    return;
  }
  pending.value = e;
}

async function confirmUninstall() {
  const e = pending.value;
  pending.value = null;
  if (!e) return;
  busyId.value = e.id;
  lastResult.value = null;
  error.value = "";
  try {
    const res = await uninstall(e.id, quiet.value);
    lastResult.value = res;
    if (!res.launched) {
      error.value = res.error || "卸载程序启动失败";
    }
  } catch (err: any) {
    error.value = `卸载失败：${String(err)}`;
  } finally {
    busyId.value = "";
  }
}

function truncate(s: string, n = 70) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------------- 卸载残留（§3.11）----------------
const residue = ref<ResidueItem[]>([]);
const resLoading = ref(false);
/** 残留扫描是否已执行过一次（区分两种空态） */
const resScanned = ref(false);
const resBusy = ref(false);
const resSelected = ref<Record<string, boolean>>({});
const resMinMb = ref(10);
const resMinDays = ref(60);
const resResult = ref<CleanResult | null>(null);

const resSelectedIds = computed(() =>
  residue.value.filter((i) => resSelected.value[i.id]).map((i) => i.id),
);
const resSelectedSize = computed(() =>
  residue.value
    .filter((i) => resSelected.value[i.id])
    .reduce((a, i) => a + i.size, 0),
);

async function doScanResidue() {
  resLoading.value = true;
  error.value = "";
  residue.value = [];
  resSelected.value = {};
  resResult.value = null;
  try {
    // seen 去重：避免每来一项都对整表 some() 扫描（O(n²) → O(n)）
    const seen = new Set<string>();
    await scanResidue(resMinMb.value, resMinDays.value, (item) => {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        residue.value.unshift(item);
      }
    });
    // 默认不勾选（设计：需用户确认）
    residue.value.forEach((i) => (resSelected.value[i.id] = false));
    const total = residue.value.reduce((s, i) => s + i.size, 0);
    void recordScan('residue', `${residue.value.length} 个目录 · ${formatSize(total)}`);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    resLoading.value = false;
    resScanned.value = true;
  }
}

async function doDeleteResidue() {
  const ids = resSelectedIds.value;
  if (!ids.length) {
    error.value = "没有勾选任何残留目录。";
    return;
  }
  if (
    !confirm(
      `确认清理 ${ids.length} 个残留目录（合计 ${formatSize(resSelectedSize.value)}）？\n` +
        `这些目录已匹配不到任何已安装程序，且长期未改动。\n` +
        `默认移入回收站，可在回收站还原。`,
    )
  ) {
    return;
  }
  resBusy.value = true;
  error.value = "";
  try {
    resResult.value = await deleteResidue(ids, false);
    await doScanResidue();
  } catch (e: any) {
    error.value = `清理失败：${String(e)}`;
  } finally {
    resBusy.value = false;
  }
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <PackageX :size="22" class="title-icon" />
      软件卸载
    </h1>
    <p class="muted">
      枚举已安装程序（与「控制面板 → 程序和功能」同源）。卸载命令由后端从注册表读取并启动，
      前端无法注入任意命令。卸载将调用软件自带卸载程序，可能需要管理员权限。
    </p>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'app' }" @click="tab = 'app'">
        已安装程序
      </button>
      <button class="tab" :class="{ active: tab === 'residue' }" @click="tab = 'residue'">
        卸载残留
      </button>
    </div>

    <div class="card fill-card" style="margin-top: 14px">
      <template v-if="tab === 'app'">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="doScan">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "扫描中…" : "扫描已安装程序" }}
        </button>
        <button v-if="loading" class="btn" @click="cancelScan">取消</button>
        <input
          v-model="keyword"
          class="search"
          placeholder="按名称 / 厂商筛选"
        />
        <span class="muted" v-if="loading">已扫描 {{ entries.length }} 个</span>
        <span class="muted" v-else-if="entries.length">
          共 {{ entries.length }} 个 · 合计
          {{ formatSize(totalSize * 1024) }}
        </span>
        <LastScan module="uninstall" />
      </div>
      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="lastResult && lastResult.launched" class="ok">
        已启动卸载程序：<code>{{ truncate(lastResult.command, 120) }}</code>
      </div>

      <div v-if="filtered.length" class="list fill-list">
        <!-- v-memo：卸载请求仅影响当前行 -->
        <div v-for="e in filtered" :key="e.id" v-memo="[e, busyId]" class="row">
          <div class="info">
            <div class="name">
              {{ e.name }}
              <span v-if="e.version" class="ver muted">v{{ e.version }}</span>
            </div>
            <div class="meta muted">
              <span v-if="e.publisher">{{ e.publisher }}</span>
              <span v-if="e.size_kb">· {{ formatSize(e.size_kb * 1024) }}</span>
            </div>
            <div class="loc muted" :title="e.install_location">
              {{ e.install_location || "—" }}
            </div>
          </div>
          <div class="row-actions">
            <button
              class="btn btn-danger"
              :disabled="busyId === e.id || !e.can_uninstall"
              :title="e.can_uninstall ? '卸载此程序' : '该项不可卸载'"
              @click="askUninstall(e)"
            >
              {{ busyId === e.id ? "启动中…" : "卸载" }}
            </button>
          </div>
        </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="PackageX"
        title="扫描中……"
      />
      <EmptyState
        v-else-if="!scanned"
        :icon="PackageX"
        title="暂未扫描"
        desc="点击「扫描已安装程序」枚举当前系统的软件列表。"
      />
      <EmptyState
        v-else
        :icon="SearchX"
        title="未发现对应记录"
        desc="当前账户下未枚举到已安装程序。"
      />
      </template>

      <!-- 卸载残留 -->
      <template v-else>
        <div class="toolbar">
          <button class="btn btn-primary" :disabled="resLoading" @click="doScanResidue">
            <span v-if="resLoading" class="spinner"></span>
            {{ resLoading ? "扫描中…" : "扫描残留目录" }}
          </button>
          <button v-if="resLoading" class="btn" @click="cancelScanResidue">
            取消
          </button>
          <span class="muted">体积 ≥</span>
          <input v-model.number="resMinMb" type="number" class="mini" min="1" />
          <span class="muted">MB 且</span>
          <input v-model.number="resMinDays" type="number" class="mini" min="0" />
          <span class="muted">天未改动</span>
          <span class="spacer" />
          <button
            class="btn btn-danger"
            :disabled="resBusy || resSelectedIds.length === 0"
            @click="doDeleteResidue"
          >
            {{ resBusy ? "清理中…" : `清理选中（${resSelectedIds.length}）` }}
          </button>
          <LastScan module="residue" />
        </div>
        <div v-if="resLoading" class="progress toolbar-progress">
          <div class="bar indeterminate"></div>
        </div>

        <div v-if="error" class="err">{{ error }}</div>
        <div v-if="resResult" class="ok">
          已删除 {{ resResult.deleted_count }} 项 ·
          {{ formatSize(resResult.deleted_size) }}
          <span v-if="resResult.skipped.length">
            · 跳过 {{ resResult.skipped.length }} 项
          </span>
        </div>

        <p class="muted small tip-line">
          判定方式：目录名匹配不到任何<b>已安装程序</b>（名称 / 厂商 / 安装目录），
          且长期未改动。系统目录与硬件厂商目录已排除；<b>默认不勾选</b>，请确认后再清理。
        </p>

        <div v-if="residue.length" class="list fill-list">
          <div v-for="i in residue" :key="i.id" class="row residue-row">
            <label class="chk">
              <input type="checkbox" v-model="resSelected[i.id]" />
            </label>
            <div class="info">
              <div class="name">
                {{ i.name }}
                <span class="src">{{ i.source }}</span>
              </div>
              <div class="meta muted">
                <span>{{ formatSize(i.size) }}</span>
                <span>· {{ i.days }} 天未改动</span>
              </div>
              <div class="loc muted" :title="i.path">{{ i.path }}</div>
            </div>
          </div>
        </div>
        <EmptyState
          v-else-if="resLoading"
          loading
          :icon="PackageX"
          title="扫描中……"
        />
        <EmptyState
          v-else-if="!resScanned"
          :icon="PackageX"
          title="暂未扫描"
          desc="点击「扫描残留目录」检测软件卸载后遗留的空壳目录。"
        />
        <EmptyState
          v-else
          :icon="SearchX"
          title="未发现对应记录"
          desc="当前阈值下没有发现残留目录。"
        />

        <div v-if="residue.length" class="foot muted">
          已选 {{ resSelectedIds.length }} 项 ·
          合计 {{ formatSize(resSelectedSize) }} · 默认移入回收站
        </div>
      </template>
    </div>

    <!-- 二次确认弹窗 -->
    <Transition name="fade">
      <div v-if="pending" class="mask" @click.self="pending = null">
        <div class="dialog card">
          <h2>确认卸载？</h2>
          <p>
            即将卸载 <b>{{ pending.name }}</b
            ><span v-if="pending.version">（v{{ pending.version }}）</span>。
            该操作会调用软件自带的卸载程序，可能不可恢复。
          </p>
          <label class="quiet">
            <input type="checkbox" v-model="quiet" />
            静默卸载（若程序支持，使用 QuietUninstallString）
          </label>
          <div class="actions">
            <button class="btn" @click="pending = null">取消</button>
            <button class="btn btn-danger" @click="confirmUninstall">
              确认卸载
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.tabs {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}
.tab {
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 9px;
  padding: 7px 14px;
  font-size: calc(13px * var(--fs-scale));
  cursor: pointer;
}
.tab.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.spacer {
  flex: 1;
}
.mini {
  width: 62px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 8px;
  padding: 5px 8px;
  font-size: calc(13px * var(--fs-scale));
}
.small {
  font-size: calc(11px * var(--fs-scale));
}
.tip-line {
  margin-top: 10px;
  line-height: 1.6;
}
.chk {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.src {
  font-size: calc(10px * var(--fs-scale));
  color: var(--primary);
  background: var(--primary-weak);
  border-radius: 5px;
  padding: 2px 7px;
  margin-left: 6px;
  font-weight: 400;
}
.foot {
  margin-top: 10px;
  font-size: calc(12px * var(--fs-scale));
}
.search {
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 8px 12px;
  font-size: calc(14px * var(--fs-scale));
  background: var(--bg);
  color: var(--text);
  min-width: 200px;
}
.list {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 2px;
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
/* 卸载残留行：勾选框 + 文本两项，让文本占满剩余宽度并左对齐（不居中/不右推）；
   勾选框与首行文字顶部对齐（flex-start），不随多行内容垂直居中 */
.residue-row {
  justify-content: flex-start;
  align-items: flex-start;
}
.residue-row .chk {
  padding-top: 2px;
}
.residue-row .info {
  flex: 1;
  min-width: 0;
}
.name {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 600;
}
.ver {
  font-size: calc(12px * var(--fs-scale));
  font-weight: 400;
  margin-left: 6px;
}
.meta {
  font-size: calc(12px * var(--fs-scale));
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.loc {
  font-size: calc(11px * var(--fs-scale));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60vw;
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
  word-break: break-all;
}
.ok code {
  font-size: calc(12px * var(--fs-scale));
}
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.dialog {
  width: 420px;
  max-width: 90vw;
}
.dialog h2 {
  margin-top: 0;
}
.quiet {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(13px * var(--fs-scale));
  color: var(--muted);
  margin: 10px 0 16px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
</style>
