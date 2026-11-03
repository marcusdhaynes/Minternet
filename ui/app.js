'use strict';
const byId = id => document.getElementById(id);
const api = window.minternet;
let snapshot = { tabs: [], activeId: null, extensionsCount: 0 };
let lastUrl = 'about:blank';
let addressFocused = false;

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
  root.className = 'tab' + (active ? ' selected' : '') + (tab.private ? ' private-tab' : '');
  root.setAttribute('role', 'tab');
  root.setAttribute('aria-selected', String(active));
  root.title = tab.suspended ? 'Inactive tab (reloads on selection) · ' + tab.url : (tab.url === 'about:blank' ? 'New tab' : tab.url);
  const choose = document.createElement('button');
  choose.className = 'tab-choose';
  choose.title = tab.title;
  choose.addEventListener('click', () => command('activate', tab.id));
  const symbol = document.createElement('span');
  symbol.className = 'tab-symbol';
  symbol.textContent = tab.private ? '◈' : (tab.suspended ? '◌' : tab.loading ? '◌' : '◉');
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
  root.append(choose, close);
  return root;
}
window.minternetToast = toast;
window.minternetRenderTabs = () => {
  if(window.minternetGroups?.renderTabs)
    window.minternetGroups.renderTabs(snapshot,byId('tabs'),buildTab);
};
function render(data) {
  snapshot = data;
  const tabs = byId('tabs');
  const active = data.tabs.find(t => t.id === data.activeId);
  const signature = data.tabs.map(t => t.id).join(',');
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
      el.className = 'tab' + (activeTab ? ' selected' : '') + (tab.private ? ' private-tab' : '');
      el.setAttribute('aria-selected', String(activeTab));
      el.title = tab.suspended ? 'Inactive tab (reloads on selection) · ' + tab.url : tab.url;
      el.querySelector('.tab-symbol').textContent = tab.private ? '◈' : tab.suspended || tab.loading ? '◌' : '◉';
      el.querySelector('.tab-text').textContent = tab.title || 'New Tab';
    }
  }
  byId('back').disabled = !active?.canBack;
  byId('forward').disabled = !active?.canForward;
  byId('reload').disabled = !active || active.url === 'about:blank';
  const isBlank = !active || active.url === 'about:blank';
  byId('homeScreen').hidden = !isBlank;
  byId('modeLabel').textContent = active?.private ? 'Private' : 'Normal';
  byId('private').classList.toggle('active-mode', !!active?.private);
  byId('private').setAttribute('aria-pressed', String(!!active?.private));
  byId('private').setAttribute('aria-label',
    active?.private ? 'Private Mode · Switch to Normal' : 'Normal Mode · Switch to Private');
  byId('private').title=active?.private ?
    'Private Mode · Switch Current Tab to Normal' : 'Normal Mode · Switch Current Tab to Private';
  byId('connectionIcon').textContent = active?.url?.startsWith('http://') ? '!' : active?.private ? '◈' : '◇';
  byId('connectionIcon').title = active?.url?.startsWith('http://') ? 'Warning: unencrypted HTTP' : 'HTTPS preferred';
  byId('address').setAttribute('aria-label', active?.url?.startsWith('http://') ? 'Insecure HTTP address' : 'Search or enter address');
  byId('pageStatus').textContent = active?.error || (active?.loading ? 'Connecting securely…' : (active?.private ? 'Private session' : 'Ready to explore'));
  byId('extensionStatus').textContent = (data.extensionsCount || 0) + ' extension(s) · ' + (active?.private ? 'Private' : 'Normal') + ' mode';
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
  ['reload','reload'],['private','privacy'],['tor','tor'],
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
  const interactive='button,.tabs,.window-actions,.ungroup-drop-target,input,a,[role="tab"]';
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
