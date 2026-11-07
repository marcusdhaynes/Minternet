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
  const flags={folderEdits:0,groupVisibility:0,tabPins:0,opened:[],deleted:[],edited:[]};
  const tabs=[{id:1,title:'Example',url:'https://example.com/',pinned:false}];
  const window={
    MinternetBookmarks:bm,
    MinternetGroupModel:gm,
    minternetBookmarks:{
      getState:()=>bookmarks,
      edit:id=>{flags.folderEdits++;flags.edited.push(id);},
      deleteBookmark:id=>{flags.deleted.push(id);return true;},
      openInNewTab:id=>{flags.opened.push(id);return true;},
      newFolder:()=>{},savePage:()=>{},
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
test('Bookmark Bar context never includes Tab Groups',()=>{
 const h=harness();
 const bar=h.window.minternetMenus.inspectBar();
 assert.ok(!bar.some(x=>x.text?.includes('Tab Groups')));
 assert.ok(bar.some(x=>x.text?.includes('New Folder')));
});
test('folder menu actions target the correct folder, without executable URLs',()=>{
 const h=harness();
 const items=h.window.minternetMenus.inspectFolder(h.root.id);
 items.find(x=>x.text?.includes('Folder Properties')).action();
 assert.equal(h.flags.folderEdits,1);
 assert.equal(bm.find(h.bookmarks,h.sub.id).children[0].url,'https://example.com/');
});

test('context tab menu pins and unpins a real tab without closing it',()=>{
  const h=harness();
  const menu=h.window.minternetMenus.inspectTabQuick(1);
  const pin=menu.find(i=>i.title?.includes('Pin Tab'));
  assert.ok(pin);
  pin.action();
  assert.equal(h.flags.tabPins,1);
  assert.ok(h.window.minternetMenus.inspectTabQuick(1).some(i=>i.title?.includes('Unpin Tab')));
});
test('folder and subfolder context menus do not offer Bookmark This Page',()=>{
 const h=harness();
 for(const id of [h.root.id,h.sub.id]){
  const entries=h.window.minternetMenus.inspectFolder(id);
  assert.equal(entries.some(x=>x.text?.includes('Bookmark This Page')),false);
 }
 const folderContext=h.window.minternetMenus.inspectBar();
 assert.equal(folderContext.some(x=>x.text?.includes('Tab Groups')),false);
});

test('blank tab strip creates a standalone group, without borrowing an active tab',()=>{
  const h=harness();
  let args;
  h.window.minternetGroups.openEditor=(...values)=>{args=values;};
  const menu=h.window.minternetMenus.inspectEmptyTabBar();
  const create=menu.find(entry=>entry.text?.includes('New Group'));
  assert.ok(create);
  assert.equal(menu.some(entry=>entry.text?.includes('With This Tab')),false);
  create.action();
  assert.deepEqual(args,[null,false]);
});
test('right-clicking an actual tab directly offers a new group containing it',()=>{
  const h=harness();
  let args;
  h.window.minternetGroups.openEditor=(...values)=>{args=values;};
  const menu=h.window.minternetMenus.inspectTab(1);
  const create=menu.find(entry=>entry.text?.includes('New Group With This Tab'));
  assert.ok(create,'New Group With This Tab should be a direct action');
  create.action();
  assert.deepEqual(args,[null,1]);
});

test('right-clicked bookmark gets background tab, rename, and delete actions without groups',()=>{
 const h=harness();
 const leaf=bm.find(h.bookmarks,h.sub.id).children[0];
 const menu=h.window.minternetMenus.inspectBookmark(leaf.id);
 assert.ok(!menu.some(x=>x.text?.includes('Tab Groups')));
 const action=text=>menu.find(x=>x.text?.includes(text))?.action();
 action('Open in New Tab');action('Edit Name');action('Delete Bookmark');
 assert.equal(h.flags.opened[0],leaf.id);
 assert.equal(h.flags.edited[0],leaf.id);
 assert.equal(h.flags.deleted[0],leaf.id);
});
test('right-clicked folder supports editing its name and deletion',()=>{
 const h=harness();
 const menu=h.window.minternetMenus.inspectBookmark(h.root.id);
 menu.find(x=>x.text?.includes('Edit Name')).action();
 menu.find(x=>x.text?.includes('Delete Folder')).action();
 assert.equal(h.flags.edited[0],h.root.id);
 assert.equal(h.flags.deleted[0],h.root.id);
 assert.ok(!menu.some(x=>x.text?.includes('Tab Groups')));
});

test('Pin Tab and Unpin Tab are visible direct right-click actions',()=>{
 const h=harness();
 const normal=h.window.minternetMenus.inspectTab(1);
 const pin=normal.find(entry=>entry.text?.includes('Pin Tab'));
 assert.ok(pin,'Pin Tab must be visible in the main tab context menu');
 pin.action();
 assert.equal(h.flags.tabPins,1);
 const pinned=h.window.minternetMenus.inspectTab(1);
 const unpin=pinned.find(entry=>entry.text?.includes('Unpin Tab'));
 assert.ok(unpin,'A pinned tab must offer Unpin Tab directly');
 unpin.action();
 assert.equal(h.flags.tabPins,2);
 assert.equal(h.window.minternetGroups.getLatest().tabs.length,1);
 assert.equal(h.window.minternetGroups.getLatest().tabs[0].pinned,false);
});

test('Secret tabs cannot be pinned from browser menus',()=>{
 const h=harness();
 h.window.minternetGroups.getLatest().tabs[0].secretTab=true;
 const normal=h.window.minternetMenus.inspectTab(1);
 assert.ok(normal.some(entry=>entry.enabled===false&&entry.text?.includes('cannot be pinned')));
 assert.equal(normal.some(entry=>entry.action&&entry.text?.includes('Pin Tab')),false);
 assert.equal(h.window.minternetMenus.inspectTabQuick(1).some(entry=>entry.title?.includes('Pin Tab')),false);
});
