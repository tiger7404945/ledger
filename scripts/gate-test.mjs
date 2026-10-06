/**
 * 写操作登录门禁的断言（S7-5，新增脚本）
 * 运行：node scripts/gate-test.mjs
 *
 * 覆盖三件事：
 * 1. **路由表**：哪些入口需要登录。用**源码扫描**而不是 import —— 路由表里
 *    挂着 `.vue` 组件，Node 认不了单文件组件。扫描能防住「手滑删掉
 *    `meta.requiresAuth`」这种最危险的改动（删了不报错，只是门禁静默失效）。
 * 2. **判定真值表**：`shouldAllowWrite` 的三种输入组合。
 * 3. **弹层状态机**：打开 / 关闭 / 登录成功后执行挂起的动作（门禁的核心
 *    价值就是「登录完接着把原来那件事做完」）。
 */
import { readFileSync } from 'node:fs'
import { register } from 'node:module'

import { createSuite } from './_harness.mjs'

// 让 Node 也能解析 `@/`（见 _alias-loader.mjs 的说明）。必须在使用之前注册。
register(new URL('./_alias-loader.mjs', import.meta.url).href, import.meta.url)

const t = createSuite('gate-test')

/* ---------------- 1. 路由表：哪些入口需要登录 ---------------- */

{
  const routerSrc = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8')

  /**
   * 取某个 path 到**下一个** `path:` 之间的片段，在这段里找 requiresAuth。
   * ⚠️ 不能简单截 320 个字符：`/`（首页）后面紧跟着 `/bills`、`/record`，
   *    窗口一大就会把别人的 meta 算到自己头上（实测误报）。
   */
  const metaHasAuth = (path) => {
    const key = `path: '${path}'`
    const at = routerSrc.indexOf(key)
    if (at < 0) return null // null = 路由都没找到，与「没设 meta」要分开报
    const rest = routerSrc.slice(at + key.length)
    const next = rest.indexOf('path:')
    const seg = next < 0 ? rest : rest.slice(0, next)
    return /requiresAuth:\s*true/.test(seg)
  }

  t.ok('1a 记一笔（/record）需要登录', metaHasAuth('/record') === true)
  t.ok('1b 分类管理（/category）需要登录', metaHasAuth('/category') === true)
  t.ok('1c 分类编辑（/category/edit）需要登录', metaHasAuth('/category/edit') === true)

  // 读操作的三个 Tab 与「我的」不该被拦：未登录也要能看能算
  t.ok('1d 首页不拦', metaHasAuth('/') === false)
  t.ok('1e 账单页不拦', metaHasAuth('/bills') === false)
  t.ok('1f 统计页不拦', metaHasAuth('/stats') === false)
  t.ok('1g 我的页不拦', metaHasAuth('/mine') === false)

  // 守卫必须注册在草稿守卫之前：否则被拦下的导航会被草稿守卫当成「离开记账页」
  const guardAt = routerSrc.indexOf('router.beforeEach')
  const draftAt = routerSrc.indexOf('installRecordDraftGuard(router)')
  t.ok(
    '1h 门禁守卫注册在草稿守卫之前',
    guardAt >= 0 && draftAt >= 0 && guardAt < draftAt,
    `guards at ${guardAt} / draft at ${draftAt}`
  )

  // 未登录被拦下时，登录成功后要把这次导航接着做完
  t.ok('1i 被拦下的导航会登记「登录后继续」', /onSuccess|after/.test(routerSrc.slice(guardAt, guardAt + 500)))
}

/* ---------------- 2. 判定真值表 ---------------- */

const { shouldAllowWrite, requireLogin } = await import('@/composables/useLoginGate.js')
const sheetMod = await import('@/composables/useLoginSheet.js')
const sheet = sheetMod.useLoginSheet()

{
  t.ok(
    '2a 没配云端：放行（纯本地记账，没有登录这个概念）',
    shouldAllowWrite({ hasCloud: false, signedIn: false }) === true
  )
  t.ok('2b 配了云端 + 已登录：放行', shouldAllowWrite({ hasCloud: true, signedIn: true }) === true)
  t.ok('2c 配了云端 + 未登录：不放行', shouldAllowWrite({ hasCloud: true, signedIn: false }) === false)

  // 传空对象也不能抛（守卫早期可能拿不到完整上下文）
  t.ok('2d 空上下文默认放行', shouldAllowWrite() === true)

  /* requireLogin 的三态。第三个参数是**显式上下文**（给测试用的注入点），
     不传才去读真实的 cloud / account store。 */
  sheet.close()
  t.ok('2e 未登录：拦下本次写操作', requireLogin('记账', null, { hasCloud: true, signedIn: false }) === false)
  t.ok('2f 未登录：弹层被打开', sheet.state.open === true)
  t.ok('2g 未登录：说明里带上了动作名', sheet.state.reason.includes('记账'))

  sheet.close()
  t.ok('2h 已登录：放行且不弹层', requireLogin('记账', null, { hasCloud: true, signedIn: true }) === true && sheet.state.open === false)
  t.ok('2i 无云端：放行且不弹层', requireLogin('记账', null, { hasCloud: false, signedIn: false }) === true && sheet.state.open === false)
  sheet.close()
}

/* ---------------- 3. 弹层状态机与挂起动作 ---------------- */

{
  t.ok('3a 初始是关闭的', sheet.state.open === false)

  let ran = 0
  sheetMod.openLoginSheet({ reason: '为了记一笔', onSuccess: () => { ran += 1 } })
  t.ok('3b open 后可见且记下来意', sheet.state.open === true && sheet.state.reason === '为了记一笔')
  t.ok('3c 挂起的动作还没执行（要等登录成功）', ran === 0)

  sheetMod.closeLoginSheet()
  t.ok('3d 用户取消：弹层关闭、动作被丢弃', sheet.state.open === false && sheet.state.pending === null)

  await sheetMod.resolveLoginSheet()
  t.ok('3e 取消后 resolve 不会执行被丢弃的动作', ran === 0)

  // 正常路径
  sheetMod.openLoginSheet({ reason: '为了记一笔', onSuccess: () => { ran += 1 } })
  await sheetMod.resolveLoginSheet()
  t.ok('3f 登录成功：执行挂起的动作', ran === 1)
  t.ok('3g 登录成功：弹层关闭、状态清空', sheet.state.open === false && sheet.state.pending === null && sheet.state.reason === '')

  // 动作本身失败不该让弹层停在「开」的状态（先清状态再执行）
  sheetMod.openLoginSheet({ reason: 'x', onSuccess: () => { throw new Error('boom') } })
  let threw = false
  try {
    await sheetMod.resolveLoginSheet()
  } catch (e) {
    threw = true
  }
  t.ok('3h 挂起动作抛错：异常照常抛出（调用方能看到）', threw === true)
  t.ok('3i 挂起动作抛错：弹层已提前关闭、不会被卡住', sheet.state.open === false)

  // 登录动作里又触发门禁时，不能自己调自己
  sheetMod.openLoginSheet({ reason: 'x', onSuccess: () => {
    t.ok('3j 执行挂起动作时 pending 已清空（防递归）', sheet.state.pending === null && sheet.state.open === false)
  } })
  await sheetMod.resolveLoginSheet()

  // 没有挂起动作时（用户自己点登录按钮）也要能安全收尾
  sheetMod.openLoginSheet({ reason: '手动登录' })
  await sheetMod.resolveLoginSheet()
  t.ok('3k 无挂起动作时 resolve 安全返回', sheet.state.open === false)
}

/* ---------------- 4. 身份切换后的 store 刷新（真机踩坑回归） ---------------- */

/**
 * 真机实测（2026-10-02）：退出 → 重新登录后分类宫格空白。根因是
 * `runIdentityChange` 里 `resetLoadedStores()` 在 sync **之前**跑 —— 它读到的是
 * 「登录瞬间的空库」，而回拉完成后没有任何东西通知 store 重读。这两条用
 * **源码扫描**防住回归（删掉重刷调用不会报错，只会让 UI 静默停在空库快照）。
 */
{
  const accountSrc = readFileSync(new URL('../src/stores/account.js', import.meta.url), 'utf8')

  // period 切片有独立的守卫标志，漏了它账单页 / 统计页会一直显示上个分区的数据
  t.ok('4a resetLoadedStores 会重置 periodInitialized', /periodInitialized\s*=\s*false/.test(accountSrc))

  // sync（account-change）完成之后必须再刷一次 store，回拉结果才能进 UI
  const syncAt = accountSrc.indexOf("reason: 'account-change'")
  const reloadAfterSync = syncAt >= 0 && accountSrc.slice(syncAt).indexOf('this.resetLoadedStores()') > 0
  t.ok('4b account-change 同步完成后会再刷一次 store', reloadAfterSync)
}

/* ---------------- 5. 注销账号：顺序与二次确认（S8-4） ---------------- */

/**
 * 注销是本 App 里唯一**不可逆**的破坏性操作，两个地方错了都不会报错、
 * 只会静默出错，所以用源码扫描盯住：
 *
 *   1. **顺序**：必须先清云端再登出。登出后 `currentUid` 归零，`wipe()` 第一步
 *      `ensureSignedIn()` 就抛 `NOT_SIGNED_IN` —— 用户以为注销了，云端数据其实
 *      一条没删。同理本地清理必须在 `switchPartition(null)` **之前**，否则
 *      「当前分区」已经指向 guest，删的是 guest 的库。
 *   2. **二次确认**：注销按钮只能打开确认框。直接绑到执行函数上就是「一键
 *      不可逆删除」，而按钮和「退出登录」紧挨着，误触代价极大。
 */
{
  const accountSrc = readFileSync(new URL('../src/stores/account.js', import.meta.url), 'utf8')
  const mineSrc = readFileSync(new URL('../src/views/MineView.vue', import.meta.url), 'utf8')

  // 只看 deleteAccount 这个 action 的实现体
  const at = accountSrc.indexOf('async deleteAccount()')
  t.ok('5a 账号 store 有 deleteAccount 动作', at > 0)
  const body = at > 0 ? accountSrc.slice(at, at + 1200) : ''

  const cloudWipeAt = body.indexOf('cloud.deleteAccount')
  const localPurgeAt = body.indexOf('deleteLocalData')
  const signOutAt = body.indexOf('cloud.signOut')
  const switchAt = body.indexOf('switchPartition')

  t.ok('5b ★ 先清云端', cloudWipeAt > 0)
  t.ok('5c ★ 云端清理排在登出之前（登出后就删不掉了）', cloudWipeAt > 0 && cloudWipeAt < signOutAt, `${cloudWipeAt} < ${signOutAt}`)
  t.ok(
    '5d ★ 本地清理也排在登出 / 切分区之前（切完指针就指向 guest 了）',
    localPurgeAt > 0 && localPurgeAt < switchAt,
    `${localPurgeAt} < ${switchAt}`
  )
  t.ok('5e 最后才切回未登录分区', signOutAt > 0 && signOutAt < switchAt, `${signOutAt} < ${switchAt}`)
  t.ok(
    '5f 走 runIdentityChange 统一收尾（否则水位线 / store 刷新会漏）',
    /return this\.runIdentityChange\(/.test(body)
  )

  // —— 界面：注销只能由确认框触发 ——
  const dangerBtnAt = mineSrc.indexOf('class="ghost danger"')
  const dangerBtn = dangerBtnAt > 0 ? mineSrc.slice(dangerBtnAt, dangerBtnAt + 400) : ''
  t.ok('5g ★ 注销按钮只负责打开确认框', /deleteAccountOpen\s*=\s*true/.test(dangerBtn), dangerBtn.slice(0, 120))
  t.ok('5h ★ 注销按钮没有直接绑执行函数（那样就是一键不可逆删除）', dangerBtnAt > 0 && !/doDeleteAccount\s*\(/.test(dangerBtn))

  const dlgAt = mineSrc.indexOf('v-model="deleteAccountOpen"')
  const dlg = dlgAt > 0 ? mineSrc.slice(dlgAt, dlgAt + 500) : ''
  t.ok('5i ★ 二次确认：遮罩不可关闭 + 执行绑在 confirm 上', /:mask-closable="false"/.test(dlg) && /@confirm="doDeleteAccount"/.test(dlg))

  // S8-6 用户裁决：文案只讲代价本身（删什么、不可恢复），不再解释「平台侧
  // 账号记录会保留」—— 那行稀释了「永久删除」的警示分量。守卫反过来锁住这个决定。
  t.ok('5j 确认文案不再解释平台侧账号记录（S8-6 起删去）', !/账号记录/.test(mineSrc))

  // S8-6：打赏卡必须在「我的」页最底部，且下载按钮是原生 <a download>（同源，无需 Blob 中转）
  const donateAt = mineSrc.indexOf('class="card donate"')
  const donate = donateAt > 0 ? mineSrc.slice(donateAt, donateAt + 600) : ''
  t.ok(
    '5k 打赏卡含扫码标题与下载二维码按钮',
    /微信扫码打赏鼓励作者/.test(donate) && /download="微信扫码打赏二维码\.jpg"/.test(donate)
  )
}

/* ---------------- 6. schema 清理的回归守卫（S8-5） ---------------- */

/**
 * S8-5 删掉了三个字段（账单 `noReimburse` / `version`、账本 `ownerId`）、
 * 一个死索引（BILL 的 `month`）和一个废弃文件（`leancloudAdapter.js`）。
 *
 * 删除类改动最容易「悄悄长回来」：某个写路径还在赋值，字段就复活了，而且
 * **不会有任何测试失败**（多一个字段不影响渲染）。所以这里用源码扫描把
 * 每一个写入点都钉住 —— 特别是 `RecordView` 那个漏网的提交 payload，
 * 它会把编辑老账时的字段重新种回去。
 */
{
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  // 6a 废弃的 LeanCloud 适配器已删（它没有任何生产引用，全是 NotImplementedError）
  let gone = false
  try {
    read('../src/api/adapters/leancloudAdapter.js')
  } catch (e) {
    gone = true
  }
  t.ok('6a ★ 废弃的 leancloudAdapter 已删除', gone)

  // 6b 备份字段白名单（导出与导入都靠它裁剪）
  const bkSrc = read('../src/api/core/backup.js')
  const fieldsAt = bkSrc.indexOf('const FIELDS = {')
  const fieldsBlock = bkSrc.slice(fieldsAt, bkSrc.indexOf('账单类型的历史取值'))
  t.ok(
    '6b ★ 备份白名单不含 noReimburse / version / ownerId',
    fieldsAt > 0 && !/noReimburse|ownerId|'version'/.test(fieldsBlock)
  )

  // 6c / 6d 两个适配器与种子都不再产出这些字段
  t.ok('6c ★ 种子不再产出 noReimburse / ownerId', !/noReimburse|ownerId/.test(read('../src/api/mock/seed.js')))
  t.ok(
    '6d mock 适配器与 idbAdapter 形状一致（否则契约测试会漂）',
    !/noReimburse|ownerId/.test(read('../src/api/adapters/mockAdapter.js'))
  )

  // 6e 记账页的提交 payload —— S8-5 实际漏网过一次，编辑老账时把它种了回来
  t.ok('6e ★ 记账页提交不再写入 noReimburse', !/noReimburse/.test(read('../src/views/RecordView.vue')))

  // 6f ~ 6h 本地清理迁移
  const idbSrc = read('../src/api/adapters/idbAdapter.js')
  const coreDbSrc = read('../src/api/core/idb.js')
  const purgeAt = idbSrc.indexOf('async function purgeDeprecatedFields')
  const purgeBody = purgeAt > 0 ? idbSrc.slice(purgeAt, idbSrc.indexOf('async function init', purgeAt)) : ''

  t.ok('6f ★ 本地字段清理迁移存在', purgeAt > 0)
  t.ok(
    '6g ★ 清理走独立 meta 标记（bump SCHEMA_VERSION 会重新播种、清空用户数据）',
    /DEPRECATED_FIELDS_PURGED/.test(coreDbSrc) && /DEPRECATED_FIELDS_PURGED/.test(purgeBody + idbSrc.slice(idbSrc.indexOf('async function init')))
  )
  t.ok(
    '6h ★★ 清理不动 updatedAt、不入队（否则这条账会被当成「本地更新」推上云）',
    purgeAt > 0 && !/\bupdatedAt\s*:/.test(purgeBody) && !/enqueue/.test(purgeBody)
  )

  // 6i ~ 6k 库版本与死索引
  t.ok('6i ★ DB_VERSION 已升到 3', /export const DB_VERSION = 3/.test(coreDbSrc))
  t.ok('6j ★ 新库不再创建 month 死索引', !/createIndex\('month'/.test(coreDbSrc))
  t.ok(
    '6k ★ 升级路径显式删掉老库的 month 索引（createObjectStore 分支只在建新库时跑）',
    /dropIndexIfExists\(tx\.objectStore\(STORES\.BILL\), 'month'\)/.test(coreDbSrc)
  )
}

/* ---------------- 7. 废弃种子分类的回归守卫（S8-7） ---------------- */

/**
 * S8-7 删掉了种子里的「卤鹅」（`cat_goose`）。
 *
 * 与 S8-5 的字段清理同构，但多一个反方向的坑：**用户的分类可以叫任何名字**，
 * 所以清理只能认**固定 id**。一旦有人图省事改成「按名字删」，用户自己建的
 * 「卤鹅」会被悄悄删掉 —— 那是一次静默的数据损失，且不会让任何别的测试失败。
 */
{
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const seedSrc = read('../src/api/mock/seed.js')
  const idbSrc = read('../src/api/adapters/idbAdapter.js')

  t.ok('7a ★ 分类树里没有 goose', !/key: 'goose'/.test(seedSrc))
  t.ok(
    '7b ★ 废弃名单用的是固定 id（CAT_ID(\'goose\')），不是名字',
    /REMOVED_SEED_CATEGORY_IDS\s*=\s*\[\s*CAT_ID\('goose'\)\s*\]/.test(seedSrc)
  )

  const purgeFnAt = idbSrc.indexOf('async function purgeRemovedCategories')
  const purgeBody = purgeFnAt > 0 ? idbSrc.slice(purgeFnAt, idbSrc.indexOf('async function init', purgeFnAt)) : ''
  t.ok('7c ★ 适配器里有这个清理函数', purgeFnAt > 0)
  t.ok(
    '7d ★★ 只按 id / parentId 匹配 —— 不按 name（按名字会把用户自建的「卤鹅」也删了）',
    purgeFnAt > 0 && /removed\.has\(c\.id\)/.test(purgeBody) && !/c\.name\s*===|\.name\s*\)\s*\.has/.test(purgeBody)
  )
  t.ok(
    '7e ★★ 清理不动 updatedAt、不入队（同 S8-5：这是产品决定，不是用户改内容）',
    purgeFnAt > 0 && !/\bupdatedAt\s*:/.test(purgeBody) && !/enqueue/.test(purgeBody)
  )

  // 调用点必须在 init 里（否则老库永远等不到清理），且排在播种 / 接管之后
  const initBody = idbSrc.slice(idbSrc.indexOf('async function init'), idbSrc.indexOf('function ready()'))
  const callAt = initBody.indexOf('await purgeRemovedCategories()')
  const seedWriteAt = initBody.indexOf('buildSeed(')
  t.ok('7f ★ init 里调用了清理', callAt > 0)
  t.ok(
    '7g ★ 清理排在播种之后（种子已不含它，顺序错了会把刚播的库再过一遍）',
    callAt > seedWriteAt,
    `call=${callAt} seed=${seedWriteAt}`
  )
  t.ok(
    '7h ★★ 每次都跑、不落一次性标记（要能自愈「云端残留被全量回拉」）',
    callAt > 0 && !/REMOVED_SEED_CATEGORIES_PURGED/.test(idbSrc)
  )
}

/* ==========================================================================
 * 第 8 节（S8-8~S8-12）：填充风图标（十四个模块）+ 尺寸可配参数
 * ========================================================================== */
{
  const foodSrc = readFileSync(new URL('../src/components/icons/foodFill.js', import.meta.url), 'utf8')
  const iconSrc = readFileSync(new URL('../src/components/icons/index.js', import.meta.url), 'utf8')
  const catIconSrc = readFileSync(new URL('../src/components/CategoryIcon.vue', import.meta.url), 'utf8')
  const seedSrc2 = readFileSync(new URL('../src/api/mock/seed.js', import.meta.url), 'utf8')
  const idbSrc2 = readFileSync(new URL('../src/api/adapters/idbAdapter.js', import.meta.url), 'utf8')

  const FOOD_KEYS = [
    'apple', 'carrot', 'cocktail', 'burger', 'cutlery', 'bowl', 'cake', 'candy',
    'beer', 'bubbleTea', 'coffeeCup', 'friedEgg', 'honeyJar', 'iceCream', 'popsicle', 'springRoll'
  ]
  const entriesOk = FOOD_KEYS.every((k) => new RegExp(`\\b${k}:\\s*'`).test(foodSrc))

  t.ok('8a ★ 16 张用户手绘图标全部内联进 foodFill.js（8 个覆盖旧 key + 8 个新 key）', entriesOk)
  t.ok(
    '8b ★★ 填充风图标零硬编码颜色 —— 全靠 fill=currentColor 走主题联动（绿底白字的选中态靠它）',
    !/#[0-9a-fA-F]{3,8}\b/.test(foodSrc.slice(foodSrc.indexOf('FOOD_FILL_ICONS')))
  )
  t.ok(
    '8c ★★ 每张都有 stroke="none" 外壳 —— 压掉 IconBase 画布级描边，否则轮廓加粗一圈',
    FOOD_KEYS.every((k) => {
      const at = foodSrc.indexOf(`${k}: '`)
      const seg = foodSrc.slice(at, at + 120)
      return seg.includes(`'<g stroke="none"`)
    })
  )
  t.ok(
    '8d ★ ICONS 以「后展开覆盖」吃进全部填充风图标组（放前面会被同 key 旧定义盖回去），且最后以 OTHER_FILL_ICONS 收尾',
    ['FOOD', 'SHOP', 'SPORT', 'TRANSPORT', 'FUN', 'HOUSE', 'STUDY', 'FAMILY', 'GIFT', 'PETS', 'MEDICAL', 'FINANCE', 'BUSINESS', 'OTHER']
      .every((n) => iconSrc.includes(`...${n}_FILL_ICONS`)) &&
      /\.\.\.OTHER_FILL_ICONS\s*\n?\}/.test(iconSrc)
  )

  const eatGroup = iconSrc.slice(iconSrc.indexOf("key: 'eat'"), iconSrc.indexOf("key: 'shop'"))
  t.ok('8e ★ 8 个新 key 全部进了吃喝选择器组', ['beer', 'bubbleTea', 'coffeeCup', 'friedEgg', 'honeyJar', 'iceCream', 'popsicle', 'springRoll'].every((k) => eatGroup.includes(`'${k}'`)))

  t.ok(
    '8f ★★ 尺寸可配参数存在且有注释档位（用户自己调大小就改这一个数）',
    /export const CATEGORY_ICON_RATIO = 0\.\d+/.test(iconSrc) && iconSrc.includes('0.50')
  )
  t.ok(
    '8g ★★ CategoryIcon 的 iconRatio 默认值取自 CATEGORY_ICON_RATIO（不是写死的 0.5）',
    catIconSrc.includes('import { CATEGORY_ICON_RATIO }') && /default: CATEGORY_ICON_RATIO/.test(catIconSrc)
  )
  t.ok(
    '8h ★ 种子「奶茶」已换 bubbleTea（新库直接是新图标）',
    seedSrc2.includes("{ key: 'snack-milktea', name: '奶茶', icon: 'bubbleTea' }")
  )
  const refreshCallAt = idbSrc2.indexOf('await refreshSeedCategoryIcons()')
  t.ok(
    '8i ★ 旧库的图标刷新也挂在 init 里、排在播种之后（同 7g 的顺序理由）',
    refreshCallAt > 0 && refreshCallAt > idbSrc2.indexOf('buildSeed(')
  )
  const refreshBody = idbSrc2.slice(idbSrc2.indexOf('async function refreshSeedCategoryIcons'), refreshCallAt > 0 ? refreshCallAt : undefined)
  t.ok(
    '8j ★★ 图标刷新有「=== from 才动」守卫（用户自己改过图标就不覆盖）',
    refreshBody.includes('doc.icon === item.from')
  )
  t.ok(
    '8k ★★ 图标刷新不动 updatedAt、不入队（视觉刷新不是数据变更）',
    refreshBody.length > 0 && !/updatedAt/.test(refreshBody) && !/enqueue/.test(refreshBody)
  )

  /* S8-8~S8-12：填充风图标统一守卫（每个模块 3 条：全内联 / 零硬编码色 + stroke=none 外壳 / 新 key 进组） */
  const FILL_MODULES = [
    {
      label: '吃喝（S8-8）', file: 'foodFill.js', exportName: 'FOOD_FILL_ICONS',
      newKeys: ['beer', 'bubbleTea', 'coffeeCup', 'friedEgg', 'honeyJar', 'iceCream', 'popsicle', 'springRoll'],
      groupAnchor: ["key: 'eat'", "key: 'shop'"]
    },
    {
      label: '购物（S8-9）', file: 'shopFill.js', exportName: 'SHOP_FILL_ICONS',
      newKeys: ['pants', 'cosmetics', 'mirror', 'smartphone', 'toiletPaper', 'iceSkate'],
      groupAnchor: ["key: 'shop'", "key: 'traffic'"]
    },
    {
      label: '运动（S8-10）', file: 'sportFill.js', exportName: 'SPORT_FILL_ICONS',
      newKeys: ['runningShoe', 'badminton', 'billiards', 'climbing', 'fishing', 'racket'],
      groupAnchor: ["key: 'sport'", "key: 'gift'"]
    },
    {
      label: '交通（S8-10）', file: 'transportFill.js', exportName: 'TRANSPORT_FILL_ICONS',
      newKeys: ['metro', 'tram', 'charging'],
      groupAnchor: ["key: 'traffic'", "key: 'house'"]
    },
    {
      label: '娱乐（S8-10）', file: 'funFill.js', exportName: 'FUN_FILL_ICONS',
      newKeys: ['mahjong', 'playingCards', 'videoPlay', 'palmTree', 'hat', 'moneyBag'],
      groupAnchor: ["key: 'fun'", "key: 'sport'"]
    },
    {
      label: '住房（S8-10）', file: 'houseFill.js', exportName: 'HOUSE_FILL_ICONS',
      newKeys: ['rent', 'electricity', 'gas', 'telephone'],
      groupAnchor: ["key: 'house'", "key: 'fun'"]
    },
    {
      label: '学习（S8-11）', file: 'studyFill.js', exportName: 'STUDY_FILL_ICONS',
      newKeys: ['backpack', 'training', 'teach', 'palette'],
      groupAnchor: ["key: 'study'", "key: 'medical'"]
    },
    {
      label: '家庭（S8-11）', file: 'familyFill.js', exportName: 'FAMILY_FILL_ICONS',
      newKeys: ['pendantLamp', 'tv', 'aircon', 'roller', 'hammer', 'fridge'],
      groupAnchor: ["key: 'family'", "key: 'study'"]
    },
    {
      label: '人情（S8-11）', file: 'giftFill.js', exportName: 'GIFT_FILL_ICONS',
      newKeys: ['reward', 'heart', 'doubleHeart', 'coinBag'],
      groupAnchor: ["key: 'gift'", "key: 'family'"]
    },
    {
      label: '宠物（S8-12）', file: 'petsFill.js', exportName: 'PETS_FILL_ICONS',
      newKeys: ['dog', 'cat', 'bone', 'yarnBall', 'petDryer', 'petFoodBag', 'petCan'],
      groupAnchor: ["key: 'pets'", "key: 'study'"]
    },
    {
      label: '医疗（S8-12）', file: 'medicalFill.js', exportName: 'MEDICAL_FILL_ICONS',
      newKeys: ['tooth'],
      groupAnchor: ["key: 'medical'", "key: 'finance'"]
    },
    {
      label: '理财（S8-12）', file: 'financeFill.js', exportName: 'FINANCE_FILL_ICONS',
      newKeys: ['coins', 'creditCard', 'investment', 'monitorChart', 'shieldCheck', 'sparkle'],
      groupAnchor: ["key: 'finance'", "key: 'business'"]
    },
    {
      label: '生意（S8-12）', file: 'businessFill.js', exportName: 'BUSINESS_FILL_ICONS',
      newKeys: ['store', 'revenue', 'bizCart', 'openSign', 'adDisplay', 'customer'],
      groupAnchor: ["key: 'business'", "key: 'other'"]
    },
    {
      label: '其它（S8-12）', file: 'otherFill.js', exportName: 'OTHER_FILL_ICONS',
      newKeys: [],
      groupAnchor: ["key: 'other'", "key: '__last__'"]
    }
  ]
  for (const mod of FILL_MODULES) {
    const src = readFileSync(new URL('../src/components/icons/' + mod.file, import.meta.url), 'utf8')
    const keys = [...src.matchAll(/\n  (\w+): '/g)].map((m) => m[1])
    t.ok(
      `8-${mod.label} 全部内联进 ${mod.file}（${keys.length} 张，覆盖旧 key + 新 key）`,
      keys.length > 0 && keys.every((k) => new RegExp(`\\b${k}:\\s*'`).test(src))
    )
    t.ok(
      `8-${mod.label} ★★ 零硬编码颜色 + 每张都有 stroke="none" 外壳（主题联动靠它）`,
      !/#[0-9a-fA-F]{3,8}\b/.test(src) &&
        keys.every((k) => src.slice(src.indexOf(`${k}: '`), src.indexOf(`${k}: '`) + 120).includes(`'<g stroke="none"`))
    )
    const endAt = iconSrc.indexOf(mod.groupAnchor[1])
    const group = iconSrc.slice(iconSrc.indexOf(mod.groupAnchor[0]), endAt === -1 ? undefined : endAt)
    t.ok(
      `8-${mod.label} ${mod.newKeys.length} 个新 key 全部进了选择器组`,
      mod.newKeys.every((k) => group.includes(`'${k}'`))
    )
  }
}

/* ==========================================================================
 * 第 9 节（S8-13）：日历占位格类名守卫
 *
 * 事故复盘：账单页日历的占位格曾经用类名 `empty`，与同一份 scoped 样式里
 * 「空态提示文字」的 `.empty { margin: 30px 0 }` 撞名 —— 占位格被套上 30px 上下外边距，
 * 44px 的行被撑到 104px，于是「含占位格的那一行」（月初/月末）行距明显变大。
 * 这类 bug 编译、单测、构建都发现不了，只能靠约定 + 源码扫描钉住。
 * ========================================================================== */
{
  const billsSrc = readFileSync(new URL('../src/views/BillsView.vue', import.meta.url), 'utf8')
  t.ok(
    '9a ★★ 日历占位格用 `is-blank`，不再复用空态文字类名 `empty`（曾把行高从 44 撑到 104）',
    billsSrc.includes("'is-blank': !day") && billsSrc.includes('.cell.is-blank') && !/empty:\s*!day/.test(billsSrc)
  )
  t.ok(
    '9b ★ `.empty` 只用于空态文字（margin: 30px 0 的前后必须有注释说明它不能用在格子上）',
    /\.empty\s*\{[\s\S]{0,200}?margin:\s*30px 0/.test(billsSrc) &&
      billsSrc.includes('新增格子类名别再复用 `empty`')
  )
  const gridRule = billsSrc.slice(billsSrc.indexOf('.grid {'), billsSrc.indexOf('.cell')) 
  t.ok(
    '9c ★ 日历网格列数与占位格规则都在位（7 列 + visibility 隐藏而非 display:none）',
    /grid-template-columns:\s*repeat\(7,\s*1fr\)/.test(gridRule) &&
      /visibility:\s*hidden/.test(billsSrc.slice(billsSrc.indexOf('.cell.is-blank')))
  )
}

/* ==========================================================================
 * 第 10 节（S9）：push 刻度回传的契约守卫
 *
 * 事故复盘：`cloudbaseAdapter.push()` 调完 `fetchServerStamps()` 就把它的返回值
 * 丢了，返回体里没有 `stamps`，而 `syncEngine.pushPending` 读的正是 `result.stamps`
 * —— S4-6「刻度写回本地副本」这条链在真实云端上**从没接通过**。
 *
 * 为什么单靠测试发现不了：
 *   ① 它是**静默**的（`applyStamps` 找不到文档就跳过，不抛错，功能退化成
 *      「晚一轮才拿到刻度」，不影响正确性）；
 *   ② `fakeCloud` 是按 `_openid` 分桶的，`_id` 就等于本地 id，所以它的 stamps
 *      key 天然是本地 id —— 用参考实现跑测试永远绿。**契约的缺口恰好落在
 *      「后端可替换」这条原则的缝里**：两个实现返回的 id 空间不一致。
 *   ③ 真适配器依赖 CloudBase SDK，跑不了单测，只能源码扫描钉住。
 *
 * 这类「文档写了、调用方读了、实现没给」的漂移，编译、构建、单测全都不报。
 * ========================================================================== */
{
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const adapterSrc = read('../src/api/adapters/cloudbaseAdapter.js')
  const cloudClientSrc = read('../src/api/sync/cloudClient.js')
  const fakeCloudSrc = read('../src/api/sync/fakeCloud.js')
  const idbSrc = read('../src/api/adapters/idbAdapter.js')

  // 10a 返回体里有 stamps —— 空列表分支也要有（形状稳定，调用方不必写分支）
  t.ok(
    '10a ★★ `cloudbaseAdapter.push` 回传 stamps（含空推送分支），不再丢掉云函数盖的刻度',
    /return\s*\{\s*upserted:\s*\[\],\s*rejected:\s*\[\],\s*stamps:\s*\{\}\s*\}/.test(adapterSrc) &&
      /return\s*\{\s*upserted,\s*rejected,\s*stamps\s*\}/.test(adapterSrc)
  )

  // 10b 关键：云函数按**别名**回报，必须换算回本地 id 才能被消费方查到
  t.ok(
    '10b ★★ stamps 的 key 换算回**本地 id**（直接给别名 ⇒ applyStamps 每条静默 miss）',
    /const stamped = await fetchServerStamps\(/.test(adapterSrc) &&
      /localIdOf\.get\(alias\)/.test(adapterSrc)
  )

  // 10c 两侧 id 空间必须一致：消费方按本地 id 查文档
  t.ok(
    '10c ★ 消费方 `applyStamps` 按本地 id 查文档（与 upserted 同一套 id 空间）',
    /applyStamps\(collection, stamps\)/.test(read('../src/api/sync/syncEngine.js')) &&
      /byId\.get\(id\)/.test(idbSrc) &&
      /serverUpdatedAt: stamp/.test(idbSrc)
  )

  // 10d 契约声明必须写明它 —— 否则下一个人还会照「只有 upserted/rejected」去写实现
  t.ok(
    '10d ★ 契约（cloudClient.js）声明 push 返回 stamps，且注明 key 是本地 id、可缺省',
    /stamps\s*\}/.test(cloudClientSrc) &&
      /`stamps`/.test(cloudClientSrc) &&
      /必须是「本地 id」/.test(cloudClientSrc) &&
      /允许缺省或为空对象/.test(cloudClientSrc)
  )

  // 10e 参考实现（fakeCloud）保持同语义，否则「后端可替换」这条原则是空话
  t.ok(
    '10e ★ fakeCloud 同样返回 stamps（参考实现与真实现同一套契约）',
    /stamps\[id\] = stamped/.test(fakeCloudSrc) && /return\s*\{\s*upserted,\s*rejected,\s*stamps\s*\}/.test(fakeCloudSrc)
  )
}

t.done()
