'use strict';
// The trusted Minternet chrome owns bookmarks. Website webviews cannot read this storage.
(() => {
  const model = window.MinternetBookmarks;
  const api = window.minternet;
  if (!model || !api) return;
  const $ = id => document.getElementById(id);
  const STORE = 'minternet.bookmark-tree.v1';
  let data;
  try { data = model.hydrate(localStorage.getItem(STORE)); }
  catch { data = model.blank(); }
  let currentUrl = '', currentTitle = '', mode = null, folderId = null, draft = null, customIcon = '';
  let lastUndoJson=JSON.stringify(data);
  // Store only changed string spans, not a complete bookmark tree on every
  // edit. Renaming one item costs roughly that item's old name in history.
  function makeUndoPatch(before,after){
    let start=0;
    while(start<before.length&&start<after.length&&before[start]===after[start])start++;
    let suffix=0;
    while(suffix<before.length-start&&suffix<after.length-start&&
      before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
    return {start,remove:after.length-start-suffix,
      insert:before.slice(start,before.length-suffix)};
  }
  function restoreUndoBookmark(patch){
    try{
      if(!patch||!Number.isSafeInteger(patch.start)||!Number.isSafeInteger(patch.remove)||
         patch.start<0||patch.remove<0||typeof patch.insert!=='string')return false;
      const now=JSON.stringify(data);
      if(patch.start+patch.remove>now.length||patch.insert.length>950000)return false;
      const before=now.slice(0,patch.start)+patch.insert+now.slice(patch.start+patch.remove);
      const raw=JSON.parse(before);
      if(!raw || !Array.isArray(raw.items))return false;
      const parsed=model.hydrate(raw);
      data=parsed;
      applyVisibility();
      persist(true);
      return true;
    }catch{return false;}
  }
  const toast = message => {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('visible');
    clearTimeout(toast.hideTimer);
    toast.hideTimer = setTimeout(() => el.classList.remove('visible'), 2700);
  };
  function persist(skipUndo=false) {
    const json=JSON.stringify(data);
    if(!skipUndo && json!==lastUndoJson && window.__TAURI__){
      const patch=makeUndoPatch(lastUndoJson,json);
      if(patch.insert.length<240000){
        void api.command('undo-ui-checkpoint',{kind:'bookmarks',patch});
      }
    }
    lastUndoJson=json;
    try {
      if (json.length > 950000) throw new Error('Bookmark storage is full');
      localStorage.setItem(STORE, json);
    } catch {
      toast('Bookmarks could not be saved. Free space or reduce icon sizes.');
    }
    renderBar();
    renderStar();
    if (mode === 'manager') renderManager();
    if (mode === 'folder') renderFolder();
  }
  function iconNode(item, isFolder = item?.kind === 'folder') {
    const slot = document.createElement('span');
    slot.className = 'bookmark-emoji';
    const value = model.icon(item?.icon);
    if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(value)) {
      const img = document.createElement('img');
      img.src = value;
      img.alt = '';
      slot.append(img);
    } else slot.textContent = value || (isFolder ? '📁' : '🔖');
    return slot;
  }
  function textFor(node) {
    return node.name || (node.kind === 'folder' ? 'Unnamed Folder' : model.url(node.url)?.replace(/^https:\/\//, '') || 'Bookmark');
  }
  function act(name, arg) { return api.command(name, arg); }
  function applyVisibility() {
    $('bookmarkBar').hidden = !data.visible;
    $('bookmarkBarToggle').checked = data.visible;
    document.documentElement.classList.toggle('has-bookmarks', data.visible);
    if (window.__TAURI__) void act('bookmark-bar-visibility', data.visible);
  }
  function changeVisibility(visible) {
    data.visible = Boolean(visible);
    applyVisibility();
    persist();
  }
  function renderBar() {
    const holder = $('bookmarkItems');
    holder.replaceChildren();
    for (const item of data.items) {
      const el = document.createElement('button');
      el.className = 'bookmark-item';
      el.type = 'button';
      el.append(iconNode(item));
      if (item.name) {
        const name = document.createElement('span');
        name.className = 'bookmark-caption';
        name.textContent = item.name;
        el.append(name);
      }
      el.dataset.bookmarkId = item.id;
      el.title = item.kind === 'folder' ? textFor(item) : (item.name || item.url);
      el.setAttribute('aria-label', item.kind === 'folder' ? 'Open Folder: ' + textFor(item) : 'Open Bookmark: ' + textFor(item));
      el.addEventListener('click', () => {
        if(item.kind === 'folder') {
          if(window.minternetMenus?.folder) window.minternetMenus.folder(item.id,el);
          else openFolder(item.id);
        } else openLink(item.url);
      });
      el.addEventListener('contextmenu', event => {
        event.preventDefault();
        if(window.minternetMenus?.bookmark) window.minternetMenus.bookmark(item.id,event);
        else edit(item.id);
      });
      holder.append(el);
    }
  }
  function renderStar() {
    const star = $('bookmarkThisPage');
    const valid = model.url(currentUrl);
    const saved = valid && model.byUrl(data, valid);
    star.disabled = !valid;
    star.classList.toggle('active', Boolean(saved));
    star.textContent = saved ? '★' : '☆';
    star.title = saved ? 'Remove Bookmark (Ctrl+D)' : 'Bookmark This Page (Ctrl+D)';
  }
  function toggleBookmark() {
    const url = model.url(currentUrl);
    if (!url) return toast('Open an HTTPS webpage to bookmark it.');
    const existing = model.byUrl(data, url);
    if (existing) {
      model.remove(data, existing.id);
      toast('Bookmark removed');
    } else {
      const name = currentTitle && currentTitle !== 'New Tab' ? currentTitle : new URL(url).hostname;
      if (!model.add(data, 'link', null, { name, url })) return toast('Unable to save bookmark');
      toast('Page bookmarked');
    }
    persist();
  }
  function openLink(url) {
    closeOverlay();
    if (!model.url(url)) return toast('Unsafe bookmark URL');
    void act('navigate', url);
  }
  function nativeOverlay(open) {
    if (window.__TAURI__) void act('chrome-overlay', open);
  }
  function setMode(next) {
    mode = next;
    $('bookmarkOverlay').hidden = !next;
    for (const [name, id] of [
      ['settings', 'bookmarkSettings'], ['folder', 'bookmarkFolderMenu'],
      ['manager', 'bookmarkManager'], ['editor', 'bookmarkEditor']
    ]) $(id).hidden = next !== name;
    $('settings').setAttribute('aria-expanded', String(next === 'settings'));
    // Settings is separate from the bookmark manager; the bookmark list stays
    // out of view until Manage Bookmarks is explicitly selected.
    document.documentElement.classList.toggle('settings-visible',next==='settings');
    nativeOverlay(Boolean(next));
  }
  function closeOverlay() {
    if (!mode) return;
    setMode(null);
    $('settings').focus();
  }
  function openSettings() {
    if (mode === 'settings') closeOverlay();
    else setMode('settings');
  }
  function openFolder(id) {
    const folder = model.find(data, id);
    if (!folder || folder.kind !== 'folder') return toast('Folder no longer exists');
    folderId = id;
    renderFolder();
    setMode('folder');
  }
  function folderParent() {
    const info = model.location(data, folderId);
    if (info?.parent) openFolder(info.parent.id);
    else { renderManager(); setMode('manager'); }
  }
  function entryForMenu(item) {
    const row = document.createElement('div');
    row.className = 'bookmark-folder-row';
    const open = document.createElement('button');
    open.className = 'bookmark-folder-entry';
    open.type = 'button';
    open.append(iconNode(item));
    const name = document.createElement('span');
    name.textContent = textFor(item);
    open.append(name);
    const label = document.createElement('span');
    label.textContent = item.kind === 'folder' ? '›' : '↗';
    open.append(label);
    open.title = textFor(item);
    open.addEventListener('click', () => item.kind === 'folder' ? openFolder(item.id) : openLink(item.url));
    const editButton = document.createElement('button');
    editButton.className = 'edit';
    editButton.textContent = '✎';
    editButton.type = 'button';
    editButton.title = 'Edit ' + textFor(item);
    editButton.setAttribute('aria-label', 'Edit ' + textFor(item));
    editButton.addEventListener('click', () => edit(item.id));
    row.append(open, editButton);
    return row;
  }
  function renderFolder() {
    const folder = model.find(data, folderId);
    if (!folder || folder.kind !== 'folder') { setMode('manager'); return; }
    $('bookmarkFolderTitle').textContent = textFor(folder);
    const contents = $('bookmarkFolderContents');
    contents.replaceChildren();
    if (!folder.children.length) {
      const empty = document.createElement('div');
      empty.className = 'bookmark-settings-foot';
      empty.textContent = 'Empty folder · Add a subfolder or save this page.';
      contents.append(empty);
    }
    for (const item of folder.children) contents.append(entryForMenu(item));

  }
  function renderManager() {
    const tree = $('bookmarkTree');
    tree.replaceChildren();
    if (!data.items.length) {
      const empty = document.createElement('div');
      empty.className = 'bookmark-settings-foot';
      empty.textContent = 'No bookmarks yet · Create a folder or star a page.';
      tree.append(empty);
    }
    function walk(items, depth) {
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'bookmark-tree-line';
        row.style.paddingLeft = Math.min(160, depth * 13 + 4) + 'px';
        const icon = iconNode(item);
        const label = document.createElement('button');
        label.className = 'label';
        label.textContent = textFor(item);
        label.title = item.kind === 'link' ? item.url : textFor(item);
        label.addEventListener('click', () => item.kind === 'folder' ? openFolder(item.id) : openLink(item.url));
        row.append(icon, label);
        if (item.kind === 'folder') {
          const add = document.createElement('button');
          add.className = 'action';
          add.textContent = '＋';
          add.title = 'Add Subfolder';
          add.setAttribute('aria-label', 'Add Subfolder to ' + textFor(item));
          add.addEventListener('click', () => openEditor('folder', null, item.id));
          row.append(add);
        }
        const editButton = document.createElement('button');
        editButton.className = 'action';
        editButton.textContent = '✎';
        editButton.title = 'Edit / Move';
        editButton.setAttribute('aria-label', 'Edit ' + textFor(item));
        editButton.addEventListener('click', () => edit(item.id));
        row.append(editButton);
        tree.append(row);
        if (item.kind === 'folder') walk(item.children, depth + 1);
      }
    }
    walk(data.items, 0);
  }
  function edit(id) {
    const node = model.find(data, id);
    if (!node) return toast('Bookmark not found');
    const info = model.location(data, id);
    openEditor(node.kind, id, info?.parent?.id ?? null);
  }
  function openEditor(kind, id = null, parentId = null) {
    const node = id ? model.find(data, id) : null;
    draft = { kind, id, parentId };
    $('bookmarkEditorTitle').textContent = id ? 'Edit ' + (kind === 'folder' ? 'Folder' : 'Bookmark') : 'New ' + (kind === 'folder' ? 'Folder' : 'Bookmark');
    $('bookmarkName').value = node?.name || '';
    $('bookmarkUrlField').hidden = kind === 'folder';
    $('bookmarkUrl').value = node?.url || (kind === 'link' ? model.url(currentUrl) || '' : '');
    $('bookmarkRemove').hidden = !id;
    customIcon = node?.icon || '';
    $('bookmarkIcon').value = customIcon.startsWith('data:') ? '' : customIcon;
    $('bookmarkImageFile').value = '';
    renderIconPreview();
    const parentList = $('bookmarkParent');
    parentList.replaceChildren();
    const rootOption = document.createElement('option');
    rootOption.value = '';
    rootOption.textContent = 'Bookmark Bar (Root)';
    parentList.append(rootOption);
    for (const f of model.folders(data)) {
      const option = document.createElement('option');
      option.value = f.id;
      option.textContent = '  '.repeat(f.depth) + (f.icon && !f.icon.startsWith('data:') ? f.icon + ' ' : '📁 ') + (f.name || 'Unnamed Folder');
      if (id === f.id || (kind === 'folder' && id && model.location(data, f.id)?.depth > model.location(data, id)?.depth && isDescendant(id, f.id))) option.disabled = true;
      parentList.append(option);
    }
    parentList.value = parentId || '';
    if (parentList.value !== (parentId || '')) parentList.value = '';
    setMode('editor');
    $('bookmarkName').focus();
  }
  function isDescendant(ancestorId, candidateId) {
    let cursor = model.location(data, candidateId);
    while (cursor?.parent) {
      if (cursor.parent.id === ancestorId) return true;
      cursor = model.location(data, cursor.parent.id);
    }
    return false;
  }
  function renderIconPreview() {
    const el = $('bookmarkIconPreview');
    el.replaceChildren();
    el.append(iconNode({icon:customIcon,kind:draft?.kind || 'folder'}, draft?.kind === 'folder'));
  }
  function saveEditor(event) {
    event.preventDefault();
    if (!draft) return;
    const parent = $('bookmarkParent').value || null;
    const name = $('bookmarkName').value;
    const url = draft.kind === 'link' ? model.url($('bookmarkUrl').value) : null;
    if (draft.kind === 'link' && !url) return toast('Enter a valid HTTPS website address.');
    if (draft.id) {
      if (parent !== draft.parentId && !model.move(data, draft.id, parent)) return toast('Cannot move a folder into itself or its descendant.');
      if (!model.update(data, draft.id, { name, icon:customIcon, ...(draft.kind === 'link' ? {url} : {}) })) return toast('Could not update this bookmark.');
    } else {
      const item = model.add(data, draft.kind, parent, {name, icon:customIcon, ...(draft.kind === 'link' ? {url} : {})});
      if (!item) return toast('Could not create bookmark. Check folder depth or item limit.');
    }
    persist();
    closeOverlay();
  }
  function deleteEditor() {
    if (!draft?.id) return;
    const node = model.find(data, draft.id);
    if (node?.kind === 'folder' && node.children.length &&
        !window.confirm('Delete this folder and everything inside it?')) return;
    if (model.remove(data, draft.id)) {
      persist();
      closeOverlay();
      toast('Removed');
    }
  }
  async function imageFromFile(file) {
    if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 3000000) {
      throw new Error('Choose PNG, JPEG, or WebP smaller than 3 MB.');
    }
    const source = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Could not decode image'));
      img.src = source;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image conversion is unavailable.');
    ctx.clearRect(0,0,32,32);
    const scale = Math.min(32/img.naturalWidth,32/img.naturalHeight);
    const w = Math.max(1,Math.round(img.naturalWidth*scale));
    const h = Math.max(1,Math.round(img.naturalHeight*scale));
    ctx.drawImage(img,(32-w)/2,(32-h)/2,w,h);
    const result = canvas.toDataURL('image/png');
    if (!model.icon(result)) throw new Error('Image is too complex to store as a small icon.');
    return result;
  }
  $('bookmarkThisPage').addEventListener('click', toggleBookmark);
  $('bookmarkThisPage').addEventListener('contextmenu', event => {
    event.preventDefault();
    const existing = model.byUrl(data, currentUrl);
    if (existing) edit(existing.id);
    else if (model.url(currentUrl)) openEditor('link');
  });
  $('settings').addEventListener('click', openSettings);
  $('bookmarkBackdrop').addEventListener('click', closeOverlay);
  $('bookmarkSettingsClose').addEventListener('click', closeOverlay);
  $('bookmarkManageClose').addEventListener('click', closeOverlay);
  $('bookmarkFolderClose').addEventListener('click', closeOverlay);
  $('bookmarkEditClose').addEventListener('click', closeOverlay);
  $('bookmarkCancel').addEventListener('click', closeOverlay);
  $('bookmarkBarToggle').addEventListener('change', event => changeVisibility(event.target.checked));
  $('bookmarkSettingsManage').addEventListener('click', () => { renderManager(); setMode('manager'); });
  $('bookmarkBarManage').addEventListener('click', () => { renderManager(); setMode('manager'); });
  $('bookmarkManageNewFolder').addEventListener('click', () => openEditor('folder'));
  $('bookmarkManageNewLink').addEventListener('click', () => openEditor('link'));
  $('bookmarkFolderBack').addEventListener('click', folderParent);
  $('bookmarkFolderNew').addEventListener('click', () => openEditor('folder',null,folderId));
  $('bookmarkFolderEdit').addEventListener('click', () => edit(folderId));
  $('bookmarkEditForm').addEventListener('submit', saveEditor);
  $('bookmarkRemove').addEventListener('click', deleteEditor);
  $('bookmarkIcon').addEventListener('input', event => {
    customIcon = event.target.value;
    renderIconPreview();
  });
  $('bookmarkIconUpload').addEventListener('click', () => $('bookmarkImageFile').click());
  $('bookmarkImageFile').addEventListener('change', async event => {
    try {
      const file = event.target.files?.[0];
      if (!file) return;
      customIcon = await imageFromFile(file);
      $('bookmarkIcon').value = '';
      renderIconPreview();
    } catch(e) { toast(e.message || 'Could not use image.'); }
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && mode) { event.preventDefault(); closeOverlay(); }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
      event.preventDefault(); changeVisibility(!data.visible); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
      event.preventDefault(); renderManager(); setMode('manager'); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      toggleBookmark();
    }
  });
  // Controllers are accessible only within trusted local chrome. Remote
  // website WebView2 pages have neither this JS context nor native menu IPC.
  window.minternetBookmarks = {
    getState: () => data,
    edit, newFolder: parent => openEditor('folder',null,parent||null),
    savePage: parent => {
      const target=model.url(currentUrl);
      if(!target)return toast('Open an HTTPS page to bookmark it.');
      if(!model.add(data,'link',parent||null,{
        name:currentTitle||new URL(target).hostname,url:target
      }))return toast('Unable to save bookmark.');
      persist();toast('Page bookmarked');
    },
    openLink, toggleBookmark, manager:()=>{renderManager();setMode('manager');},
    toggleBar:()=>changeVisibility(!data.visible),
    closeOverlay,restoreUndoBookmark
  };
  api.onState(state => {
    const tab = state.tabs.find(t => t.id === state.activeId);
    currentUrl = tab?.url || '';
    currentTitle = tab?.title || '';
    renderStar();
  });
  // Initial hydration is synchronous and survives portable EXE restarts in the
  // trusted Tauri WebView2 profile, independent of website sessions.
  applyVisibility();
  renderBar();
  renderStar();
})();
