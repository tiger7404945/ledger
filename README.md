# 随手记账 · 移动端 H5（第一阶段：前端复刻）

基于参考截图复刻的记账 App 前端，Vue 3 + Vite。当前阶段**只做前端 UI、Mock 数据与前端交互**，已按「本地优先 + 增量同步」的目标预留接口。

## 快速开始

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run build    # 产物输出到 dist/
```

## 页面清单（对应 8 张参考图）

| 路由 | 页面 | 对应截图 |
| --- | --- | --- |
| `/` | 首页（本月总览 / 今日账单 / 净资产） | 图 11 |
| `/bills` | 账单（流水 + 日历，按月切换） | 图 12 |
| `/record` | 记账（支出 / 收入 / 转账 / 借贷） | 图 13、14 |
| `/record?id=xxx` | 修改账单（带入原数据，可删除） | — |
| `/category` | 分类管理 · 一级 | 图 18 |
| `/category/:parentId/sub` | 分类管理 · 二级（底部弹层） | 图 15 |
| `/category/edit?scope=secondary&parentId=xxx` | 新建二级分类 | 图 17 |
| `/category/edit?id=xxx` | 修改分类 | 图 16 |
| `/stats` | 统计（当期概览 + 趋势折线 + 分类排行） | — |
| `/mine` | 我的（含数据层状态） | — |

## 已实现的能力

- **支出**：创建（选分类 → 键盘输入金额 → 完成 / 再记）、查看（首页今日账单、账单页按日分组、日历视图）、搜索（备注 / 分类名 / 金额）、修改与删除。
- **账单页视图切换**：`流水` / `日历` 既点顶部胶囊切换，也可在列表区左右滑动切换。
- **账单页账期筛选**：点顶部日期打开底部选择器，可「按月查看」（选月份）或「按年查看」（选年份，一屏 12 年）筛选流水与日历；`‹ ›` 按月翻月、按年翻年。按年时日历视图变为 12 个月的年度总览，点某月下钻到该月。账期由账单页与统计页**共用**（两页始终同一个「当期」），首页固定为「本月」视角。账单页与统计页的日期切换器是同一个组件 `components/PeriodSwitch.vue`（白色药丸 + 薄荷圆钮 + 可点日期 + 弹层），只维护一处样式。
- **统计页**：
  - 页头展示当期总体支出 / 收入 / 结余，右上角是同一套账期切换器（按月 / 按年）。
  - 折线趋势图：按月账期**一天一个点**、按年账期**一个月一个点**；在图上滑动或点按会把游标吸附到最近的点并显示该点日期与金额。未来日期不画。
  - 分类排行：按一级分类聚合，默认显示金额最大的 3 项，可「查看更多 / 收起」。
  - 趋势与排行分为**支出 / 收入两屏**，点胶囊或左右滑动切换；折线图区域独占横向手势，避免与切屏冲突。
- **记账页交互**：进入默认选中第一个一级分类；点击备注框会列出该分类下用过的备注（从新到旧、可横向滑动填入）；草稿只在「记账页 ↔ 分类管理」往返时保留，用返回键或左上角返回退出即作废。
- **一级分类**：新建、宫格展示（含「有二级分类」角标）、编辑、删除（级联）。
- **二级分类**：新建（归属一级分类）、在记账页展开选择、在管理页列表展示、编辑、删除。
- **分类图标选择器**：左侧分类分组 ↔ 右侧图标区双向联动滚动，内置 10 组约 100 个线性图标（纯本地 SVG，无外部依赖）。

## 目录结构

```
src/
  api/                    数据层（视图只依赖契约，不依赖实现）
    contract.js            实体类型 + Repository 接口契约 + 错误类型
    index.js               适配器装配（改 DATA_SOURCE 即可切换数据源）
    adapters/mockAdapter.js      本期实现：内存 + localStorage
    adapters/idbAdapter.js       预留：IndexedDB 离线缓存（含建库与索引定义）
    adapters/leancloudAdapter.js 已废弃（LeanCloud 停服），仅保留同步策略注释作参考
    sync/outbox.js         增量同步队列（本地写入即入队）
    mock/seed.js           Mock 种子数据
  stores/                  Pinia：ledger / category / bill
  composables/             可复用交互：useRecordDraft（记账草稿）、useSwipeViews（左右滑动切屏）
  components/              通用组件（含 icons 图标库、PeriodSwitch + PeriodPicker 账期切换器与弹层、TrendChart 趋势折线、RankList 分类排行）
  views/                   页面
  utils/                   日期 / 金额 / id 工具
  styles/                  tokens.css（设计变量）+ base.css
```

## 从 Mock 切到「IndexedDB + Supabase」的步骤

1. `src/api/adapters/idbAdapter.js`：补齐 objectStore 读写（`openDB()` 已写好建库与索引）。写入时在同一事务内写业务表 + `outbox` 表。
2. 新增 `src/api/adapters/supabaseAdapter.js`：实现 `initialize / push / pull / syncAll`，按 `outbox.pending()` 推送，以 `updated_at` 为水位拉取，冲突「新者胜」。
3. 修改 `src/api/index.js` 的 `DATA_SOURCE` 为 `'idb'`。
4. 视图层与 store 层无需改动 —— 所有调用都走同一套 Promise 契约。

> 详细的任务分解、前置准备与验收标准见 `phase2-backend-plan.md`。

## 第一阶段验收结论（v0.2.0）

已通过构建、数据层测试与浏览器端到端走查：

| 验收项 | 结果 |
| --- | --- |
| `npm run build` | 通过（98 modules，JS gzip 约 77 kB） |
| 数据层测试（区间 / 汇总 / 种子 / 迁移） | 47 条断言全绿 |
| 创建支出 → 首页与账单页出现 | 通过（金额 12.50、分类正确、草稿自动清空） |
| 搜索 | 通过（命中 1 条 · 支出 ¥12.50） |
| 修改 | 通过（12.50 → 88.88，条数不变、`updatedAt` 已更新） |
| 删除 | 通过（软删除 `deleted=1`，返回账单页） |
| 账单页流水 / 日历、按月 / 按年选择器 | 通过（年网格 12 格，未来年份置灰） |
| 统计页双视图 + 趋势折线 + 排行展开 | 通过 |
| 一级 / 二级分类管理与编辑 | 通过 |
| 浏览器运行时未捕获异常 | 无，console 全程干净 |

> 走查过程中新建的测试账单已删除，本地库已重置回种子数据。

## 关于后端选型的重要变更

第一阶段的 `leancloudAdapter.js` 是为 **LeanCloud** 预留的，但 LeanCloud 已发布停服公告：

- **2026-01-12** 起：停止新用户注册、停止创建新应用；
- **2027-01-12** 起：关闭全部对外服务（应用访问、数据读写、API、控制台），平台数据将被销毁。

该选型因此作废。**第二阶段云端同步改用 Supabase**（PostgreSQL + 自动 REST API + 行级安全策略，开源可自托管，避免再次被单一厂商绑定）。`leancloudAdapter.js` 只在注释里保留其同步策略作为设计参考，不会再被实现。


## 说明

- 设计变量集中在 `src/styles/tokens.css`，改主题色只需动 `--brand*`。
- 数据默认持久化在 `localStorage`（键 `ledger.db.v1`）；「我的 → 重置演示数据」可恢复初始 Mock。
- 参考截图见仓库根目录 `微信图片_*.jpg`、`填写备注.jpg`、`月选择器.jpg`、`年选择器.jpg`，页面结构说明见 `page-structure.md`，第一阶段实施计划见 `ui-implementation-plan.md`，**第二阶段（接后端与云同步）任务清单见 `phase2-backend-plan.md`**。
