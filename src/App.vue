<script setup>
import ToastHost from '@/components/ToastHost.vue'
import LoginSheet from '@/components/LoginSheet.vue'
</script>

<template>
  <div class="app-frame">
    <router-view v-slot="{ Component }">
      <component :is="Component" />
    </router-view>
    <ToastHost />
    <!-- 全局登录弹层（S7-4）：门禁与「我的」页共用，登录成功后执行挂起的动作 -->
    <LoginSheet />
  </div>
</template>
