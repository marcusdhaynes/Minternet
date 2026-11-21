'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

function harness(previousSettings=new Map()){
  const saved=new Map(previousSettings),timers=new Map(),calls=[];
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
test('all managers offer matching Title Case Seconds, Minutes, Hours, Days and Never options',()=>{
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
      [['seconds','Seconds'],['minutes','Minutes'],['hours','Hours'],
       ['days','Days'],['never','Never']]);
    assert.equal(unit.value,section==='logins'?'never':'seconds');
  }
});
test('zero seconds locks only the closed section immediately through native IPC',async()=>{
  const h=harness(),controller=h.window.minternetVaultAutoLock.forSection('logins');
  const {amount,unit}=labelFor(h,'logins');
  unit.value='seconds';unit.change();
  amount.value='0';amount.change();
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
  assert.equal(login.unit.value,'never');
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
  const {amount,unit}=labelFor(h,'logins');
  unit.value='seconds';unit.change();
  amount.value='0';amount.change();
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
test('a transient native lock failure is retried while the panel stays closed',async()=>{
  const h=harness(),ctrl=h.window.minternetVaultAutoLock.forSection('payments');
  let attempts=0;
  h.command(async()=>({ok:++attempts>1}));
  await ctrl.openManager();ctrl.setUnlocked(true);
  ctrl.closeManager(true);
  await h.flush();
  assert.equal(attempts,1);
  assert.equal([...h.timers.values()][0].delay,2000);
  h.advance(2000);
  await h.flush();
  assert.equal(attempts,2);
  assert.deepEqual(h.calls,[['vault-lock','payments'],['vault-lock','payments']]);
  assert.equal(h.timers.size,0);
});
test('Never preserves Logins session access without changing explicit Lock or restart protection',async()=>{
  const h=harness(),ctrl=h.window.minternetVaultAutoLock.forSection('logins');
  const {amount,unit}=labelFor(h,'logins');
  assert.equal(unit.value,'never');
  assert.equal(amount.disabled,true);
  await ctrl.openManager();ctrl.setUnlocked(true);ctrl.closeManager(true);
  h.advance(86400000*40);await h.flush();
  assert.equal(h.calls.length,0);
  unit.value='days';unit.change();amount.value='2';amount.change();
  assert.equal(amount.disabled,false);
  await ctrl.openManager();ctrl.closeManager(true);
  assert.equal([...h.timers.values()][0].delay,172800000);
  unit.value='never';unit.change();
  assert.equal(amount.disabled,true);
  assert.equal(h.timers.size,0);
  assert.equal(h.calls.length,0);
});
test('Secret Bookmarks also supports Days/Never and Title Case',()=>{
  const html=read('ui/index.html'),secret=read('ui/secret-bookmarks.js');
  for(const option of ['Seconds','Minutes','Hours','Days','Never'])
    assert.match(html,new RegExp('>'+option+'</option>'));
  assert.match(secret,/unit==='never'/);
  assert.match(secret,/unit==='days'\?86400000/);
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

test('simple Auto-Lock toggles independently persist across browser restarts',async()=>{
  const h=harness(),api=h.window.minternetVaultAutoLock;
  const identity=labelFor(h,'identities');
  const login=labelFor(h,'logins');
  const payment=labelFor(h,'payments');
  assert.equal(api.getEnabled('identities'),true);
  assert.equal(api.getEnabled('logins'),false);
  assert.equal(api.getEnabled('payments'),true);
  api.setEnabled('identities',false);
  api.setEnabled('payments',false);
  assert.equal(identity.unit.value,'never');
  assert.equal(payment.unit.value,'never');
  assert.equal(login.unit.value,'never');
  assert.equal(api.getEnabled('identities'),false);
  assert.equal(api.getEnabled('payments'),false);
  assert.equal(api.getEnabled('logins'),false);
  assert.equal(JSON.parse(h.saved.get('minternet.identities-close-lock.v1')).unit,'never');
  assert.equal(JSON.parse(h.saved.get('minternet.payments-close-lock.v1')).unit,'never');
  assert.equal(h.saved.has('minternet.logins-close-lock.v1'),false);
  const next=harness(h.saved),fresh=next.window.minternetVaultAutoLock;
  assert.equal(fresh.getEnabled('identities'),false);
  assert.equal(fresh.getEnabled('payments'),false);
  assert.equal(fresh.getEnabled('logins'),false);
  const ctrl=fresh.forSection('identities');
  await ctrl.openManager();ctrl.setUnlocked(true);ctrl.closeManager(true);
  next.advance(86400000*365);await next.flush();
  assert.equal(next.calls.length,0,'off must never schedule an automatic native lock');
});

test('re-enabling restores each section previous delay, without affecting others',async()=>{
  const h=harness(),api=h.window.minternetVaultAutoLock;
  const identity=labelFor(h,'identities');
  const payment=labelFor(h,'payments');
  identity.amount.value='3';identity.unit.value='minutes';identity.unit.change();
  payment.amount.value='2';payment.unit.value='hours';payment.unit.change();
  api.setEnabled('identities',false);
  api.setEnabled('payments',false);
  assert.equal(api.setEnabled('identities',true),true);
  assert.equal(identity.unit.value,'minutes');
  assert.equal(identity.amount.value,'3');
  assert.equal(api.getEnabled('payments'),false);
  assert.equal(api.setEnabled('payments',true),true);
  assert.equal(payment.unit.value,'hours');
  assert.equal(payment.amount.value,'2');
  assert.equal(api.getEnabled('logins'),false);
  api.setEnabled('logins',true);
  const login=labelFor(h,'logins');
  assert.equal(login.unit.value,'minutes');
  assert.equal(login.amount.value,'5');
});

test('turning Auto-Lock off cancels already queued timeout and Settings stays synchronized',async()=>{
  const h=harness(),api=h.window.minternetVaultAutoLock;
  const observed=[];
  api.onChange((section,enabled)=>observed.push([section,enabled]));
  const ctrl=api.forSection('payments');
  const {amount,unit}=labelFor(h,'payments');
  amount.value='4';unit.value='seconds';unit.change();
  await ctrl.openManager();ctrl.setUnlocked(true);ctrl.closeManager(true);
  assert.equal(h.timers.size,1);
  api.setEnabled('payments',false);
  assert.equal(h.timers.size,0);
  assert.equal(unit.value,'never');
  h.advance(9000);await h.flush();
  assert.equal(h.calls.length,0);
  unit.value='minutes';unit.change();
  assert.equal(api.getEnabled('payments'),true);
  assert.deepEqual(observed.map(x=>[x[0],x[1]]),
    [['payments',true],['payments',false],['payments',true]]);
});

test('Settings has three independent, accessible persistent Auto-Lock toggles',()=>{
  const settings=read('ui/settings-sections.js');
  const css=read('ui/styles.css');
  assert.match(settings,/section\('Auto-Lock',userData\)/);
  assert.match(settings,/\['identities','Identities'\],\['logins','Logins'\],\['payments','Payments'\]/);
  assert.match(settings,/toggle\.id='autoLockEnabled-'\+key/);
  assert.match(settings,/autoLock\?\.setEnabled\(key,toggle\.checked\)/);
  assert.match(settings,/autoLock\?\.onChange/);
  assert.match(css,/\.auto-lock-preference-row input\[type="checkbox"\]:checked/);
});
