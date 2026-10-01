import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router/index.js'
import { cloud, syncEngine, initDataLayer } from './api/index.js'
import { useAccountStore } from './stores/account.js'
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
 *      ⚠️ 它**只读身份、不创建账号**（S7 去掉了匿名身份）：没登录就落到
 *      未登录分区 `ledger_guest`。
 *   ② 建应用并挂载 —— 此时代理已有目标，view 一进来就能读到正确的数据。
 *   ③ `syncEngine.start()` —— 挂 online/offline 监听、订阅 outbox、启动时补推一次。
 *      放在挂载之后：同步是后台行为，不该拖慢首屏。
 *
 * ## S7-7 删掉了原第 ② 步「首次绑定」
 *
 * 以前这里是 `initDataLayer()` → `ensureCloudFirstBind()` → `mount()` → `start()`。
 * 首次绑定做的是「把本地已有数据整体入队推上云」，它当初存在的理由是
 * 「匿名身份下攒了一堆本地账，登录/转正后要送上去」。匿名身份没了之后，
 * 未登录不写数据、登录必然先退出清本地，云端不可能出现「两边都有内容」
 * 的局面 —— 于是这件事收敛成登录流程里的一次 `enqueueLocalForCloud()`，
 * 不该放在启动链上（启动时本来就不知道自己会不会登录）。
 *
 * ## 为什么要包一层 async IIFE
 *
 * top-level `mount()` 是同步的，而 ① 是异步的。之前把 `mount()` 写在最前面、
 * 把 ①②③ 串成 `.then` 链挂在后面，就出现了「view 先跑、数据层后到」的竞态。
 * 包进 IIFE 把「挂载」挪到 await 之后，顺序才是确定的。
 *
 * ## 失败也要能起来
 *
 * 身份探测失败**不该挡住应用** —— 没配云端时整条链本来就是空操作
 * （`cloud = null`），本地记账必须照常可用。
 */
;(async () => {
  try {
    await initDataLayer()
  } catch (e) {
    // 身份探测失败：退回未登录分区，本地记账照常（initDataLayer 内部已兜底）
    console.warn('[ledger] 数据层初始化失败，退回未登录分区', e)
  }

  createApp(App).use(createPinia()).use(router).mount('#app')

  /**
   * 立刻把身份同步进 Pinia store（**别等「我的」页挂载才做**）。
   *
   * 账号卡片、登录门禁、云端状态行都读 `account.signedIn`。而 store 的初始值
   * 是「未登录」——如果等某个页面自己去 bootstrap，那么**从其它页面进入时
   * 它还是默认值**：实测首页点「+」，明明已经登录却被门禁判成未登录、
   * 弹了登录框。`initDataLayer()` 已经把身份喂给了云端适配器（`cloud.signedIn`
   * 是准的），这里只是把它搬进 store。
   *
   * 幂等：`bootstrap()` 内部就是「读一次身份」，重复调没有副作用
   * （「我的」页的 onMounted 也会调它）。
   */
  useAccountStore()
    .bootstrap()
    .catch(() => {})

  // 挂载后再启动同步：它是后台行为，不该挡在首屏前面。
  // ⚠️ **只在已登录时启动**（S7-3）：未登录没什么可同步的（本地是 `ledger_guest`
  //    分区），引擎开着只会让 UI 一直显示「同步失败」。真正拉起同步的是
  //    登录成功后的 account store（`switchPartition` → `start()`）。
  try {
    if (cloud?.signedIn) syncEngine.start()
  } catch (e) {
    console.warn('[ledger] 同步引擎启动失败', e)
  }
})()
