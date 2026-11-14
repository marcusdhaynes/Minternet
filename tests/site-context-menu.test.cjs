'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function harness(){
  const events=new Map(),commands=[];
  class Element {
    constructor(tag){
      this.tagName=tag.toUpperCase();this.children=[];this.listeners={};
      this.className='';this.style={};this.textContent='';this.disabled=false;
      this.classList={add:()=>{},remove:()=>{},toggle:()=>{}};
    }
    append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);} }
    appendChild(node){this.append(node);}
    setAttribute(key,value){this[key]=value;}
    addEventListener(kind,fn){this.listeners[kind]=fn;}
    removeEventListener(kind){delete this.listeners[kind];}
    getBoundingClientRect(){return {left:0,top:0,width:255,height:190,bottom:190};}
    contains(node){return node===this||this.children.some(child=>child.contains?.(node));}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    click(){this.listeners.click?.({target:this,stopPropagation(){},preventDefault(){}});}
  }
  const body=new Element('body');
  const document={
    body,createElement:tag=>new Element(tag),
    getElementById:()=>null,
    querySelector:()=>null,querySelectorAll:()=>[],
    addEventListener:()=>{},removeEventListener:()=>{}
  };
  const window={
    __TAURI__:{event:{listen:(name,fn)=>{events.set(name,fn);return Promise.resolve(()=>{});}}},
    minternet:{command:async (name,payload)=>{commands.push({name,payload});return {ok:true};}},
    minternetGroups:{getLatest:()=>({activeId:1,tabs:[{id:1,url:'https://example.com'}]})}
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname,'../ui/chrome-native-menu.js'),'utf8'),
    {window,document,console,setTimeout,clearTimeout,innerWidth:1350,innerHeight:800}
  );
  const emit=payload=>events.get('minternet:site-context')({payload:{tabId:1,requestId:42,
    x:120,y:180,pageUrl:'https://example.com/',nativeItems:[],...payload}});
  const buttons=()=>{const output=[];const visit=node=>{if(node.tagName==='BUTTON')output.push(node);for(const child of node.children)visit(child);};visit(body);return output;};
  const click=text=>{const button=buttons().find(button=>button.textContent.includes(text));assert.ok(button,'Missing context command: '+text);assert.equal(button.disabled,false,text+' is disabled');button.click();};
  return {window,commands,events,body,emit,buttons,click};
}
const cmd=(text,id,extra={})=>({text,commandId:id,enabled:true,name:text.replace(/\W/g,''),...extra});
test('01 right click on image exposes native Copy Image that runs WebView2 command ID',()=>{
  const h=harness();
  h.emit({kind:'image',sourceUrl:'https://example.com/image.png',
    nativeItems:[cmd('Copy Image',121,{name:'copyImage'}),cmd('Save Image As…',122,{name:'saveImageAs'})]});
  h.click('Copy Image');
  assert.ok(h.commands.some(c=>c.name==='site-context-select'&&c.payload.requestId===42&&c.payload.commandId===121));
  assert.ok(!h.commands.some(c=>c.name==='site-context-copy'),'Copy Image must not be a URL text copy');
});
test('02 save image uses native command even when URI is data/blob',()=>{
  const h=harness();
  h.emit({kind:'image',sourceUrl:'blob:https://example.com/asset',
    nativeItems:[cmd('Save Image As…',201,{name:'saveImageAs'})]});
  h.click('Save Image As');
  assert.ok(h.commands.some(c=>c.name==='site-context-select'&&c.payload.commandId===201));
});
test('03 linked image preserves both image and link commands',()=>{
  const h=harness();
  h.emit({kind:'image',linkUrl:'https://example.com/article',
    nativeItems:[cmd('Copy Image',31,{name:'copyImage'}),cmd('Copy Link',32,{name:'copyLink'})]});
  assert.ok(h.buttons().some(x=>x.textContent.includes('Copy Image')));
  h.click('Copy Link');
  assert.ok(h.commands.some(x=>x.payload?.commandId===32));
});
test('04 selected text exposes Copy and Search actions from engine',()=>{
  const h=harness();
  h.emit({kind:'selection',selection:'selected words',
    nativeItems:[cmd('Copy',51,{name:'copy'}),cmd('Search Web',52,{name:'searchWeb'})]});
  h.click('Search Web');
  assert.ok(h.commands.some(x=>x.payload?.commandId===52));
});
test('05 editable input shows native Cut Copy Paste and Undo',()=>{
  const h=harness();
  h.emit({editable:true,nativeItems:[
    cmd('Undo',61,{name:'undo'}),cmd('Cut',62,{name:'cut'}),
    cmd('Copy',63,{name:'copy'}),cmd('Paste',64,{name:'paste'})]});
  assert.ok(['Undo','Cut','Copy','Paste'].every(text=>h.buttons().some(b=>b.textContent===text)));
  h.click('Paste');
  assert.ok(h.commands.some(x=>x.payload?.commandId===64));
});
test('06 spellcheck submenu works and preserves nested suggestion command',()=>{
  const h=harness();
  h.emit({editable:true,nativeItems:[{
    text:'Spelling Suggestions',name:'spellCheck',enabled:true,
    items:[cmd('Recommendation',75,{name:'spellCheck'}),{separator:true},cmd('Add to Dictionary',76,{name:'addToDictionary'})]
  }]});
  h.click('Recommendation');
  assert.ok(h.commands.some(x=>x.payload?.commandId===75));
});
test('07 video controls execute original media command',()=>{
  const h=harness();
  h.emit({kind:'video',nativeItems:[
    cmd('Play',81,{name:'play'}),cmd('Picture in Picture',82,{name:'pictureInPicture'}),
    cmd('Save Video As…',83,{name:'saveVideoAs'})]});
  h.click('Picture in Picture');
  assert.ok(h.commands.some(x=>x.payload?.commandId===82));
});
test('08 audio controls are preserved',()=>{
  const h=harness();
  h.emit({kind:'audio',nativeItems:[cmd('Mute',91,{name:'mute'}),cmd('Save Audio As…',92,{name:'saveAudioAs'})]});
  h.click('Save Audio As');
  assert.ok(h.commands.some(x=>x.payload?.commandId===92));
});
test('09 disabled native command cannot be invoked',()=>{
  const h=harness();
  h.emit({kind:'image',nativeItems:[cmd('Copy Image',101,{enabled:false,name:'copyImage'})]});
  const button=h.buttons().find(x=>x.textContent==='Copy Image');
  assert.ok(button?.disabled);
  assert.equal(h.commands.some(c=>c.name==='site-context-select'&&c.payload.commandId===101),false);
});
test('10 dismissal and next context request never execute a stale command',()=>{
  const h=harness();
  h.emit({nativeItems:[cmd('Copy Image',111,{name:'copyImage'})]});
  h.emit({kind:'video',requestId:43,nativeItems:[cmd('Play',112,{name:'play'})]});
  assert.ok(h.commands.some(c=>c.name==='site-context-select'&&c.payload.requestId===42&&c.payload.commandId===null));
  h.click('Play');
  assert.ok(h.commands.some(c=>c.name==='site-context-select'&&c.payload.requestId===43&&c.payload.commandId===112));
  assert.equal(h.commands.some(c=>c.payload?.commandId===111),false);
});
