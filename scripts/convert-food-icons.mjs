/**
 * 一次性转换脚本（S8-8）：把用户提供的填充风 SVG 内联成 IconBase 可用的图标字符串。
 * 用法：node scripts/convert-food-icons.mjs
 * 产物：src/components/icons/foodFill.js（生成物，别手改路径数据）
 */
import { readFileSync, writeFileSync } from 'node:fs'

const MAP = [
  ['apple.svg', 'apple'],
  ['carrot.svg', 'carrot'],
  ['cocktail.svg', 'cocktail'],
  ['hamburger.svg', 'burger'],
  ['spoon-fork.svg', 'cutlery'],
  ['soup-bowl.svg', 'bowl'],
  ['cupcake.svg', 'cake'],
  ['candy.svg', 'candy'],
  ['beer-mug.svg', 'beer'],
  ['bubble-tea.svg', 'bubbleTea'],
  ['coffee-cup.svg', 'coffeeCup'],
  ['fried-egg.svg', 'friedEgg'],
  ['honey-jar.svg', 'honeyJar'],
  ['ice-cream-cup.svg', 'iceCream'],
  ['popsicle.svg', 'popsicle'],
  ['spring-roll.svg', 'springRoll']
]

const DIR = 'C:/Users/DELL/Downloads/svg-输出/svg'
const SRC_SCALE = 24 / 512

// d 属性里的数字统一降到 2 位小数（原稿 512 坐标系，误差 < 0.01px@24px，纯瘦身）
function roundNums(s) {
  return s.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (m) => {
    const n = Number(m)
    if (!Number.isFinite(n)) return m
    return String(Math.round(n * 100) / 100)
  })
}

const entries = []
let total = 0
for (const [file, key] of MAP) {
  const svg = readFileSync(DIR + '/' + file, 'utf8')
  const m = svg.match(/<g\b[\s\S]*<\/g>/)
  if (!m) throw new Error('no <g> in ' + file)
  // 原稿是带换行缩进的多行 SVG：折叠成单行，才能安全放进单引号字符串字面量
  const inner = roundNums(m[0]).replace(/\s+/g, ' ').trim()
  const wrapped = '<g stroke="none" transform="scale(' + SRC_SCALE + ')">' + inner + '</g>'
  entries.push('  ' + key + ": '" + wrapped + "'")
  total += wrapped.length
  console.log(key.padEnd(12), (wrapped.length / 1024).toFixed(1) + 'KB')
}

const js = [
  '/**',
  ' * 吃喝组·填充风图标（S8-8，由 scripts/convert-food-icons.mjs 从用户手绘 SVG 生成 —— 别手改路径数据）',
  ' *',
  ' * 来源：用户提供的 16 张 512×512 填充风 SVG。转换做了两件事：',
  ' *  1. 外层 <g stroke="none">：压掉 IconBase 画布级的 stroke="currentColor" + stroke-width，',
  ' *     填充风图标不吃描边（否则轮廓会加粗一圈）；',
  ' *  2. transform="scale(24/512)"：原稿坐标系是 512×512，整体映射进 IconBase 的 24×24 viewBox。',
  ' * 颜色仍走 fill="currentColor"，主题联动（灰 / mint / 绿底白）与旧线性图标完全一致。',
  ' *',
  ' * 同 key 覆盖（apple / carrot / cocktail / burger / cutlery / bowl / cake / candy）在',
  ' * index.js 里以「后展开覆盖先定义」生效；其余 8 个是新 key，已加进 ICON_GROUPS 吃喝组。',
  ' */',
  'export const FOOD_FILL_ICONS = {',
  entries.join(',\n'),
  '}',
  ''
].join('\n')

writeFileSync('src/components/icons/foodFill.js', js)
console.log('---')
console.log('total:', (total / 1024).toFixed(1) + 'KB  (raw files: ~170KB)')
