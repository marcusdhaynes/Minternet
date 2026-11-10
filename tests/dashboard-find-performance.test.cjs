'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('Dashboard is the default zero-website-processor new-tab state',()=>{
  const native=read('native/desktop/src-tauri/src/main.rs');
  const html=read('ui/index.html');
  assert.match(native,/fn default_new_tab_mode\(\)->String\{"dashboard"\.into\(\)\}/);
  assert.match(native,/new_tab_mode:String/);
  assert.match(native,/browser-new-tab-mode-set/);
  assert.match(native,/if new_tab_is_dashboard\(&app\) \{/);
  assert.match(native,/display_active\(&app\);/);
  assert.match(native,/b\.active_id=0; \/\/ Keep loaded\/suspended remaining tabs untouched/);
  assert.match(native,/b\.active_id=0;\s*\}/);
  assert.match(html,/id="dashboardGrid"/);
  assert.match(html,/id="newTabMode"/);
  assert.match(html,/id="dashboardSnap"/);
  assert.doesNotMatch(html.slice(html.indexOf('<main id="homeScreen"'),html.indexOf('</main>')),/<iframe|<video|<canvas/i);
});

test('Dashboard grid snap preferences use separate tiny local storage',()=>{
  const script=read('ui/dashboard.js');
  new vm.Script(script);
  const values=new Map();
  const listeners={};
  const nodes={
    dashboardGrid:{style:{setProperty:(name,value)=>values.set(name,value)}},
    dashboardGridSpacing:{value:'24',addEventListener:(event,fn)=>{listeners['spacing:'+event]=fn;}},
    dashboardSnap:{checked:true,addEventListener:(event,fn)=>{listeners['snap:'+event]=fn;}},
    dashboardStatus:{textContent:''},
  };
  const stored=new Map();
  const w={};
  vm.runInNewContext(script,{
    window:w,document:{getElementById:id=>nodes[id]},
    localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)},
    Math,Number,JSON,String
  });
  assert.equal(values.get('--dashboard-grid-spacing'),'24px');
  assert.equal(w.minternetDashboard.snap(27,43).x,24);
  nodes.dashboardGridSpacing.value='40';
  listeners['spacing:change']();
  assert.equal(w.minternetDashboard.snap(27,43).x,40);
  assert.equal(JSON.parse(stored.get('minternet.dashboard.grid.v1')).spacing,40);
});

test('New Tab address survives stale homepage WebView2 notifications',()=>{
  const chrome=read('ui/app.js');
  const native=read('native/desktop/src-tauri/src/main.rs');
  assert.match(chrome,/pendingNavigation=\{text:typed/);
  assert.match(chrome,/pendingNavigation\?\.text/);
  assert.match(native,/pending_previous_url:Option<String>/);
  assert.match(native,/if stale\{return;\}/);
  assert.match(native,/tab\.pending_previous_url\.as_deref\(\)==Some\(url\)/);
  assert.match(chrome,/if\s*\(!addressFocused\) byId\('address'\)\.value/);
});

test('Find bar is below Bookmarks without occupying full-page overlay',()=>{
  const html=read('ui/index.html');
  const css=read('ui/styles.css');
  const script=read('ui/find-page.js');
  const native=read('native/desktop/src-tauri/src/main.rs');
  assert.ok(html.indexOf('id="findBar"')>html.indexOf('id="bookmarkBar"'));
  for(const id of ['findBar','findQuery','findResult','findNext','findPrevious','findClose'])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(native,/FIND_BAR: f64 = 22\.0/);
  assert.match(native,/find_visible\(app\)/);
  assert.match(native,/window\.find\(/);
  assert.match(native,/minternet:find-open/);
  assert.match(css,/:root\.has-bookmarks\.find-open/);
  new vm.Script(script);
});

test('Bookmarks and encrypted Logins searchable by website and username',()=>{
  const html=read('ui/index.html');
  const bookmark=read('ui/bookmark-ui.js');
  const logins=read('ui/password-ui.js');
  const labels=read('ui/site-names.js');
  const w={};
  vm.runInNewContext(labels,{window:w,URL});
  assert.equal(w.MinternetSiteNames.label('https://www.github.com/login'),'GitHub');
  assert.equal(w.MinternetSiteNames.label('https://accounts.google.com/signin'),'Google');
  assert.equal(w.MinternetSiteNames.label('https://example.co.uk/'),'Example');
  assert.match(html,/id="bookmarkManagerSearch"/);
  assert.match(html,/id="vaultSearch"/);
  assert.match(bookmark,/const matched=new Set\(\)/);
  assert.match(bookmark,/matched\.has\(item\.id\)/);
  assert.match(logins,/entry\.origin,entry\.username/);
  assert.match(logins,/window\.MinternetSiteNames\?\.label\(entry\.origin\)/);
  assert.doesNotMatch(logins,/localStorage\.setItem/);
});

test('Tab DOM is keyed, not rebuilt for every small state change',()=>{
  const groups=read('ui/tab-group-ui.js');
  assert.match(groups,/const reusedTabs=new Map\(\)/);
  assert.match(groups,/const takeTab=\(tab,active\)=>/);
  assert.match(groups,/if\(!cache\|\|cache\.signature!==signature\)/);
  assert.match(groups,/items\.push\(takeTab\(tab,tab\.id===data\.activeId\)\)/);
  assert.match(groups,/if\(!surviving\.has\(id\)\)reusedTabs\.delete\(id\)/);
});

test('Release archives recover legacy drafts without depending on draft tag lookup',()=>{
  const workflow=read('.github/workflows/publish-current-portable.yml');
  assert.match(workflow,/matching_draft=.*draft==true/);
  assert.match(workflow,/releases\/\$draft_id" -F draft=false/);
  assert.match(workflow,/gh release create "\$TAG"/);
  assert.doesNotMatch(workflow,/--draft --prerelease/);
  assert.match(workflow,/test "\$published_sha" = "\$SHA"/);
  assert.match(workflow,/test "\$remote_size" = "\$\(stat -c%s "\$file"\)"/);
});

test('Keyed tab UI refreshes loading and secret status without quadratic slot scans',()=>{
  const groups=read('ui/tab-group-ui.js');
  assert.match(groups,/tab\.suspended,tab\.loading/);
  assert.match(groups,/t\.secretTab,t\.secretPending,t\.syncId/);
  assert.match(groups,/const positions=new Map\(normal\.map/);
  assert.match(groups,/Object\.assign\(stored,savedTabSlots\(data\.tabs\)\)/);
  assert.doesNotMatch(groups,/state\.order\.map\(id=>data\.tabs\.filter/);
});

test('compact Find, toolbar order, and branded new tabs',()=>{
  const html=read('ui/index.html'),css=read('ui/styles.css'),app=read('ui/app.js');
  assert.doesNotMatch(html,/<span class="find-bar-label">/);
  assert.match(css,/:root\.find-open\{--chrome-height:74px;/);
  assert.match(css,/\.find-bar\{[^}]*height:22px/);
  assert.match(css,/\.tab-row > \.new-private-tab\{order:3;/);
  assert.match(css,/\.tab-row > \.dashboard-tab-button\{order:4;/);
  assert.match(app,/image\.src='\.\/minternet-brand\.png'/);
  assert.match(css,/\.address-wrap\{flex:1 1 auto!important/);
});

test('reject site downloads until explicit trusted Windows approval and block popunders',()=>{
  const native=read('native/desktop/src-tauri/src/main.rs');
  const shield=read('native/desktop/src-tauri/src/privacy_shield.rs');
  assert.match(native,/if !explicit_download_approval\(id,&url,&path\)/);
  assert.match(native,/MB_YESNO\|MB_ICONWARNING\|MB_DEFBUTTON2/);
  assert.match(native,/fn is_disguised_executable/);
  assert.match(native,/if is_disguised_executable\(std::path::Path::new\(&entry\.path\)\)/);
  assert.match(native,/DownloadEvent::Requested\{\.\.\}=>false/);
  assert.match(shield,/An about:blank popunder can redirect/);
  assert.match(shield,/Cross-site popups are denied by default/);
});

test('official extension catalogs are browsable without misleading install claims',()=>{
  const html=read('ui/index.html'),prefs=read('ui/browser-settings.js');
  assert.match(html,/id="chromeExtensionStore"/);
  assert.match(html,/id="firefoxExtensionStore"/);
  assert.match(prefs,/https:\/\/chromewebstore\.google\.com\//);
  assert.match(prefs,/https:\/\/addons\.mozilla\.org\/en-US\/firefox\//);
});

test('unknown OAuth-looking popup URLs cannot bypass cross-site blocker',()=>{
 const native=read('native/desktop/src-tauri/src/main.rs');
 assert.match(native,/fn trusted_auth_destination/);
 assert.match(native,/ads\.example\/oauth\/authorize/);
 assert.match(native,/intentional_new_tab_shortcut/);
 assert.match(native,/trusted_auth_destination\(&url\)\|\|same_origin_auth/);
});
