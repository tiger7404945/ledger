# 随手记账 · 移动端 H5

基于参考截图复刻的记账 App，Vue 3 + Vite。

- **第一阶段（已完成，v0.2.0）**：前端 UI 与交互复刻，全部页面跑通。
- **第二阶段（进行中）**：数据从「只在这台浏览器」变成「本地优先 + 云端同步」。
  **S1 已完成** —— 本地存储已从 localStorage 切到 IndexedDB，用户无感。
  **S2 已完成** —— 同步引擎骨架落地：四态状态机、pull/push 收敛、拒收回拉、服务端单调水位线；
  云端用内存假实现（`fakeCloud.js`）跑通全链路，真实云端留给 S3。
  设计说明见 `phase2-backend-plan.md` 的 S2 小节。

## 快速开始

```bash
npm install
npm run dev       # http://127.0.0.1:5173
npm run build     # 产物输出到 dist/
npm run test:data # 数据层断言（契约一致性 + 区间/汇总 + 种子 + 迁移 + 同步引擎）
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
    core/query.js          查询与派生（纯函数，无 IO）—— 各适配器共用
    core/migrate.js        演示数据的幂等迁移 —— 各适配器共用
    core/idb.js            IndexedDB 库名/版本/objectStore 原语（破解 adapter ↔ outbox 循环依赖）
    core/merge.js          远端文档合并规则（剥元数据 / 新者胜 / 分流 take|keep）
    adapters/mockAdapter.js      内存 + localStorage（对照基准，保留）
    adapters/idbAdapter.js       当前启用：IndexedDB 离线缓存
    adapters/leancloudAdapter.js 已废弃（LeanCloud 停服），仅保留同步策略注释作参考
    sync/outbox.js         增量同步队列（本地写入即入队，变更通知订阅者）
    sync/outboxStore.js    队列的存储后端（IndexedDB 表 / 内存）+ 旧 localStorage 队列一次性搬迁
    sync/cloudClient.js    云端客户端接口约定（只有形状，无实现）
    sync/fakeCloud.js      内存假云端（真云端同接口，S3 换实现即可）
    sync/syncEngine.js     同步调度：四态状态机 + pull/push + 退避重试 + 水位线
    mock/seed.js           种子数据
  stores/                  Pinia：ledger / category / bill
  composables/             可复用交互：useRecordDraft（记账草稿）、useSwipeViews（左右滑动切屏）
  components/              通用组件（含 icons 图标库、PeriodSwitch + PeriodPicker 账期切换器与弹层、TrendChart 趋势折线、RankList 分类排行）
  views/                   页面
  utils/                   日期 / 金额 / id 工具
  styles/                  tokens.css（设计变量）+ base.css
```

## 数据层现状

调用链：视图 → Pinia store → `api/index.js` 导出的 repository → 适配器。换实现只动一个装配点，视图与 store 零改动。

| 适配器 | 状态 |
| --- | --- |
| `mockAdapter.js` | 第一阶段实现（内存 + localStorage）。保留作契约对照基准 |
| `idbAdapter.js` | **当前启用**：IndexedDB，库名 `ledger`、版本 2、5 个 objectStore |
| `leancloudAdapter.js` | 已废弃（LeanCloud 停服），仅留同步策略注释作参考 |
| `cloudbaseAdapter.js` | 待实现（第二阶段 S3，腾讯云开发） |

业务规则（过滤 / 排序 / 聚合 / 派生字段 / 种子迁移）统一放在 `api/core/`，由各适配器共用 —— 避免「两个适配器各写一套、慢慢漂开」。

### 已切到 IndexedDB（S1）

- 首次打开会**接管**第一阶段留在 localStorage 的 `ledger.db.v1`，且**不删除旧库**（可回退）；只接管一次，靠 meta 标记判断。
- 写入落在 IndexedDB（库 `ledger`，版本 2，5 个 objectStore：`ledger / category / bill / outbox / meta`）。
- 切换数据源：改 `src/api/index.js` 的 `DATA_SOURCE`（`'mock' | 'idb'`）。

### 同步引擎骨架（S2）

代码在 `src/api/sync/`，装配在 `src/api/index.js`（`createSyncEngine` 注入 `db.outbox` / `db.syncStore` / `db.kv` / `cloud`），`src/main.js` 里 `syncEngine.start()`。

- **状态机四态**：`idle / syncing / error / offline`。离线时不发请求（省流量、也不污染重试计数），联网后由 `online` 事件自动补推。
- **单次同步的顺序固定为 pull → push → 回拉被拒 → compact**。反序会用本地旧版本盖掉云端较新版本。
- **防重入**：`syncing` 期间再调 `sync()` 返回**同一个 in-flight Promise**（而不是直接 `return`），四种触发源都收敛到此。触发源：启动、`online`、写后 debounce（2s）、手动。
- **水位线只认服务端接收时间**（`_serverTs`），且服务端时间**严格单调**，区间为 `(since, snapshotAt]` 左开右闭 —— 否则同一毫秒的写入会被永久漏掉。
- **推送被拒必须回拉**：云端仅当本地不旧于云端才覆盖，被拒条目进 `rejected`，引擎据此把云端版本拉回本地并**作废对应队列条目**；否则本地以为推成功，两端静默分叉。
- 队列已从 localStorage 迁到 IndexedDB 的 `outbox` 表；旧的 `ledger.outbox.v1` 键**保留不删**，搬迁靠 meta 的 `outboxImported` 标记幂等（旧键里可能残留 S1 留下的空数组 `[]`，属正常）。
- 适配器**不 import syncEngine**，靠 `outbox.onChange` 通知解耦，依赖方向保持 `适配器 → outbox ← syncEngine`。
- **已知不修**：本地「新者胜」依赖客户端时钟，跨设备乱序写入时可能判错；S4 用服务端时间裁决。

### 接腾讯云开发的步骤（第二阶段 S3）

1. 按 `phase2-backend-plan.md` 第 3 节完成账号与环境准备，**配好安全规则**（不配等于数据库公开）。
2. 新增 `src/api/adapters/cloudbaseAdapter.js`，实现 `cloudClient.js` 约定的三件事：
   - `pull(collection, { since, cursor, limit, ids }) -> { docs, serverTime, hasMore, cursor }` —— 必须返回**服务端时间**作为水位，不能拿客户端 `updatedAt` 顶替；
   - `push(collection, docs) -> { upserted, rejected }` —— 条件 upsert，被拒条目要带上 `cloudUpdatedAt`；
   - `serverTime()`。
3. 在 `src/api/index.js` 把 `export const cloud = null` 换成该实现的实例。**syncEngine、适配器、store、视图都不需要改**。
4. 验收重点：S3 的安全规则是**真**权限（fakeCloud 只测「代码没抹掉身份」，测不了规则本身），要用两个真实账号交叉验证。

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

## 关于后端选型的两次变更

1. **曾按 LeanCloud 预留 → 作废**。第一阶段为 LeanCloud 写了适配器骨架，但它已发布停服公告：**2026-01-12** 起停止新用户注册与创建应用，**2027-01-12** 起关闭全部对外服务（应用访问、数据读写、API、控制台），平台数据将被销毁。注册通道现已关闭。
2. **一度改用 Supabase → 因国内访问不稳定放弃**。方案本身没问题（Postgres + RLS + 开源可自托管），但其官方域名在国内直连不稳，真机测试常需自备域名与代理。
3. **终选腾讯云开发 CloudBase**：国内访问快、合规、有免费额度，且前端静态托管与后端同平台，省掉跨域与域名配置。**注意：免费环境每个账号限 1 个，单次续期 6 个月、不支持自动续费，过期会停用。**

`leancloudAdapter.js` 只在注释里保留其同步策略（本地为主 + outbox 推送 + 水位拉取 + 新者胜）作设计参考，不会再被实现。

> 两次换厂商都只动了适配器层，**视图与 store 一行未改** —— 这正是「契约 + 适配器」分层的价值。

## 第二阶段 S1 验收结论（本地 IndexedDB）

| 验收项 | 结果 |
| --- | --- |
| `npm run build` | 通过（100 modules，JS gzip 约 78.5 kB） |
| 契约一致性测试（mock vs idb） | **83 条断言全绿**（S2 补了 outbox / syncStore 断言，现为 87 条） |
| 既有数据层断言 | 无回归（22 + 14 + 11） |
| 两适配器只读结果一致 | 通过（列表派生字段 / 区间汇总 / 日历分组 / 备注候选 / 关键字搜索） |
| 两适配器写入结果一致 | 通过（10 个错误码 / 分类 CRUD / 级联软删除 / 改分类后一级联动 / 软删除标记） |
| 旧库接管 | 通过（连时间戳逐字段一致；旧库保留未删，可回退） |
| 写入确实落 IndexedDB | 通过（bill 44 → 45，同时 localStorage 旧库仍为 44） |
| 刷新后数据保留 / 重置演示数据 | 通过 |
| 浏览器运行时未捕获异常 | 无 |


## 第二阶段 S2 验收结论（同步引擎骨架）

| 验收项 | 结果 |
| --- | --- |
| `npm run build` | 通过（104 modules，JS 229.30 kB / gzip 81.40 kB） |
| 数据层断言合计 | **259 条全绿**（契约 87 + 区间 22 + 种子 14 + 迁移 11 + 同步 125） |
| 服务端单调水位线 | 通过（同毫秒连续写入不漏、`(since, snapshotAt]` 左开右闭） |
| 双设备同改一条 → 收敛 | 通过（不裂成两条，且不无限重推） |
| 陈旧推送被拒 → 回拉 | 通过（云端版本拉回本地，被拒条目就地作废） |
| 离线补推 / 退避重试 | 通过（延迟断言为 2 → 4 → 8 → 16 → 32 秒，超 5 次不再自动重试） |
| 防重入 | 通过（并发调用拿到同一个 in-flight Promise） |
| 分页拉取 | 通过（250 条 / 3 页一次同步拉完） |
| 多用户隔离（fakeCloud 身份维度） | 通过（A 的数据不会出现在 B 名下） |
| 未配置云端时降级 | 通过（`sync()` 返回 `{ ok:false, skipped:true, reason:'no-cloud' }`，不报错） |
| 队列搬迁幂等 | 通过（旧 localStorage 队列只导入一次，重复 `prepare()` 不翻倍） |
| 端到端（真实 idbAdapter + fake-indexeddb） | 通过（写入 → 入队 → 同步 → 落本地，且落地的文档不带 `_` 前缀云端元数据） |
| 浏览器端到端 | 通过（写入一笔账后「我的」页待同步队列 0 → 1 条，重置后回 0；无未捕获异常） |

> 走查过程中新建的测试账单已删除，本地库已重置回种子数据（44 条）。
> **说明**：fakeCloud 带身份维度只能验「代码没抹掉身份」，**测不了真实安全规则** —— 那是 S3 用两个真实账号验收的事。


## 说明

- 设计变量集中在 `src/styles/tokens.css`，改主题色只需动 `--brand*`。
- 数据当前持久化在 **IndexedDB**（库名 `ledger`，版本 2）；首次打开会自动接管第一阶段留在 localStorage 的旧库。「我的 → 重置演示数据」可恢复初始种子。
- 云端目前是 `fakeCloud.js`（内存），所以「我的」页显示**未接入**；接 S3 时只需在 `src/api/index.js` 换掉 `cloud` 一个变量。
- **数据层断言**（`scripts/`，纳入版本管理）：`npm run test:data`
  - `contract-test.mjs` —— 契约一致性（mock 与 idb 双跑，87 条断言）
  - `period-test.mjs`（22 条）/ `seed-test.mjs`（14 条）/ `migrate-test.mjs`（11 条）
  - `sync-test.mjs` —— 同步引擎 18 组场景（125 条断言），用测试时钟 + 注入定时器让退避延迟可断言、不必真等
  - IndexedDB 在 Node 里用 `fake-indexeddb` 打桩（devDependency）。
- 参考截图见仓库根目录 `微信图片_*.jpg`、`填写备注.jpg`、`月选择器.jpg`、`年选择器.jpg`，页面结构说明见 `page-structure.md`，第一阶段实施计划见 `ui-implementation-plan.md`，**第二阶段（接后端与云同步）任务清单见 `phase2-backend-plan.md`**。
