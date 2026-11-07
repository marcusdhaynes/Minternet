#!/usr/bin/env python3
"""Minternet source-level security invariants. Not a penetration test or independent audit."""
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[1]
def read(p):
    data=(ROOT/p).read_text(encoding="utf-8")
    assert data.strip(),f"Empty security-sensitive file: {p}"
    return data
def require(text,marker,what):
    assert marker in text, f"Security invariant missing: {what}"
windows=read("native/desktop/src-tauri/src/main.rs")
android=read("native/android/app/src/main/java/app/minternet/browser/MainActivity.java")
manifest=read("native/android/app/src/main/AndroidManifest.xml")
private=read("native/android/app/src/main/java/app/minternet/browser/PrivateActivity.java")
ios=read("native/ios/Sources/MinternetApp.swift")
config=json.loads(read("native/desktop/src-tauri/tauri.conf.json"))
cap=json.loads(read("native/desktop/src-tauri/capabilities/default.json"))

require(windows, 'if matches!(url.scheme(), "https"|"http")', "Desktop permits only normal HTTP(S) site navigation")
require(windows, 'url.host_str().is_some()', "Desktop requires a host for normal page URLs")
require(windows, 'url.scheme()=="blob"', "Desktop recognizes provenance-checked blob URLs")
require(windows, 'download_source_allowed(&for_navigation,id,&url)', "Desktop only permits bound blob navigation")
require(windows, '.on_permission_request(|_view, _kind| PermissionResponse::Deny)', "Desktop default deny permissions")
require(windows, '.incognito(private)', "Desktop private webview profile")
require(windows, "NewWindowResponse::Deny", "Desktop external popup interception")
assert cap["local"] is True and cap["webviews"]==["chrome"], "Privileged Tauri API not exclusive to local chrome webview"
assert "remote" not in cap, "No remote webview may receive native privileges"
assert "frame-src 'none'" in config["app"]["security"]["csp"],"Local chrome CSP must prohibit iframes"

for marker in (
    "s.setAllowFileAccess(false)", "s.setAllowContentAccess(false)",
    "s.setAllowFileAccessFromFileURLs(false)",
    "s.setAllowUniversalAccessFromFileURLs(false)",
    "s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW)",
    "s.setSafeBrowsingEnabled(true)", "request.deny()",
    "handler.cancel()", "WebView.setWebContentsDebuggingEnabled(false)",
    "WebView.setDataDirectorySuffix",
):
    require(android,marker,"Android hardened WebView: "+marker)
assert "addJavascriptInterface" not in android,"Native JavaScript bridges must undergo review before use"
assert 'android:usesCleartextTraffic="false"' in manifest, "Android disallows cleartext transport"
assert 'android:allowBackup="false"' in manifest, "Android browser data should not be backed up by default"
assert 'android:exported="false"' in manifest and 'android:process=":minternet_private"' in manifest, "Private process must be non-exported and separate"
require(private,"extends MainActivity","Android private process entrypoint")
require(ios,".nonPersistent()", "iOS ephemeral WKWebsiteDataStore")
require(ios,'scheme != "https"', "iOS HTTPS-only main-frame nav")
require(ios,"javaScriptCanOpenWindowsAutomatically = false","iOS popup safety")
assert "NSAllowsArbitraryLoads" not in read("native/ios/project.yml"), "iOS must not disable ATS wholesale"

print("PASS: Minternet native security invariants checked.")
print("WARNING: Automated source checks are NOT an independent security audit, fuzzing, or runtime leak test.")
