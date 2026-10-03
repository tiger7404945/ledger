/**
 * 填充风 SVG → 内联图标 转换脚本（S8-8 吃喝 / S8-9 购物，后续批次往 BATCHES 里加即可）。
 * 用法：node scripts/convert-fill-icons.mjs
 * 产物：src/components/icons/{foodFill,shopFill}.js（生成物，别手改路径数据）
 *
 * 每批做两件事：
 *  1. 外层 <g stroke="none">：压掉 IconBase 画布级的 stroke="currentColor" + stroke-width，
 *     填充风图标不吃描边（否则轮廓会加粗一圈）；
 *  2. transform="scale(24/512)"：原稿坐标系是 512×512，整体映射进 IconBase 的 24×24 viewBox。
 * 颜色一律 fill="currentColor"，主题联动（灰 / mint / 绿底白）与旧线性图标完全一致。
 *
 * extractor 两种：
 *  - 'g'    ：源文件是「裸 <path> 包在 <g fill=currentColor> 里」（吃喝批，原样抠出 <g> 保其内部变换）
 *  - 'shell': 源文件是「裸 <path fill=currentColor> 直接铺在 svg 根下，无 <g>」（购物批，抠掉 svg 壳和 title）
 */
import { readFileSync, writeFileSync } from 'node:fs'

const SRC_SCALE = 24 / 512

const BATCHES = [
  {
    name: 'eat',
    out: 'src/components/icons/foodFill.js',
    exportName: 'FOOD_FILL_ICONS',
    dir: 'C:/Users/DELL/Downloads/svg-输出/svg',
    extractor: 'g',
    header: [
      ' * 吃喝组·填充风图标（S8-8，由 scripts/convert-fill-icons.mjs 从用户手绘 SVG 生成 —— 别手改路径数据）',
      ' *',
      ' * 来源：用户提供的 16 张 512×512 填充风 SVG。',
      ' * 同 key 覆盖（apple / carrot / cocktail / burger / cutlery / bowl / cake / candy）在',
      ' * index.js 里以「后展开覆盖先定义」生效；其余 8 个是新 key，已加进 ICON_GROUPS 吃喝组。'
    ],
    MAP: [
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
  },
  {
    name: 'shop',
    out: 'src/components/icons/shopFill.js',
    exportName: 'SHOP_FILL_ICONS',
    dir: 'E:/svg-输出-五类/shopping',
    extractor: 'shell',
    header: [
      ' * 购物组·填充风图标（S8-9，由 scripts/convert-fill-icons.mjs 从用户手绘 SVG 生成 —— 别手改路径数据）',
      ' *',
      ' * 来源：用户提供的 16 张 512×512 填充风 SVG（单 path、每条自带 fill="currentColor"）。',
      ' * 同 key 覆盖 10 个旧 key（bag / cart / tshirt / diamond / scissors / box / camera /',
      ' * monitor / truck / duck），历史库零迁移自动换新；其余 6 个是新 key，已加进 ICON_GROUPS 购物组。',
      ' * 注：源文件 mask.svg 的实际内容是化妆镜（title=mirror），故 key 取 mirror 而非 mask。'
    ],
    MAP: [
      ['shopping-bag.svg', 'bag'],
      ['shopping-cart.svg', 'cart'],
      ['tshirt.svg', 'tshirt'],
      ['pants.svg', 'pants'],
      ['diamond.svg', 'diamond'],
      ['cosmetics.svg', 'cosmetics'],
      ['mask.svg', 'mirror'],
      ['smartphone.svg', 'smartphone'],
      ['scissors.svg', 'scissors'],
      ['package-box.svg', 'box'],
      ['camera.svg', 'camera'],
      ['monitor.svg', 'monitor'],
      ['delivery-truck.svg', 'truck'],
      ['rubber-duck.svg', 'duck'],
      ['toilet-paper.svg', 'toiletPaper'],
      ['ice-skate.svg', 'iceSkate']
    ]
  },
  {
    name: 'sport',
    out: 'src/components/icons/sportFill.js',
    exportName: 'SPORT_FILL_ICONS',
    dir: 'E:/svg-输出-五类/sports',
    extractor: 'shell',
    header: [
      ' * 运动组·填充风图标（S8-10，由 scripts/convert-fill-icons.mjs 从用户手绘 SVG 生成 —— 别手改路径数据）',
      ' *',
      ' * 来源：用户提供的 9 张 512×512 填充风 SVG（单 path、每条自带 fill="currentColor"）。',
      ' * 同 key 覆盖 3 个旧 key（basketball / dumbbell / swim←swimming-pool）；其余 6 个是新 key。',
      ' * 注：running-shoe 是新 key（不覆盖旧线性 run）。'
    ],
    MAP: [
      ['basketball.svg', 'basketball'],
      ['dumbbell.svg', 'dumbbell'],
      ['swimming-pool.svg', 'swim'],
      ['running-shoe.svg', 'runningShoe'],
      ['badminton.svg', 'badminton'],
      ['billiards.svg', 'billiards'],
      ['climbing.svg', 'climbing'],
      ['fishing.svg', 'fishing'],
      ['racket.svg', 'racket']
    ]
  },
  {
    name: 'traffic',
    out: 'src/components/icons/transportFill.js',
    exportName: 'TRANSPORT_FILL_ICONS',
    dir: 'E:/svg-输出-五类/transport',
    extractor: 'shell',
    header: [
      ' * 交通组·填充风图标（S8-10，由 scripts/convert-fill-icons.mjs 从用户手绘 SVG 生成 —— 别手改路径数据）',
      ' *',
      ' * 来源：用户提供的 10 张 512×512 填充风 SVG（单 path、每条自带 fill="currentColor"）。',
      ' * 同 key 覆盖 7 个旧 key（car / bus / train←high-speed-rail / ship / bike←bicycle /',
      ' * parking / fuel←gas-pump）；其余 3 个是新 key（metro / tram / charging）。'
    ],
    MAP: [
      ['car.svg', 'car'],
      ['bus.svg', 'bus'],
      ['high-speed-rail.svg', 'train'],
      ['ship.svg', 'ship'],
      ['bicycle.svg', 'bike'],
      ['metro.svg', 'metro'],
      ['tram.svg', 'tram'],
      ['charging.svg', 'charging'],
      ['parking.svg', 'parking'],
      ['gas-pump.svg', 'fuel']
    ]
  },
  {
    name: 'fun',
    out: 'src/components/icons/funFill.js',
    exportName: 'FUN_FILL_ICONS',
    dir: 'E:/svg-输出-五类/entertainment',
    extractor: 'shell',
    header: [
      ' * 娱乐组·填充风图标（S8-10，由 scripts/convert-fill-icons.mjs 从用户手绘 SVG 生成 —— 别手改路径数据）',
      ' *',
      ' * 来源：用户提供的 10 张 512×512 填充风 SVG（单 path、每条自带 fill="currentColor"）。',
      ' * 同 key 覆盖 4 个旧 key（gamepad / film←film-reel / headset←headphones / microphone）；',
      ' * 其余 6 个是新 key（mahjong / playingCards / videoPlay / palmTree / hat / moneyBag）。',
      ' * 注：money-bag 画的实际是红包封，但没覆盖人情组的 redpacket —— 人情组保持旧图标。'
    ],
    MAP: [
      ['gamepad.svg', 'gamepad'],
      ['film-reel.svg', 'film'],
      ['headphones.svg', 'headset'],
      ['microphone.svg', 'microphone'],
      ['mahjong.svg', 'mahjong'],
      ['playing-cards.svg', 'playingCards'],
      ['video-play.svg', 'videoPlay'],
      ['palm-tree.svg', 'palmTree'],
      ['hat.svg', 'hat'],
      ['money-bag.svg', 'moneyBag']
    ]
  },
  {
    name: 'house',
    out: 'src/components/icons/houseFill.js',
    exportName: 'HOUSE_FILL_ICONS',
    dir: 'E:/svg-输出-五类/housing',
    extractor: 'shell',
    header: [
      ' * 住房组·填充风图标（S8-10，由 scripts/convert-fill-icons.mjs 从用户手绘 SVG 生成 —— 别手改路径数据）',
      ' *',
      ' * 来源：用户提供的 6 张 512×512 填充风 SVG（单 path、每条自带 fill="currentColor"）。',
      ' * 同 key 覆盖 2 个旧 key（bed / house）；其余 4 个是新 key（rent / electricity / gas / telephone）。'
    ],
    MAP: [
      ['house.svg', 'house'],
      ['bed.svg', 'bed'],
      ['rent.svg', 'rent'],
      ['electricity.svg', 'electricity'],
      ['gas.svg', 'gas'],
      ['telephone.svg', 'telephone']
    ]
  },
  {
    name: 'study',
    out: 'src/components/icons/studyFill.js',
    exportName: 'STUDY_FILL_ICONS',
    dir: 'D:/projects/ledger/.vectorize-work/svg',
    extractor: 'g',
    header: [
      ' * 学习组·填充风图标（S8-11，由 scripts/convert-fill-icons.mjs 从用户 PNG 矢量化生成 —— 别手改路径数据）',
      ' *',
      ' * 来源：用户提供的 7 张 PNG（豆包 AI 线稿，.vectorize-work/vectorize.py 矢量化）。',
      ' * 同 key 覆盖 3 个旧 key（cap / book / pen）；其余 4 个是新 key（backpack / training / teach / palette）。'
    ],
    MAP: [
      ['backpack.svg', 'backpack'],
      ['cap.svg', 'cap'],
      ['book.svg', 'book'],
      ['pen.svg', 'pen'],
      ['training.svg', 'training'],
      ['teach.svg', 'teach'],
      ['palette.svg', 'palette']
    ]
  },
  {
    name: 'family',
    out: 'src/components/icons/familyFill.js',
    exportName: 'FAMILY_FILL_ICONS',
    dir: 'D:/projects/ledger/.vectorize-work/svg',
    extractor: 'g',
    header: [
      ' * 家庭组·填充风图标（S8-11，由 scripts/convert-fill-icons.mjs 从用户 PNG 矢量化生成 —— 别手改路径数据）',
      ' *',
      ' * 来源：用户提供的 7 张 PNG（豆包 AI 线稿，.vectorize-work/vectorize.py 矢量化）。',
      ' * 全部是新 key（pendantLamp / tv / aircon / roller / hammer / fridge）；',
      ' * 注：第 4 张相机与购物组 camera 重复，不生成 —— 家庭组选择器直接复用 camera key。'
    ],
    MAP: [
      ['pendantLamp.svg', 'pendantLamp'],
      ['tv.svg', 'tv'],
      ['aircon.svg', 'aircon'],
      ['roller.svg', 'roller'],
      ['hammer.svg', 'hammer'],
      ['fridge.svg', 'fridge']
    ]
  },
  {
    name: 'gift',
    out: 'src/components/icons/giftFill.js',
    exportName: 'GIFT_FILL_ICONS',
    dir: 'D:/projects/ledger/.vectorize-work/svg',
    extractor: 'g',
    header: [
      ' * 人情组·填充风图标（S8-11，由 scripts/convert-fill-icons.mjs 从用户 PNG 矢量化生成 —— 别手改路径数据）',
      ' *',
      ' * 来源：用户提供的 7 张 PNG（豆包 AI 线稿，.vectorize-work/vectorize.py 矢量化）。',
      ' * 同 key 覆盖 2 个旧 key（gift / redpacket，红包种子分类自动换新）；',
      ' * 其余 4 个是新 key（reward / heart / doubleHeart / coinBag）。',
      ' * 注：第 7 张（dome+双环）内容待用户确认，暂未接入（SVG 存 .vectorize-work/svg/mystery.svg）。'
    ],
    MAP: [
      ['reward.svg', 'reward'],
      ['redpacket.svg', 'redpacket'],
      ['heart.svg', 'heart'],
      ['gift.svg', 'gift'],
      ['doubleHeart.svg', 'doubleHeart'],
      ['coinBag.svg', 'coinBag']
    ]
  }
]

// d 属性里的数字统一降到 2 位小数（原稿 512 坐标系，误差 < 0.01px@24px，纯瘦身）
function roundNums(s) {
  return s.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (m) => {
    const n = Number(m)
    if (!Number.isFinite(n)) return m
    return String(Math.round(n * 100) / 100)
  })
}

function extractInner(svg, extractor, file) {
  if (extractor === 'g') {
    const m = svg.match(/<g\b[\s\S]*<\/g>/)
    if (!m) throw new Error('no <g> in ' + file)
    return m[0]
  }
  // shell：抠掉 <svg ...> 壳、<title>，剩下的就是铺在根下的 path 列表
  const m = svg.match(/<\/title>([\s\S]*)<\/svg>/)
  if (!m) throw new Error('no </title>..</svg> in ' + file)
  return m[1]
}

for (const batch of BATCHES) {
  const entries = []
  let total = 0
  for (const [file, key] of batch.MAP) {
    const svg = readFileSync(batch.dir + '/' + file, 'utf8')
    // 原稿是带换行缩进的多行 SVG：折叠成单行，才能安全放进单引号字符串字面量
    const inner = roundNums(extractInner(svg, batch.extractor, file)).replace(/\s+/g, ' ').trim()
    const wrapped = '<g stroke="none" transform="scale(' + SRC_SCALE + ')">' + inner + '</g>'
    entries.push('  ' + key + ": '" + wrapped + "'")
    total += wrapped.length
    console.log(batch.name.padEnd(5), key.padEnd(12), (wrapped.length / 1024).toFixed(1) + 'KB')
  }

  const js = [
    '/**',
    ...batch.header,
    ' *',
    ' * 转换做了两件事：',
    ' *  1. 外层 <g stroke="none">：压掉 IconBase 画布级描边；',
    ' *  2. transform="scale(24/512)"：原稿 512×512 坐标系映射进 IconBase 的 24×24 viewBox。',
    ' * 颜色仍走 fill="currentColor"，主题联动（灰 / mint / 绿底白）与旧线性图标完全一致。',
    ' */',
    'export const ' + batch.exportName + ' = {',
    entries.join(',\n'),
    '}',
    ''
  ].join('\n')

  writeFileSync(batch.out, js)
  console.log('---')
  console.log(batch.name, 'total:', (total / 1024).toFixed(1) + 'KB ->', batch.out)
}
