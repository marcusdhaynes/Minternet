'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=pathFromRoot=>fs.readFileSync(path.join(__dirname,'..',pathFromRoot),'utf8');
const main=read('native/desktop/src-tauri/src/main.rs');
const health=read('native/desktop/src-tauri/src/render_visual.rs');
const ui=read('ui/startup-curtain.js');
const html=read('ui/index.html');
const css=read('ui/styles.css');
function harness(armed=true){
 const classes=new Set();
 const callbacks=[];
 const timers=new Map();
 const actions=[];
 const nodes={
   startupCurtain:{
     style:{},attributes:{},getBoundingClientRect:()=>({width:1200,height:700}),
     setAttribute(k,v){this.attributes[k]=v;}
   },
   startupCurtainStatus:{textContent:''},
   startupCurtainRetry:{
     hidden:true,disabled:false,handlers:{},
     addEventListener(type,handler){this.handlers[type]=handler;}
   }
 };
 let nextTimer=1;
 const document={
   documentElement:{classList:{
     add:v=>classes.add(v),remove:v=>classes.delete(v),
     contains:v=>classes.has(v)
   }},
   getElementById:k=>nodes[k]||null
 };
 const window={
   __minternetStartupArmed:armed,
   minternet:{command:async (name,value)=>{actions.push({name,value});return {ok:true}}}
 };
 vm.runInNewContext(ui,{
   window,document,
   requestAnimationFrame:f=>{callbacks.push(f);},
   getComputedStyle:()=>({display:'flex',backgroundColor:'rgb(11, 16, 32)'}),
   setTimeout:(fn,delay)=>{const key=nextTimer++;timers.set(key,{fn,delay});return key;},
   clearTimeout:key=>timers.delete(key)
 },{filename:'startup-curtain.js'});
 return {window,document,classes,callbacks,timers,actions,nodes};
}
test('only restored real desktop sessions activate the opaque curtain',()=>{
 const h=harness(false);
 assert.equal(h.callbacks.length,0);
 assert.equal(h.classes.size,0);
 assert.equal(h.actions.length,0);
});
test('trusted chrome can request startup display without waiting for invisible-window animation frames',async()=>{
 const h=harness();
 assert.ok(h.classes.has('minternet-startup-armed'));
 assert.equal(h.nodes.startupCurtain.attributes['aria-hidden'],'false');
 assert.equal(h.actions.length,0);
 assert.equal(h.callbacks.length,0);
 assert.ok([...h.timers.values()].some(x=>x.delay===80));
 [...h.timers.values()].find(x=>x.delay===80).fn();
 await Promise.resolve();
 assert.equal(h.actions.length,1);
 assert.equal(h.actions[0].name,'startup-present');
 assert.equal(h.actions[0].value.curtainReady,true);
 assert.ok(h.classes.has('minternet-startup-armed'));
 h.window.minternetStartup.finish();
 assert.ok(!h.classes.has('minternet-startup-armed'));
 assert.equal(h.nodes.startupCurtain.attributes['aria-hidden'],'true');
});
test('startup retry leaves opaque curtain in place while reloading last page',async()=>{
 const h=harness();
 await h.nodes.startupCurtainRetry.handlers.click();
 assert.equal(h.actions[0].name,'reload');
 assert.ok(h.classes.has('minternet-startup-armed'));
 assert.equal(h.nodes.startupCurtainRetry.disabled,false);
});
test('native startup selects restored tab before creating its hidden main window',()=>{
 const start=main.indexOf('let initial_site=if real_launch');
 const windowIndex=main.indexOf('let builder = WindowBuilder::new(app, "main")',start);
 assert.ok(start>=0&&windowIndex>start);
 const source=main.slice(start,windowIndex+1200);
 assert.match(source,/b\.active\(\)/);
 assert.match(source,/cache\.overlay_open=true/);
 assert.match(source,/\.visible\(!startup_gate\)/);
 assert.match(main,/\.initialization_script\(if startup_gate/);
 assert.match(main,/window\.show\(\)/);
 assert.match(main,/raise_chrome_above_site\(app\)/);
 // Chrome's Finished callback verifies the local opaque curtain without
 // waiting for requestAnimationFrame while the window is hidden.
 assert.match(main,/let chrome_ready_app=app\.handle\(\)\.clone\(\)/);
 assert.match(main,/chrome_ready_app\.state::<StartupPresentation>\(\)\.armed\(\)/);
 assert.match(main,/present_restored_chrome\(&handle\)/);
 assert.doesNotMatch(ui,/requestAnimationFrame\(/);
});
test('only painted and loaded actual WebView2 pages remove the startup curtain',()=>{
 assert.match(health,/if !white\{/);
 assert.match(health,/document\.readyState==='complete'/);
 assert.match(health,/finish_restored_chrome\(&on_main,id,&expected_url\)/);
 assert.match(main,/\*active==id && url\.as_str\(\)==expected_url && \*shown/);
 assert.match(main,/cache\.overlay_open=false/);
 assert.match(main,/startup-painted/);
 assert.doesNotMatch(main,/window\.show\(\).*view\.reload\(\)/);
});
test('visible restoration UI is opaque and has a retry button, never a white overlay',()=>{
 assert.match(html,/id="startupCurtain"/);
 assert.match(html,/id="startupCurtainRetry"/);
 assert.match(html,/startup-curtain\.js/);
 assert.match(css,/html\.minternet-startup-armed \.startup-curtain/);
 assert.match(css,/background:rgb\(11,16,32\)!important/);
 assert.match(css,/z-index:3000!important/);
});
