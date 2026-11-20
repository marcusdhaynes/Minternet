'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

function harness(){
  const saved=new Map(),timers=new Map(),calls=[];
  let next=1,now=0,onCommand=async()=>({ok:true});
  const createElement=tag=>({
    tag,children:[],handlers:new Map(),value:'',hidden:false,
    append(...children){this.children.push(...children);},
    setAttribute(name,value){this[name]=value;},
    addEventListener(name,cb){this.handlers.set(name,cb);},
    change(){this.handlers.get('change')?.();}
  });
  const storage={
    getItem(key){return saved.get(key)??null;},
    setItem(key,value){saved.set(key,value);}
  };
  const window={
    minternet:{command:async(name,section)=>{
      calls.push([name,section]);return onCommand(name,section);
    }}
  };
  vm.runInNewContext(read('ui/vault-auto-lock.js'),{
    window,localStorage:storage,document:{createElement},
    Date:{now:()=>now},
    setTimeout:(fn,delay)=>{const id=next++;timers.set(id,{fn,delay});return id;},
    clearTimeout:id=>timers.delete(id)
  });
  async function flush(){await new Promise(setImmediate);}
  return {
    window,saved,timers,calls,createElement,flush,
    advance(ms){now+=ms;const pending=[...timers.entries()];
      for(const [id,callback] of pending){if(timers.has(id)){
        timers.delete(id);callback.fn();
      }}
    },
    command(fn){onCommand=fn;}
  };
}
const labelFor=(h,section)=>{
  const header=h.createElement('div');
  h.window.minternetVaultAutoLock.forSection(section).mount(header);
  assert.equal(header.children.length,1);
  const label=header.children[0];
  const [caption,amount,unit]=label.children;
  return {label,caption,amount,unit};
};
test('all three managers display Secret Bookmarks exact Lock in, sec/min/hours controls',()=>{
  const h=harness();
  for(const section of ['identities','logins','payments']){
    const {label,caption,amount,unit}=labelFor(h,section);
    assert.equal(label.className,'secret-close-lock');
    assert.equal(caption.textContent,'Lock in');
    assert.equal(amount.type,'number');
    assert.equal(amount.min,'0');
    assert.equal(amount.max,'999999');
    assert.equal(amount.step,'1');
    assert.equal(amount.value,'0');
    assert.deepEqual(unit.children.map(x=>[x.value,x.textContent]),
      [['seconds','sec'],['minutes','min'],['hours','hours']]);
    assert.equal(unit.value,'seconds');
  }
});
test('zero seconds locks only the closed section immediately through native IPC',async()=>{
  const h=harness(),controller=h.window.minternetVaultAutoLock.forSection('logins');
  await controller.openManager();
  controller.setUnlocked(true);
  assert.equal(h.calls.length,0);
  controller.closeManager(true);
  await h.flush();
  assert.deepEqual(h.calls,[['vault-lock','logins']]);
  assert.equal(h.timers.size,0);
});
test('delays persist independently and the timer starts only when closing',async()=>{
  const h=harness();
  const {amount,unit}=labelFor(h,'identities');
  amount.value='2';unit.value='minutes';amount.change();
  assert.equal(JSON.parse(h.saved.get('minternet.identities-close-lock.v1')).amount,2);
  assert.equal(JSON.parse(h.saved.get('minternet.identities-close-lock.v1')).unit,'minutes');
  const ctrl=h.window.minternetVaultAutoLock.forSection('identities');
  await ctrl.openManager();ctrl.setUnlocked(true);
  assert.equal(h.timers.size,0);
  ctrl.closeManager(true);
  assert.equal([...h.timers.values()][0].delay,120000);
  h.advance(60000);
  await h.flush();
  assert.equal(h.calls.length,0);
  assert.equal([...h.timers.values()][0].delay,60000);
  h.advance(60000);
  await h.flush();
  assert.deepEqual(h.calls,[['vault-lock','identities']]);
  const login=labelFor(h,'logins');
  assert.equal(login.amount.value,'0');
  const payments=labelFor(h,'payments');
  payments.amount.value='4';payments.unit.value='hours';payments.unit.change();
  assert.equal(JSON.parse(h.saved.get('minternet.payments-close-lock.v1')).unit,'hours');
  assert.equal(JSON.parse(h.saved.get('minternet.identities-close-lock.v1')).unit,'minutes');
});
test('reopening before the deadline cancels an in-progress delay and does not lock',async()=>{
  const h=harness(),{amount}=labelFor(h,'payments');
  amount.value='5';amount.change();
  const ctrl=h.window.minternetVaultAutoLock.forSection('payments');
  await ctrl.openManager();ctrl.setUnlocked(true);
  ctrl.closeManager(true);
  assert.equal(h.timers.size,1);
  await ctrl.openManager();
  assert.equal(h.timers.size,0);
  h.advance(9000);
  await h.flush();
  assert.equal(h.calls.length,0);
  ctrl.closeManager(true);
  h.advance(5000);
  await h.flush();
  assert.deepEqual(h.calls,[['vault-lock','payments']]);
});
test('reopening waits for a previously-started native lock before returning',async()=>{
  const h=harness(),ctrl=h.window.minternetVaultAutoLock.forSection('logins');
  let finish;
  h.command(()=>new Promise(resolve=>{finish=resolve;}));
  await ctrl.openManager();ctrl.setUnlocked(true);
  ctrl.closeManager(true);
  let reopened=false;
  const reopening=ctrl.openManager().then(()=>{reopened=true;});
  await h.flush();
  assert.equal(reopened,false);
  finish({ok:true});
  await reopening;
  assert.equal(reopened,true);
});
test('timers safely chunk very long hours rather than overflowing setTimeout',async()=>{
  const h=harness(),{amount,unit}=labelFor(h,'identities');
  amount.value='999999';unit.value='hours';unit.change();
  const ctrl=h.window.minternetVaultAutoLock.forSection('identities');
  await ctrl.openManager();ctrl.setUnlocked(true);ctrl.closeManager(true);
  assert.equal([...h.timers.values()][0].delay,2147483647);
  assert.equal(h.calls.length,0);
});
test('three native manager surfaces use the shared selector and lock on close',()=>{
  const html=read('ui/index.html'),css=read('ui/styles.css');
  assert.match(html,/vault-auto-lock\.js/);
  assert.ok(html.indexOf('vault-auto-lock.js')<html.indexOf('password-ui.js'));
  for(const [file,section] of [
    ['ui/password-ui.js','logins'],
    ['ui/identity-ui.js','identities'],
    ['ui/payment-ui.js','payments']
  ]){
    const code=read(file);
    assert.match(code,new RegExp("forSection\\('"+section+"'\\)"));
    assert.match(code,/autoLock\?\.mount\(/);
    assert.match(code,/await autoLock\?\.openManager\(\)/);
    assert.match(code,/autoLock\?\.closeManager\(/);
    assert.match(code,/autoLock\?\.setUnlocked\(/);
    assert.match(css,new RegExp('\\.'+(section==='logins'?'vault':'payment')+'-head \\.secret-close-lock'));
  }
  // The shared utility may persist a timer preference, never passwords.
  const utility=read('ui/vault-auto-lock.js');
  assert.match(utility,/window\.minternet\?\.command\('vault-lock',section\)/);
  assert.doesNotMatch(utility,/localStorage\.setItem\([^,]+,\s*JSON\.stringify\((?:password|secret|credentials)/);
});
