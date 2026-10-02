/**
 * S8-1 断言：数据备份（导出 / 导入）
 * ------------------------------------------------------------
 * 这一组盯住的是「数据不能只交给一家厂商」这条底线（LeanCloud 停服那一课）。
 * 导出/导入看起来只是两个按钮，但真正的风险全在**合并规则**上：
 *
 *   1. **合并模式不能弄丢数据** —— 它只做增量合并，绝不删本地已有的东西。
 *      反例（设计时否掉的方案）：把「合并」实现成整库替换。用户「把另一台
 *      设备的账并过来」的期待会被它变成「我本机的账全没了」。
 *   2. **两种模式都必须幂等** —— 同一份文件点两次不能变成两倍账单。
 *      第一次点没反应/以为没成功，再点一次是极常见的用户行为；
 *      幂等不是加分项，是合格线。
 *   3. **合并模式不能复活旧数据** —— 本地那条已经被改到更新，导入一份旧备份
 *      不能把它改回去。「新者胜」必须对**两个方向**都成立。
 *   4. **恢复模式要真能找回误删** —— 这正是它存在的理由。本项目的删除是软删
 *      （留墓碑 + 抬高 `updatedAt`），所以「导出 → 删错 → 再导入」在合并口径下
 *      会静默失败（第 8 组 8a 就是这个反例的固化）；恢复必须无视 `updatedAt`、
 *      以备份为准。
 *   5. **恢复的「清除」只能软删** —— 物理删除会让其他设备的下一次回拉把它当成
 *      云端还没有的新数据又拉回来。这条只能在真实适配器上断言（第 9 组 9g）。
 *   6. **坏数据不能带崩整份导入** —— 手工编辑过的、或来自早期版本的备份，
 *      有一条字段不合法就整份拒绝，用户就永远导不进自己的数据了。
 *      所以逐条校验、坏条计数跳过。
 *
 * 这里能测的（纯函数 + fake-indexeddb）：格式构造、解析与校验、合并与恢复两份
 *   计划、软删落盘、「导出 → 空库导入」往返、两种模式的幂等、同步队列入队、
 *   身份凭据不外泄。
 *
 * 这里**测不了**的：真实浏览器的 file 选择与下载（`<input type=file>`、Blob URL），
 *   那靠手工走查；`api/index.js` 的三层编排（exportBackup / previewImport /
 *   applyImport）只是把本文件的纯逻辑接起来，其中「写前再裁决一次」复用同一份
 *   `planImport`，它的正确性由第 3 组覆盖。
 *
 * 运行：node scripts/backup-test.mjs（已并入 npm run test:data）
 */

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
}
globalThis.window = globalThis

const ROOT = new URL('../', import.meta.url).href
const SRC = `${ROOT}src/`

await import(`${ROOT}node_modules/fake-indexeddb/auto/index.mjs`)

const { DB_VERSION, STORES, openDB, putMany } = await import(`${SRC}api/core/idb.js`)
const { createIdbAdapter } = await import(`${SRC}api/adapters/idbAdapter.js`)
const {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFileName,
  buildBackup,
  isPlanEmpty,
  parseBackup,
  planImport,
  planRestore,
  pickAlive
} = await import(`${SRC}api/core/backup.js`)

/* 断言与汇总统一走 scripts/_harness.mjs（输出格式见该文件顶部说明） */
import { createSuite } from './_harness.mjs'
import { readFileSync } from 'node:fs'

const t = createSuite('backup-test')

/** 每个用例用独立库名，避免相互污染 */
let seq = 0
const nextDb = (label) => `t_backup_${label}_${++seq}`

/* ---------------- 造数据 ---------------- */

const L = {
  id: 'ledger_default',
  name: '默认账本',
  /** ⚠️ S8-5 已从契约删除：故意留着，用第 1 组 1j 验证它被白名单滤掉 */
  ownerId: '',
  createdAt: 1000,
  updatedAt: 1000,
  deleted: 0
}

const C = [
  {
    id: 'cat_food',
    name: '吃喝',
    icon: 'bowl',
    parentId: null,
    type: 'expense',
    ledgerId: 'ledger_default',
    order: 0,
    createdAt: 1000,
    updatedAt: 1000,
    deleted: 0
  },
  {
    id: 'sub_rice',
    name: '米饭',
    icon: 'bowl',
    parentId: 'cat_food',
    type: 'expense',
    ledgerId: 'ledger_default',
    order: 0,
    createdAt: 1000,
    updatedAt: 1000,
    deleted: 0
  }
]

const B = [
  {
    id: 'bill_1',
    ledgerId: 'ledger_default',
    type: 'expense',
    amount: 12.5,
    categoryId: 'sub_rice',
    primaryCategoryId: 'cat_food',
    remark: '午饭',
    date: '2026-10-01',
    /** ⚠️ S8-5 已从契约删除：故意留着，用第 1 组 1j 验证它被白名单滤掉 */
    noReimburse: false,
    version: 1,
    createdAt: 1000,
    updatedAt: 1000,
    deleted: 0,
    /** 同步元数据：**不该**出现在备份文件里（见第 1 组 1d） */
    serverUpdatedAt: 999999
  },
  {
    id: 'bill_2',
    ledgerId: 'ledger_default',
    type: 'income',
    amount: 8000,
    categoryId: null,
    primaryCategoryId: null,
    remark: '工资',
    date: '2026-10-01',
    createdAt: 1001,
    updatedAt: 1001,
    deleted: 0
  },
  {
    id: 'bill_3',
    ledgerId: 'ledger_default',
    type: 'expense',
    amount: 66,
    categoryId: null,
    primaryCategoryId: null,
    remark: '被删掉的账',
    date: '2026-10-02',
    createdAt: 1002,
    updatedAt: 1002,
    /** 软删除墓碑：**不该**出现在备份文件里（见第 1 组 1c） */
    deleted: 1
  }
]

const DATA = { ledgers: [L], categories: C, bills: B }

/* ---------------- 1. 导出构造 ---------------- */

t.group('1. buildBackup：导出格式是契约，只含用户可见的数据')

{
  const bk = buildBackup({ data: DATA, exportedAt: 1700000000000 })

  t.eq('1a 顶层字段固定', Object.keys(bk).sort(), [
    'account',
    'app',
    'counts',
    'data',
    'dataSource',
    'exportedAt',
    'format',
    'version'
  ])
  t.ok('1b format / version 是识别标记', bk.format === BACKUP_FORMAT && bk.version === BACKUP_VERSION)
  t.eq('1c 三类集合的键名（复数，与集合名解耦）', Object.keys(bk.data).sort(), [
    'bills',
    'categories',
    'ledgers'
  ])
  t.eq('1d ★ 软删除的文档不进备份', bk.counts.bills, 2)
  t.eq('1e counts 与 data 实际条数一致', bk.counts, {
    ledgers: 1,
    categories: 2,
    bills: 2
  })
  t.ok(
    '1f ★ 同步元数据（serverUpdatedAt）不进备份',
    bk.data.bills.every((d) => d.serverUpdatedAt === undefined)
  )
  t.eq('1g 导出保留 createdAt / updatedAt 原始值（不改成导出时刻）', [
    bk.data.bills[0].createdAt,
    bk.data.bills[0].updatedAt
  ], [1000, 1000])
  t.ok('1h deleted 字段不进备份（导入时统一补 0）', bk.data.bills.every((d) => d.deleted === undefined))
  t.ok('1i pickAlive：没有 deleted 字段视为活着', pickAlive([{ id: 'a' }, { id: 'b', deleted: 1 }]).length === 1)

  /**
   * S8-5 反例：`noReimburse` / `version` / `ownerId` 已从契约里删除，
   * 但**历史备份文件里可能还带着它们**（旧版本导出的），老库里也可能残留。
   * 上面 L / B 里特意留了这些字段 —— 导出与导入都必须靠白名单把它们滤掉，
   * 否则删掉的字段会顺着备份文件「复活」。
   */
  t.ok(
    '1j ★ S8-5 已删除的字段既不进备份、也不被导入',
    bk.data.bills.every((d) => d.noReimburse === undefined && d.version === undefined) &&
      bk.data.ledgers.every((d) => d.ownerId === undefined) &&
      parseBackup(JSON.stringify(bk)).backup.data.bills.every(
        (d) => d.noReimburse === undefined && d.version === undefined
      ) &&
      parseBackup(JSON.stringify(bk)).backup.data.ledgers.every((d) => d.ownerId === undefined)
  )

  const withAccount = buildBackup({
    data: DATA,
    account: { label: '手机号 138****1234', signedIn: true, uid: 'SECRET_UID_SHOULD_NOT_LEAK' }
  })
  t.eq('1k ★ 身份凭据（uid）不写进备份文件', Object.keys(withAccount.account).sort(), [
    'label',
    'signedIn'
  ])
}

/* ---------------- 2. 解析与校验 ---------------- */

t.group('2. parseBackup：整份不合格就拒绝，单条不合格只跳过那一条')

{
  t.ok('2a 非 JSON → 整份拒绝', parseBackup('{ not json').ok === false)
  t.ok('2b 不是本产品的备份 → 整份拒绝', parseBackup(JSON.stringify({ foo: 1 })).ok === false)
  t.ok(
    '2c ★ 版本比自己新 → 整份拒绝（不猜着导入）',
    parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION + 1, data: {} })).ok === false
  )
  t.ok(
    '2d 缺版本号 → 整份拒绝',
    parseBackup(JSON.stringify({ format: BACKUP_FORMAT, data: {} })).ok === false
  )

  const good = parseBackup(JSON.stringify(buildBackup({ data: DATA })))
  t.ok('2e 自己导出的文件自己认', good.ok === true)
  t.eq('2f 解析后的条数', good.backup.counts, { ledgers: 1, categories: 2, bills: 2 })
  t.eq('2g 好数据没有 invalid 计数', good.invalid, { ledgers: 0, categories: 0, bills: 0 })

  // 文件里自报的 counts 是**不可信**的（可能被人改过）—— 计数必须按解析结果算
  const lying = {
    format: BACKUP_FORMAT,
    version: 1,
    counts: { ledgers: 999, categories: 999, bills: 999 },
    data: { bills: B.slice(0, 1) }
  }
  const parsedLying = parseBackup(JSON.stringify(lying))
  t.eq('2h ★ counts 按解析结果重算，不信文件自报', parsedLying.backup.counts.bills, 1)

  const dirty = {
    format: BACKUP_FORMAT,
    version: 1,
    data: {
      ledgers: [L],
      categories: [
        C[0],
        { ...C[1], id: '' }, // 缺 id
        { ...C[1], id: 'sub_bad', name: '   ' }, // 名称空
        { ...C[1], id: 'sub_bad2', type: 'weird' } // 类型不在枚举里
      ],
      bills: [
        B[0],
        { ...B[0], id: 'bill_bad1', amount: 0 }, // 金额非正
        { ...B[0], id: 'bill_bad2', amount: 'x' }, // 金额非数字
        { ...B[0], id: 'bill_bad3', date: '2026/10/01' }, // 日期格式非法
        { ...B[0], id: 'bill_bad4', date: '' }
      ]
    }
  }
  const parsedDirty = parseBackup(JSON.stringify(dirty))
  t.ok('2i ★ 坏数据不打断整份导入', parsedDirty.ok === true)
  t.eq('2j 坏条逐条计数', parsedDirty.invalid, { ledgers: 0, categories: 3, bills: 4 })
  t.eq('2k 只有合法的留下来', parsedDirty.backup.counts, {
    ledgers: 1,
    categories: 1,
    bills: 1
  })

  const dup = {
    format: BACKUP_FORMAT,
    version: 1,
    data: {
      bills: [
        { ...B[0], updatedAt: 10 },
        { ...B[0], amount: 99, updatedAt: 20 }
      ]
    }
  }
  const parsedDup = parseBackup(JSON.stringify(dup))
  t.eq('2l ★ 文件里同 id 两条 → 取 updatedAt 新的那条', parsedDup.backup.data.bills.length, 1)
  t.eq('2m 取到的是新的那条', parsedDup.backup.data.bills[0].amount, 99)

  const empty = parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, data: {} }))
  t.ok('2n 空备份是合法的（只是没东西可导）', empty.ok === true)
  t.eq('2o 空备份 count 全 0', empty.backup.counts, {
    ledgers: 0,
    categories: 0,
    bills: 0
  })

  // 迁移字段的容错：老文档里的 transfer / lending 要能照常进出（枚举保留的历史取值）
  const legacy = parseBackup(
    JSON.stringify({ format: BACKUP_FORMAT, version: 1, data: { bills: [{ ...B[0], type: 'transfer' }] } })
  )
  t.eq('2p 早期版本写过的 transfer 类型照常通过', legacy.backup.data.bills[0].type, 'transfer')
  t.eq(
    '2q 但未知类型会兜底成 expense（不至于丢掉整条账）',
    parseBackup(
      JSON.stringify({ format: BACKUP_FORMAT, version: 1, data: { bills: [{ ...B[0], type: 'nope' }] } })
    ).backup.data.bills[0].type,
    'expense'
  )
}

/* ---------------- 3. 合并计划 ---------------- */

t.group('3. planImport：只做增量合并，绝不删本地已有的东西')

{
  const incoming = { ledgers: [L], categories: C, bills: B.slice(0, 2) }

  const empty = planImport({ local: { ledgers: [], categories: [], bills: [] }, incoming })
  t.eq('3a 本地空 → 全部新增', empty.counts, { create: 5, update: 0, skip: 0 })
  t.ok('3b 不会产生删除动作（plan 里根本没有 delete 这个键）', !('delete' in empty))

  const same = planImport({ local: DATA, incoming })
  t.eq('3c ★ 本地一模一样 → 全部跳过（幂等的根据）', same.counts, { create: 0, update: 0, skip: 5 })

  const backupNewer = planImport({
    local: { ledgers: [{ ...L, updatedAt: 10 }], categories: [], bills: [] },
    incoming: { ledgers: [{ ...L, name: '云端改的', updatedAt: 20 }], categories: [], bills: [] }
  })
  t.eq('3d 备份更新 → 更新', backupNewer.counts, { create: 0, update: 1, skip: 0 })
  t.eq('3e 更新拿的是备份那份', backupNewer.update.ledgers[0].name, '云端改的')

  const localNewer = planImport({
    local: { ledgers: [{ ...L, name: '本机改的', updatedAt: 30 }], categories: [], bills: [] },
    incoming: { ledgers: [{ ...L, name: '旧备份', updatedAt: 20 }], categories: [], bills: [] }
  })
  t.eq('3f ★ 本地更新 → 跳过，备份不覆盖新数据', localNewer.counts, { create: 0, update: 0, skip: 1 })

  const localOnly = planImport({
    local: { ledgers: [L], categories: [], bills: [{ ...B[1], id: 'bill_local_only' }] },
    incoming: { ledgers: [], categories: [], bills: [] }
  })
  t.eq('3g ★ 备份里没有的本地文档一条都不动', localOnly.counts, { create: 0, update: 0, skip: 0 })
  t.eq('3h 而且不会出现在 create / update 里', [
    localOnly.create.bills.length,
    localOnly.update.bills.length
  ], [0, 0])

  const revive = planImport({
    local: { ledgers: [], categories: [], bills: [{ ...B[0], deleted: 1, updatedAt: 5 }] },
    incoming: { ledgers: [], categories: [], bills: [{ ...B[0], updatedAt: 6 }] }
  })
  t.eq('3i ★ 本地删过、但备份更晚 → 恢复（算 update）', revive.counts, { create: 0, update: 1, skip: 0 })

  t.ok('3j isPlanEmpty 认出空计划', isPlanEmpty(same) === true)
  t.ok('3k 非空计划不会被误判为空', isPlanEmpty(empty) === false)
}

/* ---------------- 4. 往返自洽 ---------------- */

t.group('4. 往返：导出的对象必须能被自己解析回来')

{
  const bk = buildBackup({ data: DATA, exportedAt: 1700000000000 })
  const parsed = parseBackup(JSON.stringify(bk))
  t.ok('4a 导出 → JSON → 解析 全链路通过', parsed.ok === true)
  t.eq('4b 往返后条数不变', parsed.backup.counts, bk.counts)
  t.eq('4c 往返后一条坏数据都没有', parsed.invalid, { ledgers: 0, categories: 0, bills: 0 })
  t.eq('4d 往返后账单字段逐个保住', parsed.backup.data.bills[0], {
    id: 'bill_1',
    ledgerId: 'ledger_default',
    type: 'expense',
    amount: 12.5,
    categoryId: 'sub_rice',
    primaryCategoryId: 'cat_food',
    remark: '午饭',
    date: '2026-10-01',
    createdAt: 1000,
    updatedAt: 1000
  })
}

/* ---------------- 5. 端到端：导出 → 空库导入 → 再导一次 ---------------- */

t.group('5. ★ 端到端：往返不丢数据、导两次不翻倍')

{
  // 设备 A：把三类文档直接灌进库（绕开写路径，模拟「已经用了一阵子」）
  const dbA = nextDb('a')
  const rawA = await openDB({ dbName: dbA, version: DB_VERSION })
  await putMany(rawA, STORES.LEDGER, [L])
  await putMany(rawA, STORES.CATEGORY, C)
  await putMany(rawA, STORES.BILL, B)

  const a = createIdbAdapter({ dbName: dbA, seed: false })
  await a.ready()
  const backupA = buildBackup({ data: await a.backup.dump() })
  t.eq('5a 导出的是活文档（墓碑不在里面）', backupA.counts, {
    ledgers: 1,
    categories: 2,
    bills: 2
  })

  // 设备 B：全新空库
  const dbB = nextDb('b')
  const rawB = await openDB({ dbName: dbB, version: DB_VERSION })
  const b = createIdbAdapter({ dbName: dbB, seed: false })
  await b.ready()

  const plan1 = planImport({ local: await b.backup.dump(), incoming: backupA.data })
  t.eq('5b 首次导入全部是新增', plan1.counts, { create: 5, update: 0, skip: 0 })
  const r1 = await b.backup.apply(plan1)
  t.eq('5c 落盘计数', r1, { created: 5, updated: 0, removed: 0 })

  const snapB = await b.snapshot()
  t.eq('5d 账单条数与备份一致', snapB.bills.length, 2)
  t.eq('5e 分类条数与备份一致', snapB.categories.length, 2)
  t.eq(
    '5f ★ 导入保留备份里的 updatedAt（不改成导入时刻）',
    snapB.bills.find((x) => x.id === 'bill_1').updatedAt,
    1000
  )
  t.eq(
    '5g 新写入的文档 deleted 归零（覆盖本地可能的墓碑）',
    snapB.bills.every((x) => x.deleted === 0),
    true
  )
  t.eq('5h ★ 导入的文档进了同步队列（登录后会推上云）', await b.sync.pendingCount(), 5)

  // 幂等：同一份文件再导一次
  const plan2 = planImport({ local: await b.backup.dump(), incoming: backupA.data })
  t.eq('5i ★★ 再导一次：全部跳过，一条都不重复', plan2.counts, { create: 0, update: 0, skip: 5 })
  const r2 = await b.backup.apply(plan2)
  t.eq('5j 第二次落盘写 0 条', r2, { created: 0, updated: 0, removed: 0 })
  t.eq('5k 库里条数没有翻倍', (await b.snapshot()).bills.length, 2)

  // 反方向：本地已经更新过，旧备份不能把它改回去
  await b.sync.clearOutbox()
  await putMany(rawB, STORES.BILL, [{ ...B[0], amount: 99, updatedAt: 5000 }])
  const plan3 = planImport({ local: await b.backup.dump(), incoming: backupA.data })
  t.eq('5l ★ 本地更新过 ⇒ 旧备份一律跳过', plan3.counts, { create: 0, update: 0, skip: 5 })
  await b.backup.apply(plan3)
  const after = await b.snapshot()
  t.eq(
    '5m ★ 本地那份数值没被旧备份覆盖',
    after.bills.find((x) => x.id === 'bill_1').amount,
    99
  )

  // 空库不接受任何东西：坏计划不该写坏数据
  const dbC = nextDb('c')
  const c = createIdbAdapter({ dbName: dbC, seed: false })
  await c.ready()
  const r3 = await c.backup.apply({})
  t.eq('5n 空计划 + 空入参不炸', r3, { created: 0, updated: 0, removed: 0 })
  t.eq('5o 也没有因此入队任何东西', await c.sync.pendingCount(), 0)
}

/* ---------------- 6. 文件名 ---------------- */

t.group('6. 导出文件名')

{
  const name = backupFileName(new Date(2026, 9, 2, 18, 3))
  t.eq('6a 文件名带本地日期与时分', name, '随手记账-2026-10-02-1803.json')
  t.ok('6b 文件名以 .json 结尾', name.endsWith('.json'))
}

/* ---------------- 7. 门禁与隐私的静态守卫 ---------------- */

t.group('7. ★ 静态守卫：漏了门禁 / 泄漏凭据，单测必须能发现')

{
  const sheetSrc = readFileSync(new URL('../src/components/BackupSheet.vue', import.meta.url), 'utf8')

  /**
   * 导入是**批量写**（会落库 + 入队推上云），必须过写操作门禁。
   * 这条用源码扫描而不是行为断言：门禁是 UI 层调用，没有可注入的上下文
   * （`requireLogin` 不传 ctx 时会去读 Pinia，Node 里跑不动）。
   * 盯住这一条的理由 —— 漏掉它不会让任何功能变红，只会让未登录用户
   * 静默写进本地分区，正是 S7 要防的那类问题。
   */
  t.ok('7a ★ 导入前调用写操作门禁', /requireLogin\(\s*['"]导入备份['"]\s*\)/.test(sheetSrc))

  // 精确取 doExport 函数体再判断，比「doExport 后 400 字符内没有 requireLogin」可靠
  const exportBody = sheetSrc.slice(
    sheetSrc.indexOf('async function doExport'),
    sheetSrc.indexOf('/* ---------------- 导入 ---------------- */')
  )
  t.ok('7b ★ 导出**不**被门禁拦住（纯读操作，数据本来就在本机）', exportBody.length > 0 && !exportBody.includes('requireLogin'))
  t.ok(
    '7c 导入失败/成功后都会刷新首页与账期两个切片',
    /billStore\.refresh\(\)/.test(sheetSrc) && /billStore\.refreshPeriod\(\)/.test(sheetSrc)
  )

  /**
   * 恢复是**不可逆**的（它会删本机数据），所以「按钮只负责开确认弹层、
   * 真正写库在 confirm 回调里」这件事必须锁住。同样只能源码扫描 ——
   * 确认弹层的交互没有可注入的上下文。
   */
  t.ok(
    '7d ★ 恢复必须经过二次确认（开弹层与写库分成两步）',
    /function askRestore\(\)[\s\S]{0,400}?restoreAsk\.value = true/.test(sheetSrc) &&
      /function doRestore\(\)[\s\S]{0,200}?runImport\('restore'\)/.test(sheetSrc)
  )
  t.ok('7e 主按钮绑的是 askRestore（不直接写）', /@click="askRestore"/.test(sheetSrc))
  t.ok('7f 确认弹层接了 confirm → doRestore', /@confirm="doRestore"/.test(sheetSrc))
  t.ok(
    '7g ★ 确认正文给出精确到秒的时刻与「不可撤销」',
    /formatFullTimeCN/.test(sheetSrc) && /不可撤销/.test(sheetSrc)
  )
  t.ok('7h 危险抉择不因误点遮罩而替用户决定', /:mask-closable="false"/.test(sheetSrc))

  /**
   * 适配器侧的硬约束：清除**只能软删**。一旦有人在备份落盘里用上物理删除
   * （`removeMany` / `clearStore`），其他设备的下一次回拉会把那些记录当成
   * 「云端还没有的新数据」又拉回来。第 9 组 9g 是行为断言，这里是源码守卫。
   */
  const adapterSrc = readFileSync(new URL('../src/api/adapters/idbAdapter.js', import.meta.url), 'utf8')
  const backupBlock = adapterSrc.slice(
    adapterSrc.indexOf('const backupApi = {'),
    adapterSrc.indexOf('/* ---------------- 同步 ---------------- */')
  )
  t.ok(
    '7i ★ 备份落盘只用 putMany（清除写墓碑），不碰物理删除',
    backupBlock.length > 0 && /putMany\(/.test(backupBlock) && !/removeMany|clearStore/.test(backupBlock)
  )
}

/* ---------------- 8. 恢复计划（纯逻辑） ---------------- */

t.group('8. ★ planRestore：删错了能用备份找回来（不可逆，判据必须钉死）')

{
  const incoming = { ledgers: [L], categories: C, bills: B.slice(0, 2) }

  // 本地删过一笔（墓碑 updatedAt = 9000，比备份里的 1000 新）
  const localAfterDelete = {
    ledgers: [L],
    categories: C,
    bills: [{ ...B[0], deleted: 1, updatedAt: 9000 }, B[1]]
  }

  const merge = planImport({ local: localAfterDelete, incoming })
  t.eq('8a ★ 反例固化：合并口径下「删了再导」一条都找不回来', merge.counts, {
    create: 0,
    update: 0,
    skip: 5
  })

  const restore = planRestore({ local: localAfterDelete, incoming })
  t.eq('8b ★ 恢复口径下：那笔被找回，内容一致的其余照旧跳过', restore.counts, {
    create: 0,
    update: 1,
    skip: 4,
    remove: 0,
    revive: 1
  })
  t.eq('8c 找回的就是备份里那一笔', restore.update.bills.map((d) => d.id), ['bill_1'])
  t.ok(
    '8d planner 是纯函数，不改入参（调用方可以直接复用 backup.data）',
    localAfterDelete.bills[0].deleted === 1 && incoming.bills[0].deleted === 0
  )

  // 覆盖：恢复不看 updatedAt，只以备份为准
  const localNewerArgs = {
    local: { ledgers: [], categories: [], bills: [{ ...B[0], amount: 99, updatedAt: 5000 }] },
    incoming: { ledgers: [], categories: [], bills: [{ ...B[0], updatedAt: 1000 }] }
  }
  t.eq('8e 反例：合并口径下本地改过 ⇒ 旧备份不覆盖', planImport(localNewerArgs).counts, {
    create: 0,
    update: 0,
    skip: 1
  })
  const covered = planRestore(localNewerArgs)
  t.eq('8f ★ 恢复口径下：本地改过的也被备份盖回去', covered.counts, {
    create: 0,
    update: 1,
    skip: 0,
    remove: 0,
    revive: 0
  })
  t.eq('8g 盖回去用的是备份那份的值', covered.update.bills[0].amount, 12.5)

  // 清除：本机有、备份里没有 ⇒ remove 桶
  const extra = planRestore({
    local: { ledgers: [L], categories: [], bills: [{ ...B[1], id: 'bill_extra' }] },
    incoming: { ledgers: [L], categories: [], bills: [] }
  })
  t.eq('8h ★ 本机多出来的记录进 remove 桶（合并口径下则一条都不动）', extra.counts, {
    create: 0,
    update: 0,
    skip: 1,
    remove: 1,
    revive: 0
  })
  t.eq('8i remove 桶装的是 id', extra.remove.bills, ['bill_extra'])

  const alreadyGone = planRestore({
    local: { ledgers: [L], categories: [], bills: [{ ...B[1], deleted: 1, updatedAt: 9000 }] },
    incoming: { ledgers: [L], categories: [], bills: [] }
  })
  t.eq('8j ★ 已是墓碑的记录不会再进 remove（幂等的另一半）', alreadyGone.counts.remove, 0)

  // 墓碑 + 备份内容一致 ⇒ 仍要复活（内容比对刻意不看 deleted）
  const reviveSame = planRestore({
    local: { ledgers: [], categories: [], bills: [{ ...B[0], deleted: 1 }] },
    incoming: { ledgers: [], categories: [], bills: [{ ...B[0] }] }
  })
  t.eq('8k ★ 墓碑 + 备份内容一致 ⇒ 仍判复活（不能因「内容相同」而漏掉）', reviveSame.counts, {
    create: 0,
    update: 1,
    skip: 0,
    remove: 0,
    revive: 1
  })

  // 账本保护：备份里一个账本都没有时不能把本机账本删空
  const guard = planRestore({
    local: { ledgers: [L], categories: C, bills: [] },
    incoming: { ledgers: [], categories: [], bills: [] }
  })
  t.eq('8l ★ 备份里没有账本 ⇒ 不删本机账本（没有账本 App 起不来）', guard.remove.ledgers, [])
  t.eq('8m 但分类该清就清（只有账本受这层保护）', guard.remove.categories, ['cat_food', 'sub_rice'])
  t.eq('8n remove 总数 = 被清掉的分类数', guard.counts.remove, 2)

  t.ok(
    '8o ★ 只清除不新增的计划不算空计划（否则按钮会被误禁用）',
    isPlanEmpty({ counts: { create: 0, update: 0, remove: 2 } }) === false
  )
  t.ok('8p 真正无事可做的计划仍算空', isPlanEmpty({ counts: { create: 0, update: 0, remove: 0 } }) === true)

  t.eq('8q 空入参不炸', planRestore({}).counts, { create: 0, update: 0, skip: 0, remove: 0, revive: 0 })
  t.eq(
    '8r 备份为空 ⇒ 只清除，不误判成新增',
    planRestore({ local: { ledgers: [L], categories: [], bills: [B[0]] }, incoming: {} }).counts.create,
    0
  )
}

/* ---------------- 9. 端到端：导出 → 误删 → 恢复 ---------------- */

t.group('9. ★ 端到端：误删能用备份找回，且「清除」走的是软删')

{
  const dbD = nextDb('restore')
  const rawD = await openDB({ dbName: dbD, version: DB_VERSION })
  await putMany(rawD, STORES.LEDGER, [L])
  await putMany(rawD, STORES.CATEGORY, C)
  await putMany(rawD, STORES.BILL, [B[0], B[1]])

  const d = createIdbAdapter({ dbName: dbD, seed: false })
  await d.ready()
  await d.sync.clearOutbox()

  const snapshot = buildBackup({ data: await d.backup.dump(), exportedAt: 1700000000000 })
  t.eq('9a 备份那一天有两条账单', snapshot.counts.bills, 2)

  // 误删一笔（走**真实**写路径，顺便验证它确实是软删）
  await d.bill.remove('bill_1')
  const tomb = (await d.backup.dump()).bills.find((x) => x.id === 'bill_1')
  t.ok(
    '9b ★ 删除是软删：墓碑留在库里、updatedAt 被抬到删除时刻',
    tomb && tomb.deleted === 1 && tomb.updatedAt > snapshot.data.bills.find((x) => x.id === 'bill_1').updatedAt
  )

  // 备份之后又记了一笔（恢复会把它清掉）
  await putMany(rawD, STORES.BILL, [{ ...B[0], id: 'bill_after', amount: 7, createdAt: 5000, updatedAt: 5000 }])
  await d.sync.clearOutbox()

  const plan = planRestore({ local: await d.backup.dump(), incoming: snapshot.data })
  t.eq('9c 恢复计划：找回 1 条、清除 1 条', {
    create: plan.counts.create,
    update: plan.counts.update,
    remove: plan.counts.remove,
    revive: plan.counts.revive
  }, { create: 0, update: 1, remove: 1, revive: 1 })

  const r = await d.backup.apply(plan)
  t.eq('9d 落盘计数', r, { created: 0, updated: 1, removed: 1 })

  const afterRestore = await d.backup.dump()
  const back = afterRestore.bills.find((x) => x.id === 'bill_1')
  t.ok('9e ★ 误删的那笔回来了（deleted 归零）', back && !back.deleted)
  t.eq('9f 恢复保留备份里的 updatedAt（幂等的根据）', back.updatedAt, 1000)

  const cleared = afterRestore.bills.find((x) => x.id === 'bill_after')
  t.ok('9g ★ 被清除的走的是软删（墓碑还在，没被物理删除）', cleared && cleared.deleted === 1)
  t.ok(
    '9h ★ 清除的墓碑时间戳比备份里的都新（否则云端会把这条又复活）',
    cleared.updatedAt > snapshot.exportedAt
  )

  t.eq('9i ★ 这批改动进了同步队列（登录后会推上云）', await d.sync.pendingCount(), 2)

  // 幂等：同一份备份再恢复一次
  const plan2 = planRestore({ local: await d.backup.dump(), incoming: snapshot.data })
  t.eq('9j ★★ 再恢复一次：写 0 条、清 0 条（恢复两次 = 恢复一次）', {
    create: plan2.counts.create,
    update: plan2.counts.update,
    remove: plan2.counts.remove
  }, { create: 0, update: 0, remove: 0 })
  const r2 = await d.backup.apply(plan2)
  t.eq('9k 第二次落盘什么也没写', r2, { created: 0, updated: 0, removed: 0 })

  const finalLive = (await d.backup.dump()).bills.filter((x) => !x.deleted)
  t.eq('9l ★ 活账单回到备份那一天的两条', finalLive.map((x) => x.id).sort(), ['bill_1', 'bill_2'])
  t.eq(
    '9m 被清的那条只剩墓碑（库里仍是 3 条 = 2 活 + 1 墓碑，没有物理删除）',
    (await d.backup.dump()).bills.length,
    3
  )

  // 恢复一份「空备份」不该把账本删掉（账本保护在真实库上再验一次）
  const emptyPlan = planRestore({ local: await d.backup.dump(), incoming: {} })
  await d.backup.apply(emptyPlan)
  t.eq('9n ★ 用空备份恢复后账本仍在（没账本 App 起不来）', (await d.backup.dump()).ledgers.filter((x) => !x.deleted).length, 1)
  t.eq('9o 账单则被清空（活文档 0 条）', (await d.backup.dump()).bills.filter((x) => !x.deleted).length, 0)
}

t.done()
