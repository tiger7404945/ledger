# 随手记账 · 移动端 H5（第一阶段：前端复刻）

基于参考截图复刻的记账 App 前端，Vue 3 + Vite。当前阶段**只做前端 UI、Mock 数据与前端交互**，已按「本地优先 + 增量同步」的目标预留接口。

## 快速开始

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run build    # 产物输出到 dist/
```

## 页面清单（对应 8 张参考图）

| 路由 | 页面 | 对应截图 |
| --- | --- | --- |
| `/` | 首页（本月总览 / 今日账单 / 净资产） | 图 11 |
| `/bills` | 账单（流水 + 日历，按月切换） | 图 12 |
| `/record` | 记账（支出 / 收入 / 转账 / 借贷） | 图 13、14 |
| `/record?id=xxx` | 修改账单（带入原数据，可删除） | — |
| `/category` | 分类管理 · 一级 | 图 18 |
| `/category/:parentId/sub` | 分类管理 · 二级（底部弹层） | 图 15 |
| `/category/edit?scope=secondary&parentId=xxx` | 新建二级分类 | 图 17 |
| `/category/edit?id=xxx` | 修改分类 | 图 16 |
| `/stats` `/mine` | 统计 / 我的（含数据层状态） | — |

## 已实现的能力

- **支出**：创建（选分类 → 键盘输入金额 → 完成 / 再记）、查看（首页今日账单、账单页按日分组、日历视图）、搜索（备注 / 分类名 / 金额）、修改与删除。
- **账单页视图切换**：`流水` / `日历` 既点顶部胶囊切换，也可在列表区左右滑动切换。
- **账单页账期筛选**：点顶部日期打开底部选择器，可「按月查看」（选月份）或「按年查看」（选年份，一屏 12 年）筛选流水与日历；`‹ ›` 按月翻月、按年翻年。按年时日历视图变为 12 个月的年度总览，点某月下钻到该月。筛选只作用于账单页，首页与统计页始终是本月视角。
- **记账页交互**：进入默认选中第一个一级分类；点击备注框会列出该分类下用过的备注（从新到旧、可横向滑动填入）；草稿只在「记账页 ↔ 分类管理」往返时保留，用返回键或左上角返回退出即作废。
- **一级分类**：新建、宫格展示（含「有二级分类」角标）、编辑、删除（级联）。
- **二级分类**：新建（归属一级分类）、在记账页展开选择、在管理页列表展示、编辑、删除。
- **分类图标选择器**：左侧分类分组 ↔ 右侧图标区双向联动滚动，内置 10 组约 100 个线性图标（纯本地 SVG，无外部依赖）。

## 目录结构

```
src/
  api/                    数据层（视图只依赖契约，不依赖实现）
    contract.js            实体类型 + Repository 接口契约 + 错误类型
    index.js               适配器装配（改 DATA_SOURCE 即可切换数据源）
    adapters/mockAdapter.js      本期实现：内存 + localStorage
    adapters/idbAdapter.js       预留：IndexedDB 离线缓存（含建库与索引定义）
    adapters/leancloudAdapter.js 预留：LeanCloud 增量同步（含 Class 设计与冲突策略）
    sync/outbox.js         增量同步队列（本地写入即入队）
    mock/seed.js           Mock 种子数据
  stores/                  Pinia：ledger / category / bill
  components/              通用组件（含 icons 图标库）
  views/                   页面
  utils/                   日期 / 金额 / id 工具
  styles/                  tokens.css（设计变量）+ base.css
```

## 从 Mock 切到「IndexedDB + LeanCloud」的步骤

1. `src/api/adapters/idbAdapter.js`：补齐 objectStore 读写（`openDB()` 已写好建库与索引）。写入时在同一事务内写业务表 + `outbox` 表。
2. `src/api/adapters/leancloudAdapter.js`：实现 `initialize / push / pull / syncAll`，按 `outbox.pending()` 推送，以 `updatedAt` 为水位拉取，冲突「新者胜」。
3. 修改 `src/api/index.js` 的 `DATA_SOURCE` 为 `'idb'`。
4. 视图层与 store 层无需改动 —— 所有调用都走同一套 Promise 契约。

## 说明

- 设计变量集中在 `src/styles/tokens.css`，改主题色只需动 `--brand*`。
- 数据默认持久化在 `localStorage`（键 `ledger.db.v1`）；「我的 → 重置演示数据」可恢复初始 Mock。
- 参考截图见仓库根目录 `微信图片_*.jpg`、`填写备注.jpg`、`月选择器.jpg`、`年选择器.jpg`，页面结构说明见 `page-structure.md`，实施计划见 `ui-implementation-plan.md`。
