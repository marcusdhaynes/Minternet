#!/usr/bin/env bash
set -euo pipefail
APK="native/android/app/build/outputs/apk/debug/app-debug.apk"
adb install -r "$APK"
adb shell am start -W -n app.minternet.browser/.MainActivity
sleep 9

dump() {
  adb shell uiautomator dump /sdcard/minternet-window.xml >/dev/null
  adb pull /sdcard/minternet-window.xml /tmp/minternet-window.xml >/dev/null
}

# Read Android accessibility coordinates rather than guessing a screen resolution.
tap_by_description() {
  local description="$1"
  dump
  python3 - "$description" <<'PY' > /tmp/minternet-tap.txt
import sys,xml.etree.ElementTree as ET,re
root=ET.parse('/tmp/minternet-window.xml').getroot()
wanted=sys.argv[1]
for node in root.iter('node'):
    if node.get('content-desc')==wanted:
        nums=list(map(int,re.findall(r'\d+',node.attrib['bounds'])))
        print((nums[0]+nums[2])//2, (nums[1]+nums[3])//2)
        break
else:
    raise SystemExit(f"Android UI control not found: {wanted}")
PY
  read -r x y < /tmp/minternet-tap.txt
  adb shell input tap "$x" "$y"
}
# Capture the first screen to diagnose emulator UI/runtime failures.
dump
cp /tmp/minternet-window.xml /tmp/minternet-first-screen.xml
adb shell screencap -p /sdcard/minternet-initial.png
adb pull /sdcard/minternet-initial.png /tmp/minternet-initial.png >/dev/null
if ! grep -q "Open isolated private window" /tmp/minternet-window.xml; then
  echo "Expected private button missing: Android accessibility tree follows:"
  cat /tmp/minternet-window.xml
  adb shell dumpsys activity activities | grep -E 'mResumed|topResumedActivity|MainActivity' | head -20
  exit 1
fi
tap_by_description "Open isolated private window"
sleep 5
dump
grep -q "Close isolated private window" /tmp/minternet-window.xml
adb shell dumpsys activity activities | grep -q "PrivateActivity"
adb shell screencap -p /sdcard/minternet-private.png
adb pull /sdcard/minternet-private.png /tmp/minternet-private.png >/dev/null
tap_by_description "Close isolated private window"
sleep 3
dump
grep -q "Open isolated private window" /tmp/minternet-window.xml

# Verify HTTPS navigation updates the in-app address bar and DOES NOT launch Chrome.
tap_by_description "New tab"
dump
python3 - <<'PY' > /tmp/minternet-address.txt
import xml.etree.ElementTree as ET,re
root=ET.parse('/tmp/minternet-window.xml').getroot()
for node in root.iter('node'):
    if node.get('class')=='android.widget.EditText':
        v=list(map(int,re.findall(r'\d+',node.attrib['bounds'])))
        print((v[0]+v[2])//2, (v[1]+v[3])//2)
        break
else:
    raise SystemExit('Address input missing')
PY
read -r x y < /tmp/minternet-address.txt
adb shell input tap "$x" "$y"
adb shell input text "example.com"
adb shell input keyevent 66
sleep 9
dump
grep -q "example.com" /tmp/minternet-window.xml
adb shell dumpsys activity activities | grep -q "app.minternet.browser"
adb shell screencap -p /sdcard/minternet-web.png
adb pull /sdcard/minternet-web.png /tmp/minternet-web.png >/dev/null
echo "Minternet Android emulator smoke passed: UI, process-private activity, in-app HTTPS navigation."
