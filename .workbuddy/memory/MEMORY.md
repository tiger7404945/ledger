# 项目长期记忆 · 随手记账（D:\projects\ledger）

> 只留「改动前必须先知道」的规则。细节：`phase2-backend-plan.md`（S0–S6 任务与实施记录）、
> `CLOUD-S4-NOTES.md`（云端/同步实测）、同目录 `YYYY-MM-DD.md` 日志。

## 阶段
Vue3+Vite 记账 Web App。设计稿=根目录 9 张 jpg（统计页无稿）。v0.2.0 前端完成；
**S0–S5 全部完成**（含 S5-4 退出、S5-7 首绑裁决），云端=用户自有腾讯云开发 CloudBase（envId 只在 `.env.local`）。
**S7 已裁决、待实施**：去掉匿名身份，改为「写操作登录门禁」（2026-10-01，见下）。
标签 v0.1~v0.5 已打（v0.5.0 = S5 账号体系 + 库分区，2026-10-01，package.json 已对齐）。

## 强制约定（违反返工）
- 视图不直接调 adapter，只用 `src/api/index.js` 代理出的 repo 与 Pinia store。
- 新数据操作：contract.js 契约 → 各 adapter → store getter。写操作 local-first + `outbox.enqueue`。
- 业务/合并规则只在 `src/api/core/` 写一次。**后端可替换**：换厂商只动适配器层（已两次生效）。
- 云端资源一律 `ledger` 前缀（集合/云函数/网关），出口 `src/config/cloud.js`，不手写资源名。
- 设计变量只在 `tokens.css`；图标只用 `components/icons`；手机框宽 `--frame-w`，
  fixed 元素依赖 `.app-frame` 的 transform 包含块。

## 高频陷阱
- **账单 store 两份切片勿合并**：首页只用 `month/bills/summary`；账单页+统计页共用 `period*`
  （进统计页用 `ensurePeriodLoaded()`，勿用 `ensureLoaded()`）。写操作两份都刷。
- 滑动切屏只用 `useSwipeViews`；`[data-no-swipe]` 处不接管。区间一律 `from`/`to`（含首尾）。
- TabBar 页 `padding-bottom: var(--tabbar-space)`，**禁 `padding:0 14px` 简写**；局部滚动用 `.scroll-area`。
- `PeriodSwitch.vue` 是账期切换唯一实现（自带弹层），页面只写一行。
- 改视觉先像素采样（比例 2.844，裁状态栏；量高度用垂直线扫色跳变，别找包围盒）；
  单张稿孤立色值不可信（`--brand-mint`=#DCFDF6 由 9 张稿交叉验证）。
- 种子：本月支出 **8720.72** 别动；补数据走 `SEED_EXTRA_VERSION`+`migrate()`（幂等只补），
  **别 bump SCHEMA_VERSION**。统计页：未来日期不画；横轴桶用 store 的 `periodTrend`。

## 数据层 / IndexedDB
- 库名 `ledger_<账号前缀8位>`（`accountPrefixOf`），版本 2，store：ledger/category/bill/outbox/meta。
- `toPlain()` 深拷贝后再 put（Vue Proxy 会 DataCloneError）；读-改-写**分两个事务**
  （跨 await 抛 TransactionInactiveError）；`createIdbAdapter({dbName,seed,migrateFrom,claimant})`。
- `reset()` 必须保留 `importedFromLocalStorage`/`outboxImported` 两标记；
  localStorage 残留 `ledger.outbox.v1="[]"` 是正常的，别清。
- 裸库 `ledger` 只被认领一次（`partitionClaimedBy` 写在裸库）；`migratePartitionData` 五种 reason，
  **只有 `empty-source` 播种**（曾因把空源当 migrated 导致全新设备全 0.00）。
- 测试陷阱：`ledgerApi` 没有 create（造账本用 `putMany(STORES.LEDGER)`）；`billApi.create` 自造 id；
  `store.get` 双形态（单 id 返对象/数组返数组）。

## 同步引擎
- 装配唯一（api/index.js），启动在 main.js；适配器→outbox←引擎，适配器绝不 import 引擎。
- **防重入必须 return 同一个 in-flight Promise**；顺序固定 **pull→push→回拉被拒→compact**。
- 水位线只认 `_serverTs` 且**严格单调**、pull 左闭；**推送被拒必须回拉**（否则两端静默分叉）。
- fakeCloud 必须带身份（`as('openid')`）；测试注入 `createClock()`+`createFakeTimer()`
  （记得把 `now: clock.now` 传进 makeDevice）。
- `npm run test:data` **九脚本 529 条**（contract87/period22/seed14/migrate11/sync128/conflict135/
  cloudid42/partition51/**firstbind39**）。输出格式由 `scripts/_harness.mjs` 统一
  （`createSuite(名)` → `t.ok/t.eq/t.group` → 末尾 `t.done()` 打汇总并设 exitCode）；
  **改测试脚本别再手搓 pass/fail**，否则又会出现「某脚本失败但 test:data 照样成功」。
  `migrate-test` 的历史叫法是 `t.assert`（harness 里有别名）。

## 装配与启动（顺序错会静默失败）
- `db`/`*Repo`/`syncEngine` 全是稳定 Proxy（内部指针可换）→ `rebuildForAccount(uid)` 只换指针，
  视图/store 零改动。`cloud` 单例不随分区重建。
- 启动顺序：`initDataLayer()` → `ensureCloudFirstBind()` → `mount()` → `syncEngine.start()`
  （mount 在前会抛 `ledgerRepo.list is not a function` 且不再重试）。
- 身份变化收尾只走 `stores/account.js` 的 `runIdentityChange(mutate)`；`rebuildForAccount` 不自动 start。
- ⚠️ 端到端验证别 `localStorage.clear()`（会换新匿名 uid 开空分区，像数据丢了）。

## S5 账号体系（改 cloudbaseAdapter 前必读）
- 发码 `getVerification({phone_number})` 返 `{verification_id,is_user}`；登录
  `signInWithSms({verificationInfo,verificationCode,phoneNum})` 返 LoginState（失败 throw）。
- 转正两步：`prepareUpgrade({phone})`=getSession→`signUp({phone,anonymous_token})`（**短信只在这发**，
  字段必须是 `phone`；传 `phone_number` 会注册全新账号）→暂存 `verifyOtp`；`confirmUpgrade({code})`
  消费暂存回调。**verifyOtp 一次性消费**：验证失败即作废，必须重新发码。
- **真机实测（2026-10-01，推翻 fake SDK 前提）**：真 SDK 转正**会换 uid**（4QEhrnqB→21053329…），
  但服务端同一账号记录、云端数据可读；数据层按新 uid 重建分区→`empty-source` 播种→水位 0
  全量**回拉**盖过种子→数据完好（outbox 0、旧分区留盘=备份）。转正必在线，故在线场景
  「绑定后数据原地保留」成立。探针已按真机行为建模（4e uid 会换、4i prefix 跟随），21 条全绿。
- `getAuth()` 必须缓存（authPromise）；`getIdentity()` 不触发登录；两类返回形状用 `unwrap()`/`userOf()` 统一。
- toast 停留 1800ms（useToast），自动化验证抓不到——先装 MutationObserver 记 body 文本再触发。
- **匿名身份是设备绑定的**：`cloud.signOut()` 之后 `ensureSignedIn()` 拿回的 uid 与退出前**相同**，
  所以「匿名退出＝永久失联」不成立。匿名**没有**退出入口（MineView 只在 `phase==='formal'` 渲染按钮），
  匿名分支文案已删（`signOutTitle`/`signOutMessage` 是常量、`danger` 恒 true）。
  口径统一为：匿名唯一的真风险是**清除浏览器数据**（登录态在 localStorage）。
- **「钥匙」= localStorage 四个键**：`lang_/user_info_/credentials_<envId>` + `device_id`。
  实测（2026-10-01）：清掉后重开 → SDK 给**全新 uid + 新 device_id**，云端按 `_openid` 隔离
  → 旧账号的数据（仍在云端）彻底读不到。反之**只**用 `clearLocalData()` 清本地（身份保留）
  → 重载即全量回拉。⇒ 匿名数据**有**云备份，但清浏览器数据后**找不回**；正式账号才可跨设备找回。
- ⚠️ **首访分区错位（S6 记录；按 S7 去匿名后会自然消失，无需单独修）**：`initDataLayer()` 用 `getIdentity()`（**不触发登录**，防 88 次写入），
  设备无身份缓存时 uid=null → 分区落 `ledger_anon`；随后 `ensureCloudFirstBind()` 才登录拿到 uid，
  **分区不重建**。若 `ledger_anon` 带着上个会话的 `syncWatermark`，`ensureFirstBind` 命中
  `already-synced`（写 done、**不入队**）→ **数据一条都不上云**（实测新匿名账号云端 0 条、outbox 0）。
  根因：水位线只证明「某账号在这分区推过」，不证明「**当前**账号推过」。修法方向：分区名 ≠
  `ledger_<accountPrefixOf(uid)>` 时水位线不可信，强制走 `pushLocal`。

## S5-4 退出 / S5-7 首绑（规则写死后别改回去）
- `clearLocalData()` = 清业务 + 清 outbox + **清水位线**，但保留 `schemaVersion`（清了下一次开库会
  **重新播种**）/`seedMeta`/两个导入标记/`partitionMigratedFrom`。
- 退出规则：**先推干净再清本地**；`pendingCount>0` 先同步一轮，推不干净就**抛错取消退出**。
- ⚠️ 退出后**禁止** `switchPartition(null)`：会落 `ledger_anon` 而 uid 是那个匿名账号 → 身份/库名错位
  （看到别分区历史数据 + 莫名弹首绑框 + 后续写操作落错分区）。改为先 `await cloud.ensureSignedIn()`
  问明身份，再 `switchPartition(uid || null)`（离线才退回未认证分区）。
- 首绑逻辑在 `src/api/core/firstBind.js`（纯逻辑 + 依赖注入，Node 可测）。`needs-decision` **必须落盘**
  meta `firstBindPending`（main.js 那次判定没人接住，且 startup 同步会写回水位线 → 之后永久短路）。
  UI 先读标记再实探；裁决两条路都要写 `firstBindDone` 并清 `firstBindPending`。
- 「保留云端」= `clearLocalData()` + 清水位线（**必须**，否则增量拉取一条都回不来）。
- `migratePartitionData` 只搬 `SCHEMA/SEED/IMPORTED/OUTBOX_IMPORTED`，**刻意不搬 WATERMARK**。

## S7 去匿名（**已裁决 2026-10-01，代码待实施**）
- 决策（P10，**五条规则**）：**删掉本地默认匿名用户**。未登录只读可浏览（空账本 0.00 + **分类齐备**），
  写操作（记一笔 / 编辑账单 / 分类增删）一律先弹手机号登录；`cloud=null` 时**不做门禁**（保 S0-3 降级）。
- 连带删除：转正链路（`prepareUpgrade`/`confirmUpgrade`）、**整个 `core/firstBind.js` + 39 条测试**
  —— 因为「本机攒了未登录期数据、要决定推不推上云」这个前提**消失了**（未登录根本写不了）。
- 落点：`ensureSignedIn` 只复用**现有**登录态、拿不到就抛 `NOT_SIGNED_IN`（**绝不 `signInAnonymously`**）；
  未登录分区改名 `ledger_anon` → **`ledger_guest`**（`seed: import.meta.env.DEV ? 'full' : 'base'` + 不继承旧库）；
  `accountPrefixOf(null)` 兜底 `'anon'` → `'guest'`；未登录**不启动** syncEngine。
- **种子分层（S7-9，用户 2026-10-01 追加裁决）**：种子里三样东西性质不同 ——
  **账本 + 分类是「基础设施」**（`buildBase()`，任何分区都播），**~44 条演示账单是「演示数据」**
  （`buildDemoBills()`，**仅 `import.meta.env.DEV`**，生产构建下返回 `[]` 让打包器摇掉）。
  `seed` 参数 boolean → 三态 `'base' | 'full' | false`；`runSeedMigration()` **只在播了演示账单时跑**
  （否则它会把演示账单当「缺失的补充数据」灌进空库）。
  ⚠️ **账号分区兜底播种的分类 `updatedAt` 必须置 0** —— `updatedAt` 新者胜，否则本地刚生成的默认分类
  会在合并时**覆盖用户在云端改过的分类名**（比「没有分类」更糟）。
  ⚠️ `buildInstance()` 原先**根本没传 `seed`**（走默认 `true`）⇒ **所有分区都播全套** ⇒
  新账号首次登录就把 44 条演示账单推上云（实测旁证：匿名分区本地与云端条数完全一致）。
- 登录弹层要从 `MineView`（813 行里的内嵌弹层，带 login/upgrade 两模式）抽成全局
  `LoginSheet.vue` + `useLoginSheet.js`（只留 login）；门禁走 `useLoginGate.requireLogin()`
  + 路由 `meta.requiresAuth`（`/record` 含 `?id=`、`/category*`）。
- ⚠️ 前提：**换号必须先退出**（退出清本地 + 水位线 ⇒ 下次登录必是空库全量回拉）。
  将来若要支持「不退出直接切号」，必须补回本地 / 云端裁决 —— 那正是 S5-7 被删掉的东西。
- ⚠️ 代码改完**不等于**禁用匿名登录：上线前必须去 CloudBase 控制台关「匿名登录」开关。
- 本机现有的 `ledger_anon` / `ledger_<匿名uid>` 数据（各 87~88 条）**将被忽略**（用户已确认）。

## 运行 / 版本 / 选型
- `npm run dev` → 127.0.0.1:5173。不配 `.env.local` 退纯本地（`ledger_anon` 分区）。
  「重置演示数据」清本地+云端再播种（保留两导入标记）。装新包后删 `node_modules/.vite` 再重启 dev。
- ⚠️ **Vite 在本机会漏掉文件变更**：改了代码但 dev server 仍吐**旧编译产物**（`?t=` 是新的、
  内容还是旧的），表现为「代码改了、浏览器行为没变」。判别：`curl localhost:5173/<该模块路径>`
  再 grep 新代码关键字；对不上就是产物过期 → **`touch <file>` 强制刷新**（比重启 dev 快）。
  曾因此把「弹框不出现」误判成模块实例分裂，浪费一轮排查。
- 本机无 Git for Windows，用 WorkBuddy 内置 PortableGit；主分支 main，约定式提交前缀；
  打 tag 时对齐 package.json。不提交 node_modules/dist/.preview；**设计图与 .workbuddy/memory 入库**。
- `.preview/` 子目录装依赖前先放自己的 package.json（否则向上冒泡污染根）。
- 选型教训：LeanCloud 停服弃用；Supabase 国内直连不稳弃用；终选 CloudBase（2026-09-29 拍定）。
