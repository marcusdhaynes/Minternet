'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../ui/updates.js'),'utf8');

function harness(respond) {
  const memory=new Map();
  let requests=0;
  const window={
    __TAURI__:{},
    minternet:{command:async name=>name==='app-version'?{version:'0.3.0'}:{message:'unsupported'}},
    open:()=>{throw Error('update may not auto-open during a check');}
  };
  const context={
    window,
    document:{readyState:'loading',addEventListener:()=>{},getElementById:()=>null},
    localStorage:{getItem:key=>memory.get(key)||null,setItem:(key,v)=>memory.set(key,v)},
    fetch:async(url,opts)=>{requests++;return respond(url,opts,requests);},
    setTimeout,clearTimeout,AbortController,Promise,console
  };
  vm.runInNewContext(source,context,{filename:'updates.js'});
  return {updates:window.MuseUpdates,get requests(){return requests;}};
}
function response(status,data) {
  return {ok:status>=200&&status<300,status,json:async()=>data};
}
test('update version uses installed native package, not stale web v0.1.0',async()=>{
  const h=harness(()=>response(200,{tag_name:'v0.3.0-build.9-g123abc',assets:[
    {name:'Minternet-Windows-Portable-v0.3.0-build.9-g123abc.exe',browser_download_url:'https://github.com/example.exe'}
  ],html_url:'https://github.com/example',body:'Windows build'}));
  const found=await h.updates.checkForUpdate();
  assert.equal(h.updates.CURRENT_VERSION,'0.3.0');
  assert.equal(found.version,'0.3.0-build.9-g123abc');
  assert.equal(h.updates.lastStatus.kind,'verified');
});
test('missing latest AND empty releases yields unpublished, not up to date',async()=>{
  const h=harness(url=>url.includes('/latest')?response(404,null):response(200,[]));
  assert.equal(await h.updates.checkForUpdate(),null);
  assert.equal(h.updates.lastStatus.kind,'unpublished');
});
test('API outage shows recoverable error rather than falsely saying up to date',async()=>{
  const h=harness(()=>response(503,{message:'unavailable'}));
  assert.equal(await h.updates.checkForUpdate(),null);
  assert.equal(h.updates.lastStatus.kind,'offline');
  assert.ok(h.updates.lastStatus.message.includes('503'));
  assert.equal(h.requests,2);
});
test('release without Windows EXE is not offered as Windows update',async()=>{
  const r={tag_name:'v9.0.0',assets:[{name:'checksums.txt'}],html_url:'https://github.com/example'};
  const h=harness(url=>url.includes('/latest')?response(200,r):response(200,[r]));
  assert.equal(await h.updates.checkForUpdate(),null);
  assert.equal(h.updates.lastStatus.kind,'unpublished');
});
