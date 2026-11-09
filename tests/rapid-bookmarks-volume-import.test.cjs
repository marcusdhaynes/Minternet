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
