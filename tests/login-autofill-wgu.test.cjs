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
  username='',password='',accountName='pf.anon',extra=[]}={}){
  class Form {
    constructor(){this.id='signinForm';this.className='';}
    getAttribute(name){return name==='action'?route:null;}
  }
  const form=new Form(),events=[];
  class Input {
    constructor(type,name,value=''){
      this.tagName='INPUT';this.type=type;this.name=name;this.id='';
      this.placeholder='';this.disabled=false;this.readOnly=false;
      this.labels=[];this.form=form;this.autocomplete='off';
      this.value=value;this.events=[];
    }
    getClientRects(){return [{}];}
    getBoundingClientRect(){return {left:100,bottom:180,width:200,height:40};}
    getAttribute(k){return k==='autocomplete'?this.autocomplete:null;}
    closest(){return null;}
    dispatchEvent(event){this.events.push(event.type);events.push(event.type);return true;}
    getRootNode(){return doc;}
  }
  Object.defineProperty(Input.prototype,'value',{
    get(){return this._value||'';},set(value){this._value=String(value);}
  });
  const user=new Input('text',accountName,username),pw=new Input('password','pf.pass',password);
  const extraInputs=extra.map(([type,name])=>new Input(type,name));
  const inputs=[user,...extraInputs,pw];
  const doc={
    documentElement:{},title:'Sign On',
    hasFocus(){return true;},querySelector(selector){
      if(selector==='h1')return {textContent:'Sign On'};
      return null;
    },
    querySelectorAll(sel){
      if(sel==='input'||sel==='input,textarea,select')return inputs;
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
  let scheduled=0,notifyChanges=()=>{};
  const globals={
    window:view,document:doc,
    location:{protocol:'https:',origin,pathname:route},
    HTMLInputElement:Input,HTMLFormElement:Form,Event:view.Event,
    MutationObserver:class {
      constructor(callback){notifyChanges=callback;}
      observe(){}
      disconnect(){}
    },
    setTimeout(){scheduled++;return scheduled;},clearTimeout(){},
    Date,Set,WeakSet,Math
  };
  function fill(credentialOrigin='https://access.wgu.edu'){
    const payload={origin:credentialOrigin,username:'student-name',password:'secret-login'};
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
  return {user,pw,inputs,events,fill,inspect,doc,replaceLoginFields};
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

test('retries respect deliberately cleared fields and never refill the same input',()=>{
  const page=fakePage();
  page.fill();
  page.user.value='';page.pw.value='';
  page.fill();
  assert.equal(page.user.value,'');
  assert.equal(page.pw.value,'');
});

test('WGU native retry is scoped to exact access.wgu.edu origin',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');
  assert.match(main,/fn schedule_wgu_login_autofill/);
  assert.match(main,/tab\.url\.starts_with\("https:\/\/access\.wgu\.edu\/"\)/);
  assert.match(main,/schedule_wgu_login_autofill\(app\.handle\(\)\)/);
  assert.match(main,/vault\.matching\("https:\/\/my\.wgu\.edu",false,None\)/);
});
