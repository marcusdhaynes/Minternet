'use strict';
// Runs ONLY in trusted local Minternet chrome. Never exposes passwords to a
// website or stores credentials in localStorage.
(() => {
  const $=id=>document.getElementById(id);
  const screen=$('passwordVaultScreen');
  if(!screen)return;
  const autoLock=window.minternetVaultAutoLock?.forSection('logins');
  autoLock?.mount(screen.querySelector('.vault-head'));
  const call=(name,value)=>window.minternet?.command(name,value);
  let existing=false,unlocked=false;
  let entries=[],editing=null;
  const isWguOrigin=origin=>{
    try{
      const url=new URL(origin),host=url.hostname.toLowerCase();
      return url.protocol==='https:'&&(url.port===''||url.port==='443')&&
        (host==='wgu.edu'||host.endsWith('.wgu.edu'));
    }catch{return false;}
  };
  const siteMatches=(source,destination)=>source===destination||
    (isWguOrigin(source)&&isWguOrigin(destination));
  function resetEditor(){
    editing=null;
    $('vaultEntryTitle').textContent='Add Login';
    $('vaultEditCancel').hidden=true;
    $('vaultSaveButton').textContent='Save Login';
    $('vaultPasswordHint').hidden=true;
    $('vaultPassword').required=true;
    $('vaultPassword').value='';
    $('vaultPassword').type='password';
    $('vaultOrigin').value=activeSite();
    $('vaultUsername').value='';
    $('vaultAutofill').checked=true;
  }
  function editLogin(entry){
    editing={origin:entry.origin,username:entry.username};
    $('vaultEntryTitle').textContent='Edit Login';
    $('vaultEditCancel').hidden=false;
    $('vaultSaveButton').textContent='Save Changes';
    $('vaultPasswordHint').hidden=false;
    $('vaultPassword').required=false;
    $('vaultPassword').value='';
    $('vaultPassword').type='password';
    $('vaultOrigin').value=entry.origin;
    $('vaultUsername').value=entry.username;
    $('vaultAutofill').checked=entry.autofill!==false;
    $('vaultOrigin').focus();
    report('Editing '+entry.origin+'. Leave Password blank to retain the existing one.');
  }
  $('vaultEditCancel').addEventListener('click',()=>{resetEditor();report('Edit cancelled.');});
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
    autoLock?.setUnlocked(unlocked);
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
      const fill=document.createElement('button');fill.type='button';fill.textContent='Fill';
      fill.title='Fill the current matching HTTPS site (WGU family supported)';
      fill.addEventListener('click',async()=>{
        if(!siteMatches(entry.origin,activeSite())){
          report('Open '+entry.origin+' or a verified matching website first.');return;
        }
        const answer=await invoke('vault-fill',{origin:entry.origin,username:entry.username});
        if(!answer?.filled){
          report('No eligible login was sent. Check the saved website and unlocked vault.');
          return;
        }
        // Native accepted the injection, but that is NOT proof the fields
        // were filled. Reveal the webpage before checking both real values.
        const startingSite=activeSite();
        close();
        window.minternetToast?.('Filling saved login…');
        let confirmed=false,redirected=false;
        for(let attempt=0;attempt<12;attempt++){
          if(startingSite&&activeSite()&&activeSite()!==startingSite){
            redirected=true;
            window.minternetToast?.('Sign-on redirected; continue any WGU verification.');
            break;
          }
          await new Promise(done=>setTimeout(done,450));
          let status=null;
          try{status=await call('vault-fill-status');}catch{}
          if(status?.usernameFilled&&status?.passwordFilled){
            confirmed=true;
            window.minternetToast?.(
              status.submitted?'WGU Sign On submitted; complete any required verification.':
              'Username and password filled successfully.');
            break;
          }
        }
        if(!confirmed&&!redirected){
          window.minternetToast?.(
            'Fill was requested but the fields were not confirmed. Check that Logins is unlocked and retry.');
        }
      });
      if(isWguOrigin(entry.origin)){
        const wguDefault=document.createElement('button');
        wguDefault.type='button';wguDefault.className='vault-wgu-default';
        wguDefault.textContent=entry.preferred?'WGU Default ✓':'Use For WGU';
        wguDefault.title='Autofill this saved login on verified WGU websites';
        wguDefault.disabled=entry.autofill===false;
        wguDefault.addEventListener('click',async()=>{
          const result=await invoke('vault-wgu-default',{
            origin:entry.origin,username:entry.username
          });
          if(result?.ok){
            await list();
            report('Selected WGU login will autofill on verified WGU sign-in pages while Logins is unlocked.');
          }
        });
        row.append(caption,fill,wguDefault);
      }else row.append(caption,fill);
      const edit=document.createElement('button');edit.type='button';
      edit.textContent='Edit';edit.className='vault-edit';
      edit.title='Edit this saved login';
      edit.addEventListener('click',()=>editLogin(entry));
      const del=document.createElement('button');del.type='button';del.textContent='×';
      del.className='vault-delete';del.title='Delete saved login';
      del.addEventListener('click',async()=>{
        if(!window.confirm('Delete the saved login for '+entry.origin+'?'))return;
        const result=await invoke('vault-remove',{origin:entry.origin,username:entry.username});
        if(result?.ok)await list();
      });
      row.append(edit,del);host.append(row);
    }
    if(!visible)host.textContent='No matching logins';
  }
  async function open(){
    if(!window.__TAURI__){
      window.minternetToast?.('Encrypted passwords require the native desktop version.');
      return;
    }
    await autoLock?.openManager();
    window.minternetBookmarks?.closeOverlay();
    screen.hidden=false;
    await invoke('chrome-overlay',true);
    resetEditor();
    report('');
    await refresh();
    if(!unlocked)report('Autofill paused: unlock Logins or enable automatic unlock in Settings.');
    (unlocked?$('vaultUsername'):$('vaultMaster')).focus();
  }
  function close(){
    if(screen.hidden)return;
    screen.hidden=true;
    autoLock?.closeManager(unlocked);
    $('vaultMaster').value='';
    $('vaultPassword').value='';
    editing=null;
    report('');
    if(window.__TAURI__)void invoke('chrome-overlay',false);
  }
  // Passkeys are intentionally separate from the encrypted password vault.
  // The website's WebAuthn API must remain browser/OS-owned; Minternet never
  // asks the website to export secrets or implements fake credential objects.
  const passkeyStatus=$('passkeyStatus');
  function passkeyReport(message){if(passkeyStatus)passkeyStatus.textContent=String(message);}
  async function checkPasskeys(){
    passkeyReport('Checking Windows Hello and native WebAuthn…');
    try{
      const result=await call('passkey-status');
      if(!result||result.message)throw Error(result?.message||'Native capability check failed');
      const native=result.nativeProbeSucceeded
        ? (result.windowsHelloAvailable?'Windows Hello authenticator available':'No Windows Hello platform authenticator detected')
        : (result.platform==='windows'?'Windows WebAuthn capability check failed':'Windows Hello is not available on this platform');
      const api=result.nativeWebAuthnApiVersion==null?'':(' (Windows WebAuthn API v'+result.nativeWebAuthnApiVersion+')');
      passkeyReport(native+api+'. Website registration/sign-in is NOT verified; use Test WebAuthn for an end-to-end check.');
    }catch(e){passkeyReport('Unable to check passkeys: '+String(e?.message||e));}
  }
  $('passkeyCheck')?.addEventListener('click',checkPasskeys);
  $('passkeyManage')?.addEventListener('click',async()=>{
    try{
      const result=await call('passkey-open-settings');
      if(result?.message)throw Error(result.message);
      if(!result?.ok)throw Error('Windows Passkeys settings did not open');
      passkeyReport('Opened Windows Settings → Accounts → Passkeys. Windows manages credential details and deletion.');
    }catch(e){passkeyReport(String(e?.message||e));}
  });
  $('passkeyTest')?.addEventListener('click',async()=>{
    // A genuine registration/sign-in ceremony needs a relying-party server.
    // The user controls consent, and WebAuthn private keys never enter chrome.
    close();
    const result=await call('new-url','https://webauthn.io/');
    if(result?.message)window.minternetToast?.(result.message);
  });
  $('passwordManagerOpen').addEventListener('click',open);
  $('vaultBackdrop').addEventListener('click',close);
  document.addEventListener('pointerdown',event=>{
    if(screen.hidden||screen.querySelector('.vault-panel')?.contains(event.target))return;
    close();
  },true);
  window.addEventListener?.('blur',()=>{if(!screen.hidden)close();});
  $('vaultClose').addEventListener('click',close);
  $('vaultLock').addEventListener('click',async()=>{
    const result=await invoke('vault-lock','logins');
    if(result?.ok){unlocked=false;autoLock?.setUnlocked(false);sync();$('vaultMaster').value='';report('Vault locked.');}
  });
  $('vaultAuthForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const input=$('vaultMaster'),password=input.value;
    input.value='';
    const result=await invoke(existing?'vault-unlock':'vault-create',{password,section:'logins'});
    if(result?.ok){existing=true;unlocked=true;autoLock?.setUnlocked(true);sync();await list();$('vaultUsername').focus();report('Logins unlocked. Matching saved passwords can now autofill.');}
  });
  $('vaultEntryForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const origin=$('vaultOrigin').value,username=$('vaultUsername').value;
    const password=$('vaultPassword').value,autofill=$('vaultAutofill').checked;
    const command=editing?'vault-edit':'vault-put';
    const data={origin,username,password,autofill,
      ...(editing?{oldOrigin:editing.origin,oldUsername:editing.username}:{})};
    const result=await invoke(command,data);
    $('vaultPassword').value='';
    if(result?.ok){
      const wasEditing=Boolean(editing);
      resetEditor();await list();
      report(wasEditing?'Login updated. Autofill uses the revised details.':
        'Encrypted login saved. Autofill works while Logins is unlocked.');
    }
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
