'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const supertab=require('../ui/supertab.js');

test('2, 3 and 4-way supertab icon order follows real screen geometry',()=>{
 assert.deepEqual(supertab.ordered([10,20],false),[10,20]);
 assert.deepEqual(supertab.ordered([10,20,30],false),[10,20,30]);
 // Left side is split: top-left, right full-height, bottom-left.
 assert.deepEqual(supertab.ordered([10,30,20],true),[10,20,30]);
 assert.deepEqual(supertab.ordered([10,20,30,40],false),[10,20,30,40]);
 // Reject stale/duplicate native pane IDs.
 assert.deepEqual(supertab.ordered([10,10],false),[]);
 assert.deepEqual(supertab.ordered([10],false),[]);
 assert.deepEqual(supertab.ordered([1,2,3,4,5],false),[]);
 assert.deepEqual(supertab.ordered(['1',2],false),[]);
});

test('supertab icon buttons are individually focusable, clickable and have separators',()=>{
 const previous=global.document;
 const createElement=tag=>{
   const handlers={};
   const element={
     tagName:tag,children:[],dataset:{},attributes:{},
     setAttribute(k,v){this.attributes[k]=v;},
     append(child){this.children.push(child);},
     addEventListener(k,fn){handlers[k]=fn;},
     fire(k,e){handlers[k]?.(e);},
     className:'',title:'',draggable:false
   };
   return element;
 };
 global.document={createElement};
 try{
   const changes=[],context=[],icons=[];
   const tabs=[{id:10,title:'Top'},{id:20,title:'Right'},{id:30,title:'Bottom'}];
   const root=supertab.build(tabs,20,(tab,slot)=>icons.push(tab.id),
     id=>changes.push(id),(id,point)=>context.push([id,point]));
   assert.equal(root.children.length,5);
   assert.equal(root.children.filter(x=>x.className==='split-super-divider').length,2);
   assert.deepEqual(icons,[10,20,30]);
   assert.equal(root.children[2].className,'split-super-pane current');
   let stopped=0;
   root.children[4].fire('click',{stopPropagation(){stopped++;}});
   root.children[0].fire('contextmenu',{
     preventDefault(){stopped++;},stopPropagation(){stopped++;},clientX:75,clientY:90
   });
   assert.deepEqual(changes,[30]);
   assert.deepEqual(context,[[10,{x:75,y:90}]]);
   assert.equal(stopped,3);
   assert.deepEqual(root.dataset.splitTabIds,'10,20,30');
   assert.equal(root.dataset.tabId,'10');
   root.fire('click',{target:root});
   assert.deepEqual(changes,[30,20]);
 }finally{global.document=previous;}
});

test('native snapshots, groups and tab menus treat panes as exactly one supertab',()=>{
 const native=read('native/desktop/src-tauri/src/main.rs');
 const group=read('ui/tab-group-ui.js');
 const menu=read('ui/chrome-native-menu.js');
 const html=read('ui/index.html');
 const layout=read('ui/tab-layout-settings.js');
 const css=read('ui/styles.css');
 assert.match(native,/split_ids: Vec<u32>/);
 assert.match(native,/split_left: bool/);
 assert.match(native,/state\.split_ids=if ids\.len\(\)>1/);
 assert.match(group,/MinternetSuperTab\.build\(splitTabs/);
 assert.match(group,/!splitSet\.has\(t\.id\)/);
 assert.match(group,/const members=allMembers\.filter\(t=>!splitSet\.has\(t\.id\)\)/);
 assert.match(group,/attachTabMenu\(superNode,splitTabs\[0\]\.id\)/);
 assert.match(group,/const containsSuper=splitGroup\?\.id===g\.id/);
 assert.match(group,/node\.classList\.add\('group-member'\)/);
 assert.match(group,/supertabMembers\(finished\.id\)\.length===1/);
 assert.match(group,/model\.moveBlockRelative\(state,ids,last\.id,true\)/);
 assert.match(group,/model\.assignMany\(state,ids,groupId\)/);
 assert.match(group,/splitSet\.has\(tab\.id\)/);
 assert.match(menu,/#tabs \.split-super-pane\[data-tab-id\]/);
 assert.match(html,/src="\.\/supertab\.js"/);
 for(const id of ['supertabIconGap','supertabSidePadding']){
   assert.match(html,new RegExp('id="'+id+'"'));
   assert.match(layout,new RegExp("id:'"+id+"'"));
 }
 assert.match(css,/\.tabs \.tab\.split-supertab/);
 assert.match(css,/\.split-super-divider/);
 assert.match(css,/--minternet-supertab-gap/);
 assert.match(css,/--minternet-supertab-padding/);
});

test('super tabs drag from the full surface and render as one item inside groups',()=>{
 const widget=read('ui/supertab.js');
 const group=read('ui/tab-group-ui.js');
 const css=read('ui/styles.css');
 assert.match(widget,/node\.dataset\.tabId=String\(tabs\[0\]\.id\)/);
 assert.match(group,/tabStrip\.addEventListener\('pointerdown',beginPointer\)/);
 assert.match(group,/const tab=event\.target\.closest\('\.tab\[data-tab-id\]'\)/);
 assert.match(group,/attachTabMenu\(superNode,splitTabs\[0\]\.id\)/);
 assert.match(css,/\.tabs \.tab\.split-supertab,\.tabs \.split-supertab \.split-super-pane\{/);
 assert.match(css,/cursor:grab;user-select:none/);
 assert.match(group,/const visualMembers=containsSuper\?\[\.\.\.members,splitTabs\[0\]\]:members/);
 assert.match(group,/const node=takeSuper\(\)/);
});

test('split pane badge is flush, compact, and supports captured drag back to the tab strip',()=>{
 const native=read('native/desktop/src-tauri/src/main.rs');
 const badge=read('ui/split-badge.js'),css=read('ui/split-badge.css');
 assert.match(native,/let position=LogicalPosition::new\(x,y\);/);
 assert.match(native,/LogicalSize::new\(w.min\(104.0\).max\(1.0\),16.0\)/);
 assert.match(css,/\.split-badge\{[^}]*height:16px;[^}]*opacity:\.38/);
 assert.match(badge,/setPointerCapture\(event.pointerId\)/);
 assert.match(badge,/send\('drop\?x='/);
 assert.match(badge,/else send\('focus'\)/);
 assert.match(native,/window.inner_position\(\)/);
 assert.match(native,/split_badge_drop_in_strip\(local_x,local_y,width\)/);
 assert.match(native,/split_badge_drop_in_strip\(px\+x,py\+y,width\)/);
 assert.match(native,/if browser.active_id==id \{browser.active_id=next;\}/);
});

test('native pane focus changes the active tab without navigating or stealing focus from the toolbar',()=>{
 const native=read('native/desktop/src-tauri/src/main.rs');
 const focus=native.slice(native.indexOf('fn focus_split_pane('),native.indexOf('fn return_split_pane('));
 assert.match(focus,/!split.contains\(&browser.active_id\)/);
 assert.match(focus,/!split.contains\(&id\)/);
 assert.match(focus,/browser.active_id=id/);
 assert.match(focus,/notify\(app\)/);
 assert.match(focus,/controller.add_GotFocus/);
 assert.doesNotMatch(focus,/navigate_tab\(|display_active\(|set_focus\(/);
 assert.match(native,/attach_split_pane_focus\(app,id,&created\)/);
 assert.match(native,/"reload" => \{\s*let \(id,url,label\)=\{[\s\S]*?b.active\(\)/);
});
