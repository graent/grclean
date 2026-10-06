<script setup lang="ts">
import { FolderTree, SearchX } from "@lucide/vue";
import EmptyState from "../components/EmptyState.vue";
import { ref, computed, onActivated, onDeactivated, onMounted, onUnmounted } from "vue";
import {
  tmRoots,
  tmAnalyze,
  tmCancel,
  onTreemapProgress,
  formatSize,
  type TreeNode,
  type AnalyzeProgress,
} from "../api/electron";

const roots = ref<Array<{ label: string; path: string }>>([]);
const root = ref("");
const depth = ref(3);
const tree = ref<TreeNode | null>(null);
const loading = ref(false);
const error = ref("");
const progress = ref<AnalyzeProgress | null>(null);

/** 下钻路径栈（首项为根）。 */
const stack = ref<TreeNode[]>([]);

let unsubscribe: (() => void) | null = null;

const current = computed<TreeNode | null>(
  () => stack.value[stack.value.length - 1] ?? tree.value,
);

const PALETTE = [
  "var(--primary)",
  "#3fa7a0",
  "#5b8fd6",
  "#8b6fd6",
  "#d98324",
  "#c96a7a",
  "#4a9d5f",
  "#7a8ba3",
];

/** 块颜色：按父层序号取色，同一父节点下的子块同色系深浅递进。 */
function blockColor(depthIdx: number, i: number): string {
  const base = PALETTE[depthIdx % PALETTE.length];
  if (base.startsWith("var(")) return base;
  // 十六进制色：按序号做明暗微调
  const hex = base.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const k = 1 - (i % 4) * 0.12;
  return `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
}

interface Block {
  node: TreeNode;
  x: number;
  y: number;
  w: number;
  h: number;
  d: number;
  i: number;
}

/**
 * 交替方向切分（slice-and-dice）树图布局。
 * 在 0–100 的百分比坐标系里工作，容器尺寸变化时自动适配。
 */
function layout(
  items: TreeNode[],
  x: number,
  y: number,
  w: number,
  h: number,
  horizontal: boolean,
  d: number,
  out: Block[],
): void {
  const total = items.reduce((s, it) => s + it.size, 0);
  if (total <= 0) return;
  let pos = 0;
  items.forEach((it, i) => {
    const frac = it.size / total;
    const bw = horizontal ? w * frac : w;
    const bh = horizontal ? h : h * frac;
    const bx = x + (horizontal ? pos : 0);
    const by = y + (horizontal ? 0 : pos);
    out.push({ node: it, x: bx, y: by, w: bw, h: bh, d, i });
    if (d < 2 && it.children.length && bw > 6 && bh > 6) {
      layout(
        it.children.slice(0, 8),
        bx + 0.3,
        by + 0.3,
        bw - 0.6,
        bh - 0.6,
        !horizontal,
        d + 1,
        out,
      );
    }
    pos += horizontal ? bw : bh;
  });
}

const blocks = computed<Block[]>(() => {
  const node = current.value;
  if (!node || !node.children.length) return [];
  const out: Block[] = [];
  layout(node.children.slice(0, 24), 0, 0, 100, 100, true, 0, out);
  return out;
});

/** 当前层子项列表（精确数字，树图之外再给一份可读清单）。 */
const rows = computed(() => {
  const node = current.value;
  if (!node) return [];
  const total = node.children.reduce((s, c) => s + c.size, 0) || 1;
  return node.children
    .slice()
    .sort((a, b) => b.size - a.size)
    .slice(0, 40)
    .map((c) => ({
      node: c,
      pct: (c.size / total) * 100,
      pctOfRoot: tree.value && tree.value.size ? (c.size / tree.value.size) * 100 : 0,
    }));
});

async function loadRoots() {
  try {
    roots.value = await tmRoots();
    if (roots.value.length) root.value = roots.value[0].path;
  } catch (e: any) {
    error.value = String(e);
  }
}

async function analyze() {
  if (!root.value) return;
  loading.value = true;
  error.value = "";
  progress.value = null;
  tree.value = null;
  stack.value = [];
  try {
    const t = await tmAnalyze(root.value, depth.value);
    tree.value = t;
    stack.value = [t];
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
    progress.value = null;
  }
}

function drill(node: TreeNode) {
  if (!node.children.length) return;
  stack.value.push(node);
}

function goto(idx: number) {
  stack.value = stack.value.slice(0, idx + 1);
}

/** 订阅目录分析进度（幂等：重复调用先取消旧订阅）。 */
function subscribe() {
  if (unsubscribe) return;
  unsubscribe = onTreemapProgress((p) => {
    progress.value = p;
  });
}
/** 取消订阅（幂等）。 */
function unsubscribeProgress() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

onMounted(async () => {
  await loadRoots();
  subscribe();
});

// KeepAlive：切走时退订、回到时重新订阅，避免缓存期间残留 IPC 监听
onActivated(subscribe);
onDeactivated(unsubscribeProgress);
onUnmounted(unsubscribeProgress);

function cancel() {
  tmCancel();
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <FolderTree :size="22" class="title-icon" />
      大目录钻取
    </h1>
    <p class="muted">
      逐层下钻定位空间大户：树图按体积占比切分，点击色块进入下一层，配合下方百分比清单精确定位。
      本模块只统计，不删除任何文件。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <select v-model="root" class="sel">
          <option v-for="r in roots" :key="r.path" :value="r.path">
            {{ r.label }} — {{ r.path }}
          </option>
        </select>
        <span class="muted">下钻层数</span>
        <input v-model.number="depth" type="number" class="inp" min="1" max="5" />
        <button class="btn btn-primary" :disabled="loading" @click="analyze">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "分析…" : "开始分析" }}
        </button>
        <button class="btn" :disabled="!loading" @click="cancel">取消</button>
      </div>

      <div v-if="error" class="err">{{ error }}</div>

      <div v-if="progress" class="prog">
        <div class="muted small ellipsis">正在扫描：{{ progress.current }}</div>
        <div class="muted small">
          目录 {{ progress.dirs }} · 文件 {{ progress.files }} ·
          {{ formatSize(progress.bytes) }}
        </div>
      </div>

      <template v-if="tree">
        <!-- 面包屑 -->
        <div class="crumbs">
          <span
            v-for="(n, i) in stack"
            :key="n.path + i"
            class="crumb"
            :class="{ last: i === stack.length - 1 }"
            @click="goto(i)"
          >
            {{ n.name || n.path }}
          </span>
          <span class="spacer" />
          <span class="muted small">
            当前层合计 {{ formatSize(current?.size ?? 0) }}
          </span>
        </div>

        <!-- 树图 -->
        <div class="tm-wrap">
          <div
            v-for="(b, i) in blocks"
            :key="b.node.path + i"
            class="tm-block"
            :style="{
              left: b.x + '%',
              top: b.y + '%',
              width: b.w + '%',
              height: b.h + '%',
              background: blockColor(b.d, b.i),
              borderColor: b.d === 0 ? 'var(--panel)' : 'transparent',
            }"
            :title="b.node.path + ' — ' + formatSize(b.node.size)"
            @click="drill(b.node)"
          >
            <span v-if="b.w > 8 && b.h > 5" class="tm-text">
              {{ b.node.name }}
            </span>
          </div>
          <EmptyState
            v-if="!blocks.length"
            :icon="SearchX"
            title="未发现对应记录"
            desc="该目录下没有子目录或体积为 0。"
          />
        </div>

        <!-- 精确清单 -->
        <div class="fill-list rows">
          <div v-for="(r, i) in rows" :key="r.node.path + i" class="row">
            <div class="row-head">
              <span class="row-name" @click="drill(r.node)">
                {{ r.node.name }}
              </span>
              <span class="spacer" />
              <span class="row-size">{{ formatSize(r.node.size) }}</span>
              <span class="row-pct">{{ r.pctOfRoot.toFixed(1) }}%</span>
            </div>
            <div class="row-path muted small ellipsis">{{ r.node.path }}</div>
            <div class="row-bar">
              <div class="row-fill" :style="{ width: r.pct + '%' }" />
            </div>
          </div>
        </div>
      </template>
      <EmptyState
        v-else-if="loading"
        loading
        :icon="FolderTree"
        title="分析中……"
      />
      <EmptyState
        v-else
        :icon="FolderTree"
        title="暂未扫描"
        desc="选择目录后点击「开始分析」，按体积钻取大目录。"
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
  padding: 14px 0;
}
.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sel {
  max-width: 320px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: calc(13px * var(--fs-scale));
}
.inp {
  width: 60px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: calc(13px * var(--fs-scale));
}
.prog {
  margin-top: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 14px 0 8px;
  flex-wrap: wrap;
}
.crumb {
  font-size: calc(12px * var(--fs-scale));
  color: var(--primary);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.crumb:hover {
  background: var(--primary-weak);
}
.crumb.last {
  color: var(--title);
  font-weight: 700;
  cursor: default;
}
.tm-wrap {
  position: relative;
  width: 100%;
  height: 300px;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg);
}
.tm-block {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid var(--panel);
  border-radius: 2px;
  cursor: pointer;
  overflow: hidden;
  transition: filter 0.12s;
}
.tm-block:hover {
  filter: brightness(1.12);
}
.tm-text {
  display: block;
  font-size: calc(10px * var(--fs-scale));
  color: #fff;
  padding: 4px 5px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
}
.rows {
  margin-top: 14px;
  max-height: 260px;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.row {
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
}
.row:last-child {
  border-bottom: none;
}
.row-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.row-name {
  font-size: calc(13px * var(--fs-scale));
  color: var(--text);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-name:hover {
  color: var(--primary);
}
.row-size {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  color: var(--title);
}
.row-pct {
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
  min-width: 46px;
  text-align: right;
}
.row-path {
  margin-top: 2px;
}
.row-bar {
  margin-top: 5px;
  height: 6px;
  border-radius: 3px;
  background: var(--border);
  overflow: hidden;
}
.row-fill {
  height: 100%;
  background: var(--primary);
}
.err {
  margin-top: 10px;
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
}
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
</style>
