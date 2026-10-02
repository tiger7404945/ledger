# 项目长期记忆 · 随手记账（D:\projects\ledger）

> 只留「改动前必须先知道」的规则。细节：`phase2-backend-plan.md`（S0–S6 任务与实施记录）、
> `CLOUD-S4-NOTES.md`（云端/同步实测）、同目录 `YYYY-MM-DD.md` 日志。

## 阶段
Vue3+Vite 记账 Web App。设计稿=根目录 9 张 jpg（统计页无稿）。v0.2.0 前端完成；
**S0–S5、S7 全部完成**，云端=用户自有腾讯云开发 CloudBase（envId 只在 `.env.local`）。
**S7 = 去掉匿名身份 + 写操作登录门禁**（2026-10-01 裁决、2026-10-02 凌晨实施完毕，见下）。
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
- 库名 `ledger_<账号前缀8位>`（`accountPrefixOf`），**未登录 = `ledger_guest`**（`GUEST_ACCOUNT_PREFIX`）；
  版本 2，store：ledger/category/bill/outbox/meta。
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
- `npm run test:data` **九脚本 555 条**（contract87/period22/seed28/migrate11/sync134/conflict135/
  cloudid42/partition67/**gate**29）。输出格式由 `scripts/_harness.mjs` 统一
  （`createSuite(名)` → `t.ok/t.eq/t.group` → 末尾 `t.done()` 打汇总并设 exitCode）；
  **改测试脚本别再手搓 pass/fail**，否则又会出现「某脚本失败但 test:data 照样成功」。
  `migrate-test` 的历史叫法是 `t.assert`（harness 里有别名）。

## 装配与启动（顺序错会静默失败）
- `db`/`*Repo`/`syncEngine` 全是稳定 Proxy（内部指针可换）→ `rebuildForAccount(uid)` 只换指针，
  视图/store 零改动。`cloud` 单例不随分区重建。
- 启动顺序：`initDataLayer()` → `mount()` → `syncEngine.start()`（**仅已登录**）
  （mount 在前会抛 `ledgerRepo.list is not a function` 且不再重试）。
  S7 删掉了原来的第 ② 步 `ensureCloudFirstBind()`，并把启动同步收进 `if (cloud?.signedIn)`。
- 身份变化收尾只走 `stores/account.js` 的 `runIdentityChange(mutate)`；`rebuildForAccount` 不自动 start。
- ⚠️ 端到端验证别 `localStorage.clear()`（会丢登录态、让分区落回 `ledger_guest`，看起来像数据丢了）。

## 账号体系（改 cloudbaseAdapter 前必读）
- 发码 `getVerification({phone_number})` 返 `{verification_id,is_user}`；登录
  `signInWithSms({verificationInfo,verificationCode,phoneNum})` 返 LoginState（失败 throw）。
- `getAuth()` 必须缓存（authPromise）；`getIdentity()` **不触发登录**；两类返回形状用 `unwrap()`/`userOf()` 统一。
- **`getIdentity()` 必须把匿名登录态判为「未登录」**（返 `{uid:null,isAnonymous:true}`）——
  旧版本遗留在 localStorage 的匿名会话会伪装成已登录（实测显示「已登录 · 0OuzUrrt」并开错分区）。
  改身份逻辑时别把这个判空删掉。
- **「钥匙」= localStorage 四个键**：`lang_/user_info_/credentials_<envId>` + `device_id`。
  清掉后重开 → SDK 给全新身份，云端按 `_openid` 隔离 → 旧账号数据彻底读不到（但仍在云端）。
  反之只用 `clearLocalData()` 清本地（身份保留）→ 重载即全量回拉。⇒ 正式账号才可跨设备找回。
- toast 停留 1800ms（useToast），自动化验证抓不到 —— 先装 MutationObserver 记 body 文本再触发。
- **S5 的「匿名转正 / 首绑裁决」已随 S7 整体删除**（`prepareUpgrade`/`confirmUpgrade`/`core/firstBind.js`）。
  留下的唯一教训：真机实测证明**转正会换 uid**（fake SDK 模拟不出来），所谓「绑定后数据原地保留」
  从来不是免费的 —— 它靠的是「新分区 `empty-source` 播种 + 水位 0 全量回拉」这套兜底。

## 退出登录 / 本地清空（规则写死后别改回去）
- `clearLocalData()` = 清业务 + 清 outbox + **清水位线**，但保留 `schemaVersion`（清了下一次开库会
  **重新播种**）/`seedMeta`/两个导入标记/`partitionMigratedFrom`。
- 退出规则：**先推干净再清本地**；`pendingCount>0` 先同步一轮，推不干净就**抛错取消退出**。
- ⚠️ **清水位线才能全量回拉** —— 清了业务数据却不清水位线，增量拉取一条都回不来。
- 退出后 `switchPartition(null)` → 落 `ledger_guest`。S5 时这条**被禁止过**（当时 `null` 会落
  `ledger_anon`，而身上还挂着那个匿名 uid → 身份/库名错位、莫名弹首绑框）；S7 去匿名后 uid 真为
  `null`，禁令才反过来成立。**别再照 S5 的注释把 `switchPartition(null)` 禁掉。**
- `migratePartitionData` 只搬 `SCHEMA/SEED/IMPORTED/OUTBOX_IMPORTED`，**刻意不搬 WATERMARK**。
  ⚠️ **账号分区仍会从裸库 `ledger` 继承**（`index.js`：`migrateFrom: partitioned && !isGuest ? DB_NAME : false`）。
  真机实测撞到（2026-10-02）：手机裸库里的**旧版演示种子**（`bill_seed_001~029` + `gap`，**无 extra** ⇒ EXTRA 特性之前的老版本）
  在登录建 `ledger_<uid>` 时被搬进来（reason `migrated`），再被 `enqueueLocalForCloud()` 整体入队推上云
  ⇒ 新账号凭空多出 30 条演示账单，**击穿 S7「全新账号 0 账单」这条线**。
  S7 之后未登录写不了 ⇒ 裸库/旧分区里的账单只可能是旧的演示或匿名数据，**继承它没有正当收益**（关不关待用户决策）。
- ⚠️ **真机验证必须换干净环境**：同一浏览器里残留的 `ledger_guest`/裸库会在登录时被搬进账号分区并推上云。
  用**无痕窗口**打开，或先清掉该站点数据，否则验证结果必然被污染（看起来像「种子又灌进来了」）。
- 首绑裁决（`core/firstBind.js` / `firstBindPending` / `firstBindDone`）**已整体删除**，别再加回来。

## S7 去匿名（**已完成 2026-10-02**）
- 决策（P10，**五条规则**）：**删掉本地默认匿名用户**。未登录只读可浏览（空账本 0.00 + **分类齐备**），
  写操作（记一笔 / 编辑账单 / 分类增删）一律先弹手机号登录；`cloud=null` 时**不做门禁**（保 S0-3 降级）。
- **落点（全部生效）**：`ensureSignedIn()` 只复用现有登录态、拿不到就抛 `NOT_SIGNED_IN`
  （**绝不 `signInAnonymously`**）；未登录分区 `ledger_guest`；`accountPrefixOf(null)` → `'guest'`；
  未登录**不启动** syncEngine，且 `sync()` 直接短路（`cloud.signedIn === false` → `reason:'not-signed-in'`；
  用 `=== false` 是为了别误拦没实现该属性的 fakeCloud）。
- **种子分层（S7-9）**：`buildBase()`（账本 + 42 分类 = **基础设施**，任何分区都播）与
  `buildDemoBills()`（演示账单，**仅 `import.meta.env.DEV`**，生产构建返回 `[]`）。
  `seed` 参数三态 `'base' | 'full' | false`；`runSeedMigration()` **只在播了演示账单时跑**。
  分区取值（**2026-10-02 修订**）：**所有分区常规启动恒 `'base'`** —— guest 开发构建也不播
  演示账单（用户实测发现「未登录账单页还有 13768.50 演示收入」，容易当成没清理的脏数据）；
  `'full'` 只留给「重置演示数据」抬档（`pendingResetMode`）。
  账号分区恒 `'base'` + `seedCategoryUpdatedAt: 0`。
- ⚠️ **老 guest 库的一次性清理**：`buildInstance` 对 guest 传 `purgeSeedBills: true` —— 首次启动
  清空 BILL store（未登录写路径被门禁拦着，guest 库里的账单**只可能来自种子**，整批清是安全的），
  落 meta `SEED_BILLS_PURGED` 保证只清一次（**不然重置灌进去的演示账单活不过下次启动**；
  抬档 FULL 那次 init 跳过清理但**照样落标记**）。⚠️ `snapshot().meta` 只含 **seedMeta 子对象**，
  顶层 meta 标记要 `readMeta()` 直读。
- ⚠️ **账号分区兜底播种的分类 `updatedAt` 必须置 0** —— 否则「新者胜」会让本地刚生成的默认分类
  **覆盖用户在云端改过的分类名**（比「没有分类」更糟）。
- ⚠️ **门禁必须注册在 `installRecordDraftGuard` 之前**，否则被拦下的导航会被草稿守卫当成
  「离开记账链路」而清掉草稿。直接访问 `#/record` 时守卫要返回 `{path:'/',replace:true}`
  （首次进入没有上一页，`return false` 会白屏）。
- ⚠️ `liveGateContext()` 取 `cloud?.signedIn === true || account.signedIn` 的**并集**，且 `main.js`
  挂载后立刻 `bootstrap()` —— 否则「已登录但没进过我的页」会被假拦截。
- **登录后的数据上云**：`db.enqueueAll()`（meta `LOCAL_PUSHED` 幂等）+ 一次全量 `sync()`，
  取代已删的 `ensureCloudFirstBind`。⚠️ **换号必须先退出**（`signInWithPhone` 注释里写死了）。
- ⚠️ 代码改完**不等于**禁用匿名登录：上线前必须去 CloudBase 控制台关「匿名登录」开关。
- 旧的 `ledger_anon` / `ledger_<匿名uid>` 库**不再被读取**（实测仍在盘上各 46 条，留作备份）。
- **已知取舍（别当成 bug 重查）**：生产包应用 chunk 里仍有演示文案（`地铁通勤`/`星巴克`）——
  `SEED_BILL_NOTES`（导出常量）与 `buildExtraBills`（导出函数）是给**开发期遗留本地库做历史回填**的
  公开 API，依赖模板数组，一经导出即**不可摇**。功能上生产**不会写入**演示账单；要根治得把整块
  改成 dev-only 的动态 `import()`。
- **未验**：真实云端登录往返（需真机短信）—— `partition-test` 67 条提供等价覆盖。

## 运行 / 版本 / 选型
- `npm run dev` → 127.0.0.1:5173。不配 `.env.local` 退纯本地（`ledger_guest` 分区，**门禁不生效**）。
  ⚠️ **「重置演示数据」按钮已删（2026-10-02，用户裁决：没有演示数据就没有重置）** ——
  演示数据无任何 UI 入口，`seed:'full'` 只剩测试在用；要灌演示数据只能测试脚本或 devtools。
  装新包后删 `node_modules/.vite` 再重启 dev。
- ⚠️ **改 `.env.local` 会让正在跑的 Vite 自动重启**；原端口还被占着时它会**自动降级到 5174**。
  此时「另起一个实例」很可能其实是漂移过去的旧实例（曾据此差点把验证结论弄反）。
  要验环境变量差异，**用全新端口另起，别去动跑着的那个的配置文件**。
- ⚠️ **Vite 在本机会漏掉文件变更**：改了代码但 dev server 仍吐**旧编译产物**（`?t=` 是新的、
  内容还是旧的），表现为「代码改了、浏览器行为没变」。判别：`curl localhost:5173/<该模块路径>`
  再 grep 新代码关键字；对不上就是产物过期 → **`touch <file>` 强制刷新**（比重启 dev 快）。
  曾因此把「弹框不出现」误判成模块实例分裂，浪费一轮排查。
- 本机无 Git for Windows，用 WorkBuddy 内置 PortableGit；主分支 main，约定式提交前缀；
  打 tag 时对齐 package.json。不提交 node_modules/dist/.preview；**设计图与 .workbuddy/memory 入库**。
- `.preview/` 子目录装依赖前先放自己的 package.json（否则向上冒泡污染根）。
- 选型教训：LeanCloud 停服弃用；Supabase 国内直连不稳弃用；终选 CloudBase（2026-09-29 拍定）。
