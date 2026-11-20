'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const read=name=>readFileSync(join(__dirname,'..',name),'utf8');
const pipelines=[
  '.github/workflows/pages.yml',
  '.github/workflows/native-windows.yml',
  '.github/workflows/native-unix.yml',
  '.github/workflows/native-android.yml',
  '.github/workflows/native-ios.yml',
  '.github/workflows/android-emulator.yml'
];
test('every main push triggers Web, Windows, macOS, Linux, Android, and iOS workflows',()=>{
  for(const name of pipelines){
    const src=read(name);
    assert.match(src,/push:\s*\n\s*branches:\s*\[main\]/,name+' missing main push');
    const trigger=src.split('permissions:')[0];
    assert.doesNotMatch(trigger,/^\s+paths:/m,name+' is silently skipping unrelated commits');
  }
});
test('Windows finishes active builds, coalesces pending commits and prevents release regression',()=>{
  const src=read('.github/workflows/native-windows.yml');
  // A running compile must complete so rapid pushes cannot starve releases.
  // Only the most recent pending commit competes for the next build.
  assert.match(src,/group: minternet-windows-\$\{\{ github\.ref \}\}/);
  assert.match(src,/cancel-in-progress: false/);
  assert.match(src,/cache-on-failure: true/);
  assert.match(src,/\$latestFlag.*'--latest=false'/);
  assert.match(src,/releases\/tags\/\$tag/);
});
test('every platform has a commit-addressable artifact or deployment',()=>{
  const web=read('.github/workflows/pages.yml');
  assert.match(web,/minternet-web-preview-\$\{\{ github\.sha \}\}/);
  assert.match(web,/site\/build-info\.json/);
  assert.match(web,/cp -a ui\/\. site\//);
  const unix=read('.github/workflows/native-unix.yml');
  assert.match(unix,/minternet-native-\$\{\{ matrix\.label \}\}-\$\{\{ github\.sha \}\}/);
  const android=read('.github/workflows/native-android.yml');
  assert.match(android,/minternet-android-debug-apk-\$\{\{ github\.sha \}\}/);
  const ios=read('.github/workflows/native-ios.yml');
  assert.match(ios,/minternet-ios-simulator-\$\{\{ github\.sha \}\}/);
  assert.match(ios,/minternet-ios-device-unsigned-\$\{\{ github\.sha \}\}/);
});
test('mobile versions are based on the shared Minternet version and CI build',()=>{
  const android=read('native/android/app/build.gradle');
  assert.match(android,/desktop\/src-tauri\/tauri\.conf\.json/);
  assert.match(android,/versionCode buildNumber/);
  assert.match(android,/versionName/);
  const ios=read('.github/workflows/native-ios.yml');
  assert.match(ios,/MINTERNET_BASE_VERSION/);
  assert.match(ios,/CURRENT_PROJECT_VERSION=\$GITHUB_RUN_NUMBER/);
  assert.match(ios,/CODE_SIGNING_ALLOWED=NO build/);
});
test('GitHub Releases archives include all platform artifacts without impersonating installable iPhone IPA',()=>{
  const archive=read('.github/workflows/publish-current-portable.yml');
  assert.match(archive,/Publish Minternet UI preview/);
  assert.match(archive,/Web-Preview:minternet-web-preview-\*/);
  assert.match(archive,/Android:minternet-android-debug-apk-\*/);
  assert.match(archive,/iOS-Simulator:minternet-ios-device-unsigned-\*/);
  const ios=read('.github/workflows/native-ios.yml');
  assert.match(ios,/not directly installable/);
});
