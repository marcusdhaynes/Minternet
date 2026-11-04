'use strict';
const byId = id => document.getElementById(id);
const api = window.minternet;
let snapshot = { tabs: [], activeId: null, extensionsCount: 0 };
let lastUrl = 'about:blank';
let addressFocused = false;
const PRIVATE_EYE='<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12s3.7-5.7 9.5-5.7 9.5 5.7 9.5 5.7-3.7 5.7-9.5 5.7S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.7"/></svg>';

const command = async (name, value) => {
  try {
    const result = await api.command(name, value);
    if (result?.message) toast(result.message);
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
function buildTab(tab, active) {
  const root = document.createElement('div');
  root.className = 'tab' + (active ? ' selected' : '') +
    (tab.private ? ' private-tab' : '') + (tab.pinned ? ' pinned-tab' : '');
  root.setAttribute('role', 'tab');
  root.setAttribute('aria-selected', String(active));
  root.title = tab.suspended ? 'Inactive tab (reloads on selection) · ' + tab.url : (tab.url === 'about:blank' ? 'New tab' : tab.url);
  const choose = document.createElement('button');
  choose.className = 'tab-choose';
  choose.title = (tab.pinned?'Pinned · ':'')+tab.title;
  choose.addEventListener('click', () => command('activate', tab.id));
  const symbol = document.createElement('span');
  symbol.className = 'tab-symbol';
  // Compact local site monogram; no third-party favicon requests/leaks.
  let monogram='◆';
  if(tab.pinned && tab.url?.startsWith('https://')){
    try {monogram=new URL(tab.url).hostname.replace(/^www\./,'').charAt(0).toUpperCase()||'◆';}
    catch {}
  }
  if(tab.private){symbol.classList.add('private-eye');symbol.innerHTML=PRIVATE_EYE;}
  else symbol.textContent = tab.pinned ? monogram :
    (tab.suspended ? '◌' : tab.loading ? '◌' : '◉');
  const text = document.createElement('span');
  text.className = 'tab-text';
  text.textContent = tab.title || 'New Tab';
  choose.append(symbol, text);
  const close = document.createElement('button');
  close.className = 'tab-close';
  close.textContent = '×';
  close.title = 'Close tab';
  close.setAttribute('aria-label', 'Close ' + (tab.title || 'tab'));
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
  const isNewTab=data.activeId && !previouslyKnown.has(data.activeId) &&
    data.tabs.some(tab=>tab.id===data.activeId&&tab.url==='about:blank');
  snapshot = data;
  const tabs = byId('tabs');
  const active = data.tabs.find(t => t.id === data.activeId);
  const signature = data.tabs.map(t => [t.id,t.audioPlaying,t.audioMuted]).join(';');
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
        (tab.private ? ' private-tab' : '')+(tab.pinned ? ' pinned-tab' : '');
      el.setAttribute('aria-selected', String(activeTab));
      el.title = tab.suspended ? 'Inactive tab (reloads on selection) · ' + tab.url : tab.url;
      const symbol=el.querySelector('.tab-symbol');
      if(tab.private){symbol.classList.add('private-eye');symbol.innerHTML=PRIVATE_EYE;}
      else{
        symbol.classList.remove('private-eye');
        symbol.textContent = tab.pinned ?
          (tab.url?.startsWith('https://')?new URL(tab.url).hostname.replace(/^www\./,'').charAt(0).toUpperCase():'◆') :
          tab.suspended || tab.loading ? '◌' : '◉';
      }
      el.querySelector('.tab-text').textContent = tab.title || 'New Tab';
    }
  }
  document.documentElement.classList.toggle('private-active',Boolean(active?.private));
  if(isNewTab){
    requestAnimationFrame(()=>{
      const address=byId('address');
      address?.focus();
      address?.select();
    });
  }
    byId('back').disabled = !active?.canBack;
  byId('forward').disabled = !active?.canForward;
  byId('reload').disabled = !active || active.url === 'about:blank';
  const isBlank = !active || active.url === 'about:blank';
  byId('homeScreen').hidden = !isBlank;
  byId('address').setAttribute('aria-label', active?.url?.startsWith('http://') ? 'Insecure HTTP address' : 'Search or enter address');
  if (!addressFocused) byId('address').value = isBlank ? '' : active.url;
  if (lastUrl !== active?.url) {
    lastUrl = active?.url;
    document.title = active?.title ? active.title + ' — Minternet' : 'Minternet';
  }
}
api.onState(render);
api.onFocusAddress(() => byId('address').focus());
const bind = (id, name) => byId(id).addEventListener('click', () => command(name));
for (const [id, name] of [
  ['newTab','new'],['newPrivate','new-private'],['back','back'],['forward','forward'],
  ['reload','reload'],['tor','tor'],
  ['minimize','minimize'],['maximize','maximize'],['quit','quit']
]) bind(id,name);
byId('addressForm').addEventListener('submit', event => {
  event.preventDefault();
  command('navigate', byId('address').value);
  byId('address').blur();
});
byId('homeSearchForm').addEventListener('submit', event => {
  event.preventDefault();
  const q = byId('homeSearch').value;
  if (q.trim()) command('navigate', q);
});
// Warm the native renderer while the user begins typing. Nothing is fetched
// until Enter; no speculative website requests, DNS prefetch, or privacy leak.
let warmTimer;
function prepareBlankTab() {
  if (!window.__TAURI__) return;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    const active = snapshot.tabs.find(t => t.id === snapshot.activeId);
    if (active?.url === 'about:blank') void api.command('prepare-tab').catch(() => {});
  }, 75);
}
byId('address').addEventListener('focus', event => {
  addressFocused = true;
  event.target.select();
  prepareBlankTab();
});
byId('homeSearch').addEventListener('focus', prepareBlankTab);
byId('address').addEventListener('blur', () => {
  addressFocused = false;
  const active = snapshot.tabs.find(t => t.id === snapshot.activeId);
  byId('address').value = active && active.url !== 'about:blank' ? active.url : '';
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
    void api.command('maximize').catch(()=>{});
  });
}
