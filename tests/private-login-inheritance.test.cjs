'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const rust=read('native/desktop/src-tauri/src/main.rs');
const html=read('ui/index.html');
const settings=read('ui/browser-settings.js');
const categories=read('ui/settings-sections.js');

test('new preference retains existing saved profiles and defaults login sharing on',()=>{
 assert.match(rust,/\#\[serde\(default="default_private_login_sharing"\)\]/);
 assert.match(rust,/fn default_private_login_sharing\(\)->bool\{true\}/);
 assert.match(rust,/private_login_sharing:default_private_login_sharing\(\)/);
 assert.match(rust,/"privateLoginSharing":private_login_sharing/);
 assert.match(rust,/"private-login-sharing-set" => \{/);
 assert.match(rust,/persist_preferences\(&app,&updated\)\?/);
});

test('Private login sharing is a real persisted toggle in Privacy settings',()=>{
 assert.match(html,/id="privateLoginSettings"/);
 assert.match(html,/id="privateLoginSharing" checked/);
 assert.match(settings,/privateLoginSharing\.checked=settings\.privateLoginSharing!==false/);
 assert.match(settings,/invoke\('private-login-sharing-set',enabled\)/);
 assert.match(categories,/const privacy=section\('Privacy & History'\)/);
 assert.match(categories,/move\(privacy,'privateLoginSettings'\)/);
});

test('new private HTTPS navigation imports normal cookies before page loads',()=>{
 const marker=rust.indexOf('fn defer_private_first_navigation(');
 const end=rust.indexOf('fn navigate_tab(',marker);
 const seed=rust.slice(marker,end);
 assert.ok(marker>0&&end>marker);
 assert.match(seed,/tab\.private&&\s*!tab\.tor&&tab\.secret_id\.is_none\(\)/);
 assert.match(seed,/!tab\.private&&!tab\.tor&&tab\.secret_id\.is_none\(\)/);
 assert.match(seed,/get_webview\("chrome"\)/);
 assert.match(seed,/create_webview\(app,id,WebviewUrl::App\("warmup\.html"\.into\(\)\),true\)\?/);
 assert.match(seed,/std::thread::spawn\(move\|\|\{/);
 assert.match(seed,/source\.cookies\(\)/);
 assert.match(seed,/private_view\.set_cookie\(cookie\)/);
 assert.match(seed,/run_on_main_thread\(move\|\|\{/);
 assert.match(seed,/view\.navigate\(url\)/);
 const nav=rust.slice(end,rust.indexOf('fn focus_address_bar(',end));
 assert.ok(nav.indexOf('defer_private_first_navigation(app,id,&url,existing_view.clone())?')<
   nav.indexOf('view.navigate(url)'));
 assert.match(rust,/defer_private_first_navigation\(app,id,&target,Some\(view\.clone\(\)\)\)\?/);
});

test('Private tabs stay isolated; history, Tor and secret tabs stay protected',()=>{
 assert.match(rust,/\.incognito\(private\)/);
 assert.match(rust,/if tab\.private\|\|tab\.secret_id\.is_some\(\)\{return;\}/);
 assert.match(rust,/tab\.private&&\s*!tab\.tor&&tab\.secret_id\.is_none\(\)/);
 assert.match(rust,/private_login_sharing_enabled\(&owner\)/);
 assert.doesNotMatch(rust.slice(rust.indexOf('fn defer_private_first_navigation('),
   rust.indexOf('fn navigate_tab(')),/save_recent_downloads|save_pinned|record_page_history|localStorage|console\.log/);
});
