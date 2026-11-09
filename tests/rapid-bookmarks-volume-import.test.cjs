'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const bookmark=read('ui/bookmark-ui.js');
const history=read('ui/history-ui.js');
const html=read('ui/index.html');
const native=read('native/desktop/src-tauri/src/main.rs');
const audio=read('ui/audio-gain.js');

test('bookmark-bar folder middle drops move inside and edges reorder outside',()=>{
  assert.match(bookmark,/item\?\.kind==='folder'&&fraction>=0\.25&&fraction<=0\.75/);
  assert.match(bookmark,/parentId:item\.id,inside:true/);
  assert.match(bookmark,/parentId:bar\.parentId\|\|model\.BOOKMARK_BAR_ID/);
  assert.match(bookmark,/model\.moveMany\(data,ids,placement\.parentId,placement\.anchorId,placement\.after\)/);
  assert.match(bookmark,/model\.location\(data,node\.id\)\?\.parent\?\.id/);
});
test('History is settings-only while Ctrl+H and suggestions remain available',()=>{
  assert.doesNotMatch(html,/id="historyButton"/);
  assert.match(html,/id="historyManagerOpen"/);
  assert.match(history,/historyButton=\$\('historyManagerOpen'\)/);
  assert.match(history,/historyButton\.insertAdjacentElement\('afterend',panel\)/);
  assert.match(history,/minternetBookmarks\?\.openSettings\?\.\(\)/);
  assert.match(history,/event\.key\.toLowerCase\(\)==='h'/);
  assert.match(history,/history-search/);
});
test('volume is backed by website gain graph AND native WebView2 mute',()=>{
  assert.match(html,/id="volumeSlider"[^>]+max="300"[^>]+step="1"/);
  assert.match(html,/id="volumeNumber"[^>]+max="300"/);
  assert.match(html,/id="volumeHoldDelay"/);
  assert.match(native,/name=="volume-set"/);
  assert.match(native,/include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/ui\/audio-gain\.js"\)/);
  assert.match(native,/audio\.SetIsMuted\(mute\)/);
  assert.match(native,/apply_volume_to_site\(&for_load,id,view\.label\(\),true\)/);
  assert.match(audio,/createMediaElementSource\(media\)/);
  assert.match(audio,/createGain\(\)/);
  assert.match(audio,/state\.level=n/);
  assert.match(audio,/gain\.gain\.value=state\.level/);
  assert.match(audio,/url\.origin===location\.origin \|\| Boolean\(media\.crossOrigin\)/);
});

function importHarness(){
  const elements={};for(const id of ['importPasswords','importPaymentMethods','credentialImportFile','credentialImportSummary']){
    elements[id]={listeners:{},files:[],value:'',hidden:true,disabled:false,textContent:'',
      addEventListener(name,fn){this.listeners[name]=fn;},
      fire(name){return this.listeners[name]?.({});},
      click(){this.clicked=true;}
    };
  }
  const calls=[];
  const api={
    async command(name,value){
      calls.push([name,value]);
      if(name==='vault-status')return {unlocked:true,exists:true};
      if(name==='vault-import')return {ok:true,imported:value.entries.length,skipped:0};
      throw Error('unexpected '+name);
    }
  };
  vm.runInNewContext(read('ui/credential-import.js'),{
    window:{minternet:api,__TAURI__:{}},
    document:{getElementById:id=>elements[id]},
    localStorage:{},URL,Number,JSON,String,Array,Object,Error,RegExp
  });
  return {elements,calls};
}
async function settle(){
  for(let n=0;n<12;n++)await Promise.resolve();
}
test('CSV login imports are local, validated and batched into encrypted vault',async()=>{
  const {elements,calls}=importHarness();
  const csv='name,url,username,password\r\n' +
    '"Hello, World",https://example.com/path,ava,"p,one"\r\n' +
    'Bad,http://unsafe.test,test,nope\r\n';
  elements.importPasswords.fire('click');await settle();
  assert.equal(elements.credentialImportFile.clicked,true);
  elements.credentialImportFile.files=[{size:csv.length,name:'Chrome Passwords.csv',text:async()=>csv}];
  await elements.credentialImportFile.fire('change');
  const batch=calls.find(([name])=>name==='vault-import')?.[1];
  assert.equal(batch?.kind,'password');
  assert.equal(batch?.entries?.length,1);
  assert.equal(batch.entries[0].origin,'https://example.com');
  assert.equal(batch.entries[0].password,'p,one');
  assert.equal(batch.entries[0].autofill,false);
  assert.match(elements.credentialImportSummary.textContent,/Imported 1 passwords; skipped 1/);
});
test('Bitwarden JSON credit-card exports import only complete card numbers',async()=>{
  const {elements,calls}=importHarness();
  const file={
    name:'bitwarden.json',size:640,
    text:async()=>JSON.stringify({items:[
      {type:3,name:'Personal',card:{cardholderName:'A Citizen',
        number:'4111111111111111',expMonth:'12',expYear:'2030'}},
      {type:3,name:'Masked',card:{cardholderName:'A Citizen',number:'****1111'}}
    ]})
  };
  elements.importPaymentMethods.fire('click');await settle();
  elements.credentialImportFile.files=[file];
  await elements.credentialImportFile.fire('change');
  const batch=calls.find(([name])=>name==='vault-import')?.[1];
  assert.equal(batch?.kind,'card');
  assert.equal(batch?.entries?.length,1);
  assert.equal(batch.entries[0].number,'4111111111111111');
  assert.equal(batch.entries[0].month,12);
  assert.equal(batch.entries[0].year,2030);
});
test('source importer never scans browser profiles and uses unlocked vault',()=>{
  const src=read('ui/credential-import.js');
  assert.match(src,/chooser\.click\(\)/);
  assert.match(src,/command\('vault-status'\)/);
  assert.match(src,/!state\?\.unlocked/);
  assert.match(src,/command\('vault-import',\{kind,entries:candidates\}\)/);
  assert.doesNotMatch(src,/localStorage\.setItem|fetch\(|XMLHttpRequest/);
  assert.match(native,/if !vault\.unlocked\(\)/);
  assert.match(native,/vault\.save\(&password_vault::file\(&app\)\?\)\?/);
});


test('Web Audio gain numerically amplifies eligible local media up to 300%',()=>{
  let gain=null;
  const media={currentSrc:'https://example.com/video.mp4',src:'',srcObject:null,
    mediaKeys:null,crossOrigin:null,paused:true};
  const context={
    destination:{},state:'running',
    createMediaElementSource(node){
      assert.equal(node,media);
      return {connect(target){return target;}};
    },
    createGain(){gain={gain:{value:1},connect(){}};return gain;}
  };
  const document={
    documentElement:{},
    addEventListener(){},
    querySelectorAll(){return [media];}
  };
  const win={AudioContext:function(){return context;}};
  vm.runInNewContext(audio,{window:win,document,location:{href:'https://example.com/',origin:'https://example.com'},
    MutationObserver:function(){this.observe=()=>{};},
    requestAnimationFrame:callback=>callback(),URL,Number,Set,WeakMap});
  assert.equal(typeof win.__minternetAudioGain?.setLevel,'function');
  win.__minternetAudioGain.setLevel(2);
  assert.equal(gain?.gain.value,2);
  win.__minternetAudioGain.setLevel(3);
  assert.equal(gain?.gain.value,3);
  win.__minternetAudioGain.setLevel(1);
  assert.equal(gain?.gain.value,1);
});

test('volume magnet snaps prominently to 0, 100, 200, 300 with fine keyboard steps',()=>{
  const elements=Object.fromEntries(['volumeSlider','volumeButton','volumeNumber','volumeValue','volumeHoldDelay','volumeIncrement1','volumeIncrement10']
    .map(id=>[id,{value:'',hidden:false,innerText:'',textContent:'',listeners:{},
      addEventListener(type,fn){this.listeners[type]=fn;},
      setAttribute(name,value){this[name]=value;}}]));
  const win={minternet:{command:async()=>({ok:true})}};
  const storage=new Map();
  vm.runInNewContext(read('ui/volume-ui.js'),{
    document:{getElementById:id=>elements[id]},window:win,
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,val)=>storage.set(key,val)},
    requestAnimationFrame:fn=>fn(),setTimeout,clearTimeout,
    Number,Math,JSON,String
  });
  const slider=elements.volumeSlider,output=elements.volumeValue;
  const send=n=>{slider.value=String(n);slider.listeners.input();return output.textContent;};
  assert.equal(elements.volumeIncrement10['aria-pressed'],'true');
  elements.volumeIncrement1.listeners.click();
  assert.equal(elements.volumeIncrement1['aria-pressed'],'true');
  slider.listeners.pointerdown();
  assert.equal(send(8),'0%');
  assert.equal(send(112),'112%');
  assert.equal(send(193),'200%');
  assert.equal(send(211),'200%'); // 13-point hysteresis prevents jitter
  assert.equal(send(214),'214%');
  assert.equal(send(291),'300%');
  slider.listeners.pointerup();
  assert.equal(send(299),'299%'); // 1% step remains available by keyboard
  assert.equal(send(198),'198%');
});
test('volume chrome has no divider and keeps the slider long enough for evenly spaced ticks',()=>{
  const css=read('ui/styles.css');
  const segment=css.slice(css.indexOf('/* Browser audio:'),css.indexOf('.credential-import-settings'));
  assert.match(segment,/\.minternet-volume\s*\{[^}]*gap:0;/);
  assert.match(segment,/\.minternet-volume\s*\{[^}]*border-left:0;/);
  assert.match(segment,/flex:0 0 25px;width:25px/);
  assert.match(segment,/\.volume-slider-wrap\s*\{[^}]*width:141px;/);
  assert.match(segment,/\.volume-tick-100\s*\{left:calc\(33\.333333% \+ 2\.333333px\);\}/);
  assert.match(segment,/\.volume-tick-200\s*\{left:calc\(66\.666667% - 2\.333333px\);\}/);
  assert.match(segment,/--volume-thumb-size:14px/);
  assert.match(segment,/top:50%;width:1px;height:8px/);
});

test('volume increments default to 10 and stay saved across launches',()=>{
  const store=new Map();
  const make=()=>{
    const elements=Object.fromEntries(['volumeSlider','volumeButton','volumeNumber','volumeValue',
      'volumeHoldDelay','volumeIncrement1','volumeIncrement10'].map(id=>
      [id,{value:'',listeners:{},setAttribute(k,v){this[k]=v;},
        addEventListener(k,fn){this.listeners[k]=fn;}}]));
    const window={minternet:{command:async()=>({ok:true})}};
    vm.runInNewContext(read('ui/volume-ui.js'),{window,
      document:{getElementById:id=>elements[id]},
      localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},
      requestAnimationFrame:fn=>fn(),setTimeout,clearTimeout,Number,Math,JSON,String,Object});
    return {elements,window};
  };
  const {elements,window}=make(),slider=elements.volumeSlider;
  const set=n=>{slider.value=String(n);slider.listeners.input();return elements.volumeValue.textContent;};
  assert.equal(window.minternetVolume.get().increments,10);
  assert.equal(elements.volumeIncrement10['aria-pressed'],'true');
  assert.equal(set(13),'10%');
  assert.equal(set(24),'20%');
  assert.equal(set(198),'200%');
  slider.listeners.keydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(elements.volumeValue.textContent,'210%');
  elements.volumeIncrement1.listeners.click();
  assert.equal(set(213),'213%');
  assert.equal(JSON.parse(store.get('minternet.volume.v1')).increments,1);
  const restored=make();
  assert.equal(restored.window.minternetVolume.get().increments,1);
  restored.elements.volumeIncrement10.listeners.click();
  assert.equal(restored.window.minternetVolume.get().increments,10);
});

test('two equal-height volume ticks precisely align with the 14px thumb travel',()=>{
  const styles=read('ui/styles.css');
  const volume=styles.slice(styles.indexOf('/* Browser audio:'));
  const travel=(width,fraction)=>7+(width-14)*fraction;
  const tick100=width=>width/3+2.333333;
  const tick200=width=>width*2/3-2.333333;
  for(const width of [120,141,180]){
    assert.ok(Math.abs(travel(width,1/3)-tick100(width))<0.00001);
    assert.ok(Math.abs(travel(width,2/3)-tick200(width))<0.00001);
  }
  assert.match(volume,/\.volume-tick\s*\{[^}]*top:50%;width:1px;height:8px;/);
  assert.match(volume,/transform:translate\(-50%,-50%\)/);
  assert.match(volume,/\.volume-mute-slash \{display:none;stroke:[^;]+;stroke-width:1\.65;/);
  assert.match(html,/class="volume-mute-slash" d="M7 17 17 7"/);
  assert.match(html,/id="volumeIncrement1"[^>]*aria-pressed="false"/);
  assert.match(html,/id="volumeIncrement10"[^>]*aria-pressed="true"/);
});

// Rapid fixes: session deep-link restore, progress UI, bulk unload, secret
// group cleanup, and ordered Settings navigation.
test('non-private SPA routes refresh from WebView into persisted session',()=>{
  const native=read('native/desktop/src-tauri/src/main.rs');
  const app=read('ui/app.js');
  assert.match(native,/fn refresh_session_urls\(app:&tauri::AppHandle\)->usize/);
  assert.match(native,/if address!=previous && is_real_page_url\(address\)/);
  assert.match(native,/\.on_document_title_changed\(move \|view, title\|/);
  assert.match(native,/"session-refresh-urls" =>/);
  assert.match(native,/browser\.tabs\.iter\(\)\.filter\(\|t\|!t\.private && t\.secret_id\.is_none\(\)\)/);
  assert.match(native,/browser\.tabs\.iter\(\)\.filter\(\|tab\|!tab\.private\)/);
  assert.match(app,/api\.command\('session-refresh-urls'\)/);
});
test('downloading files display progress bars, tracked bytes and a live toolbar indicator',()=>{
  const down=read('ui/downloads-ui.js');
  const styles=read('ui/styles.css');
  assert.match(down,/bar\.setAttribute\('role','progressbar'\)/);
  assert.match(down,/className='downloads-progress-fill'/);
  assert.match(down,/entry\.receivedBytes/);
  assert.match(down,/setInterval\(\(\)=>\{if\(activeProgress\)/);
  assert.match(styles,/\.downloads-progress-fill/);
  assert.match(read('native/desktop/src-tauri/src/main.rs'),/"receivedBytes":received/);
});
test('holding unload quick button unloads other tabs but keeps clicked tab',()=>{
  const menu=read('ui/chrome-native-menu.js');
  const native=read('native/desktop/src-tauri/src/main.rs');
  assert.match(menu,/hold:\(\)=>window\.minternet\?\.command\('unload-others',id\)/);
  assert.match(menu,/timer=setTimeout\(\(\)=>\{/);
  assert.match(native,/"unload-others" =>/);
  assert.match(native,/browser\.active_id=keep_id;/);
  assert.match(native,/if tab\.id==keep_id\{continue;\}/);
});
test('secret group removes itself once its last secret tab closes',()=>{
  const g=read('ui/tab-group-ui.js');
  assert.match(g,/const previous=latest\.tabs\.some\(t=>t\.secretTab/);
  assert.match(g,/if\(previous&&!current\)\{/);
  assert.match(g,/model\.remove\(state,secretGroupId\);/);
});
test('Settings submenus offer User Data in requested order',()=>{
  const source=read('ui/settings-sections.js');
  assert.match(source,/User Data/);
  for(const key of ['identityManagerOpen','passwordManagerOpen','paymentManagerOpen',
    'bookmarkSettingsManage','settingsSecretsOpen'])assert.ok(source.includes(key));
  assert.match(source,/details/);
});
