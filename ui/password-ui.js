'use strict';
// Runs ONLY in trusted local Minternet chrome. Never exposes passwords to a
// website or stores credentials in localStorage.
(() => {
  const $=id=>document.getElementById(id);
  const screen=$('passwordVaultScreen');
  if(!screen)return;
  const call=(name,value)=>window.minternet?.command(name,value);
  let existing=false,unlocked=false;
  let entries=[];
  let searchTimer=0;
  $('vaultSearch')?.addEventListener('input',()=>{
    clearTimeout(searchTimer);
    searchTimer=setTimeout(renderEntries,55);
  });
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
    else {entries=[];renderEntries();}
  }
  async function list(){
    const data=await invoke('vault-list');
    if(!Array.isArray(data))return;
    entries=data;
    renderEntries();
  }
  function renderEntries(){
    const host=$('vaultEntries');host.replaceChildren();
    if(!entries.length){host.textContent='No saved logins yet.';return;}
    const query=($('vaultSearch')?.value||'').trim().toLocaleLowerCase();
    let visible=0;
    for(const entry of entries){
      const site=window.MinternetSiteNames?.label(entry.origin)||entry.origin;
      if(query&&![site,entry.origin,entry.username].join(' ')
          .toLocaleLowerCase().includes(query))continue;
      visible++;
      const row=document.createElement('div');row.className='vault-entry';
      const caption=document.createElement('span');caption.className='vault-caption';
      const domain=document.createElement('strong');domain.textContent=site;
      const username=document.createElement('small');
      username.textContent=entry.origin+' · '+entry.username;
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
    if(!visible)host.textContent='No matching logins';
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
  document.addEventListener('pointerdown',event=>{
    if(screen.hidden||screen.querySelector('.vault-panel')?.contains(event.target))return;
    close();
  },true);
  window.addEventListener?.('blur',()=>{if(!screen.hidden)close();});
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

  // Web Crypto CSPRNG with rejection sampling: no Math.random() for passwords.
  function securePassword(){
    const sets=['ABCDEFGHJKLMNPQRSTUVWXYZ','abcdefghijkmnopqrstuvwxyz','23456789','!@#$%^&*_-+='];
    const alphabet=sets.join('');
    function random(max){
      const limit=256-(256%max);let n;
      do{const bytes=new Uint8Array(1);crypto.getRandomValues(bytes);n=bytes[0];}while(n>=limit);
      return n%max;
    }
    const chars=sets.map(set=>set[random(set.length)]);
    while(chars.length<24)chars.push(alphabet[random(alphabet.length)]);
    for(let i=chars.length-1;i>0;i--){const j=random(i+1);[chars[i],chars[j]]=[chars[j],chars[i]];}
    return chars.join('');
  }
  $('vaultGeneratePassword').addEventListener('click',()=>{
    $('vaultPassword').value=securePassword();
    $('vaultPassword').type='text';
    report('Generated a unique 24-character password. Save it to the encrypted vault.');
  });
  $('vaultShowPassword').addEventListener('click',()=>{
    const input=$('vaultPassword');input.type=input.type==='password'?'text':'password';
  });
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!screen.hidden){event.preventDefault();close();}
  });
})();
