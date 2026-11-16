'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const native=source('native/desktop/src-tauri/src/main.rs');
const transport=source('native/desktop/src-tauri/src/tor_transport.rs');
const cargo=source('native/desktop/src-tauri/Cargo.toml');
const app=source('ui/app.js');
const html=source('ui/index.html');
test('1. Native desktop embeds Arti, not a Tor shell or informational mock',()=>{
 assert.match(cargo,/arti-client\s*=\s*\{/);
 assert.match(native,/mod tor_transport;/);
 assert.match(native,/if name=="tor"\s*\{/);
 assert.match(native,/tor_transport::prepare\(id\)\.await/);
});
test('2. Tor network bootstraps before opening the browser tab',()=>{
 assert.match(transport,/TorClient::create_bootstrapped\(TorClientConfig::default\(\)\)/);
 assert.match(transport,/bootstrap timed out \(no direct browsing fallback\)/);
 assert.match(native,/if let Err\(error\)=tor_transport::prepare\(id\)\.await/);
 assert.match(native,/return Err\(error\)/);
});
test('3. Every Tor tab has its own isolated Tor client and SOCKS listener',()=>{
 assert.match(transport,/client\.isolated_client\(\)/);
 assert.match(transport,/TcpListener::bind\(\("127\.0\.0\.1",0\)\)/);
 assert.match(transport,/struct TabProxy/);
 assert.match(transport,/proxy_url\(id:u32\)/);
});
test('4. SOCKS proxy forwards domain requests using Arti, never host DNS',()=>{
 assert.match(transport,/header\[3\]!=3/);
 assert.match(transport,/client\.connect\(\(domain\.as_str\(\),port\)\)/);
 assert.doesNotMatch(transport,/lookup_host\(|getaddrinfo\(|ToSocketAddrs|std::net::TcpStream::connect/);
});
test('5. A missing Tor listener blocks navigation instead of returning direct routing',()=>{
 assert.match(transport,/Tor proxy not ready: navigation blocked/);
 assert.match(native,/\.proxy_url\(tor_transport::proxy_url\(id\)\?\)/);
 assert.match(native,/if let Err\(error\)=tor_transport::prepare\(id\)\.await/);
});
test('6. Tor browsing is private and has its own WebView data directory',()=>{
 assert.match(native,/let id=b\.add\(true\)\?/);
 assert.match(native,/tab\.tor=true/);
 assert.match(native,/\.incognito\(private\)/);
 assert.match(transport,/tor-ephemeral-profiles/);
 assert.match(native,/if !private && !tor && extensions::any_enabled\(app\)/);
});
test('7. New context-menu and background tabs inherit Tor instead of leaking directly',()=>{
 assert.match(native,/let tor=original\.tor/);
 assert.match(native,/let tor=b\.tabs\.iter\(\)\.find\(\|t\|t\.id==opener\)/);
 assert.match(native,/if tor\{prepare_new_tor_tab\(&app,new_id\)\.await\?;\}/);
 assert.match(native,/if tor\{prepare_new_tor_tab\(&app,id\)\.await\?;\}/);
});
test('8. Tor-linked normal browser windows and auth popups are blocked',()=>{
 assert.match(native,/if source\.is_some_and\(\|tab\|tab\.tor\)/);
 assert.match(native,/if tor\{return NewWindowResponse::Deny;\}/);
 assert.match(native,/if original\.tor\{return Err\("Tor popup blocked/);
});
test('9. Tor does not silently degrade when duplicated or privacy switched',()=>{
 assert.match(native,/browser\.add\(private \|\| tor\)\?/);
 assert.match(native,/if t\.secret_id\.is_some\(\)\|\|t\.tor\{return Err/);
 assert.match(native,/if tab\.secret_id\.is_some\(\)\|\|tab\.tor\{return Err/);
});
test('10. Tor sessions remain excluded from synced and persistent regular sessions',()=>{
 assert.match(native,/filter\(\|t\|!t\.private/);
 assert.match(native,/filter\(\|tab\|!tab\.private/);
 assert.match(native,/if tab\.private\|\|tab\.secret_id\.is_some\(\)/);
});
test('11. Tor mode is clearly labelled and does not fetch favicons directly',()=>{
 assert.match(html,/Open New Tor Tab \(Tor-routed; not Tor Browser\)/);
 assert.match(app,/if\(tab\.tor && \/\^https\?/);
 assert.match(app,/tab-tor-mark/);
 assert.match(app,/Tor-routed tab; not equivalent to Tor Browser/);
});
test('12. Tor microphone and camera access are denied while ordinary sites retain native prompts',()=>{
 assert.match(native,/PermissionKind::Microphone \| PermissionKind::Camera if tor/);
 assert.match(native,/PermissionKind::Microphone \| PermissionKind::Camera =>/);
});

test('13. Native bookmark icon helpers reject onion-site URLs and Tor-active bypass',()=>{
 assert.match(native,/host\.ends_with\("\.onion"\)/);
 assert.match(native,/if tor_active\{return Err\("Direct icon lookups are blocked while Tor is active"/);
 assert.match(native,/if tor_active\{return Err\("Direct site metadata lookups are blocked while Tor is active"/);
});
test('14. Bookmark bar avoids chrome-origin icon requests while Tor is active',()=>{
 const bar=source('ui/bookmark-ui.js');
 assert.match(bar,/if\(torBookmarkMode\)return Promise\.resolve\(\[\]\)/);
 assert.match(bar,/if\(torBookmarkMode\)return;/);
 assert.match(bar,/pendingIconRequests\.clear\(\)/);
 assert.match(bar,/if\(torBookmarkMode&&!thumbs\.has\(value\)\)/);
});

test('15. Tor rejects direct loopback and local top-level requests',()=>{
 assert.match(transport,/pub fn safe_top_level\(url:&tauri::Url\)/);
 assert.match(native,/if tor && matches!\(url\.scheme\(\),"http"\|"https"\)/);
 assert.match(native,/!tor_transport::safe_top_level\(&url\)/);
 assert.match(native,/tor_transport::proxy_url\(id\)\?;/);
});
test('16. The WebView2 Tor proxy explicitly removes Chromium implicit loopback bypass',()=>{
 assert.match(native,/--proxy-server=\{\}/);
 assert.match(native,/--proxy-bypass-list=<-loopback>/);
 assert.match(native,/force-webrtc-ip-handling-policy=disable_non_proxied_udp/);
});
test('17. Tor tabs use process-specific ephemeral WebView profiles',()=>{
 assert.match(transport,/static SESSION_TAG:/);
 assert.match(transport,/OsRng\.fill_bytes\(&mut random\)/);
 assert.match(transport,/join\(format!\("session-\{\}",session_tag\(\)\)\)/);
 assert.match(transport,/cleanup_profile\(app,id\)/);
});
test('18. Closing Tor tab disconnects streams and best-effort cleans the profile',()=>{
 assert.match(transport,/proxy\.shutdown\.send\(true\)/);
 assert.match(transport,/session_shutdown\.changed\(\)\.await/);
 assert.match(transport,/remove_dir_all\(&path\)/);
});
test('19. Tor document-start script disables potentially identifying WebRTC and privileged APIs',()=>{
 assert.match(native,/tor-site-hardening\.js/);
 const script=source('ui/tor-site-hardening.js');
 assert.match(script,/RTCPeerConnection/);
 assert.match(script,/getUserMedia/);
 assert.match(script,/getDisplayMedia/);
});

test('20. New Tor identity closes previous Tor views and circuits without touching normal tabs',()=>{
 assert.match(native,/if name=="tor-new-identity"/);
 assert.match(native,/browser\.tabs\.retain\(\|tab\|!tab\.tor\)/);
 assert.match(native,/for id in &ids\{tor_transport::release\(&app,\*id\);\}/);
 assert.match(native,/prepare_new_tor_tab\(&app,new_id\)\.await/);
});
test('21. New identity and fresh-tab actions are available from custom Tor menu',()=>{
 assert.match(app,/torButton\.addEventListener\('contextmenu'/);
 assert.match(app,/New Identity · Close All Tor Tabs/);
 assert.match(app,/Open Site in Fresh Tor Tab/);
 assert.match(app,/torMenu\.setAttribute\('role','menu'\)/);
});

test('22. Tor readiness reports current bootstrap condition, not merely a cached client',()=>{
 assert.match(transport,/client\.bootstrap_status\(\)/);
 assert.match(transport,/status\.ready_for_traffic\(\)/);
 assert.match(transport,/bootstrapProgressPercent/);
 assert.doesNotMatch(transport,/"bootstrapped":CLIENT\.get\(\)\.is_some\(\)/);
});
test('23. Ordinary tab closes do not spawn Tor profile cleanup threads',()=>{
 assert.match(transport,/if removed\{cleanup_profile\(app,id\);\}/);
});

test('24. Onion destinations cannot navigate through ordinary system DNS',()=>{
 assert.match(native,/Onion addresses require an isolated Tor tab/);
 assert.match(native,/if !tor && url\.host_str\(\)\.is_some_and/);
});
test('25. Bare onion URLs default to HTTP only inside Tor and can be duplicated',()=>{
 assert.match(native,/let is_bare_onion=active_is_tor/);
 assert.match(native,/format!\("http:\/\/\{onion\}"\)/);
 assert.match(native,/tor && parsed\.scheme\(\)=="http"/);
});
