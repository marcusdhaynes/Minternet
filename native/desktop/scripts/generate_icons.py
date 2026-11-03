"""Generate Minternet native application icons. Build-time only, not runtime.
The raster icon matches ui/minternet-logo.svg and uses antialiased Pillow drawing.
Run: python native/desktop/scripts/generate_icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri" / "icons"
ICONS.mkdir(parents=True, exist_ok=True)
S = 1024
scale = S / 256
image = Image.new("RGBA", (S, S), (0, 0, 0, 0))
background = Image.new("RGBA", (S, S), (0, 0, 0, 0))
draw_bg = ImageDraw.Draw(background)
for y in range(S):
    t = y / (S - 1)
    # Soft purple gradient: readable even at 16x16 taskbar size.
    start, end = (125, 111, 237), (60, 54, 143)
    tone = tuple(round(a * (1 - t) + b * t) for a, b in zip(start, end))
    draw_bg.line((0, y, S, y), fill=(*tone, 255))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    (int(3*scale), int(3*scale), int(253*scale), int(253*scale)),
    radius=int(57*scale), fill=255
)
background.putalpha(mask)
image.alpha_composite(background)
draw = ImageDraw.Draw(image)
# Geometric M matches the official vector brand: white, high contrast.
m_points = [(35,210),(35,63),(46,51),(58,55),(128,133),
            (198,55),(210,51),(221,63),(221,210),(188,210),
            (188,107),(134,169),(128,175),(121,169),
            (68,107),(68,210)]
draw.polygon([(round(x*scale), round(y*scale)) for x,y in m_points],
             fill=(246, 246, 255, 255))
# Tiny gold star accent identifies the brand without visual clutter.
star = [(207,36),(210.5,46.5),(221,50),(210.5,53.5),
        (207,64),(203.5,53.5),(193,50),(203.5,46.5)]
draw.polygon([(round(x*scale),round(y*scale)) for x,y in star],
             fill=(255,214,170,255))
master = image.resize((256,256), Image.Resampling.LANCZOS)
master.save(ICONS / "icon.png", format="PNG", optimize=True)
master.save(ICONS / "icon.ico", format="ICO",
            sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),
                   (128,128),(256,256)])
print("Generated branded icon.png and icon.ico in", ICONS)
