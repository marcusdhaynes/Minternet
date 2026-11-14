'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'../ui/chrome-native-menu.js'),'utf8');
const native=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/site_context_menu.rs'),'utf8');
const backend=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');

function harness({width=1200,height=800,shortChromeHeight=74,rootHeight=240}={}){
  const commands=[];
  let nextHeight=rootHeight;
  class Element{
    constructor(tag){
      this.tagName=tag.toUpperCase();
      this.children=[];this.style={};this.listeners={};this.className='';
      this.textContent='';this.disabled=false;
      this.classList={
        add:name=>{this.className+=(this.className?' ':'')+name;},
        remove:name=>{this.className=this.className.split(' ').filter(x=>x!==name).join(' ');},
        toggle:(name,force)=>{const has=this.className.split(' ').includes(name);
          if(force===undefined?has:!force)this.classList.remove(name);else if(!has)this.classList.add(name);}
      };
    }
    append(...nodes){for(const item of nodes){item.parent=this;this.children.push(item);}}
    appendChild(node){this.append(node);}
    setAttribute(name,value){this[name]=value;}
    addEventListener(name,handler){this.listeners[name]=handler;}
    removeEventListener(name){delete this.listeners[name];}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
    contains(node){return node===this||this.children.some(x=>x.contains?.(node));}
    querySelector(selector){
      if(selector===':scope > .system-popup-list')return this.children.find(x=>x.className.split(' ').includes('system-popup-list'));
      return null;
    }
    get scrollHeight(){return this.className.includes('system-popup-root')?nextHeight:nextHeight-32;}
    getBoundingClientRect(){
      const root=this.className.includes('system-popup-root');
      const max=parseFloat(this.style.maxHeight)||Infinity;
      return {left:0,top:0,width:root?205:205,height:root?Math.min(nextHeight,max):nextHeight-32,bottom:nextHeight};
    }
  }
  const body=new Element('body');
  const document={
    body,createElement:tag=>new Element(tag),
    getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],
    addEventListener:()=>{},removeEventListener:()=>{},createTextNode:s=>{const el=new Element('span');el.textContent=s;return el;}
  };
  const groups={
    getState:()=>({groups:[]}),getLatest:()=>({activeId:1,tabs:[{id:1,url:'https://example.com'}]}),
    get:()=>({id:7,name:'Work',visible:true,color:'violet'}),
    groupColor:()=> '#7650aa',displayName:()=> 'Work',
    updateGroup:()=>{}
  };
  const window={
    __TAURI__:{event:{listen:()=>Promise.resolve(()=>{})}},
    minternet:{command:async(name,payload)=>{
      commands.push({name,payload});
      if(name==='chrome-overlay')return {ok:true,viewport:{width,height}};
      return {ok:true};
    }},
    minternetGroups:groups
  };
  vm.runInNewContext(source,{window,document,innerWidth:width,innerHeight:shortChromeHeight,setTimeout,clearTimeout,console});
  const wait=()=>new Promise(resolve=>setImmediate(resolve));
  const popup=()=>body.children.find(x=>x.className.includes('system-popup-root'));
  return {window,commands,body,popup,wait,setHeight:value=>{nextHeight=value;}};
}

test('1: Chrome context menu stays beside pointer despite toolbar-only 74px innerHeight',async()=>{
  const h=harness();
  void h.window.minternetMenus.chrome({clientX:380,clientY:430,target:{closest:()=>null}});
  await h.wait();
  assert.equal(Number.parseInt(h.popup().style.left,10),383);
  assert.equal(Number.parseInt(h.popup().style.top,10),433);
  assert.ok(h.commands.some(x=>x.name==='chrome-overlay'&&x.payload===true));
});
test('2: Browser-style menu opens above cursor near bottom edge rather than jumping to top',async()=>{
  const h=harness();
  void h.window.minternetMenus.chrome({clientX:300,clientY:755,target:{closest:()=>null}});
  await h.wait();
  assert.equal(Number.parseInt(h.popup().style.top,10),755-240-3);
  assert.ok(Number.parseInt(h.popup().style.top,10)>300);
});
test('3: At right edge, menu opens left of cursor',async()=>{
  const h=harness();
  void h.window.minternetMenus.chrome({clientX:1190,clientY:260,target:{closest:()=>null}});
  await h.wait();
  assert.equal(Number.parseInt(h.popup().style.left,10),1190-205-3);
});
test('4: At top-left corner, menu stays visible without negative coordinates',async()=>{
  const h=harness();
  void h.window.minternetMenus.chrome({clientX:1,clientY:1,target:{closest:()=>null}});
  await h.wait();
  assert.ok(Number.parseInt(h.popup().style.left,10)>=6);
  assert.ok(Number.parseInt(h.popup().style.top,10)>=6);
});
test('5: Oversized site menu becomes scrollable without escaping parent window',async()=>{
  const h=harness({height:600,rootHeight:920});
  void h.window.minternetMenus.chrome({clientX:400,clientY:510,target:{closest:()=>null}});
  await h.wait();
  const root=h.popup();
  assert.equal(Number.parseInt(root.style.maxHeight,10),550);
  assert.ok(root.className.includes('system-popup-scrollable'));
  const list=root.querySelector(':scope > .system-popup-list');
  assert.equal(list.style.overflowY,'auto');
  assert.ok(Number.parseInt(root.style.top,10)>=6);
  assert.ok(Number.parseInt(root.style.top,10)+550<=600);
});
test('6: group overview uses same full-window cursor anchor',async()=>{
  const h=harness({height:800});
  await h.window.minternetMenus.groups({x:460,y:500});
  await h.wait();
  assert.equal(Number.parseInt(h.popup().style.left,10),463);
  assert.equal(Number.parseInt(h.popup().style.top,10),503);
});
test('7: native WebView2 event uses actual split-pane X and Y offsets',()=>{
  assert.match(native,/get_webview\(&format!\("tab-\{id\}"\)\)/);
  assert.match(native,/view\.position\(\)\.ok\(\)/);
  assert.match(native,/"x":\(origin_x\+point\.x as f64\/scale\)/);
  assert.match(native,/"y":\(origin_y\+point\.y as f64\/scale\)/);
});
test('8: native chrome-overlay API returns logical parent viewport, not toolbar height',()=>{
  assert.match(backend,/let viewport=app\.get_window\("main"\)/);
  assert.match(backend,/\.and_then\(\|window\|dimensions\(&window\)\.ok\(\)\)/);
  assert.match(backend,/json!\(\{"ok": true,"viewport":viewport\}\)/);
});
test('9: closing a pending menu prevents stale overlay response from reviving it',async()=>{
  const h=harness();
  void h.window.minternetMenus.chrome({clientX:220,clientY:300,target:{closest:()=>null}});
  void h.window.minternetMenus.chrome({clientX:700,clientY:500,target:{closest:()=>null}});
  await h.wait();
  assert.equal(h.body.children.filter(x=>x.className.includes('system-popup-root')).length,1);
  assert.equal(Number.parseInt(h.popup().style.left,10),703);
});
test('10: menu positioning does not request native Windows context menus',async()=>{
  const h=harness();
  void h.window.minternetMenus.chrome({clientX:220,clientY:300,target:{closest:()=>null}});
  await h.wait();
  assert.ok(h.commands.every(x=>x.name!=='native-popup'&&x.name!=='system-menu'));
});
