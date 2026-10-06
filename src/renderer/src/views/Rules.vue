<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  listRules,
  addUserRule,
  deleteUserRule,
  getRulesDir,
  openRulesDir,
  type RuleInfo,
  type UserRuleInput,
} from '../api/electron'
import { FileText, FolderOpen, Plus, RefreshCw, Trash2 } from '@lucide/vue'
import Modal from '../components/Modal.vue'
import { t } from '../stores/i18n'

const rules = ref<RuleInfo[]>([])
const loading = ref(false)
const error = ref('')
const rulesDir = ref('')

const builtinRules = computed(() => rules.value.filter((r) => r.source === 'builtin'))
const userRules = computed(() => rules.value.filter((r) => r.source === 'user'))

// 新增规则：改为弹出对话框
const showDialog = ref(false)
const saving = ref(false)
const pathsText = ref('')
const form = ref<UserRuleInput>({
  id: '',
  name: '',
  category: '自定义',
  description: '',
  enabled: true,
  paths: [],
  max_age_days: 30,
  min_size_kb: 0,
})

function resetForm() {
  form.value = {
    id: '',
    name: '',
    category: '自定义',
    description: '',
    enabled: true,
    paths: [],
    max_age_days: 30,
    min_size_kb: 0,
  }
  pathsText.value = ''
  error.value = ''
}

function openDialog() {
  resetForm()
  showDialog.value = true
}

function closeDialog() {
  showDialog.value = false
  resetForm()
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    rules.value = await listRules()
  } catch (e: any) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function openDir() {
  try {
    await openRulesDir()
  } catch (e: any) {
    error.value = String(e)
  }
}

async function submit() {
  saving.value = true
  error.value = ''
  try {
    const paths = pathsText.value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (!form.value.id.trim()) {
      error.value = t('rules.errId')
      return
    }
    if (paths.length === 0) {
      error.value = t('rules.errPaths')
      return
    }
    const res = await addUserRule({ ...form.value, paths })
    if (!res.ok) {
      error.value = res.error ?? t('rules.saveFailed')
      return
    }
    closeDialog()
    await load()
  } catch (e: any) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}

async function remove(r: RuleInfo) {
  if (!confirm(`${t('rules.confirmDelete')}「${r.name || r.id}」？${t('rules.deleteWarn')}`)) {
    return
  }
  try {
    const res = await deleteUserRule(r.id)
    if (!res.ok) {
      error.value = res.error ?? t('rules.deleteFailed')
      return
    }
    await load()
  } catch (e: any) {
    error.value = String(e)
  }
}

onMounted(async () => {
  await load()
  try {
    rulesDir.value = await getRulesDir()
  } catch {
    rulesDir.value = ''
  }
})
</script>

<template>
  <div>
    <h1>{{ t('rules.title') }}</h1>
    <p class="muted">
      {{ t('rules.descPrefix') }} <code>*.json</code> {{ t('rules.descSuffix') }}
    </p>

    <div class="card" style="margin-top: 14px">
      <div class="toolbar">
        <button class="btn btn-primary" :disabled="loading" @click="load">
          <RefreshCw :size="15" />
          <span v-if="loading" class="spinner"></span>
          {{ loading ? t('common.loading') : t('common.refresh') }}
        </button>
        <button class="btn" @click="openDir">
          <FolderOpen :size="15" />
          {{ t('rules.openDir') }}
        </button>
        <button class="btn" @click="openDialog">
          <Plus :size="15" />
          {{ t('rules.new') }}
        </button>
        <span v-if="rulesDir" class="muted dir">{{ rulesDir }}</span>
        <span v-if="error" class="err">{{ error }}</span>
      </div>

      <!-- 用户规则 -->
      <h2 class="sec">
        <FileText :size="15" /> {{ t('rules.userRules') }}（{{ userRules.length }}）
      </h2>
      <div v-if="userRules.length === 0" class="muted empty">
        {{ t('rules.emptyUser') }}
      </div>
      <div v-for="r in userRules" :key="r.id" class="rule">
        <div class="rule-head">
          <b>{{ r.name || r.id }}</b>
          <span class="tag" :class="{ off: !r.enabled }">
            {{ r.enabled ? t('rules.tagOn') : t('rules.tagOff') }}
          </span>
          <button class="btn btn-danger sm" @click="remove(r)">
            <Trash2 :size="13" /> {{ t('common.delete') }}
          </button>
        </div>
        <div class="muted desc">{{ r.description }}</div>
        <div class="meta">
          <span>ID: {{ r.id }}</span>
          <span v-if="r.max_age_days > 0">{{ t('rules.ageDays', { n: r.max_age_days }) }}</span>
          <span v-for="p in r.paths" :key="p" class="path">{{ p }}</span>
        </div>
      </div>

      <!-- 内置规则 -->
      <h2 class="sec">{{ t('rules.builtinRules') }}（{{ builtinRules.length }}）</h2>
      <div v-for="r in builtinRules" :key="r.id" class="rule">
        <div class="rule-head">
          <b>{{ r.name }}</b>
          <span class="tag builtin">{{ t('rules.tagBuiltin') }}</span>
        </div>
        <div class="muted desc">{{ r.description }}</div>
        <div class="meta">
          <span>{{ t('rules.ageDays', { n: r.max_age_days }) }}</span>
          <span v-for="p in r.paths" :key="p" class="path">{{ p }}</span>
        </div>
      </div>
    </div>

    <!-- 新增规则：弹出对话框 -->
    <Modal
      :open="showDialog"
      :title="t('rules.newTitle')"
      width="560px"
      @update:open="(v) => (showDialog = v)"
      @close="closeDialog"
    >
      <div class="form">
        <p class="muted dialog-tip">{{ t('rules.newDesc') }}</p>
        <div class="row2">
          <label
            >{{ t('rules.id') }}
            <input v-model="form.id" :placeholder="t('rules.idPh')" />
          </label>
          <label
            >{{ t('rules.name') }}
            <input v-model="form.name" :placeholder="t('rules.namePh')" />
          </label>
        </div>
        <div class="row2">
          <label
            >{{ t('rules.category') }}
            <input v-model="form.category" placeholder="自定义" />
          </label>
          <label
            >{{ t('rules.maxAge') }}
            <input v-model.number="form.max_age_days" type="number" min="0" />
          </label>
        </div>
        <label
          >{{ t('rules.description') }}
          <input v-model="form.description" :placeholder="t('rules.descPh')" />
        </label>
        <label>
          {{ t('rules.glob') }}
          <textarea v-model="pathsText" rows="3" :placeholder="t('rules.globPh')"></textarea>
        </label>
        <div class="row2">
          <label
            >{{ t('rules.minSize') }}
            <input v-model.number="form.min_size_kb" type="number" min="0" />
          </label>
          <label class="chk">
            <input v-model="form.enabled" type="checkbox" />
            {{ t('rules.enabled') }}
          </label>
        </div>
        <div v-if="error" class="err">{{ error }}</div>
      </div>
      <template #footer>
        <button class="btn" @click="closeDialog">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" :disabled="saving" @click="submit">
          {{ saving ? t('rules.saving') : t('rules.save') }}
        </button>
      </template>
    </Modal>
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
.dir {
  font-size: calc(12px * var(--fs-scale));
  word-break: break-all;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dialog-tip {
  margin: 0;
}
.form label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: calc(13px * var(--fs-scale));
  color: var(--muted);
}
.form input,
.form textarea {
  font-size: calc(14px * var(--fs-scale));
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  font-family: inherit;
}
.form textarea {
  resize: vertical;
}
.row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.sec {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 18px 0 8px;
  font-size: calc(15px * var(--fs-scale));
}
.empty {
  padding: 10px 0;
}
.rule {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 10px;
}
.rule-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rule-head .btn {
  margin-left: auto;
}
.tag {
  font-size: calc(11px * var(--fs-scale));
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--primary-weak);
  color: var(--primary);
}
.tag.off {
  background: var(--border);
  color: var(--muted);
}
.tag.builtin {
  background: rgba(0, 0, 0, 0.06);
  color: var(--muted);
}
.desc {
  font-size: calc(13px * var(--fs-scale));
  margin: 6px 0;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: calc(12px * var(--fs-scale));
  color: var(--muted);
}
.meta .path {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px 6px;
  word-break: break-all;
}
.err {
  color: var(--danger);
  font-size: calc(13px * var(--fs-scale));
}
.btn.sm {
  padding: 4px 10px;
  font-size: calc(12px * var(--fs-scale));
}
</style>
