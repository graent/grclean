<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  listSchedules,
  addSchedule,
  deleteSchedule,
  listPrivacyRules,
  runPrivacyNow,
  formatSize,
  type ScheduleConfig,
  type PrivacyRuleOption,
  type CleanResult,
} from '../api/electron'
import { CalendarClock, Play, Trash2 } from '@lucide/vue'
import Select from '../components/Select.vue'

const freqOptions = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周一' },
]

const schedules = ref<ScheduleConfig[]>([])
const options = ref<PrivacyRuleOption[]>([])
const loading = ref(false)
const saving = ref(false)
const running = ref(false)

const form = ref({
  name: '',
  frequency: 'daily',
  time: '09:00',
  ruleIds: [] as string[],
})

const lastRun = ref<CleanResult | null>(null)
const message = ref('')
const isError = ref(false)

async function load() {
  loading.value = true
  try {
    const [s, o] = await Promise.all([listSchedules(), listPrivacyRules()])
    schedules.value = s
    options.value = o
  } finally {
    loading.value = false
  }
}

onMounted(load)

function toggleRule(id: string) {
  const i = form.value.ruleIds.indexOf(id)
  if (i >= 0) form.value.ruleIds.splice(i, 1)
  else form.value.ruleIds.push(id)
}

const canSave = computed(
  () => form.value.name.trim().length > 0 && form.value.time.length === 5,
)

async function createSchedule() {
  if (!canSave.value) return
  saving.value = true
  message.value = ''
  isError.value = false
  try {
    const cfg: ScheduleConfig = {
      id: `s_${Date.now()}`,
      name: form.value.name.trim(),
      frequency: form.value.frequency,
      time: form.value.time,
      rule_ids: form.value.ruleIds,
      enabled: true,
    }
    const res = await addSchedule(cfg)
    if (!res.ok) {
      isError.value = true
      message.value = '创建失败：' + (res.error ?? '未知错误')
      return
    }
    form.value = { name: '', frequency: 'daily', time: '09:00', ruleIds: [] }
    await load()
    message.value = '计划已创建，并已注册到 Windows 任务计划程序'
  } finally {
    saving.value = false
  }
}

async function remove(id: string) {
  if (!confirm('确定删除该定时清理计划？已注册的 Windows 任务也会一并移除。')) return
  const res = await deleteSchedule(id)
  if (!res.ok) {
    isError.value = true
    message.value = '删除失败：' + (res.error ?? '未知错误')
    return
  }
  await load()
}

async function runNow() {
  running.value = true
  message.value = ''
  isError.value = false
  try {
    lastRun.value = await runPrivacyNow(
      form.value.ruleIds.length ? form.value.ruleIds : null,
    )
  } catch (e: any) {
    isError.value = true
    message.value = '执行失败：' + String(e)
  } finally {
    running.value = false
  }
}

function freqLabel(f: string) {
  return f === 'weekly' ? '每周一' : '每天'
}
</script>

<template>
  <div>
    <h1>定时清理</h1>
    <p class="muted">
      设置后，GrClean 会在指定时间自动清理浏览器缓存与临时文件（默认移入回收站，绝不永久删除）。
    </p>

    <div class="card">
      <h2>新建计划</h2>
      <div class="form">
        <label>名称<input v-model="form.name" placeholder="如：每日隐私清理" /></label>
        <label>
          频率
          <Select v-model="form.frequency" :options="freqOptions" :width="140" />
        </label>
        <label>时间<input v-model="form.time" type="time" /></label>
      </div>

      <div class="rules">
        <div class="rules-title">清理范围（可多选，默认全选）</div>
        <label v-for="o in options" :key="o.id" class="chk">
          <input
            type="checkbox"
            :checked="form.ruleIds.length === 0 || form.ruleIds.includes(o.id)"
            @change="toggleRule(o.id)"
          />
          {{ o.name }}
        </label>
      </div>

      <div class="row actions">
        <button class="btn btn-primary" :disabled="!canSave || saving" @click="createSchedule">
          <CalendarClock :size="15" />
          {{ saving ? '创建中…' : '创建计划' }}
        </button>
        <button class="btn" :disabled="saving || running" @click="runNow">
          <Play :size="15" />
          {{ running ? '执行中…' : '立即运行一次' }}
        </button>
      </div>
    </div>

    <div class="card" style="margin-top: 16px">
      <h2>已有计划（{{ schedules.length }}）</h2>
      <div v-if="loading" class="muted">加载中…</div>
      <div v-else-if="schedules.length === 0" class="muted">暂无计划，先在上方创建一个。</div>
      <table v-else class="tbl">
        <thead>
          <tr><th>名称</th><th>频率</th><th>时间</th><th>范围</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="s in schedules" :key="s.id">
            <td>{{ s.name }}</td>
            <td>{{ freqLabel(s.frequency) }}</td>
            <td>{{ s.time }}</td>
            <td class="muted">{{ s.rule_ids.length === 0 ? '全部' : s.rule_ids.length + ' 项' }}</td>
            <td>
              <button class="btn btn-danger" @click="remove(s.id)">
                <Trash2 :size="13" /> 删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="message" class="card note" :class="{ danger: isError }">{{ message }}</div>

    <div v-if="lastRun" class="card note success">
      本次立即运行：删除 {{ lastRun.deleted_count }} 个文件，释放
      {{ formatSize(lastRun.deleted_size) }}
      <span v-if="lastRun.errors.length" class="err-inline">
        · {{ lastRun.errors.length }} 个错误</span
      >
    </div>
  </div>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.form {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: calc(13px * var(--fs-scale));
  color: var(--muted);
}
.form input {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  font-size: calc(14px * var(--fs-scale));
}
.rules {
  margin-bottom: 14px;
}
.rules-title {
  font-size: calc(13px * var(--fs-scale));
  color: var(--muted);
  margin-bottom: 8px;
}
.chk {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 16px;
  font-size: calc(14px * var(--fs-scale));
  cursor: pointer;
}
.row {
  display: flex;
  gap: 12px;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: calc(14px * var(--fs-scale));
}
.tbl th,
.tbl td {
  text-align: left;
  padding: 9px 8px;
  border-bottom: 1px solid var(--border);
}
.note {
  margin-top: 16px;
  font-size: calc(14px * var(--fs-scale));
}
.success {
  color: var(--success);
}
.danger {
  color: var(--danger);
}
.err-inline {
  color: var(--danger);
}
</style>
