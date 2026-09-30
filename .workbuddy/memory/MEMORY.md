# 项目长期记忆 · 随手记账（D:\projects\ledger）

> 本文件是**精炼后的长期约定**，只保留仍然有效、改动前必须先知道的规则。
> 每日细节见同目录 `YYYY-MM-DD.md`（按日追加，不覆盖）。

## 项目性质与阶段
移动端记账 Web App（Vue 3 + Vite）的前端复刻。设计原型是仓库根目录的设计稿：8 张 `微信图片_*.jpg` + `填写备注.jpg`（备注候选条）+ `月选择器.jpg` / `年选择器.jpg`（账期弹层），均纳入版本管理。**统计页没有参考稿**，按需求补齐。
- 第一阶段（v0.2.0）：前端 + Mock 数据，已完成。
- 第二阶段「本地优先 + 云端同步」：**S0 / S1 / S2 / S3 均已完成**。当前 `DATA_SOURCE = 'idb'`，云端为**用户自有的腾讯云开发 CloudBase 环境**（环境 ID 只在 `.env.local`，不入库）。
- 下一步：S4（冲突与边界，含用云函数取真服务端时间）、S5（匿名转正式账号 + 本地库按用户分区）。计划文档 `phase2-backend-plan.md`。

## 强制约定（违反会返工）
- 视图层**不得**直接调 adapter，只用 `src/api/index.js` 导出的 repository 与 Pinia store。
- 新增数据操作：先补 `src/api/contract.js` 契约 → 再实现到各 adapter → 再给 store 加 getter。
- 写操作一律 local-first：先落本地，再 `outbox.enqueue`。
- 业务规则 / 合并规则**只在 `src/api/core/` 与各 adapter 的公共处写一次**。本项目吃过「两处各写一套慢慢漂开」的亏（`PeriodSwitch` 那次），**新增适配器必须复用 core**。
- 设计变量只写在 `src/styles/tokens.css`，组件内不硬编码品牌色。图标只用 `src/components/icons`，不引外部图标库。
- 手机外框宽 `--frame-w`（430px）；`position: fixed` 元素依赖 `.app-frame` 的 transform 包含块。
- 后端选型必须在架构上可替换：换厂商/换云端只动适配器层，视图与 store 零改动。**继续维持这个纪律**（已两次生效）。

## 记账页与草稿
- **草稿**：`src/composables/useRecordDraft.js`，localStorage key `ledger.recordDraft.v1`。它只是 UI 草稿，**不经 repository / outbox**，不是业务数据。新增表单字段要同步加进 `persistDraft` / `applyDraft`。
- **草稿生命周期由 `installRecordDraftGuard(router)` 一处裁决**（在 `src/router/index.js` 装配）：只在「记账页 ↔ 分类管理/分类编辑」往返时保留；返回键、切 Tab、去其它页、从别处重进记账页，都立即作废。**不要**在组件里另写一套。
- 进入顺序：路由守卫清草稿 → `onMounted` 比对 `editingId` 套用草稿 → 编辑态读账单 → 新建则默认选中第一个一级分类。
- **备注候选**：`billRepo.remarkHistory({ ledgerId, categoryId, limit })`，当前分类 = `subId || primaryId`，**精确匹配不含子分类**（选「交通」拿不到「交通-停车费」）。
- **层级**：页面底色用灰 `--page`，二级分类面板（`SubCategoryPanel`）是白色浮起卡片（`--surface-raised` + `--r-md` + `--shadow-card` + 左右 24px 内缩）叠在灰底上。**不要**给页面/body 设纯白底，否则面板与背景糊在一起。
- `CategoryGrid` 选中态 = `selectedId`（叶子）或 `activeId`（父级一级）；记账页两个都传，选二级时父级也点亮。

## 设计稿采样
- 改视觉前先对参考稿做像素取样，**别肉眼估**。参考稿 1080×2400（对应 390×844 视口，比例 2.844），采样前要按比例换算并裁掉状态栏/导航栏。
- **量高度用「穿过元素的垂直线逐像素扫 `#RRGGBB` 看跳变」**，不要找色块包围盒——白场阈值会漏掉边缘柔化像素（实测把 31px 药丸量成 27px）。
- **怀疑单张稿的色值是 JPEG 噪声时，扫一遍全套稿看是否反复出现**。`#DCFDF6` 在 9 张稿里都是最高频浅薄荷 → 判为设计系统色，立 `--brand-mint` token（与早期 `--brand-soft-2` #d3f4ea 并非同色）。
- **账期选择器几何**（采样自 `月选择器.jpg` / `年选择器.jpg`）：4 列网格、左右内缩 20、列间距 7、行间距 20、单元格高 45 圆角 12、选中 `--brand` 实底 + 深色文字；页签下划线 2.5px、两页签间距 50；`‹ 标题 ›` 行高 66、左右内边距 16、标题 20px/600；年份一屏 12 个，当前年前留 8 年。

## 账期切换器（只有一处实现）
`src/components/PeriodSwitch.vue`：自带药丸、箭头、可点日期**和** `PeriodPicker` 弹层，直接读写 `billStore.period`。账单页筛选行与统计页页头都只写 `<PeriodSwitch />` 一行；**不要**在页面里再抄触发器或另绑 `pickerOpen`。
- 几何（采样自 `微信图片_20260927231957_12_4.jpg` 顶部筛选行）：白药丸高 31、全圆角、内缩 5；薄荷圆钮直径 21、底 `--brand-mint`、箭头 `--brand`；日期 13.5px 深色、`min-width:78px`（固定宽度，否则按月/按年切换时药丸宽度会跳）。**没有下拉箭头图标**。
- 药丸总宽 154（设计稿 171.5）：统计页页头要放得下且不压居中标题（实测留 16px）。**两页一致比照抄设计稿宽度更重要。**

## 布局约定
- **账单 store 有两份互相独立的数据切片，不要合并**：
  - 本月视角 `month` / `bills` / `summary` —— **只有首页**用（首页永远显示「本月」）。
  - 账期取景 `period{mode,month,year}` / `periodBills` / `periodSummary` + `period*` getter（`periodRange`/`periodLabel`/`periodUnit`/`periodGroups`/`periodDailyMap`/`periodMonthlyMap`/`periodTrend`/`periodRankMap`）—— **账单页与统计页共用**，两页始终是同一个「当期」。这是刻意选择。
  - 写操作要同时刷新两份；`periodInitialized` 为 false 时跳过 period 刷新。
- **区间一律用 `from` / `to`（'YYYY-MM-DD'，含首尾）**，`month` 只是特例；contract 里两者可同时传，按 AND 处理。
- **左右滑动切屏统一用 `useSwipeViews`**（`src/composables/useSwipeViews.js`）：`width = 视图数×100%`，位移 `-(下标 × 100/视图数)% + dx`，拖动关 `transition` 跟手，松手 56px 阈值吸附。账单页（流水/日历）与统计页（支出/收入）共用，**不要另写**。
  - 先判主方向，纵向放弃（`active=false`）把滚动还给浏览器；全程不用 `preventDefault`。起点命中 `[data-no-swipe]` 不接管（统计页折线图靠它独占横向手势）。
- **底部标签栏占位**：带 TabBar 的页面用 `padding-bottom: var(--tabbar-space)`（= `--tab-h` + `--safe-b` + `--plus-overhang`）。**不要写 `padding: 0 14px` 简写**——会连 padding-bottom 一起重置，最后一条被盖住且滚不出来。base.css 的 `.has-tabbar` 工具类已删除（会被页面 scoped padding 简写静默覆盖）。
  - `--plus-overhang`（20px）：TabBar 中间深色加号是 54px 圆、`bottom:20px`，凸出上沿 18px；不算进占位的话，滚到底时最后一行交互元素会压在加号下面。
- **局部滚动**：用 base.css 的 `.scroll-area`（`flex:1` + `min-height:0` + `overflow-y:auto`），外层 `.page-body` 改 `display:flex; flex-direction:column; overflow:hidden`。账单页/统计页即此结构：筛选行 + 概览卡片固定，只有内容滚动；滚动区自己写 `padding: 0 14px var(--tabbar-space)`。
- 卡片与上方固定区的间距放在**固定区**上（如 `.hero { margin-bottom: 12px }`），不要放滚动区 `padding-top`，否则滚动时留白被滚掉、半截列表贴到固定区。

## 页面与路由
`/` 首页 · `/bills` 账单 · `/record` 记账（`?id=` 为修改）· `/stats` 统计 · `/mine` 我的
`/category` 一级分类管理（含子路由 `:parentId/sub` 二级弹层）· `/category/edit`（`?scope=primary|secondary&parentId=&id=`）

## 关键规范
- 二级分类展示名统一 `一级名-二级名`（如「交通-公交地铁」），由 `categoryStore.label()` 产出。
- 分类名上限 8 字（`NAME_MAX_LENGTH`）；同级同类型重名抛 `RepositoryError`。
- 删除一律软删除（`deleted: 1`），供增量同步识别。
- 金额为元、正数；配色遵国内习惯（本项目支出深色、收入主题绿）。

## 统计页
- 结构：概览卡（当期支出/收入/结余）→ `支出/收入` 胶囊 + 笔数 → 横向轨道（两屏各自 `scroll-area`）→ 每屏一张趋势卡 + 一张排行卡。
- `TrendChart`：**按月一天一个点、按年一个月一个点**；纵轴上限取整到好读刻度（≥1000 取百、≥100 取十），两条参考线，横轴最多 6 个标签。
  - **未来日期不画**（当月只画到今天、当年只画到本月），否则折线尾巴掉到 0。
  - 横轴桶由 store 的 `periodTrend` 产出（`{key, axis, full}`），图表只用 `value`，不自己算日期。
  - 交互：滑动/点按都把游标吸附到最近点（`indexFrom(clientX)` 用容器 rect 换 viewBox 坐标），浮层显示日期 + 金额；纵向滑动清游标。鼠标与触摸事件都实现（便于桌面与合成事件验证）。
  - 配色：**支出深色 `--ink`、收入主题绿 `--brand`**；排行条统一 `--brand`（细条用深色显脏）。
- `RankList`：按**一级分类**（`primaryCategoryId`）聚合，金额降序，默认前 3，超 3 项出现「查看更多/收起」。展开态在组件内部。
- 页面进入调 `ensurePeriodLoaded()`，**不要**用 `ensureLoaded()`（后者是首页本月视角）。

## 演示数据（种子）
- **本月支出目标 `8720.72` 不要动**（对齐账单页参考图）；差额由 `bill_seed_gap` 补齐。算差额只累加 `type === 'expense'` 的本月账单。
- 补充账单 `bill_seed_extra_NN`：本月 4 笔收入（用 `offset` 表达并夹在本月内）+ 前两个月收支（用 `day`），让统计页开箱有数据。
- 给已有库补演示数据走 `SEED_EXTRA_VERSION` / `SEED_NOTES_VERSION` + `migrate()`：**按 id 幂等回填、不覆盖用户数据**。**不要**为演示数据 bump `SCHEMA_VERSION`（会清空用户记的账）。
- 当前数字：本月支出 8720.72 / 收入 13768.50 / 结余 5047.78；2026 年支出 19666.22 / 收入 43368.50。

## 数据层（S1 / S2 / S3）
**业务规则只在 `src/api/core/` 写一次**，各适配器共用：
- `core/query.js` —— 过滤/排序/聚合/派生（纯函数无 IO）：`alive`、`createCategoryLookup`、`filterCategories`、`filterBills`、`groupBillsByDate`、`dailySummaryOf`、`summarizeBills`、`remarkHistoryOf`、`decorateBill`。
- `core/migrate.js` —— 种子迁移 `migrateSeedData(bills, meta)`，幂等、只补不覆盖。
- `core/idb.js` —— IndexedDB 库名/版本/objectStore 名/`META_KEYS` 与全部库原语。**抽出来只为破解循环依赖**（outbox 要用 `openDB()`，而 `idbAdapter` 又 import outbox）。新增「队列/引擎也要用」的库操作放这里。
- `core/merge.js` —— 远端合并：`fromRemote`（剥 `_id`/`_openid`/`_serverTs`）、`shouldTakeRemote`、`partitionRemote → {take, keep}`。**合并规则只写这一份**。

**适配器**：`mockAdapter`（内存 + localStorage，契约对照基准）、`idbAdapter`（本地，当前启用）、`cloudbaseAdapter`（云端，当前启用）、`leancloudAdapter`（已废弃，只留注释）。

**IndexedDB 约定**：库名 `ledger`、版本 2、5 个 objectStore（ledger/category/bill/outbox/meta）；meta 键 `schemaVersion`/`seedMeta`/`importedFromLocalStorage`/`outboxImported`/`syncWatermark`/`firstBindDone`。
- 首次打开**接管** localStorage 的 `ledger.db.v1`（`LEGACY_KEY`），**导入后不删旧库**（可回退）；靠 `importedFromLocalStorage` 幂等。`reset()` 必须**保留** `importedFromLocalStorage` 与 `outboxImported` 两个标记，否则重置后旧库/旧队列会被重新导入。
- 写入前一律 `toPlain()` JSON 深拷贝 —— 结构化克隆处理不了 Vue 的 Proxy，直接 put 抛 `DataCloneError`。
- **「读-改-写」分两次事务**，塞进一个事务会因跨 `await` 失效而抛 `TransactionInactiveError`。
- 查询用 `readAll` 读进内存再算（千条级毫秒级）。`createIdbAdapter` 有 **`seed` 选项**（默认 true），建空库/写测试传 `seed: false`。
- **存储顺序不是契约**：IndexedDB 的 `getAll` 按主键序、内存数组是插入序，凡有顺序语义处显式排序（`filterCategories` 已加 id 兜底，因为 `order` 只在同级同类型内唯一）。

## 同步引擎（`src/api/sync/`）
- **装配点唯一**：`src/api/index.js` 的 `createSyncEngine({ outbox: db.outbox, store: db.syncStore, meta: db.kv, cloud })`；启动在 `src/main.js` 的 `syncEngine.start()`。
- **依赖方向单向**：适配器 → outbox ← syncEngine。**适配器绝不 import syncEngine**，靠 `outbox.onChange` 解耦。
- **四态**`idle / syncing / error / offline`。离线**不发请求**（省资源点、不污染 retry 计数）。
- **防重入是唯一闸门**：`syncing` 期间再调 `sync()` 必须 **`return` 同一个 in-flight Promise**（不能 return undefined，否则调用方没法 await）。四种触发源（启动 / `online` / 写后 debounce 2s / 手动）都收敛到此。
- **单次同步顺序固定 pull → push → 回拉被拒 → compact**。反序会用本地旧版本盖掉云端较新版本。push 推的是**当前本地文档**，不是入队时的 payload 快照。
- **水位线只认服务端 `_serverTs`**，不认客户端 `updatedAt`；服务端时间必须**严格单调**（`base > serverClock ? base : serverClock + 1`），pull 区间 **左闭 `>=`**（宁可重复拉不能漏，重复无副作用）。两条各对应一个真实漏数据缺陷，**别改回去**。
- **推送被拒必须回拉**：被拒条目带 `cloudUpdatedAt` 进 `rejected`，引擎据此把云端版本拉回本地并 `outbox.drop()` 作废该条目。否则两端静默分叉 —— **单设备永远测不出这个 bug**。
- **`fakeCloud` 必须带身份维度**（`cloud.as('openid')`），否则两用户躺在同一 Map 里天然全通。它只能验「代码没抹掉身份」，**测不了真实权限**。
- **串号风险在本地不在云端**：两账号共用 `ledger` 库时，A 残留的 outbox 会被推到 B 名下。方案是库名分区 `ledger_<openid>`（`openDB({ dbName })` 已支持注入），**S5 启用**。
- **已知不修，留给 S4**：本地「新者胜」依赖客户端时钟，`fakeCloud._skew(ms)` 能暴露但 S2 刻意不断言 —— 不要为了让测试变绿打补丁。
- **测试时间与定时器必须注入**：`createClock()`（serverTime 与 updatedAt 同源，否则水位跑到文档时间前面导致假失败）+ `createFakeTimer()`（退避延迟可断言、不用真等）。
- `localStorage['ledger.outbox.v1']` 残留 `"[]"` 是正常的（S1 旧队列排空留下的），有 `outboxImported` 兜底，**不要去清理**。

## 云端（S3 已完成，腾讯云开发 CloudBase）
装配：`src/api/index.js` 里 `cloud = isCloudConfigured ? createCloudBaseAdapter({ env: cloudEnvId }) : null`。**换云端只需改这一处。**

- **环境能力以实测为准，不靠文档推断**：当前环境是**纯 NoSQL 后端**（`RuntimeBackends.nosql = true`，官方提示 "PostgreSQL is NOT provisioned in this env … legacy NoSQL CloudBase backend"），走 `app.database()`。**不要**改成 `app.rdb()`。判断方法是查 `queryEnv(action="info")` 的 `RuntimeMode` / `RuntimeBackends`。
- **集合名带项目前缀**：`ledger_ledgers` / `ledger_categories` / `ledger_bills`。**该 CloudBase 环境后续可能被其它项目复用**，所有云端资源都加 `ledger_` 前缀；由 `CLOUD_COLLECTION_PREFIX` + `CLOUD_COLLECTIONS` 映射产出，**业务代码不手写集合名**。
- **权限用简单权限 `PRIVATE`（仅创建者可读写）**，三集合全设。它与 CUSTOM 规则的区别很关键：**CUSTOM 规则要求查询条件必须自带 `_openid`**，简单权限由服务端按 `_openid` 自动隔离、客户端查询**不带** `_openid`。选后者更省心。
- **权限是「服务端校验」不是「前端过滤」**，所以适配器里**故意不过滤** `_openid`（前端代码谁都能改）。
- **`_openid` 由 SDK 自动注入**（手写报错），拉回时由 `fromRemote()` 剥掉，不落本地库；`stripServerMeta()` 剥掉所有 `_` 前缀字段。
- **`_serverTs` 用 `db.serverDate()` 写入** = 服务端接收时间，读回来是 **Date 对象**。**坑：拿数字比较 Date 字段一条都匹配不到**，必须 `_.gte(new Date(0))`。
- **`push` 是两段式条件 upsert**：①按 `_id` 批量读回云端 `updatedAt` → ②逐条比较，本地不旧才 `col.doc(id).set({...payload, _serverTs: db.serverDate()})`，否则进 `rejected`。**①②之间不原子，是留给 S4 的已知窗口。**
- **`.doc(id).set()` 就是指定 `_id` 的 upsert**；`.add()` 返回 `result._id`；`.update()` 返回 `{updated}`、`.remove()` 返回 `{deleted}`；分页 `orderBy + skip + limit`。`.set()` 的 upsert **只对自己拥有的文档成立**，`_id` 已存在但属主是别人时抛 **`E11000 duplicate key`（500 / `DATABASE_REQUEST_FAILED`）**。
- **`serverTime()` 是「能观察到的最新 `_serverTs`」，是下界不是精确当前时间**（Web SDK 没有读服务端时间的接口，`serverDate()` 只能写入）。做水位线安全，**不能做冲突裁决** → 留给 S4 用云函数。
- **匿名登录是懒触发的**：只在真正要读写数据时 `signInAnonymously()`（否则光开「我的」页就触发 88 次写入）。登录态在 localStorage（`user_info_<envId>` / `credentials_<envId>` / `lang_<envId>` / `device_id`），**清掉就永久失联** → S5 要尽早「匿名转正」。
  - **坑**：同一 `app` 实例 `signOut()` 后重新匿名登录**仍拿到同一个 uid** → 验证隔离必须用**两个独立进程**。
- **首次绑定 `ensureCloudFirstBind()`**：把本地三集合文档一次性 `outbox.enqueueMany` 推上云（本地优先）。匿名设备身份下云端不可能有别人的数据，故无覆盖风险；**S5 有真账号后必须改成先问用户**。
- **SDK 走动态 import**（`loadSdk: () => import('@cloudbase/js-sdk')`），Vite 拆成独立 chunk（871 kB / gzip 220.8 kB）；不配云端时根本不加载。
- **体验版两个限制**：`addSecurityDomain` 报「当前套餐无法执行此操作」（但 `localhost:5173` 实测本来就能过 Origin 校验，伪造域名才 403）；**免费环境要手动续期**（单次 6 个月、不支持自动续费）。
- **平台自带的默认域名可绕过"添加安全域名"**：`<环境ID>-<随机段>.ap-shanghai.app.tcloudbase.com`（上海地域，2026-09-30 由用户拿到）。实测请求到达 CloudBase 网关（`server: tcbgw`），返回 **404 是因为静态托管尚未部署内容**，不是域名问题。正式域名待开发测试结束后申请。**该域名写进文档时可以写全，但注意它含 envId —— 若日后要严格保密，应改为只记形态。**
- **⚠️ 匿名登录的开关时机（用户主动提出，务必在 S6 收口）**：**开发测试期保持开启**（S3 云端链路依赖它）；**正式上线前必须重新评估**。理由：①匿名登录无需凭证 → 任何人拿到环境 ID 就能创建身份并写数据；②免费额度按量计（3,000 点/月），PRIVATE 权限**只能防"看别人的数据"、防不住"新建账号写自己的数据"**；③S5 匿名转正后它应从主入口降级为游客体验。**上线时三选一**：A 直接关闭 / B 保留但匿名身份不参与云同步（按 `auth.loginType` 分流）/ C 保留并接受风险（须配额度告警）。详见 `phase2-backend-plan.md` 第 3 节 **P10** 与 S6 的 **S6-7**。
- **环境到期时间 2027-03-30**（用户已于 2026-09-30 设好续期提醒）。
- 探针脚本 `.preview/sdk-probe/`：`probe-docdb.mjs`（serverDate / 自定义 `_id` upsert / `_openid` 注入 / 区间+排序+分页 / 水位线边界）、`probe-isolation.mjs`（**独立进程**验证跨身份隔离）。换环境或升 SDK 大版本时重跑。

## 数据层断言
`npm run test:data` 一次跑完五个脚本，**合计 259 条**。Node 里 IndexedDB 用 `fake-indexeddb`（devDependency）。
- `contract-test.mjs`（87）：同一套断言跑 mock 与 idb，并断言 `outbox` / `syncStore` 方法齐全。注意 `outbox` 是**对象**，要先断言 `!!adapter.outbox` 再查方法（写成 `has(adapter, ['outbox'])` 恒假）。
- `period-test.mjs`（22）/ `seed-test.mjs`（14）/ `migrate-test.mjs`（11，输出格式是 `PASS xxx` 而非「N 通过」）/ `sync-test.mjs`（125 / 18 组）。
- **真正会咬人的是防重入、否决回拉、双实例收敛、身份隔离、分页、队列搬迁幂等** —— 都只能在多实例/并发下暴露，单设备手点测不出来。
- 脚本用 `new URL('../src/', import.meta.url)` 解析路径，**不要写死绝对路径**。store getter 依赖 `@/` 别名，Node 直接 import 不了，那部分靠浏览器读 DOM 断言。
- **真实云端的调用不在这套断言里**，靠 `.preview/sdk-probe/` + 浏览器端到端走查。

## 本地运行
`npm install && npm run dev` → http://127.0.0.1:5173（也可用 `127.0.0.1`）。
数据在 **IndexedDB**（库 `ledger`，版本 2）+ 云端。「我的 → 重置演示数据」会清本地与云端、重灌种子并推上云（保留两个「已导入」标记）。
不配 `.env.local` 即退回纯本地模式，无需改代码。

### ⚠️ 在 `.preview/` 之类子目录装依赖会污染项目根
这些目录**没有 `package.json`**，npm 会**向上冒泡**写到项目根的 `package.json`（2026-09-29 实测：一条 `npm install @cloudbase/js-sdk` 让根 `package.json` 多两条依赖、lock 多 701 行）。
**规矩：在 `.preview/` 下 `npm install` 前，先在该目录放自己的 `package.json`。** 事后回滚：`git checkout -- package.json package-lock.json` + `rm -rf node_modules/<scope>`，再 `grep -c` 复核。

### dev server 重启
装了新包后 lockfile 变化，vite 要清 `node_modules/.vite/deps`，会被沙箱的批量删除保护拦住（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。手动 `rm -rf node_modules/.vite` 后重启即可。

## 版本管理
- **本机没有 Git for Windows**（无 `C:\Program Files\Git`，PATH 里无 git）。本会话用 WorkBuddy 内置 PortableGit `~/.workbuddy/binaries/PortableGit/versions/1.2.0`（2.55.0，bash 可用）；另装有 GitHub Desktop 3.5.12，其精简 git 在 `%LOCALAPPDATA%\GitHubDesktop\app-3.5.12\resources\app\git\cmd\git.exe`（2.53.0，无 bash）。
- 主分支 `main`；标签 `v0.1.0`（前端骨架）、`v0.2.0`（第一阶段完成，验收通过）。S2 / S3 完成时**均未打新标签**。
- 提交用约定式前缀（`feat:` / `fix:` / `refactor:` / `docs:`），正文写清功能点与数据层改动。
- 不提交 `node_modules/`、`dist/`、`.preview/`。**设计参考图与 `.workbuddy/memory/` 纳入版本管理**，作为设计来源与决策记录。

## 后端选型（教训）
- **LeanCloud 已停服**（2026-01-12 起停止注册与建应用，2027-01-12 关闭全部对外服务、数据销毁）。第一阶段的 `leancloudAdapter.js` 因此作废，只留「本地为主 + outbox 推送 + 水位拉取 + 新者胜」的策略注释作参考，**不要照它实现**。
- **Supabase 曾一度选定后放弃**：方案没问题（Postgres + RLS + 开源可自托管），但国内直连其官方域名不稳，真机测试常需自备域名与代理。
- **终选腾讯云开发 CloudBase**（用户 2026-09-29 拍定，路线 B = 自有环境 + `@cloudbase/js-sdk`）。
- **曾经评估过的路线 A**（WorkBuddy 托管云服务 + `@tencent-ai/workbuddy-cloud-sdk` + PostgreSQL + 邮箱登录）**已放弃**，其调研结论不再追述——A 路无匿名登录、且登录只能在已注册的 HTTPS 发布域名上验证，与「本地先把云同步跑通」的节奏冲突。若日后要重新评估，结论是：**该项目走自有 CloudBase 环境**。
- `.env.local` 不入库（`.gitignore` 已覆盖，`git check-ignore` 验过）。
