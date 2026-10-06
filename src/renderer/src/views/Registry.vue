<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  scanRegistry,
  cancelScan,
  deleteRegistry,
  listRegistryBackups,
  restoreRegistry,
  type RegistryEntry,
  type RegistryCleanResult,
  type RegistryBackup,
} from '../api/electron'
import { recordScan } from '../stores/history'
import LastScan from '../components/LastScan.vue'
import {
  Search,
  Trash2,
  ShieldCheck,
  RotateCcw,
  AlertTriangle,
  FileSearch,
  SearchX,
} from '@lucide/vue'
import EmptyState from '../components/EmptyState.vue'

const entries = ref<RegistryEntry[]>([])
const loading = ref(false)
/** 是否已执行过一次扫描（区分「暂未扫描」与「已扫描无结果」两种空态） */
const scanned = ref(false)
const error = ref('')
const selected = ref<Set<string>>(new Set())
const cleaning = ref(false)
const cleanResult = ref<RegistryCleanResult | null>(null)
const showConfirm = ref(false)

const backups = ref<RegistryBackup[]>([])
const showBackups = ref(false)
const restoring = ref<string | null>(null)
const restoreMsg = ref('')

const selectedCount = computed(() => selected.value.size)

// 按分类汇总，便于用户判断清理范围
const categories = computed(() => {
  const m = new Map<string, number>()
  for (const e of entries.value) m.set(e.category, (m.get(e.category) ?? 0) + 1)
  return Array.from(m.entries()).map(([category, count]) => ({ category, count }))
})

async function doScan() {
  loading.value = true
  error.value = ''
  cleanResult.value = null
  entries.value = []
  selected.value = new Set()
  try {
    // 新条目从上方插入，保持「逐行浮现」的流式观感；seen 去重（O(n²) → O(n)）
    const seen = new Set<string>()
    const res = await scanRegistry((item) => {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        entries.value.unshift(item)
      }
    })
    entries.value = res
    void recordScan('registry', `${entries.value.length} 项`)
  } catch (e: any) {
    error.value = String(e)
  } finally {
    loading.value = false
    scanned.value = true
  }
}

function toggle(id: string) {
  const s = new Set(selected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selected.value = s
}

function toggleAll() {
  if (selectedCount.value === entries.value.length) selected.value = new Set()
  else selected.value = new Set(entries.value.map((e) => e.id))
}

async function confirmClean() {
  showConfirm.value = false
  cleaning.value = true
  error.value = ''
  try {
    cleanResult.value = await deleteRegistry(Array.from(selected.value))
    selected.value = new Set()
    await Promise.all([doScan(), loadBackups()])
  } catch (e: any) {
    error.value = String(e)
  } finally {
    cleaning.value = false
  }
}

async function loadBackups() {
  try {
    backups.value = await listRegistryBackups()
  } catch {
    backups.value = []
  }
}

async function doRestore(b: RegistryBackup) {
  if (!confirm(`确定从备份恢复 ${b.count} 项注册表内容？\n${b.created_at}`)) return
  restoring.value = b.file
  restoreMsg.value = ''
  try {
    const r = await restoreRegistry(b.file)
    restoreMsg.value = r.errors.length
      ? `已恢复 ${r.restored} 项，${r.errors.length} 项失败`
      : `已恢复 ${r.restored} 项`
  } catch (e: any) {
    restoreMsg.value = '恢复失败：' + String(e)
  } finally {
    restoring.value = null
  }
}

function kindLabel(k: string) {
  return k === 'key' ? '子键' : '键值'
}

onMounted(async () => {
  await loadBackups()
})
</script>

<template>
  <div>
    <h1 class="h-with-icon">
      <FileSearch :size="22" class="title-icon" />
      注册表清理
    </h1>
    <p class="muted">
      仅检测「判定明确」的失效项：卸载残留、无效启动项、丢失的共享 DLL、无效应用路径。
      删除前自动备份，可在下方一键恢复。
    </p>

    <div class="card" style="margin-top: 14px">
      <div class="toolbar">
        <button v-if="!loading" class="btn btn-primary" @click="doScan">
          <Search :size="15" /> 扫描注册表
        </button>
        <button v-else class="btn btn-warn" @click="cancelScan">取消扫描</button>
        <span v-if="loading" class="muted"><span class="spinner"></span> 扫描中… 已发现 {{ entries.length }} 项</span>
        <span v-else-if="entries.length" class="muted">
          共 {{ entries.length }} 项
        </span>
        <span v-if="error" class="err">{{ error }}</span>
        <LastScan module="registry" />
      </div>
      <div v-if="loading" class="progress toolbar-progress">
        <div class="bar indeterminate"></div>
      </div>

      <div v-if="categories.length" class="cat-summary">
        <div v-for="c in categories" :key="c.category" class="cat-chip">
          <b>{{ c.category }}</b>
          <span class="muted">{{ c.count }} 项</span>
        </div>
      </div>

      <div v-if="entries.length" class="list-head">
        <label class="chk">
          <input
            type="checkbox"
            :checked="selectedCount === entries.length"
            @change="toggleAll"
          />
          全选
        </label>
        <span class="muted">已选 {{ selectedCount }} 项</span>
        <button
          class="btn btn-danger"
          :disabled="cleaning || selectedCount === 0"
          @click="showConfirm = true"
        >
          <Trash2 :size="15" />
          {{ cleaning ? '清理中…' : '清理选中' }}
        </button>
      </div>

      <div v-if="entries.length" class="list">
        <div v-for="e in entries" :key="e.id" class="row">
          <label class="chk">
            <input
              type="checkbox"
              :checked="selected.has(e.id)"
              @change="toggle(e.id)"
            />
          </label>
          <span class="tag">{{ e.category }}</span>
          <span class="main">
            <span class="name">{{ e.name }}</span>
            <span class="muted sub">{{ e.key_path }} · {{ kindLabel(e.kind) }}</span>
            <span class="muted sub target">目标已不存在：{{ e.target }}</span>
          </span>
        </div>
      </div>

      <EmptyState
        v-if="loading && !entries.length"
        loading
        :icon="FileSearch"
        title="扫描中……"
      />
      <EmptyState
        v-else-if="!entries.length && !scanned"
        :icon="FileSearch"
        title="暂未扫描"
        desc="点击「扫描注册表」检测失效的卸载信息、共享 DLL、开机自启等条目。"
      />
      <EmptyState
        v-else-if="!entries.length"
        :icon="SearchX"
        title="未发现对应记录"
        desc="注册表很干净，没有发现可清理的失效项。"
      />
    </div>

    <!-- 清理结果 -->
    <div v-if="cleanResult" class="card result">
      <h2>清理完成</h2>
      <p>已删除 <b>{{ cleanResult.deleted_count }}</b> 项注册表内容</p>
      <p v-if="cleanResult.backup_file" class="muted">
        备份文件：{{ cleanResult.backup_file }}
      </p>
      <p v-if="cleanResult.skipped.length" class="muted">
        跳过 {{ cleanResult.skipped.length }} 项（已不存在或目标已恢复）
      </p>
      <p v-if="cleanResult.errors.length" class="err">
        {{ cleanResult.errors.length }} 项失败（HKLM 项可能需要管理员权限）
      </p>
    </div>

    <!-- 备份与恢复 -->
    <div class="card" style="margin-top: 14px">
      <button class="extra-head" @click="showBackups = !showBackups">
        <ShieldCheck :size="16" />
        <span>备份与恢复（{{ backups.length }}）</span>
      </button>
      <div v-if="showBackups" class="backups">
        <div v-if="!backups.length" class="muted">暂无备份。执行清理后会自动生成备份。</div>
        <div v-for="b in backups" :key="b.file" class="backup-row">
          <span class="muted time">{{ b.created_at }}</span>
          <span class="muted">{{ b.count }} 项</span>
          <button
            class="btn sm"
            :disabled="restoring === b.file"
            @click="doRestore(b)"
          >
            <RotateCcw :size="13" />
            {{ restoring === b.file ? '恢复中…' : '恢复' }}
          </button>
        </div>
        <p v-if="restoreMsg" class="muted">{{ restoreMsg }}</p>
      </div>
    </div>

    <!-- 二次确认 -->
    <Transition name="fade">
      <div v-if="showConfirm" class="mask" @click.self="showConfirm = false">
      <div class="card dialog">
        <h2>确认清理注册表？</h2>
        <p>
          即将删除 <b>{{ selectedCount }}</b> 项无效注册表内容。
        </p>
        <div class="warn">
          <AlertTriangle :size="15" />
          <span>
            删除前会自动备份，可在「备份与恢复」中还原。
            若你不确定某些项的用途，建议只清理「卸载残留」类。
          </span>
        </div>
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
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.btn.sm {
  padding: 4px 10px;
  font-size: calc(12px * var(--fs-scale));
}
.cat-summary {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin: 14px 0;
}
.cat-chip {
  background: var(--primary-weak);
  border-radius: 9px;
  padding: 6px 12px;
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: calc(13px * var(--fs-scale));
}
.list-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 6px 0 10px;
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
  max-height: 46vh;
  overflow-y: auto;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 2px;
  border-bottom: 1px solid var(--border);
}
.row .chk {
  padding-top: 2px;
}
.tag {
  flex-shrink: 0;
  background: var(--primary-weak);
  color: var(--primary);
  border-radius: 6px;
  padding: 2px 8px;
  font-size: calc(11px * var(--fs-scale));
  font-weight: 600;
}
.main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.name {
  font-size: calc(13px * var(--fs-scale));
  font-weight: 600;
  word-break: break-all;
}
.sub {
  font-size: calc(12px * var(--fs-scale));
  word-break: break-all;
}
.target {
  color: var(--danger);
}
.empty {
  padding: 10px 0;
}
.result {
  margin-top: 14px;
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
}
.extra-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: calc(14px * var(--fs-scale));
  font-family: inherit;
  cursor: pointer;
  padding: 4px 2px;
}
.backups {
  margin-top: 10px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.backup-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 2px;
  border-bottom: 1px solid var(--border);
}
.time {
  font-size: calc(12px * var(--fs-scale));
  flex: 1;
}
.warn {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: calc(12px * var(--fs-scale));
  line-height: 1.6;
  padding: 10px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
  margin-top: 10px;
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
  width: 400px;
  max-width: 90vw;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}
.h-with-icon { display: flex; align-items: center; gap: 8px; }
.title-icon { flex-shrink: 0; }
</style>
