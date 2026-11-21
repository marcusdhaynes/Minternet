'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const probe=read('ui/auth-popup-blank-probe.js');
const display=read('ui/auth-popup-unavailable.js');
function check({protocol='https:',ready='complete',text='',children=0,controls=[]}={}){
  const body={innerText:text,
    querySelectorAll(selector){
      if(selector==='*')return Array.from({length:children},()=>({}));
      return controls;
    }
  };
  return vm.runInNewContext(probe,{
    location:{protocol},document:{readyState:ready,body},
    getComputedStyle:el=>({display:el.display||'block',
      visibility:el.visibility||'visible',opacity:el.opacity??'1'})
  });
}
const control={getBoundingClientRect:()=>({width:60,height:26})};

test('an empty completed HTTPS popup is eligible for one recovery reload',()=>{
  assert.equal(check(),true);
  assert.equal(check({text:' '}),true);
});
test('never reload an active account chooser, OAuth challenge or error',()=>{
  assert.equal(check({text:'Choose an account'}),false);
  assert.equal(check({text:'403: disallowed_useragent'}),false);
  assert.equal(check({controls:[control]}),false);
  assert.equal(check({controls:[{...control,visibility:'hidden'}]}),true);
});
test('do not reload unfinished, insecure or large dynamically hydrated apps',()=>{
  assert.equal(check({ready:'interactive'}),false);
  assert.equal(check({protocol:'http:'}),false);
  assert.equal(check({children:13}),false);
  assert.equal(check({children:12}),true);
});
test('unavailable UI includes bounded retry and close but no token bridge',()=>{
  new vm.Script(display);
  assert.match(display,/Reload Sign-In/);
  assert.match(display,/location\.reload\(\)/);
  assert.match(display,/window\.close\(\)/);
  assert.doesNotMatch(display,/__TAURI__|window\.opener\.postMessage|document\.cookie|localStorage/);
});
test('native blank recovery preserves the real WebView2 opener and never reopens a window',()=>{
  const main=read('native/desktop/src-tauri/src/main.rs');
  const start=main.indexOf('fn schedule_auth_popup_blank_check(');
  const end=main.indexOf('fn create_webview(',start);
  const section=main.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(main,/\.window_features\(_features\)/);
  assert.match(main,/NewWindowResponse::Create\{window\}/);
  assert.match(section,/if attempts\.load\(Ordering::Relaxed\)>=2/);
  assert.match(section,/view\.eval_with_callback\(AUTH_POPUP_BLANK_PROBE/);
  assert.match(section,/recovery\.fetch_update/);
  assert.match(section,/if count==0\{/);
  assert.match(section,/popup\.reload\(\)/);
  assert.match(section,/popup\.eval\(AUTH_POPUP_UNAVAILABLE\)/);
  assert.doesNotMatch(section,/WebviewWindowBuilder::new|create_webview\(|window\.open\(/);
  assert.match(main,/matches!\(event\.event\(\),PageLoadEvent::Finished\)/);
  assert.match(main,/\.on_new_window\(\|_,_\|NewWindowResponse::Deny\)/);
});
