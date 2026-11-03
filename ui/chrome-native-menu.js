'use strict';
// Browser-style native context menus. On Windows this is an OS-owned popup:
// it is anchored precisely to the clicked folder, keeps the page WebView2
// visible, follows system DPI and automatically cascades on submenu hover.
(() => {
  const $=id=>document.getElementById(id);
  let lastMenus=[];
  const cleanLabel=(value,fallback)=>String(value||fallback).replace(/[\r\n\t]/g,' ').slice(0,80);
  const sep=()=>({item:'Separator'});
  const disabled=text=>({text,enabled:false});
  const item=(text,action)=>({text:cleanLabel(text,'Untitled'),action});
  const sub=(text,items)=>({text:cleanLabel(text,'Folder'),items:items.length?items:[disabled('Empty')]});
  const iconText=node=>{
    const icon=node?.icon||'';
    return icon.startsWith('data:')?(node?.kind==='folder'?'📁':'🔖'):icon|| (node?.kind==='folder'?'📁':'🔖');
  };
  const label=node=>cleanLabel(node?.name,node?.kind==='folder'?'Unnamed Folder':node?.url||'Bookmark');
  const state=()=>window.minternetBookmarks?.getState();
  const ctrl=()=>window.minternetBookmarks;
  const groups=()=>window.minternetGroups;

  function folderItems(id,depth=0){
    const b=ctrl(),data=state(),folder=window.MinternetBookmarks?.find(data,id);
    if(!folder||folder.kind!=='folder')return [disabled('Folder not found')];
    const items=[];
    for(const child of folder.children.slice(0,120)){
      if(child.kind==='folder'){
        items.push(sub(iconText(child)+'  '+label(child)+'  ›',depth<11?folderItems(child.id,depth+1):[disabled('Maximum folder depth')]));
      }else if(child.kind==='link'){
        items.push(item(iconText(child)+'  '+label(child),()=>b.openLink(child.url)));
      }
    }
    if(folder.children.length>120)items.push(item('More…',()=>b.manager()));
    if(items.length===0)items.push(disabled('Empty Folder'));
    items.push(sep());
    items.push(item('＋  New Subfolder…',()=>b.newFolder(id)));
    items.push(item('☆  Bookmark This Page',()=>b.savePage(id)));
    items.push(item('✎  Edit Folder…',()=>b.edit(id)));
    return items;
  }
  function barGroupItems(){
    const g=groups();
    if(!g)return [disabled('Tab Groups unavailable')];
    const arr=g.getState().groups;
    const options=arr.map(group=>{
      const text='●  '+cleanLabel(g.displayName(group),'Group').padEnd(24,' ')+'   '+(group.visible?'👁':'👁̸');
      return item(text,()=>g.toggleVisible(group.id));
    });
    if(!options.length)options.push(disabled('No groups yet'));
    options.push(sep(),item('＋  New Tab Group…',()=>g.openEditor(null,true)));
    return options;
  }
  function groupDetail(id) {
    const g=groups(),obj=g?.get(id);
    if(!obj)return [disabled('Group unavailable')];
    return [
      item(obj.visible?'👁  Hide From Tab Bar':'👁  Show In Tab Bar',()=>g.toggleVisible(id)),
      item(obj.collapsed?'▸  Expand Tabs':'▾  Collapse Tabs',()=>g.toggleCollapsed(id)),
      item('＋  Move Current Tab Here',()=>g.assign(g.getLatest().activeId,id)),
      sep(),item('✎  Rename / Change Color…',()=>g.openEditor(id)),
      item('×  Delete Group (Keep Tabs)',()=>g.removeGroup(id))
    ];
  }
  function groupsMenu(){
    const g=groups();
    if(!g)return [disabled('Unavailable')];
    const list=[item('▣  New Tab Group…',()=>g.openEditor(null,true))];
    for(const group of g.getState().groups) {
      list.push(sub('●  '+g.displayName(group)+'  '+(group.visible?'👁':'👁̸'),groupDetail(group.id)));
    }
    if(g.getState().groups.length===0)list.push(disabled('No groups yet'));
    return list;
  }
  function tabMenu(tabId){
    const g=groups(), b=ctrl();
    if(!g)return [disabled('Unavailable')];
    const belonging=window.MinternetGroupModel.findTab(g.getState(),tabId);
    const assignOptions=[item('＋  New Group With Tab…',()=>{g.openEditor(null,true);})];
    for(const group of g.getState().groups) {
      assignOptions.push(item((belonging?.id===group.id?'✓  ':'●  ')+g.displayName(group),()=>g.assign(tabId,group.id)));
    }
    return [
      sub('▣  Add Tab To Group',assignOptions),
      ...(belonging?[item('Remove Tab From '+g.displayName(belonging),()=>g.ungroup(tabId))]:[]),
      sep(),item('☆  Bookmark This Page',()=>b?.toggleBookmark()),
      item('＋  New Tab',()=>window.minternet?.command('new'))
    ];
  }
  function barMenu(folderId=null){
    const b=ctrl();
    const menus=[
      sub('▣  Tab Groups',barGroupItems()),
      sep(),
      item('📁  New Folder…',()=>b?.newFolder(folderId)),
      item('☆  Bookmark This Page',()=>b?.toggleBookmark()),
      item('⚙  Manage Bookmarks…',()=>b?.manager()),
      sep(),
      item((state()?.visible?'✓  ':'')+'Show Bookmark Bar',()=>b?.toggleBar())
    ];
    if(folderId){
      menus.unshift(sub('📁  Folder Contents',folderItems(folderId)),item('✎  Edit This Folder…',()=>b?.edit(folderId)),sep());
    }
    return menus;
  }

  // For the GitHub Pages UI-only demo, use a small DOM popup and cascading
  // submenus. The actual installed browser uses the native OS menu above.
  let fallback=null;
  function closeFallback(){
    fallback?.remove();fallback=null;
    document.removeEventListener('pointerdown',outside,true);
    document.removeEventListener('keydown',esc,true);
  }
  function outside(e){if(fallback&&!fallback.contains(e.target))closeFallback();}
  function esc(e){if(e.key==='Escape'){e.preventDefault();closeFallback();}}
  function domMenu(items){
    const list=document.createElement('div');list.className='system-popup-list';
    for(const spec of items){
      if(spec.item==='Separator'){
        const line=document.createElement('div');line.className='system-popup-separator';list.append(line);continue;
      }
      const row=document.createElement('button');
      row.type='button';row.className='system-popup-row';
      row.textContent=spec.text;
      row.disabled=spec.enabled===false;
      if(spec.items){
        const arrow=document.createElement('span');arrow.textContent='›';arrow.className='system-popup-arrow';row.append(arrow);
        const child=domMenu(spec.items);
        child.classList.add('system-popup-child');
        const host=document.createElement('div');
        host.className='system-popup-has-child';
        host.append(row,child);list.append(host);
        row.addEventListener('click',()=>host.classList.toggle('system-popup-open'));
        host.addEventListener('mouseenter',()=>host.classList.add('system-popup-open'));
        host.addEventListener('mouseleave',()=>host.classList.remove('system-popup-open'));
      }else{
        row.addEventListener('click',()=>{closeFallback();spec.action?.();});
        list.append(row);
      }
    }
    return list;
  }
  async function popup(items,point){
    const x=Math.max(0,Math.round(point.x||0)), y=Math.max(0,Math.round(point.y||0));
    if(window.__TAURI__?.menu?.Menu){
      const api=window.__TAURI__;
      try {
        const native=await api.menu.Menu.new({items});
        lastMenus.push(native);
        if(lastMenus.length>6)lastMenus.shift();
        await native.popup(new api.dpi.LogicalPosition(x,y));
        return true;
      }catch(error){
        console.warn('Native menu unavailable:',error);
        window.minternetToast?.('Native menu unavailable; using compact menu.');
      }
    }
    closeFallback();
    const host=document.createElement('div');host.className='system-popup-root';
    const contents=domMenu(items);host.append(contents);
    document.body.append(host);fallback=host;
    const rect=host.getBoundingClientRect();
    host.style.left=Math.max(2,Math.min(x,innerWidth-rect.width-3))+'px';
    host.style.top=Math.max(3,Math.min(y,innerHeight-rect.height-4))+'px';
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',esc,true);
    return true;
  }
  function fromElement(button){
    const bounds=button.getBoundingClientRect();
    return {x:bounds.left,y:bounds.bottom};
  }
  const handlers={
    folder:(id,button)=>popup(folderItems(id),fromElement(button)),
    bookmark:(id,event)=>popup(barMenu(id),{x:event.clientX,y:event.clientY}),
    bar:event=>popup(barMenu(),{x:event.clientX,y:event.clientY}),
    groups:point=>popup(groupsMenu(),point),
    group:(id,point)=>popup(groupDetail(id),point),
    tab:(id,point)=>popup(tabMenu(id),point)
  };
  window.minternetMenus=handlers;
  const bar=$('bookmarkBar');
  // Capturing phase ensures right-click on a folder receives the browser-style
  // context menu instead of immediately opening the old edit form.
  bar?.addEventListener('contextmenu',event=>{
    event.preventDefault();
    event.stopImmediatePropagation();
    const button=event.target.closest('.bookmark-item');
    const id=button?.dataset.bookmarkId;
    if(id&&window.MinternetBookmarks.find(state(),id)?.kind==='folder')handlers.bookmark(id,event);
    else handlers.bar(event);
  },true);
})();
