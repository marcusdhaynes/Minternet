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
  // The trusted chrome WebView is only 52-96px tall when its overlay is
  // closed. Measuring a popup against that tiny viewport used to produce
  // a NEGATIVE top and draw a giant purple rectangle over the tab strip.
  // This function is only called after native chrome-overlay has expanded.
  function positionPanel(ctx){
    const chromeTop=Number.isFinite(ctx.top)?Math.max(0,ctx.top):52;
    const width=window.innerWidth,height=window.innerHeight;
    if(width<160||height<=chromeTop+64)return false;
    const popupWidth=Math.min(280,Math.max(176,Number(ctx.width)||176),width-16);
    panel.style.width=popupWidth+'px';
    panel.style.maxHeight=Math.max(64,height-chromeTop-12)+'px';
    panel.style.left=Math.max(8,Math.min(Number(ctx.x)||8,width-popupWidth-8))+'px';
    // Measure actual content, not an assumed 170px. A short list must not
    // jump to the top of the browser when the page is near the viewport end.
    const ideal=chromeTop+Math.max(5,Number(ctx.y)||0)+3;
    panel.style.top=Math.max(chromeTop+4,
      Math.min(ideal,height-panel.offsetHeight-8))+'px';
    return true;
  }
  async function render(ctx){
    // Do not open a toolbar-obscuring dialog merely because a site has a
    // login or email field. Show it only when there is something useful.
    const status=await cmd('vault-status');
    const locked=!status?.unlocked;
    // The master key is intentionally not persisted between browser runs.
    // A locked vault previously suppressed all suggestions silently. Offer
    // an explicit unlock action, never a hidden password or auto-unlock.
    if(locked && (ctx.kind!=='login'||(!status?.exists&&!ctx.saveReady)))return;
    let logins=[],cards=[],identities=[];
    if(ctx.kind==='login'){
      if(!locked){
        const all=await cmd('vault-list');
        logins=(Array.isArray(all)?all:[]).filter(item=>
          item.origin===ctx.origin&&item.autofill!==false);
        if(!logins.length&&!ctx.saveReady)return;
      }
    }else if(ctx.kind==='payment'){
      const all=await cmd('vault-card-list');
      cards=Array.isArray(all)?all:[];
      if(!cards.length)return;
    }else{
      const all=await cmd('vault-identity-list');
      identities=Array.isArray(all)?all:[];
      if(!ctx.hasValue&&!identities.some(item=>
        Array.isArray(item.fields)&&item.fields.includes(ctx.key)))return;
    }
    if(otherDialogs()||document.visibilityState==='hidden')return;
    active=ctx;
    panel.replaceChildren();
    const head=create('div','form-suggestion-head');
    head.append(create('strong','',ctx.kind==='login'?'Logins':
      ctx.kind==='payment'?'Payment Methods':'Identities'));
    head.append(action('×',()=>hide(true),'form-suggestion-x'));
    panel.append(head);
    if(ctx.kind==='login'){
      if(locked){
        panel.append(create('p','form-suggestion-help',
          status?.exists
            ? 'Saved logins are locked. Unlock your encrypted vault to fill them.'
            : 'Set up Passwords to securely save this login.'));
        panel.append(action(status?.exists?'Unlock Saved Logins':'Set Up Passwords',
          ()=>openManager('login'),'form-suggestion-option'));
      }else{
      for(const item of logins.slice(0,7)){
        panel.append(action('Fill · '+item.username,async()=>{
          const answer=await cmd('vault-fill',item.username);
          if(answer?.filled)hide();
          else window.minternetToast?.('No matching login form found.');
        },'form-suggestion-option'));
      }
      if(ctx.saveReady)panel.append(action('＋ Save this login',async()=>{
        await approved('vault-capture-login',null,'Login encrypted and saved.');
      },'form-suggestion-option'));
      panel.append(action('✎ Edit Logins',()=>openManager('login'),'form-suggestion-option'));
      }
    }else if(ctx.kind==='payment'){
      for(const card of cards.slice(0,7)){
        panel.append(action('Fill · '+(card.label||card.name)+' ••••'+card.last4,async()=>{
          const response=await cmd('vault-card-fill',card.id);
          if(response?.filled)hide();
        },'form-suggestion-option'));
      }
      panel.append(action('✎ Save or Edit Payment Method',()=>openManager('payment'),'form-suggestion-option'));
    }else{
      for(const entry of identities.slice(0,10)){
        if(Array.isArray(entry.fields)&&entry.fields.includes(ctx.key)){
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

    // IMPORTANT: expand the native chrome WebView BEFORE reading innerHeight.
    const expanded=await cmd('chrome-overlay',true);
    if(expanded?.message){hide();return;}
    for(let i=0;i<4&&window.innerHeight<=ctx.top+64;i++){
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
    if(!active||fingerprint(active)!==fingerprint(ctx)||otherDialogs()){
      hide();return;
    }
    panel.style.visibility='hidden';
    panel.hidden=false;
    if(!positionPanel(ctx)){hide();return;}
    backdrop.hidden=false;
    panel.style.visibility='';
  }
  window.addEventListener('resize',()=>{
    if(active&&isOpen()&&!positionPanel(active))hide();
  });
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