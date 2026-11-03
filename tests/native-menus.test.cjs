'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const bm=require('../ui/bookmark-model.js');
const gm=require('../ui/tab-group-model.js');

function harness() {
  const bookmarks=bm.blank(),root=bm.add(bookmarks,'folder',null,{name:'',icon:'🌿'});
  const sub=bm.add(bookmarks,'folder',root.id,{name:'Projects',icon:'🪐'});
  bm.add(bookmarks,'link',sub.id,{name:'Example',url:'https://example.com'});
  const groups=gm.blank(),g=gm.create(groups,{name:'Research',color:'teal'});
  const flags={folderEdits:0,groupVisibility:0,tabPins:0};
  const tabs=[{id:1,title:'Example',url:'https://example.com/',pinned:false}];
  const window={
    MinternetBookmarks:bm,
    MinternetGroupModel:gm,
    minternetBookmarks:{
      getState:()=>bookmarks,
      edit:()=>{flags.folderEdits++}, newFolder:()=>{},savePage:()=>{},
      openLink:()=>{}, manager:()=>{}, toggleBookmark:()=>{},toggleBar:()=>{}
    },
    minternetGroups:{
      getState:()=>groups, get:id=>gm.get(groups,id), displayName:x=>x.name,
      toggleVisible:id=>{flags.groupVisibility++;gm.update(groups,id,{visible:!gm.get(groups,id).visible})},
      openEditor:()=>{},assign:()=>{},toggleCollapsed:()=>{},removeGroup:()=>{},
      pin:(id,yes)=>{flags.tabPins++;tabs.find(x=>x.id===id).pinned=yes;},
      getLatest:()=>({activeId:1,tabs})
    }
  };
  const context={window, document:{getElementById:()=>null},console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/chrome-native-menu.js'),'utf8'),context);
  return {window,bookmarks,groups,root,sub,g,flags};
}
test('bookmarks popup contains native-style cascading submenus from folder',()=>{
 const h=harness();
 const items=h.window.minternetMenus.inspectFolder(h.root.id);
 const nested=items.find(x=>Array.isArray(x.items));
 assert.ok(nested,'A nested folder must become an OS submenu');
 assert.match(nested.text,/Projects/);
 assert.match(nested.text,/🪐/);
 assert.ok(nested.items.some(x=>x.text?.includes('Example')));
 assert.ok(items.some(x=>x.text?.includes('New Subfolder')));
 assert.ok(items.some(x=>x.text?.includes('Folder Properties')));
});
test('Bookmark Bar context has Tab Groups eyes on the right',()=>{
 const h=harness();
 const bar=h.window.minternetMenus.inspectBar();
 const tabGroups=bar.find(x=>x.text?.includes('Tab Groups'));
 assert.ok(tabGroups && Array.isArray(tabGroups.items));
 const entry=tabGroups.items.find(x=>x.text?.includes('Research'));
 assert.ok(entry);
 assert.match(entry.text,/👁$/u);
 entry.action();
 assert.equal(h.flags.groupVisibility,1);
 assert.equal(h.window.minternetMenus.inspectBar().find(x=>x.text?.includes('Tab Groups')).items.find(x=>x.text?.includes('Research')).text.includes('👁̸'),true);
});
test('folder menu actions target the correct folder, without executable URLs',()=>{
 const h=harness();
 const items=h.window.minternetMenus.inspectFolder(h.root.id);
 items.find(x=>x.text?.includes('Folder Properties')).action();
 assert.equal(h.flags.folderEdits,1);
 assert.equal(h.bookmarks.items[0].children[0].children[0].url,'https://example.com/');
});

test('context tab menu pins and unpins a real tab without closing it',()=>{
  const h=harness();
  const menu=h.window.minternetMenus.inspectTab(1);
  const pin=menu.find(i=>i.text?.includes('Pin Tab'));
  assert.ok(pin);
  pin.action();
  assert.equal(h.flags.tabPins,1);
  assert.ok(h.window.minternetMenus.inspectTab(1).some(i=>i.text?.includes('Unpin Tab')));
});
test('folder and subfolder context menus do not offer Bookmark This Page',()=>{
 const h=harness();
 for(const id of [h.root.id,h.sub.id]){
  const entries=h.window.minternetMenus.inspectFolder(id);
  assert.equal(entries.some(x=>x.text?.includes('Bookmark This Page')),false);
 }
 const folderContext=h.window.minternetMenus.inspectBar();
 const group=folderContext.find(x=>x.text?.includes('Tab Groups'));
 assert.ok(group);
});
