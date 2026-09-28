# ui-implementation-plan.md

## 1. 现状分析
- 目标目录 `D:\projects\ledger` 为空工程（仅参考截图）。
- 无既有组件库 / 设计系统，需要从零建立 tokens 与组件层。
- 结论：新建 Vue3 + Vite 工程，自建轻量组件库（不使用第三方 UI 库，保证视觉贴合原型）。

## 2. 技术选型
| 关注点 | 方案 |
| --- | --- |
| 框架 | Vue 3.5（`<script setup>`）+ Vite 6 |
| 路由 | Vue Router 4（hash 无关，history 模式） |
| 状态 | Pinia（`category` / `bill` / `ledger` / `sync`） |
| 样式 | 原生 CSS + CSS 变量（`styles/tokens.css`），组件内 `<style scoped>` |
| 图标 | 自建 SVG 图标库（`components/icons/index.js`），stroke=currentColor，离线可用 |
| 数据 | `api/contract.js` 定义契约 → `api/adapters/mockAdapter.js` 实现；预留 `idbAdapter` / `leancloudAdapter` |

## 3. 目录结构
```
src/
  main.js  App.vue
  router/index.js
  styles/{tokens.css,base.css}
  api/
    contract.js          # 实体类型 + Repository 接口契约（JSDoc）
    index.js             # 适配器装配：mock | idb | leancloud
    adapters/mockAdapter.js
    adapters/idbAdapter.js        # 预留
    adapters/leancloudAdapter.js  # 预留
    mock/seed.js         # Mock 种子数据
    sync/outbox.js       # 增量同步队列骨架
  stores/{ledger.js,category.js,bill.js,sync.js}
  composables/{useToast.js,useScrollLock.js}
  components/
    AppHeader.vue        # 通用导航栏（返回 / 标题 / 右侧插槽）
    TabBar.vue           # 底部标签栏 + 悬浮 +
    CategoryIcon.vue     # 圆形底图标（浅灰 / 浅绿 / 主题绿实底）
    CategoryGrid.vue     # 一级分类宫格（含角标、选中态、末位入口）
    SubCategoryPanel.vue # 二级分类展开面板
    BottomSheet.vue      # 底部弹层
    RecordPanel.vue      # 记账面板（备注 + 金额 + 标签 + 键盘）
    NumericKeypad.vue    # 数字键盘
    AmountText.vue       # 金额排版
    SearchOverlay.vue    # 搜索覆盖层
    ToastHost.vue
    ConfirmDialog.vue
    icons/{index.js,IconBase.vue}
  views/
    HomeView.vue             # 图 11
    BillsView.vue            # 图 12
    RecordView.vue           # 图 13 / 14
    StatsView.vue            # 占位（统计 Tab）
    MineView.vue             # 占位（我的 Tab）
    CategoryManageView.vue   # 图 18
    SubCategoryManageView.vue# 图 15
    CategoryEditView.vue     # 图 16 / 17
```

## 4. 路由表
| 路径 | 视图 | 说明 |
| --- | --- | --- |
| `/` | HomeView | 首页 |
| `/bills` | BillsView | 账单 |
| `/stats` | StatsView | 统计 |
| `/mine` | MineView | 我的 |
| `/record` | RecordView | 记账，`?id=` 编辑已有账单 |
| `/category` | CategoryManageView | 一级分类管理，`?type=expense|income` |
| `/category/:parentId/sub` | SubCategoryManageView | 二级分类管理 |
| `/category/edit` | CategoryEditView | `?scope=primary|secondary&parentId=&id=` |

## 5. 实施步骤
1. 建立 tokens（颜色 / 圆角 / 间距 / 阴影）与 base 样式 + 移动端容器（430px 居中）。
2. 图标库（约 60 个线性图标，按 10 个分组编排，供图标选择器使用）。
3. 数据层：契约 + Mock 种子数据 + mockAdapter（localStorage 持久化）+ 预留适配器。
4. Pinia stores：分类 CRUD（含二级）、账单 CRUD + 搜索 + 汇总、账本切换。
5. 通用组件：AppHeader / TabBar / CategoryIcon / CategoryGrid / BottomSheet / NumericKeypad / RecordPanel / SearchOverlay / Toast / Confirm。
6. 页面实现顺序：RecordView（记账，图 13/14）→ HomeView（图 11）→ BillsView（图 12）→ CategoryManageView（图 18）→ SubCategoryManageView（图 15）→ CategoryEditView（图 16/17）→ Stats/Mine 占位。
7. 自检：`npm run build` 通过；dev server 起服务；关键路径手测（创建/查看/搜索/修改支出，分类与二级分类增删改）。

## 6. 验收要点（对应需求）
- [x] 创建支出：分类选择 → 键盘输入金额 → 完成落库
- [x] 查看支出：首页今日账单 + 账单页按日分组
- [x] 搜索支出：备注 / 分类名 / 金额
- [x] 修改支出：点击账单条目进入编辑态，可改分类/金额/备注/日期，可删除
- [x] 一级分类：创建、展示（宫格）、更新（编辑/删除）
- [x] 二级分类：创建（归属一级）、展示（列表 + 记账页展开）、更新（编辑/删除）
- [x] 预留 IndexedDB 离线缓存与 LeanCloud 增量同步适配器与 outbox 队列
