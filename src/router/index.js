import { createRouter, createWebHashHistory } from 'vue-router'

import { installRecordDraftGuard } from '@/composables/useRecordDraft.js'
import { requireLogin } from '@/composables/useLoginGate.js'
import HomeView from '@/views/HomeView.vue'
import BillsView from '@/views/BillsView.vue'
import RecordView from '@/views/RecordView.vue'
import StatsView from '@/views/StatsView.vue'
import MineView from '@/views/MineView.vue'
import CategoryManageView from '@/views/CategoryManageView.vue'
import SubCategoryManageView from '@/views/SubCategoryManageView.vue'
import CategoryEditView from '@/views/CategoryEditView.vue'

/**
 * `meta.requiresAuth`（S7-5）：**写操作入口**。未登录时进不去，会先弹登录弹层。
 *
 * 哪些算写操作：记账页（新建 / 改一笔、删一笔）、分类管理（增删改分类）及其
 * 子页。读操作的三个 Tab（首页 / 账单 / 统计）与「我的」不设限 —— 未登录也能
 * 看能算（`ledger_guest` 分区里有账本和分类，账单是空的）。
 *
 * `meta.authLabel` 是弹层里给用户看的那句话的动作名，如「记账需要先登录…」。
 */
const routes = [
  { path: '/', name: 'home', component: HomeView, meta: { tab: true } },
  { path: '/bills', name: 'bills', component: BillsView, meta: { tab: true } },
  {
    path: '/record',
    name: 'record',
    component: RecordView,
    meta: { requiresAuth: true, authLabel: '记账' }
  },
  { path: '/stats', name: 'stats', component: StatsView, meta: { tab: true } },
  { path: '/mine', name: 'mine', component: MineView, meta: { tab: true } },
  {
    path: '/category',
    name: 'category',
    component: CategoryManageView,
    meta: { requiresAuth: true, authLabel: '分类管理' },
    children: [
      // 二级分类管理以底部弹层形式叠在分类管理页之上
      { path: ':parentId/sub', name: 'category-sub', component: SubCategoryManageView }
    ]
  },
  {
    path: '/category/edit',
    name: 'category-edit',
    component: CategoryEditView,
    meta: { requiresAuth: true, authLabel: '分类管理' }
  },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

/**
 * 写操作登录门禁（S7-5）。
 *
 * ⚠️ **必须注册在草稿守卫之前**：vue-router 的 `beforeEach` 按注册顺序执行，
 *    一旦这里返回 `false`（导航被中止），后面的草稿守卫就不会跑 ——
 *    否则「未登录点 + 被拦下」会被草稿守卫误判成「离开了记账链路」。
 *
 * `after` = 登录成功后把这次被拦下的导航**接着做完**：用户点的是「记一笔」，
 * 登录完就该真的进到记账页，而不是停在原地再点一次。
 */
router.beforeEach((to, from) => {
  if (!to.meta.requiresAuth) return true

  const after = () => router.push(to.fullPath).catch(() => {})
  if (requireLogin(to.meta.authLabel || '该操作', after)) return true

  /**
   * 被拦下之后往哪走，分两种情况：
   *
   *   - **正常导航**（用户点了某个入口）→ 返回 `false` 停在原页。
   *     用户点的是「+」，取消登录后就该留在首页，而不是被莫名扔到别处。
   *
   *   - **直接访问 / 刷新到受保护路由** → `from` 是 router 的初始位置
   *     （`from.name === undefined`，没有「原页」可停）。这时如果也返回
   *     `false`，router-view 就没有匹配的组件 —— 实测**整页白屏**，
   *     只剩一个登录弹层。所以必须显式重定向到首页。
   */
  return from.name === undefined ? { path: '/', replace: true } : false
})

/**
 * 记账页草稿的生命周期：只在「记账页 ↔ 分类管理/分类编辑」往返时保留，
 * 其它任何退出方式（返回键、左上角返回、切 Tab）立即作废。
 */
installRecordDraftGuard(router)

export default router
