/**
 * 生成 .preview/icon-preview.html：全部填充风图标（吃喝 + 购物 + 后续批次）的尺寸滑杆预览页。
 * 用法：node scripts/build-icon-preview.mjs
 * 加新批次后重跑一次即可刷新预览页。
 */
import { writeFileSync } from 'node:fs'
import { FOOD_FILL_ICONS } from '../src/components/icons/foodFill.js'
import { SHOP_FILL_ICONS } from '../src/components/icons/shopFill.js'

const RATIO = 0.65 // 与 index.js 的 CATEGORY_ICON_RATIO 保持一致

const GROUPS = [
  ['吃喝组 · 16 枚', FOOD_FILL_ICONS],
  ['购物组 · 16 枚', SHOP_FILL_ICONS]
]

const cell = (key, inner) =>
  `<div class='cell'><span class='disc' data-key='${key}'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>${inner}</svg></span><label>${key}</label></div>`

const grids = GROUPS.map(
  ([label, icons]) =>
    `<h2>${label}</h2><div class='grid'>${Object.entries(icons).map(([k, v]) => cell(k, v)).join('')}</div>`
).join('\n')

const demo = ['bag', 'cart', 'diamond']
  .map(
    (k, i) =>
      `<div style='text-align:center'><span class='disc ${['', 'mint', 'active'][i]}'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor'>${(FOOD_FILL_ICONS[k] || SHOP_FILL_ICONS[k])}</svg></span><div class='tag'>${k}</div></div>`
  )
  .join('')

const html = `<!DOCTYPE html>
<html lang='zh'><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<title>填充风图标预览 · 尺寸滑杆</title>
<style>
  body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#f6f8f8;color:#1c2b2b;margin:0;padding:24px}
  h1{font-size:17px;margin:0 0 4px} h2{font-size:14px;margin:20px 0 0}
  .sub{font-size:12px;color:#6b7c7c;margin-bottom:18px}
  .panel{background:#fff;border-radius:14px;padding:16px 18px;box-shadow:0 1px 4px rgba(0,0,0,.06);max-width:640px;margin-bottom:16px}
  .row{display:flex;align-items:center;gap:12px}
  input[type=range]{flex:1;accent-color:#3fd9b6}
  .val{font-variant-numeric:tabular-nums;font-weight:700;font-size:15px;min-width:44px;text-align:right}
  .disc{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;background:#eef2f2;color:#1c2b2b;overflow:hidden}
  .disc svg{display:block}
  .grid{display:flex;flex-wrap:wrap;gap:14px 18px;margin-top:14px}
  .cell{display:flex;flex-direction:column;align-items:center;gap:6px}
  .cell label{font-size:11px;color:#6b7c7c}
  .demo{display:flex;gap:22px;margin-top:6px;align-items:center;flex-wrap:wrap}
  .tag{font-size:11px;color:#6b7c7c;text-align:center;margin-top:6px}
  .mint{background:#dcfdf6}
  .active{background:#3fd9b6;color:#fff;box-shadow:0 4px 10px rgba(63,217,182,.35)}
</style></head><body>
<h1>填充风图标总览（S8-8 吃喝 + S8-9 购物）</h1>
<div class='sub'>拖滑杆调「图标 / 圆底」尺寸比 —— App 内对应 src/components/icons/index.js 的 CATEGORY_ICON_RATIO（当前 ${RATIO}）</div>
<div class='panel'>
  <div class='row'><span style='font-size:12px;color:#6b7c7c'>小</span><input id='r' type='range' min='0.40' max='0.72' step='0.01' value='${RATIO}'><span style='font-size:12px;color:#6b7c7c'>大</span><span class='val' id='v'>${RATIO.toFixed(2)}</span></div>
  ${grids}
</div>
<div class='panel'>
  <div class='sub' style='margin-bottom:8px'>三种底色下的效果（44px 圆底 · 当前比值）</div>
  <div class='demo'>${demo}</div>
</div>
<script>
const apply = (ratio) => {
  document.getElementById('v').textContent = Number(ratio).toFixed(2)
  document.querySelectorAll('.disc').forEach(d => {
    const s = d.querySelector('svg'); const px = Math.round(44 * ratio)
    s.style.width = px + 'px'; s.style.height = px + 'px'
  })
}
document.getElementById('r').addEventListener('input', e => apply(e.target.value))
apply(${RATIO})
</script>
</body></html>
`

writeFileSync('.preview/icon-preview.html', html)
console.log('preview -> .preview/icon-preview.html')
