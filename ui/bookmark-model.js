'use strict';
// Pure, dependency-free bookmark tree. Never executes or embeds bookmark URLs.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MinternetBookmarks = api;
})(typeof window !== 'undefined' ? window : null, () => {
  const MAX_ITEMS = 2000, MAX_DEPTH = 12, MAX_IMAGE_LENGTH = 45000;
  const imageRE = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i;
  let seq = 0;
  const id = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'bm-' + Date.now().toString(36) + '-' + (++seq).toString(36);
  };
  const clean = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
  function icon(v) {
    if (typeof v !== 'string') return '';
    if (v.startsWith('data:')) return v.length <= MAX_IMAGE_LENGTH && imageRE.test(v) ? v : '';
    if (/^https:\/\//i.test(v)) {
      const safe=url(v); // A bookmark's favicon URL is allowed, never a script URL.
      return safe&&safe.length<=1024?safe:'';
    }
    return v.slice(0, 24).trim();
  }
  function url(v) {
    try {
      const parsed = new URL(v);
      if (!['https:','http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.href.length > 4096) return null;
      return parsed.href;
    } catch { return null; }
  }
  // Default favicon always comes from the bookmark's HTTPS origin.
  // There is no third-party icon service, and the URL never contains the
  // bookmark's path, query, credentials or fragment.
  function favicon(v) {
    const target=url(v);
    if(!target)return null;
    try{return new URL(target).origin+'/favicon.ico';}
    catch{return null;}
  }
  function blank() { return { version: 1, visible: true, items: [] }; }
  function hydrate(raw) {
    let data;
    try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return blank(); }
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return blank();
    const used = new Set();
    let count = 0;
    function normalizeNodes(nodes, depth) {
      if (!Array.isArray(nodes) || depth > MAX_DEPTH || count >= MAX_ITEMS) return [];
      const result = [];
      for (const item of nodes) {
        if (++count > MAX_ITEMS) break;
        if (!item || typeof item !== 'object') continue;
        const kind = item.kind;
        if (kind !== 'folder' && kind !== 'link') continue;
        let identifier = clean(item.id, 90);
        if (!identifier || used.has(identifier)) identifier = id();
        used.add(identifier);
        const basic = { id: identifier, kind, name: clean(item.name, kind === 'folder' ? 100 : 180), icon: icon(item.icon) };
        if (kind === 'folder') {
          basic.children = normalizeNodes(item.children, depth + 1);
        } else {
          const target = url(item.url);
          if (!target) continue;
          basic.url = target;
        }
        result.push(basic);
      }
      return result;
    }
    return { version: 1, visible: data.visible !== false, items: normalizeNodes(data.items, 1) };
  }
  function visit(items, fn, parent = null, depth = 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const result = fn(item, parent, depth, items, i);
      if (result !== undefined) return result;
      if (item.kind === 'folder') {
        const hit = visit(item.children, fn, item, depth + 1);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  }
  const find = (state, itemId) => visit(state.items, item => item.id === itemId ? item : undefined);
  const location = (state, itemId) => visit(state.items, (item, parent, depth, array, index) => item.id === itemId ? { item, parent, depth, array, index } : undefined);
  const count = state => { let n = 0; visit(state.items, () => { n++; }); return n; };
  const folders = state => { const a = []; visit(state.items, (node, parent, depth) => { if (node.kind === 'folder') a.push({ id: node.id, name: node.name, icon: node.icon, depth, parentId: parent?.id ?? null }); }); return a; };
  function add(state, kind, parentId, options = {}) {
    if (!['folder', 'link'].includes(kind) || count(state) >= MAX_ITEMS) return null;
    const parent = parentId == null ? null : find(state, parentId);
    if (parentId != null && (!parent || parent.kind !== 'folder')) return null;
    const depth = parent ? (location(state, parent.id)?.depth ?? 0) + 1 : 0;
    if (depth >= MAX_DEPTH) return null;
    const item = { id: id(), kind, name: clean(options.name, kind === 'folder' ? 100 : 180), icon: icon(options.icon) };
    if (kind === 'folder') item.children = [];
    else {
      item.url = url(options.url);
      if (!item.url) return null;
    }
    (parent ? parent.children : state.items).push(item);
    return item;
  }
  function remove(state, itemId) {
    const found = location(state, itemId);
    if (!found) return false;
    found.array.splice(found.index, 1);
    return true;
  }
  function update(state, itemId, attrs = {}) {
    const node = find(state, itemId);
    if (!node) return false;
    if (Object.hasOwn(attrs, 'name')) node.name = clean(attrs.name, node.kind === 'folder' ? 100 : 180);
    if (Object.hasOwn(attrs, 'icon')) node.icon = icon(attrs.icon);
    if (node.kind === 'link' && Object.hasOwn(attrs, 'url')) {
      const target = url(attrs.url);
      if (!target) return false;
      node.url = target;
    }
    return true;
  }
  function move(state, itemId, parentId) {
    if (itemId === parentId) return false;
    const found = location(state, itemId);
    if (!found) return false;
    const parent = parentId == null ? null : find(state, parentId);
    if (parentId != null && (!parent || parent.kind !== 'folder')) return false;
    if (parent && visit([found.item], n => n.id === parent.id ? true : undefined)) return false;
    const targetDepth = parent ? location(state, parent.id).depth + 1 : 0;
    let height = 0;
    visit([found.item], (_, __, d) => { height = Math.max(height, d); });
    if (targetDepth + height >= MAX_DEPTH) return false;
    found.array.splice(found.index, 1);
    (parent ? parent.children : state.items).push(found.item);
    return true;
  }
  const byUrl = (state, target) => visit(state.items, node => node.kind === 'link' && node.url === url(target) ? node : undefined);
  return { blank, hydrate, url, icon, favicon, find, location, folders, count, add, remove, update, move, byUrl, MAX_ITEMS };
});
