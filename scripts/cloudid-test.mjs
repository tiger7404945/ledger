/**
 * S4-7 断言：云端 `_id` 别名映射 + 换身份不再撞车
 * ------------------------------------------------------------
 * 这一组专门盯住 S4-7 那个真实缺陷：
 *
 *   缺陷：云端 `_id` 在集合内**跨账号全局唯一**，而 PRIVATE 权限按 `_openid`
 *         **隔离读** → 换身份（清 localStorage / 换设备）后，新身份看不见旧文档，
 *         却写不进同名 `_id`，抛 E11000，**首次绑定永久失败**、队列永远排不空。
 *
 *   修法（方案 A）：云端 `_id` 换成 `<账号前缀>_<本地 id>` 的别名，
 *         把唯一性范围收进账号内；本地 id 移进业务字段 `id` 作为权威来源。
 *
 * 这里能测的（纯函数 + 假云端 + 引擎）：
 *   - 别名映射与还原
 *   - 换身份后同名本地 id 不再冲突
 *   - 同一身份跨设备仍能按本地 id 合并（这是「本地 id 保持设备无关」的价值）
 *   - 全链路：outbox → 引擎 → 云端 → 换设备拉回，本地主键被正确还原
 *
 * 这里**测不了**的：真实服务端的 `_id` 唯一性与权限隔离 —— 那是
 * `.preview/sdk-probe/probe-alias.mjs` 的活（实测 6/6 通过）。
 *
 * 运行：node scripts/cloudid-test.mjs（已并入 npm run test:data）
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

const { createFakeCloud } = await import(`${SRC}api/sync/fakeCloud.js`)
const { createSyncEngine } = await import(`${SRC}api/sync/syncEngine.js`)
const { createOutbox } = await import(`${SRC}api/sync/outbox.js`)
const { createMemoryOutboxStore } = await import(`${SRC}api/sync/outboxStore.js`)
const { accountPrefixOf, toCloudId, toLocalId, CLOUD_ID_PREFIX_LENGTH } = await import(
  `${SRC}api/core/cloudId.js`
)
const { fromRemote, partitionRemote } = await import(`${SRC}api/core/merge.js`)

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) {
    pass += 1
    process.stdout.write(`✓ ${name}\n`)
  } else {
    fail += 1
    process.stdout.write(`✗ ${name}${detail ? '  — ' + detail : ''}\n`)
  }
}
const group = (t) => process.stdout.write(`\n== ${t} ==\n`)

/* ---------------- 1. 账号前缀 ---------------- */

group('1. accountPrefixOf：uid → 可放进 _id 的账号前缀')

ok('1a 去掉非字母数字', accountPrefixOf('kqjV1DcPvon2m-UE0E0XMQ') === 'kqjv1dcp')
ok('1b 统一小写', accountPrefixOf('ABCDEF12345') === 'abcdef12')
ok('1c 长度固定 8', accountPrefixOf('kqjV1DcPvon2m-UE0E0XMQ').length === CLOUD_ID_PREFIX_LENGTH)
ok('1d 短 uid 不补齐', accountPrefixOf('abc') === 'abc')
ok('1e 空 uid 兜底为 anon', accountPrefixOf(null) === 'anon' && accountPrefixOf('') === 'anon')
ok('1f 纯符号 uid 也兜底', accountPrefixOf('---___') === 'anon')
ok(
  '1g 两个真实 uid 的前缀不同（防冲突的根本）',
  accountPrefixOf('hVfpnRlq_AbAFDKrd4sxpw') !== accountPrefixOf('kqjV1DcPvon2m-UE0E0XMQ')
)

/* ---------------- 2. 别名映射 ---------------- */

group('2. toCloudId / toLocalId：双向映射')

const P1 = accountPrefixOf('hVfpnRlq_AbAFDKrd4sxpw')
const P2 = accountPrefixOf('kqjV1DcPvon2m-UE0E0XMQ')

ok('2a 别名 = 前缀 + 下划线 + 本地 id', toCloudId('ledger_default', P1) === `${P1}_ledger_default`)
ok(
  '2b ★ 同一本地 id 在不同账号下映射到不同别名（S4-7 修法的核心）',
  toCloudId('ledger_default', P1) !== toCloudId('ledger_default', P2),
  `${toCloudId('ledger_default', P1)} vs ${toCloudId('ledger_default', P2)}`
)
ok(
  '2c 本地 id 里的下划线不破坏映射（按前缀长度切分，不用 split）',
  toCloudId('bill_seed_001', P1) === `${P1}_bill_seed_001`
)
ok('2d toLocalId 优先取业务字段 id', toLocalId({ _id: `${P1}_bill_1`, id: 'bill_1' }) === 'bill_1')
ok('2e 业务字段缺失时退回 _id（兼容旧格式）', toLocalId({ _id: 'bill_1' }) === 'bill_1')
ok('2f 空文档返回 null', toLocalId(null) === null)

/* ---------------- 3. fromRemote 还原本地 id ---------------- */

group('3. fromRemote：云端文档 → 本地文档（别名场景）')

const remoteDoc = {
  _id: `${P1}_bill_seed_001`,
  _openid: 'hVfpnRlq_AbAFDKrd4sxpw',
  _serverTs: 1790000000000,
  id: 'bill_seed_001',
  amount: 40,
  updatedAt: 1789999999000
}
const local = fromRemote(remoteDoc)
ok('3a 本地 id 来自业务字段，不是别名', local.id === 'bill_seed_001', local.id)
ok(
  '3b 剥掉了 _id / _openid / _serverTs',
  !('_id' in local) && !('_openid' in local) && !('_serverTs' in local)
)
ok('3c 业务字段保留', local.amount === 40 && local.updatedAt === 1789999999000)
ok('3d 别名还原 ≠ 别名本身（确认没误用 _id）', local.id !== remoteDoc._id)

ok('3e 旧格式文档（_id 就是本地 id）也能还原', fromRemote({ _id: 'bill_old', amount: 1 }).id === 'bill_old')
ok('3f partitionRemote 走 fromRemote，id 也对', partitionRemote([], [remoteDoc]).take[0]?.id === 'bill_seed_001')

/* ---------------- 4. ★ 换身份不再撞车 ---------------- */

group('4. ★ 换身份：同名本地 id 不再冲突（S4-7 复现）')

const cloud = createFakeCloud()
const A = cloud.as('user_alpha')
const B = cloud.as('user_beta')

const doc = (id, amount, updatedAt) => ({ id, amount, updatedAt, deleted: 0 })

// 身份 A 先写下账本（本地 id 就是那个固定常量 ledger_default）
const aPush = await A.push('ledger', [doc('ledger_default', 100, 1000)])
ok('4a A 推成功', aPush.upserted.length === 1 && aPush.rejected.length === 0)
ok('4b A 云端有 1 条', cloud._size('ledger', 'user_alpha') === 1)

// 身份 B（模拟清 localStorage 后的新匿名身份）写**同一个本地 id**
const bPush = await B.push('ledger', [doc('ledger_default', 200, 2000)])
ok('4c ★ B 也推成功 —— 修复前这里必抛 E11000', bPush.upserted.length === 1)

// 两边互不干扰
const aPull = await A.pull('ledger', { since: 0 })
const bPull = await B.pull('ledger', { since: 0 })
ok('4d A 只看到自己的', aPull.docs.length === 1 && aPull.docs[0].amount === 100)
ok('4e B 只看到自己的', bPull.docs.length === 1 && bPull.docs[0].amount === 200)
ok(
  '4f 两边还原出的本地 id 相同（「本地 id 设备无关」的价值所在）',
  fromRemote(aPull.docs[0]).id === fromRemote(bPull.docs[0]).id
)
ok('4g 归属仍是各自的', aPull.docs[0]._openid === 'user_alpha' && bPull.docs[0]._openid === 'user_beta')

/* ---------------- 5. 跨设备收敛 ---------------- */

group('5. 同一身份两台设备：条件 upsert 未被别名改动破坏')

const d1 = cloud.as('user_gamma')
const d2 = cloud.as('user_gamma')

await d1.push('ledger', [doc('ledger_default', 300, 5000)])
const pulled = await d2.pull('ledger', { since: 0 })
ok('5a 设备 2 拉到设备 1 的账本', pulled.docs.length === 1 && pulled.docs[0].amount === 300)
ok('5b 还原出的本地 id 一致', fromRemote(pulled.docs[0]).id === 'ledger_default')

const stale = await d2.push('ledger', [doc('ledger_default', 999, 4000)])
ok('5c 更旧的版本被拒', stale.rejected.length === 1)
ok('5d ★ 被拒回的是本地 id（引擎靠它清队列）', stale.rejected[0].id === 'ledger_default')
ok('5e 云端仍是新版本', cloud._dump('ledger', 'user_gamma')[0].amount === 300)

const again = await d2.push('ledger', [doc('ledger_default', 300, 5000)])
ok('5f 重复推送不产生重复文档（幂等）', again.upserted.length === 1 && cloud._size('ledger', 'user_gamma') === 1)

/* ---------------- 6. 全链路（引擎 + outbox） ---------------- */

group('6. 全链路：outbox → 引擎 → 云端 → 换设备拉回')

/**
 * 最小的内存设备。
 * 关键契约：`store.get(collection, idOrIds)` —— 单 id 返对象、数组返数组。
 * syncEngine.pushPending 与 resolveRejected 都依赖这个双形态（见 S2 的接线）。
 */
function makeDevice() {
  let docs = new Map()
  const store = {
    async get(_collection, idOrIds) {
      if (Array.isArray(idOrIds)) return idOrIds.map((id) => docs.get(id) || null)
      return docs.get(idOrIds) || null
    },
    async all() {
      return [...docs.values()]
    },
    async applyRemote(_collection, remoteDocs) {
      const { take, keep } = partitionRemote([...docs.values()], remoteDocs)
      take.forEach((d) => docs.set(d.id, d))
      return { applied: take.length, kept: keep.length }
    }
  }
  const meta = new Map()
  const kv = {
    async get(k) {
      return meta.get(k) ?? null
    },
    async set(k, v) {
      meta.set(k, v)
    }
  }
  return {
    store,
    kv,
    put(d) {
      docs.set(d.id, d)
    },
    has(id) {
      return docs.has(id)
    },
    get(id) {
      return docs.get(id)
    },
    keys() {
      return [...docs.keys()]
    },
    wipe() {
      docs = new Map()
    }
  }
}

const cloud6 = createFakeCloud()
const devA = makeDevice()
devA.put(doc('ledger_default', 888, 7000))

const outboxA = createOutbox(createMemoryOutboxStore())
const engineA = createSyncEngine({
  outbox: outboxA,
  store: devA.store,
  meta: devA.kv,
  cloud: cloud6.as('user_delta')
})

await outboxA.enqueue({ collection: 'ledger', op: 'update', docId: 'ledger_default', payload: { ...doc('ledger_default', 888, 7000) } })
const r1 = await engineA.sync({ reason: 'test' })
ok('6a 引擎同步成功', r1.ok === true, JSON.stringify(r1))
ok('6b 推上去 1 条', r1.pushed === 1, `pushed=${r1.pushed}`)
ok('6c 队列已清空', (await outboxA.pendingCount()) === 0)
ok('6d 云端有这条', cloud6._size('ledger', 'user_delta') === 1)

// 换设备：本地清空，从云端恢复
const devB = makeDevice()
const engineB = createSyncEngine({
  outbox: createOutbox(createMemoryOutboxStore()),
  store: devB.store,
  meta: devB.kv,
  cloud: cloud6.as('user_delta')
})
const r2 = await engineB.sync({ reason: 'test' })
ok('6e 新设备拉回 1 条', r2.pulled >= 1, `pulled=${r2.pulled}`)
ok('6f ★ 本地主键被正确还原成 ledger_default', devB.has('ledger_default'), devB.keys().join(','))
ok('6g 金额一致', devB.get('ledger_default')?.amount === 888)
ok('6h 落本地时不带云端元数据', !('_id' in (devB.get('ledger_default') || {})))

// 换身份（模拟另一台设备的新用户）不冲突
const devC = makeDevice()
devC.put(doc('ledger_default', 111, 8000))
const outboxC = createOutbox(createMemoryOutboxStore())
const engineC = createSyncEngine({
  outbox: outboxC,
  store: devC.store,
  meta: devC.kv,
  cloud: cloud6.as('user_epsilon')
})
await outboxC.enqueue({ collection: 'ledger', op: 'update', docId: 'ledger_default', payload: { ...doc('ledger_default', 111, 8000) } })
const r3 = await engineC.sync({ reason: 'test' })
ok('6i ★ 另一身份的同一本地 id 也能同步（修复前必失败）', r3.ok === true && r3.pushed === 1, JSON.stringify(r3))
ok('6j 两边云端各自独立', cloud6._size('ledger', 'user_delta') === 1 && cloud6._size('ledger', 'user_epsilon') === 1)

process.stdout.write(`\n${pass} 通过 / ${fail} 失败\n`)
if (fail) process.exit(1)
