import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router/index.js'
import { syncEngine, ensureCloudFirstBind } from './api/index.js'
import './styles/base.css'

createApp(App).use(createPinia()).use(router).mount('#app')

// 同步引擎：挂 online / offline 监听、订阅 outbox 的变更通知、启动时补推一次。
//
// 顺序有意义：先把「本地已有数据」整体入队（首次绑定），再启动引擎，
// 这样第一次同步就能把它们一起送上去。没配云端时两步都是空操作
// （见 api/index.js 的 cloud），不影响记账。
ensureCloudFirstBind()
  .catch(() => {
    // 首次绑定失败不该挡住应用：已经入队的条目照样会被同步，用户新记的账也走正常入队
  })
  .then(() => {
    syncEngine.start()
  })
