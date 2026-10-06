<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import {
  scanBigFiles,
  cancelScan,
  listDisks,
  formatSize,
  buildScopeOptions,
  getLocal,
  setLocal,
  getCachedDisks,
  setCachedDisks,
  deleteOne,
  type BigFileEntry,
  type DiskInfo,
} from "../api/electron";
import { Package, FileSearch, SearchX, Trash2 } from "@lucide/vue";
import { recordScan } from "../stores/history";
import LastScan from "../components/LastScan.vue";
import Select from "../components/Select.vue";
import OpenFolder from "../components/OpenFolder.vue";
import Modal from "../components/Modal.vue";
import EmptyState from "../components/EmptyState.vue";

const SCOPE_KEY = "grclean.scope.big";

const minMb = ref(200);
/** 扫描范围：'C'/'D'…=指定盘符；'all'=全部盘符。默认系统盘，已持久化记忆。 */
const scope = ref(getLocal(SCOPE_KEY) || "");
/** 盘符列表：先用缓存瞬时填充，再后台刷新并缓存（避免每次进入都跑 PowerShell 查询）。 */
const disks = ref<DiskInfo[]>(getCachedDisks());
const files = ref<BigFileEntry[]>([]);
const loading = ref(false);
/** 是否已执行过一次分析（区分「暂未扫描」与「已扫描无结果」两种空态） */
const scanned = ref(false);
const error = ref("");
const maxSize = ref(1);
const scannedCount = ref(0);

/** 范围下拉选项：系统盘最上（默认），其余盘符按序，全部磁盘放最后。 */
const scopeOptions = computed(() => buildScopeOptions(disks.value));

/** 保证 scope 始终落在有效选项内（盘符缺失 / 旧值 '' 时回退到系统盘）。 */
function ensureScope() {
  const valid = scopeOptions.value.some((o) => o.value === scope.value);
  if (!valid) scope.value = scopeOptions.value[0]?.value ?? "all";
}

watch(scope, (v) => setLocal(SCOPE_KEY, v));

onMounted(async () => {
  // 后台刷新盘符列表并缓存；失败则保留上次缓存
  try {
    const list = await listDisks();
    disks.value = list;
    setCachedDisks(list);
  } catch {
    /* 保留缓存值 */
  }
  ensureScope();
});

const totalSize = computed(() =>
  files.value.reduce((s, f) => s + f.size, 0),
);

/** 单条删除：正在删除中的文件路径集合（逐行禁用按钮 + 转圈）。 */
const deleting = ref<Set<string>>(new Set());

/** 操作结果弹窗（删除成功 / 删除失败 / 打开目录失败 共用）。 */
const dlg = ref<{
  open: boolean;
  title: string;
  kind: "ok" | "err";
  message: string;
  detail: string;
}>({ open: false, title: "", kind: "ok", message: "", detail: "" });

function showDlg(kind: "ok" | "err", title: string, message: string, detail = "") {
  dlg.value = { open: true, kind, title, message, detail };
}

function pct(size: number) {
  return Math.max(2, Math.round((size / maxSize.value) * 100));
}

async function removeBig(f: BigFileEntry) {
  if (deleting.value.has(f.path)) return
  deleting.value.add(f.path)
  try {
    const r = await deleteOne(f.path)
    if (r.ok) {
      files.value = files.value.filter((x) => x.path !== f.path)
      showDlg(
        "ok",
        "删除成功",
        `已移入回收站，释放 ${formatSize(f.size)}。`,
        f.path,
      )
    } else {
      showDlg("err", "删除失败", r.error ?? "未知错误", f.path)
    }
  } catch (e: any) {
    showDlg("err", "删除失败", String(e), f.path)
  } finally {
    deleting.value.delete(f.path)
  }
}

async function doScan() {
  loading.value = true;
  error.value = "";
  files.value = [];
  scannedCount.value = 0;
  try {
    // 通过回调「逐条」追加大文件；新文件从列表上方插入（unshift），
    // 实现「从上方逐行增加」的流式观感；后端命令返回时再用权威排序结果覆盖。
    // seen 用 Set 去重：避免每来一项都对整表 some() 扫描（O(n²) → O(n)）
    const seen = new Set<string>();
    const res = await scanBigFiles(
      minMb.value,
      scope.value,
      (item) => {
        scannedCount.value += 1;
        if (!seen.has(item.path)) {
          seen.add(item.path);
          files.value.unshift(item);
        }
      },
    );
    files.value = res.slice().sort((a, b) => b.size - a.size);
    maxSize.value = files.value.reduce((m, f) => Math.max(m, f.size), 1);
    void recordScan('big', `${files.value.length} 个文件 · ${formatSize(totalSize.value)}`);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    scanned.value = true;
  }
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <Package :size="22" class="title-icon" />
      大文件分析
    </h1>
    <p class="muted">
      选择磁盘范围扫描大文件（仅分析）。阈值越大结果越少。扫描范围已记忆，下次进入仍为上次所选。每条结果右侧可「打开所在目录」或「删除（移入回收站）」。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <label class="muted">大小阈值 (MB)</label>
        <input class="num" type="number" v-model.number="minMb" min="1" />
        <label class="muted">扫描范围</label>
        <Select v-model="scope" :options="scopeOptions" :width="190" />
        <button class="btn btn-primary" :disabled="loading" @click="doScan">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "扫描中…" : "开始分析" }}
        </button>
        <button
          v-if="loading"
          class="btn"
          @click="cancelScan"
        >
          取消
        </button>
        <span v-if="loading" class="muted">已扫描 {{ scannedCount }} 个文件</span>
        <span v-if="error" class="err">{{ error }}</span>
        <LastScan module="big" />
      </div>
      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div v-if="files.length" class="list fill-list">
        <!-- v-memo：逐条删除/扫描追加时仅重渲染受影响的行 -->
        <div
          v-for="f in files"
          :key="f.path"
          v-memo="[f, deleting.has(f.path), maxSize]"
          class="row"
        >
          <span class="path" :title="f.path">{{ f.path }}</span>
          <div class="bar">
            <div class="fill" :style="{ width: pct(f.size) + '%' }"></div>
          </div>
          <span class="size muted">{{ formatSize(f.size) }}</span>
          <div class="actions">
            <OpenFolder
              :path="f.path"
              title="打开所在目录"
              @error="
                (m: string) =>
                  showDlg('err', '打开目录失败', m, f.path)
              "
            />
            <button
              class="row-del"
              type="button"
              title="删除（移入回收站）"
              no-drag
              :disabled="deleting.has(f.path)"
              @click.stop="removeBig(f)"
            >
              <span v-if="deleting.has(f.path)" class="spinner"></span>
              <Trash2 v-else :size="15" />
            </button>
          </div>
        </div>
      </div>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="FileSearch"
        title="分析中……"
      />
      <EmptyState
        v-else-if="!scanned"
        :icon="FileSearch"
        title="暂未扫描"
        desc="选择扫描范围与体积阈值，点击「开始分析」查找大文件。"
      />
      <EmptyState
        v-else
        :icon="SearchX"
        title="未发现对应记录"
        desc="当前阈值下没有发现大文件，可调低阈值后重新分析。"
      />
    </div>

    <!-- 单条删除 / 打开目录 的结果提示（弹窗，不再用行内大字提示） -->
    <Modal
      :open="dlg.open"
      :title="dlg.title"
      width="440px"
      @update:open="dlg.open = $event"
    >
      <p :class="dlg.kind === 'ok' ? 'dlg-ok' : 'dlg-err'">{{ dlg.message }}</p>
      <p v-if="dlg.detail" class="muted dlg-path">{{ dlg.detail }}</p>
      <template #footer>
        <button class="btn btn-primary" @click="dlg.open = false">确定</button>
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
  gap: 12px;
  flex-wrap: wrap;
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(13px * var(--fs-scale));
  cursor: pointer;
}
.num {
  width: 90px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
}
.list {
  margin-top: 14px;
}
.empty {
  margin-top: 14px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 2px;
  border-bottom: 1px solid var(--border);
}
.path {
  flex: 1;
  font-size: calc(13px * var(--fs-scale));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar {
  width: 30%;
  height: 8px;
  background: var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--primary);
  border-radius: 6px;
}
.size {
  width: 90px;
  text-align: right;
  font-size: calc(12px * var(--fs-scale));
  flex-shrink: 0;
}
.actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.row-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  flex: none;
  transition: color 0.15s;
}
.row-del:hover:not(:disabled) {
  color: var(--danger);
}
.row-del:disabled {
  cursor: default;
  opacity: 0.6;
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
}
.dlg-ok {
  color: var(--success);
  font-size: calc(14px * var(--fs-scale));
}
.dlg-err {
  color: var(--danger);
  font-size: calc(14px * var(--fs-scale));
}
.dlg-path {
  margin-top: 8px;
  font-size: calc(12px * var(--fs-scale));
  word-break: break-all;
}
</style>
