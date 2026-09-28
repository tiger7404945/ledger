<script setup>
import IconBase from './icons/IconBase.vue'

const emit = defineEmits(['key'])

const keys = [
  { k: '1', label: '1' },
  { k: '2', label: '2' },
  { k: '3', label: '3' },
  { k: 'backspace', label: '⌫' },
  { k: '4', label: '4' },
  { k: '5', label: '5' },
  { k: '6', label: '6' },
  { k: '+', label: '+' },
  { k: '7', label: '7' },
  { k: '8', label: '8' },
  { k: '9', label: '9' },
  { k: '-', label: '-' },
  { k: '.', label: '.' },
  { k: '0', label: '0' },
  { k: 'again', label: '再记' },
  { k: 'done', label: '完成', dark: true }
]
</script>

<template>
  <div class="keypad">
    <button
      v-for="item in keys"
      :key="item.k"
      class="key"
      :class="{ dark: item.dark, small: item.k === 'again' }"
      type="button"
      @click="emit('key', item.k)"
    >
      <IconBase v-if="item.k === 'backspace'" name="backspace" :size="22" />
      <template v-else>{{ item.label }}</template>
    </button>
  </div>
</template>

<style scoped>
.keypad {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: var(--hairline);
  border-top: 1px solid var(--hairline);
}

.key {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 52px;
  background: #fff;
  font-size: 22px;
  font-weight: 400;
  color: var(--ink);
  font-family: var(--font-num);
  transition: background 0.12s ease;
}

.key:active {
  background: var(--surface-2);
}

.key.small {
  font-size: 16px;
  font-family: var(--font);
}

.key.dark {
  margin: 6px;
  height: 42px;
  border-radius: 10px;
  background: var(--dark);
  color: #fff;
  font-size: 16px;
  font-family: var(--font);
  font-weight: 500;
}

.key.dark:active {
  background: #2a2a2a;
}
</style>
