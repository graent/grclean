<script setup lang="ts">
import { MousePointerClick, Image } from "@lucide/vue";
import { ref, computed } from "vue";
import {
  scanContextMenu,
  setContextMenuDisabled,
  deleteContextMenu,
  ctxBackupDir,
  scanShellIcons,
  deleteShellIcons,
  type ContextMenuItem,
  type ShellIconItem,
} from "../api/electron";
import { recordScan } from "../stores/history";
import LastScan from "../components/LastScan.vue";
import Modal from "../components/Modal.vue";
import EmptyState from "../components/EmptyState.vue";

/** 模块两个入口：右键菜单 / 此电脑外壳图标（§3.13 两项）。 */
type TabKey = "menu" | "icon";
const tab = ref<TabKey>("menu");

const items = ref<ContextMenuItem[]>([]);
const selected = ref<Record<string, boolean>>({});
const loading = ref(false);
/** 是否已读取过（区分「暂未扫描」与「已扫描无结果」两种空态） */
const scanned = ref(false);
const busy = ref(false);
const error = ref("");
const results = ref<Array<{ id: string; ok: boolean; message: string }>>([]);
/** 删除完成提示对话框（重新读取 / 暂不） */
const showDone = ref(false);
const keyword = ref("");
const onlyThirdParty = ref(true);
const backupPath = ref("");

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return items.value.filter((i) => {
    if (onlyThirdParty.value && i.system) return false;
    if (!kw) return true;
    return (
      i.name.toLowerCase().includes(kw) ||
      i.verb.toLowerCase().includes(kw) ||
      i.command.toLowerCase().includes(kw) ||
      i.source.toLowerCase().includes(kw)
    );
  });
});

const selectedIds = computed(() =>
  filtered.value.filter((i) => selected.value[i.id] && !i.system).map((i) => i.id),
);
const thirdPartyCount = computed(() => items.value.filter((i) => !i.system).length);

// ---------------- 外壳图标 ----------------
const icons = ref<ShellIconItem[]>([]);
const iconSelected = ref<Record<string, boolean>>({});
const iconLoading = ref(false);
/** 外壳图标是否已读取过（区分两种空态） */
const iconScanned = ref(false);
const iconBusy = ref(false);

const iconFiltered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return icons.value.filter((i) => {
    if (onlyThirdParty.value && i.system) return false;
    if (!kw) return true;
    return (
      i.name.toLowerCase().includes(kw) ||
      i.source.toLowerCase().includes(kw) ||
      i.dll.toLowerCase().includes(kw)
    );
  });
});

const iconSelectedIds = computed(() =>
  iconFiltered.value
    .filter((i) => iconSelected.value[i.id] && !i.system)
    .map((i) => i.id),
);

async function doScanIcons() {
  iconLoading.value = true;
  error.value = "";
  results.value = [];
  iconSelected.value = {};
  icons.value = [];
  try {
    // 逐条回调，从上方插入（边扫边出）；返回后用权威结果覆盖；seen 去重（O(n²) → O(n)）
    const seen = new Set<string>();
    icons.value = await scanShellIcons((it) => {
      if (!seen.has(it.id)) {
        seen.add(it.id);
        icons.value.unshift(it);
      }
    });
    if (!backupPath.value) backupPath.value = await ctxBackupDir();
    void recordScan('shellicon', `${icons.value.length} 项`);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    iconLoading.value = false;
    iconScanned.value = true;
  }
}

async function doDeleteIcons() {
  const ids = iconSelectedIds.value;
  if (!ids.length) {
    error.value = "没有选择要移除的图标。";
    return;
  }
  if (
    !confirm(
      `确认移除 ${ids.length} 个「此电脑」外壳图标？\n` +
        `删除前会自动导出 .reg 备份${backupPath.value ? `到：\n${backupPath.value}` : ""}\n` +
        `需要管理员权限，生效需重启资源管理器或注销。`,
    )
  ) {
    return;
  }
  iconBusy.value = true;
  error.value = "";
  try {
    results.value = await deleteShellIcons(ids);
    icons.value = await scanShellIcons(() => {});
    iconSelected.value = {};
    showDone.value = true;
  } catch (e: any) {
    error.value = `移除失败：${String(e)}`;
  } finally {
    iconBusy.value = false;
  }
}

async function doScan() {
  loading.value = true;
  error.value = "";
  results.value = [];
  selected.value = {};
  items.value = [];
  try {
    // 逐条回调，从上方插入（边扫边出）；返回后用权威结果覆盖；seen 去重（O(n²) → O(n)）
    const seen = new Set<string>();
    items.value = await scanContextMenu((it) => {
      if (!seen.has(it.id)) {
        seen.add(it.id);
        items.value.unshift(it);
      }
    });
    backupPath.value = await ctxBackupDir();
    void recordScan('contextmenu', `${items.value.length} 项`);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    scanned.value = true;
  }
}

async function toggleDisabled(disabled: boolean) {
  const ids = selectedIds.value;
  if (!ids.length) {
    error.value = "没有选择要操作的菜单项。";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    results.value = await setContextMenuDisabled(ids, disabled);
    items.value = await scanContextMenu(() => {});
    selected.value = {};
  } catch (e: any) {
    error.value = `操作失败：${String(e)}`;
  } finally {
    busy.value = false;
  }
}

async function doDelete() {
  const ids = selectedIds.value;
  if (!ids.length) {
    error.value = "没有选择要删除的菜单项。";
    return;
  }
  if (
    !confirm(
      `确认删除 ${ids.length} 个右键菜单项？\n` +
        `删除前会自动导出 .reg 备份${backupPath.value ? `到：\n${backupPath.value}` : ""}\n` +
        `需要管理员权限。`,
    )
  ) {
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    results.value = await deleteContextMenu(ids);
    items.value = await scanContextMenu(() => {});
    selected.value = {};
    showDone.value = true;
  } catch (e: any) {
    error.value = `删除失败：${String(e)}`;
  } finally {
    busy.value = false;
  }
}

/** 删除完成后：重新读取当前 Tab（刷新列表与结果），或关闭对话框。 */
function doneRescan() {
  showDone.value = false;
  if (tab.value === 'menu') doScan();
  else doScanIcons();
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <MousePointerClick :size="22" class="title-icon" />
      右键菜单 / 外壳图标
    </h1>
    <p class="muted">
      枚举 <code>HKEY_CLASSES_ROOT</code> 下各类 shell 谓词（文件 / 文件夹 / 桌面空白处 /
      驱动器）与「此电脑」命名空间扩展图标，列出第三方项，
      支持<b>禁用（可逆）</b>与<b>删除（自动 .reg 备份）</b>。
      系统内置项（打开 / 编辑 / 打印、桌面/文档/下载等）永不可操作。
    </p>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'menu' }" @click="tab = 'menu'">
        右键菜单
      </button>
      <button class="tab" :class="{ active: tab === 'icon' }" @click="tab = 'icon'">
        外壳图标（此电脑）
      </button>
    </div>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button
          v-if="tab === 'menu'"
          class="btn btn-primary"
          :disabled="loading"
          @click="doScan"
        >
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "读取中…" : "读取右键菜单" }}
        </button>
        <button
          v-else
          class="btn btn-primary"
          :disabled="iconLoading"
          @click="doScanIcons"
        >
          <span v-if="iconLoading" class="spinner"></span>
          {{ iconLoading ? "读取中…" : "读取外壳图标" }}
        </button>
        <input
          v-if="items.length"
          v-model="keyword"
          class="kw"
          placeholder="搜索名称 / 命令"
        />
        <label v-if="items.length" class="chk">
          <input type="checkbox" v-model="onlyThirdParty" />
          <span class="muted small">仅显示第三方（{{ thirdPartyCount }}）</span>
        </label>
        <span class="muted" v-if="items.length">
          共 {{ items.length }} 项，已筛出 {{ filtered.length }} 项
        </span>
        <LastScan :module="tab === 'menu' ? 'contextmenu' : 'shellicon'" />
      </div>

      <div v-if="loading || iconLoading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>
      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="backupPath && (items.length || icons.length)" class="muted small backup">
        备份目录：{{ backupPath }}
      </div>

      <div v-if="results.length" class="results">
        <div
          v-for="(r, i) in results"
          :key="i"
          class="res-row"
          :class="{ bad: !r.ok }"
        >
          <span class="res-msg">{{ r.message }}</span>
        </div>
      </div>

      <template v-if="tab === 'menu'">
      <div v-if="filtered.length" class="list fill-list">
        <div class="row head">
          <label class="chk">
            <input
              type="checkbox"
              :checked="selectedIds.length === filtered.filter((i) => !i.system).length && selectedIds.length > 0"
              @change="
                filtered.forEach(
                  (i) => (selected[i.id] = ($event.target as HTMLInputElement).checked && !i.system),
                )
              "
            />
          </label>
          <span class="muted small">全选（不含系统项）</span>
        </div>
          <div v-for="it in filtered" :key="it.id" class="row">
            <label class="chk">
              <input type="checkbox" v-model="selected[it.id]" :disabled="it.system" />
            </label>
            <div class="info">
              <div class="name">
                {{ it.name }}
                <span class="src">{{ it.source }}</span>
                <span v-if="it.system" class="sys">系统</span>
                <span v-else-if="it.disabled" class="off">已禁用</span>
              </div>
              <div class="path muted small" :title="it.command">
                {{ it.command || "（无命令）" }}
              </div>
            </div>
            <span class="spacer" />
            <span class="verb muted small">{{ it.verb }}</span>
          </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="MousePointerClick"
        title="读取中……"
      />
      <p v-else-if="items.length" class="muted">没有匹配的菜单项。</p>
      <EmptyState
        v-else-if="scanned"
        :icon="MousePointerClick"
        title="未发现对应记录"
        desc="没有读取到右键菜单项。"
      />
      <EmptyState
        v-else
        :icon="MousePointerClick"
        title="暂未扫描"
        desc="点击「读取菜单项」检测资源管理器右键菜单（含云盘、压缩工具注入项）。"
      />

      <div v-if="filtered.length" class="actions">
        <button
          class="btn"
          :disabled="busy || selectedIds.length === 0"
          @click="toggleDisabled(true)"
        >
          禁用选中（{{ selectedIds.length }}）
        </button>
        <button
          class="btn"
          :disabled="busy || selectedIds.length === 0"
          @click="toggleDisabled(false)"
        >
          启用选中
        </button>
        <button
          class="btn btn-danger"
          :disabled="busy || selectedIds.length === 0"
          @click="doDelete"
        >
          {{ busy ? "处理中…" : "删除选中（自动备份）" }}
        </button>
        <span class="muted">禁用优先于删除；删除需管理员权限。</span>
      </div>
      </template>

      <!-- 外壳图标 -->
      <template v-else>
        <div v-if="iconFiltered.length" class="list fill-list">
          <div class="row head">
            <label class="chk">
              <input
                type="checkbox"
                :checked="iconSelectedIds.length === iconFiltered.filter((i) => !i.system).length && iconSelectedIds.length > 0"
                @change="
                  iconFiltered.forEach(
                    (i) => (iconSelected[i.id] = ($event.target as HTMLInputElement).checked && !i.system),
                  )
                "
              />
            </label>
            <span class="muted small">全选（不含系统内置）</span>
          </div>
          <div v-for="it in iconFiltered" :key="it.id" class="row">
            <label class="chk">
              <input
                type="checkbox"
                v-model="iconSelected[it.id]"
                :disabled="it.system"
              />
            </label>
            <div class="info">
              <div class="name">
                {{ it.name }}
                <span class="src">{{ it.source }}</span>
                <span v-if="it.system" class="sys">系统</span>
              </div>
              <div class="path muted small" :title="it.dll">
                {{ it.dll || it.guid }}
              </div>
            </div>
            <span class="spacer" />
            <span class="verb muted small">{{ it.guid }}</span>
          </div>
        </div>
        <EmptyState
          v-else-if="iconLoading"
          loading
          :icon="Image"
          title="读取中……"
        />
        <p v-else-if="icons.length" class="muted">
          没有匹配的外壳图标。
        </p>
        <EmptyState
          v-else-if="iconScanned"
          :icon="Image"
          title="未发现对应记录"
          desc="没有读取到「此电脑」下的外壳图标项。"
        />
        <EmptyState
          v-else
          :icon="Image"
          title="暂未扫描"
          desc="点击「读取外壳图标」检测「此电脑」中的厂商图标（云盘 / 播放器 / 压缩工具常在此处留图标）。"
        />

        <div v-if="iconFiltered.length" class="actions">
          <button
            class="btn btn-danger"
            :disabled="iconBusy || iconSelectedIds.length === 0"
            @click="doDeleteIcons"
          >
            {{ iconBusy ? "处理中…" : `移除选中（${iconSelectedIds.length}，自动备份）` }}
          </button>
        <span class="muted">
          移除后重启资源管理器或注销即可生效；系统内置文件夹不可选。
        </span>
      </div>
      </template>
    </div>

    <!-- 删除完成提示：重新读取 / 暂不 -->
    <Modal
      :open="showDone"
      title="删除完成"
      width="420px"
      @update:open="showDone = $event"
    >
      <p>
        共处理 <b>{{ results.length }}</b> 项，其中
        <b>{{ results.filter((r) => r.ok).length }}</b> 项成功
        <template v-if="results.some((r) => !r.ok)">
          ，<span class="err">{{ results.filter((r) => !r.ok).length }}</span> 项失败
        </template>
        。删除前已自动导出 .reg 备份。
      </p>
      <template #footer>
        <button class="btn" @click="showDone = false">暂不</button>
        <button class="btn btn-primary" @click="doneRescan">重新读取</button>
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
.kw {
  width: 200px;
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
.backup {
  margin-top: 8px;
}
.list {
  margin-top: 12px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}
.row.head {
  border-bottom: 1px solid var(--border);
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(13px * var(--fs-scale));
  flex-shrink: 0;
}
.src {
  display: inline-block;
  font-size: calc(10px * var(--fs-scale));
  color: var(--primary);
  background: var(--primary-weak);
  border-radius: 5px;
  padding: 1px 7px;
  margin-left: 6px;
  vertical-align: 1px;
}
.info {
  min-width: 0;
}
.name {
  font-size: calc(13px * var(--fs-scale));
}
.sys {
  font-size: calc(10px * var(--fs-scale));
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0 6px;
  margin-left: 6px;
}
.off {
  font-size: calc(10px * var(--fs-scale));
  color: var(--warn, #d98324);
  border: 1px solid var(--warn, #d98324);
  border-radius: 5px;
  padding: 0 6px;
  margin-left: 6px;
}
.path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 44vw;
}
.verb {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.results {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.res-row {
  padding: 8px 14px;
  font-size: calc(12px * var(--fs-scale));
}
.res-row:nth-child(even) {
  background: var(--bg);
}
.res-row.bad {
  color: var(--danger);
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
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
