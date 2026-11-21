'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'ui/updates.js'),'utf8');
const SHA='a'.repeat(40);
function harness({saved=null,respond=null}={}){
  const storage=new Map();
  if(saved!==null)storage.set('minternet.updates.interval-seconds.v1',String(saved));
  const timers=new Map();let timerId=0,requests=[],events=new Map();
  const w={
    __TAURI__:{},minternet:{command:async name=>name==='app-version'
      ?{version:'0.3.0'}:{message:'unsupported'}},
    addEventListener(name,fn){events.set(name,fn);}
  };
  const context={
    window:w,document:{readyState:'loading',getElementById:()=>null,
      addEventListener:()=>{}},
    localStorage:{getItem:k=>storage.get(k)||null,
      setItem:(k,v)=>storage.set(k,String(v))},
    fetch:(url,options)=>{requests.push({url,options});
      return respond?respond(url,options):Promise.resolve({ok:true,json:async()=>({})});},
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},
    clearTimeout(id){timers.delete(id);},
    Date,AbortController,Promise,console
  };
  vm.runInNewContext(source,context,{filename:'updates.js'});
  const tick=async()=>{
    const [id,entry]=timers.entries().next().value||[];
    assert.ok(entry,'expected polling timeout');
    timers.delete(id);entry.fn();
    // flush pending fetch, JSON and finally callbacks
    for(let i=0;i<12;i++)await Promise.resolve();
  };
  return {api:w.MuseUpdates,storage,requests,timers,tick,events};
}
const verified={
  version:'0.3.0-build.1200-g1234abcd',
  tag:'v0.3.0-build.1200-g1234abcd',sourceSha:SHA,
  downloadUrl:'https://github.com/marcusdhaynes/Minternet/releases/download/v0.3.0-build.1200-g1234abcd/Minternet-Windows-Portable-v0.3.0-build.1200-g1234abcd.exe',
  checksumUrl:'https://github.com/marcusdhaynes/Minternet/releases/download/v0.3.0-build.1200-g1234abcd/SHA256SUMS.txt',
  url:'https://github.com/marcusdhaynes/Minternet/releases/tag/v0.3.0-build.1200-g1234abcd',
  notes:'Verified release'
};
function feed(release=verified){
  return {schema:1,sourceSha:SHA,windowsRun:{head_sha:SHA,
    run_number:1200,status:'completed',conclusion:'success'},release};
}
test('update checker defaults to five seconds, with configurable saved seconds',()=>{
  const h=harness();
  assert.equal(h.api.updateCheckSeconds,5);
  h.api.startPipelinePolling({closest:()=>null});
  assert.equal([...h.timers.values()][0].ms,5000);
  assert.equal(h.api.setPollSeconds(30),30);
  assert.equal(h.storage.get('minternet.updates.interval-seconds.v1'),'30');
  assert.equal(h.timers.size,1,'old poll timer cleared on preference change');
  assert.equal([...h.timers.values()][0].ms,30000);
  assert.equal(harness({saved:45}).api.updateCheckSeconds,45);
});
test('invalid intervals fall back to safe 5-second minimum, bounded at one hour',()=>{
  const h=harness({saved:'javascript:1'});
  assert.equal(h.api.updateCheckSeconds,5);
  assert.equal(h.api.setPollSeconds(4),5);
  assert.equal(h.api.setPollSeconds(3601),5);
  assert.equal(h.api.setPollSeconds(3600),3600);
});
test('every poll uses only static feed, not rate-limited GitHub API',async()=>{
  const h=harness({respond:async()=>({ok:true,json:async()=>feed()})});
  h.api.startPipelinePolling({closest:()=>null});
  await h.tick();
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].url,
    'https://marcusdhaynes.github.io/Minternet/update-feed.json');
  assert.equal(h.requests[0].options.cache,'no-store');
  assert.equal(h.api.lastStatus.kind,'verified');
  assert.equal(h.api.livePipeline.kind,'ready');
  assert.ok(h.api.lastFeedPollAt>0);
  assert.equal([...h.timers.values()][0].ms,5000);
});
test('ignore duplicate in-flight checks instead of overlapping requests',async()=>{
  let finish;
  const pending=new Promise(resolve=>{finish=resolve});
  const h=harness({respond:()=>pending});
  const one=h.api.refreshLiveFeed(null),two=h.api.refreshLiveFeed(null);
  assert.equal(h.requests.length,1);
  finish({ok:true,json:async()=>feed()});
  await Promise.all([one,two]);
  assert.equal(h.requests.length,1);
});
test('malformed or incomplete release feed cannot trigger an update',async()=>{
  const h=harness({respond:async()=>({ok:true,json:async()=>feed({
    ...verified,checksumUrl:'https://evil.example/SHA256SUMS.txt'
  })})});
  await h.api.refreshLiveFeed(null);
  assert.notEqual(h.api.livePipeline.kind,'ready');
  assert.equal(h.api.lastStatus,null);
});
test('Settings owns numeric seconds control; publisher refreshes feed on release',()=>{
  assert.match(source,/pollInput\.id='updatesPollSeconds'/);
  assert.match(source,/pollInput\.addEventListener\('change'/);
  assert.match(source,/refreshLiveFeed\(el\)\.finally\(scheduleNextPoll\)/);
  assert.match(fs.readFileSync(path.join(root,'ui/styles.css'),'utf8'),
    /\.bookmark-settings \.updates-poll-setting/);
  const pages=fs.readFileSync(path.join(root,'.github/workflows/pages.yml'),'utf8');
  const archive=fs.readFileSync(path.join(root,'.github/workflows/publish-current-portable.yml'),'utf8');
  const win=fs.readFileSync(path.join(root,'.github/workflows/native-windows.yml'),'utf8');
  assert.match(pages,/site\/update-feed\.json/);
  assert.match(pages,/SHA256SUMS\.txt/);
  assert.match(archive,/gh workflow run pages\.yml --ref main/);
  assert.match(win,/gh workflow run pages\.yml --ref main/);
});
