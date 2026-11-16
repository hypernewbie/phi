# Launcher icons from the ACTUAL Phi favicon formula —
# web-src/theme.ts applyPrepaintFavicon: a rounded tile (rx = 8/32 = 25%)
# filled with a radial gradient accent -> accentDim, white bold Phi glyph
# centered at 60% height. This is the only icon recipe the repo defines
# for itself; the desktop appicon raster is the same glyph in a different
# frame. Default accent = theme.ts 'purple' (#7c6af7 / #5b4ec2).
#
# Run: python3 gen-icons.py   (PIL required)
from PIL import Image, ImageDraw
import os

ACCENT = (124, 106, 247, 255)      # #7c6af7
ACCENT_DIM = (91, 78, 194, 255)    # #5b4ec2

RES = "app/src/main/res"
DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
MASTER = 1024


def tile(size: int) -> Image.Image:
    im = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # radial gradient: sample concentric circles from the center
    cx = cy = MASTER / 2
    for r in range(int(MASTER * 0.72), 0, -4):
        t = r / (MASTER * 0.72)
        color = tuple(
            int(a + (b - a) * t) for a, b in zip(ACCENT, ACCENT_DIM)
        )
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    # rounded-corner mask, rx = 25% (favicon 8/32)
    mask = Image.new("L", (MASTER, MASTER), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, MASTER, MASTER), radius=MASTER // 4, fill=255
    )
    im.putalpha(mask)
    return im.resize((size, size), Image.LANCZOS)


def glyph(font_path: str, px: int) -> Image.Image:
    from PIL import ImageFont

    font = ImageFont.truetype(font_path, int(px * 0.62))
    layer = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    bbox = d.textbbox((0, 0), "Φ", font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    # favicon places the glyph center at 60% height, text-anchor middle
    d.text(
        ((px - w) / 2 - bbox[0], px * 0.60 - h / 2 - bbox[1]),
        "Φ",
        font=font,
        fill=(255, 255, 255, 255),
    )
    return layer


FONT = "../web/vendor/fonts/JetBrainsMono-Regular.ttf"
if not os.path.exists(FONT):
    # any system mono with Greek coverage will do for the prototype
    for cand in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
    ):
        if os.path.exists(cand):
            FONT = cand
            break

for d, px in DENS.items():
    p = os.path.join(RES, f"mipmap-{d}")
    os.makedirs(p, exist_ok=True)
    icon = tile(px)
    icon.alpha_composite(glyph(FONT, px))
    icon.save(os.path.join(p, "ic_launcher.png"))
    # round icon = the same tile under a circular mask
    mask = Image.new("L", (px, px), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, px, px), fill=255)
    circ = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    circ.paste(icon, (0, 0), mask)
    circ.save(os.path.join(p, "ic_launcher_round.png"))

os.makedirs(os.path.join(RES, "mipmap-anydpi"), exist_ok=True)
with open(os.path.join(RES, "mipmap-anydpi", "ic_launcher.xml"), "w") as f:
    f.write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<adaptive-icon "
        'xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/panel"/>\n'
        '    <foreground android:drawable="@mipmap/ic_launcher"/>\n'
        '    <monochrome android:drawable="@mipmap/ic_launcher"/>\n'
        "</adaptive-icon>\n"
    )
print("favicon-formula icons written")
