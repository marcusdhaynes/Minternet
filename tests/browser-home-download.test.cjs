'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const native=read('native/desktop/src-tauri/src/main.rs');
const index=read('ui/index.html');

test('internal warmup URL cannot overwrite a new tab homepage',()=>{
  assert.match(native,/const DEFAULT_HOMEPAGE: &str = "https:\/\/www\.google\.com\/"/);
  assert.match(native,/fn is_real_page_url\(/);
  assert.match(native,/actual\.path\(\)=="\/warmup\.html"/);
  assert.match(native,/if !is_real_page_url\(url\)\{return;\}/);
  assert.match(native,/name=="new" \|\| name=="new-private"/);
  assert.match(native,/Some\(homepage\(&app\)\)/);
  assert.match(native,/tab\.url==HOME&&tab\.secret_id\.is_none\(\)/);
});
test('all browser downloads honor a configurable trusted destination',()=>{
  assert.match(native,/fn configured_download_folder\(/);
  assert.match(native,/let dir=configured_download_folder\(app\)\?/);
  assert.match(native,/fn download_source_allowed\(/);
  assert.match(native,/url\.scheme\(\)=="blob"/);
  assert.match(native,/address && matches!\(url\.scheme\(\),"blob"\|"data"\)/);
  assert.match(native,/DownloadEvent::Requested/);
  assert.match(native,/download_destination\(&for_download,&url,destination\.as_path\(\)\)/);
  assert.match(native,/downloads-folder-set/);
  assert.match(native,/allowed_download_folders\(/);
});
test('homepage and Downloads Folder are editable in Settings',()=>{
  for(const id of ['homePageUrl','homePageSave','downloadFolderPath',
    'downloadFolderSave','downloadFolderDefault','browserPreferencesStatus','tabLimit','tabLimitSave']){
    assert.match(index,new RegExp('id="'+id+'"'));
  }
});
test('browser preference UI persists only through the native settings bridge',async()=>{
  const js=read('ui/browser-settings.js');
  const ids=['homePageUrl','homePageSave','downloadFolderPath',
    'downloadFolderSave','downloadFolderDefault','browserPreferencesStatus','tabLimit','tabLimitSave'];
  const elements=Object.fromEntries(ids.map(id=>[id,{
    value:'',disabled:false,hidden:false,placeholder:'',textContent:'',
    events:{},addEventListener(k,fn){this.events[k]=fn;},dispatch(k){this.events[k]?.({key:k,preventDefault(){}})}
  }]));
  const events=[];
  const window={
    __TAURI__:{},
    minternet:{
      async command(name,value){
        events.push([name,value]);
        if(name==='browser-preferences')return {homepage:'https://www.google.com/',
          downloadFolder:'C:\\Users\\example\\Downloads',usingSystemDownloads:true,tabLimit:0};
        if(name==='browser-homepage-set')return {ok:true,homepage:value};
        if(name==='tab-limit-set')return {ok:true,tabLimit:value};
        if(name==='downloads-folder-set')return {ok:true,downloadFolder:
          value||'C:\\Users\\example\\Downloads',usingSystemDownloads:!value};
        return {message:'Unexpected command'};
      }
    },
    minternetToast(){}
  };
  vm.runInNewContext(js,{window,document:{getElementById:id=>elements[id]}});
  for(let i=0;i<5;i++)await Promise.resolve();
  assert.equal(elements.homePageUrl.value,'https://www.google.com/');
  assert.equal(elements.tabLimit.value,'0');
  elements.tabLimit.value='55';
  elements.tabLimitSave.dispatch('click');
  for(let i=0;i<8;i++)await Promise.resolve();
  assert(events.some(([name,value])=>name==='tab-limit-set'&&value===55));
  elements.tabLimit.value='0';
  elements.tabLimitSave.dispatch('click');
  for(let i=0;i<8;i++)await Promise.resolve();
  assert(events.some(([name,value])=>name==='tab-limit-set'&&value===0));
  elements.homePageUrl.value='example.org/home';
  elements.homePageSave.dispatch('click');
  for(let i=0;i<8;i++)await Promise.resolve();
  assert(events.some(([name,value])=>
    name==='browser-homepage-set'&&value==='https://example.org/home'));
  elements.downloadFolderPath.value='C:\\Files';
  elements.downloadFolderSave.dispatch('click');
  for(let i=0;i<8;i++)await Promise.resolve();
  assert(events.some(([name,value])=>name==='downloads-folder-set'&&value==='C:\\Files'));
  elements.downloadFolderDefault.dispatch('click');
  for(let i=0;i<8;i++)await Promise.resolve();
  assert(events.some(([name,value])=>name==='downloads-folder-set'&&value===''));
});

test('Download Location offers automatic and Save As without custom approval prompts',()=>{
  const settings=read('ui/browser-settings.js');
  assert.match(index,/id="downloadMode"/);
  assert.match(index,/value="automatic"/);
  assert.match(index,/value="ask"/);
  assert.match(settings,/downloads-mode-set/);
  assert.match(native,/fn default_download_mode\(\)->String/);
  assert.match(native,/fn download_destination\(/);
  assert.match(native,/blocking_save_file\(/);
  assert.match(native,/"downloads-mode-set" =>/);
  assert.doesNotMatch(native,/Minternet — Verify Download/);
  assert.doesNotMatch(native,/explicit_download_approval\(/);
});

test('download links stay in the originating WebView and native failures are visible',()=>{
  const linkBridge=read('ui/site-download-links.js');
  const downloads=read('ui/downloads-ui.js');
  assert.match(native,/initialization_script\(include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/ui\/site-download-links\.js"\)\)/);
  assert.match(linkBridge,/generated\(uri\)/);
  assert.match(linkBridge,/link\.target='_self'/);
  assert.match(linkBridge,/oaiusercontent/);
  assert.match(native,/minternet:download-blocked/);
  assert.match(downloads,/minternet:download-blocked/);
});
test('back and forward use click to navigate and configurable hold to show history',()=>{
  const nav=read('ui/navigation-history-ui.js');
  const settings=read('ui/settings-sections.js');
  assert.match(nav,/api\.command\(side\)/);
  assert.match(nav,/holdSeconds\*1000/);
  assert.match(nav,/void open\(side\)/);
  assert.match(nav,/pointercancel/);
  assert.match(index,/id="navigationHistoryHoldDelay"/);
  assert.match(settings,/move\(tabs,'navigationHistoryHoldDelay'/);
});
test('Maximum Volume sits inside Audio accordion without losing volume preferences',()=>{
  const settings=read('ui/settings-sections.js');
  const volume=read('ui/volume-ui.js');
  assert.match(settings,/move\(audio,'volumeMax'/);
  assert.match(settings,/move\(audio,'volumeIncrement10'/);
  assert.match(settings,/move\(audio,'volumeHoldDelay'/);
  assert.match(volume,/maxSelect=\$\('volumeMax'\)/);
  assert.match(volume,/maxVolume/);
});
test('Settings and context panels close on outside pointer-down or window blur',()=>{
  const bookmarks=read('ui/bookmark-ui.js');
  const secrets=read('ui/secret-bookmarks.js');
  const navigation=read('ui/navigation-history-ui.js');
  for(const code of [bookmarks,secrets]){
    assert.match(code,/document\.addEventListener\('pointerdown'/);
  }
  for(const code of [bookmarks,secrets,navigation,
    read('ui/search-settings.js'),read('ui/downloads-ui.js'),
    read('ui/media-devices-ui.js'),read('ui/chrome-native-menu.js'),
    read('ui/password-ui.js'),read('ui/payment-ui.js'),
    read('ui/identity-ui.js'),read('ui/privacy-shield-ui.js'),
    read('ui/history-ui.js'),read('ui/tab-group-ui.js')]){
    assert.match(code,/window\.addEventListener(?:\?\.)?\('blur'/);
  }
  assert.match(bookmarks,/activePanel\?\.contains\(event\.target\)/);
  assert.match(secrets,/dialog\?\.contains\(event\.target\)/);
});
