import { createRouter, createWebHashHistory } from 'vue-router'

import { installRecordDraftGuard } from '@/composables/useRecordDraft.js'
import HomeView from '@/views/HomeView.vue'
import BillsView from '@/views/BillsView.vue'
import RecordView from '@/views/RecordView.vue'
import StatsView from '@/views/StatsView.vue'
import MineView from '@/views/MineView.vue'
import CategoryManageView from '@/views/CategoryManageView.vue'
import SubCategoryManageView from '@/views/SubCategoryManageView.vue'
import CategoryEditView from '@/views/CategoryEditView.vue'

const routes = [
  { path: '/', name: 'home', component: HomeView, meta: { tab: true } },
  { path: '/bills', name: 'bills', component: BillsView, meta: { tab: true } },
  { path: '/record', name: 'record', component: RecordView },
  { path: '/stats', name: 'stats', component: StatsView, meta: { tab: true } },
  { path: '/mine', name: 'mine', component: MineView, meta: { tab: true } },
  {
    path: '/category',
    name: 'category',
    component: CategoryManageView,
    children: [
      // 二级分类管理以底部弹层形式叠在分类管理页之上
      { path: ':parentId/sub', name: 'category-sub', component: SubCategoryManageView }
    ]
  },
  { path: '/category/edit', name: 'category-edit', component: CategoryEditView },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

/**
 * 记账页草稿的生命周期：只在「记账页 ↔ 分类管理/分类编辑」往返时保留，
 * 其它任何退出方式（返回键、左上角返回、切 Tab）立即作废。
 */
installRecordDraftGuard(router)

export default router
