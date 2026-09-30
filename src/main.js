import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router/index.js'
import { syncEngine, ensureCloudFirstBind, initDataLayer } from './api/index.js'
import './styles/base.css'

/**
 * 启动顺序（每一步都有理由，不要调换）。
 *
 * ## 为什么**先 init 再 mount**（S5-5 踩过的坑）
 *
 * 视图的 `onMounted` 会立刻去读 repository（`ledgerRepo.list()` 等）。
 * 而 repository 是**指向当前分区的代理**，`current` 还没定下来时它就是空的
 * —— 读出来直接抛 `xxx is not a function`，首页停在 0.00 且不再刷新
 * （store 的 `initialized` 已被置真，之后不会再重试）。
 *
 * 所以顺序必须是：
 *   ① `initDataLayer()` —— 先问「我是谁」，据此选**按账号分区的库名**（S5-5）。
 *      必须在任何读写之前完成：早于它发生的读写会落到错误的分区，或者直接失败。
 *   ② `ensureCloudFirstBind()` —— 把本地已有数据整体入队（首次绑定）。
 *      它读的是「当前分区」的库，所以必须在 ① 之后。
 *   ③ 建应用并挂载 —— 此时代理已有目标，view 一进来就能读到正确的数据。
 *   ④ `syncEngine.start()` —— 挂 online/offline 监听、订阅 outbox、启动时补推一次。
 *      放在挂载之后：同步是后台行为，不该拖慢首屏。
 *
 * ## 为什么要包一层 async IIFE
 *
 * top-level `mount()` 是同步的，而 ①② 是异步的。之前把 `mount()` 写在最前面、
 * 把 ①②③ 串成 `.then` 链挂在后面，就出现了「view 先跑、数据层后到」的竞态。
 * 包进 IIFE 把「挂载」挪到 await 之后，顺序才是确定的。
 *
 * ## 失败也要能起来
 *
 * 每步都单独 catch：身份探测或首次绑定失败**不该挡住应用** ——
 * 没配云端时整条链本来就是空操作（`cloud = null`），本地记账必须照常可用。
 */
;(async () => {
  try {
    await initDataLayer()
  } catch (e) {
    // 身份探测失败：退回未认证分区，本地记账照常（initDataLayer 内部已兜底）
    console.warn('[ledger] 数据层初始化失败，退回未认证分区', e)
  }

  try {
    await ensureCloudFirstBind()
  } catch (e) {
    // 首次绑定失败：已入队的条目照样会被同步，用户新记的账走正常入队
    console.warn('[ledger] 首次绑定失败，不影响本地记账', e)
  }

  createApp(App).use(createPinia()).use(router).mount('#app')

  // 挂载后再启动同步：它是后台行为，不该挡在首屏前面
  try {
    syncEngine.start()
  } catch (e) {
    console.warn('[ledger] 同步引擎启动失败', e)
  }
})()
