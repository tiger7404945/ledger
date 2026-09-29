import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router/index.js'
import { syncEngine } from './api/index.js'
import './styles/base.css'

createApp(App).use(createPinia()).use(router).mount('#app')

// 同步引擎：挂 online / offline 监听、订阅 outbox 的变更通知、启动时补推一次。
// 没配云端时它什么都不做（见 api/index.js 的 cloud），不影响记账。
syncEngine.start()
