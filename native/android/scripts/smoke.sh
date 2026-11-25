#!/usr/bin/env bash
set -euo pipefail
APK="native/android/app/build/outputs/apk/debug/app-debug.apk"
adb install -r "$APK"
adb shell am start -W -n app.minternet.browser/.MainActivity
# Chrome is a real WebView; UIAutomator's accessibility tree may omit its
# virtual DOM nodes. Debug-only DevTools drives the actual packaged frontend.
python3 native/android/scripts/shared-chrome-smoke.py
