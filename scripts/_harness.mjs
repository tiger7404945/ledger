/**
 * test:data 的统一测试外壳
 * ------------------------------------------------------------
 * 十个脚本以前各写一份 `ok` / `eq` / `pass++`，格式慢慢就漂了：
 * 失败详情有的用「  」有的用「  — 」有的换行缩进，`migrate-test` 干脆
 * 只打 PASS/FAIL、既不汇总也不设退出码（测试挂了 `npm run test:data` 照样成功）。
 *
 * 这里把「逐条输出 + 汇总 + 退出码」收敛成一处，脚本只要：
 *
 *   import { createSuite } from './_harness.mjs'
 *   const t = createSuite('sync-test')
 *   t.ok('1a 描述', cond, '实得 xxx')
 *   t.eq('1b 描述', got, want)
 *   t.group('阶段 2：xxx')
 *   t.done()            // 必须放最后：打汇总行，有失败时置 exitCode=1
 *
 * 输出格式（全脚本一致）：
 *   ✓ 1a 描述
 *   ✗ 1b 描述
 *       期望 3
 *       实得 4
 *
 *   ──── sync-test ────
 *   128 通过 / 0 失败（共 128 条）
 */
export function createSuite(name) {
  let pass = 0
  let fail = 0

  /** 统一出口：不混用 console.log / process.stdout.write，避免顺序错乱 */
  const out = (line) => process.stdout.write(`${line}\n`)

  return {
    /**
     * 布尔断言。
     * @param {string} label 断言描述（带编号便于定位）
     * @param {unknown} cond 真值即通过
     * @param {string} [extra] 失败时附在后面的实测信息
     */
    ok(label, cond, extra = '') {
      const good = Boolean(cond)
      if (good) {
        pass += 1
        out(`✓ ${label}`)
      } else {
        fail += 1
        out(`✗ ${label}${extra ? `  — ${extra}` : ''}`)
      }
      return good
    },

    /**
     * 深比较断言（JSON 序列化后比对，够用且不引依赖）。
     * @param {string} label
     * @param {unknown} got 实得
     * @param {unknown} want 期望
     */
    eq(label, got, want) {
      const good = JSON.stringify(got) === JSON.stringify(want)
      if (good) {
        pass += 1
        out(`✓ ${label}`)
      } else {
        fail += 1
        out(`✗ ${label}\n    期望 ${JSON.stringify(want)}\n    实得 ${JSON.stringify(got)}`)
      }
      return good
    },

    /** `ok` 的别名 —— migrate-test 历史叫法，保留以免改写全部调用点 */
    assert(label, cond, extra = '') {
      return this.ok(label, cond, extra)
    },

    /** 分组小标题（阶段 / 场景分隔） */
    group(title) {
      out(`\n== ${title} ==`)
    },

    /** 汇总 + 退出码。**必须在脚本最后调用一次** */
    done() {
      const total = pass + fail
      out('')
      out(`──── ${name} ────`)
      out(`  ${pass} 通过 / ${fail} 失败（共 ${total} 条）`)
      out('')
      // 用 exitCode 而不是 process.exit()：后者会截断尚未 flush 的 stdout
      if (fail) process.exitCode = 1
      return { pass, fail, total }
    },

    get pass() {
      return pass
    },
    get fail() {
      return fail
    }
  }
}
