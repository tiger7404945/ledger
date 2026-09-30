# 项目长期记忆 · 随手记账（D:\projects\ledger）

> 只留「改动前必须先知道」的规则。细节：`phase2-backend-plan.md`（S0–S6 任务与实施记录）、
> `CLOUD-S4-NOTES.md`（云端/同步实测）、同目录 `YYYY-MM-DD.md` 日志。

## 阶段
Vue3+Vite 记账 Web App。设计稿=根目录 9 张 jpg（统计页无稿）。v0.2.0 前端完成；
**S0–S5 主体完成**（S5-4/S5-7 待办），云端=用户自有腾讯云开发 CloudBase（envId 只在 `.env.local`）。
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
- `npm run test:data` 八脚本 479 条（contract87/period22/seed14/migrate11/sync128/conflict135/cloudid42/partition51）。

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

## 运行 / 版本 / 选型
- `npm run dev` → 127.0.0.1:5173。不配 `.env.local` 退纯本地（`ledger_anon` 分区）。
  「重置演示数据」清本地+云端再播种（保留两导入标记）。装新包后删 `node_modules/.vite` 再重启 dev。
- 本机无 Git for Windows，用 WorkBuddy 内置 PortableGit；主分支 main，约定式提交前缀；
  打 tag 时对齐 package.json。不提交 node_modules/dist/.preview；**设计图与 .workbuddy/memory 入库**。
- `.preview/` 子目录装依赖前先放自己的 package.json（否则向上冒泡污染根）。
- 选型教训：LeanCloud 停服弃用；Supabase 国内直连不稳弃用；终选 CloudBase（2026-09-29 拍定）。
