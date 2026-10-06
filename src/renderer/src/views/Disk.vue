<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { HardDrive, SearchX } from "@lucide/vue";
import {
  listDisks,
  listPhysicalDisks,
  smartOverview,
  formatSize,
  type DiskInfo,
  type PhysicalDiskInfo,
  type SmartRow,
} from "../api/electron";
import { loadScan, recordScan, scanHistory } from "../stores/history";
import LastScan from "../components/LastScan.vue";
import EmptyState from "../components/EmptyState.vue";

const disks = ref<DiskInfo[]>([]);
const physical = ref<PhysicalDiskInfo[]>([]);
const loading = ref(false);
const error = ref("");
const activeId = ref<number | null>(null);
const smart = ref<SmartRow[]>([]);
const smartLoading = ref(false);

/** 健康标签配色（对齐 §3.16 的健康评估输出）。 */
const HEALTHY_COLOR: Record<string, string> = {
  健康: "var(--success)",
  关注: "#d98324",
  警告: "#e08a2b",
  危险: "var(--danger)",
};

const activePhysical = computed(
  () => physical.value.find((p) => p.deviceId === activeId.value) || null,
);

/** 当前选中物理磁盘上的盘符（卷）列表，用于容量卡片。 */
const activeDisks = computed(() => {
  const p = activePhysical.value;
  if (!p) return [];
  const set = new Set(p.letters.map((l) => l.toUpperCase()));
  return sortDisks(disks.value.filter((d) => set.has(d.letter.toUpperCase())));
});

/** 系统盘优先，其余按盘符字母升序排序。 */
function sortDisks(list: DiskInfo[]): DiskInfo[] {
  return [...list].sort((a, b) => {
    if (a.system !== b.system) return a.system ? -1 : 1;
    return a.letter.toUpperCase() < b.letter.toUpperCase() ? -1 : 1;
  });
}

/** 兜底盘符视图（无物理分组时）按同样规则排序。 */
const sortedDisks = computed(() => sortDisks(disks.value));

/** 盘符 → 卷标名称（供物理磁盘详情里的盘符 chip 显示名称）。 */
const nameByLetter = computed(() => {
  const m: Record<string, string> = {};
  for (const d of disks.value) m[d.letter.toUpperCase()] = d.name || "";
  return m;
});

function usedPercent(d: DiskInfo): number {
  if (!d.totalBytes) return 0;
  return Math.min(100, ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100);
}

function barColor(pct: number): string {
  if (pct >= 90) return "var(--danger)";
  if (pct >= 75) return "#e6c200";
  return "var(--success)";
}

/** 按健康状态给出处理建议（§9.6 底部提示条），仅针对当前显示的盘符。 */
const advice = computed(() => {
  const out: string[] = [];
  for (const d of activeDisks.value) {
    const pct = usedPercent(d);
    if (pct >= 90) {
      out.push(
        `${d.letter}: 已用 ${pct.toFixed(0)}%，空间严重不足，建议立即清理垃圾/大文件或迁移数据。`,
      );
    } else if (pct >= 75) {
      out.push(`${d.letter}: 已用 ${pct.toFixed(0)}%，建议关注并适当释放空间。`);
    }
    if (d.smartOk === false) {
      out.push(`${d.letter}: SMART 报告异常，建议立即备份重要数据并检查磁盘。`);
    }
    if (d.type === "SSD" && d.trimEnabled === false) {
      out.push(`${d.letter}: SSD 未开启 Trim，长期使用会影响写入性能与寿命。`);
    }
    if (d.type === "HDD" && pct >= 75) {
      out.push(`${d.letter}: HDD 建议执行碎片整理（defrag）。`);
    }
  }
  return out;
});

const smartNeedsAdmin = computed(() =>
  smart.value.some((r) => r.value === "需管理员权限"),
);
const smartUnsupported = computed(() =>
  smart.value.some((r) => r.value === "不支持"),
);

/** 是否有过读取历史（决定按钮是「读取磁盘信息」还是「重新获取」）。 */
const hasHistory = computed(
  () => Boolean(scanHistory.disk) || physical.value.length > 0,
);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [list, phys] = await Promise.all([listDisks(), listPhysicalDisks()]);
    disks.value = list;
    physical.value = phys;
    if (activeId.value === null && phys.length) {
      const sys = phys.find((p) => p.isSystem) || phys[0];
      activeId.value = sys.deviceId;
    } else if (phys.length && !phys.some((p) => p.deviceId === activeId.value)) {
      activeId.value = phys[0].deviceId;
    }
    if (phys.length) {
      const sys2 = phys.find((p) => p.isSystem) || phys[0];
      const letters = sys2.letters.join("/") || "?";
      void recordScan(
        "disk",
        `${phys.length} 块硬盘 · ${letters}: 剩余 ${formatSize(sys2.freeBytes)}`,
      );
    }
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function loadSmart(id: number) {
  if (id === null) return;
  smartLoading.value = true;
  smart.value = [];
  try {
    smart.value = await smartOverview(id);
  } catch (e: any) {
    error.value = String(e);
  } finally {
    smartLoading.value = false;
  }
}

onMounted(() => {
  // 仅拉取「上次获取」记录用于展示；磁盘数据等待用户点击按钮后才读取
  void loadScan("disk");
});

watch(activeId, (v) => {
  if (v !== null) void loadSmart(v);
});

function rowColor(ok: boolean | null): string {
  if (ok === true) return "var(--success)";
  if (ok === false) return "var(--danger)";
  return "var(--muted)";
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <HardDrive :size="22" class="title-icon" />
      磁盘信息分析
    </h1>
    <p class="muted">
      按物理硬盘维度展示本机所有磁盘（含其盘符与 SMART 关键项），异常盘给出处理建议，
      并直接计入健康度评分的「磁盘健康」因素。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="load">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "读取中…" : hasHistory ? "重新获取" : "读取磁盘信息" }}
        </button>
        <span class="muted" v-if="physical.length">
          共 {{ physical.length }} 块硬盘
        </span>
        <span class="muted" v-else-if="disks.length">
          共 {{ disks.length }} 个盘符
        </span>
        <LastScan module="disk" />
      </div>

      <div v-if="error" class="err">{{ error }}</div>

      <!-- 物理磁盘选择器（硬盘本体，先于盘符展示） -->
      <div v-if="physical.length" class="pd-tabs">
        <button
          v-for="p in physical"
          :key="p.deviceId"
          class="pd-tab"
          :class="{ active: p.deviceId === activeId }"
          @click="activeId = p.deviceId"
        >
          <span class="pd-idx">磁盘 {{ p.deviceId }}</span>
          <span class="pd-model">{{ p.model || "未知型号" }}</span>
          <span class="pd-meta">{{ p.type }} · {{ p.busType }}</span>
          <span
            class="healthy-tag"
            :style="{
              color: HEALTHY_COLOR[p.healthy] || 'var(--muted)',
              borderColor: HEALTHY_COLOR[p.healthy] || 'var(--border)',
            }"
          >
            {{ p.healthy }}
          </span>
        </button>
      </div>

      <!-- 下方内容区：超出框时可上下滚动，扫描按钮与硬盘选择器保持固定 -->
      <div class="fill-list">
      <!-- 选中物理磁盘详情：盘符 + SMART -->
      <template v-if="activePhysical">
        <div class="pd-detail">
          <div class="pd-detail-head">
            <div>
              <div class="pd-detail-title">{{ activePhysical.model }}</div>
              <div class="muted small">
                {{ activePhysical.type }} · {{ activePhysical.busType }} ·
                序列号 {{ activePhysical.serial || "未知" }} · 固件
                {{ activePhysical.firmware || "未知" }}
              </div>
            </div>
            <span class="spacer" />
            <div class="muted small right">
              总容量 {{ formatSize(activePhysical.sizeBytes) }} · 可用
              {{ formatSize(activePhysical.freeBytes) }}
            </div>
          </div>
          <div class="pd-letters">
            <span class="muted small">盘符：</span>
            <span
              v-for="l in activePhysical.letters"
              :key="l"
              class="letter-chip"
              >{{ l }}:{{ nameByLetter[l.toUpperCase()] }}</span
            >
            <span v-if="!activePhysical.letters.length" class="muted small"
              >无挂载卷</span
            >
          </div>
        </div>

        <!-- 该磁盘上的盘符容量卡片 -->
        <div v-if="activeDisks.length" class="grid">
          <div
            v-for="d in activeDisks"
            :key="d.letter"
            class="disk-card"
          >
            <div class="disk-head">
              <span class="disk-letter">{{ d.letter }}:{{ d.name }}</span>
              <span class="muted small" v-if="!d.name">{{ d.model || "未知型号" }}</span>
            </div>
            <div class="muted small disk-sub">
              {{ formatSize(d.totalBytes) }} ·
              {{ d.fileSystem || "未知文件系统" }} ·
              {{ d.aligned === null ? "对齐未知" : d.aligned ? "已对齐" : "未对齐" }}
            </div>
            <div class="bar">
              <div
                class="bar-fill"
                :style="{
                  width: usedPercent(d) + '%',
                  background: barColor(usedPercent(d)),
                }"
              />
            </div>
            <div class="disk-used-row">
              <span class="muted small">
                已用 {{ formatSize(d.totalBytes - d.freeBytes) }} / 剩余
                {{ formatSize(d.freeBytes) }}
              </span>
              <span class="spacer" />
              <span class="muted small disk-pct">{{ usedPercent(d).toFixed(0) }}%</span>
            </div>
          </div>
        </div>
        <p v-else class="muted small pad">
          该硬盘当前没有可显示的卷。
        </p>

        <!-- SMART 概览（磁盘级，非盘符级） -->
        <div class="smart-block">
          <div class="smart-title">
            SMART 概览（磁盘 {{ activePhysical.deviceId }}：{{ activePhysical.model }}）
            <span v-if="smartLoading" class="muted small">读取中…</span>
          </div>
          <div class="smart-table">
            <div
              v-for="(r, i) in smart"
              :key="r.label + i"
              class="smart-row"
              :class="{ alt: i % 2 === 1 }"
            >
              <span class="smart-label">{{ r.label }}</span>
              <span class="spacer" />
              <span class="smart-value" :style="{ color: rowColor(r.ok) }">
                {{ r.value }}
              </span>
            </div>
            <div v-if="!smart.length && !smartLoading" class="muted small pad">
              该磁盘未提供 SMART 数据（部分硬盘或权限受限时不可用）。
            </div>
          </div>
          <div
            v-if="smartNeedsAdmin"
            class="muted small pad"
          >
            温度 / 剩余寿命 / 通电时长 / 重映射扇区需在
            <b>管理员权限</b>下运行 GrClean 才能读取（Windows 限制普通程序访问 SMART 数据）。
          </div>
          <div
            v-else-if="smartUnsupported"
            class="muted small pad"
          >
            部分 SMART 项当前设备或控制器未提供（如 NVMe/RAID/USB 磁盘），
            其余可读项已正常显示。
          </div>
        </div>
      </template>

      <!-- 异常建议 -->
      <div v-if="advice.length" class="advice">
        <div v-for="(a, i) in advice" :key="i" class="advice-row">
          <span class="advice-dot" />
          <span>{{ a }}</span>
        </div>
      </div>

      <!-- 兜底：无法获取物理磁盘分组时，回退为旧盘符视图 -->
      <template v-if="!physical.length && disks.length">
        <p class="muted small pad">
          未能获取物理磁盘分组信息，仅显示盘符视图；SMART 概览暂不可用。
        </p>
        <div class="grid">
          <div v-for="d in sortedDisks" :key="d.letter" class="disk-card">
            <div class="disk-head">
              <span class="disk-letter">{{ d.letter }}:{{ d.name }}</span>
              <span class="muted small" v-if="!d.name">{{ d.model || "未知型号" }}</span>
            </div>
            <div class="muted small disk-sub">
              {{ d.type }} · {{ d.fileSystem || "未知文件系统" }} ·
              {{ d.aligned === null ? "对齐未知" : d.aligned ? "已对齐" : "未对齐" }}
            </div>
            <div class="bar">
              <div
                class="bar-fill"
                :style="{
                  width: usedPercent(d) + '%',
                  background: barColor(usedPercent(d)),
                }"
              />
            </div>
            <div class="disk-used-row">
              <span class="muted small">
                已用 {{ formatSize(d.totalBytes - d.freeBytes) }} / 剩余
                {{ formatSize(d.freeBytes) }}
              </span>
              <span class="spacer" />
              <span class="muted small disk-pct">{{ usedPercent(d).toFixed(0) }}%</span>
            </div>
          </div>
        </div>
      </template>

      <EmptyState
        v-if="!disks.length && !physical.length && loading"
        loading
        :icon="HardDrive"
        title="读取中……"
      />
      <EmptyState
        v-else-if="!disks.length && !physical.length && !hasHistory"
        :icon="HardDrive"
        title="暂未扫描"
        desc="点击「读取磁盘信息」开始采集磁盘容量与 SMART 健康状态。"
      />
      <EmptyState
        v-else-if="!disks.length && !physical.length"
        :icon="SearchX"
        title="未发现对应记录"
        desc="未读取到磁盘信息，可能需要管理员权限或硬件不支持。"
      />
      </div>
    </div>
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
  flex-shrink: 0;
}
.spacer {
  flex: 1;
}
.small {
  font-size: calc(11px * var(--fs-scale));
}
.right {
  text-align: right;
}
/* 物理磁盘选择器 */
.pd-tabs {
  margin-top: 14px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.pd-tab {
  flex: 1 1 200px;
  min-width: 180px;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--bg);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pd-tab:hover {
  border-color: var(--primary);
}
.pd-tab.active {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-weak);
}
.pd-idx {
  font-size: calc(12px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
}
.pd-model {
  font-size: calc(12px * var(--fs-scale));
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pd-meta {
  font-size: calc(11px * var(--fs-scale));
  color: var(--muted);
}
.pd-tab .healthy-tag {
  align-self: flex-start;
  margin-top: 4px;
}
/* 选中磁盘详情 */
.pd-detail {
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--panel);
}
.pd-detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pd-detail-title {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
}
.pd-letters {
  margin-top: 8px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.letter-chip {
  font-size: calc(11px * var(--fs-scale));
  font-weight: 700;
  color: var(--primary);
  background: var(--primary-weak);
  border-radius: 6px;
  padding: 1px 8px;
}
.grid {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.disk-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.disk-card:hover {
  border-color: var(--primary);
}
.disk-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.disk-letter {
  font-size: calc(15px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
}
.disk-sub {
  margin: 4px 0 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar {
  height: 10px;
  border-radius: 5px;
  background: var(--border);
  overflow: hidden;
  margin-bottom: 6px;
}
.bar-fill {
  height: 100%;
  border-radius: 5px;
}
.disk-used-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.disk-pct {
  font-weight: 700;
  color: var(--text);
}
.healthy-tag {
  font-size: calc(11px * var(--fs-scale));
  font-weight: 700;
  border: 1px solid;
  border-radius: 10px;
  padding: 2px 10px;
}
.smart-block {
  margin-top: 18px;
}
.smart-title {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.smart-table {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.smart-row {
  display: flex;
  align-items: center;
  padding: 9px 14px;
  font-size: calc(13px * var(--fs-scale));
}
.smart-row.alt {
  background: var(--bg);
}
.smart-label {
  color: var(--text);
}
.smart-value {
  font-weight: 600;
}
.pad {
  padding: 12px 14px;
}
.advice {
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 14px;
  background: var(--bg);
}
.advice-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: calc(12px * var(--fs-scale));
  color: var(--text);
  padding: 3px 0;
}
.advice-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary);
  margin-top: 6px;
  flex-shrink: 0;
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
  margin-top: 10px;
}
</style>
