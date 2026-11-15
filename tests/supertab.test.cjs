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
 assert.match(group,/!splitSet\.has\(tab\.id\)/);
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
