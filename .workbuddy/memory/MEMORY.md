# 项目长期记忆 · 随手记账（D:\projects\ledger）

> 只留「改动前必须先知道」的规则。细节：`phase2-backend-plan.md`（S0–S6 任务与实施记录）、
> `CLOUD-S4-NOTES.md`（云端/同步实测）、同目录 `YYYY-MM-DD.md` 日志。

## 阶段
Vue3+Vite 记账 Web App。设计稿=根目录 9 张 jpg（统计页无稿）。v0.2.0 前端完成；
**S0–S5、S7、S8 全部完成**，云端=用户自有腾讯云开发 CloudBase（envId 只在 `.env.local`）。
**S7 = 去掉匿名身份 + 写操作登录门禁**（2026-10-01 裁决、2026-10-02 凌晨实施完毕，见下）。
**S7-10（2026-10-02）= 关闭裸库继承 + 记账/首页功能裁剪**（见「功能裁剪」节）。
**S8 = 上线收尾**：S8-1 数据备份/导入、S8-2 同步状态补全、S8-3 恢复模式、S8-4「我的」页精简 + 注销账号、
S8-5 schema 瘦身、S8-6 注销文案精简 + 微信打赏卡、S8-7 删种子分类「卤鹅」
（见「数据备份」「注销账号」「schema 瘦身」「种子分类的增删」四节）。
剩余上线项：正式域名/安全域名白名单（⚠️ 2026-10-02 实测：`*.tcloudbaseapp.com` 测试域名现在会先弹
一个免责提示页，需点「确定访问」才能进 App —— 正式域名这件事的实际收益又多了一条）、真机系统终验、打 `v1.0.0`。
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
- **分类总数 41**（支出 16 个一级 / 34 条 + 收入 7 条）。改种子分类数会让一堆断言挂掉：
  `partition-test` 12b/12g/12j/13c/16a/16f/16j、`seed-test` 1b-2/1b-9/1b-14、
  `sync-test` 20a/20b/20f/20g 都写死了条数，记得一起改。

## 种子分类的增删（S8-7，改 `CATEGORY_TREE` 前必读）
- 删一个种子分类 = **三处都要动**：① `CATEGORY_TREE` 删条目 + 加进
  `REMOVED_SEED_CATEGORY_IDS`（用 `CAT_ID(key)`，**别写名字**）；② 本地由
  `idbAdapter#purgeRemovedCategories()` 在 `init()` 里清（**排在播种之后、每次都跑、不落标记**）；
  ③ **云端管理端先删**（`ledger_categories` 里 `_id = <账号前缀>_cat_xxx`）。
- ⚠️ 顺序不能反：云端没删就发版 ⇒ 新设备首登水位线 0 全量回拉会把它拉回来；清理若是一次性
  （落标记），它就永远赖在那台设备上。所以这里**刻意不落标记**（跟 `DEPRECATED_FIELDS_PURGED`
  的写法不同，别「统一」过去）。
- ⚠️ **只按固定 id 匹配，绝不按名字**：用户自建同名分类（id 是 `uid('cat')`）必须活着。
- 与 S8-5 同纪律：**不动 `updatedAt`、不入 outbox**（入队会被判「本地更新」推上去顶掉别的设备）。
- 挂在该分类下的账**一笔记不能删**（那是用户真实支出），`query.js` 兜底显示「未分类」。

## 数据层 / IndexedDB
- 库名 `ledger_<账号前缀8位>`（`accountPrefixOf`），**未登录 = `ledger_guest`**（`GUEST_ACCOUNT_PREFIX`）；
  **库版本 3**（v3 = S8-5 删掉 BILL 的死索引 `month`），store：ledger/category/bill/outbox/meta。
- ⚠️ **`DB_VERSION` ≠ `SCHEMA_VERSION`**：前者只管 objectStore/索引结构（升它安全）；
  后者记在 meta 里、决定「要不要播种/接管」——**bump 它会触发重新播种、用种子覆盖用户数据**，
  绝对不能拿它当迁移版本号用（补数据走 `SEED_EXTRA_VERSION` 那类独立标记）。
- ⚠️ 改 store/索引结构时，`createObjectStore` 分支**只在建新库时跑**，已存在的表要在
  `onupgradeneeded` 里用 `dropIndexIfExists(tx.objectStore(x), 'name')` 显式处理
  （直接 `deleteIndex` 不存在时会抛 `NotFoundError`）。真机（Chromium）v2→v3 实测通过。
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
  pull 按 `_serverTs` 过滤 ⇒ **本地种子的 `updatedAt=0` 不影响回拉**（sync-test 20 段回归锁死）。
- fakeCloud 必须带身份（`as('openid')`）；测试注入 `createClock()`+`createFakeTimer()`
  （记得把 `now: clock.now` 传进 makeDevice）。
- **IndexedDB 连接会 被 Chromium 单方面杀掉**（清数据/长会话/无痕高发）：连接层必须探活+自动重连
  （`createIdbConnection()`，adapter/outboxStore/kv 三处共用），且**打开失败的拒绝不能被缓存**。
  任何「句柄一次性缓存」在浏览器环境都要假定它可能被宿主杀死。
- **身份切换后 store 必须刷两次**：`runIdentityChange` 里 sync **之前**那次 resetLoadedStores 读到的是
  「登录瞬间的空库」；回拉写库后**没人通知 store**（`initialized` 已置真，页面切换全是 no-op）——
  真机表现为重登后分类宫格空白。修法：sync 完成后**再** `resetLoadedStores()` 一次；
  且它必须同时重置 `bill.periodInitialized`（账单页/统计页的区间切片有独立守卫）。
  gate-test 第 4 段用源码扫描锁死这条时序。
- `npm run test:data` **十脚本 749 条**（contract87/period22/seed28/migrate11/sync143/conflict135/
  cloudid42/partition118/**gate**61/**backup**102）。输出格式由 `scripts/_harness.mjs` 统一
  （`createSuite(名)` → `t.ok/t.eq/t.group` → 末尾 `t.done()` 打汇总并设 exitCode）；
  **改测试脚本别再手搓 pass/fail**，否则又会出现「某脚本失败但 test:data 照样成功」。
  `migrate-test` 的历史叫法是 `t.assert`（harness 里有别名）。

## schema 瘦身（S8-5，2026-10-02）—— 已删的东西别加回来
- **判据只有一条：从写入到读取有没有消费者。** 有就留（哪怕看着别扭），没有就删。
- **已删字段**：账单 `noReimburse`（开关 S7-10 已下线 / 写入恒 false）、账单 `version`
  （从未被读取 —— 裁决走 `updatedAt` + 云端 `serverUpdatedAt`）、账本 `ownerId`（恒 `'user_local'`，
  云端归属靠 `_openid`、本地靠库分区）。**本地与云端都清了**。
- **已删索引**：BILL 的 `month` —— 建在一个**从未写入的字段**上，且**全项目不用索引查询**
  （一律 `readAll` 全表读 + JS 过滤），恒为空。库版本 2 → 3。
- **已删文件**：`adapters/leancloudAdapter.js`（零引用，全是 `throw NotImplementedError`）。
- **已删资源**：静态托管 12 个历史 hashed 产物（23 → 11 个文件）。
- ⚠️ **刻意保留**：`serverUpdatedAt` / `_serverTs`（**两者分工不同，不是冗余**：前者是 S4-6 裁决刻度、
  后者是水位线）、legacy localStorage 两键与 `importedFromLocalStorage`/`outboxImported`（找回旧数据的退路）、
  `partitionMigratedFrom`/`partitionClaimedBy` + `migratePartitionData`（S7-10 关了继承但能力保留，测试在测）、
  `BILL_TYPES.transfer/lending`（历史文档要能过同步）、`mockAdapter.js`（契约对照基准 + 测试基座）。
- **本地清理迁移**（`idbAdapter#purgeDeprecatedFields`，meta 标记 `deprecatedFieldsPurged`）：
  ⚠️ **不动 `updatedAt`、不入 outbox** —— 抬时间戳会让这条账被判成「本地更新」而 push，
  既覆盖云端又可能盖掉别人设备上的新修改。不入队则两端各清各的，用户真去改这条账时
  `.set()` 整份覆盖会自然收敛（partition-test 17e/17f 钉死）。
- ⚠️ **绝不能用 bump `SCHEMA_VERSION` 实现字段迁移**：那个版本号对不上会触发**重新播种**
  （`mode` 恒 `'base'`），用固定 id 的种子覆盖用户自己记的账。必须走独立标记。
- **云端清理**走管理端 `$unset`（`writeNoSqlDatabaseContent`，`isMulti: true`），不是等客户端推送收敛
  —— 本地没改过的文档永远不会被重新 push。清理前的字段级备份在
  `.preview/cloud-schema-cleanup-backup-2026-10-02.json`。
- **顺手抓到的漏网之鱼**：`RecordView.vue` 提交 payload 里的 `noReimburse: false`。
  多一个字段不会让任何测试失败，但 `update` 走 `{...doc, ...patch}` ⇒ 编辑老账会把它**种回库里**。
  ⇒ **删字段时要把「写入点」逐个找出来**（create / update / seed / backup 白名单 / 页面提交 payload），
  gate-test 第 6 节现用源码扫描把它们全钉住。

## 数据备份（S8-1 / S8-3，改 backup 相关代码前必读）
- 纯逻辑全在 `core/backup.js`（**两个 planner**）；适配器只有 `backup.dump()`（原始快照，
  **含墓碑**）与 `backup.apply({create,update,remove})`（直写 + `enqueueMany`）。
  装配层 `exportBackup` / `previewImport`（一次返回 `plan` + `restore` 两份计划）/
  `applyImport({ mode, data })`。
- **导入绝不走 `create()`/`update()`**（会重造 id / 改时间戳 ⇒ 幂等破功）。两种模式各自幂等：
  - `planImport`（**合并**，默认）靠「保留备份原始 `updatedAt` + **严格大于**才覆盖」；
  - `planRestore`（**恢复**，以备份为准）**不看 `updatedAt`**，靠 `sameDoc()` 逐字段比对 +
    「`remove` 只挑活文档」。
- ⚠️ **「导出 → 删错 → 再导入」在合并口径下不会恢复**（删除是软删 ⇒ 墓碑 `updatedAt` 必然
  比备份新 ⇒ 判本地更新而跳过）。这不是 bug，是合并模式的必然；该场景由恢复模式承担。
  两个诉求在「本地墓碑」这一点上正面冲突，**别试图用一条规则同时满足**（放宽合并会破坏
  「旧备份不覆盖新数据」）。
- 恢复的 `remove` **只能软删**（写墓碑 + `updatedAt = now()`）；**账本保护**：备份里没有账本时
  不删本机账本。恢复必须过 `ConfirmDialog` 二次确认（`mask-closable=false`，正文含精确到秒的
  导出时刻 —— `utils/date.js#formatFullTimeCN`）。
- `applyImport` 收的是**备份数据本身**（`backup.data`）而不是预览计划 —— 恢复需要全量，
  只传计划会漏掉合并口径下被跳过的那些。落盘前仍用最新本地副本重算一次。
- **导出不走登录门禁（读操作），导入必须走**（批量写 + 入队上云）—— backup-test 第 7 节源码扫描守卫。
- 「我的」页「上次同步」用 `syncEngine.lastSuccessAt`（本地时刻），**别改回水位线 `lastSyncAt`**
  （服务端时间轴的值，显示出来会出现「刚同步完却写着昨天」）。

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
  ⚠️ **账号分区的裸库继承已关闭（S7-10，2026-10-02 拍板）**：`api/index.js` 恒传 `migrateFrom: false`、
  `claimant` 下线 —— 真机实证裸库里的旧演示种子会被搬进账号分区再推上云（击穿「全新账号 0 账单」），
  继承没有正当收益 ⇒ **登录后只信云端**。适配器的迁移能力保留（partition-test 7/10/11 节），
  恢复迁移=改回一行；**回归守卫 = partition-test 第 15 节源码扫描**（剥注释后断言值只能是 false），
  别删。
- ⚠️ **真机验证必须换干净环境**：同一浏览器里残留的 `ledger_guest`/裸库会在登录时被搬进账号分区并推上云。
  用**无痕窗口**打开，或先清掉该站点数据，否则验证结果必然被污染（看起来像「种子又灌进来了」）。
- 首绑裁决（`core/firstBind.js` / `firstBindPending` / `firstBindDone`）**已整体删除**，别再加回来。

## 注销账号（S8-4，2026-10-02，与「退出登录」是两套语义，别互相套用）
- **语义分野**：退出 = 「先保数据再清」（`pendingCount>0` 推不干净就**取消退出**）；
  注销 = 「**先清云端 → 再清本地 → 最后登出**」，不可为保数据而阻拦（数据本就要没）。
- **顺序是硬约束**：① `cloud.deleteAccount()`（内部先 `ensureSignedIn()`；**登出后它会抛 `NOT_SIGNED_IN`，
  一条都删不掉**）→ ② `db.deleteLocalData()`（**必须在 `switchPartition(null)` 之前**，否则清的是 `ledger_guest`）
  → ③ `cloud.signOut()` + `switchPartition(null)`。整段包在 `runIdentityChange()` 里。
- **`deleteLocalData()` vs `clearLocalData()`**：前者 = 清四表（ledger/category/bill/meta）+ 清 outbox
  + **抹掉 meta（含 `schemaVersion`）** + 清第一阶段遗留的 localStorage 两键（`clearLegacyLocalKeys()`，
  即 `LEGACY_DB_KEY`/`LEGACY_OUTBOX_KEY`）⇒ 回到**出厂态**；后者保留 meta（分区会被同账号复用、退出后全量回拉）。
- **「清回出厂态」三件缺一不可**：清业务表 + **抹 meta** + **清遗留键**。
  留 `schemaVersion` ⇒ 同号再登录 `init()` 跳过播种 ⇒ 空宫格；抹 meta 却不清遗留键 ⇒ `readLegacy()` 把旧库**重新导入** ⇒ 数据复活。
- ⚠️ **刻意不走 `indexedDB.deleteDatabase()`**（实测结论）：别的连接（其他标签页）开着时删除请求进 `blocked`
  被**永久挂起**，且此后 `open()` 同一库会**排到该挂起请求后面** ⇒ 「删不掉就退回去清表」的兜底**自己把自己锁死**
  （fake-indexeddb 复现，与规范一致；曾让 partition-test 整脚本挂死 exit=124）。
  等价的「清表 + 抹 meta + 清遗留键」是安全解，**别为「更彻底」把 dropDatabase 加回来**。
- **平台侧的账号记录删不掉**（如实告知用户）：`auth.deleteUser(DeleteMeReq)` 内部强制
  `validateParams({password:{required:true}})` → `sudo({password})` 换 `sudo_token`；短信登录账号从无密码，
  另一条路（`verification_token`）要用户当场再收一次短信，得不偿失 ⇒ 注销落地为「云端数据清空 + 本机数据清空 + 登出」。
  ⚠️ **S8-6 用户裁决反转**：确认文案**不得**再写「平台侧的账号记录会保留」—— 只讲代价本身，
  gate-test 5j 是反向断言（`!/账号记录/.test(mineSrc)`），注意 MineView 注释里也别出现这四个字。
- **二次确认**：`ConfirmDialog` 的 `mask-closable=false`（不可逆操作不让手滑点遮罩定夺）、正文 `white-space: pre-line`
  （让 `\n\n` 分段生效）、确认键写「永久注销」/取消键「再想想」。「注销账号」按钮**只负责开确认框**，
  绝不可直绑 `doDeleteAccount(`；gate-test 第 5 节（5a~5j）源码扫描锁死这几点 + 三步顺序。

## S7 去匿名（**已完成 2026-10-02**）
- 决策（P10，**五条规则**）：**删掉本地默认匿名用户**。未登录只读可浏览（空账本 0.00 + **分类齐备**），
  写操作（记一笔 / 编辑账单 / 分类增删）一律先弹手机号登录；`cloud=null` 时**不做门禁**（保 S0-3 降级）。
- **落点（全部生效）**：`ensureSignedIn()` 只复用现有登录态、拿不到就抛 `NOT_SIGNED_IN`
  （**绝不 `signInAnonymously`**）；未登录分区 `ledger_guest`；`accountPrefixOf(null)` → `'guest'`；
  未登录**不启动** syncEngine，且 `sync()` 直接短路（`cloud.signedIn === false` → `reason:'not-signed-in'`；
  用 `=== false` 是为了别误拦没实现该属性的 fakeCloud）。
- **种子分层（S7-9）**：`buildBase()`（账本 + 41 分类 = **基础设施**，任何分区都播；41 是 S8-7 删「卤鹅」后的数）与
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
- **真机已验（2026-10-02，无痕窗口 + 控制台独立核对）**：全新账号登录云端恰为 1/42/0（兜底分类推云、0 账单）；
  换机登录回拉 ¥168 账单；记一笔待同步归零、云端 1 条（`_id` 带账号前缀）；退出清本地不弹裁决框。
  仍待验：多设备并发写；退出→换号登录的完整矩阵。

## 功能裁剪（S7-10，2026-10-02 用户拍板，别「顺手加回来」）
- **记账页**：类型 Tab 只留**支出/收入**（转账/借贷从未真正建模，提交时折叠成 expense）；
  胶囊只留「今天 / 账本」（资产账户、图片、不报销已删）。~~`noReimburse` 契约字段**保留**但读写恒 `false`~~
  —— **该字段已于 S8-5 连同旧值一起删除**（见「schema 瘦身」节），别再引用它
  （否则编辑老账会把旧值隐形带下去）；草稿里也没有它了。
- **首页**：总览三列 = 本月收入 / **本月结余**（`summary.balance`，前端不自算）/ 日均支出；
  「自动记账」「净资产」两卡已删；「添加卡片 + 编辑首页」合并为单个「编辑分类」（都跳 `/category`）。
- `BILL_TYPES` 枚举保留 transfer/lending（历史文档要能过同步），只在 JSDoc 标注「不再产出」。
- `page-structure.md` 已同步标注「原稿 XX 已裁」，设计稿本身没改。

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
