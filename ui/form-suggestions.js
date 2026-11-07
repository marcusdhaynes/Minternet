'use strict';
// Trusted chrome popup: only metadata from sites, never passwords or identity
// values. Secrets are read, authorized and filled entirely inside native Rust.
(()=>{
  if(!window.__TAURI__||!window.minternet)return;
  const cmd=(name,value)=>window.minternet.command(name,value);
  const create=(tag,cls,text)=>{
    const e=document.createElement(tag);
    if(cls)e.className=cls;
    if(text!==undefined)e.textContent=text;
    return e;
  };
  const backdrop=create('div','form-suggestion-backdrop');
  const panel=create('section','form-suggestion-popup');
  backdrop.hidden=true;panel.hidden=true;
  panel.setAttribute('role','dialog');
  panel.setAttribute('aria-label','Minternet Autofill');
  document.body.append(backdrop,panel);
  let active=null,ignored=null,busy=false;
  const fingerprint=ctx=>ctx?.origin+'|'+ctx?.key+'|'+ctx?.x+'|'+ctx?.y;
  const isOpen=()=>!panel.hidden;
  function otherDialogs(){
    const names=['passwordVaultScreen','secretScreen','bookmarkManager',
      'bookmarkEditor','bookmarkFolderMenu','bookmarkSettings','historyScreen'];
    if(names.some(id=>{const e=document.getElementById(id);return e&&!e.hidden;}))return true;
    if(document.querySelector('.payment-screen:not([hidden])'))return true;
    return false;
  }
  function hide(ignore=false){
    if(ignore&&active)ignored=fingerprint(active);
    active=null;backdrop.hidden=true;panel.hidden=true;
    panel.replaceChildren();
    void cmd('chrome-overlay',false);
  }
  backdrop.addEventListener('click',()=>hide(true));
  function action(text,handler,cls=''){
    const button=create('button',cls,text);
    button.type='button';
    button.addEventListener('click',async event=>{
      event.preventDefault();
      button.disabled=true;
      try{await handler();}
      catch(err){window.minternetToast?.(err.message||'Autofill unavailable');}
      finally{button.disabled=false;}
    });
    return button;
  }
  async function approved(name,payload,message){
    const response=await cmd(name,payload);
    if(message&&response?.ok)window.minternetToast?.(message);
    if(response?.filled||response?.ok){hide();return true;}
    return false;
  }
  async function openManager(kind){
    hide();
    if(kind==='identity')await window.minternetIdentities?.open();
    else if(kind==='payment')await window.minternetPayment?.open();
    else document.getElementById('passwordManagerOpen')?.click();
  }
  async function render(ctx){
    active=ctx;
    const width=Math.min(Math.max(ctx.width,160),window.innerWidth-16);
    panel.style.width=width+'px';
    panel.style.left=Math.min(Math.max(8,ctx.x),window.innerWidth-width-8)+'px';
    panel.style.top=Math.min(Math.max(ctx.top+5,ctx.y+ctx.top+3),window.innerHeight-170)+'px';
    backdrop.hidden=false;panel.hidden=false;
    panel.replaceChildren();
    const head=create('div','form-suggestion-head');
    head.append(create('strong','',ctx.kind==='login'?'Passwords':
      ctx.kind==='payment'?'Payment Methods':'Identities'));
    head.append(action('×',()=>hide(true),'form-suggestion-x'));
    panel.append(head);
    const status=await cmd('vault-status');
    if(!active||fingerprint(active)!==fingerprint(ctx))return;
    if(!status?.unlocked){
      panel.append(create('small','form-suggestion-note','Encrypted vault is locked.'));
      panel.append(action('Unlock to autofill',()=>openManager(ctx.kind),'form-suggestion-option'));
    }else if(ctx.kind==='login'){
      const items=(await cmd('vault-list')||[]).filter(item=>item.origin===ctx.origin&&item.autofill!==false);
      for(const item of items.slice(0,7)){
        panel.append(action('Fill · '+item.username,async()=>{
          const answer=await cmd('vault-fill',item.username);
          if(answer?.filled)hide();
          else window.minternetToast?.('No matching login form found.');
        },'form-suggestion-option'));
      }
      if(ctx.saveReady)panel.append(action('＋ Save this login',async()=>{
        await approved('vault-capture-login',null,'Login encrypted and saved.');
      },'form-suggestion-option'));
      if(!items.length&&!ctx.saveReady)panel.append(
        create('small','form-suggestion-note','No saved login for this website.'));
      panel.append(action('✎ Edit Passwords',()=>openManager('login'),'form-suggestion-option'));
    }else if(ctx.kind==='payment'){
      const cards=await cmd('vault-card-list')||[];
      for(const card of cards.slice(0,7)){
        panel.append(action('Fill · '+(card.label||card.name)+' ••••'+card.last4,async()=>{
          const response=await cmd('vault-card-fill',card.id);
          if(response?.filled)hide();
        },'form-suggestion-option'));
      }
      if(!cards.length)panel.append(create('small','form-suggestion-note','No saved payment methods.'));
      panel.append(action('✎ Save or Edit Payment Method',()=>openManager('payment'),'form-suggestion-option'));
    }else{
      const identities=await cmd('vault-identity-list')||[];
      for(const entry of identities.slice(0,10)){
        if(entry.fields.includes(ctx.key)){
          panel.append(action('Fill · '+entry.label,async()=>{
            const response=await cmd('vault-identity-fill',entry.id);
            if(response?.filled)hide();
          },'form-suggestion-option'));
        }
        if(ctx.hasValue){
          panel.append(action('＋ Save to '+entry.label,async()=>{
            await approved('vault-identity-capture',{id:entry.id,key:ctx.key,index:ctx.fieldIndex},'Saved to '+entry.label);
          },'form-suggestion-option'));
        }
      }
      if(ctx.hasValue)panel.append(action('＋ Save as New Identity',async()=>{
        await approved('vault-identity-capture',{key:ctx.key,index:ctx.fieldIndex},'Identity encrypted and saved. Edit it in Settings.');
      },'form-suggestion-option'));
      panel.append(action('✎ Edit Identities',()=>openManager('identity'),'form-suggestion-option'));
    }
    const footer=create('div','form-suggestion-footer');
    footer.append(action('Ignore',()=>hide(true),'form-suggestion-ignore'));
    panel.append(footer);
    await cmd('chrome-overlay',true);
  }
  async function probe(){
    if(busy||isOpen()||otherDialogs()||document.visibilityState==='hidden')return;
    busy=true;
    try{
      const ctx=await cmd('browser-form-context');
      if(!ctx||!['login','payment','identity'].includes(ctx.kind)){
        ignored=null;return;
      }
      if(ignored===fingerprint(ctx))return;
      await render(ctx);
    }catch{/* HTTPS, private pages and unready tabs have no autofill context. */}
    finally{busy=false;}
  }
  // Low-priority field detection. No remote password/identity values are read
  // on this timer: only type, focus rectangle and whether a field has text.
  setInterval(()=>{void probe();},700);
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&isOpen()){event.preventDefault();hide(true);}
  });
  window.minternetFormSuggestions={close:hide};
})();