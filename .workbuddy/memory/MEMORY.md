# 项目长期记忆 · 随手记账（D:\projects\ledger）

> 只留「改动前必须先知道」的规则。细节：`phase2-backend-plan.md`（S0–S9 实施记录）、
> `CLOUD-S4-NOTES.md`、同目录 `YYYY-MM-DD.md` 日志。

## 阶段
Vue3+Vite 记账 App。**S0–S8 全部完成**（S8-1 备份/导入、S8-2 同步状态、S8-3 恢复模式、
S8-4 注销账号、S8-5 schema 瘦身、S8-6 打赏卡、S8-7 删卤鹅、S8-8/S8-9 吃喝/购物组填充风图标）。
云端=用户自有腾讯云 CloudBase（envId 只在 `.env.local`）。剩余上线项：正式域名
（tcloudbaseapp 测试域名现带免责提示页）、真机终验、打 v1.0.0。标签 v0.1~v0.5 已打。

## 强制约定（违反返工）
- 视图不直调 adapter，只用 `api/index.js` 代理的 repo 与 Pinia store；写操作 local-first + `outbox.enqueue`。
- 业务/合并规则只在 `src/api/core/` 写一次；后端可替换（换厂商只动适配器层，已两次生效）。
- 云端资源一律 `ledger` 前缀，出口 `src/config/cloud.js`，不手写资源名。
- **图标两套风格共用 24×24 画布**：旧线性 stroke=currentColor；吃喝/购物组填充风在
  `icons/foodFill.js`、`shopFill.js`（`<g stroke="none" transform="scale(24/512)">` 外壳）。
  **别手改路径**，重生成跑 `node scripts/convert-fill-icons.mjs`（多批次 BATCHES 配置，
  加新批次往里加再重跑；预览页 `node scripts/build-icon-preview.mjs` 生成）。
  大小调 `CATEGORY_ICON_RATIO`（icons/index.js，现 0.65）。新 key 要进 `ICON_GROUPS` 对应组。

## 高频陷阱
- **账单 store 两份切片勿合并**：首页 `month/bills/summary`；账单页+统计页 `period*`
  （进统计页用 `ensurePeriodLoaded()`）。写操作两份都刷。
- 滑动只用 `useSwipeViews`；区间一律 `from`/`to`；TabBar 页禁 `padding:0 14px` 简写。
- 种子：本月支出 **8720.72** 别动；补数据走 `SEED_EXTRA_VERSION`+`migrate()`，
  **别 bump SCHEMA_VERSION**。**分类总数 41**（改种子分类数要同步改 partition/seed/sync
  测试里写死的条数，见 phase2-backend-plan S8-7）。
- 改视觉先像素采样（比例 2.844，裁状态栏，垂直线扫色跳变量高度）；单张稿孤立色值不可信。

## 数据层 / IndexedDB
- 库名 `ledger_<账号前缀8位>`，未登录 `ledger_guest`；**库版本 3**，store：ledger/category/bill/outbox/meta。
- ⚠️ **`DB_VERSION` ≠ `SCHEMA_VERSION`**：bump 后者会**触发重新播种、用种子覆盖用户数据**，
  绝不能拿它当迁移版本号。升级索引用 `dropIndexIfExists`；`toPlain()` 后再 put；读-改-写分两个事务。
- 裸库只被认领一次；`migratePartitionData` 五种 reason **只有 `empty-source` 播种**。

## 同步引擎
- 装配唯一（api/index.js）；顺序固定 **pull→push→回拉被拒→compact**；防重入 return 同一 Promise。
- 水位线只认 `_serverTs` 严格单调；**推送被拒必须回拉**。种子 `updatedAt=0` 不影响回拉。
- **IDB 连接会被 Chromium 杀**：连接层探活+自动重连，打开失败的拒绝不能被缓存。
- **身份切换后 store 必须刷两次**（sync 完成后再 `resetLoadedStores()`，含 `bill.periodInitialized`）。
- `npm run test:data` **十脚本 769 条**（contract87/period22/seed28/migrate11/sync143/conflict135/
  cloudid42/partition124/gate75/backup102），输出统一走 `scripts/_harness.mjs`，别手搓 pass/fail。

## 清理/迁移纪律（S8-5/8-7，已删的东西别加回来）
- 判据：从写入到读取有没有消费者。已删：账单 `noReimburse`/`version`、账本 `ownerId`、
  BILL `month` 索引、leancloudAdapter。**删字段要把写入点找全**（gate 第 6 节源码扫描钉住）。
- 清理类操作（废弃字段/分类/图标刷新）：**不动 `updatedAt`、不入 outbox**。
- ⚠️ 云端清理走管理端 `$unset`/`$set`/delete，**`isMulti: true` 且别带 `_openid` 条件**
  （云端有多个账号的数据）；本地侧靠「每次 init 都跑」的自愈兜底。
- **删种子分类 = 三处联动**：`CATEGORY_TREE`+`REMOVED_SEED_CATEGORY_IDS`（按固定 id 不按名字）、
  `purgeRemovedCategories()`（每次 init 跑、**不落一次性标记**，防云端回拉残留永留）、云端先删。
- **改种子分类图标**：`CATEGORY_ICON_REFRESH` + `refreshSeedCategoryIcons()`（守卫 `icon === from`
  才动）。**同 key 覆盖的填充风图标不需要它**（历史库自动换新）。

## 数据备份（S8-1/8-3）
- 两个 planner：合并（保备份 `updatedAt`、严格大于才覆盖）/ 恢复（不看 updatedAt、remove 只挑活文档）。
  **导入绝不走 create()/update()**；「导出→删→合并导入」不恢复是必然（墓碑比备份新），由恢复模式承担。
- 恢复 remove 只软删；备份无账本时不删本机账本；恢复必过 ConfirmDialog。
- **导出不过登录门禁、导入必须过**。上次同步显示用 `syncEngine.lastSuccessAt` 别用水位线。

## 装配 / 账号 / 退出 / 注销
- 启动顺序：`initDataLayer()` → `mount()` → `syncEngine.start()`（仅已登录）。
- **S7 去匿名**：未登录只读（`ledger_guest`），写操作弹登录；`cloud=null` 不做门禁。
  种子分层：`buildBase()` 41 分类恒播；`buildDemoBills()` 仅 DEV；分区启动恒 `'base'`。
  上线前必须去控制台关「匿名登录」开关。
- **S7-10 裸库继承已关闭**（`migrateFrom: false`，partition-test 第 15 节源码扫描守卫，别删）。
  真机验证用**无痕窗口**（残留 guest/裸库会污染）。
- 退出 = 先推干净再清本地（推不干净抛错取消）；`clearLocalData()` 清业务+outbox+**水位线**但保留
  `schemaVersion`。⚠️ 端到端验证别 `localStorage.clear()`。
- **注销（S8-4）顺序硬约束**：`cloud.deleteAccount()` → `db.deleteLocalData()`（抹 meta+清遗留键）
  → `signOut()`+`switchPartition(null)`，包在 `runIdentityChange()`。⚠️ **别用 `indexedDB.deleteDatabase()`**
  （其他连接开着会 blocked 挂死）。注销文案**不得**出现「账号记录」四字（gate 5j 反向断言，注释也算）。

## 环境坑
- `npm run dev` → 127.0.0.1:5173；不配 `.env.local` 退纯本地。装新包删 `node_modules/.vite`。
- **Vite 会漏文件变更**（吐旧产物）：`curl` 模块路径 grep 关键字判别，`touch <file>` 强制刷新。
- **改 `.env.local` 触发自动重启 + 端口漂移**（5173 被占降级 5174）：验环境变量差异用全新端口另起。
- 本机无 Git for Windows，用 WorkBuddy 内置 PortableGit；主分支 main，约定式提交；不提交
  node_modules/dist/.preview；设计图与 `.workbuddy/memory` 入库。
