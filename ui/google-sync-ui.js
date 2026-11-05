'use strict';
// Google sync is opt-in and encrypted locally. The browser holds the derived
// encryption key only for the current running session; no passphrase is stored.
(() => {
  const $=id=>document.getElementById(id);
  const api=window.minternet;
  const core=window.MinternetSyncCore;
  if(!api||!core||!$('googleAccountLogin'))return;
  const CLIENT_KEY='minternet.google-oauth-client.v1'; // Public client ID, not a secret.
  let primary=null,active=false,key=null,salt=null,lastCloud=null,lastLocal=null,busy=false;
  const knownCodes=new Set();
  let latestCode='';
  let mailboxes=[];
  let lastSyncAt=0;
  const toast=msg=>window.minternetToast?.(msg);
  const call=async(name,value)=>{
    const response=await api.command(name,value);
    if(response?.message)throw Error(response.message);
    return response;
  };
  const setStatus=msg=>{if($('googleSyncStatus'))$('googleSyncStatus').textContent=msg;};
  function connected(){
    $('googleSyncState').textContent=primary?'Signed in':'Not connected';
    $('googleAccountLogin').hidden=!!primary;
    $('googleSyncConnected').hidden=!primary;
    $('googleSyncEmail').textContent=primary||'';
    $('googleSyncDisconnect').textContent=active?'Stop Sync':'Local Only';
    $('googleGmailAccounts').textContent=mailboxes.length
      ?'Verification codes: '+mailboxes.join(', ')
      :'Gmail monitoring is off until you separately grant read-only access.';
    if(primary&&!active)setStatus('Google connected · Sync off');
  }
  function base64(bytes){
    let str='';
    for(let i=0;i<bytes.length;i+=8192)
      str+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(str);
  }
  function fromBase64(value){
    const data=atob(value),result=new Uint8Array(data.length);
    for(let i=0;i<data.length;i++)result[i]=data.charCodeAt(i);
    return result;
  }
  async function derive(passphrase,saltBytes){
    const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(passphrase),
      {name:'PBKDF2'},false,['deriveKey']);
    return crypto.subtle.deriveKey(
      {name:'PBKDF2',salt:saltBytes,iterations:260000,hash:'SHA-256'},
      material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  async function seal(data){
    if(!key||!salt)throw Error('Sync encryption is locked');
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const encoded=new TextEncoder().encode(JSON.stringify(data));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,encoded);
    return JSON.stringify({version:1,algorithm:'PBKDF2-SHA256/AES-256-GCM',
      iterations:260000,salt:base64(salt),iv:base64(iv),
      ciphertext:base64(new Uint8Array(ciphertext))});
  }
  async function open(envelope){
    const value=JSON.parse(envelope);
    if(value.version!==1||value.algorithm!=='PBKDF2-SHA256/AES-256-GCM'||
       value.iterations!==260000)throw Error('Incompatible sync encryption format');
    const bytes=fromBase64(value.iv);
    if(bytes.length!==12)throw Error('Invalid sync nonce');
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes},key,
      fromBase64(value.ciphertext));
    return core.validate(JSON.parse(new TextDecoder().decode(plain)));
  }
  async function capture(){
    const state=core.snapshot(window.minternetBookmarks?.getState(),
      window.minternetGroups?.getState(),
      window.minternetGroups?.getLatest());
    const backup=await call('google-vault-export');
    if(backup?.exists)state.encryptedVault=backup.encrypted;
    return state;
  }
  function signature(state){return JSON.stringify(state);}
  async function apply(remote){
    // Imported normal URLs are dormant until selected; current work and every
    // private tab remain untouched.
    await call('google-sync-tabs-merge',remote.tabs);
    const local=window.minternetBookmarks?.getState();
    const joined=core.mergeBookmarks(local,remote.bookmarks);
    window.minternetBookmarks?.applySyncedState(joined);
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const currentGroups=window.minternetGroups?.getState()?.groups||[];
    const merged=[...remote.groups];
    for(const group of currentGroups)if(!merged.some(g=>g.id===group.id))merged.push(group);
    window.minternetGroups?.applySyncedGroups(merged,remote.tabs);
    if(remote.encryptedVault && typeof remote.encryptedVault==='string'){
      const imported=await call('google-vault-import',remote.encryptedVault);
      if(imported?.reason==='local-vault-exists'){
        // Never overwrite a different local vault, potentially destroying
        // passwords/cards. The native vault is still encrypted in Drive.
        setStatus('Tabs/bookmarks synced · Existing local vault preserved');
      }
    }
  }
  async function syncOnce(){
    if(!active||!key||busy)return;
    busy=true;
    try{
      const local=await capture();
      const localText=signature(local);
      const cloud=await call('google-drive-pull');
      if(!cloud.exists){
        const sealed=await seal(local);
        await call('google-drive-push',sealed);
        lastCloud=sealed;lastLocal=localText;
        setStatus('Encrypted sync active · Latest changes uploaded');
        lastSyncAt=Date.now();
        return;
      }
      if(lastCloud!==cloud.data){
        const remote=await open(cloud.data);
        // Two devices changed after the last common version. Do not clobber
        // either side automatically; require conflict resolution.
        if(lastLocal!==null && localText!==lastLocal){
          setStatus('Sync conflict: local and another device both changed');
          return;
        }
        lastCloud=cloud.data;
        await apply(remote);
        const now=await capture();
        lastLocal=signature(now);
        // Merge can introduce new local links not in the remote revision.
        if(signature(now)!==signature(remote)){
          const sealed=await seal(now);
          await call('google-drive-push',sealed);
          lastCloud=sealed;
        }
        setStatus('Encrypted sync active · Updated from Google');
      }else if(lastLocal!==localText){
        const sealed=await seal(local);
        await call('google-drive-push',sealed);
        lastCloud=sealed;lastLocal=localText;
        setStatus('Encrypted sync active · Latest changes uploaded');
      }
      lastSyncAt=Date.now();
    }catch(err){
      setStatus('Sync needs attention: '+String(err.message||err).slice(0,110));
    }finally{busy=false;}
  }
  function fail(err){const msg=String(err?.message||err);setStatus(msg);toast(msg);}
  async function googleLogin(mail){
    if(!window.__TAURI__){toast('Google account sync requires the native desktop app.');return;}
    let id=$('googleClientId').value.trim()||localStorage.getItem(CLIENT_KEY)||'';
    if(!/^\d+-[\w.-]+\.apps\.googleusercontent\.com$/.test(id)){
      $('googleAccountConfig').hidden=false;
      $('googleClientId').focus();
      setStatus('Configure your Minternet Google OAuth Client ID first');
      return;
    }
    localStorage.setItem(CLIENT_KEY,id);
    $('googleAccountConfig').hidden=true;
    setStatus('Complete Google authorization in your system browser');
    try{
      const answer=await call(mail?'google-gmail-login':'google-login',{clientId:id});
      if(mail){
        if(!mailboxes.includes(answer.email))mailboxes.push(answer.email);
        connected();
        setStatus('Read-only Gmail verification enabled for '+answer.email);
        await checkCodes();
      }else{
        primary=answer.email;
        connected();
        $('googleSyncChoice').hidden=false;
        setStatus('Choose whether to sync this Minternet');
      }
    }catch(err){fail(err);}
  }
  $('googleAccountLogin').addEventListener('click',()=>void googleLogin(false));
  $('googleConnectContinue').addEventListener('click',()=>void googleLogin(false));
  $('googleSyncNo').addEventListener('click',async()=>{
    $('googleSyncChoice').hidden=true;
    $('googleSyncEncryption').hidden=true;
    active=false;key=null;salt=null;lastCloud=null;lastLocal=null;
    try{await call('google-sync-enable',false);}catch(err){fail(err);}
    connected();
  });
  $('googleSyncYes').addEventListener('click',()=>{
    $('googleSyncChoice').hidden=true;
    $('googleSyncEncryption').hidden=false;
    $('googleSyncPassphrase').focus();
  });
  $('googleSyncEnable').addEventListener('click',async()=>{
    const input=$('googleSyncPassphrase');
    const phrase=input.value;
    if(phrase.length<12){setStatus('Use a 12-character or longer encryption passphrase');return;}
    input.value='';
    try{
      await call('google-sync-enable',true);
      const remote=await call('google-drive-pull');
      salt=remote.exists?fromBase64(JSON.parse(remote.data).salt):
        crypto.getRandomValues(new Uint8Array(16));
      if(salt.length!==16)throw Error('Invalid cloud encryption salt');
      key=await derive(phrase,salt);
      if(remote.exists)await open(remote.data); // Validate passphrase before allowing sync.
      active=true;
      $('googleSyncEncryption').hidden=true;
      connected();
      await syncOnce();
    }catch(err){
      key=null;salt=null;active=false;
      try{await call('google-sync-enable',false);}catch{}
      fail(err);
    }
  });
  $('googleSyncRefresh').addEventListener('click',()=>void syncOnce());
  $('googleSyncDisconnect').addEventListener('click',async()=>{
    active=false;key=null;salt=null;lastCloud=null;lastLocal=null;
    try{await call('google-sync-enable',false);}catch(err){fail(err);}
    connected();
    setStatus('Sync off · Local data unchanged');
    $('googleSyncChoice').hidden=false;
  });
  $('googleAddGmail').addEventListener('click',()=>void googleLogin(true));
  async function checkCodes(){
    if(!window.__TAURI__||!mailboxes.length)return;
    const tabs=window.minternetGroups?.getLatest()?.tabs||[];
    if(!tabs.some(t=>!t.private && core.safeUrl(t.url)))return;
    try{
      const matches=await call('google-code-check');
      if(!Array.isArray(matches))return;
      for(const match of matches){
        if(!/^\d{4,8}$/.test(match.code)||typeof match.host!=='string')continue;
        const marker=match.email+':'+match.messageId;
        if(knownCodes.has(marker))continue;
        knownCodes.add(marker);
        if(knownCodes.size>100)knownCodes.delete(knownCodes.values().next().value);
        latestCode=match.code;
        const btn=$('gmailCodeBadge');
        btn.hidden=false;
        btn.textContent=latestCode;
        btn.title='Verification code for '+match.host+' · Click to copy';
        // Browser clipboard access can be denied without foreground focus.
        // A click on the badge always retries with a user gesture.
        try{await navigator.clipboard?.writeText(latestCode);}catch{}
      }
    }catch(err){setStatus('Gmail code check unavailable: '+String(err.message||err).slice(0,90));}
  }
  $('gmailCodeBadge').addEventListener('click',async()=>{
    if(!latestCode)return;
    try{await navigator.clipboard.writeText(latestCode);toast('Verification code copied');}
    catch{toast('Clipboard access not permitted. Copy the displayed code manually.');}
  });
  try{$('googleClientId').value=localStorage.getItem(CLIENT_KEY)||'';}catch{}
  if(window.__TAURI__){
    void call('google-status').then(result=>{
      primary=result.email||null;
      mailboxes=Array.isArray(result.gmailAccounts)?result.gmailAccounts:[];
      connected();
    }).catch(()=>{});
  }
  connected();
  setInterval(()=>{if(active&&Date.now()-lastSyncAt>30000)void syncOnce();},45000);
  setInterval(()=>{if(mailboxes.length)void checkCodes();},60000);
})();
