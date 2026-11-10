# 由 icon-1024.png 生成各尺寸 PNG + app.ico（LANCZOS + 小尺寸锐化）
import os
from PIL import Image, ImageFilter

D = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'icons')
src = Image.open(os.path.join(D, 'icon-1024.png')).convert('RGBA')

# 去掉极边缘的半透明脏边（渲染抗锯齿残留）
alpha = src.getchannel('A').point(lambda a: 0 if a < 6 else a)
src.putalpha(alpha)

for s in (512, 256, 128, 64, 48, 32, 24, 16):
    im = src.resize((s, s), Image.LANCZOS)
    if s <= 32:
        im = im.filter(ImageFilter.UnsharpMask(radius=0.6, percent=70, threshold=0))
    im.save(os.path.join(D, f'icon-{s}.png'))

src.save(os.path.join(D, 'app.ico'), sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
for n in ('16', '32'):
    Image.open(os.path.join(D, f'icon-{n}.png')).save(os.path.join(D, f'tray-{n}.png'))
print('icons done')
