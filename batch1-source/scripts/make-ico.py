"""把 assets/icons/icon-*.png 组装成规范的 app.ico（PNG 压缩，Windows Vista+ 支持）。"""
import os
import struct

D = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'icons')
SIZES = [256, 128, 64, 48, 32, 24, 16]

imgs = []
for s in SIZES:
    p = os.path.join(D, f'icon-{s}.png')
    with open(p, 'rb') as f:
        imgs.append((s, f.read()))

header = struct.pack('<HHH', 0, 1, len(imgs))
entries = b''
offset = 6 + 16 * len(imgs)
for s, data in imgs:
    w = 0 if s >= 256 else s
    h = 0 if s >= 256 else s
    entries += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(data), offset)
    offset += len(data)

with open(os.path.join(D, 'app.ico'), 'wb') as f:
    f.write(header + entries + b''.join(d for _, d in imgs))

print('app.ico ok:', os.path.getsize(os.path.join(D, 'app.ico')), 'bytes,', len(imgs), 'sizes')
