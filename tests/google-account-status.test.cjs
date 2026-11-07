'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../ui/google-sync-ui.js'),'utf8');
function harness(authorized){
  const nodes=new Map();
  const get=id=>{
    if(!nodes.has(id))nodes.set(id,{
      id,hidden:false,disabled:false,value:'',textContent:'',listeners:{},
      addEventListener(name,cb){(this.listeners[name]??=[]).push(cb);},
      click(){for(const cb of this.listeners.click||[])cb();},
      focus(){}
    });
    return nodes.get(id);
  };
  const cache=new Map(),calls=[];
  let connectedEmail=null;
  const native={
    async command(name,value){
      calls.push([name,value]);
      if(name==='google-status')return {email:connectedEmail,connected:!!connectedEmail,gmailAccounts:[]};
      if(name==='google-login'){
        if(!authorized)return {message:'Google authorization rejected (400, invalid_grant)'};
        connectedEmail='test@example.com';
        return {authorized:true,email:connectedEmail,sessionSaved:true};
      }
      return {ok:true};
    },
    onState(){return ()=>{};}
  };
  const win={
    __TAURI__:{event:{listen:async()=>()=>{}}},
    minternet:native,
    MinternetLiveSync:{eligibleTab:()=>false},
    MinternetLiveTransport:{},
    minternetToast(){},
    minternetBookmarks:{closeOverlay(){}},
    addEventListener(){}
  };
  const context={
    window:win,
    document:{getElementById:get},
    localStorage:{getItem:k=>cache.get(k)||null,setItem:(k,v)=>cache.set(k,v)},
    setInterval(){},queueMicrotask:fn=>Promise.resolve().then(fn),
    navigator:{clipboard:{writeText:async()=>{}}}
  };
  vm.runInNewContext(source,context,{filename:'google-sync-ui.js'});
  // App initialization restores the saved Client ID after loading its UI.
  get('googleClientId').value='123456-local.apps.googleusercontent.com';
  return {get,win,calls};
}
async function tick(){for(let i=0;i<20;i++)await Promise.resolve();}
test('Google OAuth success is shown as connected even without encrypted cloud sync',async()=>{
  const {get,calls}=harness(true);
  await tick();
  assert.equal(get('googleSyncState').textContent,'Not connected');
  get('googleConnectContinue').click();
  await tick();
  assert.equal(get('googleSyncState').textContent,'Google connected · Sync off');
  assert.equal(get('googleSyncConnected').hidden,false);
  assert.equal(get('googleAccountLogin').hidden,true);
  assert.match(get('googleLoginFeedback').textContent,/connected and securely saved/);
  assert.equal(get('googleLoginFeedback').hidden,false);
  get('googleWebsiteSignIn').click();
  await tick();
  assert(calls.some(([name,url])=>name==='new-url'&&url==='https://accounts.google.com/'));
});
test('OAuth failures are visible without a connected account',async()=>{
  const {get}=harness(false);
  await tick();
  get('googleConnectContinue').click();
  await tick();
  assert.equal(get('googleSyncState').textContent,'Not connected');
  assert.equal(get('googleSyncConnected').hidden,true);
  assert.equal(get('googleLoginFeedback').hidden,false);
  assert.match(get('googleLoginFeedback').textContent,/invalid_grant/);
  assert.equal(get('googleAccountConfig').hidden,false);
  assert.equal(get('googleConnectContinue').disabled,false);
});
