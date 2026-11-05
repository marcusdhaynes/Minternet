"""Produce transparent, legible jade-rabbit icons from a single master image.

Run from the repository root:
    python native/desktop/scripts/generate_icons.py

The source has occasionally carried an opaque near-black *outer matte*.
Only edge-connected near-black pixels are removed; dark colors within the
rabbit and its universe are preserved. Native sizes are always regenerated.
"""
import json
from collections import deque
import sys
from pathlib import Path
from PIL import Image, ImageEnhance, ImageFilter

PROJECT = Path(__file__).resolve().parents[3]
SOURCE = PROJECT / "ui" / "minternet-brand.png"
DESKTOP = PROJECT / "native" / "desktop" / "src-tauri" / "icons"
ANDROID_RES = PROJECT / "native" / "android" / "app" / "src" / "main" / "res"
IOS_ASSETS = PROJECT / "native" / "ios" / "Assets.xcassets"

if not SOURCE.is_file():
    raise SystemExit(f"Missing Minternet brand artwork: {SOURCE}")
with Image.open(SOURCE) as source:
    artwork = source.convert("RGBA")
if artwork.width != artwork.height or artwork.width < 512:
    raise SystemExit("Brand artwork must be square and at least 512 pixels.")

def remove_outer_black_matte(source):
    """Remove background BLACK attached to the canvas edge, never internal dark art."""
    width, height = source.size
    pixels = source.load()
    erased = bytearray(width * height)
    queued = bytearray(width * height)
    pending = deque()

    def near_black(x, y):
        r, g, b, a = pixels[x, y]
        return a > 0 and max(r, g, b) <= 42 and max(r, g, b) - min(r, g, b) <= 28

    def enqueue(x, y):
        offset = y * width + x
        if not queued[offset] and near_black(x, y):
            queued[offset] = 1
            pending.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        enqueue(x, height - 1)
    for y in range(height):
        enqueue(0, y)
        enqueue(width - 1, y)

    while pending:
        x, y = pending.popleft()
        erased[y * width + x] = 1
        if x > 0:
            enqueue(x - 1, y)
        if x + 1 < width:
            enqueue(x + 1, y)
        if y > 0:
            enqueue(x, y - 1)
        if y + 1 < height:
            enqueue(x, y + 1)

    if not any(erased):
        return source
    fixed = source.copy()
    fixed_pixels = fixed.load()
    for y in range(height):
        for x in range(width):
            if erased[y * width + x]:
                fixed_pixels[x, y] = (0, 0, 0, 0)
    return fixed

artwork = remove_outer_black_matte(artwork)
if "--normalize-source" in sys.argv:
    # Update the canonical PNG as well, so GitHub Pages, favicons and every
    # application surface receive the same genuine RGBA transparency.
    artwork.save(SOURCE, format="PNG", optimize=True)
resample = Image.Resampling.LANCZOS

def icon(size):
    image = artwork.resize((size, size), resample)
    if size <= 48:
        # Mild micro-contrast correction after scaling, no new background/shadow.
        alpha = image.getchannel("A")
        rgb = ImageEnhance.Contrast(image.convert("RGB")).enhance(1.16)
        rgb = rgb.filter(ImageFilter.UnsharpMask(radius=0.55, percent=120, threshold=2))
        image = rgb.convert("RGBA")
        image.putalpha(alpha)
    return image

def png(target, size, opaque=False):
    target.parent.mkdir(parents=True, exist_ok=True)
    image = icon(size)
    if opaque:
        # iOS Home / App Store icons are required to have an opaque background.
        # Use brand-indigo, never the old solid black square.
        backdrop = Image.new("RGBA", image.size, (22, 21, 67, 255))
        backdrop.alpha_composite(image)
        image = backdrop.convert("RGB")
    image.save(target, format="PNG", optimize=True)

DESKTOP.mkdir(parents=True, exist_ok=True)
png(DESKTOP / "icon.png", 1024)
# All Windows shell sizes retain genuine transparency, including 16 / 24 px.
icon(512).save(
    DESKTOP / "icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64),
           (128, 128), (256, 256)],
)
icon(1024).save(DESKTOP / "icon.icns", format="ICNS")

for density, size in [
    ("mdpi", 48), ("hdpi", 72), ("xhdpi", 96),
    ("xxhdpi", 144), ("xxxhdpi", 192)
]:
    folder = ANDROID_RES / ("mipmap-" + density)
    png(folder / "ic_launcher.png", size)
    png(folder / "ic_launcher_round.png", size)

# Modern Android adaptive icon: the artwork stays within launcher mask safe area.
# The background stays transparent, rather than the default opaque black tile.
foreground = ANDROID_RES / "drawable-nodpi" / "minternet_launcher_foreground.png"
foreground.parent.mkdir(parents=True, exist_ok=True)
surface = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
surface.alpha_composite(icon(288), (72, 72))
surface.save(foreground, format="PNG", optimize=True)
adaptive_dir = ANDROID_RES / "mipmap-anydpi-v26"
adaptive_dir.mkdir(parents=True, exist_ok=True)
adaptive = ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '  <background android:drawable="@android:color/transparent" />\n'
            '  <foreground android:drawable="@drawable/minternet_launcher_foreground" />\n'
            '</adaptive-icon>\n')
for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
    (adaptive_dir / name).write_text(adaptive, encoding="utf-8")

appicon = IOS_ASSETS / "AppIcon.appiconset"
png(appicon / "AppIcon-1024.png", 1024, opaque=True)
appicon.joinpath("Contents.json").write_text(
    json.dumps({
        "images": [{"filename": "AppIcon-1024.png",
                    "idiom": "universal", "platform": "ios",
                    "size": "1024x1024"}],
        "info": {"author": "xcode", "version": 1},
    }, indent=2) + "\n", encoding="utf-8"
)
brand = IOS_ASSETS / "Brand.imageset"
png(brand / "brand.png", 256)
brand.joinpath("Contents.json").write_text(
    json.dumps({
        "images": [{"filename": "brand.png", "idiom": "universal"}],
        "info": {"author": "xcode", "version": 1},
    }, indent=2) + "\n", encoding="utf-8"
)
assert icon(32).getpixel((0, 0))[3] == 0, "Icon corner must be transparent"
print("Generated clear Minternet icons (transparent except required opaque iOS launcher).")
