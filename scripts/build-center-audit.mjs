/**
 * 生成「填充风图标居中度审计」页（浏览器里量墨迹包围盒）
 *
 * 背景：shell 抽取器直接沿用源 SVG 的 512 坐标系，**不做居中**。
 * 若源图主体不在画布中心，图标在圆形底里就会偏（S8-10 娱乐组的 film 实测偏 (79, -82)px）。
 *
 * 用法：node scripts/build-center-audit.mjs  → 打开 .preview/center-audit.html（无头或肉眼均可）
 * 页面把结果写到 window.__centerAudit（JSON 字符串），并按偏移量从大到小排序。
 */
import { writeFileSync } from 'node:fs'
import {
  FOOD_FILL_ICONS, SHOP_FILL_ICONS, SPORT_FILL_ICONS, TRANSPORT_FILL_ICONS,
  FUN_FILL_ICONS, HOUSE_FILL_ICONS, STUDY_FILL_ICONS, FAMILY_FILL_ICONS, GIFT_FILL_ICONS,
  PETS_FILL_ICONS, MEDICAL_FILL_ICONS, FINANCE_FILL_ICONS, BUSINESS_FILL_ICONS, OTHER_FILL_ICONS
} from '../src/components/icons/index.js'

const GROUPS = [
  ['吃喝', FOOD_FILL_ICONS],
  ['购物', SHOP_FILL_ICONS],
  ['运动', SPORT_FILL_ICONS],
  ['交通', TRANSPORT_FILL_ICONS],
  ['娱乐', FUN_FILL_ICONS],
  ['住房', HOUSE_FILL_ICONS],
  ['学习', STUDY_FILL_ICONS],
  ['家庭', FAMILY_FILL_ICONS],
  ['人情', GIFT_FILL_ICONS],
  ['宠物', PETS_FILL_ICONS],
  ['医疗', MEDICAL_FILL_ICONS],
  ['理财', FINANCE_FILL_ICONS],
  ['生意', BUSINESS_FILL_ICONS],
  ['其它', OTHER_FILL_ICONS]
]

// 每个图标在内联串里是 `<g stroke="none" transform="scale(24/512)">…</g>`
// 还原成独立的 512 viewBox SVG 来量
const toSvg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${
    inner.replace(/transform="scale\([^)]*\)"/g, '')
  }</svg>`

const items = []
for (const [label, mod] of GROUPS) {
  for (const [key, inner] of Object.entries(mod)) {
    items.push({ label, key, svg: toSvg(inner) })
  }
}

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{background:#fff;color:#111;font:13px/1.5 ui-monospace,monospace;margin:16px}
h1{font-size:16px}
.grid{display:flex;flex-wrap:wrap;gap:10px}
.c{width:132px;text-align:center}
.c canvas{width:120px;height:120px;border:1px solid #ddd;border-radius:8px}
.c .n{font-size:11px;color:#555;word-break:break-all}
.c .s{font-size:11px}
.bad .n{color:#c00;font-weight:700}
.bad canvas{border-color:#c00}
</style></head><body>
<h1>填充风图标居中度审计（512 画布，理想中心 256,256）</h1>
<p id="sum">测量中…</p>
<div class="grid" id="grid"></div>
<script>
const ITEMS = ${JSON.stringify(items)}
const grid = document.getElementById('grid')
let pending = ITEMS.length
const out = []
function done () {
  out.sort((a, b) => b.offset - a.offset)
  window.__centerAudit = JSON.stringify(out)
  const bad = out.filter((o) => o.offset > 20)
  document.getElementById('sum').textContent =
    ITEMS.length + ' 枚，偏移 >20px（512 空间）的有 ' + bad.length + ' 枚：' +
    bad.map((o) => o.label + '/' + o.key + ' (' + o.dx + ',' + o.dy + ')').join('  ')
}
for (const it of ITEMS) {
  const box = document.createElement('div')
  box.className = 'c'
  box.innerHTML = '<canvas width="512" height="512"></canvas><div class="n"></div><div class="s"></div>'
  grid.appendChild(box)
  const cv = box.querySelector('canvas')
  const ctx = cv.getContext('2d')
  const img = new Image()
  img.onload = () => {
    ctx.clearRect(0, 0, 512, 512)
    ctx.drawImage(img, 0, 0, 512, 512)
    const px = ctx.getImageData(0, 0, 512, 512).data
    let x0 = 9999, y0 = 9999, x1 = -1, y1 = -1, ink = 0
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        if (px[(y * 512 + x) * 4 + 3] > 32) {
          ink++
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    const dx = Math.round(cx - 256), dy = Math.round(cy - 256)
    const offset = Math.round(Math.hypot(dx, dy) * 10) / 10
    const rec = { label: it.label, key: it.key, dx, dy, offset, w: x1 - x0 + 1, h: y1 - y0 + 1 }
    out.push(rec)
    box.querySelector('.n').textContent = it.label + '/' + it.key
    box.querySelector('.s').textContent = 'Δ(' + dx + ',' + dy + ') w' + rec.w + ' h' + rec.h
    if (offset > 20) box.classList.add('bad')
    if (--pending === 0) done()
  }
  img.onerror = () => {
    box.querySelector('.n').textContent = it.label + '/' + it.key + ' 渲染失败'
    box.classList.add('bad')
    out.push({ label: it.label, key: it.key, dx: 0, dy: 0, offset: 0, error: true })
    if (--pending === 0) done()
  }
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(it.svg)
}
</script></body></html>`

writeFileSync(new URL('../.preview/center-audit.html', import.meta.url), html)
console.log('center-audit.html 已生成，共', items.length, '枚图标')
