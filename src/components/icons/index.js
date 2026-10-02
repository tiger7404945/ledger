/**
 * 内置线性图标库（24x24，stroke=currentColor）
 * 参考截图中的分类图标分组：吃喝 / 购物 / 交通 / 住房 / 娱乐 / 运动 / 人情 / 家庭 / 学习 / 医疗
 * 图标选择器（CategoryEditView）按 ICON_GROUPS 渲染左右两栏。
 *
 * 约定：
 *  - 默认 fill: none，stroke: currentColor
 *  - 需要在描边图标上点缀实心元素时，显式写 fill="currentColor" stroke="none"
 *  - S8-8 起吃喝组混入填充风图标（foodFill.js，fill="currentColor" stroke="none"），
 *    两种风格共用同一张 24×24 画布与 currentColor 主题联动
 */
import { FOOD_FILL_ICONS } from './foodFill.js'

/** 原样再导出：给测试（gate-test 扫描硬编码色）与预览页用，别的地方别直接 import foodFill.js */
export { FOOD_FILL_ICONS }

/**
 * 分类图标的「图标 / 圆底」尺寸比 —— ★ 调图标大小就改这一个数 ★
 *
 * CategoryIcon 的默认 iconRatio。0.5 = 原始设计（图标占圆底直径的一半）；
 * 填充风图标视觉更满，S8-8 起默认 0.62。想要更大/更小直接调这里：
 *   0.50 → 原始大小    0.62 → 当前默认（明显更大）
 *   0.56 → 稍大        0.68 → 塞满圆底（再大就要出圈了）
 * 单处覆盖不受影响：任何 <CategoryIcon :icon-ratio="..."> 显式传值仍优先生效。
 */
export const CATEGORY_ICON_RATIO = 0.62

export const ICONS = {
  /* ================= 吃喝 ================= */
  can: '<ellipse cx="12" cy="6.8" rx="4.6" ry="2.4"/><path d="M7.4 6.8v10.4a4.6 2.4 0 0 0 9.2 0V6.8"/><path d="M10.2 12.4c.9-1 1.8-1 2.7 0s1.8 1 2.7 0"/>',
  lollipop:
    '<circle cx="10" cy="9.6" r="5.2"/><path d="M10 6.4a3.2 3.2 0 0 1 3.2 3.2"/><path d="M13.8 13.4 20 19.6"/>',
  bowl: '<path d="M3.4 11.6h17.2a8.6 8.6 0 0 1-17.2 0Z"/><path d="M10 8.4c0-1.1 2-1.3 2-2.4M14.4 8.4c0-1.1 2-1.3 2-2.4"/>',
  cake: '<path d="M5 14.2h14l-1.5 5.3a1 1 0 0 1-1 .7H7.5a1 1 0 0 1-1-.7L5 14.2Z"/><path d="M6.4 14.2a5.6 5.6 0 0 1 11.2 0"/><path d="M12 8.6V6.6"/><circle cx="12" cy="5.4" r="1"/>',
  popcorn:
    '<path d="M7.6 9.4h8.8l1 11.2H6.6l1-11.2Z"/><path d="M9.4 9.4 9 20.6M12 9.4v11.2M14.6 9.4 15 20.6"/><path d="M7.4 9.4a2.4 2.2 0 0 1 1.6-3.4 2.4 2.2 0 0 1 3.6-1.4 2.4 2.2 0 0 1 3.8 1.4 2.4 2.2 0 0 1 1.6 3.4"/>',
  burger:
    '<path d="M3.6 10.6a8.4 3.4 0 0 1 16.8 0Z"/><path d="M3.6 13.6h16.8"/><path d="M3.6 16.4a8.4 3.4 0 0 0 16.8 0Z"/><circle cx="7.4" cy="7.4" r=".55" fill="currentColor" stroke="none"/><circle cx="12" cy="6.6" r=".55" fill="currentColor" stroke="none"/><circle cx="16.6" cy="7.6" r=".55" fill="currentColor" stroke="none"/>',
  carrot:
    '<path d="M8.8 20.6 3.8 15.6a3.6 3.6 0 0 1 .4-5.2 3.6 3.6 0 0 1 5.2-.4l5 5a7.2 7.2 0 0 1-5.6 5.6Z"/><path d="M14.6 6.4 16.6 4.2M16.6 9 19.6 7.6M12.6 4.4 13.6 2.2"/><path d="M7.4 12.6l1.6 1.6M9.6 10.4l1.6 1.6"/>',
  apple:
    '<path d="M12 8.6c-1.6-2-4.5-1.6-5.6.6-1.1 2.2.2 5.9 2.3 7.9 1 1 2.3 1 3.3 0 1 1 2.3 1 3.3 0 2.1-2 3.4-5.7 2.3-7.9-1.1-2.2-4-2.6-5.6-.6Z"/><path d="M12 8.6V5.6"/><path d="M12 5.6c.8-1.3 2.1-1.7 2.9-1.6"/>',
  fries:
    '<path d="M6.6 9.6h10.8l1 10.8H5.6l1-10.8Z"/><path d="M9.2 9.6V4.4M12 9.6V3.2M14.8 9.6V4.6"/><path d="M7.2 14.2h9.6"/>',
  cutlery:
    '<path d="M6.6 3.2v5.6a2.3 2.3 0 0 0 4.6 0V3.2"/><path d="M8.9 8.8v12"/><path d="M16.6 3.2c-1.6 1.5-2.4 3.5-2.4 5.6 0 1.8.8 3.3 2.4 3.8v8.2"/>',
  cocktail:
    '<path d="M4.4 4.4h11.2L10 11.6 4.4 4.4Z"/><path d="M10 11.6v7.6"/><path d="M6.6 19.2h6.8"/>',
  sushi:
    '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3.6"/><path d="M5.6 12h1.8M16.6 12h1.8"/>',
  chopsticks:
    '<path d="M3.4 20.6 12.6 4.4M7 21 15.2 5.2"/><path d="M11.2 13.6h9.4a4.7 4.7 0 0 1-9.4 0Z"/>',
  fish: '<path d="M2.6 12c2.8-4.4 7.6-6 11.4-3.2L17.6 6v12l-3.6-2.8C10.2 18 5.4 16.4 2.6 12Z"/><circle cx="7" cy="11" r=".8" fill="currentColor" stroke="none"/>',

  /* ================= 购物 ================= */
  bag: '<path d="M5.4 8.4h13.2l1 11.2a1 1 0 0 1-1 1.1H5.4a1 1 0 0 1-1-1.1l1-11.2Z"/><path d="M8.8 8.4V6.6a3.2 3.2 0 0 1 6.4 0v1.8"/>',
  tshirt:
    '<path d="M9 3.6 5.4 5.4 4.6 11l2.6.8V20.4h9.6V11.8l2.6-.8-.8-5.6L15 3.6"/><path d="M9 3.6a3 3 0 0 0 6 0"/>',
  cart: '<path d="M3.2 4.4h2.4l2.4 10.4h9.6l2-7.6H6.4"/><circle cx="9" cy="19" r="1.5"/><circle cx="16.6" cy="19" r="1.5"/>',
  bottles:
    '<rect x="3.8" y="10" width="4.6" height="10.4" rx="1.2"/><path d="M4.8 10V7.4h2.6V10"/><rect x="14" y="8" width="4.6" height="12.4" rx="1.2"/><path d="M15 8V5.4h2.6V8"/>',
  scissors:
    '<circle cx="6.6" cy="6.6" r="2.4"/><circle cx="6.6" cy="17.4" r="2.4"/><path d="M8.6 8.2 20.4 17.4M8.6 15.8 20.4 6.6"/>',
  box: '<path d="M3.6 8.4 12 4l8.4 4.4v7.2L12 20l-8.4-4.4V8.4Z"/><path d="M3.6 8.4 12 12.8l8.4-4.4M12 12.8V20"/>',
  camera:
    '<path d="M3.6 8.4h3.2l1.6-2.4h7.2l1.6 2.4h3.2v10.4H3.6V8.4Z"/><circle cx="12" cy="13.4" r="3"/>',
  card: '<rect x="3" y="6.4" width="18" height="12" rx="2.4"/><path d="M3 10.8h18"/><path d="M6.4 15h3.2"/>',
  diamond:
    '<path d="M7.6 3.6h8.8l3.6 5.2L12 20.4 4 8.8l3.6-5.2Z"/><path d="M4 8.8h16M9.2 8.8 12 20.4M14.8 8.8 12 20.4"/>',
  truck:
    '<path d="M2.8 6.6h10.6v9.8H2.8z"/><path d="M13.4 9.8h3.6l3.2 3.2v3.4h-6.8V9.8Z"/><circle cx="6.6" cy="18.4" r="1.7"/><circle cx="16.6" cy="18.4" r="1.7"/>',
  duck: '<path d="M8.4 20.4h7.6"/><path d="M9.6 16.8c-2.4-1.2-3.8-3.2-3.8-5.6 0-1.2.4-2.2 1-3h3.4a4.6 4.6 0 0 1 4.6 4.6c0 .7-.2 1.4-.6 2l1.8 1.6-2.2 1.4"/><circle cx="7.6" cy="10.4" r="1.5"/><path d="M17.6 13.6 20.6 12l-3-1.6"/>',
  monitor:
    '<rect x="2.8" y="5.2" width="18.4" height="11.6" rx="1.6"/><path d="M8.4 20.4h7.2M12 16.8v3.6"/>',
  jacket:
    '<path d="M9.4 3.6 5 6v14.4h14V6l-4.4-2.4"/><path d="M9.4 3.6 12 7.6l2.6-4M12 7.6v12.8"/>',
  coupon:
    '<path d="M3.6 7.2h16.8v3.2a1.6 1.6 0 0 0 0 3.2v3.2H3.6v-3.2a1.6 1.6 0 0 0 0-3.2V7.2Z"/><path d="M9.6 7.2v9.6"/>',

  /* ================= 交通 ================= */
  car: '<path d="M3.6 16.8v-3.4l2-4.6h12.8l2 4.6v3.4"/><path d="M3.6 13.4h16.8"/><circle cx="7.4" cy="16.8" r="1.8"/><circle cx="16.6" cy="16.8" r="1.8"/>',
  compass:
    '<circle cx="12" cy="12" r="8.4"/><path d="M15.4 8.6 13.6 13.6 8.6 15.4l1.8-5 5-1.8Z"/>',
  ship: '<path d="M3.6 15.8h16.8l-2.2 4.2H5.8l-2.2-4.2Z"/><path d="M6.4 15.8V9.4h11.2v6.4"/><path d="M12 9.4V4.6M9.4 6.6h5.2"/>',
  train:
    '<rect x="5.6" y="3.6" width="12.8" height="13.2" rx="2"/><path d="M5.6 10.4h12.8"/><path d="M9.4 13.4h.9M13.6 13.4h.9"/><path d="M8.6 16.8 6.6 20.4M15.4 16.8l2 3.6"/>',
  bike: '<circle cx="6" cy="16.8" r="3.6"/><circle cx="18" cy="16.8" r="3.6"/><path d="M9.6 16.8 12.8 6.8h3.4M6 16.8l4-10h2.8l4.6 8.4M9.4 6.8h4.4"/>',
  bus: '<rect x="4.4" y="3.6" width="15.2" height="13.6" rx="2.4"/><path d="M4.4 12h15.2"/><path d="M9 14.2h.9M14.4 14.2h.9"/><path d="M7.2 17.2v3.2M16.8 17.2v3.2M9.6 7h4.8"/>',
  parking: '<circle cx="12" cy="12" r="8.4"/><path d="M10 16.6V7.8h3.1a2.7 2.7 0 0 1 0 5.4H10"/>',
  fuel: '<path d="M5.6 20.4V6.4a2.6 2.6 0 0 1 2.6-2.6h3.2a2.6 2.6 0 0 1 2.6 2.6v14"/><path d="M3.8 20.4h12"/><path d="M14 9.6h2.8a2.2 2.2 0 0 1 2.2 2.2v5a1.8 1.8 0 0 0 3.6 0v-4.6L19.4 8"/><path d="M8.4 10.4h2.8"/>',
  taxi: '<path d="M3.6 16.8v-3.4l2-4.6h12.8l2 4.6v3.4"/><path d="M3.6 13.4h16.8"/><circle cx="7.4" cy="16.8" r="1.8"/><circle cx="16.6" cy="16.8" r="1.8"/><path d="M9.8 5.6h4.4v2.6H9.8z"/>',

  /* ================= 住房 ================= */
  bolt: '<path d="M13.4 2.6 5.6 13.4h5.2l-.6 8 7.8-10.8h-5.2l.6-7.9Z"/>',
  bed: '<path d="M2.8 18.4v-9"/><path d="M2.8 13.6h18.4v4.8"/><path d="M21.2 18.4v-6"/><path d="M6.4 13.6v-2.4a1.4 1.4 0 0 1 1.4-1.4h3.6a2 2 0 0 1 2 2v1.8"/>',
  flame:
    '<path d="M12 21c3.4 0 5.8-2.3 5.8-5.4 0-4.2-5.8-9.6-5.8-9.6S6.2 11.4 6.2 15.6C6.2 18.7 8.6 21 12 21Z"/><path d="M12 17.6c1 0 1.8-.8 1.8-1.8 0-1.2-1.8-3-1.8-3s-1.8 1.8-1.8 3c0 1 .8 1.8 1.8 1.8Z"/>',
  drop: '<path d="M12 3.2s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11Z"/>',
  call: '<path d="M7.6 3.4 4.4 4.8a2.2 2.2 0 0 0-1.2 2.4c1 6.6 5.6 11.2 12.2 12.2a2.2 2.2 0 0 0 2.4-1.2l1.4-3.2-4.4-2-1.8 2.2a11.6 11.6 0 0 1-5.2-5.2l2.2-1.8-2.4-4.8Z"/>',
  wifi: '<path d="M3.2 9.2a13 13 0 0 1 17.6 0"/><path d="M6.4 12.8a8.4 8.4 0 0 1 11.2 0"/><path d="M9.6 16.4a4 4 0 0 1 4.8 0"/><circle cx="12" cy="19.4" r="1" fill="currentColor" stroke="none"/>',
  houseLoan:
    '<path d="M3.8 10.6 12 3.6l8.2 7v9.4H3.8v-9.4Z"/><path d="M12 10.4v7M9.6 12.4h4.8M9.8 14.6 12 12.2l2.2 2.4"/>',
  house:
    '<path d="M3.8 10.6 12 3.6l8.2 7v9.4H3.8v-9.4Z"/><path d="M9.6 20v-5.4h4.8V20"/>',

  /* ================= 娱乐 ================= */
  person: '<circle cx="12" cy="8.4" r="3.4"/><path d="M5.6 20.4c0-3.6 2.8-6.2 6.4-6.2s6.4 2.6 6.4 6.2"/>',
  laptop:
    '<rect x="4.6" y="5.6" width="14.8" height="10" rx="1.4"/><path d="M2.6 18.6h18.8l-1.2-2.4H3.8l-1.2 2.4Z"/>',
  keypad:
    '<rect x="3.4" y="6.4" width="17.2" height="11.2" rx="1.6"/><circle cx="7.6" cy="10.2" r=".6" fill="currentColor" stroke="none"/><circle cx="12" cy="10.2" r=".6" fill="currentColor" stroke="none"/><circle cx="16.4" cy="10.2" r=".6" fill="currentColor" stroke="none"/><circle cx="7.6" cy="13.8" r=".6" fill="currentColor" stroke="none"/><circle cx="12" cy="13.8" r=".6" fill="currentColor" stroke="none"/><circle cx="16.4" cy="13.8" r=".6" fill="currentColor" stroke="none"/>',
  mask: '<path d="M4.6 8.4c4.8-2 10-2 14.8 0 .6 4.6-2 8.6-7.4 10.4C6.6 17 4 13 4.6 8.4Z"/><path d="M8 11.6h1.8M14.2 11.6H16"/><path d="M9.6 15.2c1.6.8 3.2.8 4.8 0"/>',
  laugh:
    '<circle cx="12" cy="12" r="8.4"/><path d="M8.4 13.4c.8 1.6 2 2.4 3.6 2.4s2.8-.8 3.6-2.4"/><circle cx="9.2" cy="9.6" r=".7" fill="currentColor" stroke="none"/><circle cx="14.8" cy="9.6" r=".7" fill="currentColor" stroke="none"/>',
  film: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2"/><path d="M7.6 4.6v14.8M16.4 4.6v14.8"/><path d="M3.4 9.4h4.2M3.4 14.6h4.2M16.4 9.4h4.2M16.4 14.6h4.2"/>',
  gamepad:
    '<path d="M8.4 8.4h7.2a5.4 5.4 0 0 1 5.2 6.8l-.6 2a2.2 2.2 0 0 1-3.8.8l-1.4-1.8h-6l-1.4 1.8a2.2 2.2 0 0 1-3.8-.8l-.6-2A5.4 5.4 0 0 1 8.4 8.4Z"/><path d="M7.4 12.4h2M8.4 11.4v2"/><circle cx="15.4" cy="12.4" r="1.4"/>',
  dart: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r=".8" fill="currentColor" stroke="none"/><path d="M12 3.6v3M12 17.4v3M3.6 12h3M17.4 12h3"/>',
  easel:
    '<rect x="3.4" y="4.6" width="17.2" height="14.4" rx="1.4"/><path d="M6.6 15.4 10.4 11l3 3 2.6-2.8 4 4.2"/><circle cx="8.4" cy="8.2" r="1.1"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.6 11.6a6.4 6.4 0 0 0 12.8 0"/><path d="M12 18v3.2M9 21.2h6"/>',
  headset:
    '<path d="M4.6 15.4v-3.6a7.4 7.4 0 0 1 14.8 0v3.6"/><path d="M4.6 13h2.2a1 1 0 0 1 1 1v3.4a1 1 0 0 1-1 1H5.6a1 1 0 0 1-1-1V13Z"/><path d="M19.4 13h-2.2a1 1 0 0 0-1 1v3.4a1 1 0 0 0 1 1h1.2a1 1 0 0 0 1-1V13Z"/><path d="M17.6 18.4c0 1.2-1.6 2.2-3.6 2.2"/>',

  /* ================= 运动 ================= */
  basketball:
    '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8M12 3.6v16.8"/><path d="M6.2 6.2c2 2 3 3.6 3 5.8s-1 3.8-3 5.8M17.8 6.2c-2 2-3 3.6-3 5.8s1 3.8 3 5.8"/>',
  football:
    '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.2l3.4 2.4-1.3 4h-4.2l-1.3-4L12 7.2Z"/><path d="M12 3.6v3.6M5.6 10.4l3.6 3.4M18.4 10.4l-3.6 3.4M9.9 13.6 8 19.4M14.1 13.6 16 19.4"/>',
  dumbbell:
    '<path d="M6.4 9.4v5.2M3.6 8v8M17.6 8v8M20.4 9.4v5.2"/><path d="M6.4 12h11.2"/>',
  swim: '<path d="M3.6 17c1.6-1.4 3.2-1.4 4.8 0s3.2 1.4 4.8 0 3.2-1.4 4.8 0"/><path d="M3.6 20.4c1.6-1.4 3.2-1.4 4.8 0s3.2 1.4 4.8 0 3.2-1.4 4.8 0"/><circle cx="16.6" cy="7.4" r="2"/><path d="M12.8 12.8 7.4 11.4"/>',
  run: '<circle cx="14.6" cy="5.2" r="2"/><path d="M12.8 20.4 14.4 15l-3.4-2.4 1.2-4.2 3.2 1.8 3 1"/><path d="M10.4 12.6 6 13.8M15.8 15l3 3.2"/>',
  yoga: '<circle cx="12" cy="5.4" r="2.2"/><path d="M12 9v4.4M12 13.4 7 16M12 13.4 17 16M8.4 20.4 12 17l3.6 3.4"/>',

  /* ================= 人情 ================= */
  gift: '<rect x="3.4" y="9.4" width="17.2" height="4" rx="1"/><path d="M4.8 13.4v7h14.4v-7"/><path d="M12 9.4v11"/><path d="M12 9.4C10.6 9.4 7.4 9.4 7.4 7a2.2 2.2 0 0 1 4.6 0c0 2.4 0 2.4 0 2.4Zm0 0c1.4 0 4.6 0 4.6-2.4a2.2 2.2 0 0 0-4.6 0Z"/>',
  redpacket:
    '<path d="M5.4 4.6h13.2v15l-6.6-3.6-6.6 3.6v-15Z"/><path d="M9.4 10.6a2.6 2.6 0 0 0 5.2 0"/>',
  flower:
    '<circle cx="12" cy="7.4" r="2.6"/><circle cx="12" cy="16.6" r="2.6"/><circle cx="7.4" cy="12" r="2.6"/><circle cx="16.6" cy="12" r="2.6"/><circle cx="12" cy="12" r="1.6"/>',
  candy: '<circle cx="12" cy="12" r="4.4"/><path d="M7.6 12 3.4 9v6l4.2-3Z"/><path d="M16.4 12l4.2 3V9l-4.2 3Z"/>',
  wineglass:
    '<path d="M7.4 3.6h9.2l-.6 5.6a4 4 0 0 1-8 0L7.4 3.6Z"/><path d="M12 13.2v6M8.6 19.2h6.8"/>',
  cakeGift:
    '<rect x="4" y="10" width="16" height="10" rx="1.6"/><path d="M4 14h16"/><path d="M12 10V6.4"/><path d="M12 6.4c-1.4 0-2.4-1-2.4-2.2S11 2.4 12 3.6c1-1.2 2.4-.6 2.4.6S13.4 6.4 12 6.4Z"/>',

  /* ================= 家庭 ================= */
  family:
    '<circle cx="8" cy="8" r="2.8"/><circle cx="16" cy="8.6" r="2.4"/><path d="M2.8 19.4c0-3 2.3-5.2 5.2-5.2s5.2 2.2 5.2 5.2"/><path d="M14.2 14.8c2.5-.6 4.8 1.4 4.8 4.6"/>',
  baby: '<circle cx="12" cy="12" r="8.4"/><circle cx="9.4" cy="10.6" r=".8" fill="currentColor" stroke="none"/><circle cx="14.6" cy="10.6" r=".8" fill="currentColor" stroke="none"/><path d="M9.6 15c1.4 1 3.4 1 4.8 0"/><path d="M12 3.6v1.6"/>',
  pet: '<circle cx="7" cy="9" r="2"/><circle cx="12" cy="6.6" r="2"/><circle cx="17" cy="9" r="2"/><path d="M8 17.4c0-2.4 1.8-4.4 4-4.4s4 2 4 4.4a2.6 2.6 0 0 1-4 2.2 2.6 2.6 0 0 1-4-2.2Z"/>',
  elder:
    '<circle cx="11" cy="6.8" r="2.8"/><path d="M7.6 20.4v-4.6l-1.6-4L11 9.4l5 2.4-1.6 4v4.6"/><path d="M17.6 10.6 20.4 20.4"/>',
  child:
    '<circle cx="12" cy="6.8" r="2.8"/><path d="M7.6 20.4v-4.8a4.4 4.4 0 0 1 8.8 0v4.8"/><path d="M5.6 13.6 3.6 17M18.4 13.6l2 3.4"/>',
  school: '<path d="M3.6 20.4V9.2L12 3.6l8.4 5.6v11.2"/><path d="M3.6 20.4h16.8"/><path d="M9.6 20.4v-5.6h4.8v5.6"/><path d="M12 12.2h.01"/>',

  /* ================= 学习 ================= */
  book: '<path d="M4 5.4c2.8-1.4 5.4-1.4 8 0v14c-2.6-1.4-5.2-1.4-8 0v-14Z"/><path d="M12 5.4c2.6-1.4 5.2-1.4 8 0v14c-2.8-1.4-5.4-1.4-8 0"/><path d="M12 5.4v14"/>',
  notebook:
    '<rect x="5" y="3.6" width="14" height="16.8" rx="2"/><path d="M8.6 3.6v16.8"/><path d="M11.6 8h4.6M11.6 11.6h4.6"/>',
  pen: '<path d="M4.4 19.6 4.8 15 15.6 4.2a2.4 2.4 0 0 1 3.4 3.4L8.2 18.4l-3.8 1.2Z"/><path d="M14.2 5.6l3.4 3.4"/>',
  cap: '<path d="M2.8 9.4 12 5l9.2 4.4L12 13.8 2.8 9.4Z"/><path d="M6.4 11.6v4.6c0 1.6 2.6 2.8 5.6 2.8s5.6-1.2 5.6-2.8v-4.6"/><path d="M20.4 10.4v5.2"/>',
  lightbulb:
    '<path d="M9.4 17.4a6.2 6.2 0 1 1 5.2 0v1.6H9.4v-1.6Z"/><path d="M9.6 21.4h4.8"/>',
  microphone:
    '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.6 11.6a6.4 6.4 0 0 0 12.8 0"/><path d="M12 18v3.2M9 21.2h6"/>',

  /* ================= 医疗 ================= */
  medkit:
    '<rect x="3" y="7.4" width="18" height="12" rx="2.4"/><path d="M8.6 7.4V5.8a2 2 0 0 1 2-2h2.8a2 2 0 0 1 2 2v1.6"/><path d="M12 10.6v5.6M9.2 13.4h5.6"/>',
  pill: '<path d="M8.6 3.6a6 6 0 0 1 8.4 8.4l-5 5A6 6 0 0 1 3.6 8.6l5-5Z"/><path d="M9.4 9.4l5.2 5.2"/>',
  hospital:
    '<path d="M4 20.4V9l8-5.4 8 5.4v11.4H4Z"/><path d="M12 10v6M9 13h6"/>',
  thermometer:
    '<path d="M14.6 13.6V5.2a2.6 2.6 0 0 0-5.2 0v8.4a4.6 4.6 0 1 0 5.2 0Z"/><circle cx="12" cy="17.6" r="1.2" fill="currentColor" stroke="none"/>',
  syringe:
    '<path d="M4.6 19.4 14.8 9.2M17.4 3.6 20.4 6.6M16 5 19 8M9.4 14.6l-1.6-1.6M12.4 11.6 10.8 10"/><path d="M3.4 20.6l2.2-.6-1.6-1.6-.6 2.2Z"/>',
  spa: '<path d="M12 20.4c0-4.6 2-8.6 5.4-10.8-1 5-2.8 8.6-5.4 10.8Z"/><path d="M12 20.4c0-4.6-2-8.6-5.4-10.8 1 5 2.8 8.6 5.4 10.8Z"/><path d="M12 20.4V9.2"/><path d="M12 9.2a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2Z"/>',

  /* ================= 其它 / 会员卡 ================= */
  more: '<circle cx="5.4" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  membership:
    '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.4"/><path d="M7.6 15.4V8.6l4.4 5.2 4.4-5.2v6.8"/>',
  settings:
    '<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6L12 3.2Z"/><circle cx="12" cy="12" r="3"/>',
  piggy:
    '<path d="M4 13.4a6.6 6.6 0 0 1 6.6-6.6h3.2A6.4 6.4 0 0 1 20.2 13c0 2.4-1 4.2-2.6 5.4v2H15v-1.4h-4.2v1.4H8.2v-2A6.3 6.3 0 0 1 4 13.4Z"/><circle cx="15.6" cy="11" r=".8" fill="currentColor" stroke="none"/><path d="M10.6 6.8 10.2 4.4h3.4l.4 2.4"/>',
  wallet:
    '<path d="M3.6 7.6A2.4 2.4 0 0 1 6 5.2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2.4 2.4 0 0 1-2.4-2.4V7.6Z"/><path d="M4 8.6h13.4"/><circle cx="16.4" cy="13.6" r="1.2"/>',

  /* ================= UI ================= */
  search: '<circle cx="11" cy="11" r="6.6"/><path d="M15.8 15.8 20.4 20.4"/>',
  backspace:
    '<path d="M9.4 4.8h10a1.4 1.4 0 0 1 1.4 1.4v11.6a1.4 1.4 0 0 1-1.4 1.4h-10L3 12l6.4-7.2Z"/><path d="M13.2 9.6 17.8 14.4M17.8 9.6 13.2 14.4"/>',
  back: '<path d="M15 4.4 7.4 12l7.6 7.6"/>',
  chevronLeft: '<path d="M14.4 6 8.4 12l6 6"/>',
  chevronRight: '<path d="M9.6 6l6 6-6 6"/>',
  chevronUp: '<path d="M6 14.4 12 8.4l6 6"/>',
  chevronDown: '<path d="M6 9.6 12 15.6l6-6"/>',
  plus: '<path d="M12 5.4v13.2M5.4 12h13.2"/>',
  minus: '<path d="M5.4 12h13.2"/>',
  edit: '<path d="M4.4 19.6 4.8 15 15.6 4.2a2.4 2.4 0 0 1 3.4 3.4L8.2 18.4l-3.8 1.2Z"/><path d="M14.2 5.6l3.4 3.4"/>',
  trash:
    '<path d="M4.6 6.8h14.8"/><path d="M9.4 6.8V4.6h5.2v2.2"/><path d="M6.6 6.8 7.6 20a1.4 1.4 0 0 0 1.4 1.3h6a1.4 1.4 0 0 0 1.4-1.3l1-13.2"/><path d="M10.4 10.6v6.8M13.6 10.6v6.8"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4"/><circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none"/>',
  swap: '<path d="M8.4 4.4 5.8 7l2.6 2.6"/><path d="M5.8 7h12.4"/><path d="M15.6 19.6l2.6-2.6-2.6-2.6"/><path d="M18.2 17H5.8"/>',
  check: '<path d="M5 12.6l4.6 4.6L19 7.4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.2 2"/>',
  calendar:
    '<rect x="3.6" y="5.4" width="16.8" height="15" rx="2.4"/><path d="M8 3.4v4M16 3.4v4M3.6 10.4h16.8"/>',
  image:
    '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2"/><circle cx="8.6" cy="10" r="1.5"/><path d="M4.6 17.4 9.8 12l3.4 3.4 2.4-2.2 4.4 4.2"/>',
  home: '<path d="M3.6 10.6 12 3.6l8.4 7v9.4h-5.6v-5.6H9.2v5.6H3.6v-9.4Z"/>',
  bill: '<rect x="5" y="3.4" width="14" height="17.2" rx="2.4"/><path d="M8.6 8h6.8M8.6 12h6.8M8.6 16h4"/>',
  stats:
    '<path d="M12 3.6a8.4 8.4 0 1 0 8.4 8.4H12V3.6Z"/><path d="M14.4 5.4a8.4 8.4 0 0 1 4.2 4.2h-4.2V5.4Z"/>',
  user: '<circle cx="12" cy="8" r="3.4"/><path d="M5.6 20.4c0-3.6 2.8-6.4 6.4-6.4s6.4 2.8 6.4 6.4"/>',
  grid: '<rect x="3.6" y="3.6" width="7" height="7" rx="1.6"/><rect x="13.4" y="3.6" width="7" height="7" rx="1.6"/><rect x="3.6" y="13.4" width="7" height="7" rx="1.6"/><rect x="13.4" y="13.4" width="7" height="7" rx="1.6"/>',
  list: '<path d="M8 6.4h12M8 12h12M8 17.6h12"/><circle cx="4.4" cy="6.4" r="1" fill="currentColor" stroke="none"/><circle cx="4.4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.4" cy="17.6" r="1" fill="currentColor" stroke="none"/>',
  filter: '<path d="M3.6 5.6h16.8l-6.4 7.4v6l-4-2.2v-3.8L3.6 5.6Z"/>',
  sync: '<path d="M20 12a8 8 0 0 1-13.4 5.9M4 12a8 8 0 0 1 13.4-5.9"/><path d="M17.4 2.8v3.6h-3.6M6.6 21.2v-3.6h3.6"/>',
  cloudOff: '<path d="M6.6 18.4a4.2 4.2 0 0 1-.6-8.4 5.6 5.6 0 0 1 9.4-2.4"/><path d="M17.4 18.4H18a3.6 3.6 0 0 0 .8-7.1"/><path d="M9.6 10.6h5.8a4.4 4.4 0 0 1 1.6 8.5"/><path d="M4 4l16 16"/>',
  arrowUp: '<path d="M12 19.4V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 4.6V19M6 13l6 6 6-6"/>',
  star: '<path d="M12 3.4l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.9l6.1-.9L12 3.4Z"/>',
  'checkbox-on':
    '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="4.6" fill="#3fd9b6" stroke="none"/><path d="M7.6 12.4l3 3 5.8-6" stroke="#fff" stroke-width="2"/>',
  'checkbox-off':
    '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="4.6"/>',
  /* S8-8：吃喝组换用户手绘的填充风图标（同 key 覆盖上面的线性版），放在最后以生效 */
  ...FOOD_FILL_ICONS
}

/** 图标选择器的分组（顺序与截图左右两栏一致） */
export const ICON_GROUPS = [
  {
    key: 'eat',
    label: '吃喝',
    icons: [
      /* S8-8 起前面这些是填充风新图标（user 手绘），后面保留旧线性图标以供选择 */
      'bowl', 'cutlery', 'burger', 'bubbleTea', 'coffeeCup',
      'beer', 'cake', 'candy', 'iceCream', 'popsicle',
      'friedEgg', 'springRoll', 'honeyJar', 'apple', 'carrot',
      'cocktail', 'can', 'lollipop', 'popcorn', 'fries',
      'sushi', 'chopsticks', 'fish', 'cakeGift'
    ]
  },
  {
    key: 'shop',
    label: '购物',
    icons: [
      'bag', 'tshirt', 'cart', 'bottles', 'scissors',
      'box', 'camera', 'card', 'diamond', 'truck',
      'duck', 'monitor', 'jacket', 'coupon', 'wallet'
    ]
  },
  {
    key: 'traffic',
    label: '交通',
    icons: ['car', 'compass', 'ship', 'train', 'bike', 'bus', 'parking', 'fuel', 'taxi']
  },
  {
    key: 'house',
    label: '住房',
    icons: ['bolt', 'bed', 'flame', 'drop', 'call', 'wifi', 'houseLoan', 'house']
  },
  {
    key: 'fun',
    label: '娱乐',
    icons: [
      'person', 'laptop', 'keypad', 'ticket', 'mask',
      'laugh', 'film', 'gamepad', 'dart', 'easel',
      'mic', 'headset'
    ]
  },
  {
    key: 'sport',
    label: '运动',
    icons: ['basketball', 'football', 'dumbbell', 'swim', 'run', 'yoga']
  },
  {
    key: 'gift',
    label: '人情',
    icons: ['gift', 'redpacket', 'flower', 'candy', 'wineglass', 'cakeGift']
  },
  {
    key: 'family',
    label: '家庭',
    icons: ['family', 'baby', 'pet', 'elder', 'child', 'school']
  },
  {
    key: 'study',
    label: '学习',
    icons: ['book', 'notebook', 'pen', 'cap', 'lightbulb', 'microphone']
  },
  {
    key: 'medical',
    label: '医疗',
    icons: ['medkit', 'pill', 'hospital', 'thermometer', 'syringe', 'spa']
  }
]

/** 兜底：ICON_GROUPS 之外的图标，用于「更多图标」区 */
export const EXTRA_ICONS = ['more', 'membership', 'settings', 'piggy', 'wallet', 'star', 'grid', 'list']

export function getIconPath(name) {
  return ICONS[name] || ICONS.more
}
