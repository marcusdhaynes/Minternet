'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');

test('address focus alone never queries history, even with a prefilled URL',async()=>{
  const handlers={},calls=[];
  class Element {
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.listeners={};this.attrs={};this.style={};this.children=[];this.value='';}
    addEventListener(name,listener){this.listeners[name]=listener;}
    setAttribute(name,value){this.attrs[name]=value;}
    removeAttribute(name){delete this.attrs[name];}
    getBoundingClientRect(){return {left:40,bottom:56,width:440};}
    append(...elements){this.children.push(...elements);}
    replaceChildren(...elements){this.children=elements;}
    remove(){}
  }
  const address=new Element('input'),form=new Element('form'),history=new Element('button');
  const document={
    activeElement:address,
    body:new Element('body'),
    getElementById:id=>({address,addressForm:form,historyManagerOpen:history})[id],
    createElement:tag=>new Element(tag),
    addEventListener:(name,callback)=>{handlers[name]=callback;}
  };
  const window={
    innerWidth:1200,
    addEventListener:(name,callback)=>{handlers[name]=callback;},
    minternet:{command:async(name,value)=>{
      calls.push({name,value});
      return name==='history-search'?[{url:'https://example.com/',title:'Example'}]:[];
    }}
  };
  vm.runInNewContext(read('ui/history-ui.js'),{
    window,document,URL,innerWidth:1200,setTimeout,console
  });
  address.value='https://example.com/';
  address.listeners.focus();
  await Promise.resolve();
  assert.equal(calls.filter(x=>x.name==='history-search').length,0);
  address.value='exa';
  address.listeners.input();
  await Promise.resolve();await Promise.resolve();
  assert.equal(calls.filter(x=>x.name==='history-search').length,1);
  address.value='';
  address.listeners.input();
  await Promise.resolve();
  assert.equal(calls.filter(x=>x.name==='history-search').length,1);
  assert.equal(address.attrs['aria-expanded'],'false');
});

test('username-first sign-in is recognized without classifying signup forms as login',()=>{
  const native=read('native/desktop/src-tauri/src/main.rs');
  assert.match(native,/include_str!\("login_form_context\.js"\)/);
  assert.match(native,/include_str!\("login_autofill\.js"\)/);
  const context=read('native/desktop/src-tauri/src/login_form_context.js');
  assert.match(context,/hasPassword\.length===0&&usernameField&&loginRoute/);
  assert.match(context,/const registration=/);
  assert.match(context,/const login=!registration/);
  const ui=read('ui/form-suggestions.js');
  assert.match(ui,/needsUnlock=!status\?\.unlocked/);
  assert.match(ui,/Unlock Saved Logins/);
  assert.match(ui,/item\.origin===ctx\.origin/);
});

test('blank-page recovery is origin-agnostic, double checked and nondestructive',()=>{
  const health=read('native/desktop/src-tauri/src/render_health.rs');
  const native=read('native/desktop/src-tauri/src/main.rs');
  assert.match(health,/matches!\(url\.scheme\(\),"https"\|"http"\)/);
  assert.match(health,/consecutive=Arc::new\(AtomicU8::new\(0\)\)/);
  assert.match(health,/hits\.fetch_add\(1,Ordering::AcqRel\)==0/);
  assert.match(native,/action==render_health::Recovery::Reload/);
  assert.match(health,/Some\(Recovery::Recreate\)/);
  assert.match(native,/if view\.reload\(\)\.is_ok\(\)/);
  const updater=read('native/desktop/src-tauri/src/portable_updater.rs');
  assert.match(updater,/pub fn confirm_startup_when_ready\(app:&AppHandle\)/);
  assert.match(updater,/document\.getElementById\('addressForm'\)/);
  assert.match(native,/portable_updater::confirm_startup_when_ready\(app\.handle\(\)\)/);
  assert.doesNotMatch(native,/^\s*portable_updater::confirm_startup\(\);/m);
});
