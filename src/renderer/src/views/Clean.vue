<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  scanJunk,
  cancelScan,
  clean,
  listExtraJunk,
  formatSize,
  type CleanCandidate,
  type ScanResult,
  type CleanResult,
  type ExtraJunkItem,
} from '../api/electron'
import { settings } from '../stores/settings'
import { recordScan } from '../stores/history'
import LastScan from '../components/LastScan.vue'
import Modal from '../components/Modal.vue'
import EmptyState from '../components/EmptyState.vue'
import { AlertTriangle, SearchX, Trash2 } from '@lucide/vue'

const candidates = ref<CleanCandidate[]>([])
const result = ref<ScanResult | null>(null)
const loading = ref(false)
const cancelled = ref(false)
const error = ref('')
const selected = ref<Set<string>>(new Set())
const cleaning = ref(false)
/** 清理过程中的实时计数（主进程每删完一批即推送） */
const cleanedCount = ref(0)
const showConfirm = ref(false)
/** 清理完成对话框（询问重新扫描 / 暂不） */
const showDone = ref(false)
const doneResult = ref<CleanResult | null>(null)

// ---- 增强清理项（可勾选、可展开收起） ----
const extraItems = ref<ExtraJunkItem[]>([])
const extraSelected = ref<Set<string>>(new Set())
const showExtra = ref(false)

const safeItems = computed(() => extraItems.value.filter((i) => i.level === 'safe'))
const cautionItems = computed(() =>
  extraItems.value.filter((i) => i.level === 'caution'),
)
const dangerItems = computed(() =>
  extraItems.value.filter((i) => i.level === 'danger'),
)
/** 本次勾选的不可逆项名称，用于二次确认时高亮警告 */
const selectedDangerNames = computed(() =>
  dangerItems.value
    .filter((i) => extraSelected.value.has(i.id))
    .map((i) => i.name),
)

function toggleExtra(id: string) {
  const s = new Set(extraSelected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  extraSelected.value = s
}

const selectedCount = computed(() => selected.value.size)
const selectedSize = computed(() =>
  candidates.value
    .filter((c) => selected.value.has(c.id))
    .reduce((s, c) => s + c.size, 0),
)

/**
 * 结果分组：直接基于候选列表自身分组，**不依赖 result**。
 *
 * 这是「结果列表/操作条与扫描进度同步」的关键：result 只在扫描**结束**时才赋值，
 * 若分组取自 result，流式扫出的候选要等扫描跑完才显示，而操作条按
 * candidates.length 提前出现——就会看到操作条先于结果列表冒出来。
 * 现在第一条候选到达即成组显示（count/size 由组内实时计算）。
 */
const grouped = computed(() => {
  // 单次遍历分组：避免对每个分类都 filter 一遍整表（O(cats×n) → O(n)）
  const byCat = new Map<
    string,
    { category: string; count: number; size: number; items: CleanCandidate[] }
  >()
  for (const c of candidates.value) {
    let g = byCat.get(c.category)
    if (!g) {
      g = { category: c.category, count: 0, size: 0, items: [] }
      byCat.set(c.category, g)
    }
    g.count += 1
    g.size += c.size
    g.items.push(c)
  }
  const list = Array.from(byCat.values())
  // 分类顺序：沿用上一轮（result）的分类次序，新出现的分类排在后面
  const order = result.value?.categories.map((c) => c.category) ?? []
  if (order.length > 1) {
    const rank = (cat: string) => {
      const i = order.indexOf(cat)
      return i < 0 ? Number.MAX_SAFE_INTEGER : i
    }
    list.sort((a, b) => rank(a.category) - rank(b.category))
  }
  return list
})
// 有结果的分类（count>0）才显示：分类导航条与结果列表都只展示有内容的分类。
const visibleCategories = computed(() => grouped.value)
const totalCount = computed(() => candidates.value.length)
const totalSize = computed(() =>
  candidates.value.reduce((s, c) => s + c.size, 0),
)

async function doScan() {
  loading.value = true
  cancelled.value = false
  error.value = ''
  candidates.value = []
  selected.value = new Set()
  // 重新扫描：分类计数先归 0，随扫描进度实时累加（扫描完成后再用权威结果覆盖）
  if (result.value) {
    result.value = {
      ...result.value,
      categories: result.value.categories.map((c) => ({
        ...c,
        count: 0,
        size: 0,
      })),
    }
  }
  try {
    // 通过回调「逐批」追加候选；新候选从列表上方插入（unshift），
    // 实现「从上方逐行增加」的流式观感；回调结束后用权威结果覆盖，
    // 保证与清理会话完全一致。
    // seen 用 Set 去重：避免每来一项都对整表 some() 扫描（O(n²) → O(n)）
    const seen = new Set<string>()
    const res = await scanJunk(Array.from(extraSelected.value), (item) => {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        candidates.value.unshift(item)
        // 分类计数随扫描实时累加；新分类自动追加到分类条
        const cats = result.value?.categories
        if (cats) {
          const cat = cats.find((x) => x.category === item.category)
          if (cat) {
            cat.count += 1
            cat.size += item.size
          } else {
            cats.push({ category: item.category, count: 1, size: item.size })
          }
        }
      }
    })
    result.value = res
    cancelled.value = res.cancelled
    candidates.value = res.candidates
    void recordScan('junk', `${totalCount.value} 项 · ${formatSize(totalSize.value)}`)
  } catch (e: any) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

function doCancel() {
  // 前端仅发取消信号，主进程在批次间轮询中断
  cancelScan()
}

function toggle(id: string) {
  const s = new Set(selected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selected.value = s
}

function toggleAll() {
  if (candidates.value.length === 0) return
  if (selectedCount.value === candidates.value.length) {
    selected.value = new Set()
  } else {
    selected.value = new Set(candidates.value.map((c) => c.id))
  }
}

/** 该分类下的全部候选是否已勾选（用于分组复选框状态） */
function isGroupSelected(category: string): boolean {
  const g = grouped.value.find((x) => x.category === category)
  return !!g && g.items.length > 0 && g.items.every((i) => selected.value.has(i.id))
}

/** 勾选/取消勾选某个分类下的所有候选（分组复选框） */
function toggleGroup(category: string) {
  const g = grouped.value.find((x) => x.category === category)
  const ids = g?.items.map((i) => i.id) ?? []
  if (!ids.length) return
  const s = new Set(selected.value)
  const allSelected = ids.every((id) => s.has(id))
  if (allSelected) ids.forEach((id) => s.delete(id))
  else ids.forEach((id) => s.add(id))
  selected.value = s
}

/** 单独删除某条回收站项（选中该项后走统一清理流程，二次确认） */
function deleteOne(id: string) {
  const s = new Set(selected.value)
  s.add(id)
  selected.value = s
  triggerClean()
}

// ---- 分类导航条（横向滚动：按住拖动 + 左右箭头 + 点击定位结果列表对应分类） ----
const stripRef = ref<HTMLElement | null>(null)
const activeCat = ref('')
const stripDown = ref(false)
const stripDragged = ref(false)
let stripStartX = 0
let stripStartLeft = 0
const groupEls: Record<string, HTMLElement> = {}
function setGroupRef(cat: string, el: unknown) {
  if (el) groupEls[cat] = el as HTMLElement
  else delete groupEls[cat]
}
/** 左右箭头滚动分类条 */
function scrollStrip(dir: number) {
  stripRef.value?.scrollBy({ left: dir * 220, behavior: 'smooth' })
}
/** 在分类条上按住拖动左右平移。
 *  ⚠️ 不能在 pointerdown 就 setPointerCapture：捕获会把随后的 click 重定向到
 *  分类条容器，chip 的 click 失效 → 点击分类无法定位结果列表；
 *  只有位移超过阈值真正进入拖动后才捕获。 */
function onStripDown(e: PointerEvent) {
  const el = stripRef.value
  if (!el) return
  stripDown.value = true
  stripDragged.value = false
  stripStartX = e.clientX
  stripStartLeft = el.scrollLeft
}
function onStripMove(e: PointerEvent) {
  if (!stripDown.value) return
  const el = stripRef.value
  if (!el) return
  const dx = e.clientX - stripStartX
  if (!stripDragged.value) {
    if (Math.abs(dx) <= 4) return
    stripDragged.value = true
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* 指针已释放，忽略 */
    }
  }
  el.scrollLeft = stripStartLeft - dx
}
function onStripUp(e: PointerEvent) {
  stripDown.value = false
  const el = stripRef.value
  if (el && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
}
/** 点击分类：拖动后不触发定位；否则高亮并滚动结果列表到对应分组 */
function onStripClick(cat: string, e: MouseEvent) {
  if (stripDragged.value) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  scrollToCategory(cat)
}
/** 点击分类：高亮并滚动结果列表到对应分组 */
function scrollToCategory(cat: string) {
  activeCat.value = cat
  const el = groupEls[cat]
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function triggerClean() {
  if (selectedCount.value === 0) return
  showConfirm.value = true
}

/** 清理进度合并：主进程逐项推送，前端按 ~100ms 时间窗批量处理。
 *  若每项都立即遍历+filter 整个列表（O(n²)）并触发一次渲染，删上千项会明显卡顿。 */
let pendingIds = new Set<string>()
let flushTimer: number | null = null

/** 立即应用累积的已删除 id：列表与分类计数同步更新，并累计「已删除 N 条」 */
function flushCleanProgress() {
  if (flushTimer != null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!pendingIds.size) return
  const idSet = pendingIds
  pendingIds = new Set<string>()
  const cats = result.value?.categories
  let n = 0
  for (const c of candidates.value) {
    if (idSet.has(c.id)) {
      n++
      const cat = cats?.find((x) => x.category === c.category)
      if (cat) {
        cat.count = Math.max(0, cat.count - 1)
        cat.size = Math.max(0, cat.size - c.size)
      }
    }
  }
  if (n > 0) {
    candidates.value = candidates.value.filter((c) => !idSet.has(c.id))
    const s = new Set(selected.value)
    for (const id of idSet) s.delete(id)
    selected.value = s
    cleanedCount.value += n
  }
}

function onCleanProgress(ev: { type: 'items'; ids: string[] }) {
  if (!ev.ids.length) return
  for (const id of ev.ids) pendingIds.add(id)
  if (flushTimer == null) flushTimer = window.setTimeout(flushCleanProgress, 100)
}

async function confirmClean() {
  showConfirm.value = false
  cleaning.value = true
  error.value = ''
  cleanedCount.value = 0
  try {
    const r = await clean(
      selected.value.size === candidates.value.length
        ? null
        : Array.from(selected.value),
      settings.allowPurge,
      onCleanProgress,
    )
    // 收尾：把仍在合并窗口内的已删除项立即应用（保证列表与计数最终一致）
    flushCleanProgress()
    // 已删项已从列表移除；这里清空剩余勾选并弹完成对话框
    selected.value = new Set()
    doneResult.value = r
    showDone.value = true
  } catch (e: any) {
    error.value = String(e)
  } finally {
    cleaning.value = false
  }
}

/** 完成对话框中选择「重新扫描」 */
function doneRescan() {
  showDone.value = false
  void doScan()
}

onMounted(async () => {
  try {
    extraItems.value = await listExtraJunk()
    // 默认勾选「建议清理」项；需确认 / 不可逆项一律不默认勾选
    extraSelected.value = new Set(
      extraItems.value.filter((i) => i.recommend).map((i) => i.id),
    )
  } catch {
    extraItems.value = []
  }
})
</script>

<template>
  <div class="scan-view">
    <h1 class="h-with-icon"><Trash2 :size="20" class="title-icon" />垃圾清理</h1>
    <p class="muted">
      所有删除默认移入回收站；受保护路径与系统目录会被自动拦截。
    </p>

    <div class="card fill-card" style="margin-top: 14px">
      <div class="toolbar">
        <button v-if="!loading" class="btn btn-primary" @click="doScan">
          扫描垃圾
        </button>
        <button v-else class="btn btn-warn" @click="doCancel">取消扫描</button>
        <span v-if="loading" class="muted">
          <span class="spinner"></span>
          扫描中… 已扫描 {{ totalCount }} 项
        </span>
        <span v-else-if="result" class="muted">
          共 {{ totalCount }} 项 · {{ formatSize(totalSize) }}
        </span>
        <span v-if="error" class="err">{{ error }}</span>
        <LastScan module="junk" />
        <button class="btn extra-btn" @click="showExtra = true">
          增强清理项
          <span class="extra-count">
            已选 {{ extraSelected.size }} / {{ extraItems.length }}
          </span>
        </button>
      </div>
      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <!-- 增强清理项改为弹窗勾选（入口在工具栏最右侧按钮） -->

      <!-- 分类导航条：单行横向滚动（按住拖动）+ 左右箭头，点击定位结果列表对应分类 -->
      <div v-if="visibleCategories.length" class="cat-strip-wrap">
        <button class="strip-arrow" type="button" aria-label="上一项" @click="scrollStrip(-1)">
          ‹
        </button>
        <div
          ref="stripRef"
          class="cat-strip"
          :class="{ grabbing: stripDown }"
          @pointerdown="onStripDown"
          @pointermove="onStripMove"
          @pointerup="onStripUp"
          @pointerleave="onStripUp"
        >
          <button
            v-for="c in visibleCategories"
            :key="c.category"
            type="button"
            class="cat-chip"
            :class="{ active: activeCat === c.category }"
            @click="onStripClick(c.category, $event)"
          >
            <b>{{ c.category }}</b>
            <span class="muted">{{ c.count }} 项 · {{ formatSize(c.size) }}</span>
          </button>
        </div>
        <button class="strip-arrow" type="button" aria-label="下一项" @click="scrollStrip(1)">
          ›
        </button>
      </div>

      <!-- 明细列表：按分类分组，每组一个标题（标题前为分组复选框），下挂该类结果。
           条件用 grouped.length（真正渲染出内容）而非 candidates.length，
           保证与底部操作条严格同步出现。 -->
      <div v-if="grouped.length" class="list fill-list">
        <div
          v-for="grp in grouped"
          :key="grp.category"
          class="cat-group"
          :ref="(el) => setGroupRef(grp.category, el)"
        >
          <div class="group-head">
            <label
              class="chk grp-chk"
              :class="{ disabled: grp.items.length === 0 }"
              title="勾选/取消该分类全部项"
            >
              <input
                type="checkbox"
                :checked="isGroupSelected(grp.category)"
                :disabled="grp.items.length === 0"
                @change="toggleGroup(grp.category)"
              />
            </label>
            <span class="group-name">{{ grp.category }}</span>
            <span class="muted">{{ grp.count }} 项 · {{ formatSize(grp.size) }}</span>
          </div>
          <!-- v-memo：勾选/清理时仅重渲染受影响的行，避免上千行整表 diff -->
          <div
            v-for="item in grp.items"
            :key="item.id"
            v-memo="[item, selected.has(item.id), cleaning]"
            class="row"
          >
            <label class="chk">
              <input
                type="checkbox"
                :checked="selected.has(item.id)"
                @change="toggle(item.id)"
              />
            </label>
            <span class="path" :title="item.path">{{ item.path }}</span>
            <span class="size muted">{{ formatSize(item.size) }}</span>
            <button
              class="row-del"
              :disabled="cleaning"
              title="删除该项"
              @click="deleteOne(item.id)"
            >
              <Trash2 :size="15" />
            </button>
          </div>
        </div>
      </div>

      <!-- 操作条：与结果列表同条件（grouped.length），绝不早于结果列表出现 -->
      <div v-if="grouped.length" class="list-head">
        <label class="chk">
          <input
            type="checkbox"
            :checked="candidates.length > 0 && selectedCount === candidates.length"
            @change="toggleAll"
          />
          全选
        </label>
        <span class="muted"
          >已选 {{ selectedCount }} 项 · {{ formatSize(selectedSize) }}</span
        >
        <button
          class="btn btn-danger"
          :disabled="cleaning || selectedCount === 0"
          @click="triggerClean"
        >
          <span v-if="cleaning" class="spinner" style="margin-right: 6px"></span>
          {{ cleaning ? "清理中…" : settings.allowPurge ? "直接删除" : "删除所选" }}
        </button>
        <span v-if="cleaning" class="ok">已删除 {{ cleanedCount }} 条</span>
      </div>

      <!-- 空态：一旦结果列表有内容（grouped.length）就整体隐藏，让位给列表。
           扫描中且还没出结果 → 显示「扫描中……」+ loading 图标。 -->
      <EmptyState
        v-if="!grouped.length && loading"
        loading
        :icon="Trash2"
        title="扫描中……"
      />
      <EmptyState
        v-else-if="!grouped.length && !result"
        :icon="Trash2"
        title="暂未扫描"
        desc="点击「扫描垃圾」开始查找可清理的垃圾文件。"
      />
      <EmptyState
        v-else-if="!grouped.length"
        :icon="SearchX"
        title="未发现对应记录"
        desc="本次扫描未发现可清理的垃圾文件，系统很干净。"
      />
    </div>

    <!-- 增强清理项勾选对话框 -->
    <Modal :open="showExtra" title="增强清理项" width="680px" @update:open="showExtra = $event">
      <div v-if="extraItems.length">
        <!-- 建议清理 -->
        <div class="group">
          <div class="group-title">
            <span class="badge safe">安全</span>
            建议清理（已默认勾选，删除后可自动重建）
          </div>
          <label v-for="i in safeItems" :key="i.id" class="opt">
            <input
              type="checkbox"
              :checked="extraSelected.has(i.id)"
              @change="toggleExtra(i.id)"
            />
            <span class="opt-main">
              <b>{{ i.name }}</b>
              <span class="muted desc">{{ i.description }}</span>
            </span>
          </label>
        </div>

        <!-- 需确认 -->
        <div v-if="cautionItems.length" class="group">
          <div class="group-title">
            <span class="badge caution">需确认</span>
            勾选前请先确认
          </div>
          <label v-for="i in cautionItems" :key="i.id" class="opt">
            <input
              type="checkbox"
              :checked="extraSelected.has(i.id)"
              @change="toggleExtra(i.id)"
            />
            <span class="opt-main">
              <b>{{ i.name }}</b>
              <span class="muted desc">{{ i.description }}</span>
            </span>
          </label>
        </div>

        <!-- 不可逆 -->
        <div v-if="dangerItems.length" class="group danger-group">
          <div class="warn">
            <AlertTriangle :size="15" />
            <span>
              以下操作<b>不可逆</b>：以前的 Windows 安装、Windows 更新清理、系统错误内存转储。
              勾选前请确认不需要回退系统或排查蓝屏。
            </span>
          </div>
          <div class="group-title">
            <span class="badge danger">不可逆</span>
            谨慎勾选
          </div>
          <label v-for="i in dangerItems" :key="i.id" class="opt">
            <input
              type="checkbox"
              :checked="extraSelected.has(i.id)"
              @change="toggleExtra(i.id)"
            />
            <span class="opt-main">
              <b>{{ i.name }}</b>
              <span class="muted desc">{{ i.description }}</span>
            </span>
          </label>
        </div>
      </div>
      <p v-else class="muted">增强清理项暂不可用。</p>
      <template #footer>
        <button class="btn btn-primary" @click="showExtra = false">完成</button>
      </template>
    </Modal>

    <!-- 清理完成对话框：重新扫描 / 暂不 -->
    <Modal
      :open="showDone"
      title="清理完成"
      width="420px"
      @update:open="showDone = $event"
    >
      <template v-if="doneResult">
        <p>
          已删除 <b>{{ doneResult.deleted_count }}</b> 项 ·
          {{ formatSize(doneResult.deleted_size) }}
        </p>
        <p v-if="doneResult.skipped.length" class="muted">
          已拦截 {{ doneResult.skipped.length }} 项（受保护/目录）
        </p>
        <p v-if="doneResult.errors.length" class="err">
          {{ doneResult.errors.length }} 项失败：{{ doneResult.errors.join('；') }}
        </p>
      </template>
      <template #footer>
        <button class="btn" @click="showDone = false">暂不</button>
        <button class="btn btn-primary" @click="doneRescan">重新扫描</button>
      </template>
    </Modal>

    <!-- 二次确认 -->
    <Transition name="fade">
      <div v-if="showConfirm" class="mask" @click.self="showConfirm = false">
        <div class="card dialog">
          <h2>确认清理？</h2>
          <p>
            即将{{ settings.allowPurge ? "直接删除" : "删除所选" }}
            <b>{{ selectedCount }}</b> 项文件（{{ formatSize(selectedSize) }}）。
          </p>
          <div v-if="selectedDangerNames.length" class="danger-note">
            <AlertTriangle :size="15" />
            <span>
              含不可逆项：{{ selectedDangerNames.join("、") }}。
              删除后无法恢复，也无法回退系统更新。
            </span>
          </div>
          <p class="muted">操作已写入审计日志，受保护路径会被自动跳过。</p>
          <div class="dialog-actions">
            <button class="btn" @click="showConfirm = false">取消</button>
            <button class="btn btn-danger" @click="confirmClean">确认</button>
          </div>
        </div>
      </div>
    </Transition>
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
  gap: 14px;
  flex-wrap: wrap;
}

/* ---- 增强清理项入口按钮（工具栏最右） ---- */
.extra-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.extra-count {
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
}
.group + .group {
  margin-top: 14px;
}
/* 清理项一行两个（组标题独占整行） */
.group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 18px;
  align-items: start;
}
.group-title {
  grid-column: 1 / -1;
}
.group > .warn {
  grid-column: 1 / -1;
}
.group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(13px * var(--fs-scale));
  color: var(--muted);
  margin: 10px 0 6px;
}
.badge {
  font-size: calc(11px * var(--fs-scale));
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 600;
}
.badge.safe {
  background: color-mix(in srgb, var(--success) 14%, transparent);
  color: var(--success);
}
.badge.caution {
  background: rgba(217, 119, 6, 0.14);
  color: #d97706;
}
.badge.danger {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.opt {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 4px;
  border-radius: 6px;
  cursor: pointer;
}
.opt:hover {
  background: var(--primary-weak);
}
.opt input {
  margin-top: 2px;
}
.opt-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.opt-main b {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 600;
}
.opt-main .desc {
  font-size: calc(12px * var(--fs-scale));
}
.warn,
.danger-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: calc(12px * var(--fs-scale));
  line-height: 1.6;
  padding: 10px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
}
.danger-note {
  margin-top: 10px;
}
.warn {
  margin-top: 10px;
}

/* ---- 分类导航条（单行横向滚动 + 左右箭头） ---- */
.cat-strip-wrap {
  display: flex;
  align-items: stretch;
  gap: 6px;
  margin: 14px 0 6px;
}
.cat-strip {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  /* 不设 scroll-behavior:smooth：拖动时直接赋值 scrollLeft，平滑会拖慢跟手性
     （箭头/点击定位已通过 scrollBy/scrollIntoView 的 behavior:'smooth' 单独平滑） */
  flex: 1;
  min-width: 0;
  padding-bottom: 2px;
  cursor: grab;
  user-select: none;
  /* 触屏上横向拖动交给 pointer 事件处理，别让浏览器原生横滚打断 */
  touch-action: pan-y;
  /* 隐藏横向滚动条 */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.cat-strip::-webkit-scrollbar {
  display: none;
}
.cat-strip.grabbing {
  cursor: grabbing;
}
.cat-chip {
  flex-shrink: 0;
  white-space: nowrap;
  background: var(--primary-weak);
  border: 1px solid transparent;
  border-radius: 9px;
  padding: 7px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: calc(13px * var(--fs-scale));
  cursor: pointer;
  text-align: left;
  color: var(--text);
}
.cat-chip:hover {
  border-color: var(--primary);
}
.cat-chip.active {
  background: color-mix(in srgb, var(--primary) 16%, transparent);
  border-color: var(--primary);
  color: var(--title);
}
.strip-arrow {
  flex-shrink: 0;
  width: 22px;
  border: none;
  background: transparent;
  font-size: calc(22px * var(--fs-scale));
  line-height: 1;
  cursor: pointer;
  color: var(--muted);
  padding: 0;
}
.strip-arrow:hover {
  color: var(--text);
}
.grp-chk {
  margin-right: 2px;
}
.grp-chk.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.list-head {
  display: flex;
  align-items: center;
  gap: 14px;
  /* 位于结果列表底部：只留上间距 */
  margin: 10px 0 0;
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(13px * var(--fs-scale));
  cursor: pointer;
}
.list {
  border-top: 1px solid var(--border);
  margin-top: 10px;
}
.cat-group {
  margin-bottom: 4px;
}
.group-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  position: sticky;
  /* Chromium 小数滚动偏移取整会让 top:0 的吸顶头停在顶部下方 1px，
     露出一条能看到滚动内容的缝；上移 1px 并在 padding 补回，视觉不变且完全贴合 */
  top: -1px;
  background: var(--panel);
  padding: 10px 2px 5px;
  border-bottom: 1px solid var(--border);
  z-index: 1;
}
.group-name {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 700;
  color: var(--title);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 2px;
  border-bottom: 1px solid var(--border);
  /* 大结果集性能：屏幕外的行跳过布局与绘制。
     结果上千条时，切走再切回（KeepAlive 重新插入 DOM）不再长时间占用主线程，
     避免切换页面时出现短暂白屏。 */
  content-visibility: auto;
  contain-intrinsic-size: auto 36px;
}
.path {
  flex: 1;
  font-size: calc(13px * var(--fs-scale));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.size {
  font-size: calc(12px * var(--fs-scale));
  flex-shrink: 0;
}
.btn-sm {
  margin-left: auto;
  padding: 3px 10px;
  font-size: calc(12px * var(--fs-scale));
}
.row-del {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-left: 6px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--danger);
  cursor: pointer;
}
.row-del:hover {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}
.row-del:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
}
.ok {
  color: var(--success);
  font-size: calc(13px * var(--fs-scale));
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
  width: 380px;
  max-width: 90vw;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}
</style>
