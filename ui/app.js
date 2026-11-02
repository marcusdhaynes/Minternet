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
  root.title = tab.url === 'about:blank' ? 'New tab' : tab.url;
  const choose = document.createElement('button');
  choose.className = 'tab-choose';
  choose.title = tab.title;
  choose.addEventListener('click', () => command('activate', tab.id));
  const symbol = document.createElement('span');
  symbol.className = 'tab-symbol';
  symbol.textContent = tab.private ? '◈' : (tab.loading ? '◌' : '◉');
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
function render(data) {
  snapshot = data;
  const tabs = byId('tabs');
  const active = data.tabs.find(t => t.id === data.activeId);
  tabs.replaceChildren(...data.tabs.map(t => buildTab(t, t.id === data.activeId)));
  byId('back').disabled = !active?.canBack;
  byId('forward').disabled = !active?.canForward;
  byId('reload').disabled = !active || active.url === 'about:blank';
  const isBlank = !active || active.url === 'about:blank';
  byId('homeScreen').hidden = !isBlank;
  byId('modeLabel').textContent = active?.private ? 'Private' : 'Normal';
  byId('private').classList.toggle('active-mode', !!active?.private);
  byId('private').setAttribute('aria-pressed', String(!!active?.private));
  byId('connectionIcon').textContent = active?.private ? '◈' : '◇';
  byId('pageStatus').textContent = active?.error || (active?.loading ? 'Connecting securely…' : (active?.private ? 'Private session' : 'Ready to explore'));
  byId('extensionStatus').textContent = (data.extensionsCount || 0) + ' extension(s) · ' + (active?.private ? 'Private' : 'Normal') + ' mode';
  if (!addressFocused) byId('address').value = isBlank ? '' : active.url;
  if (lastUrl !== active?.url) {
    lastUrl = active?.url;
    document.title = active?.title ? active.title + ' — Minternet' : 'Minternet';
  }
}
api.onState(render);
const bind = (id, name) => byId(id).addEventListener('click', () => command(name));
for (const [id, name] of [
  ['newTab','new'],['newPrivate','new-private'],['back','back'],['forward','forward'],
  ['reload','reload'],['home','home'],['private','privacy'],['tor','tor'],
  ['extensions','extension-install'],['minimize','minimize'],['maximize','maximize'],['quit','quit']
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
byId('address').addEventListener('focus', event => {
  addressFocused = true;
  event.target.select();
});
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
