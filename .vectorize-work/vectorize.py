# -*- coding: utf-8 -*-
"""
PNG 图标 → 单色 SVG 矢量化（icon-vectorize 流程，S8-11 学习/家庭/人情）。
输入：E:/图片处理/{学习,家庭,人情}/豆包*.png（1536²，白底黑线稿）
输出：.vectorize-work/svg/<name>.svg（512 画布、<g fill="currentColor"> 包 vtracer path）
用法：.venv/Scripts/python.exe .vectorize-work/vectorize.py
"""
import glob
import os
import re

import numpy as np
import vtracer
from PIL import Image, ImageFilter

ROOT = 'E:/图片处理'
OUT = 'D:/projects/ledger/.vectorize-work/svg'
WORK = 512          # 工作分辨率（甜点尺度）
T = 512             # 输出画布
MARGIN = 0.05       # contain 留白比例
TH = 128            # 全局二值阈值（同时清掉水印与淡纹理，采样已验证）

# 组 → {sorted 序号(1..7, 豆包.png=7) → 语义文件名}
MAP = {
    '学习': {1: 'backpack', 2: 'cap', 3: 'book', 4: 'pen', 5: 'training', 6: 'teach', 7: 'palette'},
    '家庭': {1: 'pendantLamp', 2: 'tv', 3: 'aircon', 4: 'camera', 5: 'roller', 6: 'hammer', 7: 'fridge'},
    '人情': {1: 'reward', 2: 'redpacket', 3: 'heart', 4: 'gift', 5: 'doubleHeart', 6: 'coinBag', 7: 'mystery'},
}

os.makedirs(OUT, exist_ok=True)
report = []

for group, mapping in MAP.items():
    files = sorted(glob.glob(f'{ROOT}/{group}/*.png'))
    assert len(files) == len(mapping), f'{group}: {len(files)} files vs {len(mapping)} keys'
    for idx, src in enumerate(files, 1):
        name = mapping[idx]
        im = Image.open(src)
        im.load()
        # ① 白底合成（无 alpha 也要走，PNG 可能带调色板）
        bg = Image.new('RGB', im.size, 'white')
        bg.paste(im, mask=im.split()[-1] if im.mode in ('RGBA', 'LA') else None)
        gray = np.asarray(bg.convert('L'), dtype=np.uint8)
        # ② 3×3 中值去孤立暗斑（原图尺度）
        med = np.asarray(Image.fromarray(gray).filter(ImageFilter.MedianFilter(3)))
        fg = med < TH
        if not fg.any():
            print(f'!! {group}/{idx} 无前景，跳过')
            continue
        # ③ bbox + 2% guard（灰度裁剪越界补白；掩码越界补 0）
        ys, xs = np.where(fg)
        y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
        h, w = gray.shape
        g2 = int(0.02 * max(y1 - y0, x1 - x0))
        cy0, cy1 = max(0, y0 - g2), min(h, y1 + g2 + 1)
        cx0, cx1 = max(0, x0 - g2), min(w, x1 + g2 + 1)
        gc = gray[cy0:cy1, cx0:cx1]
        mc = fg[cy0:cy1, cx0:cx1].astype(np.uint8) * 255
        # ④ 无条件缩放到工作分辨率（⚠ 不能 if s<1）
        s = WORK / max(gc.shape)
        gcb = np.asarray(
            Image.fromarray(gc).resize((int(gc.shape[1] * s), int(gc.shape[0] * s)), Image.LANCZOS)
        )
        mcb = np.asarray(
            Image.fromarray(mc).resize((int(gc.shape[1] * s), int(gc.shape[0] * s)), Image.LANCZOS)
        )
        # ⑤ 缩放「之后」的高斯 + 二值化（掩码门控兜底淡纹理）
        gb = np.asarray(Image.fromarray(gcb).filter(ImageFilter.GaussianBlur(1.0)))
        mb = np.asarray(Image.fromarray(mcb).filter(ImageFilter.GaussianBlur(1.0)))
        binimg = (mb > 110) & (gb < TH)
        if not binimg.any():
            print(f'!! {group}/{idx} 二值化后为空')
            continue
        # ⑥ vtracer（binary + spline，参数沿用已验证组）
        bin_path = f'{OUT}/_bin_{name}.png'
        Image.fromarray((~binimg * 255).astype(np.uint8)).save(bin_path)  # 前景=黑
        raw_svg = f'{OUT}/_raw_{name}.svg'
        vtracer.convert_image_to_svg_py(
            bin_path, raw_svg,
            colormode='binary', mode='spline',
            filter_speckle=4, corner_threshold=60,
            length_threshold=4.0, path_precision=1,
        )
        # ⑦ 提 path（原样保留 translate），剥硬编码 fill
        with open(raw_svg, encoding='utf-8') as f:
            raw = f.read()
        paths = re.findall(r'<path\b[^>]*/>', raw)
        cleaned = [re.sub(r'\s*fill="[^"]*"', '', p) for p in paths]
        # ⑧ contain 居中进 512 画布（前景 bbox）
        pys, pxs = np.where(binimg)
        by0, by1, bx0, bx1 = pys.min(), pys.max(), pxs.min(), pxs.max()
        cw, ch = bx1 - bx0 + 1, by1 - by0 + 1
        inner = T * (1 - 2 * MARGIN)
        sc = min(inner / cw, inner / ch)
        tx = (T - sc * cw) / 2 - sc * bx0
        ty = (T - sc * ch) / 2 - sc * by0
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {T} {T}" width="{T}" height="{T}">\n'
            f'  <title>{name}</title>\n'
            f'  <g transform="translate({tx:.1f} {ty:.1f}) scale({sc:.5f})" fill="currentColor">\n'
            + '\n'.join('    ' + p for p in cleaned)
            + '\n  </g>\n</svg>\n'
        )
        out_path = f'{OUT}/{name}.svg'
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(svg)
        os.remove(bin_path)
        os.remove(raw_svg)
        report.append((group, idx, name, f'{cw}x{ch}', len(paths), len(cleaned), os.path.getsize(out_path)))
        # ⑨ IoU 自检基准图：与 SVG 同一 contain 几何贴 512 画布
        base = np.zeros((T, T), dtype=np.uint8)
        by0t, by1t = int(ty + sc * by0), int(np.ceil(ty + sc * (by1 + 1)))
        bx0t, bx1t = int(tx + sc * bx0), int(np.ceil(tx + sc * (bx1 + 1)))
        sub = Image.fromarray((binimg[by0:by1 + 1, bx0:bx1 + 1] * 255).astype(np.uint8)).resize(
            (bx1t - bx0t, by1t - by0t), Image.LANCZOS
        )
        base[by0t:by1t, bx0t:bx1t] = np.asarray(sub)
        np.save(f'{OUT}/_base_{name}.npy', base)

for r in report:
    print(f'{r[0]}/{r[1]} -> {r[2]}.svg  fg={r[3]}  paths={r[4]}  {r[6]/1024:.1f}KB')
print(f'total {len(report)} svgs')
