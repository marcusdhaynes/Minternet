'use strict';
// Tiny, dependency-free tab-group model. Group definitions persist; tab assignments
// are deliberately session-only because native tab IDs restart when Minternet opens.
(function (root, factory) {
  const result = factory();
  if (typeof module === 'object' && module.exports) module.exports = result;
  if (root) root.MinternetGroupModel = result;
})(typeof window !== 'undefined' ? window : null, () => {
  const MAX_GROUPS = 40;
  const colors = ['violet','blue','teal','green','amber','orange','pink','red','slate'];
  const makeId = () => typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID() : 'group-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const name = value => typeof value === 'string' ? value.trim().slice(0, 42) : '';
  const color = value => colors.includes(value) ? value : 'violet';
  const blank = () => ({ version: 1, groups: [], assignments: Object.create(null), order: [] });
  function hydrate(json) {
    let raw;
    try { raw = typeof json === 'string' ? JSON.parse(json) : json; }
    catch { return blank(); }
    const state = blank();
    if (!Array.isArray(raw?.groups)) return state;
    const seen = new Set();
    for (const g of raw.groups) {
      if (!g || typeof g !== 'object' || state.groups.length >= MAX_GROUPS) continue;
      const id = typeof g.id === 'string' && /^[a-z0-9-]{1,90}$/i.test(g.id) ? g.id : makeId();
      if (seen.has(id)) continue;
      seen.add(id);
      state.groups.push({ id, name: name(g.name), color: color(g.color), visible: g.visible !== false,
        collapsed: g.collapsed === true });
    }
    // Never restore assignments: stale native tab IDs may point to another page.
    return state;
  }
  const serialize = state => JSON.stringify({ version: 1, groups: state.groups });
  const get = (state, id) => state.groups.find(g => g.id === id);
  const findTab = (state, tabId) => get(state, state.assignments[String(tabId)]);
  function create(state, attrs = {}) {
    if (state.groups.length >= MAX_GROUPS) return null;
    const g = { id: makeId(), name: name(attrs.name), color: color(attrs.color),
      visible: true, collapsed: false };
    state.groups.push(g);
    return g;
  }
  function update(state, id, attrs={}) {
    const g=get(state,id);
    if (!g) return false;
    if (Object.hasOwn(attrs,'name')) g.name=name(attrs.name);
    if (Object.hasOwn(attrs,'color')) g.color=color(attrs.color);
    if (Object.hasOwn(attrs,'visible')) g.visible=Boolean(attrs.visible);
    if (Object.hasOwn(attrs,'collapsed')) g.collapsed=Boolean(attrs.collapsed);
    return true;
  }
  function remove(state,id) {
    const index=state.groups.findIndex(g=>g.id===id);
    if(index<0)return false;
    state.groups.splice(index,1);
    for(const key of Object.keys(state.assignments)) {
      if(state.assignments[key]===id)delete state.assignments[key];
    }
    return true;
  }
  function assign(state, tabId, id) {
    if(!Number.isSafeInteger(tabId)||tabId<1)return false;
    if(id==null){delete state.assignments[String(tabId)];return true;}
    if(!get(state,id))return false;
    state.assignments[String(tabId)]=id;
    return true;
  }
  function prune(state,tabIds) {
    const valid=new Set(tabIds.map(String));
    for(const key of Object.keys(state.assignments)) {
      if(!valid.has(key)||!get(state,state.assignments[key]))delete state.assignments[key];
    }
    state.order=state.order.filter(id=>valid.has(String(id)));
    for(const id of tabIds)if(!state.order.includes(id))state.order.push(id);
  }
  function sortedTabs(state,tabs) {
    const pos=new Map(state.order.map((id,i)=>[id,i]));
    return [...tabs].sort((a,b)=>(pos.get(a.id)??Infinity)-(pos.get(b.id)??Infinity));
  }
  function moveRelative(state,movingId,targetId,after=false) {
    if(movingId===targetId||!state.order.includes(movingId)||!state.order.includes(targetId))return false;
    const next=state.order.filter(id=>id!==movingId);
    const at=next.indexOf(targetId);
    if(at<0)return false;
    next.splice(at+(after?1:0),0,movingId);
    state.order=next;
    return true;
  }
  function tabsIn(state,gid,tabs) {
    return sortedTabs(state,tabs).filter(t=>state.assignments[String(t.id)]===gid);
  }
  function isVisibleTab(state,tabId) {
    const g=findTab(state,tabId);
    return !g||(g.visible&&!g.collapsed);
  }
  function visibleFallback(state,tabs,excludeId) {
    return tabs.find(t=>t.id!==excludeId && isVisibleTab(state,t.id))?.id ?? null;
  }
  return { colors, MAX_GROUPS, blank, hydrate, serialize, get, findTab, create, update, remove,
    assign, prune, sortedTabs, moveRelative, tabsIn, isVisibleTab, visibleFallback };
});
