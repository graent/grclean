<script setup lang="ts">
import { ref, computed } from "vue";
import {
  scanAiCache,
  cancelScanAiCache,
  deleteAiCache,
  formatSize,
  type AiCacheItem,
  type AiLevel,
} from "../api/electron";
import { recordScan } from "../stores/history";
import LastScan from "../components/LastScan.vue";
import OpenFolder from "../components/OpenFolder.vue";
import Modal from "../components/Modal.vue";
import EmptyState from "../components/EmptyState.vue";
import { Bot, Trash2 } from "@lucide/vue";

/** 两级风险元信息（与 engine/ai_cache.ts 的 AI_LEVEL_META 保持一致）。 */
const LEVELS: Record<
  AiLevel,
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
    label: "① 安全 · 缓存/日志/更新",
    desc: "可自动重建，放心删（Cache / Temp / Log / 更新缓存）",
    color: "var(--success)",
    recommend: true,
    locked: false,
  },
  caution: {
    order: 2,
    label: "② 谨慎 · 模型/索引/工作区",
    desc: "可能还想保留（本地模型权重 / 代码索引 / 工作区），默认不勾",
    color: "var(--warn, #d98324)",
    recommend: false,
    locked: false,
  },
};

const LEVEL_ORDER: AiLevel[] = ["safe", "caution"];

/**
 * 支持的 AI 软件（固定顺序，与 engine/ai_cache.ts 的 AI_APPS 保持一致）。
 * 全部软件都会作为分组列出：扫到缓存的正常显示条目，未扫到的显示为空分组（体现出来）。
 */
const AI_APPS: string[] = [
  "Cursor",
  "Windsurf",
  "Trae",
  "Ollama",
  "LM Studio",
  "Jan",
  "GPT4All",
  "ChatGPT",
  "DeepSeek",
  "豆包",
  "WorkBuddy",
  "Claude Code",
  "Codex CLI",
  "Gemini CLI",
  "Aider",
  "CodeBuddy",
  "通义灵码",
  "文心快码Comate",
  "CodeGeeX",
  "Codeium",
  "Tabnine",
  "Cody",
  "Continue",
];

/**
 * 各 AI 软件对应的品牌代表图标（emoji）。
 * 项目图标库 @lucide/vue 不含品牌 Logo，故用「代表性 emoji」做区分。
 */
const APP_ICON: Record<string, string> = {
  Cursor: "🖱️",
  Windsurf: "🏄",
  Trae: "🪁",
  Ollama: "🦙",
  "LM Studio": "🧪",
  Jan: "🪟",
  GPT4All: "🤖",
  ChatGPT: "💬",
  DeepSeek: "🔍",
  豆包: "🫘",
  WorkBuddy: "🧠",
  "Claude Code": "🐙",
  "Codex CLI": "🧮",
  "Gemini CLI": "✨",
  Aider: "🤝",
  CodeBuddy: "🐝",
  通义灵码: "🐦",
  文心快码Comate: "🐾",
  CodeGeeX: "🐒",
  Codeium: "⚡",
  Tabnine: "🔢",
  Cody: "🐶",
  Continue: "➡️",
};

const items = ref<AiCacheItem[]>([]);
const selected = ref<Record<string, boolean>>({});
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const result = ref<{ deleted: number; size: number; skipped: number } | null>(
  null,
);
/** 清理确认对话框（软件自带 Modal，替代系统 confirm） */
const showConfirm = ref(false);
/** 确认对话框提示文案（含谨慎类警告） */
const confirmTip = ref("");
/** 错误/提示对话框（软件自带 Modal，替代系统内联提示） */
const showError = ref(false);
/** 清理完成提示对话框（重新扫描 / 暂不） */
const showDone = ref(false);
/** 是否已执行过一次扫描（控制列表显隐） */
const scanned = ref(false);
/** 扫描过程中累计「已扫描的文件/目录条目数」（反映真实扫描量，非命中条数） */
const scannedFiles = ref(0);
/** 删除进行中已成功删除的文件数（实时显示「已删除 N 项」） */
const deletedCount = ref(0);

/**
 * 列出全部软件分组（含空分组，体现出来）。
 * 排序：有结果的软件靠上（保持固定清单顺序），未扫到缓存的按名称字母/拼音序排在后面。
 */
const appGroups = computed(() => {
  const map = new Map<string, AiCacheItem[]>();
  for (const it of items.value) {
    const arr = map.get(it.app);
    if (arr) arr.push(it);
    else map.set(it.app, [it]);
  }
  // 以固定清单为本；engine 若返回清单外的新软件，兜底追加，避免条目分组丢失
  const apps = [...AI_APPS];
  for (const app of map.keys()) {
    if (!apps.includes(app)) apps.push(app);
  }
  const groups = apps.map((app) => {
    const list = map.get(app) ?? [];
    const sorted = [...list].sort(
      (a, b) =>
        LEVELS[a.level].order - LEVELS[b.level].order || b.size - a.size,
    );
    return {
      app,
      items: sorted,
      total: list.reduce((a, b) => a + b.size, 0),
      empty: list.length === 0,
    };
  });
  const found = groups.filter((g) => !g.empty);
  const empty = groups
    .filter((g) => g.empty)
    .sort((a, b) => a.app.localeCompare(b.app, "zh-Hans-CN"));
  return [...found, ...empty];
});

const selectedIds = computed(() =>
  items.value.filter((i) => selected.value[i.id] && !i.locked).map((i) => i.id),
);
/** 全部可选条目是否已选中 —— 控制「全选 / 全不选」按钮文案。 */
const allSelected = computed(() => {
  const selectable = items.value.filter((i) => !i.locked);
  return selectable.length > 0 && selectable.every((i) => selected.value[i.id]);
});
const selectedBytes = computed(() =>
  items.value
    .filter((i) => selected.value[i.id] && !i.locked)
    .reduce((a, b) => a + b.size, 0),
);
const totalBytes = computed(() =>
  items.value.reduce((a, b) => a + b.size, 0),
);

async function doScan() {
  loading.value = true;
  error.value = "";
  result.value = null;
  scanned.value = false;
  scannedFiles.value = 0;
  items.value = [];
  selected.value = {};
  try {
    const all = await scanAiCache(
      (it) => {
        items.value.unshift(it);
        // 默认勾选规则：安全级默认勾，谨慎级默认不勾
        if (!it.locked && LEVELS[it.level].recommend) {
          selected.value[it.id] = true;
        }
      },
      (n) => {
        scannedFiles.value = n;
      },
    );
    items.value = all;
    selected.value = {};
    for (const it of all) {
      if (!it.locked && LEVELS[it.level].recommend) selected.value[it.id] = true;
    }
    void recordScan(
      "aicache",
      `${items.value.length} 项 · ${formatSize(totalBytes.value)}`,
    );
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    scanned.value = true;
  }
}

function toggleLevel(level: AiLevel, on: boolean) {
  for (const it of items.value) {
    if (it.locked || it.level !== level) continue;
    selected.value[it.id] = on;
  }
}

function levelSelectedCount(level: AiLevel) {
  return items.value.filter(
    (i) => i.level === level && !i.locked && selected.value[i.id],
  ).length;
}

function levelTotalCount(level: AiLevel) {
  return items.value.filter((i) => i.level === level && !i.locked).length;
}

/** 某软件「可选条目」已选数量。 */
function appSelectedCount(app: string) {
  return items.value.filter(
    (i) => i.app === app && !i.locked && selected.value[i.id],
  ).length;
}

/** 某软件「可选条目」总数。 */
function appTotalCount(app: string) {
  return items.value.filter((i) => i.app === app && !i.locked).length;
}

/** 整类全选 / 全不选（仅作用于该软件的非锁定条目）。 */
function toggleApp(app: string, on: boolean) {
  for (const it of items.value) {
    if (it.locked || it.app !== app) continue;
    selected.value[it.id] = on;
  }
}

/** 一键「全选 / 全不选」。 */
function toggleSelectAll() {
  const on = !allSelected.value;
  for (const it of items.value) {
    if (it.locked) continue;
    selected.value[it.id] = on;
  }
}

function openDeleteConfirm() {
  const ids = selectedIds.value;
  if (!ids.length) {
    error.value = "没有选择要清理的缓存项。";
    showError.value = true;
    return;
  }
  const hasCaution = items.value.some(
    (i) => selected.value[i.id] && i.level === "caution",
  );
  confirmTip.value = hasCaution
    ? `注意：勾选中包含「谨慎 · 模型/索引/工作区」，其中的本地模型权重、代码索引等删除后需重新下载/索引（不可恢复）。\n\n确认将 ${ids.length} 项（${formatSize(selectedBytes.value)}）移入回收站？`
    : `确认将 ${ids.length} 项（${formatSize(selectedBytes.value)}）移入回收站？软件功能不受影响（缓存会自动重建）。`;
  showConfirm.value = true;
}

async function doDelete() {
  showConfirm.value = false;
  const ids = selectedIds.value;
  busy.value = true;
  error.value = "";
  deletedCount.value = 0;
  try {
    const res = await deleteAiCache(ids, false, (ev) => {
      deletedCount.value += ev.ids.length;
    });
    const failed = res.skipped.length + res.errors.length;
    result.value = {
      deleted: res.deleted_count,
      size: res.deleted_size,
      skipped: failed,
    };
    // 清理后移除已成功的条目，保留剩余（含跳过项）
    const done = new Set(
      items.value
        .filter((i) => ids.includes(i.id))
        .filter((i) => !res.skipped.some((s) => s.id === i.id))
        .map((i) => i.id),
    );
    items.value = items.value.filter((i) => !done.has(i.id));
    showDone.value = true;
  } catch (e: any) {
    error.value = `清理失败：${String(e)}`;
    showError.value = true;
  } finally {
    busy.value = false;
  }
}

function dismissError() {
  showError.value = false;
}

function doneRescan() {
  showDone.value = false;
  doScan();
}

/** 单行删除：确认弹框相关状态。 */
const showRowDel = ref(false);
const rowDelBusy = ref(false);
const rowDelTarget = ref<AiCacheItem | null>(null);

function askDeleteRow(it: AiCacheItem) {
  if (it.locked) return;
  rowDelTarget.value = it;
  showRowDel.value = true;
}

async function confirmRowDelete() {
  const it = rowDelTarget.value;
  if (!it) return;
  rowDelBusy.value = true;
  error.value = "";
  try {
    const res = await deleteAiCache([it.id], false);
    const skipped = res.skipped.some((s) => s.id === it.id);
    if (res.errors.length || skipped) {
      const reason =
        res.skipped.find((s) => s.id === it.id)?.reason ?? res.errors.join("；");
      error.value = `未能删除：${reason}`;
      showError.value = true;
    } else {
      items.value = items.value.filter((x) => x.id !== it.id);
      result.value = {
        deleted: res.deleted_count,
        size: res.deleted_size,
        skipped: 0,
      };
      showDone.value = true;
    }
  } catch (e: any) {
    error.value = `删除失败：${String(e)}`;
    showError.value = true;
  } finally {
    rowDelBusy.value = false;
    showRowDel.value = false;
    rowDelTarget.value = null;
  }
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon"><Bot :size="20" class="title-icon" />AI 软件专清</h1>
    <p class="muted">
      支持 Cursor / Windsurf / Trae / Ollama / LM Studio / Claude Code / CodeBuddy /
      WorkBuddy / 通义灵码 等 {{ AI_APPS.length }}+ 款 AI 工具。缓存按两级风险分级，自动搜寻常见路径。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="doScan">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "扫描中…" : "扫描 AI 软件缓存" }}
        </button>
        <button v-if="loading" class="btn" @click="cancelScanAiCache">
          取消
        </button>
        <span v-if="loading" class="scan-count">
          已扫描 {{ scannedFiles }} 个文件
        </span>
        <span class="muted" v-if="items.length">
          共 {{ items.length }} 项 · 合计 {{ formatSize(totalBytes) }}
        </span>
        <LastScan module="aicache" />
      </div>
      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <!-- 两级风险图例 -->
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
        </div>
      </div>

      <!-- 外层 transition-group：扫描过程中「有结果的分组浮到上面」时平滑位移，不跳动 -->
      <transition-group
        v-if="scanned || loading"
        name="appgrp"
        tag="div"
        class="list fill-list"
      >
        <div
          v-for="g in appGroups"
          :key="g.app"
          class="app-card"
          :class="{ 'app-empty': g.empty }"
        >
          <div class="app-head">
            <label class="chk">
              <input
                type="checkbox"
                :checked="
                  appTotalCount(g.app) > 0 &&
                  appSelectedCount(g.app) === appTotalCount(g.app)
                "
                :disabled="appTotalCount(g.app) === 0"
                @change="toggleApp(g.app, ($event.target as HTMLInputElement).checked)"
              />
            </label>
            <span class="app-emoji">{{ APP_ICON[g.app] ?? "🤖" }}</span>
            <span class="app-name">{{ g.app }}</span>
            <span class="badge" :class="{ 'badge-empty': g.empty }">
              {{ g.items.length }} 项
            </span>
            <span class="muted" v-if="!g.empty">{{ formatSize(g.total) }}</span>
          </div>
          <!-- 全程用 transition-group（无 v-memo）：扫描时逐条淡入（丝滑增加），删除时逐条淡出（丝滑减少）。
               注意：空白闪烁 bug 只在 transition-group + v-memo 同存时才出现，此处不用 v-memo，故安全。 -->
          <transition-group
            name="delrow"
            tag="div"
            class="grp-rows"
          >
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
                {{ LEVELS[it.level].label.slice(0, 2) }}
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
              <button
                v-if="!it.locked"
                class="row-del-btn"
                type="button"
                title="删除此缓存（移入回收站）"
                no-drag
                :disabled="rowDelBusy"
                @click="askDeleteRow(it)"
              >
                <Trash2 :size="15" />
              </button>
            </div>
          </transition-group>
          <!-- 未扫到缓存的软件：分组保留、结果列表为空，但用一行空态提示体现出来 -->
          <div v-if="g.empty" class="grp-empty muted small">
            {{ loading ? "扫描中…" : "未检测到可清理缓存" }}
          </div>
        </div>
      </transition-group>
      <EmptyState
        v-else
        :icon="Bot"
        title="暂未扫描"
        desc="点击「扫描 AI 软件缓存」检测 Cursor、Ollama、Claude Code、WorkBuddy 等 AI 工具的可清理缓存；未检测到缓存的软件也会列出空分组。"
      />

      <div v-if="items.length" class="actions">
        <button
          class="btn btn-primary"
          :disabled="busy || selectedIds.length === 0"
          @click="openDeleteConfirm"
        >
          <template v-if="busy">清理中…</template>
          <template v-else>
            清理选中（{{ selectedIds.length }} ·
            {{ formatSize(selectedBytes) }}）
          </template>
        </button>
        <button class="btn" :disabled="busy || !items.length" @click="toggleSelectAll">
          {{ allSelected ? "全不选" : "全选" }}
        </button>
        <span v-if="busy" class="badge del-count"
          >已删除 {{ deletedCount }} 项</span
        >
        <span class="muted">默认移入回收站，可从回收站还原；仅清除缓存，不影响软件运行。</span>
      </div>
    </div>

    <!-- 清理确认对话框 -->
    <Modal
      :open="showConfirm"
      title="确认清理"
      width="440px"
      @update:open="showConfirm = $event"
    >
      <p style="white-space: pre-line">{{ confirmTip }}</p>
      <p class="muted small">
        默认移入回收站，可从回收站还原；仅清除缓存，不影响软件运行。
      </p>
      <template #footer>
        <button class="btn" @click="showConfirm = false">取消</button>
        <button class="btn btn-danger" :disabled="busy" @click="doDelete">
          确认删除
        </button>
      </template>
    </Modal>

    <!-- 清理提示 / 错误对话框 -->
    <Modal
      :open="showError"
      title="清理提示"
      width="440px"
      @update:open="showError = $event"
    >
      <p>{{ error }}</p>
      <template #footer>
        <button class="btn btn-primary" @click="dismissError">我知道了</button>
      </template>
    </Modal>

    <!-- 单行删除确认 -->
    <Modal
      :open="showRowDel"
      title="删除缓存项"
      width="440px"
      @update:open="showRowDel = $event"
    >
      <p v-if="rowDelTarget">确认将以下缓存项移入回收站？可从回收站还原。</p>
      <div v-if="rowDelTarget" class="row-del-path">
        <div class="row-del-name">{{ rowDelTarget.name }} · {{ formatSize(rowDelTarget.size) }}</div>
        <div class="row-del-loc">{{ rowDelTarget.path }}</div>
      </div>
      <template #footer>
        <button class="btn" :disabled="rowDelBusy" @click="showRowDel = false">取消</button>
        <button class="btn btn-danger" :disabled="rowDelBusy" @click="confirmRowDelete">
          {{ rowDelBusy ? "删除中…" : "移入回收站" }}
        </button>
      </template>
    </Modal>

    <!-- 清理完成提示：重新扫描 / 暂不 -->
    <Modal
      :open="showDone"
      title="清理完成"
      width="420px"
      @update:open="showDone = $event"
    >
      <template v-if="result">
        <p>
          已移入回收站 <b>{{ result.deleted }}</b> 个缓存项，释放
          {{ formatSize(result.size) }}
        </p>
        <p v-if="result.skipped > 0" class="muted">
          {{ result.skipped }} 项未能清理（多为文件被其他程序占用或受系统保护），可从回收站还原已删除项。
        </p>
        <p class="muted">软件运行不受影响。</p>
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
.grp-rows {
  /* 删除动画期间子项绝对定位，需要相对定位的容器 */
  position: relative;
}
.delrow-move,
.delrow-enter-active,
.delrow-leave-active {
  transition: transform 0.28s ease, opacity 0.28s ease;
}
.delrow-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
.delrow-leave-to {
  opacity: 0;
  transform: translateX(8px);
}
.delrow-leave-active {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 2;
  content-visibility: visible !important;
}
/* 分组重排（有结果靠上 / 空组字母序）时的平滑位移 */
.appgrp-move {
  transition: transform 0.28s ease;
}
.app-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
}
/* 未检测到缓存的软件：分组照常列出，但整卡略弱化，与有内容的分组区分 */
.app-empty {
  background: color-mix(in srgb, var(--bg) 60%, transparent);
}
.app-empty .app-head {
  margin-bottom: 0;
}
.badge-empty {
  background: var(--bg);
  color: var(--muted);
  font-weight: 500;
}
.grp-empty {
  border-top: 1px solid var(--border);
  margin-top: 6px;
  padding: 10px 2px 2px;
  text-align: left;
}
.app-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
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
.scan-count {
  font-size: calc(13px * var(--fs-scale));
  color: var(--muted);
  font-weight: 500;
}
.del-count {
  background: color-mix(in srgb, var(--success) 16%, transparent);
  color: var(--success);
  border-radius: 6px;
  padding: 2px 10px;
  font-size: calc(12px * var(--fs-scale));
  font-weight: 600;
}
.row-del-btn {
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
.row-del-btn:hover:not(:disabled) {
  color: var(--danger);
}
.row-del-btn:disabled {
  cursor: default;
  opacity: 0.6;
}
.row-del-path {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg);
  padding: 8px 10px;
}
.row-del-name {
  font-size: calc(13px * var(--fs-scale));
  color: var(--text);
}
.row-del-loc {
  margin-top: 4px;
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
  word-break: break-all;
}
</style>
