'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../ui/form-suggestions.js'),'utf8');

async function simulate({unlocked=true,logins=[{origin:'https://site.example',username:'alice',autofill:true}],ctxY=30}={}){
  const calls=[],items=[],events={};
  class Element{
    constructor(tag){this.tagName=tag.toUpperCase();this.hidden=false;this.style={};this.children=[];this.listeners={};this.offsetHeight=120;}
    setAttribute(){}
    addEventListener(name,cb){this.listeners[name]=cb;}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=[...children];}
  }
  const viewport={innerWidth:640,innerHeight:52,__TAURI__:{},minternetToast(){}};
  const command=async(name,value)=>{
    calls.push({name,value,height:viewport.innerHeight});
    if(name==='browser-form-context')return {
      kind:'login',origin:'https://site.example',top:52,x:33,y:ctxY,
      width:472,saveReady:false,key:'login'
    };
    if(name==='vault-status')return {exists:true,unlocked};
    if(name==='vault-list')return logins;
    if(name==='chrome-overlay'){
      viewport.innerHeight=value?760:52;
      return {ok:true};
    }
    return null;
  };
  viewport.minternet={command};
  viewport.addEventListener=(event,cb)=>{events[event]=cb};
  const document={
    body:{append(...children){items.push(...children);}},
    visibilityState:'visible',
    createElement(tag){return new Element(tag);},
    querySelector(){return null;},
    getElementById(){return null;}
  };
  let tick=null;
  vm.runInNewContext(source,{
    window:viewport,document,
    setInterval(cb){tick=cb;},
    requestAnimationFrame(cb){cb();},
    Promise,Math,Number
  });
  assert.ok(tick);
  tick();
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  const panel=items.find(item=>item.tagName==='SECTION');
  assert.ok(panel,'Missing popup');
  return {viewport,document,events,panel,calls};
}

test('autofill popup never uses the short toolbar height to place itself above tabs',async()=>{
  const {panel,calls}=await simulate();
  assert.equal(panel.hidden,false);
  assert.equal(panel.style.width,'280px');
  assert.ok(Number.parseFloat(panel.style.top)>=52, 'Popup is over the tab strip');
  assert.ok(Number.parseFloat(panel.style.top)<=640, 'Popup is outside the view');
  const overlay=calls.find(item=>item.name==='chrome-overlay'&&item.value===true);
  assert.ok(overlay,'Native overlay was not expanded');
  assert.equal(overlay.height,52,'Overlay was already incorrectly expanded');
});

test('a lower website field keeps its popup entirely inside the expanded browser',async()=>{
  const {panel}=await simulate({ctxY:690});
  const top=Number.parseFloat(panel.style.top);
  assert.ok(top>=52&&top+panel.offsetHeight<=760);
});

test('no purple autofill popup when vault is locked or site has no saved login',async()=>{
  for(const options of [{unlocked:false},{logins:[]}]){
    const {panel,calls}=await simulate(options);
    assert.equal(panel.hidden,true);
    assert.equal(calls.filter(item=>item.name==='chrome-overlay').length,0);
  }
});

test('CSS supplies a safe initial top even before Javascript positions the popup',()=>{
  const styles=fs.readFileSync(path.join(__dirname,'../ui/styles.css'),'utf8');
  assert.match(styles,/\.form-suggestion-popup\{[^}]*top:var\(--chrome-height,52px\)/);
  assert.match(styles,/\.form-suggestion-popup\{[^}]*max-width:calc\(100vw - 16px\)/);
});
