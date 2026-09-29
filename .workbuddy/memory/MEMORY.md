# 项目长期记忆 · 随手记账（D:\projects\ledger）

## 项目性质
移动端记账 Web App 的前端复刻。设计原型来自仓库根目录的设计稿：8 张微信截图（`微信图片_*.jpg`）+ 后续补充的 `填写备注.jpg`（记账页备注候选条）+ `月选择器.jpg` / `年选择器.jpg`（账期筛选弹层）。补充稿同样放在仓库根目录、纳入版本管理。
**第一阶段只做前端 + Mock 数据**；第二阶段接 IndexedDB 离线缓存与 LeanCloud 增量同步。

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
- **agent-browser 的 click 命中第一个匹配元素**：`click ".grid .cell:nth-child(9)"` 在账单页会点到月历的日期格（页面里有两个 `.grid`），必须写成 `.picker .grid .cell:nth-child(9)`。改完文件若页面空白又无报错，先重新 `open` 一次（HMR 半改状态）。
- **Vue 的 DOM 更新是异步的**：用 `eval` 派发合成手势后，必须在**另一次** `eval` 里读状态，同一次调用里读到的还是旧值。
- **agent-browser 用法**：二进制在 `C:\Users\DELL\.workbuddy\binaries\node\workspace\node_modules\agent-browser\bin\agent-browser-win32-x64.exe`。**必须先 `open <url>` 再 `set viewport <w> <h>`**；没有打开页面就调 `set viewport` 会一直挂住不返回。命令都可能挂起，一律套 `timeout`。`eval` 用最简单的表达式（如 `document.querySelector('.scroll-area').scrollTop = 99999`）不会挂。

## 布局约定
- **账单 store 有两份互相独立的数据切片**，不要合并：
  - **本月视角**：`month` / `bills` / `summary`，首页与统计页固定用它（首页永远显示「本月」，不能被账单页的筛选带跑）。
  - **账单页筛选取景**：`period{mode,month,year}` / `periodBills` / `periodSummary` + `period*` 系列 getter（`periodRange` / `periodLabel` / `periodUnit` / `periodGroups` / `periodDailyMap` / `periodMonthlyMap`），账单页只用这套。
  - 写操作（create/update/delete）要同时刷新两份；`periodInitialized` 为 false 时跳过 period 刷新，避免记账页做多余查询。
- **区间一律用 `from` / `to`（'YYYY-MM-DD'，含首尾）表达**，`month` 只是它的特例。contract 里两者可同时传且按 AND 处理。新增区间筛选先补 contract，再补 mockAdapter，再给 store 加 getter。
- **横向滑动轨道**：`.view-track`（`width:200%` + `translateX(0|-50%)`）+ 两个 `.view-pane`（`flex:0 0 50%`），每屏各自有 `.scroll-area`。拖动时把 `transition` 关掉（`.is-dragging`）跟手位移，松手按阈值吸附。手势要先判主方向，纵向直接放弃（`active=false`）把滚动交还给浏览器，否则会抢滚动。
- 横向手势**不要**用 `preventDefault`：纵向滚动区在轨道内部，靠主方向判定就够了。
- **底部标签栏占位**：`TabBar` 是 `position: fixed`，带 TabBar 的页面必须自己留底部空间。统一用 `padding-bottom: var(--tabbar-space)`（= `--tab-h` + `--safe-b`）。**不要写 `padding: 0 14px` 这种简写**——它会连 `padding-bottom` 一起重置，导致最后一条内容被标签栏盖住且滚不出来。原先 base.css 里的 `.has-tabbar` 工具类已删除（它会被各页面 scoped 样式里的 padding 简写静默覆盖，是个坑）。
- **局部滚动**：页面需要「只有某一块滚动、其余固定」时，用 base.css 的 `.scroll-area`（`flex: 1` + `min-height: 0` + `overflow-y: auto`），外层 `.page-body` 改为 `display: flex; flex-direction: column; overflow: hidden`。账单页即此结构：筛选行 + 结余卡片固定，只有列表（含日历视图）滚动；滚动区自己写 `padding: 0 14px var(--tabbar-space)`，卡片就能像设计稿那样一直铺到标签栏底下，且最后一条能完整滚出来。
- 卡片与上方固定区之间的间距放在固定区上（如 `.hero { margin-bottom: 12px }`），不要放在滚动区的 `padding-top`——否则滚动时这段留白会被滚掉，半截列表会贴到固定区上。

## 页面与路由
`/` 首页 · `/bills` 账单 · `/record` 记账（`?id=` 为修改）· `/stats` 统计 · `/mine` 我的
`/category` 一级分类管理（内含子路由 `:parentId/sub` 二级弹层）· `/category/edit` 分类编辑（`?scope=primary|secondary&parentId=&id=`）

## 关键规范
- 二级分类展示名统一为 `一级名-二级名`（如「交通-公交地铁」），由 `categoryStore.label()` 产出。
- 分类名上限 8 字（`NAME_MAX_LENGTH`）；重名在同级同类型内不允许，抛 `RepositoryError`。
- 删除一律软删除（`deleted: 1`），供增量同步识别。
- 金额为元、正数；颜色遵循国内习惯（涨红跌绿，本项目金额为支出显示深色、收入显示主题绿）。

## 本地运行
`npm install && npm run dev` → http://127.0.0.1:5173
Mock 数据持久化在 localStorage `ledger.db.v1`，「我的 → 重置演示数据」可恢复种子数据。

## 版本管理
- **本机 Git 环境**：未安装 Git for Windows（无 `C:\Program Files\Git`），用户 PATH 中无 git；本会话执行 git 用的是 WorkBuddy 内置 PortableGit `~/.workbuddy/binaries/PortableGit/versions/1.2.0`（2.55.0）。另装有 GitHub Desktop 3.5.12，其自带精简版 git 在 `%LOCALAPPDATA%\GitHubDesktop\app-3.5.12\resources\app\git\cmd\git.exe`（2.53.0，无 bash/gitk）。全局身份 `tiger7404945 <tiger7404945@163.com>`。
- 主分支 `main`；第一阶段已打标签 `v0.1.0`。
- 提交历史：`face5fb` 第一阶段前端 → `cb2ac48` 记账页选中态/面板层级修复 → `698c975` 记账页交互增强（默认分类/草稿/备注候选，含 `填写备注.jpg`）→ `4baf607` 记忆补档 → `9fe39d6` 账单页滑动切换视图 + 月/年账期筛选（含 `月选择器.jpg` / `年选择器.jpg`，同批带上标签栏占位与局部滚动两处布局修复）。
- 提交信息用约定式前缀（`feat:`/`fix:`/`refactor:`/`docs:`），正文写清功能点与数据层改动。
- 不提交 `node_modules/`、`dist/`、`.preview/`（见 `.gitignore`）；`dist` 为可重建产物。
- 设计参考图与 `.workbuddy/memory/` 纳入版本管理，作为设计来源与决策记录。
