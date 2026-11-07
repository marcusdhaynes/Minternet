'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const script=read('ui/tab-layout-settings.js');
const css=read('ui/styles.css');
const html=read('ui/index.html');

function harness(backing=new Map()){
  const values=new Map();
  const classNames=new Set();
  const elements={};
  for(const id of ['groupTabWidth','regularTabWidth','pinnedTabWidth',
    'groupTabPadding','regularTabPadding','pinnedTabPadding',
    'showTabBarAppIcon','resetTabWidths']){
    elements[id]={
      value:'',checked:true,handlers:{},
      addEventListener(name,fn){this.handlers[name]=fn;},
      fire(name){this.handlers[name]?.();}
    };
  }
  const listeners={};
  const storage={
    getItem:key=>backing.get(key)??null,
    setItem:(key,value)=>backing.set(key,value)
  };
  const root={
    style:{setProperty:(key,value)=>values.set(key,value)},
    classList:{
      toggle:(name,enabled)=>enabled?classNames.add(name):classNames.delete(name),
      contains:name=>classNames.has(name)
    }
  };
  const window={
    addEventListener:(name,fn)=>{listeners[name]=fn;}
  };
  vm.runInNewContext(script,{
    document:{documentElement:root,getElementById:id=>elements[id]},
    localStorage:storage,window,Number,JSON,String,Math
  });
  return {elements,values,classNames,storage,listeners,backing,window};
}

test('three independent pixel widths apply immediately and survive a restart',()=>{
  const h=harness();
  assert.equal(h.values.get('--minternet-group-tab-width'),'56px');
  assert.equal(h.values.get('--minternet-regular-tab-width'),'38px');
  assert.equal(h.values.get('--minternet-pinned-tab-width'),'27px');
  assert.equal(h.values.get('--minternet-group-tab-padding'),'5px');
  assert.equal(h.values.get('--minternet-regular-tab-padding'),'2px');
  assert.equal(h.values.get('--minternet-pinned-tab-padding'),'2px');
  h.elements.groupTabWidth.value='92';h.elements.groupTabWidth.fire('input');
  h.elements.regularTabWidth.value='120';h.elements.regularTabWidth.fire('input');
  h.elements.pinnedTabWidth.value='42';h.elements.pinnedTabWidth.fire('input');
  assert.deepEqual([...h.values],[
    ['--minternet-group-tab-width','92px'],
    ['--minternet-regular-tab-width','120px'],
    ['--minternet-pinned-tab-width','42px'],
    ['--minternet-group-tab-padding','5px'],
    ['--minternet-regular-tab-padding','2px'],
    ['--minternet-pinned-tab-padding','2px']
  ]);
  const saved=JSON.parse(h.backing.get('minternet.tab-layout.v1'));
  assert.equal(saved.group,92);assert.equal(saved.regular,120);assert.equal(saved.pinned,42);
  const restarted=harness(h.backing);
  assert.equal(restarted.elements.groupTabWidth.value,'92');
  assert.equal(restarted.elements.regularTabWidth.value,'120');
  assert.equal(restarted.elements.pinnedTabWidth.value,'42');
});

test('app icon toggle reclaims the left tab-bar space and persists',()=>{
  const h=harness();
  assert.equal(h.classNames.has('minternet-app-icon-hidden'),false);
  h.elements.showTabBarAppIcon.checked=false;
  h.elements.showTabBarAppIcon.fire('change');
  assert.equal(h.classNames.has('minternet-app-icon-hidden'),true);
  assert.equal(JSON.parse(h.backing.get('minternet.tab-layout.v1')).showAppIcon,false);
  assert.equal(harness(h.backing).classNames.has('minternet-app-icon-hidden'),true);
  h.elements.showTabBarAppIcon.checked=true;
  h.elements.showTabBarAppIcon.fire('change');
  assert.equal(h.classNames.has('minternet-app-icon-hidden'),false);
  assert.match(css,/:root\.minternet-app-icon-hidden \.tab-row > \.identity\s*\{\s*display:none!important;/);
  assert.match(css,/:root\.minternet-app-icon-hidden \.tab-row > #tabGroups\s*\{left:3px;/);
  assert.match(css,/:root\.minternet-app-icon-hidden \.tab-row > \.tabs\s*\{margin-left:25px;/);
});

test('invalid inputs cannot corrupt tab widths; reset restores defaults without changing icon',()=>{
  const h=harness();
  h.elements.groupTabWidth.value='10000';h.elements.groupTabWidth.fire('input');
  assert.equal(h.values.get('--minternet-group-tab-width'),'56px');
  h.elements.groupTabWidth.fire('change');
  assert.equal(h.elements.groupTabWidth.value,'320');
  h.elements.regularTabWidth.value='bad';h.elements.regularTabWidth.fire('change');
  assert.equal(h.elements.regularTabWidth.value,'38');
  h.elements.pinnedTabWidth.value='1';h.elements.pinnedTabWidth.fire('change');
  assert.equal(h.elements.pinnedTabWidth.value,'24');
  h.elements.showTabBarAppIcon.checked=false;h.elements.showTabBarAppIcon.fire('change');
  h.elements.resetTabWidths.fire('click');
  assert.equal(h.elements.groupTabWidth.value,'56');
  assert.equal(h.elements.regularTabWidth.value,'38');
  assert.equal(h.elements.pinnedTabWidth.value,'27');
  assert.equal(h.elements.groupTabPadding.value,'5');
  assert.equal(h.elements.regularTabPadding.value,'2');
  assert.equal(h.elements.pinnedTabPadding.value,'2');
  assert.equal(h.classNames.has('minternet-app-icon-hidden'),true);
});

test('CSS overrides late icon-only and pinned width rules with independent variables',()=>{
  const marker=css.indexOf('/* User-controlled tab geometry.');
  const older=css.indexOf('.tabs .tab:not(.group-end-cap)');
  assert(marker>older);
  assert.match(css.slice(marker),/\.tabs \.group-chip\s*\{\s*--group-chip-width:var\(--minternet-group-tab-width\);/);
  assert.match(css.slice(marker),/\.tabs \.tab:not\(\.group-end-cap\):not\(\.pinned-tab\)/);
  assert.match(css.slice(marker),/flex:0 0 var\(--minternet-regular-tab-width\)!important;/);
  assert.match(css.slice(marker),/\.tabs \.tab.pinned-tab\s*\{/);
  assert.match(css.slice(marker),/flex:0 0 var\(--minternet-pinned-tab-width\)!important;/);
  for(const id of ['groupTabWidth','regularTabWidth','pinnedTabWidth',
    'groupTabPadding','regularTabPadding','pinnedTabPadding',
    'showTabBarAppIcon','resetTabWidths'])assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(html,/src="\.\/tab-layout-settings\.js" defer/);
});

test('per-tab horizontal padding applies immediately, persists and clamps independently',()=>{
  const h=harness();
  h.elements.groupTabPadding.value='13';h.elements.groupTabPadding.fire('input');
  h.elements.regularTabPadding.value='4';h.elements.regularTabPadding.fire('input');
  h.elements.pinnedTabPadding.value='6';h.elements.pinnedTabPadding.fire('input');
  assert.equal(h.values.get('--minternet-group-tab-padding'),'13px');
  assert.equal(h.values.get('--minternet-regular-tab-padding'),'4px');
  assert.equal(h.values.get('--minternet-pinned-tab-padding'),'6px');
  const saved=JSON.parse(h.backing.get('minternet.tab-layout.v1'));
  assert.equal(saved.group,56);
  assert.equal(saved.groupPadding,13);
  assert.equal(saved.regularPadding,4);
  assert.equal(saved.pinnedPadding,6);
  const next=harness(h.backing);
  assert.equal(next.elements.groupTabPadding.value,'13');
  assert.equal(next.elements.regularTabPadding.value,'4');
  assert.equal(next.elements.pinnedTabPadding.value,'6');
  h.elements.pinnedTabPadding.value='1000';h.elements.pinnedTabPadding.fire('input');
  assert.equal(h.values.get('--minternet-pinned-tab-padding'),'6px');
  h.elements.pinnedTabPadding.fire('change');
  assert.equal(h.elements.pinnedTabPadding.value,'64');
  h.elements.groupTabPadding.value='-2';h.elements.groupTabPadding.fire('change');
  assert.equal(h.elements.groupTabPadding.value,'0');
  h.elements.resetTabWidths.fire('click');
  assert.equal(h.values.get('--minternet-group-tab-padding'),'5px');
  assert.equal(h.values.get('--minternet-regular-tab-padding'),'2px');
  assert.equal(h.values.get('--minternet-pinned-tab-padding'),'2px');
});

test('previously saved width-only profiles gain padding defaults without losing existing values',()=>{
  const store=new Map([['minternet.tab-layout.v1',JSON.stringify({group:74,regular:56,pinned:34,showAppIcon:false})]]);
  const h=harness(store);
  assert.equal(h.elements.groupTabWidth.value,'74');
  assert.equal(h.elements.regularTabWidth.value,'56');
  assert.equal(h.elements.pinnedTabWidth.value,'34');
  assert.equal(h.elements.groupTabPadding.value,'5');
  assert.equal(h.elements.regularTabPadding.value,'2');
  assert.equal(h.elements.pinnedTabPadding.value,'2');
  assert.equal(h.classNames.has('minternet-app-icon-hidden'),true);
});

test('tab-appearance controls are a three-row table with equal-side padding applied by CSS',()=>{
  const section=html.slice(html.indexOf('<section class="tab-layout-settings"'));
  assert.match(section,/<table class="tab-size-table"/);
  assert.match(section,/<th scope="col">Tab<\/th><th scope="col">Width<\/th><th scope="col">Padding<\/th>/);
  for(const name of ['Group','Regular','Pinned'])assert.match(section,new RegExp('<th scope="row">'+name+'<\\/th>'));
  const geometry=css.slice(css.indexOf('/* User-controlled tab geometry.'));
  for(const kind of ['group','regular','pinned']) {
    assert.match(geometry,new RegExp('--minternet-'+kind+'-tab-padding'));
    assert.match(geometry,new RegExp('padding-left:var\\(--minternet-'+kind+'-tab-padding\\)!important;'));
    assert.match(geometry,new RegExp('padding-right:var\\(--minternet-'+kind+'-tab-padding\\)!important;'));
  }
});
