'use strict';
// Payment methods live only in the same Argon2id + ChaCha20-Poly1305 native
// vault as saved logins. The UI receives masked metadata, never a saved PAN.
// Filling is always explicit, HTTPS-only, and never inserts a CVV.
(() => {
  const $=id=>document.getElementById(id);
  const trigger=$('paymentManagerOpen');
  const toolbar=$('paymentToolbarButton');
  if(!trigger||!window.minternet)return;
  const invoke=async(name,value)=>{
    try{
      const answer=await window.minternet.command(name,value);
      if(answer?.message)throw Error(answer.message);
      return answer;
    }catch(err){
      report(err?.message||'Operation unavailable');
      return null;
    }
  };
  const create=(tag,cls,text)=>{
    const el=document.createElement(tag);if(cls)el.className=cls;
    if(text!==undefined)el.textContent=text;return el;
  };
  let screen=null,panel=null,auth=null,form=null,list=null,status=null,master=null,locked=true,exists=false;
  let editingId=null,editFields=null;
  function report(text){if(status)status.textContent=String(text||'');}
  function close(){
    if(!screen)return;
    toolbar?.setAttribute('aria-expanded','false');
    screen.remove();screen=null;panel=null;auth=null;form=null;list=null;status=null;master=null;
    editingId=null;editFields=null;
    if(window.__TAURI__)void window.minternet.command('chrome-overlay',false);
  }
  function field(label,opts={}){
    const wrapper=create('label','payment-field');
    const caption=create('span','',label);
    const input=create('input');
    input.type=opts.type||'text';
    input.autocomplete='off';
    input.placeholder=opts.placeholder||'';
    input.required=Boolean(opts.required);
    input.maxLength=opts.maxLength||120;
    if(opts.inputMode)input.inputMode=opts.inputMode;
    if(opts.pattern)input.pattern=opts.pattern;
    wrapper.append(caption,input);
    return {wrapper,input};
  }
  function sync(){
    if(!screen)return;
    auth.hidden=!locked;
    form.hidden=locked;
    list.hidden=locked;
    panel.querySelector('.payment-lock').hidden=locked;
    panel.querySelector('.payment-auth-button').textContent=exists?'Unlock':'Create Encrypted Vault';
  }
  async function refresh(){
    const data=await invoke('vault-status');
    if(!data)return;
    exists=Boolean(data.exists);locked=!data.unlocked;
    sync();
    if(!locked)await renderCards();
  }
  async function renderCards(){
    if(!list)return;
    const cards=await invoke('vault-card-list');
    if(!Array.isArray(cards))return;
    list.replaceChildren();
    if(!cards.length){list.append(create('p','payment-empty','No payment methods saved yet.'));return;}
    for(const card of cards){
      const row=create('div','payment-card');
      const caption=create('div','payment-card-caption');
      caption.append(create('strong','',card.label||'Payment Card'),
        create('small','',card.name+' · •••• '+card.last4+
          ' · '+String(card.month).padStart(2,'0')+'/'+card.year));
      const fill=create('button','payment-card-fill','Fill');
      fill.type='button';fill.title='Fill recognized checkout fields in the active HTTPS tab';
      fill.addEventListener('click',async()=>{
        const result=await invoke('vault-card-fill',card.id);
        if(result?.filled){report('Card details sent to the active HTTPS page. Check the checkout fields before paying.');}
        else if(result){report('No matching checkout fields were found.');}
      });
      const edit=create('button','payment-card-edit','✎');
      edit.type='button';edit.title='Edit cardholder, label, expiry and billing postal code';
      edit.addEventListener('click',()=>{
        if(!editFields)return;
        editingId=card.id;
        editFields.name.value=card.name;
        editFields.label.value=card.label;
        editFields.month.value=String(card.month);
        editFields.year.value=String(card.year);
        editFields.postal.value=card.postal||'';
        editFields.number.value='';
        editFields.number.required=false;
        editFields.numberWrapper.hidden=true;
        editFields.save.textContent='Save Card Changes';
        editFields.cancel.hidden=false;
        editFields.name.focus();
      });
      const del=create('button','payment-card-delete','×');
      del.type='button';del.title='Delete saved payment method';
      del.addEventListener('click',async()=>{
        if(!window.confirm('Delete saved payment method ending in '+card.last4+'?'))return;
        const result=await invoke('vault-card-remove',card.id);
        if(result?.ok){report('Payment method deleted.');await renderCards();}
      });
      row.append(caption,fill,edit,del);list.append(row);
    }
  }
  async function open(){
    if(screen){close();return;}
    if(!window.__TAURI__){window.minternetToast?.('Encrypted payment methods require the Windows desktop app.');return;}
    window.minternetHistory?.close?.();
    window.minternetBookmarks?.closeOverlay();
    screen=create('section','payment-screen');
    toolbar?.setAttribute('aria-expanded','true');
    screen.setAttribute('aria-label','Encrypted Payment Methods');
    const backdrop=create('div','payment-backdrop');
    backdrop.addEventListener('click',close);
    panel=create('aside','payment-panel');
    panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
    panel.setAttribute('aria-label','Saved Payment Methods');
    const header=create('div','payment-head');
    header.append(create('strong','','Payment Methods'));
    const lock=create('button','payment-lock','Lock');lock.type='button';
    lock.addEventListener('click',async()=>{
      const result=await invoke('vault-lock');
      if(result?.ok){locked=true;sync();report('Vault locked.');master?.focus();}
    });
    const x=create('button','payment-close','×');x.type='button';
    x.setAttribute('aria-label','Close Payment Methods');
    x.addEventListener('click',close);
    header.append(lock,x);
    const info=create('p','payment-info',
      'Encrypted locally with your master password. Never stores card security codes (CVV).');
    auth=create('form','payment-auth');
    auth.autocomplete='off';
    const pwd=field('Master Password',{type:'password',required:true,maxLength:1024});
    master=pwd.input;master.minLength=12;
    const unlock=create('button','payment-auth-button','Unlock');unlock.type='submit';
    auth.append(pwd.wrapper,unlock);
    auth.addEventListener('submit',async event=>{
      event.preventDefault();
      const secret=master.value;master.value='';
      const result=await invoke(exists?'vault-unlock':'vault-create',secret);
      if(result?.ok){exists=true;locked=false;sync();await renderCards();report('Encrypted vault unlocked.');}
    });
    form=create('form','payment-form');
    form.autocomplete='off';
    const name=field('Cardholder Name',{required:true,placeholder:'Name on card'});
    const label=field('Label',{placeholder:'Personal, Work…'});
    const number=field('Card Number',{type:'password',required:true,inputMode:'numeric',maxLength:40,placeholder:'•••• •••• •••• ••••'});
    const expiry=create('div','payment-expiry');
    const month=field('Expiry Month',{type:'number',required:true,placeholder:'MM'});
    month.input.min='1';month.input.max='12';
    const year=field('Expiry Year',{type:'number',required:true,placeholder:'YYYY'});
    year.input.min='2020';year.input.max='2100';
    expiry.append(month.wrapper,year.wrapper);
    const postal=field('Billing Postal Code',{placeholder:'Optional'});
    const save=create('button','payment-save','Save Encrypted Payment Method');
    save.type='submit';
    const cancel=create('button','payment-cancel','Cancel Edit');
    cancel.type='button';cancel.hidden=true;
    const resetEdit=()=>{
      editingId=null;
      form.reset();
      number.input.value='';
      number.input.required=true;
      number.wrapper.hidden=false;
      cancel.hidden=true;
      save.textContent='Save Encrypted Payment Method';
    };
    cancel.addEventListener('click',resetEdit);
    editFields={
      name:name.input,label:label.input,number:number.input,
      numberWrapper:number.wrapper,month:month.input,year:year.input,
      postal:postal.input,save,cancel
    };
    form.append(name.wrapper,label.wrapper,number.wrapper,expiry,postal.wrapper,save,cancel);
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const details={
        name:name.input.value.trim(),label:label.input.value.trim(),
        month:Number(month.input.value),year:Number(year.input.value),
        postal:postal.input.value.trim()
      };
      const editing=Boolean(editingId);
      const result=await invoke(editing?'vault-card-update':'vault-card-put',
        editing?{...details,id:editingId}:{...details,number:number.input.value});
      number.input.value='';
      if(result?.ok){
        resetEdit();
        report(editing?'Payment method updated.':'Payment method encrypted and saved.');
        await renderCards();
      }
    });
    const sub=create('strong','payment-list-heading','Saved Cards');
    list=create('div','payment-list');
    status=create('p','payment-status');
    panel.append(header,info,auth,form,sub,list,status);
    screen.append(backdrop,panel);document.body.append(screen);
    await invoke('chrome-overlay',true);
    await refresh();
    (locked?master:name.input).focus();
  }
  document.addEventListener('pointerdown',event=>{
    if(screen && !panel?.contains(event.target))close();
  },true);
  window.addEventListener?.('blur',()=>{if(screen)close();});
  trigger.addEventListener('click',()=>void open());
  toolbar?.addEventListener('click',()=>void open());
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&screen){event.preventDefault();close();}
  });
  window.minternetPayment={open,close};
})();
