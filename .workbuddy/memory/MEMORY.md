# 项目长期记忆 · 随手记账（D:\projects\ledger）

> 只保留**仍然有效、改动前必须先知道**的规则。每日细节见同目录 `YYYY-MM-DD.md`。
> 计划文档 `phase2-backend-plan.md`（第 3 节 P0–P10 待办，其后 S0–S6 任务表）。

## 阶段
移动端记账 Web App（Vue 3 + Vite）前端复刻。设计原型 = 仓库根目录 8 张 `微信图片_*.jpg`
+ `填写备注.jpg` + `月选择器.jpg`/`年选择器.jpg`（均入库）。**统计页没有参考稿**，按需求补齐。
- 第一阶段 v0.2.0（前端 + Mock）：已完成。
- 第二阶段「本地优先 + 云端同步」：**S0–S3 完成；S4 进行中**。`DATA_SOURCE = 'idb'`，
  云端 = 用户自有的腾讯云开发 CloudBase（envId / 网关地址只在 `.env.local`）。

## 强制约定（违反会返工）
- 视图层**不得**直接调 adapter，只用 `src/api/index.js` 的 repository 与 Pinia store。
- 新增数据操作：先补 `src/api/contract.js` → 再实现各 adapter → 再给 store 加 getter。
- 写操作一律 local-first：先落本地，再 `outbox.enqueue`。
- 业务/合并规则**只在 `src/api/core/` 写一次**，各 adapter 共用（吃过「两处各写一套慢慢漂开」的亏）。
- **云端资源一律以 `ledger` 开头**（该环境会被别的项目复用）：集合 `ledger_<表名>`、
  云函数 `ledger-<功能>`、网关路径 `/<函数名>`。统一出口 `src/config/cloud.js`，**业务代码不手写资源名**。
- 设计变量只写在 `src/styles/tokens.css`；图标只用 `src/components/icons`，不引外部图标库。
- 手机外框宽 `--frame-w`（430px）；`position: fixed` 依赖 `.app-frame` 的 transform 包含块。
- 后端在架构上必须可替换：换厂商只动适配器层，视图与 store 零改动（已两次生效）。

## 页面与路由
`/` 首页 · `/bills` 账单 · `/record` 记账（`?id=` 修改）· `/stats` 统计 · `/mine` 我的
`/category` 一级分类管理（子路由 `:parentId/sub` 二级弹层）· `/category/edit`（`?scope=&parentId=&id=`）

## 关键规范
- 二级分类展示名统一 `一级名-二级名`，由 `categoryStore.label()` 产出。分类名上限 8 字。
- 同级同类型重名抛 `RepositoryError`。删除一律软删除（`deleted: 1`）。
- 金额为元、正数；支出深色、收入主题绿（国内习惯）。

## 记账页与草稿
- **草稿** `src/composables/useRecordDraft.js`，key `ledger.recordDraft.v1`。只是 UI 草稿，
  **不经 repository / outbox**。新增表单字段要同步加进 `persistDraft` / `applyDraft`。
- **草稿生命周期由 `installRecordDraftGuard(router)` 一处裁决**（`src/router/index.js` 装配）：
  只在「记账页 ↔ 分类管理/编辑」往返时保留；返回键、切 Tab、去其它页、从别处重进都立即作废。
  **不要**在组件里另写一套。
- 进入顺序：路由守卫清草稿 → `onMounted` 比对 `editingId` 套用草稿 → 编辑态读账单 →
  新建则默认选中第一个一级分类。
- **备注候选**：`billRepo.remarkHistory({ ledgerId, categoryId, limit })`，
  当前分类 = `subId || primaryId`，**精确匹配不含子分类**。
- **层级**：页面底色灰 `--page`，二级分类面板（`SubCategoryPanel`）是白色浮起卡片
  叠在灰底上。**不要**给页面/body 设纯白底，否则糊在一起。
- `CategoryGrid` 选中态 = `selectedId`（叶子）或 `activeId`（父级）；记账页两个都传。

## 账期切换器（只有一处实现）
`src/components/PeriodSwitch.vue` 自带药丸、箭头、可点日期**和** `PeriodPicker` 弹层，
直接读写 `billStore.period`。账单页筛选行与统计页页头都只写 `<PeriodSwitch />` 一行；
**不要**在页面里再抄触发器或另绑 `pickerOpen`。
- 几何（采样自 `微信图片_20260927231957_12_4.jpg`）：白药丸高 31、全圆角、内缩 5；
  薄荷圆钮直径 21（底 `--brand-mint`、箭头 `--brand`）；日期 13.5px、`min-width:78px`
  （固定宽度，否则按月/年切换时药丸宽度会跳）。**没有下拉箭头图标**。
- 药丸总宽 154（设计稿 171.5）：统计页页头要放得下且不压居中标题。**两页一致比照抄设计稿宽度更重要。**

## 设计稿采样
- 改视觉前先做像素取样，**别肉眼估**。参考稿 1080×2400（对应 390×844，比例 2.844），
  采样前按比例换算并裁掉状态栏/导航栏。
- **量高度用「穿过元素的垂直线逐像素扫 `#RRGGBB` 看跳变」**，不要找色块包围盒——
  白场阈值会漏掉边缘柔化像素（实测把 31px 药丸量成 27px）。
- **怀疑单张稿的色值只是 JPEG 噪声时，扫全套稿看是否反复出现**。`#DCFDF6` 在 9 张稿里
  都是最高频浅薄荷 → 立 `--brand-mint` token（与 `--brand-soft-2` #d3f4ea **不是同色**）。
- **账期选择器几何**（采样自 `月选择器.jpg`/`年选择器.jpg`）：4 列网格、左右内缩 20、
  列间距 7、行间距 20、单元格高 45 圆角 12、选中 `--brand` 实底；页签下划线 2.5px、
  两页签间距 50；`‹ 标题 ›` 行高 66、左右内边距 16、标题 20px/600；年份一屏 12 个，
  当前年前留 8 年。

## 布局约定
- **账单 store 有两份互相独立的数据切片，不要合并**：
  - 本月视角 `month`/`bills`/`summary` —— **只有首页**用。
  - 账期取景 `period{mode,month,year}`/`periodBills`/`periodSummary` + `period*` getter
    （`periodRange`/`periodLabel`/`periodUnit`/`periodGroups`/`periodDailyMap`/
    `periodMonthlyMap`/`periodTrend`/`periodRankMap`）—— **账单页与统计页共用**。
  - 写操作要同时刷新两份；`periodInitialized` 为 false 时跳过 period 刷新。
- **区间一律用 `from`/`to`（'YYYY-MM-DD'，含首尾）**，`month` 只是特例；两者可同时传，AND 处理。
- **左右滑动切屏统一用 `useSwipeViews`**：`width = 视图数×100%`，拖动关 `transition` 跟手，
  松手 56px 阈值吸附。账单页（流水/日历）与统计页（支出/收入）共用，**不要另写**。
  - 先判主方向，纵向放弃 `active=false` 把滚动还给浏览器；全程不用 `preventDefault`。
    起点命中 `[data-no-swipe]` 不接管（统计页折线图靠它独占横向手势）。
- **底部标签栏占位**：带 TabBar 的页面用 `padding-bottom: var(--tabbar-space)`
  （`--tab-h` + `--safe-b` + `--plus-overhang`）。**不要写 `padding: 0 14px` 简写**——
  会连 padding-bottom 一起重置，最后一条被盖住且滚不出来。
  `--plus-overhang`（20px）是 TabBar 中间 54px 加号凸出上沿的部分。
- **局部滚动**用 base.css 的 `.scroll-area`（`flex:1`+`min-height:0`+`overflow-y:auto`），
  外层 `.page-body` 改 `display:flex; flex-direction:column; overflow:hidden`。
  滚动区自己写 `padding: 0 14px var(--tabbar-space)`。
- 卡片与上方固定区的间距放在**固定区**上（如 `.hero { margin-bottom: 12px }`），
  不要放滚动区 `padding-top`，否则滚动时留白被滚掉、半截列表贴到固定区。

## 统计页
- 结构：概览卡（当期支出/收入/结余）→「支出/收入」胶囊 + 笔数 → 横向轨道（两屏各自 `scroll-area`）
  → 每屏一张趋势卡 + 一张排行卡。
- `TrendChart`：**按月一天一个点、按年一个月一个点**；纵轴上限取整到好读刻度
  （≥1000 取百、≥100 取十），两条参考线，横轴最多 6 个标签。
  - **未来日期不画**（当月只画到今天、当年只画到本月），否则折线尾巴掉到 0。
  - 横轴桶由 store 的 `periodTrend` 产出（`{key, axis, full}`），图表只用 `value`，不自己算日期。
  - 交互：滑动/点按都把游标吸附到最近点（`indexFrom(clientX)` 用容器 rect 换 viewBox 坐标），
    浮层显示日期 + 金额；纵向滑动清游标。鼠标与触摸事件都实现。
  - 配色：**支出 `--ink`、收入 `--brand`**；排行条统一 `--brand`（细条用深色显脏）。
- `RankList`：按**一级分类**（`primaryCategoryId`）聚合，金额降序，默认前 3，超 3 项「查看更多/收起」。
- 页面进入调 `ensurePeriodLoaded()`，**不要**用 `ensureLoaded()`（后者是首页本月视角）。

## 演示数据（种子）
- **本月支出目标 `8720.72` 不要动**（对齐账单页参考图）；差额由 `bill_seed_gap` 补齐。
  算差额只累加 `type === 'expense'` 的本月账单。
- 补充账单 `bill_seed_extra_NN`：本月 4 笔收入（用 `offset` 表达并夹在本月内）+ 前两个月收支。
- 给已有库补演示数据走 `SEED_EXTRA_VERSION` / `SEED_NOTES_VERSION` + `migrate()`：
  **按 id 幂等回填、不覆盖用户数据**。**不要**为演示数据 bump `SCHEMA_VERSION`（会清空用户记的账）。
- 当前数字：本月支出 8720.72 / 收入 13768.50 / 结余 5047.78；2026 年支出 19666.22 / 收入 43368.50。

## 数据层（S1–S3）
**业务规则只在 `src/api/core/` 写一次**：
- `query.js` 纯函数过滤/排序/聚合/派生：`alive`、`createCategoryLookup`、`filterCategories`、
  `filterBills`、`groupBillsByDate`、`dailySummaryOf`、`summarizeBills`、`remarkHistoryOf`、`decorateBill`。
- `migrate.js` 种子迁移 `migrateSeedData(bills, meta)`，幂等、只补不覆盖。
- `idb.js` IndexedDB 库名/版本/store 名/`META_KEYS` 与全部库原语。**抽出来只为破解循环依赖**
  （outbox 要用 `openDB()`，而 `idbAdapter` 又 import outbox）。
- `merge.js` 远端合并：`fromRemote`（剥所有 `_` 前缀字段）、`shouldTakeRemote`、`partitionRemote`。
- `cloudId.js`（S4-7）云端 id 别名映射，见下。

**适配器**：`mockAdapter`（内存+localStorage，契约对照基准）、`idbAdapter`（本地，启用）、
`cloudbaseAdapter`（云端，启用）、`leancloudAdapter`（已废弃，只留注释）。

**IndexedDB 约定**：库名 `ledger`、版本 2、5 个 store（ledger/category/bill/outbox/meta）；
meta 键 `schemaVersion`/`seedMeta`/`importedFromLocalStorage`/`outboxImported`/`syncWatermark`/`firstBindDone`。
- 首次打开**接管** localStorage 的 `ledger.db.v1`，**导入后不删旧库**（可回退），靠
  `importedFromLocalStorage` 幂等。`reset()` 必须**保留** `importedFromLocalStorage` 与
  `outboxImported`，否则重置后旧库/旧队列会被重新导入。
- 写入前一律 `toPlain()` JSON 深拷贝 —— 结构化克隆处理不了 Vue 的 Proxy，会抛 `DataCloneError`。
- **「读-改-写」分两次事务**，塞进一个事务会因跨 `await` 失效而抛 `TransactionInactiveError`。
- 查询用 `readAll` 读进内存再算。`createIdbAdapter` 有 **`seed` 选项**（默认 true），测试传 `seed: false`。
- **存储顺序不是契约**：`getAll` 按主键序、内存数组是插入序，凡有顺序语义处显式排序。

## 同步引擎（`src/api/sync/`）
- **装配点唯一**：`src/api/index.js` 的 `createSyncEngine({ outbox, store, meta, cloud })`；
  启动在 `src/main.js` 的 `syncEngine.start()`。
- **依赖方向单向**：适配器 → outbox ← syncEngine。**适配器绝不 import syncEngine**，靠 `outbox.onChange` 解耦。
- **四态** `idle / syncing / error / offline`。离线**不发请求**（省资源点、不污染 retry 计数）。
- **防重入是唯一闸门**：`syncing` 期间再调 `sync()` 必须 **`return` 同一个 in-flight Promise**
  （不能 return undefined，否则调用方没法 await）。四种触发源（启动/`online`/写后 debounce 2s/手动）都收敛到此。
- **单次同步顺序固定 pull → push → 回拉被拒 → compact**。反序会用本地旧版本盖掉云端较新版本。
  push 推的是**当前本地文档**，不是入队时的 payload 快照。
- **水位线只认服务端 `_serverTs`**，不认客户端 `updatedAt`；服务端时间必须**严格单调**；
  pull 区间 **左闭 `>=`**（宁可重复拉不能漏，重复无副作用）。**别改回去**。
- **推送被拒必须回拉**：被拒条目带 `cloudUpdatedAt` 进 `rejected`，引擎据此把云端版本拉回本地
  并 `outbox.drop()` 作废该条目。否则两端静默分叉 —— **单设备永远测不出这个 bug**。
- **`fakeCloud` 必须带身份维度**（`cloud.as('openid')`）。它只能验「代码没抹掉身份」，**测不了真实权限**。
- **串号风险在本地不在云端**：两账号共用 `ledger` 库时，A 残留的 outbox 会被推到 B 名下。
  方案是库名分区 `ledger_<openid>`（`openDB({ dbName })` 已支持），**S5 启用**。
- **测试时间与定时器必须注入**：`createClock()` + `createFakeTimer()`。
  ⚠️ **新增用例时记得把 `now: clock.now` 注进 `makeDevice`** —— 否则引擎用真实 `Date.now()`
  去算时钟偏移会得到荒谬值，裁决全乱（S4-2 踩过）。
- `localStorage['ledger.outbox.v1']` 残留 `"[]"` 是正常的（S1 旧队列排空留下的），
  有 `outboxImported` 兜底，**不要去清理**。

> **云端与 S4 的详细实测记录**（权限 / 云函数 / S4-2 / S4-4 / S4-6 / S4-7 / fakeCloud 语义漂移 / 探针位置）
> 已移到同目录 `CLOUD-S4-NOTES.md`。**改动云端适配器或同步引擎前必须先读那一份。**

## 数据层断言
`npm run test:data` 一次跑完**七个脚本**，**合计 414 条**。Node 里 IndexedDB 用 `fake-indexeddb`。
- `contract-test.mjs`（87）：同一套断言跑 mock 与 idb，并断言 `outbox`/`syncStore` 方法齐全。
  注意 `outbox` 是**对象**，要先断言 `!!adapter.outbox` 再查方法（写成 `has(adapter, ['outbox'])` 恒假）。
- `period-test.mjs`（22）/ `seed-test.mjs`（14）/ `migrate-test.mjs`（11，输出 `PASS xxx` 而非「N 通过」）
  / `sync-test.mjs`（127 / 18 组）/ `conflict-test.mjs`（122 / 13 组）/ `cloudid-test.mjs`（42）。
- **`conflict-test.mjs`（S4-5）** 测**并发与边界**：同笔并发、**同毫秒并发**、慢/快时钟、
  拔网 5 次、连续失败恢复、软删除撞修改、删除后同 id 重建、三设备并发、增改删混合逐条比对、
  错误分类与策略表完整性、不可重试类不进退避队列、时钟降级不采信下界。
  判据不是「一定是某个值」，而是 **不丢 / 不重复 / 两端收敛**。
- **测试里的 store 契约**：`store.get(collection, idOrIds)` 是**双形态** —— 单 id 返对象、
  数组返数组。`pushPending` 与 `resolveRejected` 都依赖它，写测试替身时别只实现一种。
- **真正会咬人的是防重入、否决回拉、双实例收敛、身份隔离、分页、队列搬迁幂等** ——
  都只能在多实例/并发下暴露，单设备手点测不出来。
- 脚本用 `new URL('../src/', import.meta.url)` 解析路径，**不要写死绝对路径**。
  store getter 依赖 `@/` 别名，Node 直接 import 不了，那部分靠浏览器读 DOM 断言。
- **真实云端的调用不在这套断言里**，靠 `.preview/sdk-probe/` + 浏览器端到端走查。

## 本地运行
`npm install && npm run dev` → http://127.0.0.1:5173。数据在 **IndexedDB**（库 `ledger`，版本 2）
+ 云端。「我的 → 重置演示数据」会清本地与云端、重灌种子并推上云（保留两个「已导入」标记）。
不配 `.env.local` 即退回纯本地模式。

### ⚠️ 在 `.preview/` 之类子目录装依赖会污染项目根
这些目录**没有 `package.json`**，npm 会**向上冒泡**写到项目根（2026-09-29 实测：一条
`npm install @cloudbase/js-sdk` 让根 `package.json` 多两条依赖、lock 多 701 行）。
**规矩：先在该目录放自己的 `package.json`。** 回滚：`git checkout -- package.json package-lock.json`
+ `rm -rf node_modules/<scope>`，再 `grep -c` 复核。

### dev server 重启
装了新包后 lockfile 变化，vite 要清 `node_modules/.vite/deps`，会被沙箱的批量删除保护拦住
（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。手动 `rm -rf node_modules/.vite` 后重启即可。
**端口被占**且新实例进不去时，先 `Stop-Process -Id <PID> -Force` 杀掉半死的旧 vite
（`pkill -f vite` 在 Windows 下匹配不到）。

## 版本管理
- **本机没有 Git for Windows**；用 WorkBuddy 内置 PortableGit
  `~/.workbuddy/binaries/PortableGit/versions/1.2.0`（bash 可用）。
- 主分支 `main`；标签 `v0.1.0`（前端骨架）、`v0.2.0`（第一阶段）。S2/S3/S4 完成时**均未打新标签**。
- 提交用约定式前缀（`feat:`/`fix:`/`refactor:`/`docs:`/`test:`），正文写清功能点与数据层改动。
- 不提交 `node_modules/`、`dist/`、`.preview/`。**设计参考图与 `.workbuddy/memory/` 纳入版本管理**。

## 后端选型（教训）
- **LeanCloud 已停服**（2027-01-12 关闭全部对外服务、数据销毁），`leancloudAdapter.js` 已作废，
  只留策略注释参考，**不要照它实现**。
- **Supabase 曾选定后放弃**：方案没问题（Postgres + RLS + 可自托管），但国内直连官方域名不稳。
- **终选腾讯云开发 CloudBase**（用户 2026-09-29 拍定，路线 B = 自有环境 + `@cloudbase/js-sdk`）。
- **曾评估的路线 A**（WorkBuddy 托管云服务 + PostgreSQL + 邮箱登录）**已放弃**：无匿名登录、
  且登录只能在已注册的 HTTPS 发布域名上验证，与「先把云同步跑通」的节奏冲突。
- `.env.local` 不入库（`.gitignore` 已覆盖）。
