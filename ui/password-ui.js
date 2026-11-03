'use strict';
// Runs ONLY in trusted local Minternet chrome. Never exposes passwords to a
// website or stores credentials in localStorage.
(() => {
  const $=id=>document.getElementById(id);
  const screen=$('passwordVaultScreen');
  if(!screen)return;
  const call=(name,value)=>window.minternet?.command(name,value);
  let existing=false,unlocked=false;
  function report(message){$('vaultMessage').textContent=String(message||'');}
  async function invoke(name,value){
    try{
      const result=await call(name,value);
      if(result?.message)throw Error(result.message);
      return result;
    }catch(e){report(e?.message||'Operation failed');return null;}
  }
  function activeSite(){
    const latest=window.minternetGroups?.getLatest();
    const active=latest?.tabs?.find(t=>t.id===latest.activeId);
    if(active?.private)return '';
    try{return new URL(active?.url).protocol==='https:'?new URL(active.url).origin:'';}catch{return '';}
  }
  function sync(){
    $('vaultAuthForm').hidden=unlocked;
    $('vaultUnlocked').hidden=!unlocked;
    $('vaultLock').hidden=!unlocked;
    $('vaultAuthButton').textContent=existing?'Unlock':'Create Encrypted Vault';
  }
  async function refresh(){
    const status=await invoke('vault-status');
    if(!status)return;
    existing=Boolean(status.exists);unlocked=Boolean(status.unlocked);
    sync();
    if(unlocked)await list();
  }
  async function list(){
    const data=await invoke('vault-list');
    if(!Array.isArray(data))return;
    const host=$('vaultEntries');host.replaceChildren();
    if(!data.length){host.textContent='No saved passwords yet.';return;}
    for(const entry of data){
      const row=document.createElement('div');row.className='vault-entry';
      const caption=document.createElement('span');caption.className='vault-caption';
      const domain=document.createElement('strong');domain.textContent=entry.origin;
      const username=document.createElement('small');username.textContent=entry.username;
      caption.append(domain,username);
      const fill=document.createElement('button');fill.type='button';fill.textContent='Fill';fill.title='Fill current website (matching HTTPS origin only)';
      fill.addEventListener('click',async()=>{
        if(activeSite()!==entry.origin){report('Open '+entry.origin+' in the selected tab before filling.');return;}
        const answer=await invoke('vault-fill',entry.username);
        if(answer?.filled){close();}else report('No matching login form found. Open the login page first.');
      });
      const del=document.createElement('button');del.type='button';del.textContent='×';
      del.className='vault-delete';del.title='Delete saved login';
      del.addEventListener('click',async()=>{
        if(!window.confirm('Delete the saved login for '+entry.origin+'?'))return;
        const result=await invoke('vault-remove',{origin:entry.origin,username:entry.username});
        if(result?.ok)await list();
      });
      row.append(caption,fill,del);host.append(row);
    }
  }
  async function open(){
    if(!window.__TAURI__){
      window.minternetToast?.('Encrypted passwords require the native desktop version.');
      return;
    }
    window.minternetBookmarks?.closeOverlay();
    screen.hidden=false;
    await invoke('chrome-overlay',true);
    $('vaultOrigin').value=activeSite();
    report('');
    await refresh();
    (unlocked?$('vaultUsername'):$('vaultMaster')).focus();
  }
  function close(){
    screen.hidden=true;
    $('vaultMaster').value='';
    $('vaultPassword').value='';
    report('');
    if(window.__TAURI__)void invoke('chrome-overlay',false);
  }
  $('passwordManagerOpen').addEventListener('click',open);
  $('vaultBackdrop').addEventListener('click',close);
  $('vaultClose').addEventListener('click',close);
  $('vaultLock').addEventListener('click',async()=>{
    const result=await invoke('vault-lock');
    if(result?.ok){unlocked=false;sync();$('vaultMaster').value='';report('Vault locked.');}
  });
  $('vaultAuthForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const input=$('vaultMaster'),password=input.value;
    input.value='';
    const result=await invoke(existing?'vault-unlock':'vault-create',password);
    if(result?.ok){existing=true;unlocked=true;sync();await list();$('vaultUsername').focus();report('Vault unlocked on this device.');}
  });
  $('vaultEntryForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const origin=$('vaultOrigin').value,username=$('vaultUsername').value;
    const password=$('vaultPassword').value,autofill=$('vaultAutofill').checked;
    $('vaultPassword').value='';
    const result=await invoke('vault-put',{origin,username,password,autofill});
    if(result?.ok){await list();report('Encrypted login saved.');}
  });
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!screen.hidden){event.preventDefault();close();}
  });
})();
