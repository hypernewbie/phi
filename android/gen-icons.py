# One-off generator: launcher icons from desktop/electron/assets/icon.png
# (the real Phi brand glyph raster). Run: python3 gen-icons.py
# Outputs mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png (48..192)
# plus ic_launcher_round.png, and anydpi-v26 adaptive icon on obsidian.
from PIL import Image, ImageDraw
import os
SRC = "../desktop/electron/assets/icon.png"
RES = "app/src/main/res"
DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
im = Image.open(SRC).convert("RGBA")
for d, px in DENS.items():
    p = os.path.join(RES, f"mipmap-{d}")
    os.makedirs(p, exist_ok=True)
    im.resize((px, px), Image.LANCZOS).save(os.path.join(p, "ic_launcher.png"))
    # Round icon: true circular mask so launchers don't clip a square.
    mask = Image.new("L", (px, px), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, px, px), fill=255)
    circ = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    circ.paste(im.resize((px, px), Image.LANCZOS), (0, 0), mask)
    circ.save(os.path.join(p, "ic_launcher_round.png"))
os.makedirs(os.path.join(RES, "mipmap-anydpi"), exist_ok=True)
open(os.path.join(RES, "mipmap-anydpi", "ic_launcher.xml"), "w").write(
    '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon '
    'xmlns:android="http://schemas.android.com/apk/res/android">\n'
    '    <background android:drawable="@color/obsidian_bg"/>\n'
    '    <foreground android:drawable="@mipmap/ic_launcher"/>\n'
    '    <monochrome android:drawable="@mipmap/ic_launcher"/>\n</adaptive-icon>\n')
os.makedirs(os.path.join(RES, "values"), exist_ok=True)
print("icons written")
