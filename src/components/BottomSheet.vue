<script setup>
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  closeOnMask: { type: Boolean, default: true },
  radius: { type: Number, default: 20 }
})

const emit = defineEmits(['update:modelValue', 'close'])

function close() {
  emit('update:modelValue', false)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="sheet-root">
      <transition name="mask" appear>
        <div class="mask" @click="closeOnMask && close()" />
      </transition>
      <transition name="slide-up" appear>
        <div class="sheet" :style="{ borderTopLeftRadius: radius + 'px', borderTopRightRadius: radius + 'px' }">
          <slot />
        </div>
      </transition>
    </div>
  </Teleport>
</template>

<style scoped>
.sheet-root {
  /* 固定在手机外框所在的列内，避免桌面端遮罩铺满整屏 */
  position: fixed;
  top: 0;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: var(--frame-w);
  z-index: 60;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  pointer-events: none;
}

.sheet {
  pointer-events: auto;
  position: relative;
  width: 100%;
  max-width: var(--frame-w);
  max-height: 88%;
  background: var(--page);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-sheet);
}

.mask {
  pointer-events: auto;
  position: absolute;
  inset: 0;
  background: rgba(20, 22, 26, 0.42);
}

.mask-enter-active,
.mask-leave-active {
  transition: opacity 0.22s ease;
}
.mask-enter-from,
.mask-leave-to {
  opacity: 0;
}
</style>
