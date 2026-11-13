'use strict';
const byId = id => document.getElementById(id);
const api = window.minternet;
let snapshot = { tabs: [], activeId: null, extensionsCount: 0 };
let lastUrl = 'about:blank';
let addressFocused = false;
// Navigation has to commit before old-homepage load callbacks may replace
// what the user typed. Preserve their submitted address until new URL arrives.
let pendingNavigation=null;
// Native site WebViews can steal focus when their homepage begins rendering.
// A fresh tab has a short, cancellable address-focus lease.
let focusLease=0;
let focusCancelled=false;
let focusTargetTabId=null;
let addressEditedSinceNew=false;
function focusNewTabAddress(){
  const target=snapshot.activeId;
  if(target===focusTargetTabId&&!focusCancelled&&document.activeElement===byId('address'))return;
  focusTargetTabId=target;
  addressEditedSinceNew=false;
  byId('address')?.removeAttribute('data-minternet-typed');
  const lease=++focusLease;
  focusCancelled=false;
  const field=byId('address');
  const tryFocus=()=>{
    if(lease!==focusLease||focusCancelled||snapshot.activeId!==target)return;
    if(document.activeElement===field)return;
    if(document.activeElement instanceof HTMLElement && document.activeElement.matches('input:not(#address),textarea,[contenteditable="true"]')){focusCancelled=true;return;}
    if(window.__TAURI__)void api.command('focus-address').catch(()=>{});
    field?.focus({preventScroll:true});
    if(!addressEditedSinceNew)field?.select();
  };
  tryFocus();
  // WebView2 hands focus to its site as navigation starts and ends.
  // Reclaim only while this is the newest tab, never after a user click.
  for(const delay of [80,220,480,850,1350,2100,3300,5200])setTimeout(tryFocus,delay);
}
document.addEventListener('pointerdown',event=>{
  if(!event.target.closest('#newTab,#newPrivate,#addressForm')) {
    focusCancelled=true;
  }
},true);
const PRIVATE_EYE='<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12s3.7-5.7 9.5-5.7 9.5 5.7 9.5 5.7-3.7 5.7-9.5 5.7S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.7"/></svg>';

const command = async (name, value) => {
  try {
    const result = await api.command(name, value);
    if (result?.message) {
      if(name==='navigate')pendingNavigation=null;
      toast(result.message);
    }
    if(name==='new'||name==='new-private')focusNewTabAddress();
    return result;
  } catch {
    toast('The action could not be completed.');
  }
};
function toast(message) {
  const el = byId('toast');
  el.textContent = String(message);
  el.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('visible'), 3800);
}
function tabTooltip(tab) {
  if(tab.secretTab)return (tab.secretPending?'Unloaded · ':'')+
    (window.minternetSecretTabNames?.get(tab.id)||'Secret Tab');
  const title=tab.title || (tab.url?.startsWith('https://') ? new URL(tab.url).hostname : 'New Tab');
  return (tab.suspended ? 'Unloaded · ' : tab.loading ? 'Loading · ' : '') + title;
}
// Render previously visited site icons directly from compact, persistent
// verified image bytes. The first visit to a new host still needs a network
// fetch, but later tab creation/restoration never waits for its favicon.
const FAVICON_STORE='minternet.tab-favicons.v2';
const faviconCache=new Map();
// Browser-native icons are tab scoped, not just host scoped: distinct GitHub
// Pages projects share one hostname but publish different icons.
const nativeTabIcons=new Map();
const cachedIconPattern=/^data:image\/(?:png|jpeg|webp|x-icon);base64,[a-z0-9+/=]+$/i;
function siteIconKey(address){
  try{
    const u=new URL(address);
    if(!/^https?:$/.test(u.protocol))return '';
    const host=u.hostname.toLowerCase();
    // Project-specific site roots on shared GitHub Pages hosts.
    if(host.endsWith('.github.io')){
      const project=u.pathname.split('/').filter(Boolean)[0]||'';
      return project?host+'/'+project.toLowerCase():host;
    }
    return host;
  }catch{return '';}
}
function restoreFaviconCache(){
  try{
    const entries=JSON.parse(localStorage.getItem(FAVICON_STORE)||'[]');
    if(!Array.isArray(entries))return;
    let used=0;
    for(const item of entries.slice(-120)){
      if(!Array.isArray(item)||item.length!==2)continue;
      const [host,src]=item;
      if(typeof host!=='string'||!/^[a-z0-9.\/-]{1,300}$/.test(host)||
         typeof src!=='string'||src.length>125000||!cachedIconPattern.test(src))continue;
      used+=src.length;
      if(used>1400000)break;
      faviconCache.set(host,{src,loading:false,persisted:true,native:true});
    }
  }catch{}
}
restoreFaviconCache();
try{
  const thumbnails=JSON.parse(localStorage.getItem('minternet.bookmark-icon-thumbnails.v1')||'{}');
  for(const [address,png] of Object.entries(thumbnails||{}).slice(-180)){
    if(typeof png!=='string'||png.length>10000||
       !/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(png))continue;
    const u=new URL(address),host=siteIconKey(address);
    if(u.protocol==='https:'&&!faviconCache.has(host)&&host)
      faviconCache.set(host,{src:png,loading:false,persisted:true});
  }
}catch{}
function persistFavicon(key,image){
  if(!window.__TAURI__||!key||!cachedIconPattern.test(image)||image.length>125000)return;
  if(!snapshot.tabs.some(t=>!t.private&&!t.secretTab&&siteIconKey(t.url)===key))return;
  try{
    const stored=JSON.parse(localStorage.getItem(FAVICON_STORE)||'[]');
    const map=new Map(Array.isArray(stored)?stored.filter(e=>Array.isArray(e)&&e.length===2):[]);
    map.delete(key);map.set(key,image);
    let entries=[...map.entries()].slice(-100);
    while(entries.length&&JSON.stringify(entries).length>1400000)entries.shift();
    localStorage.setItem(FAVICON_STORE,JSON.stringify(entries));
  }catch{}
}
function rememberFavicon(host,source){
  if(!window.__TAURI__||!source||!source.startsWith('https://'))return;
  const state=faviconCache.get(host);
  if(!state||state.persisted||state.persisting||state.native)return;
  if(!snapshot.tabs.some(t=>!t.private&&!t.secretTab&&siteIconKey(t.url)===host))return;
  state.persisting=true;
  void api.command('bookmark-icon-data',source).then(image=>{
    state.persisting=false;
    if(typeof image!=='string'||image.length>125000||!cachedIconPattern.test(image)||state.native)return;
    state.src=image;state.persisted=true;
    persistFavicon(host,image);
    refreshHostIcons(host);
  }).catch(()=>{state.persisting=false;});
}
function iconCandidates(host,page){
  const root='https://'+host;
  const key=siteIconKey(page),project=key.startsWith(host+'/')?key.slice(host.length+1):'';
  const base=project?root+'/'+encodeURIComponent(project):root;
  const roots=[base+'/favicon.ico',base+'/favicon.svg',base+'/favicon-32x32.png',
    base+'/apple-touch-icon.png'];
  if(project)roots.push(root+'/favicon.ico',root+'/favicon.svg');
  return roots;
}
function iconFallback(host){
  const chip=document.createElement('span');
  chip.className='site-icon-fallback'+(host==='chatgpt.com'||host.endsWith('.chatgpt.com')?' site-icon-chatgpt':'');
  chip.textContent=chip.classList.contains('site-icon-chatgpt')?'✳':
    (host.replace(/^www\./,'').charAt(0).toUpperCase()||'◆');
  let hash=0;for(const c of host)hash=(hash*31+c.charCodeAt(0))>>>0;
  chip.style.setProperty('--favicon-hue',String(hash%360));
  return chip;
}
function paintIcon(slot,source){
  const img=document.createElement('img');
  img.alt='';img.decoding='async';img.loading='eager';img.referrerPolicy='no-referrer';
  img.src=source;slot.replaceChildren(img);
}
function refreshHostIcons(key){
  document.querySelectorAll('.tab-symbol[data-site-key]').forEach(slot=>{
    if(slot.dataset.siteKey!==key)return;
    const id=Number(slot.dataset.tabId);
    const state=nativeTabIcons.get(id);
    const src=(state?.key===key&&state.src)||faviconCache.get(key)?.src;
    if(src)paintIcon(slot,src);
  });
}
function discoverSiteIcon(host,page){
  const key=siteIconKey(page);
  if(!key)return;
  const previous=faviconCache.get(key);
  if(previous?.src||previous?.loading||
      (previous?.failedAt&&Date.now()-previous.failedAt<30000))return;
  const state={src:null,loading:true};
  faviconCache.set(key,state);
  const candidates=iconCandidates(host,page);
  const tryIcon=index=>{
    if(faviconCache.get(key)!==state)return;
    if(index>=candidates.length){
      if(!window.__TAURI__||!page||state.discovered){
        state.loading=false;state.failedAt=Date.now();return;
      }
      state.discovered=true;
      void api.command('bookmark-site-icons',page).then(found=>{
        if(faviconCache.get(key)!==state)return;
        const extras=Array.isArray(found)?found.filter(url=>typeof url==='string'&&url.startsWith('https://')).slice(0,5):[];
        if(extras.length){candidates.push(...extras);tryIcon(index);}
        else{state.loading=false;state.failedAt=Date.now();}
      }).catch(()=>{state.loading=false;state.failedAt=Date.now();});
      return;
    }
    const probe=new Image();
    probe.decoding='async';probe.referrerPolicy='no-referrer';
    probe.onload=()=>{
      if(faviconCache.get(key)!==state)return;
      if(probe.naturalWidth===0||probe.naturalHeight===0){tryIcon(index+1);return;}
      state.src=candidates[index];state.loading=false;refreshHostIcons(key);
      rememberFavicon(key,candidates[index]);
    };
    probe.onerror=()=>tryIcon(index+1);
    probe.src=candidates[index];
  };
  tryIcon(0);
}
function renderSiteIcon(tab,slot){
  slot.replaceChildren();
  slot.dataset.tabId=String(tab.id);
  if(tab.secretTab){
    slot.textContent='◈';
    slot.classList.add('secret-tab-icon');
    slot.removeAttribute('data-site-key');
    return;
  }
  slot.classList.remove('secret-tab-icon','private-eye');
  slot.removeAttribute('data-site-key');
  if(!tab.url||!/^https?:\/\//i.test(tab.url)){
    if(!tab.url||tab.url==='about:blank'){
      const image=document.createElement('img');
      image.className='minternet-new-tab-icon';
      image.src='./minternet-brand.png';
      image.alt='';image.decoding='async';slot.append(image);
    }else slot.append(iconFallback(''));
    return;
  }
  const key=siteIconKey(tab.url),host=new URL(tab.url).hostname.toLowerCase();
  slot.dataset.siteKey=key;
  const native=nativeTabIcons.get(tab.id);
  const cached=faviconCache.get(key);
  const image=(native?.key===key&&native.src)||cached?.src;
  if(image){
    paintIcon(slot,image);
    if(!tab.private&&!cached?.persisted&&!cached?.native&&cached?.src)
      rememberFavicon(key,cached.src);
  }else{
    slot.append(iconFallback(host));
    discoverSiteIcon(host,tab.url);
  }
}
// WebView2 supplies the actual favicon image bytes from its own browser cache.
// There is no guessing or cross-site probe required for an opened Windows tab.
if(window.__TAURI__?.event){
  void window.__TAURI__.event.listen('minternet:native-favicon',event=>{
    const {tabId,page,image}=event.payload||{};
    if(!Number.isSafeInteger(tabId)||typeof page!=='string'||
        typeof image!=='string'||image.length>125000||
        !/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(image))return;
    const tab=snapshot.tabs.find(t=>t.id===tabId);
    if(!tab||tab.secretTab||!/^https?:\/\//.test(tab.url))return;
    let source,actual;
    try{source=new URL(page);actual=new URL(tab.url);}catch{return;}
    if(source.origin!==actual.origin)return;
    const key=siteIconKey(page);
    if(!key||key!==siteIconKey(tab.url))return;
    nativeTabIcons.set(tabId,{key,src:image});
    if(!tab.private){
      faviconCache.set(key,{src:image,loading:false,persisted:true,native:true});
      persistFavicon(key,image);
    }
    refreshHostIcons(key);
  }).catch(()=>{});
}
function buildTab(tab, active) {
  const root = document.createElement('div');
  root.className = 'tab' + (active ? ' selected' : '') +
    (tab.private ? ' private-tab' : '') + (tab.pinned ? ' pinned-tab' : '') +
    (tab.suspended ? ' unloaded-tab' : '') + (tab.secretTab?' secret-tab':'');
  root.setAttribute('role', 'tab');
  root.setAttribute('aria-selected', String(active));
  root.title = tabTooltip(tab);
  const choose = document.createElement('button');
  choose.className = 'tab-choose';
  choose.title = (tab.pinned ? 'Pinned · ' : '') + tabTooltip(tab);
  choose.addEventListener('click', () => command('activate', tab.id));
  const symbol = document.createElement('span');
  symbol.className = 'tab-symbol';
  renderSiteIcon(tab,symbol);
  const text = document.createElement('span');
  text.className = 'tab-text';
  text.textContent = tab.secretTab
    ?(window.minternetSecretTabNames?.get(tab.id)||'Secret Tab')
    :(tab.title || 'New Tab');
  choose.append(symbol, text);
  if(tab.private){const eye=document.createElement('span');eye.className='tab-private-eye';eye.innerHTML=PRIVATE_EYE;choose.append(eye);}
  const close = document.createElement('button');
  close.className = 'tab-close';
  close.textContent = '×';
  close.title = 'Close tab';
  close.setAttribute('aria-label', 'Close ' +
    (tab.secretTab?(window.minternetSecretTabNames?.get(tab.id)||'Secret Tab'):(tab.title||'tab')));
  close.addEventListener('click', () => command('close', tab.id));
  if(tab.audioPlaying){
    const audio=document.createElement('button');
    audio.type='button';audio.className='tab-audio';
    audio.title=tab.audioMuted?'Unmute this tab':'Mute this tab';
    audio.setAttribute('aria-label',audio.title);
    audio.textContent=tab.audioMuted?'◌':'♪';
    audio.addEventListener('click',event=>{
      event.stopPropagation();
      void command('mute-tab',tab.id);
    });
    root.append(audio);
  }
  root.append(choose);
  if(!tab.pinned)root.append(close);
  return root;
}
window.minternetToast = toast;
window.minternetRenderTabs = () => {
  if(window.minternetGroups?.renderTabs)
    window.minternetGroups.renderTabs(snapshot,byId('tabs'),buildTab);
};
function render(data) {
  const previouslyKnown=new Set(snapshot.tabs.map(tab=>tab.id));
  const isNewTab=Boolean(render.hasSnapshot && data.activeId && !previouslyKnown.has(data.activeId) &&
    data.tabs.some(tab=>tab.id===data.activeId&&!tab.secretTab));
  render.hasSnapshot=true;
  if(focusTargetTabId!==null&&data.activeId!==focusTargetTabId){
    focusCancelled=true;
  }
  snapshot = data;
  const ids=new Set(data.tabs.map(t=>t.id));
  for(const id of nativeTabIcons.keys())if(!ids.has(id))nativeTabIcons.delete(id);
  const tabs = byId('tabs');
  const active = data.tabs.find(t => t.id === data.activeId);
  if(pendingNavigation){
    const sameTab=active && active.id===pendingNavigation.id;
    if(!sameTab || Date.now()-pendingNavigation.started>14000 ||
       (active.url!==pendingNavigation.priorUrl && active.url!=='about:blank')){
      pendingNavigation=null;
    }
  }
  const signature = data.tabs.map(t => [t.id,t.title,t.url,t.private,t.pinned,t.suspended,t.loading,t.audioPlaying,t.audioMuted,t.secretTab,t.secretPending]).join(';');
  if (window.minternetGroups?.renderTabs) {
    window.minternetGroups.renderTabs(data,tabs,buildTab);
    render.lastSignature = null;
  } else if (signature !== render.lastSignature) {
    tabs.replaceChildren(...data.tabs.map(t => buildTab(t, t.id === data.activeId)));
    render.lastSignature = signature;
  } else {
    // Reuse tab DOM nodes during loading/title updates: avoids pointless reflows.
    for (let i = 0; i < data.tabs.length; i++) {
      const tab = data.tabs[i];
      const el = tabs.children[i];
      const activeTab = tab.id === data.activeId;
      el.className = 'tab' + (activeTab ? ' selected' : '') +
        (tab.private ? ' private-tab' : '')+(tab.pinned ? ' pinned-tab' : '')+(tab.suspended ? ' unloaded-tab' : '')+
        (tab.secretTab?' secret-tab':'');
      el.setAttribute('aria-selected', String(activeTab));
      el.title = tabTooltip(tab);
      const symbol=el.querySelector('.tab-symbol');
      renderSiteIcon(tab,symbol);
      el.querySelector('.tab-text').textContent = tab.title || 'New Tab';
    }
  }
  document.documentElement.classList.toggle('private-active',Boolean(active?.private));
  if(isNewTab){
    requestAnimationFrame(()=>{
      const address=byId('address');
      address?.focus();
      address?.select();
      focusNewTabAddress();
    });
  }
    byId('back').disabled = !active?.canBack;
  byId('forward').disabled = !active?.canForward;
  byId('reload').disabled = !active || active.secretTab || active.url === 'about:blank';
  byId('reload').classList.toggle('refresh-spinning',Boolean(active?.loading));
  if(!active?.loading)byId('reload').removeAttribute('aria-busy');
  else byId('reload').setAttribute('aria-busy','true');
  const isBlank = !active || (active.url === 'about:blank'&&!active.secretTab);
  byId('homeScreen').hidden = !isBlank;
  byId('address').setAttribute('aria-label', active?.url?.startsWith('http://') ? 'Insecure HTTP address' : 'Search or enter address');
  if (!addressFocused) byId('address').value = pendingNavigation?.text ||
    (isBlank||active?.secretTab ? '' : active.url);
  byId('address').placeholder=active?.secretTab?'Secret Tab · URL Concealed':'Search privately or enter a secure address';
  if (lastUrl !== active?.url) {
    lastUrl = active?.url;
    document.title = active?.title ? active.title + ' — Minternet' : 'Minternet';
  }
}
api.onState(render);
api.onFocusAddress(() => byId('address').focus());
const bind = (id, name) => byId(id).addEventListener('click', () => {if(name==='reload')byId('reload').classList.add('refresh-spinning');void command(name);});
for (const [id, name] of [
  ['newTab','new'],['newPrivate','new-private'],['dashboardButton','deselect'],
  ['reload','reload'],['tor','tor'],
  ['minimize','minimize'],['maximize','maximize'],['quit','quit']
]) bind(id,name);
byId('addressForm').addEventListener('submit', event => {
  event.preventDefault();
  const field=byId('address');
  const typed=field.value.trim();
  if(!typed)return;
  const active=snapshot.tabs.find(t=>t.id===snapshot.activeId);
  pendingNavigation={text:typed,id:active?.id??null,
    priorUrl:active?.url||'about:blank',started:Date.now()};
  // This is an optimistic address commit, not a website navigation. Native
  // decides the actual address. Never revert to the new tab's old homepage.
  field.value=typed;
  void command('navigate',typed);
  field.blur();
});
byId('homeSearchForm')?.addEventListener('submit', event => {
  event.preventDefault();
  const q = byId('homeSearch')?.value||'';
  if (q.trim()) void command('navigate', q);
});
// Warm the native renderer while the user begins typing. Nothing is fetched
// until Enter; no speculative website requests, DNS prefetch, or privacy leak.
let warmTimer;
function prepareBlankTab() {
  if (!window.__TAURI__) return;
  // A focused but empty Dashboard must remain truly zero-renderer.
  // Prewarm only when the user has actually begun entering an address.
  if(!byId('address')?.value?.trim())return;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    const active = snapshot.tabs.find(t => t.id === snapshot.activeId);
    if (active?.url === 'about:blank') void api.command('prepare-tab').catch(() => {});
  }, 75);
}
byId('address').addEventListener('input',event=>{
  addressEditedSinceNew=true;
  event.currentTarget.dataset.minternetTyped='true';
  prepareBlankTab();
});
byId('address').addEventListener('focus', event => {
  addressFocused = true;
  event.target.select();
  prepareBlankTab();
});
byId('homeSearch')?.addEventListener('focus', prepareBlankTab);
byId('address').addEventListener('blur', () => {
  addressFocused = false;
  const active = snapshot.tabs.find(t => t.id === snapshot.activeId);
  byId('address').value = pendingNavigation?.text ||
    (active && active.url !== 'about:blank' ? active.url : '');
});
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault(); byId('address').focus();
  }
});

/* Frameless chrome: normal drag starts only AFTER movement. Starting native
   dragging on pointerdown swallows Windows double-click events. */
if(window.__TAURI__){
  const topRow=document.querySelector('.tab-row');
  // Blank space inside .tabs counts as title-bar space; actual tabs/buttons do not.
  const interactive='button,.window-actions,.ungroup-drop-target,input,a,[role="tab"]';
  let pendingDrag=null;
  topRow?.addEventListener('pointerdown',event=>{
    if(event.button!==0 || event.detail>1 || event.target.closest(interactive))return;
    pendingDrag={id:event.pointerId,x:event.clientX,y:event.clientY};
  });
  topRow?.addEventListener('pointermove',event=>{
    if(!pendingDrag||event.pointerId!==pendingDrag.id)return;
    if(Math.hypot(event.clientX-pendingDrag.x,event.clientY-pendingDrag.y)<4)return;
    pendingDrag=null;
    void api.command('window-drag').catch(()=>{});
  });
  for(const type of ['pointerup','pointercancel','lostpointercapture'])
    topRow?.addEventListener(type,()=>{pendingDrag=null;});
  topRow?.addEventListener('dblclick',event=>{
    if(event.button!==0||event.target.closest(interactive))return;
    event.preventDefault();
    pendingDrag=null;
    const strip=byId('tabs');
    const newTab=byId('newTab');
    const action=strip&&newTab&&window.MinternetTabBlankZones
      ?window.MinternetTabBlankZones.actionFromRects(
        event.clientX,
        strip.getBoundingClientRect(),
        newTab.getBoundingClientRect(),
        Array.from(strip.children,child=>child.getBoundingClientRect()))
      :null;
    // Split only the genuine blank gap before +: left creates a tab,
    // right maximizes/restores. All other empty title-bar space still
    // maximizes/restores; tab/group drag and buttons are unaffected.
    void api.command(action||'maximize').catch(()=>{});
  });
}

// Read live native WebView URLs so client-side SPA navigation is restored
// on the next launch, including /c/<chat-id> style conversation routes.
// Private and secret tabs are excluded by the native command.
if(window.__TAURI__){
  let sessionRefreshPending=false;
  setInterval(()=>{
    if(sessionRefreshPending || document.visibilityState==='hidden')return;
    sessionRefreshPending=true;
    void api.command('session-refresh-urls')
      .catch(()=>{}).finally(()=>{sessionRefreshPending=false;});
  },6000);
}

// Auto-unload requests run in native code, which independently verifies each
// page is safe to discard before freeing its webview memory.
const AUTO_UNLOAD_KEY='minternet.autoUnloadMinutes.v1';
function autoUnloadMinutes(){
  const raw=localStorage.getItem(AUTO_UNLOAD_KEY);
  // One-minute default caused frequent WebView2 controller destruction
  // and recreation as users switched between tabs. Choose a calmer default;
  // existing explicitly stored user settings are unchanged.
  const n=raw===null?10:Number(raw);
  return Number.isInteger(n)&&n>=0&&n<=120?n:10;
}
if(window.__TAURI__){
  let unloadPending=false;
  setInterval(()=>{
    const minutes=autoUnloadMinutes();
    if(minutes===0||unloadPending||document.visibilityState==='hidden')return;
    unloadPending=true;
    void api.command('auto-unload-check',minutes)
      .catch(()=>{}).finally(()=>{unloadPending=false;});
  },30000);
}
