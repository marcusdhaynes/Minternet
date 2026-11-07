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
  assert.match(native,/url\.scheme\(\)=="data"/);
  assert.match(native,/DownloadEvent::Requested/);
  assert.match(native,/download_path\(&for_download,&url,destination\.as_path\(\)\)/);
  assert.match(native,/downloads-folder-set/);
  assert.match(native,/allowed_download_folders\(/);
});
test('homepage and Downloads Folder are editable in Settings',()=>{
  for(const id of ['homePageUrl','homePageSave','downloadFolderPath',
    'downloadFolderSave','downloadFolderDefault','browserPreferencesStatus']){
    assert.match(index,new RegExp('id="'+id+'"'));
  }
});
test('browser preference UI persists only through the native settings bridge',async()=>{
  const js=read('ui/browser-settings.js');
  const ids=['homePageUrl','homePageSave','downloadFolderPath',
    'downloadFolderSave','downloadFolderDefault','browserPreferencesStatus'];
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
          downloadFolder:'C:\\Users\\example\\Downloads',usingSystemDownloads:true};
        if(name==='browser-homepage-set')return {ok:true,homepage:value};
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
