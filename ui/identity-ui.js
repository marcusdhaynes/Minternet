'use strict';
// Identity records never live in localStorage. Only the native password vault
// encrypts and stores them. Pages never receive a profile until explicit Fill.
(()=>{
  const trigger=document.getElementById('identityManagerOpen');
  if(!trigger||!window.minternet)return;
  const command=(name,value)=>window.minternet.command(name,value);
  const sections=[
    ['Personal',[
      ['full-name','Full Name'],['given-name','First Name'],['middle-name','Middle Name'],
      ['family-name','Last Name'],['nickname','Preferred Name'],
      ['date-of-birth','Date of Birth'],['email','Email'],['phone','Phone']
    ]],
    ['Addresses',[
      ['street-address','Full Street Address'],['address-line1','Address Line 1'],
      ['address-line2','Apt / Suite / Address 2'],['city','City'],
      ['region','State / Province'],['postal-code','ZIP / Postal Code'],['country','Country']
    ]],
    ['Work',[
      ['company','Company'],['job-title','Job Title'],['website','Website']
    ]],
    ['Government & Travel',[
      ['national-id','National ID Number'],['tax-id','Tax ID Number'],
      ['passport-number','Passport Number'],['passport-country','Issuing Country'],
      ['passport-expiry','Passport Expiration'],
      ['drivers-license','Driver License Number'],['drivers-license-state','License Issuing State']
    ]],
    ['Vehicle',[
      ['vehicle-make','Make'],['vehicle-model','Model'],['vehicle-year','Year'],
      ['vehicle-color','Color'],['license-plate','License Plate'],['vin','VIN']
    ]]
  ];
  const allKeys=new Set(sections.flatMap(section=>section[1].map(field=>field[0])));
  const make=(tag,cls,label)=>{
    const node=document.createElement(tag);
    if(cls)node.className=cls;
    if(label!==undefined)node.textContent=label;
    return node;
  };
  let screen=null,statusNode=null,auth=null,editor=null,list=null,master=null;
  let editingId=null,inputs=new Map(),customContainer=null;
  let unlocked=false,exists=false;
  const report=message=>{if(statusNode)statusNode.textContent=String(message||'');};
  async function call(name,payload){
    try{return await command(name,payload);}
    catch(error){report(error.message||'Operation failed');return null;}
  }
  function clearEditor(){
    editingId=null;
    for(const input of inputs.values())input.value='';
    customContainer?.replaceChildren();
    const label=screen?.querySelector('.identity-label');
    if(label)label.value='';
    const save=screen?.querySelector('.identity-save');
    if(save)save.textContent='Save Encrypted Identity';
  }
  function close(){
    if(!screen)return;
    clearEditor();
    screen.remove();
    screen=null;statusNode=null;auth=null;editor=null;list=null;master=null;
    inputs=new Map();customContainer=null;editingId=null;
    if(window.__TAURI__)void command('chrome-overlay',false);
  }
  function field(key,label,value=''){
    const wrapper=make('label','identity-field');
    const caption=make('span','',label);
    const input=make('input');
    input.type='text';input.autocomplete='off';input.spellcheck=false;
    input.maxLength=400;input.value=value;input.dataset.field=key;
    wrapper.append(caption,input);
    return {wrapper,input};
  }
  function addCustom(key='',value=''){
    if(!customContainer)return;
    const row=make('div','identity-custom-row');
    const keyInput=make('input');
    keyInput.placeholder='Custom field (e.g. membership-number)';
    keyInput.maxLength=38;keyInput.autocomplete='off';keyInput.value=key;
    const valueInput=make('input');
    valueInput.placeholder='Value';valueInput.maxLength=400;
    valueInput.autocomplete='off';valueInput.value=value;
    const remove=make('button','','×');remove.type='button';
    remove.title='Remove custom field';
    remove.addEventListener('click',()=>row.remove());
    row.append(keyInput,valueInput,remove);
    customContainer.append(row);
  }
  function syncUi(){
    auth.hidden=unlocked;editor.hidden=!unlocked;
    const lock=screen.querySelector('.identity-lock');
    lock.hidden=!unlocked;
    const button=screen.querySelector('.identity-auth-button');
    button.textContent=exists?'Unlock':'Create Encrypted Vault';
  }
  async function reload(){
    const result=await call('vault-status');
    if(!result)return;
    exists=Boolean(result.exists);unlocked=Boolean(result.unlocked);
    syncUi();
    if(!unlocked)return;
    const records=await call('vault-identity-list');
    if(!Array.isArray(records))return;
    list.replaceChildren();
    if(!records.length)list.append(make('p','identity-empty','No identities saved.'));
    for(const item of records){
      const row=make('div','identity-saved-row');
      const label=make('div','identity-saved-label');
      label.append(make('strong','',item.label),
        make('small','',item.fields.length+' saved fields'));
      const fill=make('button','','Fill');fill.type='button';
      fill.title='Fill matching fields in the selected HTTPS page';
      fill.addEventListener('click',async()=>{
        const result=await call('vault-identity-fill',item.id);
        if(result?.filled){close();window.minternetToast?.('Identity fields offered to current page.');}
        else report('No active HTTPS page is ready for filling.');
      });
      const edit=make('button','','✎');edit.type='button';edit.title='Edit identity';
      edit.addEventListener('click',async()=>{
        const details=await call('vault-identity-get',item.id);
        if(!details)return;
        clearEditor();editingId=item.id;
        screen.querySelector('.identity-label').value=details.label;
        for(const [key,value] of Object.entries(details.fields||{})){
          if(allKeys.has(key)){const input=inputs.get(key);if(input)input.value=value;}
          else if(key.startsWith('custom-'))addCustom(key.slice(7),value);
        }
        screen.querySelector('.identity-save').textContent='Update Encrypted Identity';
        screen.querySelector('.identity-label').focus();
      });
      const remove=make('button','','×');remove.type='button';remove.title='Delete identity';
      remove.addEventListener('click',async()=>{
        if(!window.confirm('Delete identity '+item.label+'?'))return;
        const result=await call('vault-identity-remove',item.id);
        if(result?.ok){clearEditor();await reload();}
      });
      row.append(label,fill,edit,remove);list.append(row);
    }
  }
  async function open(){
    if(!window.__TAURI__){
      window.minternetToast?.('Encrypted identities require native Minternet.');
      return;
    }
    window.minternetBookmarks?.closeOverlay();
    window.minternetPayment?.close?.();
    window.minternetHistory?.close?.();
    screen=make('section','payment-screen identities-screen');
    screen.setAttribute('aria-label','Encrypted Identities');
    const backdrop=make('div','payment-backdrop');
    backdrop.addEventListener('click',close);
    const panel=make('aside','payment-panel identity-panel');
    panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
    const head=make('div','payment-head');
    head.append(make('strong','','Identities'));
    const lock=make('button','identity-lock','Lock');lock.type='button';
    lock.addEventListener('click',async()=>{
      const result=await call('vault-lock');
      if(result?.ok){unlocked=false;syncUi();clearEditor();report('Encrypted vault locked.');}
    });
    const exit=make('button','','×');exit.type='button';exit.title='Close';
    exit.addEventListener('click',close);head.append(lock,exit);
    const info=make('p','payment-info',
      'Names, addresses, passports, IDs, vehicles and custom fields stay encrypted under your master password. Filling a website requires your approval.');
    auth=make('form','payment-auth');
    const credential=field('master','Master Password');
    master=credential.input;master.type='password';master.minLength=12;
    const unlock=make('button','identity-auth-button','Unlock');unlock.type='submit';
    auth.append(credential.wrapper,unlock);
    auth.addEventListener('submit',async event=>{
      event.preventDefault();
      const secret=master.value;master.value='';
      const result=await call(exists?'vault-unlock':'vault-create',secret);
      if(result?.ok){exists=true;unlocked=true;await reload();report('Vault unlocked.');}
    });
    editor=make('div','identity-editor');
    const savedTitle=make('strong','identity-subheading','Saved Identities');
    list=make('div','identity-list');
    const reset=make('button','identity-new','＋ New Identity');reset.type='button';
    reset.addEventListener('click',()=>clearEditor());
    const form=make('form','identity-form');
    form.autocomplete='off';
    const identityLabel=make('label','identity-field');
    identityLabel.append(make('span','','Identity Name'),
      make('input','identity-label'));
    const labelInput=identityLabel.querySelector('input');
    labelInput.required=true;labelInput.maxLength=80;
    labelInput.placeholder='Personal, Work, Family, Vehicle…';
    form.append(identityLabel);
    for(const [sectionName,fields] of sections){
      const group=make('section','identity-section');
      group.append(make('strong','',sectionName));
      const grid=make('div','identity-fields-grid');
      for(const [key,label] of fields){
        const rendered=field(key,label);
        inputs.set(key,rendered.input);
        grid.append(rendered.wrapper);
      }
      group.append(grid);form.append(group);
    }
    const custom=make('section','identity-section');
    custom.append(make('strong','','Other / Custom Information'));
    customContainer=make('div','identity-custom');
    const add=make('button','identity-new','＋ Add Custom Field');
    add.type='button';add.addEventListener('click',()=>addCustom());
    custom.append(customContainer,add);form.append(custom);
    const save=make('button','identity-save','Save Encrypted Identity');save.type='submit';
    form.append(save);
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const fields={};
      for(const [key,input] of inputs)if(input.value.trim())fields[key]=input.value.trim();
      for(const row of customContainer.children){
        const [nameInput,valueInput]=row.querySelectorAll('input');
        const name=nameInput.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g,'-');
        if(name&&valueInput.value.trim())fields['custom-'+name]=valueInput.value.trim();
      }
      const label=labelInput.value.trim();
      if(!label||!Object.keys(fields).length){report('Add a name and at least one field.');return;}
      const result=await call('vault-identity-put',{
        id:editingId||undefined,label,fields
      });
      if(result?.ok){clearEditor();await reload();report('Identity encrypted and saved.');}
    });
    editor.append(savedTitle,list,reset,form);
    statusNode=make('p','payment-status');
    panel.append(head,info,auth,editor,statusNode);
    screen.append(backdrop,panel);document.body.append(screen);
    await command('chrome-overlay',true);
    await reload();
    (unlocked?labelInput:master).focus();
  }
  document.addEventListener('pointerdown',event=>{
    if(screen&&!screen.querySelector('.identity-panel')?.contains(event.target)&&!trigger.contains(event.target))close();
  },true);
  window.addEventListener?.('blur',()=>{if(screen)close();});
  trigger.addEventListener('click',()=>void open());
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&screen){event.preventDefault();close();}
  });
  window.minternetIdentities={open,close};
})();