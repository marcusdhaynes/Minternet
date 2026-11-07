'use strict';
/* Opt-in Google identity + Supabase encrypted Realtime sync.
 * NO periodic synchronization or Drive synchronization.
 * Only local change events, server broadcasts and reconnect replay trigger I/O.
 * Gmail confirmation checks are a separate optional security service.
 */
(() => {
  const $=id=>document.getElementById(id);
  const native=window.minternet;
  const model=window.MinternetLiveSync;
  const wire=window.MinternetLiveTransport;
  if(!native||!model||!wire||!$('googleAccountLogin'))return;

  const CONFIG='minternet.google-live-config.v2';
  const CLIENT_KEY='minternet.google-oauth-client.v1';
  const remote=new Map();
  const waitingVault=new Map();
  const seenCodes=new Set();
  const deferredTabs=new Map();
  let email=null,mailboxes=[],connected=false,session=null,key=null,userId=null;
  let baseline=null,initializing=false,muted=0,flushing=false,scheduled=false;
  let latestCode='',lastTabSignature='',flushPending=false,booting=false;

  const toast=message=>window.minternetToast?.(message);
  const setStatus=text=>{if($('googleSyncStatus'))$('googleSyncStatus').textContent=text;};
  const command=async(name,value)=>{
    const result=await native.command(name,value);
    if(result?.message)throw Error(result.message);
    return result;
  };
  const clone=value=>JSON.parse(JSON.stringify(value));
  const storedConfig=()=>{
    try{return JSON.parse(localStorage.getItem(CONFIG)||'{}');}catch{return {};}
  };
  const saveConfig=(url,publishableKey)=>{
    localStorage.setItem(CONFIG,JSON.stringify({url,publishableKey}));
  };
  const cloudKey=record=>record.kind+':'+record.item_key;
  const itemContent=x=>JSON.stringify(x?.value||null);
  const isSame=(a,b)=>a&&b&&a.kind===b.kind&&
    a.item_key===b.item_key&&itemContent(a)===itemContent(b);
  function updateUi(){
    $('googleSyncState').textContent=connected?'Live encrypted sync':'Not connected';
    $('googleAccountLogin').hidden=Boolean(email);
    $('googleSyncConnected').hidden=!email;
    $('googleSyncEmail').textContent=email||'';
    $('googleSyncDisconnect').textContent=connected?'Stop Sync':'Local Only';
    $('googleGmailAccounts').textContent=mailboxes.length
      ?'Gmail verification enabled: '+mailboxes.join(', ')
      :'Gmail confirmation monitoring is off until separately authorized.';
    if(email&&!connected&&!booting)setStatus('Signed into Google · Sync disabled');
  }
  function fail(err){
    const msg=String(err?.message||err).slice(0,200);
    setStatus(msg);toast(msg);
  }
  async function getLocal(){
    const tabState=window.minternetGroups?.getLatest()||{tabs:[]};
    const groupState=window.minternetGroups?.getState()||{groups:[],assignments:{}};
    const bookmarkState=window.minternetBookmarks?.getState()||{items:[]};
    const vault=await command('live-sync-vault-export');
    const prefs={bookmarkBar:bookmarkState.visible!==false};
    return {
      map:await model.makeRecords({
        tabs:tabState.tabs,
        groups:groupState.groups||[],
        assignments:groupState.assignments||{},
        bookmarks:bookmarkState,
        logins:vault?.locked?[]:vault?.logins||[],
        cards:vault?.locked?[]:vault?.cards||[],
        identities:vault?.locked?[]:vault?.identities||[],
        prefs
      }),
      vaultLocked:!!vault?.locked
    };
  }
  async function decryptRecord(record){
    if(!record.ciphertext)return null;
    return model.decrypt(record.kind,record.item_key,record.ciphertext,key);
  }
  async function writeRecord(record,deleted=false){
    if(!session||!key)return;
    const contents=await model.encrypt(record.kind,record.item_key,record.value,key);
    const response=await session.write(record.kind,record.item_key,contents,deleted);
    const confirmed=Array.isArray(response)?response[0]:response;
    if(!confirmed?.revision)throw Error('Server did not confirm encrypted sync revision');
    const entry={...confirmed,value:record.value,deleted,kind:record.kind,
      item_key:record.item_key};
    remote.set(cloudKey(record),entry);
    return entry;
  }
  async function applyTabs(){
    for(const entry of remote.values()){
      if(entry.kind!=='tab')continue;
      const tab=entry.value;
      if(!tab||!tab.syncId)continue;
      const payload={...tab,deleted:entry.deleted};
      const outcome=await command('live-sync-apply-tab',payload);
      if(outcome?.deferred)deferredTabs.set(entry.item_key,payload);
      else deferredTabs.delete(entry.item_key);
    }
  }
  async function applyBookmarks(){
    const bookmarks=[...remote.values()].filter(e=>e.kind==='bookmark');
    if(!bookmarks.length)return;
    const tree=model.buildBookmarkTree(bookmarks);
    window.minternetBookmarks?.applySyncedState(tree);
  }
  async function applyGroups(){
    const groups=[...remote.values()].filter(e=>e.kind==='group'&&!e.deleted)
      .map(e=>e.value).filter(Boolean);
    const tabs=[...remote.values()].filter(e=>e.kind==='tab'&&!e.deleted)
      .map(e=>e.value).filter(Boolean);
    if(groups.length||tabs.length)window.minternetGroups?.applySyncedGroups(groups,tabs);
  }
  async function applyVault(){
    const pending=[...remote.values()].filter(e=>
      (e.kind==='login'||e.kind==='payment'||e.kind==='identity') && e.value);
    if(!pending.length)return;
    const vault=await command('vault-status');
    if(!vault?.unlocked){
      for(const item of pending)waitingVault.set(cloudKey(item),item);
      setStatus('Live sync active · Unlock Passwords to apply latest secrets');
      return;
    }
    for(const item of pending){
      const outcome=await command('live-sync-vault-apply',{
        kind:item.kind,entry:item.value,deleted:!!item.deleted
      });
      if(outcome?.locked)waitingVault.set(cloudKey(item),item);
      else waitingVault.delete(cloudKey(item));
    }
  }
  async function applyAll(){
    if(!session)return;
    muted++;
    try{
      await applyTabs();
      await applyBookmarks();
      await applyGroups();
      await applyVault();
      baseline=(await getLocal()).map;
    }finally{muted--;}
  }
  async function onRemote(record){
    if(!key||!model.validKey(record?.kind,record?.item_key))return;
    const k=cloudKey(record);
    const previous=remote.get(k);
    if(previous && Number(previous.revision)>=Number(record.revision))return;
    let decoded=null;
    if(record.ciphertext){
      try{decoded=await decryptRecord(record);}
      catch(e){setStatus('Incorrect sync passphrase or corrupt encrypted record');return;}
    }
    const entry={...record,value:decoded};
    remote.set(k,entry);
    if(initializing)return;
    await applyAll();
  }
  function scheduleFlush(){
    if(!connected||!session||muted)return;
    if(scheduled){flushPending=true;return;}
    scheduled=true;
    queueMicrotask(async()=>{
      scheduled=false;
      await flush();
      if(flushPending){flushPending=false;scheduleFlush();}
    });
  }
  async function flush(){
    if(!connected||!session||muted||!baseline||flushing)return;
    flushing=true;
    try{
      const snapshot=await getLocal();
      const current=snapshot.map;
      const changes=[];
      for(const [k,entry] of current){
        if(entry.kind==='login'||entry.kind==='payment'||entry.kind==='identity'){
          if(snapshot.vaultLocked)continue;
        }
        const prior=baseline.get(k);
        if(!isSame(prior,entry))changes.push({entry,deleted:false});
      }
      for(const [k,entry] of baseline){
        if(!current.has(k)){
          if(snapshot.vaultLocked && (entry.kind==='login'||entry.kind==='payment'||entry.kind==='identity'))continue;
          // Preserve the encrypted identity in the tombstone. This permits a
          // receiving device to delete a login/card without exposing its key.
          changes.push({entry,deleted:true});
        }
      }
      for(const item of changes){
        await writeRecord(item.entry,item.deleted);
      }
      baseline=current;
    }catch(e){
      setStatus('Live sync temporarily unavailable: '+String(e.message||e).slice(0,85));
      // Outstanding local changes remain relative to baseline. Retry happens
      // on the next real local edit or WebSocket reconnect, never polling.
    }finally{flushing=false;}
  }
  async function connectLive(){
    if(booting)return;
    booting=true;
    const input=$('googleSyncPassphrase');
    const passphrase=input.value;
    if(passphrase.length<16){booting=false;return setStatus('Use 16 or more characters for sync encryption');}
    input.value='';
    const url=$('googleLiveUrl').value.trim().replace(/\/$/,'');
    const publishableKey=$('googleLiveKey').value.trim();
    try{
      // Native exchanges a Google ID token for a real Supabase Auth user ID
      // verified against configured Google OAuth client IDs.
      const identity=await command('live-sync-auth',{url,publishableKey});
      userId=identity.userId;
      key=await model.derive(passphrase,userId);
      saveConfig(url,publishableKey);
      remote.clear();waitingVault.clear();deferredTabs.clear();
      initializing=true;
      const localBefore=(await getLocal()).map;
      session=new wire.Realtime({
        url,publishableKey,
        key:publishableKey,
        accessToken:identity.accessToken,
        refreshToken:identity.refreshToken,
        userId,
        onChange:onRemote,
        onStatus:status=>{
          setStatus(status);
          if(status==='Live sync connected')scheduleFlush();
        }
      });
      await session.start();
      // A device's genuinely new local objects are sent to the cloud exactly
      // once. Cloud tombstones always take precedence over stale local copies.
      for(const [k,entry] of localBefore){
        if(!remote.has(k))await writeRecord(entry,false);
      }
      initializing=false;
      await applyAll();
      await command('google-sync-enable',true);
      connected=true;booting=false;
      $('googleSyncEncryption').hidden=true;
      $('googleSyncChoice').hidden=true;
      updateUi();
      setStatus('Live encrypted sync connected · No polling');
    }catch(e){
      session?.stop();session=null;connected=false;initializing=false;
      key=null;userId=null;baseline=null;booting=false;
      fail(e);
    }
  }
  async function googleLogin(mail){
    if(!window.__TAURI__){toast('Google account sync requires native Minternet');return;}
    let clientId=$('googleClientId').value.trim()||localStorage.getItem(CLIENT_KEY)||'';
    if(!/^\d+-[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)){
      $('googleAccountConfig').hidden=false;
      $('googleClientId').focus();
      setStatus('Register a Google OAuth Desktop Client ID first');return;
    }
    localStorage.setItem(CLIENT_KEY,clientId);
    $('googleAccountConfig').hidden=true;
    setStatus('Authorize in your system browser');
    try{
      const result=await command(mail?'google-gmail-login':'google-login',{clientId});
      if(mail){
        if(!mailboxes.includes(result.email))mailboxes.push(result.email);
        updateUi();await checkCodes();
        setStatus(result.sessionSaved
          ?'Gmail read-only code detection enabled · session saved securely for '+result.email
          :'Gmail authorized for this launch only · Windows Credential Manager unavailable');
      }else{
        email=result.email;
        updateUi();$('googleSyncChoice').hidden=false;
        setStatus(result.sessionSaved
          ?'Google sign-in saved securely · Sync this Minternet with other devices?'
          :'Google signed in for this launch only · Windows Credential Manager unavailable');
      }
    }catch(e){fail(e);}
  }
  async function checkCodes(){
    if(!mailboxes.length)return;
    if(!(window.minternetGroups?.getLatest()?.tabs||[]).some(model.eligibleTab))return;
    try{
      const matches=await command('google-code-check');
      for(const hit of Array.isArray(matches)?matches:[]){
        if(!/^\d{4,8}$/.test(hit.code))continue;
        const marker=hit.email+':'+hit.messageId;
        if(seenCodes.has(marker))continue;
        seenCodes.add(marker);
        if(seenCodes.size>100)seenCodes.delete(seenCodes.values().next().value);
        latestCode=hit.code;
        const badge=$('gmailCodeBadge');
        badge.hidden=false;badge.textContent=hit.code;
        badge.title='Verification code for '+hit.host+' · Click to copy';
      }
    }catch(e){setStatus('Gmail read-only code monitor: '+String(e.message||e).slice(0,70));}
  }
  function disconnect(){
    connected=false;initializing=false;muted=0;
    session?.stop();session=null;
    key=null;userId=null;baseline=null;
    remote.clear();waitingVault.clear();deferredTabs.clear();
    void command('google-sync-enable',false);
    updateUi();
    setStatus('Sync stopped · Local data remains intact');
  }

  $('googleAccountLogin').addEventListener('click',()=>void googleLogin(false));
  $('googleConnectContinue').addEventListener('click',()=>void googleLogin(false));
  $('googleSyncNo').addEventListener('click',()=>{
    $('googleSyncChoice').hidden=true;
    $('googleSyncEncryption').hidden=true;
    disconnect();
  });
  $('googleSyncYes').addEventListener('click',()=>{
    $('googleSyncChoice').hidden=true;
    $('googleSyncEncryption').hidden=false;
    $('googleSyncPassphrase').focus();
  });
  $('googleSyncEnable').addEventListener('click',()=>void connectLive());
  $('googleSyncRefresh').addEventListener('click',()=>void session?.reconcile());
  $('googleSyncDisconnect').addEventListener('click',()=>{
    disconnect();$('googleSyncChoice').hidden=false;
  });
  $('googleAddGmail').addEventListener('click',()=>void googleLogin(true));
  $('gmailCodeBadge').addEventListener('click',async()=>{
    if(!latestCode)return;
    try{await navigator.clipboard.writeText(latestCode);toast('Verification code copied');}
    catch{toast('Clipboard unavailable; select the code manually');}
  });

  window.addEventListener('minternet:local-change',scheduleFlush);
  // Detect native tab/page/pinned changes; audio and title-only events do not
  // perform any network I/O or snapshot of passwords.
  native.onState(snapshot=>{
    if(!connected||muted)return;
    const tabs=(snapshot.tabs||[]).filter(model.eligibleTab).map(t=>
      [t.syncId,t.url,t.pinned].join('|')).join(';');
    if(lastTabSignature!==tabs){lastTabSignature=tabs;scheduleFlush();}
    if(deferredTabs.size){
      for(const [k,payload] of deferredTabs){
        void command('live-sync-apply-tab',payload).then(result=>{
          if(!result?.deferred)deferredTabs.delete(k);
        }).catch(()=>{});
      }
    }
  });

  if(window.__TAURI__){
    const events=window.__TAURI__.event;
    events.listen('minternet:vault-changed',scheduleFlush).catch(()=>{});
    events.listen('minternet:vault-unlocked',()=>{
      if(!connected)return;
      void (async()=>{
        await applyVault();
        const available=(await getLocal()).map;
        // Publish newly unlocked local records only if the cloud has never
        // seen their identity. Cloud tombstones prevent resurrection.
        for(const [id,item] of available){
          if((item.kind==='login'||item.kind==='payment'||item.kind==='identity')&&!remote.has(id))
            await writeRecord(item,false);
        }
        baseline=available;
      })().catch(fail);
    }).catch(()=>{});
    void command('google-status').then(status=>{
      email=status.email||null;
      mailboxes=Array.isArray(status.gmailAccounts)?status.gmailAccounts:[];
      updateUi();
    }).catch(()=>{});
  }
  // Gmail is not a sync transport. This separately consented metadata check
  // only activates after Gmail OAuth and scans a small set of recent codes.
  // Sync itself uses NO periodic check and NO Drive upload/download loop.
  setInterval(()=>{if(mailboxes.length)void checkCodes();},60000);

  const defaults=storedConfig();
  if($('googleLiveUrl'))$('googleLiveUrl').value=defaults.url||'';
  if($('googleLiveKey'))$('googleLiveKey').value=defaults.publishableKey||'';
  try{$('googleClientId').value=localStorage.getItem(CLIENT_KEY)||'';}catch{}
  updateUi();

  window.minternetSyncV2={
    get active(){return connected;},
    undo:async()=>{
      if(!connected||!session)throw Error('Google live sync is offline');
      const result=await session.undo();
      if(!result?.ok)throw Error(result?.reason||'No shared changes to undo');
      const fresh=await session.read(result.kind,result.item_key);
      if(fresh)await session.deliver(fresh);
      return result;
    },
    stop:disconnect
  };
})();