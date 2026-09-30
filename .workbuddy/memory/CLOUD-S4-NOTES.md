# 云端与 S4 实测记录 · 随手记账

> 从 `MEMORY.md` 拆出来的**深度参考**：腾讯云开发 CloudBase 的环境事实、
> S4 各项的实施细节、fakeCloud 与真云端的语义漂移、以及踩过的坑。
> **改动云端适配器或同步引擎之前必须先读这一份** —— 每条都对应一个真实缺陷。
> 概览与硬约定见 `MEMORY.md`。

### ★ S4-2 时钟校正（已完成）
- `syncEngine.resolveClockOffset()`：每轮同步先取服务端时间，算
  `clockOffset = 服务端时间 - 本地时间`（>0 本机慢），**在比较的那一刻**校正，不改写数据。
- 三条铁律：① **只信 `source === 'cloud-function'`**，降级取下界时返回 0（下界不是当前时间，
  拿它算会把本地时钟推慢）；② RTT 中点修正（`t0 + (t1-t0)/2`）；③ 透传链路要完整
  （`run()` → `pullAll`/`pushPending`/`resolveRejected` → `applyRemote` → `partitionRemote`
  → `shouldTakeRemote`；**push 侧同样要传**，慢时钟设备才会推自己的新改动）。
- **`clockOffset` 只在比较那一刻用一次，绝不能落盘**。存校正值等于把偏移固化进数据、逐轮累积误差。

### ★ S4-4 错误分类（已完成）
- `sync/errors.js`：九类 `SYNC_ERROR_KIND`（`not-configured`/`offline`/`network`/`auth-expired`/
  `server`/`quota`/`forbidden`/`conflict`/`unknown`）+ `ERROR_POLICY` 策略表
  （`retryable`/`needsReauth`/`silent`/`label`）。**分类只写一份**。
- 引擎 `handleSyncFailure` 按策略分流：只对可重试类加 `retryCount` + `bumpRetryAll`；
  `needsReauth` 先重新登录再立刻重跑一轮（**只试一次**，避免死循环）；不可重试类要
  **清掉已排队的退避定时器**。
- `OFFLINE` 是 `retryable: false` —— 恢复路径是 `online` 事件（引擎已监听），排退避反而
  给队列加 retry 计数、把「本来就离线」显示成「网差在重试」。
- `snapshot()` 多了 `consecutiveFailures`/`clockOffset`/`clockSource`；
  `lastError` 变成 `{message,kind,at,reason,label}`。

### ★ fakeCloud 三处与真云端的语义漂移（已修，**别改回去**）
假云端与真云端**任何语义漂移都会让测试说谎**。三条都是靠新用例才浮出来的：
1. **`serverNow()` 吞时钟** —— `base > serverClock ? base : serverClock + 1` 在 `base` 没变时也
   `+1`。一次同步要调它 4 次，每轮多爬 4ms，几十轮漂移数百毫秒 → `clockOffset` 被污染成非 0
   → LWW 裁决方向整个掀翻。改为「同一时刻重复读取返回同一个值」。
2. **`pull()` 左开区间** —— fakeCloud 写 `ts > since`，真云端 `cloudbaseAdapter` 写 `_.gte(...)`
   （**左闭**）。水位线记的是快照时刻，与之等值的文档（同毫秒推送）被左开判为「已拉过」而
   **永久丢失**。已对齐成 `[since, snapshotAt]` 左闭右闭。
3. **`push()` 把校正值写回云端** —— fakeCloud 存 `updatedAt: localTs`（校正后），
   真云端存原始 `doc`。改为存客户端原始 `updatedAt`。

### ★ S4-6 待办：跨设备时钟裁决会**静默分叉**（S4-5 发现，尚未修）
`clockOffset` 是**每台设备各自算的**，而 `shouldTakeRemote` 只给「**本地那份**」加偏移 ——
等于假设远端时间戳已在正确时间轴上，但远端也是客户端写的、偏多少不知道。两台设备各自
「只校正自己」时陷入**双方都觉得自己更新**的死局：
```
A 准(offset 0)：10(…001000)+0 = …001000   → A 保留 10
B 慢5s(+5000)  ：99(…9999000)+5000 = …0004000 → B 保留 99
⇒ 反复同步也不收敛（云端只有一条，但两端内容不同）
```
- **S4-2 的真实边界**：它解决的是「**写入方自己**不把新改动误判成旧数据丢弃」（已验证有效）。
  跨设备裁决要落在**共享时间轴**上，属 S4-6。
- 修法首选：云端接收写入时把服务端刻度写进业务字段（如 `serverUpdatedAt`，服务端自己算、
  客户端不能伪造），合并优先比它。⚠️ **不要复用 `_serverTs`** —— 它承担「水位线」职责，语义不同。
- `conflict-test` 3g **刻意断言「当前不收敛」**，消息写明「若已相等说明 S4-6 修好了，
  应把本断言反转」。

## 云端（S3 完成 / S4 进行中，腾讯云开发 CloudBase）
装配：`src/api/index.js` 里 `cloud = isCloudConfigured ? createCloudBaseAdapter({ env }) : null`。
**换云端只需改这一处。**

### 环境与权限（实测钉死，别靠文档推断）
- **纯 NoSQL 后端**（`RuntimeBackends.nosql = true`，官方提示 *"PostgreSQL is NOT provisioned…
  legacy NoSQL CloudBase backend"*），走 `app.database()`。**不要**改成 `app.rdb()`。
  判断方法：`queryEnv(action="info")` 看 `RuntimeMode`/`RuntimeBackends`。
- **集合权限用简单权限 `PRIVATE`**。与 CUSTOM 的关键区别：**CUSTOM 要求查询条件必须自带
  `_openid`**，简单权限由服务端按 `_openid` 自动隔离、客户端查询**不带** `_openid`。选后者更省心。
- **权限是「服务端校验」不是「前端过滤」**，适配器里**故意不过滤** `_openid`（前端代码谁都能改）。
- **`_openid` 由 SDK 自动注入**（手写报错），拉回时由 `fromRemote()` 剥掉；
  `stripServerMeta()` 剥所有 `_` 前缀字段。
- **`_serverTs` 用 `db.serverDate()` 写入** = 服务端接收时间，读回来是 **Date 对象**。
  **坑：拿数字比较 Date 字段一条都匹配不到**，必须 `_.gte(new Date(0))`。
- **`.doc(id).set()` = 指定 `_id` 的 upsert**；`.add()` 返回 `result._id`；`.update()` 返 `{updated}`、
  `.remove()` 返 `{deleted}`；分页 `orderBy + skip + limit`。`.set()` 的 upsert **只对自己拥有的
  文档成立**，`_id` 已存在但属主是别人时抛 **`E11000 duplicate key`**（500 / `DATABASE_REQUEST_FAILED`）。
- **`push` 是两段式条件 upsert**：①按 `_id` 批量读回云端 `updatedAt` → ②逐条比较，本地不旧才
  `set({...payload, _serverTs: db.serverDate()})`，否则进 `rejected`。**①②之间不原子，是 S4-6 的窗口。**
- **匿名登录懒触发**：只在真正要读写时 `signInAnonymously()`（否则光开「我的」页就触发 88 次写入）。
  登录态在 localStorage（`user_info_<envId>`/`credentials_<envId>`/`lang_<envId>`/`device_id`），
  **清掉就永久失联** → S5 要尽早「匿名转正」。
  - **坑**：同一 `app` 实例 `signOut()` 后重新匿名登录**仍拿到同一个 uid** → 验证隔离必须用**两个独立进程**。
- **首次绑定 `ensureCloudFirstBind()`**：把本地三集合一次性 `outbox.enqueueMany` 推上云（本地优先）。
  匿名身份下云端不可能有别人的数据，故无覆盖风险；**S5 有真账号后必须改成先问用户**。
- **SDK 走动态 import**（`loadSdk: () => import('@cloudbase/js-sdk')`），Vite 拆独立 chunk；
  不配云端时根本不加载。
- **体验版限制**：`addSecurityDomain` 报「当前套餐无法执行此操作」；但 `localhost:5173` 实测能过
  Origin 校验，**平台默认域名也可绕过该流程**。**免费环境要手动续期**（单次 6 个月、不自动续费），
  **到期 2027-03-30**。
- **两个默认域名易混**：`...tcloudbaseapp.com` 是 `STATIC_STORE`（静态托管）；
  `my-cloudbase-….ap-shanghai.app.tcloudbase.com` 是 `HTTPSERVICE` 且 `IsDefault: true`
  （**HTTP 网关默认域名**）。后者 404 是因为**还没有路由**（不是托管没部署）。

### ★ S4-2 云函数：真服务端时间走「云函数 + HTTP 网关」
- **为什么不能用 `app.callFunction()`**：匿名态抛 **403 `EXCEED_AUTHORITY`** —— 云函数默认安全
  规则要求「登录且非匿名」。**改函数权限实测无效**（`managePermissions` 回 `Success: true` 但复读仍是原规则）。
- **正解 = HTTP 网关**：`manageGateway(createRoute, upstreamResourceType='SCF', auth=false)`，
  路径 `/ledger-server-time`。网关 `EnableAuth=false` 真实生效。
- **函数本体**：`cloudfunctions/ledger-server-time/`，`runtime=Nodejs18.15`、`handler=index.main`、
  `type=Event`、`timeout=5`，返回 `{ ok, serverTime, iso, env }`，依赖 `wx-server-sdk ~2.6.3`。
- **★ 云函数本地目录名必须与云端函数名完全一致**（MCP 用 `functionRootPath + '/' + 函数名` 拼路径）。
  用下划线 `ledger_server_time` → 报「路径不存在」。
- **`serverTime()` 契约是 `{ value, source }`**：`'cloud-function'`（可信、可裁决）或
  `'watermark-lower-bound'`（仅水位线）。**与 `pull()` 返回里的 `serverTime`（数字水位线）同名不同源**。
- `serverTime` **只属于云客户端契约**（`sync/cloudClient.js`），**不属于适配器契约**（`contract.js`）
  —— mock/idb 不需要它。
- 前端网关基址来自 `VITE_CLOUDBASE_API_BASE`（`.env.local`）→ `src/config/env.js`。

### ★ S4-7（已修复，方案 A）：云端 `_id` 换成账号别名
- **缺陷**：云端 `_id` **集合内全局唯一（跨账号）**，而 `PRIVATE` 按 `_openid` **隔离读** →
  新匿名身份**读不到**旧文档、**又写不进**同 `_id` → `E11000` → 首次绑定**永久失败**。
  种子 id 写死，所以真实场景（清 localStorage / 换设备 / 换浏览器）**必现**。
  **一句话根因：看不见，却撞得上。**
- **修法（用户 2026-09-30 拍板）**：云端 `_id` = **`<账号前缀>_<本地 id>`**，本地 id 移进业务字段 `id`。
  - **账号前缀** `accountPrefixOf` = uid 去掉非字母数字、截 8 位、小写。
    碰撞后果只是回到这个 bug，不是数据泄露（`_openid` 读取隔离始终有效）。
  - **本地 id 保持设备无关**（`ledger_default` 到哪都是它）→ 跨设备合并/种子/导出照旧；
    视图/store/契约**零改动**。
  - **`fromRemote()` 从业务字段 `id` 还原本地主键**，**绝不反解析别名**（格式一改就错，
    且本地 id 自带下划线）。
  - **契约层面一律用本地 id**：`pull({ ids })` 传本地 id；`push()` 返回的 `upserted`/
    `rejected[].id` 也是本地 id（引擎靠它清队列）。别名只在云适配器内部出现。
  - `fakeCloud` **不需要**这层（按 `_openid` 分桶，本来就撞不了）。
  - **落点**：`core/cloudId.js`（映射）、`cloudbaseAdapter.js` 的 `push`/`pull`（用 `setUid()`
    统一维护 `currentPrefix`）、`core/merge.js`（`fromRemote`）。
- **为什么选 A**：B 用设备维度（更短命）只是缩小问题；C 冲突换 id 会**静默产生重复账本**；
  D 只提示不解决。A 让「唯一性范围」与「可见性范围」都是账号级，构造上不可能撞；
  S5 转正时**只需重写前缀**。
- **「需数据迁移」的实义**：是**开发者的一次性云端清洗**，不是给用户开发迁移功能。
  **越早改越便宜**。
- **`wipe()` 按「有 `_serverTs` 的全部文档」删**，新旧两种 id 格式都能清。

### ⚠️ 匿名登录的开关时机（务必在 S6 收口）
**开发测试期保持开启**（S3 依赖它）；**正式上线前必须重新评估**。理由：① 匿名登录无需凭证 →
任何人拿到 envId 就能创建身份并写数据；② 免费额度按量计（3,000 点/月），PRIVATE 权限
**只能防「看别人的数据」、防不住「新建账号写自己的数据」**；③ S5 转正后它应从主入口降级为游客体验。
**上线三选一**：A 直接关闭 / B 保留但匿名不参与云同步（按 `auth.loginType` 分流）/
C 保留并接受风险（须配额告警）。详见 `phase2-backend-plan.md` **P10** 与 **S6-7**。

### 探针与工具位置
- `.preview/sdk-probe/`：`probe-docdb.mjs`、`probe-isolation.mjs`（**独立进程**验跨身份隔离）、
  `probe-alias.mjs`（S4-7 别名四前提）。换环境或升 SDK 大版本时重跑。
- **CloudBase MCP 工具来源**：`~/.workbuddy/mcp.json` **不存在**；能力来自官方插件包
  `~/.workbuddy/plugins/cache/workbuddy-connector-plugins-official/cloudbase/`，
  其 `mcp.json` 声明 `npx -y @cloudbase/cloudbase-mcp@latest`（stdio）。
  **skill 与 MCP 是同一插件的两个目录，不是二选一。**
