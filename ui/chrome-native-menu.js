'use strict';
// Browser-style native context menus. On Windows this is an OS-owned popup:
// it is anchored precisely to the clicked folder, keeps the page WebView2
// visible, follows system DPI and automatically cascades on submenu hover.
(() => {
  const $=id=>document.getElementById(id);
  let lastMenus=[];
  let nativePopupCount=0;
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
        items.push(sub(iconText(child)+'  '+label(child),depth<11?folderItems(child.id,depth+1):[disabled('Maximum folder depth')]));
      }else if(child.kind==='link'){
        items.push(item(iconText(child)+'  '+label(child),()=>b.openLink(child.url)));
      }
    }
    if(folder.children.length>120)items.push(item('More…',()=>b.manager()));
    if(items.length===0)items.push(disabled('Empty Folder'));
    items.push(sep());
    items.push(item('＋  New Subfolder…',()=>b.newFolder(id)));
    items.push(item('✎  Folder Properties…',()=>b.edit(id)));
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
  function tabIdsInVisualOrder(){
    const visible=[...document.querySelectorAll('#tabs .tab[data-tab-id]')]
      .map(el=>Number(el.dataset.tabId)).filter(Number.isSafeInteger);
    const remaining=groups()?.getLatest().tabs.map(t=>t.id).filter(id=>!visible.includes(id))||[];
    return [...visible,...remaining];
  }
  function closeRelative(tabId,scope){
    const ids=tabIdsInVisualOrder(),index=ids.indexOf(tabId);
    if(index<0)return;
    const selected=scope==='left'?ids.slice(0,index):
      scope==='right'?ids.slice(index+1):ids.filter(id=>id!==tabId);
    if(selected.length)void window.minternet?.command('close-many',selected);
  }
  function tabMenu(tabId){
    const g=groups(), b=ctrl();
    if(!g)return [disabled('Unavailable')];
    const tab=g.getLatest().tabs.find(t=>t.id===tabId);
    if(!tab)return [disabled('Tab no longer exists')];
    const belonging=window.MinternetGroupModel.findTab(g.getState(),tabId);
    const assignOptions=[item('＋  New Group With Tab…',()=>g.openEditor(null,tabId))];
    for(const group of g.getState().groups)
      assignOptions.push(item((belonging?.id===group.id?'✓  ':'●  ')+g.displayName(group),()=>g.assign(tabId,group.id)));
    return [
      item('＋  New Group With This Tab',()=>g.openEditor(null,tabId)),
      sub('▣  Move To Group',assignOptions.slice(1)),
      ...(belonging?[item('↙  Remove From '+g.displayName(belonging),()=>g.ungroup(tabId))]:[]),
      ...(tab.url?.startsWith('https://')?[item('☆  Bookmark Page',()=>window.minternet?.command('activate',tabId).then(()=>b?.toggleBookmark()))]:[]),
      sub('▣  Split View',[
        item('Snap This Tab Into Split',()=>window.minternet?.command('split-add',tabId)),
        item('Return This Tab To Single View',()=>window.minternet?.command('split-remove',tabId)),
        item('Exit Split View',()=>window.minternet?.command('split-clear'))
      ]),
      sep(),
      sub('×  Close…',[
        item('Close Tab',()=>window.minternet?.command('close',tabId)),
        item('All To Left',()=>closeRelative(tabId,'left')),
        item('All To Right',()=>closeRelative(tabId,'right')),
        item('All Others',()=>closeRelative(tabId,'others'))
      ])
    ];
  }
  const quickIcons={
    reload:'<path d="M20 11a8 8 0 1 0-2.5 6"/><path d="M20 4v7h-7"/>',
    unload:'<path d="M5 8V5h14v3M4 12h16M8 16h8M10 19h4"/>',
    duplicate:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    pin:'<path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6"/>'
  };
  function tabQuickActions(id){
    const tab=groups()?.getLatest().tabs.find(t=>t.id===id);
    if(!tab)return null;
    return [
      {title:'Reload Tab',glyph:'reload',action:()=>window.minternet?.command('reload-tab',id)},
      {title:'Unload Tab',glyph:'unload',action:()=>window.minternet?.command('unload-tab',id)},
      {title:'Duplicate Tab',glyph:'duplicate',action:()=>window.minternet?.command('duplicate',id)},
      {title:tab.pinned?'Unpin Tab':'Pin Tab',glyph:'pin',action:()=>groups()?.pin(id,!tab.pinned)}
    ];
  }
  function barMenu(folderId=null){
    const b=ctrl();
    const menus=[
      sub('▣  Tab Groups',barGroupItems()),
      sep(),
      item('📁  New Folder…',()=>b?.newFolder(folderId)),
      ...(!folderId?[item('☆  Bookmark This Page',()=>b?.toggleBookmark())]:[]),
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
  let fallback=null,customOpen=false;
  function closeFallback(){
    fallback?.remove();fallback=null;
    document.removeEventListener('pointerdown',outside,true);
    document.removeEventListener('keydown',esc,true);
    if(customOpen){
      customOpen=false;
      if(window.__TAURI__)void window.minternet?.command('chrome-overlay',false);
    }
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
  async function popup(items,point,options={}){
    const x=Math.max(0,Math.round(point.x||0)), y=Math.max(0,Math.round(point.y||0));
    if(!options.custom&&window.__TAURI__?.menu?.Menu){
      const api=window.__TAURI__;
      try {
        const native=await api.menu.Menu.new({items});
        lastMenus.push(native);
        if(lastMenus.length>6)lastMenus.shift();
        await native.popup(new api.dpi.LogicalPosition(x,y));
        nativePopupCount++;
        return true;
      }catch(error){
        console.warn('Native menu unavailable:',error);
        window.minternetToast?.('Native menu unavailable; using compact menu.');
      }
    }
    closeFallback();
    const host=document.createElement('div');
    host.className='system-popup-root'+(options.custom?' minternet-context-menu':'')+(options.compactTab?' compact-tab-menu':'');
    if(options.custom){
      const header=document.createElement('div');
      header.className='minternet-context-heading';
      header.textContent=options.heading||'MINTERNET';
      host.append(header);
      customOpen=true;
      if(window.__TAURI__)void window.minternet?.command('chrome-overlay',true);
    }
    if(options.quickActions){
      const toolbar=document.createElement('div');toolbar.className='tab-context-quick';
      for(const action of options.quickActions){
        const button=document.createElement('button');button.type='button';
        button.className='tab-context-quick-icon';
        button.title=action.title;button.setAttribute('aria-label',action.title);
        button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">'+quickIcons[action.glyph]+'</svg>';
        button.addEventListener('click',()=>{closeFallback();action.action();});
        toolbar.append(button);
      }
      host.append(toolbar);
    }
    const contents=domMenu(items);host.append(contents);
    document.body.append(host);fallback=host;
    const rect=host.getBoundingClientRect();
    host.style.left=Math.max(2,Math.min(x,innerWidth-rect.width-3))+'px';
    host.style.top=Math.max(3,Math.min(y,innerHeight-rect.height-4))+'px';
    if(x+rect.width*2>innerWidth)host.classList.add('flip-left');
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',esc,true);
    return true;
  }
  // Minimal inline group inspector. All controls update the live group state.
  function groupInspector(id,point){
    const group=groups()?.get(id);
    if(!group)return;
    closeFallback();
    const host=document.createElement('div');
    host.className='system-popup-root minternet-context-menu group-inspector';
    host.setAttribute('role','dialog');
    host.setAttribute('aria-label','Group options');
    const head=document.createElement('div');
    head.className='group-inspector-top';
    const name=document.createElement('input');
    name.className='group-inspector-name';
    name.value=group.name;name.maxLength=42;name.title='Rename group';
    name.setAttribute('aria-label','Group name');
    name.addEventListener('change',()=>groups()?.updateGroup(id,{name:name.value.trim()}));
    name.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();groups()?.updateGroup(id,{name:name.value.trim()});closeFallback();}});
    const eye=document.createElement('button');
    eye.className='group-inspector-icon';
    eye.setAttribute('aria-label','Toggle group visibility');
    const syncEye=()=>{eye.innerHTML=group.visible?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.5 6.1A11 11 0 0 1 12 6c6.5 0 10 6 10 6a15 15 0 0 1-3.5 4"/><path d="M6.5 7.3C3.5 9.1 2 12 2 12s3.5 6 10 6a10 10 0 0 0 3.1-.5"/></svg>';eye.title=group.visible?'Hide From Tab Bar':'Show In Tab Bar';eye.setAttribute('aria-pressed',String(group.visible));};
    syncEye();
    eye.addEventListener('click',()=>{groups()?.toggleVisible(id);syncEye();});
    const del=document.createElement('button');del.className='group-inspector-icon delete';
    del.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>';del.title='Delete Group';del.setAttribute('aria-label','Delete group');
    del.addEventListener('click',()=>{if(groups()?.removeGroup(id))closeFallback();});
    head.append(name,eye,del);host.append(head);
    const choices=document.createElement('div');choices.className='group-inspector-palette';
    const presets=[['red','#ea5967'],['orange','#f39b52'],['yellow','#f1ce59'],['green','#65c98a'],['blue','#6b9ff0'],['purple','#ad8df6'],['pink','#e889c9'],['white','#f2f0f8'],['black','#202235']];
    const huePanel=document.createElement('div');huePanel.className='group-inspector-sliders';huePanel.hidden=true;
    const rgbToHsv=(hex)=>{
      const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);
      const max=Math.max(...c),min=Math.min(...c),delta=max-min;
      let h=0;if(delta){if(max===c[0])h=((c[1]-c[2])/delta)%6;else if(max===c[1])h=(c[2]-c[0])/delta+2;else h=(c[0]-c[1])/delta+4;}
      return [Math.round((h*60+360)%360),Math.round(max?delta/max*100:0),Math.round(max*100)];
    };
    const hsvToHex=(h,s,v)=>{
      s/=100;v/=100;const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;
      const rgb=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
      return '#'+rgb.map(n=>Math.round((n+m)*255).toString(16).padStart(2,'0')).join('');
    };
    const initial=groups()?.groupColor(group)||'#ad8df6';
    const channels=rgbToHsv(initial);
    const sliders=[];
    for(const [i,title,max] of [['0','Hue',360],['1','Saturation',100],['2','Brightness',100]]){
      const index=Number(i),line=document.createElement('label');line.className='group-inspector-slider';
      const caption=document.createElement('span');caption.textContent=title;
      const range=document.createElement('input');range.type='range';range.min='0';range.max=String(max);range.value=String(channels[index]);range.setAttribute('aria-label',title);
      line.append(caption,range);huePanel.append(line);sliders.push(range);
      range.addEventListener('pointerdown',()=>groups()?.beginColorUndo());
      range.addEventListener('pointerup',()=>groups()?.endColorUndo());
      range.addEventListener('pointercancel',()=>groups()?.endColorUndo());
      range.addEventListener('input',()=>{
        const hex=hsvToHex(...sliders.map(x=>Number(x.value)));
        groups()?.updateGroup(id,{color:hex});refreshSelected();
      });
    }
    function refreshSelected(){
      for(const button of choices.children){
        const key=button.dataset.color;
        button.setAttribute('aria-pressed',String(key==='custom'?/^#/.test(group.color):group.color===key));
      }
    }
    for(const [key,hex] of presets){
      const button=document.createElement('button');button.type='button';button.className='group-inspector-swatch';
      button.style.background=hex;button.dataset.color=key;button.title=key;button.setAttribute('aria-label',key+' group color');
      button.addEventListener('click',()=>{groups()?.updateGroup(id,{color:key});huePanel.hidden=true;refreshSelected();});
      choices.append(button);
    }
    const custom=document.createElement('button');custom.type='button';custom.className='group-inspector-swatch group-inspector-custom';
    custom.dataset.color='custom';custom.title='Custom Color';custom.setAttribute('aria-label','Custom color sliders');
    custom.addEventListener('click',()=>{
      huePanel.hidden=!huePanel.hidden;
      const values=rgbToHsv(groups()?.groupColor(group)||initial);
      sliders.forEach((slider,i)=>slider.value=String(values[i]));
      reposition();
    });choices.append(custom);
    host.append(choices,huePanel);refreshSelected();
    document.body.append(host);fallback=host;
    customOpen=true;
    if(window.__TAURI__)void window.minternet?.command('chrome-overlay',true);
    function reposition(){
      const rect=host.getBoundingClientRect();
      host.style.left=Math.max(3,Math.min(point.x||0,innerWidth-rect.width-3))+'px';
      host.style.top=Math.max(3,Math.min(point.y||0,innerHeight-rect.height-3))+'px';
    }
    reposition();
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',esc,true);
  }
  function groupsOverview(point){
    closeFallback();
    const host=document.createElement('div');
    host.className='system-popup-root minternet-context-menu group-overview';
    const heading=document.createElement('div');heading.className='minternet-context-heading';
    heading.textContent='TAB GROUPS';host.append(heading);
    for(const group of groups()?.getState().groups||[]){
      const row=document.createElement('div');row.className='group-overview-row';
      const name=document.createElement('button');name.className='group-overview-name';
      const dot=document.createElement('span');dot.className='group-overview-dot';
      dot.style.background=groups().groupColor(group);
      name.append(dot,document.createTextNode(groups().displayName(group)));
      name.title='Edit group';
      name.addEventListener('click',()=>groupInspector(group.id,point));
      const eye=document.createElement('button');eye.className='group-inspector-icon';
      eye.setAttribute('aria-label','Toggle visibility for '+groups().displayName(group));
      const sync=()=>{eye.innerHTML=group.visible?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.5 6.1A11 11 0 0 1 12 6c6.5 0 10 6 10 6a15 15 0 0 1-3.5 4"/></svg>';eye.setAttribute('aria-pressed',String(group.visible));eye.title=group.visible?'Hide From Tab Bar':'Show In Tab Bar';};
      sync();eye.addEventListener('click',()=>{groups().toggleVisible(group.id);sync();});
      row.append(name,eye);host.append(row);
    }
    const create=document.createElement('button');create.className='system-popup-row group-overview-create';
    create.textContent='＋  New Tab Group';
    create.addEventListener('click',()=>{closeFallback();groups()?.openEditor(null,true);});
    host.append(create);
    document.body.append(host);fallback=host;customOpen=true;
    if(window.__TAURI__)void window.minternet?.command('chrome-overlay',true);
    const rect=host.getBoundingClientRect();
    host.style.left=Math.max(3,Math.min(point.x||0,innerWidth-rect.width-3))+'px';
    host.style.top=Math.max(3,Math.min(point.y||0,innerHeight-rect.height-3))+'px';
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',esc,true);
  }
  function fromElement(button){
    const bounds=button.getBoundingClientRect();
    return {x:bounds.left,y:bounds.bottom};
  }
  const handlers={
    folder:(id,button)=>popup(folderItems(id),fromElement(button),window.__minternetMenuSmoke?{}:{custom:true,heading:'FOLDER'}),
    bookmark:(id,event)=>popup(barMenu(id),{x:event.clientX,y:event.clientY},{custom:true,heading:'BOOKMARK FOLDER'}),
    bar:event=>popup(barMenu(),{x:event.clientX,y:event.clientY},{custom:true,heading:'BOOKMARKS'}),
    groups:point=>groupsOverview(point),
    group:(id,point)=>groupInspector(id,point),
    tab:(id,point)=>{
      // Blank bar space must not accidentally act on the currently active tab.
      if(id==null)return popup([
        item('＋  New Group',()=>groups()?.openEditor(null,false)),
        item('＋  New Tab',()=>window.minternet?.command('new')),
        sub('▣  Tab Groups',barGroupItems())
      ],point,{custom:true,compactTab:true,heading:'TAB BAR'});
      const chosen=id;
      if(!groups()?.getLatest().tabs.some(tab=>tab.id===chosen))
        return popup([disabled('Tab no longer exists')],point,{custom:true,compactTab:true,heading:'TAB'});
      return popup(tabMenu(chosen),point,{custom:true,compactTab:true,heading:'TAB',quickActions:tabQuickActions(chosen)});
    },
    inspectTab:id=>tabMenu(id),
    inspectTabQuick:id=>tabQuickActions(id),
    inspectBar:()=>barMenu(),
    inspectFolder:id=>folderItems(id),
    nativePopupCount:()=>nativePopupCount
  };
  window.minternetMenus=handlers;
  $('tabs')?.addEventListener('contextmenu',event=>{
    if(event.defaultPrevented)return;
    event.preventDefault();
    handlers.tab(null,{x:event.clientX,y:event.clientY});
  });
  // The blank portion of the title/tab bar is another tab-bar target.
  // Never hijack native window buttons, the group button, or individual tabs.
  document.querySelector?.('.tab-row')?.addEventListener('contextmenu',event=>{
    if(event.defaultPrevented || event.target.closest('button,.group-chip,.tab,[role="tab"]'))return;
    event.preventDefault();
    handlers.tab(null,{x:event.clientX,y:event.clientY});
  });
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
