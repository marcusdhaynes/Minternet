'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const file=name=>fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src',name),'utf8');
const fillSource=file('login_autofill.js');
const probeSource=file('login_form_context.js');

function fakePage({origin='https://access.wgu.edu',route='/pingfed/idp/SSO.saml2',
  username='',password='',accountName='pf.anon',extra=[],
  rememberLabel='',rememberName='rememberMe',rememberChecked=false,usernameOutsideForm=false,
  passwordStep=true,usernameStepButton='Next',
  navType='navigate',sessionStore=null}={}){
  class Form {
    constructor(){this.id='signinForm';this.className='';this.submissions=0;this.isConnected=true;}
    getAttribute(name){return name==='action'?route:null;}
    querySelectorAll(sel){
      if(sel==='button,input[type="submit"],input[type="button"]')return [signOnButton];
      return [];
    }
    querySelector(){return null;}
    requestSubmit(){this.submissions++;}
  }
  const form=new Form(),events=[];
  const signOnButton={tagName:'BUTTON',textContent:passwordStep?'Sign On':usernameStepButton,
    disabled:false,click(){form.submissions++;}};
  class Input {
    constructor(type,name,value=''){
      this.tagName='INPUT';this.type=type;this.name=name;this.id='';
      this.placeholder='';this.disabled=false;this.readOnly=false;
      this.labels=[];this.form=form;this.autocomplete='off';
      this.value=value;this.events=[];this.listeners=new Map();
    }
    getClientRects(){return [{}];}
    getBoundingClientRect(){return {left:100,bottom:180,width:200,height:40};}
    getAttribute(k){return k==='autocomplete'?this.autocomplete:null;}
    closest(){return null;}
    addEventListener(type,callback){
      const list=this.listeners.get(type)||[];list.push(callback);this.listeners.set(type,list);
    }
    dispatchEvent(event){
      this.events.push(event.type);events.push(event.type);
      for(const callback of this.listeners.get(event.type)||[])callback(event);
      return true;
    }
    getRootNode(){return doc;}
  }
  Object.defineProperty(Input.prototype,'value',{
    get(){return this._value||'';},set(value){this._value=String(value);}
  });
  const user=new Input('text',accountName,username),pw=new Input('password','pf.pass',password);
  if(usernameOutsideForm)user.form=null;
  const remember=rememberLabel?new Input('checkbox',rememberName):null;
  if(remember){
    remember.checked=rememberChecked;
    remember.labels=[{textContent:rememberLabel}];
    remember.parentElement={textContent:rememberLabel};
  }
  const extraInputs=extra.map(([type,name])=>new Input(type,name));
  const inputs=[user,...extraInputs,...(passwordStep?[pw]:[]),...(remember?[remember]:[])];
  const doc={
    documentElement:{},title:'Sign On',
    hasFocus(){return true;},querySelector(selector){
      if(selector==='h1')return {textContent:'Sign On'};
      return null;
    },
    querySelectorAll(sel){
      if(sel==='input'||sel==='input,textarea,select')return inputs;
      if(sel==='input[type="checkbox"]')return inputs.filter(input=>input.type==='checkbox');
      if(sel==='button,input[type="submit"],input[type="button"]')return [signOnButton];
      return [];
    },
    addEventListener(){},removeEventListener(){},
    activeElement:user
  };
  const view={
    HTMLInputElement:Input,Event:class {constructor(type){this.type=type;}},
    addEventListener(){},removeEventListener(){}
  };
  view.top=view;
  doc.defaultView=view;
  for(const input of inputs)input.ownerDocument=doc;
  let scheduled=0,notifyChanges=()=>{},clock=0;
  const timers=new Map(),store=sessionStore||new Map();
  view.performance={getEntriesByType(type){
    return type==='navigation'?[{type:navType}]:[];
  }};
  view.sessionStorage={
    getItem(key){return store.get(key)??null;},
    setItem(key,value){store.set(key,String(value));}
  };
  const globals={
    window:view,document:doc,
    location:{protocol:'https:',origin,pathname:route,
      href:origin+route,hostname:new URL(origin).hostname},
    URL,sessionStorage:view.sessionStorage,
    HTMLInputElement:Input,HTMLFormElement:Form,Event:view.Event,
    MutationObserver:class {
      constructor(callback){notifyChanges=callback;}
      observe(){}
      disconnect(){}
    },
    setTimeout(fn,ms){const id=++scheduled;timers.set(id,{fn,ms});return id;},
    clearTimeout(id){timers.delete(id);},
    Date:{now(){clock+=120;return clock;}},Set,WeakSet,Math
  };
  function fill(credentialOrigin='https://access.wgu.edu',options={}){
    const payload={origin:credentialOrigin,username:'student-name',
      password:'secret-login',autoSubmit:options.autoSubmit===true};
    vm.runInNewContext(fillSource.replace('__MINTERNET_LOGIN_PAYLOAD__',JSON.stringify(payload)),
      globals,{filename:'login_autofill.js'});
    return {user,pw,inputs,events};
  }
  function inspect(focused=user){
    doc.activeElement=focused;
    return vm.runInNewContext(probeSource,globals,{filename:'login_form_context.js'});
  }
  function replaceLoginFields(){
    const nextUser=new Input('text',accountName);
    const nextPassword=new Input('password','pf.pass');
    nextUser.ownerDocument=doc;nextPassword.ownerDocument=doc;
    inputs.splice(0,inputs.length,nextUser,nextPassword);
    notifyChanges();
    return {user:nextUser,pw:nextPassword};
  }
  function runSubmitTimers(){
    for(const [id,entry] of [...timers]){
      if(entry.ms>500)continue;
      timers.delete(id);entry.fn();
    }
  }
  return {user,pw,remember,inputs,events,fill,inspect,doc,form,replaceLoginFields,
    runSubmitTimers,getStatus:()=>view.__minternetLoginStatus};
}

test('WGU/PingFederate sign-on fills unique text username and password even without helpful field names',()=>{
  const form=fakePage();
  const {user,pw}=form.fill();
  assert.equal(user.value,'student-name');
  assert.equal(pw.value,'secret-login');
  assert.deepEqual(user.events,['input','change']);
  assert.deepEqual(pw.events,['input','change']);
});

test('never overwrite a WGU username entered by the user',()=>{
  const page=fakePage({username:'different-student'});
  const {user,pw}=page.fill();
  assert.equal(user.value,'different-student');
  assert.equal(pw.value,'');
});

test('do not write credentials on a different HTTPS origin, including lookalikes',()=>{
  const page=fakePage({origin:'https://access.wgu.edu.evil.example'});
  const {user,pw}=page.fill();
  assert.equal(user.value,'');
  assert.equal(pw.value,'');
});

test('do not fill username or password on registration or password-reset routes',()=>{
  for(const route of ['/register','/forgot-password','/reset-password']){
    const page=fakePage({route});
    page.fill();
    assert.equal(page.user.value,'',route);
    assert.equal(page.pw.value,'',route);
  }
});

test('do not mistake a verification code for username when another unique account field exists',()=>{
  const page=fakePage({extra:[['text','verification_code']]});
  page.fill();
  assert.equal(page.user.value,'student-name');
  assert.equal(page.pw.value,'secret-login');
  assert.equal(page.inputs[1].value,'');
});

test('WGU Sign On form context detects focused username and password without HTML autocomplete hints',()=>{
  const page=fakePage();
  const username=page.inspect(page.user);
  assert.equal(username.kind,'login');
  assert.equal(username.key,'login');
  const password=page.inspect(page.pw);
  assert.equal(password.kind,'login');
});

test('login form inspection never returns actual entered passwords to trusted chrome',()=>{
  const page=fakePage({username:'student',password:'secret'});
  const context=page.inspect(page.pw);
  assert.equal(context.kind,'login');
  assert.ok(!JSON.stringify(context).includes('secret'));
  assert.ok(!JSON.stringify(context).includes('student'));
});

test('WGU association in native Rust requires exact origins and private-tab exclusion',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');
  assert.match(main,/source=="https:\/\/my\.wgu\.edu" && target=="https:\/\/access\.wgu\.edu"/);
  assert.match(main,/vault-associate-login/);
  assert.match(main,/tab\.private\|\|tab\.secret_id\.is_some\(\)/);
  assert.match(main,/permitted_wgu_login_association\(source,&target\)/);
  assert.match(main,/entry\.password\.zeroize\(\)/);
});

test('WGU form remount re-fills newly created fields without another prompt or navigation',()=>{
  const page=fakePage();
  page.fill();
  const second=page.replaceLoginFields();
  assert.equal(second.user.value,'student-name');
  assert.equal(second.pw.value,'secret-login');
});

test('retries respect a user deliberately clearing already-filled fields',()=>{
  const page=fakePage();
  page.fill();
  page.user.value='';page.pw.value='';
  page.user.dispatchEvent({type:'input',isTrusted:true});
  page.pw.dispatchEvent({type:'input',isTrusted:true});
  for(let i=0;i<14;i++)page.fill();
  assert.equal(page.user.value,'');
  assert.equal(page.pw.value,'');
});
test('WGU SPA-cleared fields refill after a short cooldown without another user prompt',()=>{
  const page=fakePage();
  page.fill();
  page.user.value='';page.pw.value='';
  for(let i=0;i<15;i++)page.fill();
  assert.equal(page.user.value,'student-name');
  assert.equal(page.pw.value,'secret-login');
});

test('continuous login retry validates the current HTTPS origin and vault access',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');
  assert.match(main,/fn schedule_wgu_login_autofill/);
  assert.match(main,/password_vault::origin\(&tab\.url\)\.is_err\(\)/);
  assert.match(main,/Duration::from_millis\(900\)/);
  assert.match(main,/vault_section_allowed\(&owner,"logins"\)/);
  assert.match(main,/schedule_wgu_login_autofill\(app\.handle\(\)\)/);
  assert.match(main,/vault\.matching_site\(&actual_origin,manual,username,source_origin\)/);
});

test('WGU login uses direct matching or portal fallback without a popup',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');
  const start=main.indexOf('fn fill_saved_credential_from(');
  const end=main.indexOf('const IDENTITY_FILL_JS',start);
  const fill=main.slice(start,end);
  assert.match(fill,/vault\.matching_site\(&actual_origin,manual,username,source_origin\)/);
  assert.match(fill,/view\.eval\(&script\)/);
  assert.doesNotMatch(fill,/vault-associate-login|chrome-overlay|window\.confirm/);
});
test('WGU family matching is limited to secure WGU DNS suffixes',()=>{
  const vault=file('password_vault.rs');
  assert.match(vault,/host=="wgu.edu" \|\| host.ends_with\("\.wgu.edu"\)/);
  assert.match(vault,/url.scheme\(\)!="https"/);
  assert.match(vault,/pub fn matching_site/);
  assert.match(vault,/choices.len\(\)==1/);
  assert.match(vault,/e.origin==destination/);
});
test('login saving releases the vault lock before attempting autofill',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');
  const start=main.indexOf('"vault-put" => {');
  const end=main.indexOf('"vault-remove" => {',start);
  const segment=main.slice(start,end);
  assert.match(segment,/\}\s*\/\/ Release the vault mutex before any autofill attempt/);
  assert.match(segment,/fill_saved_credential\(&app,active,false,None\)/);
  assert.match(segment,/"vault-edit"/);
  assert.match(segment,/vault.edit_login/);
});
test('saved logins have Edit actions and password-preserving native update',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../ui/password-ui.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8');
  assert.match(ui,/editLogin\(entry\)/);
  assert.match(ui,/'vault-edit'/);
  assert.match(ui,/oldOrigin:editing.origin/);
  assert.match(html,/id="vaultEditCancel"/);
  assert.match(html,/id="vaultPasswordHint"/);
  assert.match(html,/<details id="vaultPasskeys"/);
});
test('no repeated WGU password prompt when optional Windows auto unlock is enabled',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');
  assert.match(main,/unlock_permitted_sections_from_device\(app\.handle\(\)\)/);
  assert.match(main,/device_secrets::read\("vault"\)/);
  const preferences=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/lock_preferences.rs'),'utf8');
  assert.match(preferences,/logins:!policy\.logins/);
  const script=file('login_autofill.js');
  assert.match(script,/if\(\(password\.value&&!marked\.has\(password\)\)/);
  assert.match(script,/accountInputs\.length===1/);
  assert.match(script,/token\(el\)\.includes\('email'\)/);
  assert.match(script,/location\.hash/);
});

test('manual WGU default is native-verified and overrides stale enabled subdomain credentials',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');
  const ui=fs.readFileSync(path.join(__dirname,'../ui/password-ui.js'),'utf8');
  const vault=file('password_vault.rs');
  assert.match(main,/"vault-wgu-default" => \{/);
  assert.match(main,/password_vault::trusted_wgu_origin\(&origin\)/);
  assert.match(main,/vault\.prefer_site\(&origin,username\)/);
  assert.match(main,/if actual_origin!=tab_origin &&/);
  assert.match(main,/password_vault::trusted_wgu_origin\(&actual_origin\)/);
  assert.match(ui,/isWguOrigin\(entry\.origin\)/);
  assert.match(ui,/Use For WGU/);
  assert.match(vault,/entry\.preferred && entry\.autofill/);
  assert.match(vault,/e\.origin==destination&&!e\.autofill/);
});

test('Windows release verifies actual WebView2 login autofill, not only eval submission',()=>{
  const native=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');
  const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/native-windows.yml'),'utf8');
  assert.match(native,/fn start_native_autofill_smoke/);
  assert.match(native,/--minternet-autofill-smoke/);
  assert.match(native,/fill_saved_credential\(&task,id,false,None\)/);
  assert.match(native,/eval_with_callback/);
  assert.match(workflow,/Verify actual WebView2 login autofill from a throwaway encrypted native vault/);
  assert.match(workflow,/minternet-autofill-\$\(\$p.Id\)\.ok/);
});

test('WGU PingFederate sign-on automatically submits once after filling both fields',()=>{
  const page=fakePage({route:'/pingfed/as/authorization.oauth2'});
  page.fill('https://access.wgu.edu',{autoSubmit:true});
  assert.equal(page.user.value,'student-name');
  assert.equal(page.pw.value,'secret-login');
  assert.equal(page.form.submissions,0);
  assert.equal(page.getStatus().usernameFilled,true);
  assert.equal(page.getStatus().passwordFilled,true);
  page.runSubmitTimers();
  assert.equal(page.form.submissions,1);
  page.fill('https://access.wgu.edu',{autoSubmit:true});
  page.runSubmitTimers();
  assert.equal(page.form.submissions,1,'native retry must not resubmit');
});
test('no automatic submission on non-WGU origins, non-login WGU routes, or without explicit flag',()=>{
  for(const [origin,route,enabled] of [
    ['https://example.com','/pingfed/as/authorization.oauth2',true],
    ['https://access.wgu.edu','/student/profile',true],
    ['https://access.wgu.edu','/pingfed/as/authorization.oauth2',false],
    ['https://access.wgu.edu.evil.example','/pingfed/as/authorization.oauth2',true]
  ]){
    const page=fakePage({origin,route});
    page.fill(origin,{autoSubmit:enabled});page.runSubmitTimers();
    assert.equal(page.form.submissions,0,origin+route);
  }
});
test('password reset and incomplete forms never auto-submit stored WGU credentials',()=>{
  const reset=fakePage({route:'/pingfed/forgot-password'});
  reset.fill('https://access.wgu.edu',{autoSubmit:true});
  reset.runSubmitTimers();
  assert.equal(reset.form.submissions,0);
  const touched=fakePage({route:'/pingfed/as/authorization.oauth2',username:'someone-else'});
  touched.fill('https://access.wgu.edu',{autoSubmit:true});touched.runSubmitTimers();
  assert.equal(touched.form.submissions,0);
});

test('manual Fill verifies actual form values rather than trusting successful JavaScript injection',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');
  const chrome=fs.readFileSync(path.join(__dirname,'../ui/password-ui.js'),'utf8');
  assert.match(main,/"autoSubmit":password_vault::trusted_wgu_origin\(&actual_origin\)/);
  assert.match(main,/"vault-fill-status" => \{/);
  assert.match(main,/let \(_origin,result\)=browser_page_eval/);
  assert.match(chrome,/await call\('vault-fill-status'\)/);
  assert.match(chrome,/status\?\.usernameFilled&&status\?\.passwordFilled/);
  assert.match(chrome,/status\.submitted/);
});

test('explicit WGU refresh can sign in again, but immediate automatic redirect cannot loop',()=>{
  const store=new Map();
  const first=fakePage({route:'/pingfed/as/authorization.oauth2',sessionStore:store});
  first.fill('https://access.wgu.edu',{autoSubmit:true});first.runSubmitTimers();
  assert.equal(first.form.submissions,1);
  const redirect=fakePage({route:'/pingfed/as/authorization.oauth2',sessionStore:store});
  redirect.fill('https://access.wgu.edu',{autoSubmit:true});redirect.runSubmitTimers();
  assert.equal(redirect.form.submissions,0,'unprompted bounce must not loop');
  const refresh=fakePage({route:'/pingfed/as/authorization.oauth2',
    navType:'reload',sessionStore:store});
  refresh.fill('https://access.wgu.edu',{autoSubmit:true});refresh.runSubmitTimers();
  assert.equal(refresh.form.submissions,1,'manual page refresh signs in again');
});

test('WGU Sign On button works even if the page uses no HTML form wrapper',()=>{
  const page=fakePage({route:'/pingfed/as/authorization.oauth2'});
  page.user.form=null;page.pw.form=null;
  page.fill('https://access.wgu.edu',{autoSubmit:true});
  page.runSubmitTimers();
  assert.equal(page.form.submissions,1);
  assert.equal(page.getStatus().submitted,true);
});
test('non-WGU or password reset pages never use the Sign On click fallback',()=>{
  const page=fakePage({origin:'https://example.com',route:'/pingfed/as/authorization.oauth2'});
  page.user.form=null;page.pw.form=null;
  page.fill('https://example.com',{autoSubmit:true});
  page.runSubmitTimers();
  assert.equal(page.form.submissions,0);
});

test('10-cycle WGU PingFederate regression: load, refresh, remount and auto sign-on',()=>{
  for(let pass=0;pass<10;pass++){
    const route=pass%2===0
      ?'/pingfed/as/authorization.oauth2'
      :'/pingfed/idp/SSO.saml2';
    const page=fakePage({
      origin:'https://access.wgu.edu',
      route,accountName:pass%2===0?'pf.username':'pf.anon',
      navType:pass%3===0?'reload':'navigate'
    });
    page.fill('https://access.wgu.edu',{autoSubmit:true});
    assert.equal(page.user.value,'student-name','username cycle '+pass);
    assert.equal(page.pw.value,'secret-login','password cycle '+pass);
    assert.equal(page.getStatus().usernameFilled,true,'username status cycle '+pass);
    assert.equal(page.getStatus().passwordFilled,true,'password status cycle '+pass);
    page.runSubmitTimers();
    assert.equal(page.form.submissions,1,'single sign-on cycle '+pass);
    for(let retry=0;retry<10;retry++){
      page.fill('https://access.wgu.edu',{autoSubmit:true});
      page.runSubmitTimers();
    }
    assert.equal(page.form.submissions,1,'no duplicate sign-on cycle '+pass);
  }
});
test('10-cycle WGU security regression: lookalikes and unrelated pages never receive credentials',()=>{
  for(let pass=0;pass<10;pass++){
    const domain=pass%2===0?'https://access.wgu.edu.evil.example':'https://other.example';
    const page=fakePage({origin:domain,route:'/pingfed/as/authorization.oauth2'});
    page.fill('https://access.wgu.edu',{autoSubmit:true});
    page.runSubmitTimers();
    assert.equal(page.user.value,'','username must stay empty cycle '+pass);
    assert.equal(page.pw.value,'','password must stay empty cycle '+pass);
    assert.equal(page.form.submissions,0,'no submission cycle '+pass);
  }
});
test('manual Fill never closes Logins before native field verification completes',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../ui/password-ui.js'),'utf8');
  const start=ui.indexOf("fill.addEventListener('click',async()=>{");
  const end=ui.indexOf("if(isWguOrigin(entry.origin))",start);
  const handler=ui.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.ok(handler.indexOf("await call('vault-fill-status')")<
    handler.lastIndexOf("close();"));
  assert.match(handler,/screen.hidden=false;\s*close\(\)/);
});


test('native scheduler automatically fills a unique unlocked identity without a prompt',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');
  const start=main.indexOf('fn fill_unique_identity_automatically(');
  const end=main.indexOf('fn fill_saved_credential(',start);
  const code=main.slice(start,end);
  assert.ok(start>0);
  assert.match(code,/vault_section_allowed\(app,"identities"\)/);
  assert.match(code,/items\.len\(\)!=1/);
  assert.match(code,/fill_identity\(app,&id\)/);
  assert.match(main,/fill_unique_identity_automatically\(&worker\)/);
});

test('WGU PingFederate remembers the login and submits through Sign On only once',()=>{
  const page=fakePage({route:'/pingfed/as/authorization.oauth2',
    rememberLabel:'Remember me'});
  page.fill('https://access.wgu.edu',{autoSubmit:true});
  assert.equal(page.remember.checked,false,'checkbox changes at submission, not before');
  page.runSubmitTimers();
  assert.equal(page.remember.checked,true);
  assert.deepEqual(page.remember.events,['input','change']);
  assert.equal(page.form.submissions,1);
  assert.equal(page.getStatus().rememberChecked,true);
  for(let n=0;n<10;n++){page.fill('https://access.wgu.edu',{autoSubmit:true});page.runSubmitTimers();}
  assert.equal(page.form.submissions,1);
});

test('WGU unmarked checkbox and login autofill without submission are untouched',()=>{
  for(const label of ['Agree to terms','Newsletter','Two-factor verification']){
    const page=fakePage({route:'/pingfed/as/authorization.oauth2',
      rememberLabel:label,rememberName:'termsOrNewsletter'});
    page.fill('https://access.wgu.edu',{autoSubmit:true});page.runSubmitTimers();
    assert.equal(page.remember.checked,false,label);
  }
  const manual=fakePage({route:'/pingfed/as/authorization.oauth2',rememberLabel:'Remember me'});
  manual.fill('https://access.wgu.edu',{autoSubmit:false});manual.runSubmitTimers();
  assert.equal(manual.remember.checked,false);
  assert.equal(manual.form.submissions,0);
});

test('WGU SSO matches one username field even when split out of the password form',()=>{
  const page=fakePage({route:'/pingfed/as/authorization.oauth2',usernameOutsideForm:true,
    rememberLabel:'Keep me signed in'});
  page.fill('https://access.wgu.edu',{autoSubmit:true});
  assert.equal(page.user.value,'student-name');
  assert.equal(page.pw.value,'secret-login');
  page.runSubmitTimers();
  assert.equal(page.remember.checked,true);
  assert.equal(page.form.submissions,1);
});

test('WGU full-portal 10x check: remember, origin, fields and single submit',()=>{
  for(let cycle=0;cycle<10;cycle++){
    const page=fakePage({origin:'https://access.wgu.edu',
      route:cycle%2?'/pingfed/idp/SSO.saml2':'/pingfed/as/authorization.oauth2',
      usernameOutsideForm:cycle%3===0,rememberLabel:'Remember this device'});
    page.fill('https://access.wgu.edu',{autoSubmit:true});
    assert.equal(page.user.value,'student-name',`username ${cycle}`);
    assert.equal(page.pw.value,'secret-login',`password ${cycle}`);
    page.runSubmitTimers();
    assert.equal(page.remember.checked,true,`remember ${cycle}`);
    assert.equal(page.form.submissions,1,`submit ${cycle}`);
  }
});

test('WGU username-first flow automatically advances once to its password page',()=>{
  const page=fakePage({route:'/pingfed/as/authorization.oauth2',passwordStep:false,
    usernameStepButton:'Next'});
  page.fill('https://access.wgu.edu',{autoSubmit:true});
  assert.equal(page.user.value,'student-name');
  page.runSubmitTimers();
  assert.equal(page.form.submissions,1);
  for(let round=0;round<10;round++){
    page.fill('https://access.wgu.edu',{autoSubmit:true});page.runSubmitTimers();
  }
  assert.equal(page.form.submissions,1);
});
test('username-first login never bypasses MFA, reset, another site or user input',()=>{
  const cases=[
    {route:'/pingfed/as/authorization.oauth2',origin:'https://other.example'},
    {route:'/pingfed/as/authorization.oauth2',extra:[['text','verification_code']]},
    {route:'/reset-password'},
    {route:'/pingfed/as/authorization.oauth2',username:'different-user'}
  ];
  for(const options of cases){
    const page=fakePage({...options,passwordStep:false,usernameStepButton:'Next'});
    page.fill(options.origin||'https://access.wgu.edu',{autoSubmit:true});
    page.runSubmitTimers();
    assert.equal(page.form.submissions,0,JSON.stringify(options));
  }
});
