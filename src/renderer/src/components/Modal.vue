<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

/**
 * 模态栈：所有已打开的对话框按「打开顺序」入栈（后开的在栈顶）。
 *
 * 为什么需要：存在嵌套弹窗场景 —— 右上角齿轮打开「设置」对话框，里面点
 * 「开始校验」又会弹出「校验结果」对话框。两个对话框都监听 window 的 keydown，
 * 若不加栈，按一次 ESC 会把两层一起关掉（外层设置页被误关）。
 * 有了栈，keydown 只在「自己是栈顶」时才响应，一次 ESC 只关最上层。
 *
 * 只存 token（本实例的标识对象），不持有组件实例，避免内存泄漏。
 */
const modalStack: object[] = reactive([])

/** 通用模态对话框：遮罩 + 居中卡片，支持 ESC / 点遮罩 / 关闭按钮三种关闭方式。 */
const props = withDefaults(
  defineProps<{
    /** 是否显示（v-model:open） */
    open: boolean
    title?: string
    /** 卡片宽度，默认 520px */
    width?: string
    /** 卡片高度；不传则随内容自适应，传了则固定高度、内容区内部滚动 */
    height?: string
    /** 点击遮罩是否关闭，默认 true */
    closeOnMask?: boolean
    /** 隐藏右上角 × 按钮（用于必须做出选择的场景） */
    hideClose?: boolean
  }>(),
  { title: '', width: '520px', closeOnMask: true, hideClose: false },
)

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'close'): void
}>()

const card = ref<HTMLElement | null>(null)

/** 本实例在模态栈中的标识 */
const token: object = {}

function pushStack() {
  if (!modalStack.includes(token)) modalStack.push(token)
}

function popStack() {
  const i = modalStack.indexOf(token)
  if (i >= 0) modalStack.splice(i, 1)
}

/** 自己在栈中的层级：0 = 最底层。reactive 栈，嵌套弹窗开关时会自动重算 */
const depth = computed(() => modalStack.indexOf(token))

/** 自己是否是当前最上层的对话框（嵌套时只有栈顶响应 ESC） */
function isTopmost(): boolean {
  return depth.value >= 0 && depth.value === modalStack.length - 1
}

/**
 * 层级：基础 9999（高于顶栏 .drag-strip 的 100）+ 栈深度。
 * 保证「视觉最上层」永远等于「ESC 会关掉的那一层」，不依赖 DOM 挂载顺序。
 */
const zIndex = computed(() => 9999 + Math.max(0, depth.value))

function close() {
  emit('update:open', false)
  emit('close')
}

function onMask() {
  if (props.closeOnMask) close()
}

function onKey(e: KeyboardEvent) {
  // 只处理最上层：嵌套弹窗时一次 ESC 关一层，不会连带关掉外层
  if (e.key === 'Escape' && props.open && isTopmost()) {
    e.stopPropagation()
    close()
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
// 卸载时必须出栈：否则栈顶残留一个已销毁的实例，之后的对话框都收不到 ESC
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  popStack()
})

// 打开时把焦点移进卡片，便于 Tab 导航与直接输入
watch(
  () => props.open,
  (v) => {
    if (v) {
      pushStack()
      requestAnimationFrame(() => {
        const el = card.value?.querySelector<HTMLElement>(
          'input, textarea, select, button',
        )
        ;(el ?? card.value)?.focus()
      })
    } else {
      popStack()
    }
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="modal-mask" :style="{ zIndex }" @click="onMask">
        <div
          ref="card"
          class="modal-card"
          :style="{ width, height }"
          role="dialog"
          aria-modal="true"
          @click.stop
        >
          <div class="modal-head">
            <h3>{{ title }}</h3>
            <button
              v-if="!hideClose"
              class="modal-x"
              type="button"
              aria-label="关闭"
              @click="close"
            >
              ✕
            </button>
          </div>
          <div class="modal-body">
            <slot />
          </div>
          <div v-if="$slots.footer" class="modal-foot">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  /* 无边框窗口：弹窗整棵子树都不可拖拽，避免 -webkit-app-region 从祖先
     继承成 drag 后吞掉鼠标事件（表现为部分区域点不动 / hover 不生效）。
     z-index 远高于顶栏 .drag-strip(100)，确保遮罩始终盖在拖拽条之上。 */
  -webkit-app-region: no-drag;
  background: rgba(20, 26, 33, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal-card {
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 12px 40px rgba(20, 26, 33, 0.28);
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--border);
}
.modal-head h3 {
  margin: 0;
  font-size: calc(16px * var(--fs-scale));
  font-weight: 600;
  color: var(--title);
}
.modal-x {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: calc(15px * var(--fs-scale));
  line-height: 1;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
}
.modal-x:hover {
  background: var(--border);
  color: var(--text);
}
.modal-body {
  padding: 16px 18px;
  overflow-y: auto;
  /* 固定高度模式下占据剩余空间，高度由内容决定时也无害 */
  flex: 1 1 auto;
  min-height: 0;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px 16px;
  border-top: 1px solid var(--border);
}
@keyframes mask-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes mask-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes card-out {
  from {
    opacity: 1;
    transform: none;
  }
  to {
    opacity: 0;
    transform: translateY(-6px) scale(0.985);
  }
}
/* Transition 进出场：遮罩淡入淡出 + 卡片轻微上滑缩放 */
.modal-enter-active {
  animation: mask-in 0.15s ease-out;
}
.modal-leave-active {
  animation: mask-out 0.13s ease-in;
}
.modal-enter-active .modal-card {
  animation: card-in 0.17s cubic-bezier(0.22, 1, 0.36, 1);
}
.modal-leave-active .modal-card {
  animation: card-out 0.13s ease-in;
}
@media (prefers-reduced-motion: reduce) {
  .modal-enter-active,
  .modal-leave-active,
  .modal-enter-active .modal-card,
  .modal-leave-active .modal-card {
    animation: none;
  }
}
</style>
