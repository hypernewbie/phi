# Launcher icons from the ACTUAL Phi favicon formula —
# web-src/theme.ts applyPrepaintFavicon: a tile filled with a radial
# gradient accent -> accentDim (default purple 7c6af7/5b4ec2) and a white
# bold Phi glyph centered at 60% height.
#
# Adaptive icons are built as layers, not a baked tile: the gradient is a
# drawable background (the launcher mask rounds it), the foreground is the
# Phi glyph alone on transparency, and the monochrome layer reuses the
# glyph so themed icons tint it instead of flattening a colored tile into
# a blob. Legacy launchers get the fully-composed tile PNGs.
#
# Run: python3 gen-icons.py   (PIL required)
from PIL import Image, ImageDraw
import os

ACCENT = (124, 106, 247, 255)      # #7c6af7
ACCENT_DIM = (91, 78, 194, 255)    # #5b4ec2

RES = "app/src/main/res"
DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
MASTER = 1024


def gradient_tile(size: int) -> Image.Image:
    im = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = cy = MASTER / 2
    for r in range(int(MASTER * 0.72), 0, -4):
        t = r / (MASTER * 0.72)
        color = tuple(int(a + (b - a) * t) for a, b in zip(ACCENT, ACCENT_DIM))
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    mask = Image.new("L", (MASTER, MASTER), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, MASTER, MASTER), radius=MASTER // 4, fill=255
    )
    im.putalpha(mask)
    return im.resize((size, size), Image.LANCZOS)


def glyph_layer(font_path: str, px: int, scale: float, y_center: float) -> Image.Image:
    from PIL import ImageFont

    font = ImageFont.truetype(font_path, int(px * scale))
    layer = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    bbox = d.textbbox((0, 0), "Φ", font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    d.text(
        ((px - w) / 2 - bbox[0], px * y_center - h / 2 - bbox[1]),
        "Φ",
        font=font,
        fill=(255, 255, 255, 255),
    )
    return layer


FONT = "../web/vendor/fonts/JetBrainsMono-Regular.ttf"
if not os.path.exists(FONT):
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
    # legacy: the composed tile (favicon verbatim)
    icon = gradient_tile(px)
    icon.alpha_composite(glyph_layer(FONT, px, 0.62, 0.60))
    icon.save(os.path.join(p, "ic_launcher.png"))
    mask = Image.new("L", (px, px), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, px, px), fill=255)
    circ = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    circ.paste(icon, (0, 0), mask)
    circ.save(os.path.join(p, "ic_launcher_round.png"))
    # adaptive foreground: the glyph alone, inside the safe zone
    glyph_layer(FONT, px, 0.42, 0.58).save(os.path.join(p, "ic_launcher_fg.png"))

os.makedirs(os.path.join(RES, "drawable"), exist_ok=True)
with open(os.path.join(RES, "drawable", "icon_bg.xml"), "w") as f:
    f.write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- theme.ts applyPrepaintFavicon: radial gradient accent ->\n"
        "     accentDim. The launcher mask supplies the shape. -->\n"
        '<shape xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    android:shape="rectangle">\n'
        '    <gradient\n'
        '        android:type="radial"\n'
        '        android:centerX="0.5"\n'
        '        android:centerY="0.5"\n'
        '        android:gradientRadius="108dp"\n'
        '        android:startColor="#7C6AF7"\n'
        '        android:endColor="#5B4EC2" />\n'
        "</shape>\n"
    )

os.makedirs(os.path.join(RES, "mipmap-anydpi"), exist_ok=True)
with open(os.path.join(RES, "mipmap-anydpi", "ic_launcher.xml"), "w") as f:
    f.write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<adaptive-icon "
        'xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@drawable/icon_bg"/>\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_fg"/>\n'
        '    <monochrome android:drawable="@mipmap/ic_launcher_fg"/>\n'
        "</adaptive-icon>\n"
    )
print("adaptive favicon-formula icons written")
