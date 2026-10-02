/**
 * S8-1 断言：数据备份（导出 / 导入）
 * ------------------------------------------------------------
 * 这一组盯住的是「数据不能只交给一家厂商」这条底线（LeanCloud 停服那一课）。
 * 导出/导入看起来只是两个按钮，但真正的风险全在**合并规则**上：
 *
 *   1. **导入不能弄丢数据** —— 它必须只做增量合并，绝不删本地已有的东西。
 *      反例（设计时否掉的方案）：整库替换。用户「把另一台设备的账并过来」
 *      的期待会被它变成「我本机的账全没了」。
 *   2. **导入必须幂等** —— 同一份文件点两次不能变成两倍账单。
 *      第一次点没反应/以为没成功，再点一次是极常见的用户行为；
 *      幂等不是加分项，是合格线。这里断言的是「再导一次全部 skip」。
 *   3. **导入不能复活旧数据** —— 本地那条已经被改到更新，导入一份旧备份
 *      不能把它改回去。「新者胜」必须对**两个方向**都成立。
 *   4. **坏数据不能带崩整份导入** —— 手工编辑过的、或来自早期版本的备份，
 *      有一条字段不合法就整份拒绝，用户就永远导不进自己的数据了。
 *      所以逐条校验、坏条计数跳过。
 *
 * 这里能测的（纯函数 + fake-indexeddb）：格式构造、解析与校验、合并计划三分支、
 *   「导出 → 空库导入」往返、幂等、同步队列入队、身份凭据不外泄。
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
    noReimburse: false,
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
    noReimburse: false,
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
    noReimburse: false,
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

  const withAccount = buildBackup({
    data: DATA,
    account: { label: '手机号 138****1234', signedIn: true, uid: 'SECRET_UID_SHOULD_NOT_LEAK' }
  })
  t.eq('1j ★ 身份凭据（uid）不写进备份文件', Object.keys(withAccount.account).sort(), [
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
    noReimburse: false,
    createdAt: 1000,
    updatedAt: 1000,
    version: 1
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
  t.eq('5c 落盘计数', r1, { created: 5, updated: 0 })

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
  t.eq('5j 第二次落盘写 0 条', r2, { created: 0, updated: 0 })
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
  t.eq('5n 空计划 + 空入参不炸', r3, { created: 0, updated: 0 })
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
}

t.done()
