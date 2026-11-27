'use strict';
// Trusted-chrome switches; native IPC owns every policy and credential.
(()=>{
  const command=(name,payload)=>window.minternet.command(name,payload);
  function mount(host,section,onChanged=()=>{},caption='Password Protection'){
    if(!host)return null;
    const root=document.createElement('div');root.className='vault-password-toggle';
    const label=document.createElement('label');label.className='vault-password-switch';
    const toggle=document.createElement('input');toggle.type='checkbox';toggle.disabled=true;
    const text=document.createElement('span');text.textContent=caption;
    label.append(toggle,text);root.append(label);
    const form=document.createElement('form');form.hidden=true;form.className='vault-password-form';form.autocomplete='off';
    const note=document.createElement('p');
    const password=document.createElement('input');password.type='password';password.autocomplete='off';password.maxLength=1024;password.setAttribute('aria-label','Vault password');
    const confirmation=document.createElement('input');confirmation.type='password';confirmation.autocomplete='new-password';confirmation.maxLength=1024;confirmation.placeholder='Confirm password';confirmation.setAttribute('aria-label','Confirm password');
    const save=document.createElement('button');save.type='submit';save.textContent='Apply';
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';
    const status=document.createElement('small');status.setAttribute('role','status');
    form.append(note,password,confirmation,save,cancel);root.append(form,status);host.prepend(root);
    // Put the switch immediately after the manager's title, not above it.
    const heading=host.querySelector('.vault-head,.payment-head,.secret-head');
    if(heading)heading.after(root);
    let required=true,supported=false,desired=true,policy=null,busy=false;
    function clear(){password.value='';confirmation.value='';form.hidden=true;toggle.checked=required;}
    function setRequired(value){required=Boolean(value);toggle.checked=required;toggle.disabled=!supported||busy;}
    async function refresh(){
      try{
        const result=await command('lock-preferences-get');
        if(result?.message)throw Error(result.message);
        supported=result?.supported===true;policy=result?.passwordRequired||{};
        setRequired(policy[section]!==false);
        if(!supported)status.textContent='Device automatic unlock is unavailable on this platform.';
      }catch(error){toggle.disabled=true;status.textContent=String(error?.message||error);}
    }
    toggle.addEventListener('change',async()=>{
      if(!supported||busy)return;
      desired=toggle.checked;toggle.checked=required;
      await refresh();
      if(desired===required)return;
      form.hidden=false;
      const another=section!=='bookmarks'&&['logins','identities','payments'].some(key=>key!==section&&policy?.[key]===true);
      const choose=desired&&!another;
      password.placeholder=choose?'New password':desired?'Existing shared master password':'Current password (if vault exists)';
      confirmation.hidden=!choose;confirmation.required=choose;password.required=desired;
      note.textContent=choose?(section==='bookmarks'?'Choose a 1–16 character Secret Bookmarks password.':'Choose a master password of at least 12 characters. Protected login, identity and payment sections share this password.'):
        desired?'Use the master password already shared by the protected sections.':'Enter your current password once. Anyone using your signed-in Windows account may then access this section.';
      save.textContent=desired?'Enable':'Disable';status.textContent='';password.focus();
    });
    cancel.addEventListener('click',clear);
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;
      if(!confirmation.hidden&&password.value!==confirmation.value){status.textContent='Passwords do not match.';return;}
      const payload={section,locked:desired,password:password.value};password.value='';confirmation.value='';
      busy=true;toggle.disabled=true;save.disabled=true;
      try{
        const result=await command('lock-preferences-set',payload);
        if(!result?.ok||result?.message)throw Error(result?.message||'Password setting could not be changed.');
        policy=result.passwordRequired;setRequired(policy[section]!==false);clear();
        status.textContent=required?'Password protection enabled.':'Password protection disabled.';
        window.dispatchEvent(new CustomEvent('minternet:password-policy',{detail:policy}));
        await onChanged(required);
      }catch(error){status.textContent=String(error?.message||error);await refresh();}
      finally{payload.password='';busy=false;save.disabled=false;toggle.disabled=!supported;}
    });
    window.addEventListener('minternet:password-policy',event=>{
      if(!root.isConnected)return;
      policy=event.detail;setRequired(policy[section]!==false);
    });
    void refresh();
    return {refresh,clear,setRequired};
  }
  window.minternetPasswordProtection={mount};
})();
