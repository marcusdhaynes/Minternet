'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../ui/updates.js'),'utf8');

function harness(respond,installedVersion='0.3.0') {
  const memory=new Map();
  let requests=0;
  const window={
    __TAURI__:{},
    minternet:{command:async name=>name==='app-version'?{version:installedVersion}:{message:'unsupported'}},
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
  assert.equal(h.requests,4);
});
test('release without Windows EXE is not offered as Windows update',async()=>{
  const r={tag_name:'v9.0.0',assets:[{name:'checksums.txt'}],html_url:'https://github.com/example'};
  const h=harness(url=>url.includes('/latest')?response(200,r):response(200,[r]));
  assert.equal(await h.updates.checkForUpdate(),null);
  assert.equal(h.updates.lastStatus.kind,'unpublished');
});

test('published Windows releases alone are installable, but newer source is reported pending',async()=>{
  const h=harness(url=>{
    if(url.includes('/branches/main'))
      return response(200,{commit:{sha:'aabbccdd'+'1'.repeat(32)}});
    return response(200,{
      tag_name:'v0.3.0-build.1099-g5dd3cee3',
      assets:[{name:'Minternet-Windows-Portable-v0.3.0-build.1099-g5dd3cee3.exe',
        browser_download_url:'https://github.com/example.exe'}]
    });
  });
  const found=await h.updates.checkForUpdate();
  assert.ok(found);
  assert.equal(h.updates.lastStatus.kind,'verified');
  assert.equal(h.requests,2);
});

test('installed newest verified release labels newer main source pending, not installable',async()=>{
  const h=harness(url=>{
    if(url.includes('/branches/main'))
      return response(200,{commit:{sha:'aabbccdd'+'1'.repeat(32)}});
    const release={tag_name:'v0.3.0',
      assets:[{name:'Minternet-Windows-Portable-v0.3.0.exe',
        browser_download_url:'https://github.com/example.exe'}]};
    return response(200,url.includes('/latest')?release:[release]);
  });
  assert.equal(await h.updates.checkForUpdate(),null);
  assert.equal(h.updates.lastStatus.kind,'verification-unknown');
  assert.match(h.updates.lastStatus.message,/Latest installable release/);
  assert.equal(h.requests,2);
});

test('matching installed published build and differing source SHA is pending, never installable',async()=>{
  const windowVersion='0.3.0-build.1099-g5dd3cee3';
  const h=harness(url=>{
    if(url.includes('/branches/main'))
      return response(200,{commit:{sha:'48f82b2dd35020e5c4443fb8d3ba764e0a0e59e5'}});
    const release={tag_name:'v0.3.0-build.1099-g5dd3cee3',
      assets:[{name:'Minternet-Windows-Portable-v0.3.0-build.1099-g5dd3cee3.exe',
      browser_download_url:'https://github.com/example.exe'}]};
    return response(200,url.includes('/latest')?release:[release]);
  },windowVersion);
  assert.equal(await h.updates.checkForUpdate(),null);
  assert.equal(h.updates.lastStatus.kind,'pending');
  assert.match(h.updates.lastStatus.message,/pending its verified Windows release/);
  assert.equal(h.requests,3);
});

test('newer published release remains installable independently of later source changes',async()=>{
  const h=harness(url=>{
    if(url.includes('/compare/'))throw Error('Unreleased code was queried');
    return response(200,{
      tag_name:'v0.3.0-build.1200-gaabbccdd',
      assets:[{name:'Minternet-Windows-Portable-v0.3.0-build.1200-gaabbccdd.exe',
        browser_download_url:'https://github.com/example.exe'}]
    });
  });
  const release=await h.updates.checkForUpdate();
  assert.equal(release.version,'0.3.0-build.1200-gaabbccdd');
  assert.equal(h.updates.lastStatus.kind,'verified');
  assert.match(h.updates.lastStatus.message,/New verified Minternet update available/);
  assert.equal(h.requests,2);
});

test('release metadata API failures do not produce false up-to-date messages',async()=>{
  const h=harness(()=>response(403,{message:'rate limit'}));
  assert.equal(await h.updates.checkForUpdate(),null);
  assert.equal(h.updates.lastStatus.kind,'offline');
  assert.doesNotMatch(h.updates.lastStatus.message,/Up to date/);
});

test('newer stable release wins if releases/latest still points to an older build',async()=>{
  const old={tag_name:'v0.3.0-build.949-g8e7f4c99',
    assets:[{name:'Minternet-Windows-Portable-v0.3.0-build.949-g8e7f4c99.exe'}]};
  const newer={tag_name:'v0.3.0-build.1200-gaabbccdd',
    assets:[{name:'Minternet-Windows-Portable-v0.3.0-build.1200-gaabbccdd.exe'}]};
  const h=harness(url=>response(200,url.includes('/latest')?old:[newer,old]));
  const found=await h.updates.checkForUpdate();
  assert.equal(found.version,'0.3.0-build.1200-gaabbccdd');
  assert.equal(h.requests,2);
});

test('older out-of-order stable publications do not override the newer version',async()=>{
  const versions=['v0.3.0-build.102-g12345678','v0.3.0-build.104-gabcdefab',
    'v0.3.0-build.103-g12345678'];
  const releases=versions.map(tag_name=>({tag_name,
    assets:[{name:'Minternet-Windows-Portable-'+tag_name+'.exe'}]}));
  const h=harness(url=>response(200,url.includes('/latest')?releases[2]:releases));
  const result=await h.updates.checkForUpdate();
  assert.equal(result.version,'0.3.0-build.104-gabcdefab');
});

test('draft-filled release page cannot hide a newer verified Windows build on next page',async()=>{
  const drafts=Array.from({length:100},(_,i)=>({
    tag_name:'minternet-build-'+i,draft:true,prerelease:true,assets:[]
  }));
  const previous={tag_name:'v0.3.0-build.1099-g5dd3cee3',
    assets:[{name:'Minternet-Windows-Portable-v0.3.0-build.1099-g5dd3cee3.exe',
      browser_download_url:'https://github.com/prev.exe'}]};
  const current={tag_name:'v0.3.0-build.1201-gaabbccdd',
    assets:[{name:'Minternet-Windows-Portable-v0.3.0-build.1201-gaabbccdd.exe',
      browser_download_url:'https://github.com/current.exe'}]};
  const h=harness(url=>{
    if(url.endsWith('/releases/latest'))return response(200,previous);
    if(/[?&]page=1(?:&|$)/.test(url))return response(200,drafts);
    if(/[?&]page=2(?:&|$)/.test(url))return response(200,[current,previous]);
    throw Error('Unexpected page: '+url);
  },'0.3.0-build.1099-g5dd3cee3');
  const found=await h.updates.checkForUpdate();
  assert.equal(found.version,'0.3.0-build.1201-gaabbccdd');
  assert.equal(h.updates.lastStatus.kind,'verified');
  assert.equal(h.requests,3);
});

test('matching source and published release reports verified current instead of pending',async()=>{
  const release={tag_name:'v0.3.0-build.1099-g5dd3cee3',
    assets:[{name:'Minternet-Windows-Portable-v0.3.0-build.1099-g5dd3cee3.exe',
      browser_download_url:'https://github.com/current.exe'}]};
  const h=harness(url=>url.includes('/branches/main')
    ?response(200,{commit:{sha:'5dd3cee35349c48afc2738fe0178f163be77ee1d'}})
    :response(200,url.includes('/latest')?release:[release]),
    '0.3.0-build.1099-g5dd3cee3');
  assert.equal(await h.updates.checkForUpdate(),null);
  assert.equal(h.updates.lastStatus.kind,'verified');
  assert.match(h.updates.lastStatus.message,/Up to date/);
  assert.equal(h.requests,3);
});

test('source status outages must not incorrectly certify everything is current',async()=>{
  const release={tag_name:'v0.3.0-build.1099-g5dd3cee3',
    assets:[{name:'Minternet-Windows-Portable-v0.3.0-build.1099-g5dd3cee3.exe',
      browser_download_url:'https://github.com/current.exe'}]};
  const h=harness(url=>url.includes('/branches/main')
    ?response(403,{message:'rate limit'})
    :response(200,url.includes('/latest')?release:[release]),
    '0.3.0-build.1099-g5dd3cee3');
  assert.equal(await h.updates.checkForUpdate(),null);
  assert.equal(h.updates.lastStatus.kind,'verification-unknown');
  assert.doesNotMatch(h.updates.lastStatus.message,/Up to date/);
});
