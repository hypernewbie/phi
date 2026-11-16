# Launcher icons from the repo's own brand raster — no re-rendering,
# no invented colors or fonts. desktop/electron/assets/icon.png is the
# Φ glyph gen-icon.mjs produces (JetBrains Mono, the --font-mono face);
# the desktop ships exactly these pixels as its app icon. The launcher
# layers it over solid --bg (#08080a): the mask supplies the shape.
#
# Run: python3 gen-icons.py   (PIL required)
from PIL import Image, ImageDraw
import os

SRC = "../desktop/electron/assets/icon.png"
RES = "app/src/main/res"
BG = (8, 8, 10, 255)  # --bg / --bg-base #08080a

DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

glyph = Image.open(SRC).convert("RGBA")

for d, px in DENS.items():
    p = os.path.join(RES, f"mipmap-{d}")
    os.makedirs(p, exist_ok=True)
    g = glyph.resize((px, px), Image.LANCZOS)

    # foreground: the glyph inset to ~70% so the adaptive canvas's safe
    # zone (66% center circle) frames it at launcher scale. No monochrome
    # layer: Samsung's themed icons swap it in wholesale and rendered a
    # blank tile; without it launchers use the fg+bg composite.
    fg = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    inner = int(px * 0.7)
    fg.alpha_composite(
        glyph.resize((inner, inner), Image.LANCZOS),
        ((px - inner) // 2, (px - inner) // 2),
    )
    fg.save(os.path.join(p, "ic_launcher_fg.png"))

    # legacy + round: glyph over solid bg, square and circle framed
    tile = Image.new("RGBA", (px, px), BG)
    tile.alpha_composite(g)
    tile.save(os.path.join(p, "ic_launcher.png"))
    mask = Image.new("L", (px, px), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, px, px), fill=255)
    circ = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    circ.paste(tile, (0, 0), mask)
    circ.save(os.path.join(p, "ic_launcher_round.png"))

os.makedirs(os.path.join(RES, "mipmap-anydpi"), exist_ok=True)
with open(os.path.join(RES, "mipmap-anydpi", "ic_launcher.xml"), "w") as f:
    f.write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<adaptive-icon "
        'xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/bg"/>\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_fg"/>'
        "</adaptive-icon>\n"
    )
print("brand-raster icons written")
