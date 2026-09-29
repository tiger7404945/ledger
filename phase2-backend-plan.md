# 第二阶段任务清单 · 接入后端与云同步（Supabase 路线）

> 读者假定：你写过前端，但**没写过后端、没碰过数据库、没注册过云服务**。
> 用法：按 S0 → S6 顺序做，**不要跳步**。每个任务都写了「做完怎么算通过」，没通过就别往下走。
> 配套文档：`page-structure.md`（页面真相源）、`ui-implementation-plan.md`（第一阶段计划）、`README.md`（快速开始）。

---

## 0. 这一阶段要达成什么

**现状**：账单只存在这台电脑、这个浏览器里（`localStorage` 的 `ledger.db.v1` 键）。换个浏览器、清一次缓存、换台电脑，数据就没了。

**目标**：数据"本地优先"——没网也能正常记账；一联网，自动同步到云端；换台设备登录同一个账号，数据完整地在那儿。

拆成三个可以独立交付的目标，**只有 2B 往后才需要注册账号**：

| 子阶段 | 做什么 | 要注册账号吗 | 难度 |
| --- | --- | --- | --- |
| **2A** | 本地存储从 localStorage 换成 IndexedDB | 不用 | ★★ |
| **2B** | 接上 Supabase，实现云同步 | 要 | ★★★ |
| **2C** | 用户登录 + 多设备 | 要 | ★★★★ |

> **关键顺序**：先做 2A，再想云的事。原因有两个：① 2A 完全不依赖任何外部服务，你现在就能做完，能立刻拿到正反馈；② 云同步必须以"本地数据库"为地基，没有 2A 直接接云会写成一团。

---

## 1. 先补概念（20 分钟，别跳过）

这些词你不懂也能抄代码，但一旦报错就完全不知道往哪查。用记账 App 的话说一遍：

| 名词 | 一句话白话 | 在本项目里对应什么 |
| --- | --- | --- |
| **前端 / 后端** | 前端是用户看得见的那层；后端是用户看不见、负责存数据的那台机器 | `src/` 里全部是前端；Supabase 是后端 |
| **BaaS** | "后端即服务"。别人把服务器、数据库、登录都搭好了，你只管调接口 | Supabase 就是 BaaS |
| **数据库** | 有结构的表格集合，断电也不丢 | 目前是 localStorage，2A 后是 IndexedDB，2B 后云端也有一份 |
| **表 / 行 / 列** | 表 = Excel 的一张 sheet；行 = 一条记录；列 = 字段 | `bills` 表，一行就是一笔账单 |
| **主键** | 能唯一认出这一行的那个字段，不允许重复 | 现在用 `id`（如 `bill_mumgc7yq17y0il4`） |
| **外键** | "这一行属于谁"的字段，指向另一张表 | `bills.user_id` 指向 `auth.users.id` |
| **索引** | 书的目录。没索引就要一页页翻（全表扫描） | 按日期查账单、按 `updated_at` 拉增量 |
| **API / REST** | 后端对外开放的"取号窗口"，你按约定格式发请求，它给你数据 | `supabase.from('bills').select()` 背后就是 REST |
| **SDK** | 官方包装好的工具库，把 API 调用变成函数调用 | `@supabase/supabase-js` |
| **鉴权 / Token** | 证明"我是我"的凭证，通常是一串有时效的字符串 | 登录后 Supabase 发的 JWT |
| **anon key / service key** | 两个不同权重的密钥 | 见下方 ⚠️ |
| **RLS**（行级安全） | 在数据库里写规则，规定"这个用户只能看/改自己的行" | 开关一开，别人的账单你查不到 |
| **本地优先**（local-first） | 先写本地、立刻返回成功，同步是后台的事 | 现在"完成"按钮的落库已经是这个模式 |
| **outbox**（发件箱） | 像寄信：先把信投进本地信箱，邮递员（同步器）负责送出去 | `src/api/sync/outbox.js` 已实现 |
| **幂等** | 同一个操作执行 1 次和 3 次，结果一样 | 重试推送不会记出两笔账 |
| **水位线** | "我上次同步到哪个时间点"，下次只拉这之后的 | `updated_at > 上次同步时间` |
| **冲突解决** | 两边都改了同一条，听谁的 | 本项目策略：`updated_at` 新者胜 |

### ⚠️ 两个密钥的区别（这条搞错会造成真实事故）

- **anon key**：权限很低，**设计上就是给前端用的**。它能不能动数据，完全取决于你有没有开 RLS。放前端是正常的。
- **service_role key**：**等同于数据库最高权限，能绕过所有 RLS**。**绝对不能写进前端代码、绝对不能提交进 git**（打包后任何人都能从 js 文件里翻出来）。它只允许出现在服务端（比如云函数的环境变量里）。

本项目是纯前端，**第二阶段只需要 anon key**。

---

## 2. 为什么是 Supabase

### 2.1 LeanCloud 的教训（这是本站的第一个真实教训）

第一阶段为 LeanCloud 预留了适配器骨架，但在验收时发现它已发布停服公告：

- **2026-01-12** 起：停止新用户注册、停止创建新应用；
- **2027-01-12** 起：关闭全部对外服务（应用访问、数据读写、API、控制台），平台数据将被销毁并不可恢复。

**现在（2026-09）注册通道已经关闭，这条路走不通了。**

这件事真正要记住的不是"LeanCloud 不行了"，而是：**后端选型要在架构上做到可替换**。本项目第一阶段的"契约 + 适配器"分层恰好做到了这点——换云厂商只改适配器层，视图和 store 一行都不用动。第二阶段请继续保持这个纪律。

### 2.2 备选对比

| 方案 | 优势 | 劣势 | 结论 |
| --- | --- | --- | --- |
| **Supabase** | PostgreSQL 全功能；自动生成 REST API；自带登录与 RLS；开源、可自托管；数据是标准 Postgres，随时能整库导出 | 国内直连不稳定（见 2.3）；需要理解 RLS 与 SQL | **本次选它** |
| 腾讯云开发 CloudBase | 国内访问快、合规、有免费额度；是 LeanCloud 官方指定的迁移目标 | 不可自托管，仍是单一厂商绑定；文档体系偏国内小程序 | 备选，若国内直连问题严重则切过去 |
| WorkBuddy 内置云服务 | 免注册、免密钥、我这边可直接接 | 更偏"托管"，你学到的后端概念会少一些 | 想最快看到效果时可用 |
| 自建 Node + Postgres | 完全可控，学到的最多 | 需要一台云服务器 + 域名 + 运维，对新手是另一个大工程 | 不推荐现在做 |

### 2.3 Supabase 是什么

一个 Supabase 项目 = 四样东西捆在一起：

1. **PostgreSQL**：正经的关系型数据库，你写 SQL 建表。
2. **PostgREST**：自动把你的表变成 REST API——建完表就有接口，不用写后端代码。
3. **Auth**：登录注册体系（邮箱、第三方登录、JWT 签发与刷新）。
4. **RLS**：数据库层面的行级权限，是"多用户数据隔离"的正确做法。

**已知风险（先知道，遇到不慌）**：

- 国内直连 Supabase 官方域名**可能不稳定或需要代理**。真机测试时如果连不上，这不是你代码的问题。缓解办法：先用桌面浏览器（可走系统代理）开发，最后再处理国内可访问性——自建或用 CloudBase。
- 免费版有数据库容量、带宽、月活用户等限制，且**长期不活跃的项目会被自动暂停**（需要去控制台手动恢复）。具体额度以 Supabase 官网 Pricing 页为准，别背数字。
- 免费项目**不做自动备份**。所以 S6 里的"数据导出"不是可选项。

---

## 3. 前置准备（只有你能做，约 30 分钟）

这些步骤需要你本人操作（注册、邮箱验证），我没法代劳：

- [ ] **P1** 注册 Supabase 账号（用 GitHub 或邮箱），完成邮箱验证。
- [ ] **P2** 新建一个 Project。区域（Region）选离你近的，一般选 **Singapore** 或 **Tokyo**。
- [ ] **P3** 建完后进入 Project Settings → API，记下两个值：
  - `Project URL`（形如 `https://xxxxx.supabase.co`）
  - `anon public` key
  - **不要**复制 `service_role` key。
- [ ] **P4** 打开 Supabase 控制台的 **SQL Editor**，后面第 5 节的建表语句直接粘进去执行。
- [ ] **P5** 确认本机 Node 可用（本项目用托管 Node 22 即可），然后装 SDK：

```bash
npm install @supabase/supabase-js
```

- [ ] **P6** 在项目根目录新建 `.env.local`，填入 P3 的两个值：

```
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

- [ ] **P7** 立刻验证它**没有**被 git 跟踪：

```bash
git status --short          # 不应该出现 .env.local
git check-ignore -v .env.local   # 应该输出 .gitignore 里匹配到的那一行
```

> `.gitignore` 第一阶段已经写了 `.env` / `.env.local` / `.env.*.local`，理论上开箱即用。但**必须亲手验一次**——密钥泄露是不可逆的。

---

## 4. 任务分解

### S0 · 配置与安全先行（0.5 天）

**为什么先做这个**：把"密钥不进仓库"做成机制，而不是靠每次提交时的小心。

| 编号 | 任务 | 验收标准 |
| --- | --- | --- |
| S0-1 | 新增 `.env.example`（只放键名，不放真值）并提交 | 仓库里有 `.env.example`，`README` 里说明怎么用它生成 `.env.local` |
| S0-2 | 新增 `src/config/env.js`，统一读取 `import.meta.env.VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`，并导出 `isCloudConfigured` | 其它文件不再直接读 `import.meta.env` |
| S0-3 | 未配置时的降级：不抛错、不白屏，正常用本地数据；「我的」页显示"未配置云端" | 把 `.env.local` 改名 → 应用仍能正常启动使用 |
| S0-4 | `import.meta.env` 里只有 `VITE_` 前缀的变量才会暴露给前端，这个认知要落实 | 在 `env.js` 顶部注释写明这一点 |

---

### S1 · IndexedDB 落地（**不需要 Supabase**，2 天）

**目标**：把 `src/api/index.js` 里的 `DATA_SOURCE` 从 `'mock'` 切到 `'idb'`，**用户能感知到的行为完全不变**。

| 编号 | 任务 | 说明 |
| --- | --- | --- |
| S1-1 | 补齐 `idbAdapter` 的业务方法 | 逐个对照 `mockAdapter`，方法签名与返回值必须完全一致（契约在 `contract.js`） |
| S1-2 | 查询走索引 | `bill.list` 按 `date` 区间取数，别全表扫；`month` 索引用起来 |
| S1-3 | 写入的原子性 | 一个事务里同时写业务表 + `outbox` 表，要么都成功要么都不写 |
| S1-4 | 旧数据迁移 | 首次打开时把 `localStorage` 的 `ledger.db.v1` 搬进 IndexedDB，成功后写标记（照抄 `mockAdapter.migrate()` 的幂等思路） |
| S1-5 | 契约一致性测试 | 同一套断言分别跑 mock 和 idb，**两边都必须全绿** |

**验收标准**

1. `.preview/` 下新增 `idb-test.mjs`，复用现有断言，对两个适配器各跑一遍，全绿。
2. 手动走查：创建 / 查看 / 搜索 / 修改 / 删除 / 分类增删改，全部与第一阶段一致。
3. DevTools → Application → IndexedDB，能看到 `ledger` 库和 `ledger` / `category` / `bill` / `outbox` 四个表，且数据对得上。
4. 旧库数据迁移后，你原来记的账一条不少。

**新手常见的两个坑（提前告诉你，能省半天）**

- **Vue 的响应式对象不能直接存 IndexedDB**。`reactive`/`ref` 包过的对象是 Proxy，结构化克隆会抛错。写入前先 `toRaw()` 或深拷贝成普通对象。
- **IndexedDB 事务"用后即关"**。事务在事件循环空闲时会自动提交；一旦你 `await` 了一个不相关的东西，事务可能已经关闭，再往里加请求就会报 `TransactionInactiveError`。解决：一个事务内的所有请求**连续发起**，不要在中间 await 别的东西。

---

### S2 · 同步引擎骨架（先不联网，1.5 天）

**目标**：先写"什么时候该同步"的调度逻辑，用**内存里的假云端**测通。这样调 bug 时不用怀疑网络。

| 编号 | 任务 | 说明 |
| --- | --- | --- |
| S2-1 | 新增 `src/api/sync/syncEngine.js` | 状态机：`idle / syncing / error`；对外暴露 `sync()`、`pendingCount`、`onStateChange` |
| S2-2 | 触发时机 | ① 应用启动；② 浏览器 `online` 事件；③ 写操作后 debounce 2 秒合并；④ 用户手动触发（「我的」页下拉或按钮） |
| S2-3 | 写 `fakeCloud`（测试用） | 一个内存 Map，实现与云端同样的 `push/pull` 接口 |
| S2-4 | 失败重试 | 复用 `outbox.bumpRetry()`，指数退避（2s → 4s → 8s…，设上限）；重试到上限后标记失败但**不阻塞用户操作** |

**验收标准**

新增 `.preview/sync-test.mjs`，至少覆盖这些用例且全绿：

- 本地写 3 条 → `push` → 清空本地 → `pull` → 3 条数据完整回来；
- 离线（fakeCloud 抛错）连续写 5 条 → 恢复后一次 `sync()` 全部补推成功；
- 同一条记录重复 `push` 两次，云端不出现两条（**幂等**验证）；
- 推送失败时 `retry` 递增，且 UI 状态回调能拿到 `error`。

---

### S3 · 真正接上 Supabase（2 天）

| 编号 | 任务 | 说明 |
| --- | --- | --- |
| S3-1 | 在控制台执行第 5 节的建表 SQL | 表、索引、唯一约束都建好 |
| S3-2 | 打开 RLS 并写 policy | 见 5.3。**这一步没做，你的数据就是公开的** |
| S3-3 | 新增 `src/api/adapters/supabaseAdapter.js` | 实现 `initialize / push / pull / syncAll`，沿用 `leancloudAdapter.js` 注释里那套策略（本地为主、outbox 推送、水位拉取、新者胜） |
| S3-4 | `push` 用 upsert | 靠 `(user_id, local_id)` 唯一约束，`on conflict do update`，天然幂等 |
| S3-5 | `pull` 用水位 | `updated_at > meta.lastSyncAt`，按 `updated_at` 升序，注意分页 |
| S3-6 | 首次绑定策略 | 第一次登录时让用户选：「本地数据推到云端」还是「云端数据拉到本地」。别自己猜 |

**验收标准**

1. 单台设备：记几笔账 → 同步 → 去 Supabase 控制台的 Table Editor 能看到这些行，字段值正确。
2. 清空浏览器全部数据（模拟换设备）→ 重新打开 → 同步 → 数据完整回来（**这是最关键的一条**）。
3. RLS 验证：在控制台看 Table Editor 时确认 RLS 已启用（表上有盾牌图标）。

---

### S4 · 冲突、错误与边界（1.5 天）

| 编号 | 任务 | 说明 |
| --- | --- | --- |
| S4-1 | 软删除在云端的表示 | 删除 = 把 `deleted` 置 1 并同步，**绝不真删**。否则另一台设备会把已删的记录又拉回来 |
| S4-2 | 用服务端时间做裁决 | 客户端时钟可能不准。`updated_at` 以数据库的 `now()` 为准，本地时间只作参考 |
| S4-3 | 拉取分页 | Supabase 单次查询默认有行数上限，超过要循环拉取直到拿完 |
| S4-4 | 网络错误分类 | 区分"没网"（静默重试）/"鉴权失败"（提示重新登录）/"服务端错误"（提示稍后重试），不要让三种都跳同一个红字 |
| S4-5 | 边界用例脚本 | 剧本：同一账号，A 设备改金额、B 设备改备注、两边同时同步 |

**验收标准**

- `.preview/conflict-test.mjs`：构造"两边都改同一条"，断言最终结果是 `updated_at` 大的那一版，且两边收敛到同一状态。
- 拔网线（或 DevTools 切 offline）操作 5 次 → 恢复网络 → 无报错、无重复、无丢失。

---

### S5 · 登录与多设备（2 天）

| 编号 | 任务 | 说明 |
| --- | --- | --- |
| S5-1 | 接 Supabase Auth | 建议先用**邮箱一次性验证码**（不用管密码找回），最省事 |
| S5-2 | 登录态持久化 | Supabase 会自动存 session，确认刷新页面后仍登录 |
| S5-3 | 未登录也能用 | 保持"本地匿名记账"，登录后再把本地数据合并上去 |
| S5-4 | 退出登录的数据处置 | **先定产品规则再写代码**：退出时本地数据是保留、清空、还是标记为待确认？（建议：保留，但提示用户） |
| S5-5 | 「我的」页改造 | 显示：当前账号 / 上次同步时间 / 待同步条数 / 手动同步按钮 / 退出登录 |

**验收标准**

两个不同浏览器（或一台电脑 + 一台手机）登录同一账号：A 记一笔 → 5 秒内 B 能刷到。

---

### S6 · 稳健性与上线（1.5 天）

| 编号 | 任务 | 说明 |
| --- | --- | --- |
| S6-1 | 同步状态可视化 | 「我的」页要能一眼看出：已同步 / 同步中 / 失败（带重试按钮） |
| S6-2 | 数据导出 | 导出全部账单为 JSON（或 CSV）。**这不是可选项**——LeanCloud 的教训就是不能把数据只交给一家厂商 |
| S6-3 | 真机测试 | 手机浏览器实测：布局、手势、同步。注意国内直连 Supabase 可能不通 |
| S6-4 | 静态部署 | 部署到静态托管，得到可分享链接 |
| S6-5 | 文档更新 | `README` 补"如何配置云端"；`contract.js` 注释改为 Supabase |

**验收标准**

- 导出的 JSON 能被重新导入且数据一致。
- 手机能打开、能记账、能同步（或明确记录下"国内直连不可用"这一事实及应对方案）。

---

## 5. Supabase 表设计

### 5.1 设计要点

三件事先说清楚，否则后面一定返工：

1. **本地 id 是字符串**（如 `bill_mumgc7yq17y0il4`），不是 uuid。所以云端给它单独一个列 `local_id text`，并用 `(user_id, local_id)` 做唯一约束——这是 upsert 幂等的依据。
2. **时间统一用 `timestamptz`**，由数据库 `now()` 生成，别信客户端时钟。
3. **软删除**：`deleted smallint default 0`，同步的是这个标记，不是 `delete` 语句。

### 5.2 建表 SQL（可直接粘进 SQL Editor）

```sql
-- 分类表
create table if not exists public.categories (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  local_id      text not null,                 -- 客户端生成的 id，同步幂等键
  ledger_id     text not null default 'ledger_default',
  name          text not null,
  icon          text not null default '',
  parent_local_id text,                        -- null = 一级分类
  type          text not null check (type in ('expense', 'income')),
  sort_order    integer not null default 0,
  deleted       smallint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, local_id)
);

create index if not exists categories_user_updated_idx
  on public.categories (user_id, updated_at);

-- 账单表
create table if not exists public.bills (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  local_id      text not null,
  ledger_id     text not null default 'ledger_default',
  type          text not null check (type in ('expense', 'income', 'transfer', 'lending')),
  amount        numeric(12, 2) not null default 0,
  category_local_id         text,
  primary_category_local_id text,
  remark        text not null default '',
  date          date not null,
  no_reimburse  boolean not null default false,
  deleted       smallint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, local_id)
);

create index if not exists bills_user_updated_idx
  on public.bills (user_id, updated_at);
create index if not exists bills_user_date_idx
  on public.bills (user_id, date);

-- updated_at 自动维护：任何更新都刷新它，同步水位才有意义
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists bills_touch_updated_at on public.bills;
create trigger bills_touch_updated_at
  before update on public.bills
  for each row execute function public.touch_updated_at();

drop trigger if exists categories_touch_updated_at on public.categories;
create trigger categories_touch_updated_at
  before update on public.categories
  for each row execute function public.touch_updated_at();
```

> `amount` 用 `numeric(12,2)` 而不是浮点数——钱不能用浮点存，这是硬规矩。

### 5.3 RLS 策略（**不写这段等于把数据库公开**）

```sql
alter table public.bills      enable row level security;
alter table public.categories enable row level security;

-- 账单：只能读写自己那一行
create policy "bills_select_own" on public.bills
  for select using (auth.uid() = user_id);
create policy "bills_insert_own" on public.bills
  for insert with check (auth.uid() = user_id);
create policy "bills_update_own" on public.bills
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bills_delete_own" on public.bills
  for delete using (auth.uid() = user_id);

-- 分类：同上
create policy "categories_select_own" on public.categories
  for select using (auth.uid() = user_id);
create policy "categories_insert_own" on public.categories
  for insert with check (auth.uid() = user_id);
create policy "categories_update_own" on public.categories
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "categories_delete_own" on public.categories
  for delete using (auth.uid() = user_id);
```

### 5.4 字段映射对照（本地 → 云端）

| 本地（camelCase） | 云端（snake_case） | 备注 |
| --- | --- | --- |
| `id` | `local_id` | 云端自己的 `id` 是 uuid，本地不用管 |
| `ledgerId` | `ledger_id` | |
| `categoryId` | `category_local_id` | 存的是分类的本地 id |
| `primaryCategoryId` | `primary_category_local_id` | |
| `noReimburse` | `no_reimburse` | |
| `date`（字符串 `YYYY-MM-DD`） | `date`（date 类型） | |
| `updatedAt`（毫秒数） | `updated_at`（timestamptz） | 转换时注意单位：秒 vs 毫秒 |
| `deleted`（0/1） | `deleted`（smallint） | |

> 命名风格不同是故意的：JS 用 camelCase，Postgres 惯例 snake_case。转换集中写在一个 `toRow() / fromRow()` 函数里，别散落各处。

---

## 6. 里程碑

| 里程碑 | 内容 | 完成标志 | 建议版本号 |
| --- | --- | --- | --- |
| **M2.1** | 本地 IndexedDB 上线 | S1 验收全过，`DATA_SOURCE = 'idb'`，用户无感 | v0.3.0 |
| **M2.2** | 同步引擎跑通（假云端） | S2 用例全绿，调度逻辑稳定 | v0.4.0 |
| **M2.3** | 真云端单设备同步 | S3 验收全过，换浏览器能恢复数据 | v0.5.0 |
| **M2.4** | 多设备 + 登录 | S4 + S5 验收全过 | v0.9.0 |
| **M2.5** | 可上线 | S6 全过，含数据导出与部署 | **v1.0.0** |

---

## 7. 新手最容易踩的 10 个坑

1. **把 `service_role` key 写进前端**。打包后人人可见，等于把数据库钥匙挂在门上。前端只用 `anon` key。
2. **忘了开 RLS**。Supabase 建表默认不开 RLS，此时用 anon key 谁都能读全表。**建完表第一件事就是开 RLS**。
3. **拿本地自增 id 当云端主键**。多设备一定会撞号。用 uuid，或用 `(user_id, local_id)` 唯一约束。
4. **把 Vue 的响应式对象直接丢进 IndexedDB**。Proxy 无法被结构化克隆，会抛 `DataCloneError`。先 `toRaw()`。
5. **把 IndexedDB 当同步 API 用**。它全是回调/Promise，没有"阻塞式读取"。别写出"读到值再往下走"的假想逻辑。
6. **每次写操作都立刻打网络请求**。记 10 笔账就是 10 次请求。要 debounce + 批量。
7. **用客户端时间判断谁更新**。手机时钟可能差几分钟，会导致"新数据被旧数据覆盖"。用数据库时间。
8. **真删除**。你这边删了，另一台设备下一次拉取会把它当成"云端新增"又拉回来。必须软删除 + 同步墓碑标记。
9. **同步写成"全量覆盖"而不是"增量合并"**。全量覆盖会在多设备下互相冲掉数据。
10. **没有网络错误处理**。离线时每一步都弹红字，用户会以为应用坏了。离线应该是**正常状态**，不是错误。

---

## 8. 建议的学习顺序

按需查，不要一开始就读完：

1. **做 S1 前**：MDN 的 IndexedDB 概念页（就看"key / index / transaction"三个概念）。
2. **做 S2 前**：搞懂 outbox 模式（关键词 `transactional outbox pattern`），看本项目的 `src/api/sync/outbox.js` 就够。
3. **做 S3 前**：Supabase 官方文档的 Quickstart（JavaScript 版）+ "Row Level Security" 那一节。
4. **做 S4 前**：搜 `last write wins` 与 `CRDT` 的区别，知道本项目选了最简单的那种（LWW）以及它的代价。
5. **SQL 基础**：只需要 `create table` / `index` / `select ... where` 三种，遇到再学。

---

## 9. 第二阶段总验收清单

### 2A 本地化
- [ ] `DATA_SOURCE = 'idb'`，全功能走查通过
- [ ] 契约一致性测试：mock 与 idb 双跑全绿
- [ ] 旧 localStorage 数据成功迁移，无丢失
- [ ] DevTools 里能看到 4 个 objectStore 与数据

### 2B 云同步
- [ ] `.env.local` 未被 git 跟踪（`git check-ignore` 验证过）
- [ ] 云端表已建、RLS 已开、索引已建
- [ ] 单设备：本地 → 云端 → 换浏览器 → 恢复，全链路通过
- [ ] outbox 幂等：重复推送不产生重复行
- [ ] 离线写 5 笔 → 恢复网络自动补推成功
- [ ] 冲突用例：两边同改一条，收敛到 `updated_at` 较新的一版

### 2C 账号与上线
- [ ] 登录 / 退出 / 刷新保持登录态
- [ ] 两个浏览器同账号，5 秒内互见新账单
- [ ] 未登录仍可记账，登录后数据正确合并
- [ ] 「我的」页能看到：账号、上次同步时间、待同步条数、手动同步
- [ ] 数据可导出为 JSON 并可重新导入
- [ ] 手机实测通过（或明确记录国内直连问题与替代方案）

---

*本文件随第二阶段推进持续更新。每完成一个 S，回来把对应的验收项勾上，并更新第 6 节的里程碑状态。*
