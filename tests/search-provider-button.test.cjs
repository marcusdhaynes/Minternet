'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../ui/search-settings.js'),'utf8');
function element(tag='div'){
  const events={};
  const children=[];
  return {
    tag,children,events,style:{},className:'',title:'',innerHTML:'',textContent:'',
    classList:{toggle(){}},
    setAttribute(key,value){this[key]=value;},
    append(...nodes){children.push(...nodes);},
    remove(){this.removed=true;},
    focus(){},
    addEventListener(name,fn){events[name]=fn;},
    getBoundingClientRect(){return {left:10,right:28,top:8,bottom:30,width:150,height:52};}
  };
}
function harness(stored){
  const storage=new Map(stored?[['minternet.search-engine.v1',stored]]:[]);
  const button=element('button');
  const select=element('select');
  const address=element('input');
  const body=element('body');
  const timers=[];
  const docEvents={};
  const document={
    body,
    getElementById:id=>({connectionIcon:button,defaultSearchEngine:select,address})[id]||null,
    createElement:element,
    addEventListener:(name,fn)=>{docEvents[name]=fn;},
    removeEventListener:(name)=>{delete docEvents[name];}
  };
  const window={addEventListener(){},minternet:{command:async()=>({ok:true})}};
  vm.runInNewContext(script,{
    window,document,localStorage:{getItem:key=>storage.get(key)??null,
      setItem:(key,value)=>storage.set(key,value)},
    innerWidth:800,innerHeight:600,
    setTimeout:fn=>{timers.push(fn);return timers.length;},
    clearTimeout:()=>{}
  });
  return {window,button,select,address,storage,timers,body};
}
test('search provider starts at Google, and clicking the icon offers ChatGPT',()=>{
  const h=harness();
  assert.equal(h.window.minternetSearch.getEngine(),'google');
  assert.match(h.button.innerHTML,/4285F4/);
  assert.equal(h.select.value,'google');
  h.button.events.click({preventDefault(){}});
  const panel=h.body.children[0];
  assert.ok(panel,'must create a small menu');
  const option=panel.children.find(node=>node.tag==='button');
  assert.equal(option.children.find(x=>x.tag==='span').textContent,'ChatGPT');
  option.events.click();
  assert.equal(h.window.minternetSearch.getEngine(),'chatgpt');
  assert.equal(h.storage.get('minternet.search-engine.v1'),'chatgpt');
  assert.match(h.address.placeholder,/Ask ChatGPT/);
});
test('holding ChatGPT switches to purple Temporary Chat, then back',()=>{
  const h=harness('chatgpt');
  h.button.events.pointerdown({button:0,isPrimary:true});
  h.timers.at(-1)();
  assert.equal(h.window.minternetSearch.getEngine(),'chatgpt-private');
  assert.equal(h.select.value,'chatgpt-private');
  assert.match(h.button.title,/Temporary/);
  h.button.events.click({preventDefault(){}});
  assert.equal(h.body.children.length,0,'long press must not open a popup');
  h.button.events.pointerdown({button:0,isPrimary:true});
  h.timers.at(-1)();
  assert.equal(h.window.minternetSearch.getEngine(),'chatgpt');
});
test('settings can choose ChatGPT Temporary and unknown settings revert to Google',()=>{
  const h=harness('untrusted-engine');
  assert.equal(h.window.minternetSearch.getEngine(),'google');
  h.select.value='chatgpt-private';h.select.events.change();
  assert.equal(h.window.minternetSearch.getProviderHome(),
    'https://chatgpt.com/?temporary-chat=true');
  assert.equal(h.window.minternetSearch.setEngine('bad-scheme'),'google');
});
