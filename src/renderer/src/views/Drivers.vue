<script setup lang="ts">
import { Cpu, Search, SearchX } from "@lucide/vue";
import { ref, computed, onMounted } from "vue";
import {
  scanDrivers,
  deleteDrivers,
  openExternal,
  formatSize,
  type DriverItem,
} from "../api/electron";
import OpenFolder from "../components/OpenFolder.vue";
import EmptyState from "../components/EmptyState.vue";

const items = ref<DriverItem[]>([]);
const selected = ref<Record<string, boolean>>({});
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const note = ref("");
const results = ref<Array<{ id: string; ok: boolean; message: string }>>([]);
// 默认展示全部驱动包；非「可安全清理」的项仍不可勾选（见下方 disabled 逻辑）。
const onlyCandidate = ref(false);
const scanned = ref(0);
const total = ref(0);
// 正在从本地记忆恢复上次结果（分帧填充列表）
const restoring = ref(false);
const LS_KEY = "grclean.drivers.lastScan";
const lastScan = ref<{
  time: string;
  total: number;
  candidate: number;
  candidateBytes: number;
  items: DriverItem[];
} | null>(null);

const filtered = computed(() =>
  onlyCandidate.value ? items.value.filter((i) => i.candidate) : items.value,
);
const selectedIds = computed(() =>
  filtered.value.filter((i) => selected.value[i.id] && i.candidate).map((i) => i.id),
);
const selectedBytes = computed(() =>
  filtered.value
    .filter((i) => selected.value[i.id] && i.candidate)
    .reduce((a, b) => a + b.size, 0),
);
const candidateBytes = computed(() =>
  items.value.filter((i) => i.candidate).reduce((a, b) => a + b.size, 0),
);

/** 当无可清理候选时给用户的明确说明（含采集诊断）。 */
const candidateHint = computed(() => {
  if (note.value) return note.value
  if (items.value.length > 0 && candidateBytes.value === 0) {
    return '本机未检测到可安全清理的孤立驱动包（当前均在使用、或没有更新版本可替代，所有项均不可勾选）。'
  }
  return ''
});

const pct = computed(() =>
  total.value > 0 ? Math.round((scanned.value / total.value) * 100) : 0,
);

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function buildLastScan(items: DriverItem[]) {
  const candidate = items.filter((i) => i.candidate).length;
  const candidateBytes = items.filter((i) => i.candidate).reduce((a, b) => a + b.size, 0);
  return { time: new Date().toISOString(), total: items.length, candidate, candidateBytes, items };
}

function saveLastScan(items: DriverItem[]) {
  const snap = buildLastScan(items);
  lastScan.value = snap;
  // JSON.stringify + 写 localStorage 都是同步阻塞操作，放到下一个任务执行，
  // 避免扫描刚结束时界面更新（loading 收起、结果渲染）被拖住。
  setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(snap));
    } catch {
      /* 序列化/容量失败：仅内存记录 */
    }
  }, 0);
}

function loadLastScan() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) lastScan.value = JSON.parse(raw);
  } catch {
    /* ignore */
  }
}

/** 打开浏览器搜索该驱动的相关信息（厂商 + 原始 INF 名 + 版本）。 */
function searchDriver(it: DriverItem) {
  const q = [it.providerName, it.originalName, it.driverVersion]
    .filter(Boolean)
    .join(" ");
  const url =
    "https://www.bing.com/search?q=" +
    encodeURIComponent((q + " 驱动").trim());
  openExternal(url);
}

/**
 * 名称行标签：
 * - 「可信等级」tag（不显眼）：系统自带→系统；厂商已知→可信；未知来源不显示；
 * - 「正在使用」tag：status === 'in_use'（含采集不可靠时一律视为在用）；
 * - 「可删」tag：仅安全清理候选显示（其余靠复选框禁用区分）。
 */
function nameTags(it: DriverItem): { label: string; cls: string }[] {
  const tags: { label: string; cls: string }[] = []
  // 可信等级：可信（系统自带 / 已知厂商）才显示；不可信（未知来源）不显示标签
  if (it.isSystem) tags.push({ label: "系统", cls: "tag tag-trust" })
  else if (hasText(it.providerName)) tags.push({ label: "可信", cls: "tag tag-trust" })
  // 使用中状态（采集不可靠时所有项均视为在用，同样显示）
  if (it.status === "in_use") tags.push({ label: "正在使用", cls: "tag tag-warn" })
  if (it.candidate) tags.push({ label: "可删", cls: "tag tag-ok" })
  return tags
}

/** 仅当字段有内容且不是字面量 "unknown" 时才显示。 */
function hasText(v?: string | null): boolean {
  return !!v && v.trim().toLowerCase() !== "unknown"
}

/** 驱动类 → 中文设备类别（参考 lightC 的 class 映射）。 */
const CLASS_LABELS: Record<string, string> = {
  bluetooth: "蓝牙设备",
  camera: "摄像头",
  cdrom: "光驱",
  computer: "计算机",
  display: "显示器",
  extension: "驱动扩展",
  hiddclass: "外设（键鼠等）",
  hidclass: "外设（键鼠等）",
  keyboard: "键盘",
  media: "媒体设备",
  modem: "调制解调器",
  mouse: "鼠标",
  net: "网络适配器",
  ports: "串口/并口",
  printer: "打印机",
  processor: "处理器",
  system: "系统设备",
  "system devices": "系统设备",
  softwarecomponent: "软件组件",
  "software component": "软件组件",
  usb: "USB 设备",
};
function classLabel(cls?: string): string {
  if (!cls) return "";
  const key = cls.trim().toLowerCase();
  return CLASS_LABELS[key] || cls;
}

/** 等浏览器完成一次绘制后再执行：先让页面骨架（标题 / 工具栏 / 空态）画出来，
 *  再做读盘、列表恢复这类重活，避免切换页面时主线程被占满而出现白屏。 */
function afterPaint(fn: () => void) {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

/** 分帧恢复上次结果：每帧只追加一小批，避免一次性插入上千行 DOM 阻塞渲染。 */
let restoreGen = 0;
async function restoreItems(list: DriverItem[]) {
  const gen = ++restoreGen;
  restoring.value = true;
  const CHUNK = 80;
  for (let i = 0; i < list.length; i += CHUNK) {
    if (gen !== restoreGen) return; // 已被新一轮扫描 / 删除接管
    items.value.push(...list.slice(i, i + CHUNK));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  if (gen === restoreGen) restoring.value = false;
}

onMounted(() => {
  // 历史上扫出过的结果条目可能上千条：同步读取 localStorage 并一次性渲染
  // 会阻塞页面切换动画造成短暂白屏。改为首帧绘制之后再异步、分帧恢复。
  afterPaint(() => {
    if (restoreGen !== 0) return; // 挂载后已被用户手动扫描，跳过恢复
    loadLastScan();
    const snap = lastScan.value;
    if (snap && snap.items.length) void restoreItems(snap.items);
  });
});

async function doScan() {
  console.log("[Drivers] doScan click -> start");
  restoreGen++; // 中止可能仍在进行的历史结果恢复
  restoring.value = false;
  loading.value = true;
  error.value = "";
  note.value = "";
  results.value = [];
  selected.value = {};
  items.value = [];
  scanned.value = 0;
  total.value = 0;
  try {
    // 后端逐条发送驱动包（从上方插入），前端边扫边显示；
    // 命令返回时用按体积降序的权威结果覆盖。
    // seen 用 Set 去重：避免每来一项都对整表 some() 扫描（O(n²) → O(n)）
    const seen = new Set<string>();
    const res = await scanDrivers(
      (it) => {
        if (!seen.has(it.id)) {
          seen.add(it.id);
          items.value.unshift(it);
        }
      },
      (s, t) => {
        scanned.value = s;
        total.value = t;
      },
    );
    items.value = res.items;
    note.value = res.note;
    const cand = res.items.filter((i) => i.candidate).length;
    console.log(
      "[Drivers] scan done items=" +
        res.items.length +
        " candidate=" +
        cand +
        " note=" +
        res.note,
    );
    // 调试参考：打印前 3 个驱动包的完整字段
    // res.items.slice(0, 30).forEach((it, idx) => {
    //   console.log(`[Drivers] sample[${idx}]`, JSON.parse(JSON.stringify(it)));
    // });
    saveLastScan(res.items);
  } catch (e: any) {
    error.value = String(e);
    console.log("[Drivers] scan error", e);
  } finally {
    loading.value = false;
  }
}

async function doDelete() {
  const ids = selectedIds.value;
  if (!ids.length) {
    error.value = "没有选择可安全删除的驱动包。";
    return;
  }
  if (
    !confirm(
      `确认删除 ${ids.length} 个孤立驱动包（${formatSize(selectedBytes.value)}）？\n\n` +
        `仅删除「无设备使用」的旧版本，当前在用驱动不会被触碰。\n` +
        `此操作需要管理员权限（pnputil /delete-driver）。`,
    )
  ) {
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    results.value = await deleteDrivers(ids);
    // 删除后刷新：静默重扫（不重置 loading，避免按钮闪烁）
    restoreGen++; // 中止可能仍在进行的历史结果恢复
    restoring.value = false;
    const res = await scanDrivers(() => {}, () => {});
    items.value = res.items;
    saveLastScan(res.items);
    selected.value = {};
  } catch (e: any) {
    error.value = `删除失败：${String(e)}`;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <Cpu :size="22" class="title-icon" />
      驱动清理
    </h1>
    <p class="muted">
      扫描 <code>DriverStore\FileRepository</code> 中<b>已安装但设备不再使用</b>的旧驱动包。
      <b>仅删确认无设备使用的旧版本，当前在用驱动绝不碰</b>；无法解析发布名的目录只展示体积、不提供删除。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="doScan">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "扫描中…" : "扫描驱动包" }}
        </button>
        <label v-if="items.length" class="chk">
          <input type="checkbox" v-model="onlyCandidate" />
          <span class="muted small">仅显示可清理候选</span>
        </label>
        <span class="muted" v-if="items.length">
          共 {{ items.length }} 个驱动包 · 候选可释放
          {{ formatSize(candidateBytes) }}
        </span>
        <span class="spacer" />
        <span v-if="lastScan && !loading" class="last-scan muted small">
          上次扫描：{{ fmtTime(lastScan.time) }} · 共 {{ lastScan.total }} 个 · 候选可释放
          {{ formatSize(lastScan.candidateBytes) }}
        </span>
      </div>

      <div v-if="loading" class="d-progress">
        <div
          class="d-bar"
          :class="{ indet: total === 0 }"
          :style="total > 0 ? { width: pct + '%' } : {}"
        ></div>
      </div>
      <p v-if="loading" class="muted small">
        已扫描 {{ scanned }}{{ total > 0 ? ' / ' + total : '' }} 个驱动目录…
      </p>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="candidateHint && !loading" class="warn">
        {{ candidateHint }}
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

      <div v-if="filtered.length" class="list fill-list">
        <div v-for="it in filtered" :key="it.id" class="row">
          <label class="chk" :class="{ disabled: !it.candidate }">
            <input
              type="checkbox"
              v-model="selected[it.id]"
              :disabled="!it.candidate"
            />
          </label>
          <div class="info">
            <div class="name">
              {{ it.name }}
              <span v-for="(t, i) in nameTags(it)" :key="i" :class="t.cls">{{ t.label }}</span>
            </div>
          <!---- 原始名称信息---->
            <div class="meta muted small">
              <span v-if="hasText(it.originalName)">{{ it.originalName }}</span>
              <span v-if="hasText(it.providerName)">{{ it.providerName }}</span>
              <span v-if="hasText(it.driverVersion)">{{ it.driverVersion }}</span>
              <span v-if="hasText(it.className)" class="cat">{{ classLabel(it.className) }}</span>
            </div>
            <!-- <div v-if="it.reason" class="reason muted small">{{ it.reason }}</div> -->
            <div class="stats muted small">
              <span title="使用该驱动的设备数">设备：{{ it.deviceCount ?? 0 }}</span>
              <span title="活动中的设备数">活跃：{{ it.activeDeviceCount ?? 0 }}</span>
              <span title="当前正式使用的设备数">当前：{{ it.installedDeviceCount ?? 0 }}</span>
              <span title="可替代的驱动数">替代：{{ it.outrankedDeviceCount ?? 0 }}</span>
              <span title="文件数">文件：{{ it.fileCount ?? 0 }}</span>
            </div>
            <div class="path muted small" :title="it.path">
              <span v-if="it.published" class="mono">{{ it.published }}</span>
              <span v-if="it.published" class="sep">·</span>
              {{ it.path }}
            </div>
          </div>
          <span class="size">{{ formatSize(it.size) }}</span>
          <button
            class="icon-btn"
            type="button"
            title="搜索该驱动信息"
            no-drag
            @click.stop="searchDriver(it)"
          >
            <Search :size="15" />
          </button>
          <OpenFolder :path="it.path" />
        </div>
      </div>
      <EmptyState
        v-else-if="loading || restoring"
        loading
        :icon="Cpu"
        :title="loading ? '扫描中……' : '读取上次结果……'"
      />
      <EmptyState
        v-else-if="items.length"
        :icon="SearchX"
        title="未发现对应记录"
        desc="没有符合条件的驱动包。"
      />
      <EmptyState
        v-else
        :icon="Cpu"
        title="暂未扫描"
        desc="点击「扫描驱动包」读取驱动存储（WMI / pnputil），建议以管理员身份运行。"
      />

      <div v-if="filtered.length" class="actions">
        <button
          class="btn btn-danger"
          :disabled="busy || selectedIds.length === 0"
          @click="doDelete"
        >
          {{ busy ? "删除中…" : `删除已勾选驱动包（${selectedIds.length} · ${formatSize(selectedBytes)}）` }}
        </button>
        <span class="muted">需要管理员权限；删除后若设备重新接入，系统会重新安装驱动。</span>
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
  margin-top: 12px;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 2px;
  border-bottom: 1px solid var(--border);
  /* 大列表性能：屏幕外的行跳过布局与绘制（配合分帧恢复，
     避免进入页面 / 切回页面时一次性布局上千行而卡顿） */
  content-visibility: auto;
  contain-intrinsic-size: auto 104px;
}
.chk {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-top: 2px;
}
.chk.disabled {
  opacity: 0.4;
}
.info {
  min-width: 0;
  flex: 1;
}
.name {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tag {
  font-size: calc(11px * var(--fs-scale));
  font-weight: 700;
  border-radius: 5px;
  padding: 1px 7px;
  border: 1px solid var(--border);
  color: var(--muted);
  flex-shrink: 0;
}
.tag-warn {
  color: var(--warn, #d98324);
  border-color: var(--warn, #d98324);
}
.tag-ok {
  color: var(--success, #2e9e5b);
  border-color: var(--success, #2e9e5b);
}
.tag-info {
  color: var(--primary);
  border-color: var(--primary);
}
.tag-sys {
  color: #6b7280;
  border-color: #6b7280;
}
.tag-3p {
  color: var(--primary);
  border-color: var(--primary);
}
.tag-muted {
  color: var(--muted);
  border-color: var(--border);
}
.tag-trust {
  color: var(--muted);
  border-color: var(--border);
  font-weight: 500;
  opacity: 0.85;
}
.tag-trust-low {
  color: var(--warn, #d98324);
  border-color: var(--warn, #d98324);
  font-weight: 500;
  opacity: 0.8;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.cat {
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 7px;
}
.sep {
  opacity: 0.5;
  margin: 0 2px;
}
.icon-btn {
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
.icon-btn:hover {
  color: var(--primary);
}
.reason {
  margin-top: 3px;
}
.meta {
  margin-top: 3px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.stats {
  margin-top: 3px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40vw;
}
.size {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  flex-shrink: 0;
  min-width: 78px;
  text-align: right;
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
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
  margin-top: 10px;
}
.warn {
  color: var(--warn, #d98324);
  font-size: calc(13px * var(--fs-scale));
  margin-top: 10px;
  line-height: 1.6;
}
.d-progress {
  height: 8px;
  background: var(--border);
  border-radius: 99px;
  overflow: hidden;
  margin-top: 12px;
}
.d-bar {
  height: 100%;
  background: var(--primary);
  border-radius: 99px;
  transition: width 0.2s ease;
}
.d-bar.indet {
  width: 38%;
  animation: d-indet 1.1s infinite ease-in-out;
}
@keyframes d-indet {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(320%); }
}
.last-scan {
  white-space: nowrap;
}
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
</style>
