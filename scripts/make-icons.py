"""Render the PNG app icons (needs Pillow). Run from the repo root: python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw
def icon(size, maskable=False):
    s = 4  # supersample
    W = size * s
    im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskable:
        d.rectangle([0, 0, W, W], fill='#111827'); k = 0.72
    else:
        d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill='#111827'); k = 1.0
    c = W / 2; r = W * 150 / 512 * k; w = int(W * 28 / 512 * k)
    d.ellipse([c - r, c - r, c + r, c + r], outline='white', width=w)
    def P(x, y): return (c + (x - 256) / 512 * W * k, c + (y - 256) / 512 * W * k)
    d.line([P(256, 170), P(256, 262), P(318, 302)], fill='white', width=w, joint='curve')
    for x, y in [P(256, 170), P(256, 262), P(318, 302)]:
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill='white')
    rx, ry = P(388, 124); rr = 44 / 512 * W * k
    d.ellipse([rx - rr, ry - rr, rx + rr, ry + rr], fill='#e11d48')
    return im.resize((size, size), Image.LANCZOS)
icon(192).save('public/icons/icon-192.png')
icon(512).save('public/icons/icon-512.png')
icon(512, True).save('public/icons/maskable-512.png')
bg = Image.new('RGB', (180, 180), '#111827'); i = icon(180, True); bg.paste(i, (0, 0), i); bg.save('public/icons/apple-touch-icon.png')
