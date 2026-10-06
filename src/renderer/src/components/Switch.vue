<script setup lang="ts">
const props = defineProps<{ modelValue: boolean; disabled?: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

function toggle() {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    class="switch"
    :class="{ on: modelValue, disabled }"
    role="switch"
    :aria-checked="modelValue"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="knob"></span>
  </button>
</template>

<style scoped>
.switch {
  position: relative;
  width: 44px;
  height: 24px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--border);
  cursor: pointer;
  padding: 0;
  transition: background 0.2s, border-color 0.2s;
  flex-shrink: 0;
}
.switch.on {
  background: var(--accent);
  border-color: var(--accent);
}
.switch.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: left 0.2s;
}
.switch.on .knob {
  left: 22px;
}
</style>
