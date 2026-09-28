# 项目长期记忆 · 随手记账（D:\projects\ledger）

## 项目性质
移动端记账 Web App 的前端复刻。设计原型来自仓库根目录的 8 张微信截图（`微信图片_*.jpg`）。
**第一阶段只做前端 + Mock 数据**；第二阶段接 IndexedDB 离线缓存与 LeanCloud 增量同步。

## 强制约定
- 视图层**不得**直接调用 adapter，只依赖 `src/api/index.js` 导出的 repository 与 Pinia store。
- 新增数据操作必须先在 `src/api/contract.js` 补契约，再实现到各 adapter。
- 写操作一律 local-first：先落本地，再 `outbox.enqueue`。
- 设计变量只写在 `src/styles/tokens.css`，组件内不硬编码品牌色。
- 图标一律用 `src/components/icons`（`IconBase` + `ICONS` 映射），不引入外部图标库/字体。
- 手机外框宽度 `--frame-w`（430px）；`position: fixed` 元素依赖 `.app-frame` 的 transform 包含块。
- **记账页层级**：页面底色用灰色 `--page`，二级分类面板（`SubCategoryPanel`）是白色浮起卡片（`--surface-raised` + `--r-md` + `--shadow-card` + 左右 24px 内缩）叠在灰底上。一级分类区直接铺灰底，**不要**给页面或 body 设纯白底，否则面板会与背景糊在一起。
- `CategoryGrid` 的选中态 = `selectedId`（叶子分类 id）或 `activeId`（父级一级分类 id）；记账页两个都要传，这样选中二级分类时父级也点亮。
- 调整视觉前先对参考稿做像素采样（PIL 取色），参考稿为 1080×2400。

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
- 提交信息用约定式前缀（`feat:`/`fix:`/`refactor:`/`docs:`），正文写清功能点与数据层改动。
- 不提交 `node_modules/`、`dist/`、`.preview/`（见 `.gitignore`）；`dist` 为可重建产物。
- 设计参考图与 `.workbuddy/memory/` 纳入版本管理，作为设计来源与决策记录。
