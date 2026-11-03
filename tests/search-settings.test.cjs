'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function run(initial=null){
  const data=new Map(initial ? [['minternet.search-engine.v1',initial]]:[]);
  const listeners={};
  const select={value:'',addEventListener:(type,fn)=>{listeners[type]=fn;}};
  const window={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/search-settings.js'),'utf8'),{
    window,document:{getElementById:id=>id==='defaultSearchEngine'?select:null},
    localStorage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}
  });
  return {window,select,listeners,data};
}
test('search engine defaults to Google and persists selected alternative',()=>{
 const s=run();
 assert.equal(s.window.minternetSearch.getEngine(),'google');
 s.select.value='brave';s.listeners.change();
 assert.equal(s.window.minternetSearch.getEngine(),'brave');
 assert.equal(s.data.get('minternet.search-engine.v1'),'brave');
});
test('unknown stored search providers revert to Google safely',()=>{
 const s=run('https://untrusted.invalid');
 assert.equal(s.window.minternetSearch.getEngine(),'google');
 assert.equal(s.window.minternetSearch.setEngine('startpage'),'startpage');
 assert.equal(s.window.minternetSearch.setEngine('evil'),'google');
});
