'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

function fixture(saved=null){
  const values=new Map();
  if(saved!==null)values.set('minternet.bookmark-folder-appearance.v1',saved);
  const nodes=new Map();
  const ids=['bookmarkFolderBevel','bookmarkFolderGloss','bookmarkFolderGlass',
    'bookmarkFolderTintEnabled','bookmarkFolderTintColor','bookmarkFolderAppearanceReset'];
  for(const id of ids){
    const events=new Map();
    nodes.set(id,{checked:false,value:'#b99cff',
      addEventListener(name,fn){events.set(name,fn);},
      fire(name){events.get(name)?.({target:this});}});
  }
  const flags=new Set(),variables=new Map(),listeners=new Map();
  const win={addEventListener(name,fn){listeners.set(name,fn);},
    dispatchEvent(){},CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail;}}};
  const global={
    document:{documentElement:{
      classList:{toggle(name,yes){if(yes)flags.add(name);else flags.delete(name);}},
      style:{setProperty(name,value){variables.set(name,value);}}
    },getElementById:id=>nodes.get(id)},
    localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},
    window:win,CustomEvent:win.CustomEvent
  };
  vm.runInNewContext(read('ui/bookmark-folder-appearance.js'),global);
  return {nodes,flags,variables,values,win,
    get:()=>win.minternetFolderAppearance.get()};
}

test('folder appearance is opt-in and has disabled effects by default',()=>{
  const f=fixture();
  assert.deepEqual(JSON.parse(JSON.stringify(f.get())),
    {bevel:false,gloss:false,glass:false,tint:false,color:'#b99cff'});
  assert.equal(f.flags.has('minternet-folder-style-active'),false);
});
test('toggle bevel gloss glass independently and keep tint inside circular input',()=>{
  const f=fixture();
  for(const [id,key] of [
    ['bookmarkFolderBevel','bevel'],['bookmarkFolderGloss','gloss'],
    ['bookmarkFolderGlass','glass']]){
    f.nodes.get(id).checked=true;f.nodes.get(id).fire('change');
    assert.equal(f.get()[key],true);
    assert.equal(f.flags.has('minternet-folder-style-'+key),true);
  }
  f.nodes.get('bookmarkFolderTintColor').value='#27a4f0';
  f.nodes.get('bookmarkFolderTintColor').fire('input');
  assert.equal(f.get().tint,true);
  assert.equal(f.variables.get('--minternet-folder-art-color'),'#27a4f0');
  assert.equal(f.flags.has('minternet-folder-style-active'),true);
  assert.equal(JSON.parse(f.values.get('minternet.bookmark-folder-appearance.v1')).color,'#27a4f0');
  f.nodes.get('bookmarkFolderAppearanceReset').fire('click');
  assert.equal(f.flags.has('minternet-folder-style-active'),false);
  assert.equal(f.get().color,'#b99cff');
});
test('previously saved settings restore and invalid values do not corrupt appearance',()=>{
  const f=fixture(JSON.stringify({bevel:true,gloss:true,glass:false,tint:true,color:'#112233'}));
  assert.equal(f.get().bevel,true);
  assert.equal(f.get().color,'#112233');
  const unsafe=fixture(JSON.stringify({bevel:'yes',tint:1,color:'javascript:red'}));
  assert.equal(unsafe.get().bevel,false);
  assert.equal(unsafe.get().tint,false);
  assert.equal(unsafe.get().color,'#b99cff');
});
test('bookmark folder default artwork is opt-in without changing saved icon bytes',()=>{
  const ui=read('ui/bookmark-ui.js');
  const html=read('ui/index.html');
  assert.match(ui,/slot\.classList\.add\('bookmark-folder-default'\)/);
  assert.match(ui,/slot\.classList\.add\('bookmark-folder-custom'\)/);
  assert.match(ui,/if\(isFolder && \(!value \|\| value==='📁'\)\)/);
  for(const id of ['bookmarkFolderBevel','bookmarkFolderGloss','bookmarkFolderGlass',
    'bookmarkFolderTintEnabled','bookmarkFolderTintColor']){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/src="\.\/bookmark-folder-appearance\.js"/);
  assert.match(read('ui/settings-sections.js'),/move\(appearance,'bookmarkFolderAppearance'\)/);
});
test('tab X is positioned and clipped inside compact regular tab border',()=>{
  const css=read('ui/styles.css');
  assert.match(css,/\/\* Tab X containment:/);
  assert.match(css,/\.tabs \.tab:not\(\.pinned-tab\):not\(\.split-supertab\)\{/);
  assert.match(css,/box-sizing:border-box!important;\s*overflow:hidden;/);
  const close=css.slice(css.lastIndexOf('.tabs .tab:not(.pinned-tab):not(.split-supertab) .tab-close{'));
  assert.match(close,/position:absolute!important;/);
  assert.match(close,/right:1px!important;/);
  assert.match(close,/width:12px!important;/);
  assert.match(close,/overflow:hidden;/);
  assert.match(css,/\.tabs \.tab\.pinned-tab \.tab-choose/);
});
