<script setup>
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '确定' },
  cancelText: { type: String, default: '取消' },
  danger: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'confirm', 'cancel'])

function close() {
  emit('update:modelValue', false)
}

function onConfirm() {
  emit('confirm')
  close()
}

function onCancel() {
  emit('cancel')
  close()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="dialog-root">
      <div class="mask" @click="onCancel" />
      <div class="dialog">
        <h3 v-if="title" class="title">{{ title }}</h3>
        <p v-if="message" class="message">{{ message }}</p>
        <div class="actions">
          <button class="act" type="button" @click="onCancel">{{ cancelText }}</button>
          <button class="act primary" :class="{ danger }" type="button" @click="onConfirm">
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-root {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: var(--frame-w);
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 34px;
}

.mask {
  position: absolute;
  inset: 0;
  background: rgba(20, 22, 26, 0.42);
}

.dialog {
  position: relative;
  width: 100%;
  background: #fff;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
}

.title {
  margin: 22px 20px 0;
  font-size: 16px;
  font-weight: 600;
  text-align: center;
}

.message {
  margin: 10px 20px 20px;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--ink-2);
  text-align: center;
}

.actions {
  display: flex;
  border-top: 1px solid var(--hairline);
}

.act {
  flex: 1;
  height: 48px;
  font-size: 15.5px;
  color: var(--ink-2);
}

.act + .act {
  border-left: 1px solid var(--hairline);
}

.act.primary {
  color: var(--brand-700);
  font-weight: 500;
}

.act.primary.danger {
  color: var(--danger);
}
</style>
