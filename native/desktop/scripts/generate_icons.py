"""Generate consistent Minternet jade-rabbit icons for all supported platforms.

The transparent artwork in ui/minternet-brand.png is the single source of
truth. Run before native packaging to generate each platform's required files.

Run from repository root: python native/desktop/scripts/generate_icons.py
"""
import json
from pathlib import Path
from PIL import Image

PROJECT = Path(__file__).resolve().parents[3]
SOURCE = PROJECT / "ui" / "minternet-brand.png"
DESKTOP = PROJECT / "native" / "desktop" / "src-tauri" / "icons"
ANDROID_RES = PROJECT / "native" / "android" / "app" / "src" / "main" / "res"
IOS_ASSETS = PROJECT / "native" / "ios" / "Assets.xcassets"

if not SOURCE.is_file():
    raise SystemExit(f"Missing Minternet brand artwork: {SOURCE}")
with Image.open(SOURCE) as file:
    artwork = file.convert("RGBA")

if artwork.width != artwork.height or artwork.width < 512:
    raise SystemExit("Brand artwork must be square and at least 512 pixels.")
resample = Image.Resampling.LANCZOS

def icon(size):
    return artwork.resize((size, size), resample)

def png(target, size, opaque=False):
    target.parent.mkdir(parents=True, exist_ok=True)
    image = icon(size)
    if opaque:
        # App Store icons cannot have alpha; Apple adds the rounded system mask.
        backdrop = Image.new("RGBA", image.size, (9, 13, 25, 255))
        backdrop.alpha_composite(image)
        image = backdrop.convert("RGB")
    image.save(target, format="PNG", optimize=True)

# Native Windows executable / taskbar, macOS dock, and Linux launcher.
DESKTOP.mkdir(parents=True, exist_ok=True)
png(DESKTOP / "icon.png", 1024)
icon(512).save(
    DESKTOP / "icon.ico", format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64),
           (128, 128), (256, 256)],
)
icon(1024).save(DESKTOP / "icon.icns", format="ICNS")

# Android launcher densities; same branding also appears in the native UI.
for density, size in [
    ("mdpi", 48), ("hdpi", 72), ("xhdpi", 96),
    ("xxhdpi", 144), ("xxxhdpi", 192)
]:
    folder = ANDROID_RES / ("mipmap-" + density)
    png(folder / "ic_launcher.png", size)
    png(folder / "ic_launcher_round.png", size)

# iOS 16+ asset catalog. Apple requires an opaque App Store / home icon.
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
print("Generated Minternet jade-rabbit desktop, Android and iOS icons.")
