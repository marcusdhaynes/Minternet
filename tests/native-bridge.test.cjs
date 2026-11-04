'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const bridge=fs.readFileSync(path.join(__dirname,'../ui/native-bridge.js'),'utf8');

test('one native new-tab event creates exactly one tab despite many state subscribers',async()=>{
  const handlers=new Map();
  const invocations=[];
  const tauri={
    event:{listen:async (key,callback)=>{
      handlers.set(key,[...(handlers.get(key)||[]),callback]);
      return ()=>{};
    }},
    core:{invoke:async(name,args)=>{
      invocations.push({name,args});
      return name==='browser_snapshot'?{tabs:[],activeId:null}:{ok:true};
    }}
  };
  const window={__TAURI__:tauri};
  vm.runInNewContext(bridge,{window,document:{documentElement:{classList:{toggle(){}}}}});
  window.minternet.onState(()=>{});
  window.minternet.onState(()=>{});
  window.minternet.onState(()=>{});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(handlers.get('minternet:open-tab').length,1);
  handlers.get('minternet:open-tab')[0]({payload:'https://example.com/login'});
  await Promise.resolve();
  assert.equal(invocations.filter(x=>x.args?.name==='new-background-url').length,1);
});
