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
 assert.match(native,/tor-ephemeral-profiles/);
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
