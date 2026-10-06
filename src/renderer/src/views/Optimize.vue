<script setup lang="ts">
import { Wrench, Gauge, SearchX } from "@lucide/vue";
import { ref, onMounted, computed, watch } from "vue";
import {
  optStatus,
  optSetTrim,
  optDefrag,
  optOpenStorageSense,
  optRunStorageSense,
  optSetCompactOs,
  optServices,
  optSetServiceDelayed,
  optVhd,
  pfInfo,
  pfTargets as listPfTargets,
  pfApply,
  listDisks,
  listPhysicalDisks,
  formatSize,
  getLocal,
  setLocal,
  type OptimizeOption,
  type OptimizeResult,
  type DelayableService,
  type VhdInfo,
  type PagefileInfo,
  type PagefileTarget,
  type PhysicalDiskInfo,
} from "../api/electron";
import Select from "../components/Select.vue";
import EmptyState from "../components/EmptyState.vue";

type TabKey = "disk" | "pagefile" | "boot" | "vhd";
const tab = ref<TabKey>("disk");
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "disk", label: "磁盘优化" },
  { key: "pagefile", label: "虚拟内存" },
  { key: "boot", label: "启动加速" },
  { key: "vhd", label: "WSL / Docker" },
];

// ---------------- 磁盘优化 ----------------
// 磁盘优化检测的对象是「物理磁盘」（SSD/HDD、Trim、健康等均是磁盘级属性），
// 不是某个盘符。目标选择因此改为物理磁盘；引擎侧仍按卷操作，这里把所选磁盘
// 映射为它的代表卷（优先系统卷，其次第一个卷）来调用。
const DISK_KEY = "grclean.optimize.disk";
/** 磁盘列表缓存：读取过一次就持久化，下次进入直接显示下拉（后台再刷新）。 */
const DISKS_CACHE_KEY = "grclean.optimize.disks";
const physicals = ref<PhysicalDiskInfo[]>([]);
/** 选中的物理磁盘 deviceId：优先读上次记忆，其次系统盘所在磁盘，最后第一个磁盘。 */
const deviceId = ref<number>(Number(getLocal(DISK_KEY) || "") || -1);
const options = ref<OptimizeOption[]>([]);
const loading = ref(false);
/** 本轮是否已点过「检测」（区分「暂未检测」与「未发现对应记录」两种空态） */
const diskAnalyzed = ref(false);
const busy = ref("");
const error = ref("");
const result = ref<{ ok: boolean; text: string } | null>(null);

/** 盘符 → 是否系统盘（用于把代表卷优先定位到系统盘）。 */
const disksWithSystem = ref<Array<{ letter: string; system: boolean }>>([]);

// 进入即从缓存恢复磁盘列表（读取过的磁盘直接显示到下拉，无需等待重新读取）
try {
  const c = JSON.parse(getLocal(DISKS_CACHE_KEY) || "null") as {
    physicals: PhysicalDiskInfo[];
    volumes: Array<{ letter: string; system: boolean }>;
  } | null;
  if (c?.physicals?.length) {
    physicals.value = c.physicals;
    disksWithSystem.value = c.volumes || [];
  }
} catch {
  /* 缓存损坏则忽略，走正常读取 */
}

/** 当前选中的物理磁盘。 */
const activePhysical = computed(
  () => physicals.value.find((p) => p.deviceId === deviceId.value) ?? null,
);

/**
 * 所选物理磁盘的代表卷盘符：若该磁盘含系统卷则用系统卷，否则用它的第一个盘符。
 * 引擎的 optStatus / optDefrag 按卷（盘符）工作，故用此映射。
 */
const targetLetter = computed(() => {
  const p = activePhysical.value;
  if (!p) return "";
  const letters = p.letters || [];
  if (!letters.length) return "";
  // 优先系统卷
  const sysVolume = disksWithSystem.value.find(
    (d) => d.system && letters.includes(d.letter),
  );
  return sysVolume ? sysVolume.letter : letters[0];
});

/** 磁盘下拉选项：系统盘所在磁盘最上并标注，其余按 deviceId 序。 */
const diskOptions = computed(() => {
  const sysDisk = disksWithSystem.value.find((d) => d.system);
  const sysLetter = sysDisk?.letter ?? "";
  const ordered = [...physicals.value].sort((a, b) => {
    const aSys = (a.letters || []).includes(sysLetter) ? 0 : 1;
    const bSys = (b.letters || []).includes(sysLetter) ? 0 : 1;
    if (aSys !== bSys) return aSys - bSys;
    return a.deviceId - b.deviceId;
  });
  return ordered.map((p) => {
    const isSys = (p.letters || []).includes(sysLetter);
    const letters = (p.letters || []).map((l) => `${l}:`).join(" ") || "无挂载卷";
    return {
      value: String(p.deviceId),
      label: `磁盘 ${p.deviceId} · ${p.model || "未知型号"}（${p.type}/${p.busType} · ${letters}${isSys ? " · 系统盘" : ""}）`,
    };
  });
});

const STATUS_META: Record<string, { label: string; color: string }> = {
  good: { label: "已优化", color: "var(--success)" },
  warn: { label: "可改进", color: "#d98324" },
  bad: { label: "异常", color: "var(--danger)" },
  unknown: { label: "未知", color: "var(--muted)" },
};

async function loadDisks() {
  try {
    const [phys, vols] = await Promise.all([listPhysicalDisks(), listDisks()]);
    physicals.value = phys;
    disksWithSystem.value = (vols || []).map((d) => ({ letter: d.letter, system: d.system }));
    // 持久化磁盘列表：下次进入下拉直接显示，无需等待读取
    setLocal(
      DISKS_CACHE_KEY,
      JSON.stringify({ physicals: physicals.value, volumes: disksWithSystem.value }),
    );
    if (physicals.value.length) {
      // 记忆的 deviceId 仍有效则沿用；否则优先系统盘所在磁盘，再否则第一个磁盘
      const remembered = deviceId.value;
      const valid = physicals.value.some((p) => p.deviceId === remembered);
      if (valid) {
        deviceId.value = remembered;
      } else {
        const sysLetter = disksWithSystem.value.find((d) => d.system)?.letter;
        const sysDisk = physicals.value.find((p) => (p.letters || []).includes(sysLetter ?? "?"));
        deviceId.value = (sysDisk ?? physicals.value[0]).deviceId;
      }
    }
  } catch {
    // 读取失败时保留缓存恢复出的列表（若有），避免下拉瞬间清空
    if (!physicals.value.length) physicals.value = [];
  }
}

// 目标磁盘选择持久化记忆（下次进入沿用上次所选）
watch(deviceId, (v) => setLocal(DISK_KEY, String(v)));

/** 下拉切换物理磁盘：清空旧检测结果，需手动点「检测」（不自动分析）。 */
function onDiskChange(v: string) {
  deviceId.value = Number(v);
  options.value = [];
  result.value = null;
  diskAnalyzed.value = false;
}

async function loadOptions() {
  loading.value = true;
  error.value = "";
  try {
    options.value = targetLetter.value ? await optStatus(targetLetter.value) : [];
    diskAnalyzed.value = true;
  } catch (e: any) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function run(key: string, fn: () => Promise<OptimizeResult>) {
  busy.value = key;
  result.value = null;
  error.value = "";
  try {
    const r = await fn();
    result.value = { ok: r.ok, text: r.message };
    if (r.ok) await loadOptions();
  } catch (e: any) {
    result.value = { ok: false, text: String(e) };
  } finally {
    busy.value = "";
  }
}

// ---------------- 虚拟内存 ----------------
const pf = ref<PagefileInfo | null>(null);
const pfLoading = ref(false);
const pfTargets = ref<PagefileTarget[]>([]);
const pfMode = ref<"auto" | "custom" | "move">("auto");
const pfLetter = ref("");
const pfInitial = ref(0);
const pfMax = ref(0);

const PF_MODE_OPTIONS = [
  { value: "auto", label: "系统托管（自动）" },
  { value: "custom", label: "自定义大小" },
  { value: "move", label: "迁移到其他盘" },
];

const pfLetterOptions = computed(() =>
  pfTargets.value.map((t) => ({
    value: t.letter,
    label: `${t.letter}:（剩余 ${formatSize(t.freeBytes)}）`,
  })),
);

const pfCurrentText = computed(() => {
  const p = pf.value;
  if (!p) return "读取中…";
  if (p.autoManaged) return "系统托管";
  if (!p.files.length) return "未启用页面文件";
  return p.files
    .map(
      (f) =>
        `${f.drive}: ${f.initialMb === 0 ? "系统托管" : `${f.initialMb}–${f.maxMb} MB`}`,
    )
    .join("，");
});

async function loadPagefile() {
  pfLoading.value = true;
  try {
    pf.value = await pfInfo();
    pfTargets.value = await listPfTargets();
    if (!pfLetter.value && pfTargets.value.length) {
      pfLetter.value = pfTargets.value[0].letter;
    }
    if (!pfInitial.value && pf.value) {
      pfInitial.value = pf.value.suggestInitialMb;
      pfMax.value = pf.value.suggestMaxMb;
    }
  } catch (e: any) {
    error.value = String(e);
  } finally {
    pfLoading.value = false;
  }
}

async function applyPagefile() {
  await run("pf", () =>
    pfApply(pfMode.value, pfLetter.value, pfInitial.value, pfMax.value),
  );
}

// ---------------- 启动加速 ----------------
const services = ref<DelayableService[]>([]);
const svcLoading = ref(false);
const svcLoaded = ref(false);
const svcThirdOnly = ref(true);

const visibleServices = computed(() =>
  svcThirdOnly.value ? services.value.filter((s) => s.thirdParty) : services.value,
);

async function loadServices() {
  svcLoading.value = true;
  try {
    services.value = await optServices();
  } catch (e: any) {
    error.value = String(e);
  } finally {
    svcLoading.value = false;
    svcLoaded.value = true;
  }
}

async function toggleDelayed(s: DelayableService) {
  await run("svc:" + s.name, () => optSetServiceDelayed(s.name, !s.delayed));
  await loadServices();
}

// ---------------- WSL / Docker ----------------
const vhds = ref<VhdInfo[]>([]);
const vhdLoading = ref(false);
const vhdLoaded = ref(false);

async function loadVhd() {
  vhdLoading.value = true;
  try {
    vhds.value = await optVhd();
  } catch (e: any) {
    error.value = String(e);
  } finally {
    vhdLoading.value = false;
    vhdLoaded.value = true;
  }
}

onMounted(async () => {
  // 只读取磁盘列表（有缓存则下拉即时显示）；优化项不自动分析，等用户点「检测」
  await loadDisks();
});

async function switchTab(k: TabKey) {
  tab.value = k;
  result.value = null;
  // 各子页均不自动运行：进入后需用户点击「读取」按钮才采集，避免无谓等待与卡顿。
}
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon">
      <Wrench :size="22" class="title-icon" />
      磁盘优化
    </h1>
    <p class="muted">
      SSD Trim、碎片整理、存储感知与系统文件压缩的检测与一键优化；并提供虚拟内存、
      启动加速与 WSL / Docker 占用分析。所有变更均需你显式点击，不会自动修改系统设置。
    </p>

    <div class="tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="tab"
        :class="{ active: tab === t.key }"
        @click="switchTab(t.key)"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 磁盘优化 -->
    <div v-if="tab === 'disk'" class="card fill-card">
      <div class="toolbar">
        <span class="muted">目标磁盘</span>
        <Select
          :model-value="String(deviceId)"
          :options="diskOptions"
          :width="320"
          @update:model-value="onDiskChange"
        />
        <span v-if="targetLetter" class="muted small">优化卷 {{ targetLetter }}:</span>
        <button class="btn btn-primary" :disabled="loading" @click="loadOptions">
          <span v-if="loading" class="spinner"></span>
          {{ loading ? "检测中…" : diskAnalyzed ? "重新检测" : "检测" }}
        </button>
      </div>

      <div v-if="error" class="err">{{ error }}</div>

      <div v-if="result" class="res" :class="{ ok: result.ok }">
        {{ result.text }}
      </div>

      <EmptyState
        v-if="loading && !options.length"
        loading
        :icon="Gauge"
        title="检测中……"
      />
      <EmptyState
        v-else-if="!options.length && !diskAnalyzed"
        :icon="Gauge"
        title="暂未检测"
        desc="选择目标磁盘后点击「检测」，查看 SSD Trim、碎片整理、存储感知等可优化项。"
      />
      <EmptyState
        v-else-if="!options.length"
        :icon="SearchX"
        title="未发现对应记录"
        desc="当前磁盘没有检测到可优化项。"
      />

      <div v-else class="opt-grid">
        <div v-for="o in options" :key="o.id" class="opt-card">
          <div class="opt-head">
            <span class="opt-title">{{ o.title }}</span>
            <span
              class="tag"
              :style="{
                color: STATUS_META[o.status].color,
                borderColor: STATUS_META[o.status].color,
              }"
            >
              {{ STATUS_META[o.status].label }}
            </span>
          </div>
          <div class="muted small opt-desc">{{ o.desc }}</div>
          <div class="opt-value">{{ o.value }}</div>
          <div v-if="o.advice" class="opt-advice">{{ o.advice }}</div>
          <div class="opt-actions">
            <template v-if="o.id === 'trim'">
              <button
                class="btn btn-primary"
                :disabled="busy === 'trim-on'"
                @click="run('trim-on', () => optSetTrim(true))"
              >
                开启 Trim
              </button>
              <button
                class="btn"
                :disabled="busy === 'trim-off'"
                @click="run('trim-off', () => optSetTrim(false))"
              >
                关闭
              </button>
            </template>
            <template v-else-if="o.id === 'defrag'">
              <button
                class="btn"
                :disabled="busy === 'defrag-a'"
                @click="run('defrag-a', () => optDefrag(targetLetter, true))"
              >
                分析
              </button>
              <button
                class="btn btn-primary"
                :disabled="busy === 'defrag-r'"
                @click="run('defrag-r', () => optDefrag(targetLetter, false))"
              >
                整理
              </button>
            </template>
            <template v-else-if="o.id === 'storagesense'">
              <button class="btn" :disabled="busy === 'ss-open'" @click="run('ss-open', optOpenStorageSense)">
                打开系统设置
              </button>
              <button
                class="btn btn-primary"
                :disabled="busy === 'ss-run'"
                @click="run('ss-run', optRunStorageSense)"
              >
                立即运行一次
              </button>
            </template>
            <template v-else-if="o.id === 'compactos'">
              <button
                class="btn btn-primary"
                :disabled="busy === 'co-on'"
                @click="run('co-on', () => optSetCompactOs(true))"
              >
                开启压缩
              </button>
              <button
                class="btn"
                :disabled="busy === 'co-off'"
                @click="run('co-off', () => optSetCompactOs(false))"
              >
                关闭压缩
              </button>
            </template>
          </div>
          <div v-if="o.needAdmin" class="opt-admin">部分操作需要管理员权限</div>
        </div>
      </div>
    </div>

    <!-- 虚拟内存 -->
    <div v-else-if="tab === 'pagefile'" class="card fill-card">
      <div class="toolbar">
        <button class="btn" :disabled="pfLoading" @click="loadPagefile">
          <span v-if="pfLoading" class="spinner"></span>
          {{ pfLoading ? "读取中…" : pf ? "重新读取" : "读取虚拟内存" }}
        </button>
        <span class="muted">物理内存 {{ pf ? (pf.ramMb / 1024).toFixed(1) : "?" }} GB</span>
      </div>
      <div v-if="pfLoading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="result" class="res" :class="{ ok: result.ok }">{{ result.text }}</div>

      <div v-if="pf" class="pf-block">
        <div class="pf-row">
          <span class="pf-label">当前模式</span>
          <span class="pf-val">{{ pfCurrentText }}</span>
        </div>
        <div class="pf-row">
          <span class="pf-label">建议</span>
          <span class="pf-val">
            初始 {{ pf.suggestInitialMb }} MB / 最大 {{ pf.suggestMaxMb }} MB
          </span>
        </div>
        <div class="muted small pf-reason">{{ pf.suggestReason }}</div>

        <table v-if="pf.files.length" class="pf-table">
          <thead>
            <tr>
              <th>盘符</th>
              <th>初始 (MB)</th>
              <th>最大 (MB)</th>
              <th>实际占用 (MB)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(f, i) in pf.files" :key="i">
              <td>{{ f.drive }}:</td>
              <td>{{ f.initialMb === 0 ? "系统托管" : f.initialMb }}</td>
              <td>{{ f.maxMb === 0 ? "系统托管" : f.maxMb }}</td>
              <td>{{ f.usedMb }}</td>
            </tr>
          </tbody>
        </table>

        <div class="pf-form">
          <label class="pf-field">
            模式
            <Select v-model="pfMode" :options="PF_MODE_OPTIONS" :width="200" />
          </label>
          <label v-if="pfMode !== 'auto'" class="pf-field">
            目标盘
            <Select v-model="pfLetter" :options="pfLetterOptions" :width="190" />
          </label>
          <template v-if="pfMode === 'custom'">
            <label class="pf-field">
              初始 (MB)
              <input v-model.number="pfInitial" type="number" class="inp" min="16" />
            </label>
            <label class="pf-field">
              最大 (MB)
              <input v-model.number="pfMax" type="number" class="inp" min="16" />
            </label>
          </template>
          <button
            class="btn btn-primary"
            :disabled="busy === 'pf'"
            @click="applyPagefile"
          >
            {{ busy === "pf" ? "应用中…" : "应用（重启后生效）" }}
          </button>
        </div>
        <div class="warn-line">
          修改页面文件会影响系统内存管理，建议按建议值设置；变更后需重启电脑生效。
        </div>
      </div>
      <EmptyState
        v-else-if="pfLoading"
        loading
        :icon="Gauge"
        title="读取中……"
      />
      <EmptyState
        v-else
        :icon="Gauge"
        title="暂未读取"
        desc="点击上方「读取虚拟内存」获取页面文件信息。"
      />
    </div>

    <!-- 启动加速 -->
    <div v-else-if="tab === 'boot'" class="card fill-card">
      <div class="toolbar">
        <button class="btn" :disabled="svcLoading" @click="loadServices">
          <span v-if="svcLoading" class="spinner"></span>
          {{ svcLoading ? "读取中…" : services.length ? "重新读取" : "读取服务列表" }}
        </button>
        <label class="chk">
          <input v-model="svcThirdOnly" type="checkbox" />
          只看第三方服务
        </label>
        <span class="muted">共 {{ visibleServices.length }} 项</span>
      </div>
      <div v-if="svcLoading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div v-if="error" class="err">{{ error }}</div>
      <div v-if="result" class="res" :class="{ ok: result.ok }">{{ result.text }}</div>

      <EmptyState
        v-if="svcLoading"
        loading
        :icon="Gauge"
        title="读取中……"
      />
      <EmptyState
        v-else-if="!svcLoaded"
        :icon="Gauge"
        title="暂未读取"
        desc="点击上方「读取服务列表」加载可延迟启动的服务。"
      />
      <EmptyState
        v-else-if="!visibleServices.length"
        :icon="SearchX"
        title="未发现对应记录"
        desc="没有可调整的服务。"
      />
      <div v-else class="fill-list svc-list">
        <div v-for="s in visibleServices" :key="s.name" class="svc-row">
          <div class="svc-main">
            <span class="svc-name">{{ s.displayName || s.name }}</span>
            <span class="muted small">{{ s.name }}</span>
          </div>
          <span class="spacer" />
          <span class="svc-tag" :class="{ on: s.delayed }">
            {{ s.delayed ? "已延迟" : "开机立即启动" }}
          </span>
          <button
            class="btn"
            :disabled="busy === 'svc:' + s.name"
            @click="toggleDelayed(s)"
          >
            {{ s.delayed ? "取消延迟" : "设为延迟" }}
          </button>
        </div>
      </div>
      <div class="warn-line">
        延迟启动只影响开机瞬间的加载顺序，不影响功能；系统关键服务已被排除，不会出现在列表中。
      </div>
    </div>

    <!-- WSL / Docker -->
    <div v-else class="card fill-card">
      <div class="toolbar">
        <button class="btn" :disabled="vhdLoading" @click="loadVhd">
          <span v-if="vhdLoading" class="spinner"></span>
          {{ vhdLoading ? "检测中…" : vhds.length ? "重新检测" : "检测 WSL / Docker" }}
        </button>
      </div>
      <div v-if="vhdLoading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>
      <div v-if="error" class="err">{{ error }}</div>
      <EmptyState
        v-if="vhdLoading"
        loading
        :icon="Gauge"
        title="检测中……"
      />
      <EmptyState
        v-else-if="!vhdLoaded"
        :icon="Gauge"
        title="暂未检测"
        desc="点击上方「检测 WSL / Docker」分析其占用空间。"
      />
      <div v-else class="vhd-grid">
        <div v-for="v in vhds" :key="v.id" class="vhd-card">
          <div class="opt-head">
            <span class="opt-title">{{ v.title }}</span>
            <span class="tag" :style="{ color: v.exists ? 'var(--success)' : 'var(--muted)', borderColor: v.exists ? 'var(--success)' : 'var(--border)' }">
              {{ v.exists ? "已检测到" : "未安装" }}
            </span>
          </div>
          <div class="opt-value" v-if="v.exists">
            占用 {{ formatSize(v.bytes) }}
          </div>
          <div class="muted small loc">{{ v.location }}</div>
          <div class="opt-advice">{{ v.advice }}</div>
        </div>
      </div>
      <div class="warn-line">
        本模块只检测与给出迁移建议，不会自动搬动你的开发环境数据。
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
.pad {
  padding: 12px 0;
}
.tabs {
  display: flex;
  gap: 6px;
  margin: 12px 0 10px;
  flex-wrap: wrap;
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
.inp {
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: calc(13px * var(--fs-scale));
}
.inp {
  width: 110px;
}
.opt-grid {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.opt-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg);
  display: flex;
  flex-direction: column;
}
.opt-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.opt-title {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
}
.tag {
  font-size: calc(11px * var(--fs-scale));
  font-weight: 700;
  border: 1px solid;
  border-radius: 10px;
  padding: 1px 8px;
}
.opt-desc {
  margin-top: 6px;
  line-height: 1.5;
}
.opt-value {
  margin-top: 8px;
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  color: var(--text);
}
.opt-advice {
  margin-top: 6px;
  font-size: calc(12px * var(--fs-scale));
  color: #b9701a;
  line-height: 1.5;
}
.opt-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.opt-admin {
  margin-top: 8px;
  font-size: calc(11px * var(--fs-scale));
  color: var(--muted);
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
.pf-block {
  margin-top: 14px;
}
.pf-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 4px 0;
}
.pf-label {
  width: 80px;
  color: var(--muted);
  font-size: calc(13px * var(--fs-scale));
}
.pf-val {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  color: var(--text);
}
.pf-reason {
  margin: 6px 0 10px;
  line-height: 1.6;
}
.pf-table {
  width: 100%;
  border-collapse: collapse;
  font-size: calc(13px * var(--fs-scale));
  margin-bottom: 12px;
}
.pf-table th,
.pf-table td {
  border-bottom: 1px solid var(--border);
  padding: 7px 8px;
  text-align: left;
}
.pf-table th {
  color: var(--muted);
  font-weight: 600;
}
.pf-form {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.pf-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
}
.warn-line {
  margin-top: 12px;
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
  line-height: 1.6;
  border-left: 3px solid var(--primary);
  padding-left: 10px;
}
.svc-list {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.svc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
}
.svc-row:last-child {
  border-bottom: none;
}
.svc-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.svc-name {
  font-size: calc(13px * var(--fs-scale));
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.svc-tag {
  font-size: calc(11px * var(--fs-scale));
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  color: var(--muted);
}
.svc-tag.on {
  color: var(--success);
  border-color: var(--success);
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(13px * var(--fs-scale));
  color: var(--text);
}
.vhd-grid {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.vhd-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg);
}
.loc {
  margin-top: 4px;
  word-break: break-all;
}
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
</style>
