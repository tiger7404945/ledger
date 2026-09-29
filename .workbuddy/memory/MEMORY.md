# 项目长期记忆 · 随手记账（D:\projects\ledger）

## 项目性质
移动端记账 Web App 的前端复刻。设计原型来自仓库根目录的设计稿：8 张微信截图（`微信图片_*.jpg`）+ 后续补充的 `填写备注.jpg`（记账页备注候选条）+ `月选择器.jpg` / `年选择器.jpg`（账期筛选弹层）。补充稿同样放在仓库根目录、纳入版本管理。
**统计页没有参考稿**，是按需求补齐的（视觉沿用全局设计语言）。
**第一阶段只做前端 + Mock 数据**（已完成，v0.2.0）；第二阶段为「本地离线 + 云端同步」——**S1（本地 IndexedDB）与 S2（同步引擎骨架 + 假云端）均已完成**，当前 `DATA_SOURCE = 'idb'`、`cloud = null`（未接真云端）；云端选型定为**腾讯云开发 CloudBase**（计划见 `phase2-backend-plan.md`）。

## 强制约定
- 视图层**不得**直接调用 adapter，只依赖 `src/api/index.js` 导出的 repository 与 Pinia store。
- 新增数据操作必须先在 `src/api/contract.js` 补契约，再实现到各 adapter。
- 写操作一律 local-first：先落本地，再 `outbox.enqueue`。
- 设计变量只写在 `src/styles/tokens.css`，组件内不硬编码品牌色。
- 图标一律用 `src/components/icons`（`IconBase` + `ICONS` 映射），不引入外部图标库/字体。
- 手机外框宽度 `--frame-w`（430px）；`position: fixed` 元素依赖 `.app-frame` 的 transform 包含块。
- **记账页草稿**：`src/composables/useRecordDraft.js`，localStorage key `ledger.recordDraft.v1`。它只是 UI 草稿，**不经过 repository / outbox**，也不属于业务数据。新增表单字段时要同步加进 `persistDraft` / `applyDraft`。
- **草稿生命周期**由 `installRecordDraftGuard(router)`（在 `src/router/index.js` 装配）一处裁决：**只在「记账页 ↔ 分类管理/分类编辑」往返时保留**；左上角返回、系统返回键、切 Tab、去首页/账单/统计/我的，以及从别处重新进入记账页，都立即作废草稿。不要在组件里另写一套离开时保存的逻辑。
- 记账页进入顺序：路由守卫先清掉非往返来源的草稿 → `onMounted` 比对 `editingId` 套用草稿 → 编辑态读账单 → 新建则默认选中第一个一级分类。
- **备注候选**：`billRepo.remarkHistory({ ledgerId, categoryId, limit })`。当前分类 = `subId || primaryId`，**精确匹配所选分类，不含其子分类**（选「交通」拿不到「交通-停车费」的备注）。
- **种子数据迁移**：`seed.js` 的 `SEED_NOTES_VERSION` + `mockAdapter.migrate()`，靠 `state.meta.seedNotes` 幂等标记。给已有演示账单补新字段（如备注）要走这种「按 id 回填、不动用户数据」的方式；**不要**为演示数据直接 bump `SCHEMA_VERSION`，那会清空用户自己记的账。
- **记账页层级**：页面底色用灰色 `--page`，二级分类面板（`SubCategoryPanel`）是白色浮起卡片（`--surface-raised` + `--r-md` + `--shadow-card` + 左右 24px 内缩）叠在灰底上。一级分类区直接铺灰底，**不要**给页面或 body 设纯白底，否则面板会与背景糊在一起。
- `CategoryGrid` 的选中态 = `selectedId`（叶子分类 id）或 `activeId`（父级一级分类 id）；记账页两个都要传，这样选中二级分类时父级也点亮。
- 调整视觉前先对参考稿做像素采样（PIL 取色），参考稿为 1080×2400。
- **账期选择器几何**（采样自 `月选择器.jpg` / `年选择器.jpg`）：4 列网格、左右内缩 20、列间距 7、行间距 20、单元格高 45 圆角 12、选中态 `--brand` 实底 + 深色文字；页签下划线 2.5px、两个页签间距 50；`‹ 标题 ›` 行高 66、左右内边距 16、标题 20px/600。年份网格一屏 12 个，当前年前面留 8 年。
- **账期切换器只有一处实现**：`src/components/PeriodSwitch.vue`（账单页筛选行 + 统计页页头共用）。它自带药丸、箭头、可点日期**和** `PeriodPicker` 弹层，直接读写 `billStore.period`。账单页/统计页都只写 `<PeriodSwitch />` 一行；**不要**在页面里再抄一份触发器或另绑 `pickerOpen` —— 之前两页各写一套，已经漂成「圆钮 26 vs 24、gap 6 vs 4、一个带 ⌄ 一个不带」。
  - 几何（采样自 `微信图片_20260927231957_12_4.jpg` 顶部筛选行）：白色药丸高 31、全圆角、内缩 5；薄荷圆钮直径 21、底 `--brand-mint`(#DCFDF6)、箭头 `--brand`；日期 13.5px 深色、`min-width:78px`（固定宽度，否则按月/按年切换时药丸宽度会跳）。**没有下拉箭头图标**。
  - 药丸总宽 154（设计稿 171.5）：统计页页头要放得下且不压到居中标题（实测与标题留 16px），两页保持一致比照抄设计稿宽度更重要。
- **同色跨稿比对**：怀疑某个设计稿采样值只是 JPEG 噪声时，把 `微信图片_*.jpg` 全量扫一遍看该色是否反复出现。`#DCFDF6` 在 9 张稿里都是最高频浅薄荷，故判为设计系统色并立 `--brand-mint` token；它与早期的 `--brand-soft-2`(#d3f4ea) 并非同色。
- **agent-browser 的 click 命中第一个匹配元素**：`click ".grid .cell:nth-child(9)"` 在账单页会点到月历的日期格（页面里有两个 `.grid`），必须写成 `.picker .grid .cell:nth-child(9)`。改完文件若页面空白又无报错，先重新 `open` 一次（HMR 半改状态）。
- **Vue 的 DOM 更新是异步的**：用 `eval` 派发合成手势后，必须在**另一次** `eval` 里读状态，同一次调用里读到的还是旧值。
- **agent-browser 用法**：二进制在 `C:\Users\DELL\.workbuddy\binaries\node\workspace\node_modules\agent-browser\bin\agent-browser-win32-x64.exe`。**必须先 `open <url>` 再 `set viewport <w> <h>`**；没有打开页面就调 `set viewport` 会一直挂住不返回。命令都可能挂起，一律套 `timeout`。`eval` 用最简单的表达式（如 `document.querySelector('.scroll-area').scrollTop = 99999`）不会挂。

## 数据层（第二阶段 S1 / S2 已完成）
- **业务规则只在 `src/api/core/` 写一次**，被各适配器共用：
  - `core/query.js` —— 过滤 / 排序 / 聚合 / 派生字段（纯函数，无 IO）：`alive`、`createCategoryLookup`、`filterCategories`、`filterBills`、`groupBillsByDate`、`dailySummaryOf`、`summarizeBills`、`remarkHistoryOf`、`decorateBill`。
  - `core/migrate.js` —— 种子迁移 `migrateSeedData(bills, meta)`，幂等、只补不覆盖。
  - `core/idb.js` —— IndexedDB 库名 / 版本 / objectStore 名 / `META_KEYS` 常量与全部库原语。**抽出来只为破解循环依赖**：outbox 要用 `openDB()`，而 `idbAdapter` 又 import outbox。新增任何「队列 / 引擎也要用」的库操作都放这里，别放进适配器。
  - `core/merge.js` —— 远端文档合并：`fromRemote`（剥 `_id`/`_openid`/`_serverTs`）、`shouldTakeRemote`、`partitionRemote → {take, keep}`。**合并规则只写这一份**，mock 与 idb 共用。
  - **新增适配器必须复用这几处**，不要另写一套查询 —— 本项目已吃过「两处实现各写一套、慢慢漂开」的亏（`PeriodSwitch` 那次）。
- **适配器**：`mockAdapter`（内存 + localStorage，保留作契约对照基准）、`idbAdapter`（**当前启用**）、`cloudbaseAdapter`（待实现，第二阶段 S3）。
- **IndexedDB 约定**（`idbAdapter`）：库名 `ledger`、版本 2、5 个 objectStore（ledger / category / bill / outbox / meta）；meta 表键为 `schemaVersion` / `seedMeta` / `importedFromLocalStorage` / `outboxImported` / `syncWatermark`（水位线经 `kv`）。
  - 首次打开**接管** localStorage 的 `ledger.db.v1`（`LEGACY_KEY`），**导入后不删旧库**（可回退）；靠 `importedFromLocalStorage` 标记保证只接管一次，`reset()` 会**保留**该标记（否则重置后旧库会被重新导入）。
  - 同理 `outboxImported` 标记也要在 `reset()` 里保留 —— 否则重置后 localStorage 里的旧队列会被重新导入一遍。
  - 写入前一律 `toPlain()` JSON 深拷贝 —— IndexedDB 的结构化克隆处理不了 Vue 的 Proxy，直接 `put` 会抛 `DataCloneError`。
  - **「读-改-写」必须分两次事务**，不要塞进一个事务：事务跨 `await` 会失效并抛 `TransactionInactiveError`。页面内单线程串行，无并发问题。
  - 查询用 `readAll` 把集合读进内存再算（千条级毫秒级）；索引已建好，数据量上来后再改走索引。
  - `createIdbAdapter` 有 **`seed` 选项**（默认 true）。写测试 / 建空库时传 `seed: false`，否则 `runSeedMigration()` 会把演示账单当「缺失的补充数据」灌进空库。
- **存储顺序不是契约**：IndexedDB 的 `getAll` 按主键序返回，内存数组是插入序。凡有顺序语义处必须显式排序 —— `filterCategories` 已加 id 兜底，因为 `order` 只在同级同类型内唯一。
- 改动数据层的验证姿势：`npm run test:data`（五个脚本，259 条断言，见下）。Node 里跑 IndexedDB 用 `fake-indexeddb`（devDependency）。

## 同步引擎（第二阶段 S2 已完成，`src/api/sync/`）
- **装配点唯一**：`src/api/index.js` 里 `createSyncEngine({ outbox: db.outbox, store: db.syncStore, meta: db.kv, cloud })`；启动在 `src/main.js` 的 `syncEngine.start()`。换真云端**只需改 `export const cloud = null` 这一处**，引擎 / 适配器 / store / 视图一行都不用动。
- **依赖方向单向**：适配器 → outbox ← syncEngine。**适配器绝不 import syncEngine**，靠 `outbox.onChange` 通知解耦。新增适配器时照抄这个接法。
- **状态机四态**：`idle / syncing / error / offline`。离线时**不发请求**（省 CloudBase 资源点、也不污染 retry 计数）。
- **防重入是唯一闸门**：`syncing` 期间再调 `sync()` 必须 **`return` 同一个 in-flight Promise**，不能直接 return undefined —— 否则调用方拿不到结果也没法 `await`。四种触发源（启动 / `online` / 写后 debounce 2s / 手动）都收敛到这一处。
- **单次同步顺序固定为 pull → push → 回拉被拒 → compact**。反序会用本地旧版本盖掉云端较新版本。push 推的是**当前本地文档**，不是入队时的 payload 快照。
- **水位线只认服务端接收时间 `_serverTs`**，不认客户端 `updatedAt`。且服务端时间必须**严格单调递增**（`base > serverClock ? base : serverClock + 1`），pull 区间是 **(since, snapshotAt] 左开右闭**，`snapshotAt` 在查询**开始前**取。
  - 这两条各对应一个真实漏数据缺陷：用客户端时间过滤 → 慢推上来的改动被永久漏掉；区间右端开 → 同一毫秒的写入被漏掉。**别改回去。**
- **推送被拒必须回拉**：云端条件 upsert，只有「本地不旧于云端」才覆盖，被拒条目进 `rejected` 并带 `cloudUpdatedAt`；引擎据此把云端版本拉回本地并 `outbox.drop()` 作废该条目。否则本地以为推成功、两端静默分叉 —— **单设备永远测不出这个 bug**。
- **`fakeCloud` 必须带身份维度**（`cloud.as('openid')`），否则两用户数据躺在同一 Map 里、测出来天然全通。它只能验「代码没抹掉身份」，**测不了真实安全规则**（那是 S3 用两个真实账号的事）。
- **串号风险在本地不在云端**：两账号共用一个 `ledger` 库时，A 残留的 outbox 条目会被推到 B 名下。方案是库名分区 `ledger_<openid>`（`openDB({ dbName })` 已支持注入），**S2 只预留、S5 启用**。
- **已知不修，留给 S4**：本地「新者胜」依赖客户端时钟。`fakeCloud._skew(ms)` 能暴露问题但 S2 **刻意不断言** —— 不要为了让测试变绿在这里打补丁，那是 S4 用服务端时间裁决的事。
- **测试时间与定时器必须注入**：`createClock()`（serverTime 与 updatedAt 同源，否则水位跑到文档时间前面导致假失败）+ `createFakeTimer()`（退避延迟可断言且不用真等 2 秒）。
- **`localStorage['ledger.outbox.v1']` 里残留 `"[]"` 是正常的**：S1 旧 outbox 排空后写下的空数组。S2 只读不写该键，搬迁有 `outboxImported` 标记兜底 → 无害，不要去清理它。

## 布局约定
- **账单 store 有两份互相独立的数据切片**，不要合并：
  - **本月视角**：`month` / `bills` / `summary`，**只有首页**用它（首页永远显示「本月」，不能被账期筛选带跑）。
  - **账期取景**：`period{mode,month,year}` / `periodBills` / `periodSummary` + `period*` 系列 getter（`periodRange` / `periodLabel` / `periodUnit` / `periodGroups` / `periodDailyMap` / `periodMonthlyMap` / `periodTrend` / `periodRankMap`），**账单页与统计页共用**——两页始终表达同一个「当期」，在任一处切到某年，另一处也跟着变。这是刻意的选择，不是漏了隔离；若要两页各自独立，得再加第三份切片。
  - 写操作（create/update/delete）要同时刷新两份；`periodInitialized` 为 false 时跳过 period 刷新，避免记账页做多余查询。
- **区间一律用 `from` / `to`（'YYYY-MM-DD'，含首尾）表达**，`month` 只是它的特例。contract 里两者可同时传且按 AND 处理。新增区间筛选先补 contract，再补 mockAdapter，再给 store 加 getter。
- **左右滑动切屏统一用 `useSwipeViews`**（`src/composables/useSwipeViews.js`）：`width = 视图数×100%`、位移 `-(下标 × 100/视图数)% + dx`，拖动时关掉 `transition` 跟手，松手按 56px 阈值吸附。账单页（流水/日历）与统计页（支出/收入）都用它，**不要在页面里再写一套**。
  - 手势先判主方向，纵向直接放弃（`active=false`）把滚动交还给浏览器；全程不用 `preventDefault`。
  - 起点命中 `[data-no-swipe]` 时不接管——统计页的折线图靠它独占横向手势做数据游标。
- **底部标签栏占位**：`TabBar` 是 `position: fixed`，带 TabBar 的页面必须自己留底部空间。统一用 `padding-bottom: var(--tabbar-space)`（= `--tab-h` + `--safe-b` + `--plus-overhang`）。**不要写 `padding: 0 14px` 这种简写**——它会连 `padding-bottom` 一起重置，导致最后一条内容被标签栏盖住且滚不出来。原先 base.css 里的 `.has-tabbar` 工具类已删除（它会被各页面 scoped 样式里的 padding 简写静默覆盖，是个坑）。
  - `--plus-overhang`（20px）：TabBar 中间的深色加号是 54px 圆、`bottom:20px`，会凸出标签栏上沿 18px；不把它算进占位的话，滚到底时最后一行交互元素（如统计页的「查看更多」）正好压在加号下面，看起来能点其实点的是加号。这是实测踩出来的。
- **局部滚动**：页面需要「只有某一块滚动、其余固定」时，用 base.css 的 `.scroll-area`（`flex: 1` + `min-height: 0` + `overflow-y: auto`），外层 `.page-body` 改为 `display: flex; flex-direction: column; overflow: hidden`。账单页与统计页即此结构：筛选行 + 概览卡片固定，只有内容滚动；滚动区自己写 `padding: 0 14px var(--tabbar-space)`，卡片就能像设计稿那样一直铺到标签栏底下，且最后一条能完整滚出来。
- 卡片与上方固定区之间的间距放在固定区上（如 `.hero { margin-bottom: 12px }`），不要放在滚动区的 `padding-top`——否则滚动时这段留白会被滚掉，半截列表会贴到固定区上。

## 页面与路由
`/` 首页 · `/bills` 账单 · `/record` 记账（`?id=` 为修改）· `/stats` 统计 · `/mine` 我的
`/category` 一级分类管理（内含子路由 `:parentId/sub` 二级弹层）· `/category/edit` 分类编辑（`?scope=primary|secondary&parentId=&id=`）

## 关键规范
- 二级分类展示名统一为 `一级名-二级名`（如「交通-公交地铁」），由 `categoryStore.label()` 产出。
- 分类名上限 8 字（`NAME_MAX_LENGTH`）；重名在同级同类型内不允许，抛 `RepositoryError`。
- 删除一律软删除（`deleted: 1`），供增量同步识别。
- 金额为元、正数；颜色遵循国内习惯（涨红跌绿，本项目金额为支出显示深色、收入显示主题绿）。

## 统计页
- 结构：概览卡片（当期支出/收入/结余三列）→ `支出/收入` 胶囊 + 笔数 → 横向轨道（两屏各自 `scroll-area`）→ 每屏一张趋势卡 + 一张排行卡。
- `TrendChart`：**按月账期一天一个点、按年账期一个月一个点**；纵轴上限取整到好读刻度（≥1000 取百、≥100 取十），两条参考线（上限 / 中值），横轴最多 6 个标签。
  - **未来日期不画**：当月只画到今天、当年只画到本月，否则折线尾巴会掉到 0。
  - 横轴桶由 store 的 `periodTrend` 产出（`{key, axis, full}`），图表只用 `value`，不自己算日期。
  - 交互：滑动或点按都把游标吸附到最近点（`indexFrom(clientX)` 用容器 rect 换到 viewBox 坐标），浮层显示日期 + 金额；纵向滑动会清掉游标把手势还给滚动。鼠标事件与触摸事件都实现了，便于桌面与合成事件验证。
  - 配色：**支出深色线 `--ink`、收入主题绿 `--brand`**（与账单行的收/支配色一致），渐变填充用同色低透明度；排行条统一 `--brand`（细条用深色显脏）。
- `RankList`：按**一级分类**聚合（`primaryCategoryId`），金额降序，默认前 3，超过 3 项出现「查看更多 / 收起」。展开状态在组件内部，靠 `:key` 与视图联动。
- 页面进入调用 `ensurePeriodLoaded()`，不要用 `ensureLoaded()`（后者是首页的本月视角）。

## 演示数据（种子）
- 本月支出目标 `8720.72` **不要动**（对齐账单页参考截图）；差额由 `bill_seed_gap`（购物 / 数码配件）补齐。算差额时只累加 `type === 'expense'` 的本月账单。
- 补充账单 `bill_seed_extra_NN`：本月 4 笔收入（工资/兼职/报销/红包，用 `offset` 表达并夹在本月内，避免月初跑到上月）+ 前两个月的收支（用 `day` 表达），让统计页的收入视图、按年趋势、排行开箱有数据。
- 给已有本地库补演示数据要走 `SEED_EXTRA_VERSION` + `mockAdapter.migrate()`：按 id 幂等回填、不覆盖已有记录、不动用户自己的账。**不要**为演示数据 bump `SCHEMA_VERSION`（那会清空用户记的账）。
- 当前演示数字：本月支出 8720.72 / 收入 13768.50 / 结余 5047.78；2026 年支出 19666.22 / 收入 43368.50。

## 本地运行
`npm install && npm run dev` → http://127.0.0.1:5173
数据持久化在 **IndexedDB**（库名 `ledger`，版本 2）；首次打开会自动接管 localStorage 里的旧库 `ledger.db.v1`。「我的 → 重置演示数据」可恢复种子数据（44 账单 / 42 分类），并会保留两个「已导入」标记。

## 数据层断言（scripts/，已纳入版本管理）
数据层用 Node 打桩跑（适配器只依赖相对路径 + localStorage / IndexedDB）：
- `npm run test:data` 一次跑完五个脚本，**合计 259 条断言**。
- `contract-test.mjs`（87 条）：契约一致性 —— 同一套断言跑 mock 与 idb，顺带验证「idb 首次打开接管 localStorage 旧库」，并断言 `outbox` / `syncStore` 方法齐全（注意 `outbox` 是**对象**，要先断言 `!!adapter.outbox` 再查其方法，写成 `has(adapter, ['outbox'])` 恒假）。
- `period-test.mjs`（22 条）：区间筛选 / 汇总与日期工具。
- `seed-test.mjs`（14 条）：种子数字 + 迁移幂等。
- `migrate-test.mjs`（11 条）：备注回填迁移（输出格式是 `PASS xxx`，不是「N 通过」）。
- `sync-test.mjs`（125 条 / 18 组场景）：同步引擎。真正会咬人的是防重入、否决回拉、双实例收敛、身份隔离、分页拉取、队列搬迁幂等 —— **都只能在多实例/并发场景暴露，单设备手点永远测不出来**。
- IndexedDB 在 Node 里用 `fake-indexeddb` 打桩。脚本用 `new URL('../src/', import.meta.url)` 解析路径，**不要写死绝对路径**。
- store 的 getter 依赖 `@/` 别名，Node 直接 import 不了，那部分靠浏览器读 DOM 断言。

## 版本管理
- **本机 Git 环境**：未安装 Git for Windows（无 `C:\Program Files\Git`），用户 PATH 中无 git；本会话执行 git 用的是 WorkBuddy 内置 PortableGit `~/.workbuddy/binaries/PortableGit/versions/1.2.0`（2.55.0）。另装有 GitHub Desktop 3.5.12，其自带精简版 git 在 `%LOCALAPPDATA%\GitHubDesktop\app-3.5.12\resources\app\git\cmd\git.exe`（2.53.0，无 bash/gitk）。全局身份 `tiger7404945 <tiger7404945@163.com>`。
- 主分支 `main`；标签：`v0.1.0`（第一阶段前端骨架）、`v0.2.0`（第一阶段完成并验收通过）。
- 提交历史：`face5fb` 第一阶段前端 → `cb2ac48` 记账页选中态/面板层级修复 → `698c975` 记账页交互增强（默认分类/草稿/备注候选，含 `填写备注.jpg`）→ `4baf607` 记忆补档 → `9fe39d6` 账单页滑动切换视图 + 月/年账期筛选（含 `月选择器.jpg` / `年选择器.jpg`，同批带上标签栏占位与局部滚动两处布局修复）。
- 提交信息用约定式前缀（`feat:`/`fix:`/`refactor:`/`docs:`），正文写清功能点与数据层改动。
- 不提交 `node_modules/`、`dist/`、`.preview/`（见 `.gitignore`）；`dist` 为可重建产物。
- 设计参考图与 `.workbuddy/memory/` 纳入版本管理，作为设计来源与决策记录。

## 后端选型（两次变更，教训）
- **LeanCloud 已停服**：2026-01-12 起停止新用户注册与创建应用，2027-01-12 关闭全部对外服务（应用访问 / 数据读写 / API / 控制台），平台数据将被销毁。第一阶段的 `leancloudAdapter.js` 骨架因此**作废**，仅保留「本地为主 + outbox 推送 + 水位拉取 + `updatedAt` 新者胜」的同步策略作设计参考，**不要再照它实现**。
- **Supabase 曾一度选定，后放弃**：技术方案没问题（Postgres + RLS + 开源可自托管），但**国内直连其官方域名不稳定**，真机测试常需自备域名与代理。
- **终选腾讯云开发 CloudBase**（用户 2026-09-29 拍定）：国内访问快、合规、有免费额度，且前端静态托管与后端同平台，省掉跨域与域名配置。
  - **免费体验版**：每个账号限 1 个环境，3,000 资源点/月（1,000 点 ≈ ¥1），**单次续期 6 个月、不支持自动续费，过期会停用** —— 必须设续期提醒。
  - 数据库用**文档型**（本项目数据是嵌套对象、不需要 JOIN，且 Web SDK 直连最成熟）；也提供 MySQL / PostgreSQL。
  - 权限靠**安全规则**（服务端下发，客户端改不了也绕不过）；云开发自动给带登录态的写入注入 `_openid`，规则写法 `doc._openid == auth.openid`。
  - 云端文档 `_id` 直接用**本地 id** 当幂等键；字段名保持 camelCase 与本地同名（文档型不需要 snake_case 转换）。
  - Web SDK：`@cloudbase/js-sdk`，`cloudbase.init({ env })` → `app.auth({ persistence: 'local' })` → `signInAnonymously()` → `app.database()`。**Web 端必须把开发/线上域名加入「安全来源」**，否则第一次调用就失败。
- 教训要记住：后端选型必须在架构上可替换。第一阶段「契约 + 适配器」分层在**两次换厂商**时都只动了适配器层，视图与 store 零改动。**继续维持这个纪律**。
- `.env.local` 不入库（`.gitignore` 已覆盖，`git check-ignore` 验过）。
