'use strict';
(() => {
  const model=window.MinternetGroupModel, api=window.minternet;
  if (!model || !api) return;
  const $=id=>document.getElementById(id);
  const KEY='minternet.tab-groups.v1';
  let state;
  try { state=model.hydrate(localStorage.getItem(KEY)); } catch {state=model.blank();}
  let latest={tabs:[],activeId:null};
  let lastRenderKey='', editing=null, assignTarget=null, fallbackPending=false;
  let draggingTabId=null;
  let gesture=null, ghost=null, splitPreview=null, dragOverlay=false, suppressedClick=null;
  const ungroupTarget=$('tabUngroupDrop');
  const tabStrip=$('tabs');
  const groupUndoJson=()=>JSON.stringify({
    groups:state.groups,assignments:state.assignments,order:state.order
  });
  let lastGroupUndoJson=groupUndoJson();
  let colorUndoActive=false,colorUndoRecorded=false;
  function beginColorUndo(){colorUndoActive=true;colorUndoRecorded=false;}
  function endColorUndo(){colorUndoActive=false;colorUndoRecorded=false;}
  function restoreUndoGroup(previous){
    try {
      if(typeof previous!=='string'||previous.length>120000)return false;
      const raw=JSON.parse(previous);
      const hydrated=model.hydrate({groups:raw.groups});
      const allowed=new Set(hydrated.groups.map(g=>g.id));
      const ids=new Set(latest.tabs.map(t=>t.id));
      const assignments=Object.create(null);
      for(const [rawId,gid] of Object.entries(raw.assignments||{})){
        const id=Number(rawId);
        if(ids.has(id)&&allowed.has(gid))assignments[String(id)]=gid;
      }
      state.groups=hydrated.groups;
      state.assignments=assignments;
      state.order=Array.isArray(raw.order)?raw.order.filter(id=>ids.has(id)):[];
      model.prune(state,latest.tabs.map(tab=>tab.id));
      persist(true);
      return true;
    }catch{return false;}
  }
  const palette={
    red:'#ea5967',orange:'#f39b52',yellow:'#f1ce59',green:'#65c98a',blue:'#6b9ff0',purple:'#ad8df6',pink:'#e889c9',white:'#f2f0f8',black:'#202235',violet:'#ad9cf9',teal:'#69d4c9',amber:'#e8c16d',slate:'#a1adbf'
  };
  function persist(skipUndo=false) {
    const current=groupUndoJson();
    if(!skipUndo&&current!==lastGroupUndoJson&&(!colorUndoActive||!colorUndoRecorded)){
      if(window.__TAURI__)void api.command('undo-ui-checkpoint',{kind:'groups',before:lastGroupUndoJson});
      if(colorUndoActive)colorUndoRecorded=true;
    }
    lastGroupUndoJson=current;
    try {const stored=JSON.parse(model.serialize(state));stored.slots=latest.tabs.filter(t=>!t.private).map(t=>state.assignments[String(t.id)]||null);stored.visualOrder=state.order.map(id=>latest.tabs.filter(t=>!t.private).findIndex(t=>t.id===id)).filter(i=>i>=0);localStorage.setItem(KEY,JSON.stringify(stored));}
    catch { window.minternetToast?.('Cannot save tab groups locally.');}
    repaint();
    if(!skipUndo)window.dispatchEvent(new CustomEvent('minternet:local-change',{detail:{kind:'group'}}));
  }
  function displayName(g) {return g.name || 'Unnamed Group';}
  function groupColor(g) {return palette[g.color]||(/^#[0-9a-f]{6}$/i.test(g.color)?g.color:palette.purple);}
  function eligibleFallback() {
    const t=latest.tabs.find(x=>x.id===latest.activeId);
    if(!t||model.isVisibleTab(state,t.id))return;
    if(fallbackPending)return;
    fallbackPending=true;
    const replacement=model.visibleFallback(state,latest.tabs,t.id);
    const call=replacement?api.command('activate',replacement):api.command('deselect');
    Promise.resolve(call).finally(()=>{fallbackPending=false;});
  }
  function repaint() {
    lastRenderKey='';
    eligibleFallback();
    if (typeof window.minternetRenderTabs==='function') window.minternetRenderTabs();
  }
  function createGroup(name='New Group',color='purple',tabId=null) {
    const group=model.create(state,{name,color});
    if(!group) {window.minternetToast?.('Too many tab groups.');return null;}
    if(tabId!=null)assign(tabId,group.id);
    persist();
    return group;
  }
  function updateGroup(id,attrs) {
    if(!model.update(state,id,attrs))return false;
    persist();
    return true;
  }
  function toggleVisible(id) {
    const group=model.get(state,id);
    if(!group)return false;
    return updateGroup(id,{visible:!group.visible});
  }
  function toggleCollapsed(id) {
    const group=model.get(state,id);
    if(!group)return false;
    return updateGroup(id,{collapsed:!group.collapsed,visible:true});
  }
  function assign(tabId,groupId) {
    const tab=latest.tabs.find(t=>t.id===tabId);
    if(tab?.pinned&&groupId) {
      // Native state confirmation must arrive BEFORE the group assignment,
      // otherwise a re-render sees pinned=true and detaches it immediately.
      void api.command('unpin',tabId).then(result=>{
        if(result?.message){window.minternetToast?.(result.message);return;}
        model.assign(state,tabId,groupId);
        const group=model.get(state,groupId);
        if(group){group.visible=true;group.collapsed=false;}
        persist();
      });
      return true;
    }
    if(!model.assign(state,tabId,groupId))return false;
    if(groupId){
      const g=model.get(state,groupId);
      if(g){g.visible=true;g.collapsed=false;}
    }
    persist();
    return true;
  }
  function ungroup(tabId){return assign(tabId,null);}
  async function pin(tabId,willPin=true) {
    const tab=latest.tabs.find(t=>t.id===tabId);
    if(!tab)return false;
    if(tab.secretTab){
      window.minternetToast?.('Secret Tabs cannot be pinned outside the encrypted vault.');
      return false;
    }
    if(tab.pinned===willPin)return true;
    // The native operation must succeed BEFORE group membership changes.
    // Otherwise a failed pin permanently strips a tab out of its group.
    const response=await api.command(willPin?'pin':'unpin',tabId);
    if(response?.message||response?.ok!==true){
      window.minternetToast?.(response?.message||'Could not change tab pin.');
      return false;
    }
    // Preserve the live WebView; move its favicon-only pinned tab left of all groups.
    if(willPin)model.assign(state,tabId,null);
    persist();
    return true;
  }
  function currentDraggedTab(){
    return Number.isSafeInteger(draggingTabId)&&latest.tabs.some(t=>t.id===draggingTabId)
      ?draggingTabId:null;
  }
  function clearDropState(){
    draggingTabId=null;
    ghost?.remove();
    ghost=null;
    splitPreview?.remove();
    splitPreview=null;
    if(dragOverlay){
      dragOverlay=false;
      if(window.__TAURI__)void api.command('chrome-overlay',false);
    }
    document.body.classList.remove('tab-dragging');
    tabStrip.classList.remove('drag-ungroup-over','drag-pin-over');
    ungroupTarget?.classList.remove('drag-target');
    document.querySelectorAll('.drag-target,.group-drop-target,.tab-drag-source,.drop-before,.drop-after')
      .forEach(node=>node.classList.remove('drag-target','group-drop-target','tab-drag-source','drop-before','drop-after'));
  }
  function dropIntoGroup(event,gid){
    const id=currentDraggedTab();
    if(id===null)return false;
    event.preventDefault();
    event.stopPropagation();
    const members=model.tabsIn(state,gid,latest.tabs).filter(tab=>tab.id!==id);
    const last=members[members.length-1];
    if(last)model.moveRelative(state,id,last.id,true);
    clearDropState();
    return assign(id,gid);
  }
  function dropNextTo(event,targetId,element) {
    const id=currentDraggedTab();
    if(id===null||id===targetId)return false;
    const target=latest.tabs.find(t=>t.id===targetId);
    if(!target)return false;
    event.preventDefault();
    event.stopPropagation();
    const after=event.clientX>=element.getBoundingClientRect().left+
      element.getBoundingClientRect().width/2;
    const targetGroup=model.findTab(state,targetId);
    const source=latest.tabs.find(t=>t.id===id);
    model.moveRelative(state,id,targetId,after);
    clearDropState();
    // Drag into pinned region pins; drag out into normal region unpins.
    if(target.pinned) {
      model.assign(state,id,null);
      if(!source?.pinned){void pin(id,true);}
      else persist();
      return true;
    }
    if(source?.pinned){void pin(id,false);}
    // Dropping into another group joins it; dropping beside an ordinary
    // tab removes grouping without losing the page or introducing a new tab.
    return assign(id,targetGroup?.id||null);
  }
  function dropOutsideGroup(event){
    const id=currentDraggedTab();
    if(id===null)return false;
    event.preventDefault();
    event.stopPropagation();
    const old=latest.tabs.find(t=>t.id===id);
    clearDropState();
    if(old?.pinned){void pin(id,false);}
    return ungroup(id);
  }
  function acceptDrag(event,element,marker){
    const id=currentDraggedTab();
    if(id===null)return false;
    event.preventDefault();
    event.stopPropagation();
    if(event.dataTransfer)event.dataTransfer.dropEffect='move';
    element.classList.add(marker);
    return true;
  }
  function removeGroup(id) {
    const group=model.get(state,id);
    if(!group)return false;
    if(!window.confirm('Delete '+displayName(group)+'? Its tabs will remain open.'))return false;
    if(!model.remove(state,id))return false;
    persist(); return true;
  }
  function buildChip(g,tabs) {
    const node=document.createElement('button');
    node.type='button';
    node.className='group-chip'+(g.collapsed?' group-collapsed':' group-expanded');
    node.style.setProperty('--group-accent',groupColor(g));
    node.dataset.groupId=g.id;
    node.setAttribute('aria-label',(g.collapsed?'Expand':'Collapse')+' Tab Group: '+displayName(g));
    node.setAttribute('aria-expanded',String(!g.collapsed));
    node.title=displayName(g)+' · '+tabs.length+' tabs · Click to '+(g.collapsed?'expand':'collapse');
    const name=document.createElement('span');name.className='group-chip-label';name.textContent=g.name;
    const count=document.createElement('span');count.className='group-chip-count';count.textContent=String(tabs.length);
    node.append(name,count);
    node.addEventListener('click',()=>toggleCollapsed(g.id));
    node.addEventListener('contextmenu',event=>{
      event.preventDefault();
      window.minternetMenus?.group(g.id,{x:event.clientX,y:event.clientY});
    });
    return node;
  }
  function renderTabs(data,host,buildTab) {
    let secretGroupId=null;
    try{secretGroupId=localStorage.getItem('minternet.secret-tabs-group-id.v1');}catch{}
    if(secretGroupId&&model.get(state,secretGroupId)){
      const previous=latest.tabs.some(t=>t.secretTab &&
        state.assignments[String(t.id)]===secretGroupId);
      const current=data.tabs.some(t=>t.secretTab &&
        state.assignments[String(t.id)]===secretGroupId);
      // An actual last-tab closure, not the temporary empty group created
      // while opening encrypted bookmarks. Other user groups are untouched.
      if(previous&&!current){
        model.remove(state,secretGroupId);
        try{localStorage.removeItem('minternet.secret-tabs-group-id.v1');}catch{}
      }
    }
    latest=data;
    if(state.restoredSlots&&data.tabs.length){
      // Native session restores in the saved tab order; never reuse old tab IDs.
      data.tabs.filter(tab=>!tab.private).forEach((tab,index)=>{if(!tab.pinned&&model.get(state,state.restoredSlots[index]))model.assign(state,tab.id,state.restoredSlots[index]);});
      state.restoredSlots=null;
    }
    // Ctrl-click background pages carry the actual source tab ID. Insert
    // directly next to it in the *visual* order even after user drag-reordering,
    // and inherit the source group so a group cannot separate the two tabs.
    for(const tab of data.tabs){
      if(state.order.includes(tab.id) || !Number.isSafeInteger(tab.openerId))continue;
      if(!model.insertAfter(state,tab.id,tab.openerId))continue;
      const parentGroup=model.findTab(state,tab.openerId);
      if(parentGroup && !tab.pinned){
        model.assign(state,tab.id,parentGroup.id);
        parentGroup.visible=true;
        parentGroup.collapsed=false;
      }
    }
    model.prune(state,data.tabs.map(t=>t.id));
    if(state.restoredOrder){
      const native=data.tabs.filter(t=>!t.private);
      state.order=[...new Set([...state.restoredOrder.map(i=>native[i]?.id).filter(Boolean),...data.tabs.map(t=>t.id)])];
      state.restoredOrder=null;
    }
    eligibleFallback();
    const signature=JSON.stringify([
      data.activeId,
      data.tabs.map(t=>[t.id,t.title,t.url,t.private,t.pinned,t.loading,t.suspended,t.audioPlaying,t.audioMuted]),
      state.order,
      state.groups.map(g=>[g.id,g.name,g.color,g.visible,g.collapsed]),
      Object.entries(state.assignments).sort()
    ]);
    if(lastRenderKey===signature)return;
    lastRenderKey=signature;
    // Save the current slot order so group membership survives native restarts.
    try {const stored=JSON.parse(model.serialize(state));stored.slots=data.tabs.filter(t=>!t.private).map(t=>state.assignments[String(t.id)]||null);stored.visualOrder=state.order.map(id=>data.tabs.filter(t=>!t.private).findIndex(t=>t.id===id)).filter(i=>i>=0);localStorage.setItem(KEY,JSON.stringify(stored));}catch{}
    const items=[];
    // Chrome/Firefox-style pinned tabs precede groups and show no close X.
    for(const tab of model.sortedTabs(state,data.tabs).filter(t=>t.pinned)){
      if(model.findTab(state,tab.id))model.assign(state,tab.id,null);
      const item=buildTab(tab,tab.id===data.activeId);
      item.dataset.tabId=String(tab.id);
      attachTabMenu(item,tab.id);
      items.push(item);
    }
    for(const g of state.groups){
      if(!g.visible)continue;
      const members=model.tabsIn(state,g.id,data.tabs).filter(t=>!t.pinned);
      items.push(buildChip(g,members));
      if(!g.collapsed){
        for(const tab of members){
          const item=buildTab(tab,tab.id===data.activeId);
          item.dataset.tabId=String(tab.id);
          item.classList.add('group-member');
          item.style.setProperty('--group-accent',groupColor(g));
          attachTabMenu(item,tab.id);
          items.push(item);
        }
        // A visible end-cap continues the group's tinted background beyond
        // its final tab. It is decorative only and never affects tab actions.
        if(members.length){
          const end=document.createElement('span');
          end.className='group-end-cap';
          end.style.setProperty('--group-accent',groupColor(g));
          end.setAttribute('aria-hidden','true');
          items.push(end);
        }
      }
    }
    for(const tab of model.sortedTabs(state,data.tabs)){
      if(tab.pinned||model.findTab(state,tab.id))continue;
      const item=buildTab(tab,tab.id===data.activeId);
      item.dataset.tabId=String(tab.id);
      attachTabMenu(item,tab.id);
      items.push(item);
    }
    host.replaceChildren(...items);
    // Native tab restoration/closing may prune stale group memberships;
    // synchronize the baseline without recording a phantom user action.
    lastGroupUndoJson=groupUndoJson();
  }
  function attachTabMenu(element,tabId){
    // HTML5 drag/drop on Windows WebView2 shows a forbidden cursor because the
    // system expects an external file/data destination. The browser's own
    // tabs instead use capture-based pointer tracking, just like native tabs.
    element.draggable=false;
    element.addEventListener('dragstart',event=>event.preventDefault());
    element.addEventListener('click',event=>{
      if(suppressedClick?.id===tabId && performance.now()<suppressedClick.until){
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressedClick=null;
      }
    },true);
    // Keep Close hidden until the pointer approaches the tab or its right edge.
    element.addEventListener('pointermove',event=>{
      const rect=element.getBoundingClientRect();
      element.classList.toggle('tab-close-near',event.clientX>=rect.right-20);
    });
    element.addEventListener('pointerleave',()=>element.classList.remove('tab-close-near'));
    element.addEventListener('contextmenu',event=>{
      event.preventDefault();
      window.minternetMenus?.tab(tabId,{x:event.clientX,y:event.clientY});
    });
  }
  function beginPointer(event){
    if(event.button!==0||event.isPrimary===false||gesture)return;
    if(event.target.closest('.tab-close,.tab-audio'))return;
    const tab=event.target.closest('.tab[data-tab-id]');
    const id=Number(tab?.dataset.tabId);
    if(!tab||!Number.isSafeInteger(id)||!latest.tabs.some(t=>t.id===id))return;
    gesture={id,pointerId:event.pointerId,x:event.clientX,y:event.clientY,
      started:performance.now(),active:false};
  }
  function createGhost(tabId){
    const tab=latest.tabs.find(t=>t.id===tabId);
    ghost=document.createElement('div');
    ghost.className='tab-drag-ghost';
    ghost.setAttribute('aria-hidden','true');
    ghost.textContent='◉  '+(tab?.title||'New Tab');
    document.body.append(ghost);
  }
  function updateHover(x,y){
    tabStrip.querySelectorAll('.drag-target,.group-drop-target,.drop-before,.drop-after')
      .forEach(node=>node.classList.remove('drag-target','group-drop-target','drop-before','drop-after'));
    tabStrip.classList.remove('drag-ungroup-over','drag-pin-over');
    ungroupTarget?.classList.remove('drag-target');
    const hit=document.elementFromPoint(x,y);
    const chip=hit?.closest('.group-chip[data-group-id]');
    if(chip){chip.classList.add('drag-target');return;}
    const tab=hit?.closest('.tab[data-tab-id]');
    if(tab){
      const dest=Number(tab.dataset.tabId);
      if(dest===draggingTabId)return;
      tab.classList.add('group-drop-target');
      const rect=tab.getBoundingClientRect();
      tab.classList.add(x>=rect.left+rect.width/2?'drop-after':'drop-before');
      return;
    }
    if(hit?.closest('#tabUngroupDrop'))ungroupTarget?.classList.add('drag-target');
    else if(hit?.closest('#tabs')){
      const rect=tabStrip.getBoundingClientRect();
      const source=latest.tabs.find(t=>t.id===draggingTabId);
      // Dropping on the leftmost edge pins even when no tab is pinned yet.
      if(source&&!source.pinned&&x<=rect.left+24)tabStrip.classList.add('drag-pin-over');
      else tabStrip.classList.add('drag-ungroup-over');
    }
  }
  function movePointer(event){
    if(!gesture||event.pointerId!==gesture.pointerId)return;
    if(!gesture.active){
      const distance=Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y);
      // Prevent accidental reorder while moving to open a tab's context menu.
      // A deliberate >20px drag still begins immediately.
      if(distance<12||(distance<20&&performance.now()-gesture.started<125))return;
      gesture.active=true;
      draggingTabId=gesture.id;
      createGhost(gesture.id);
      if(window.__TAURI__){
        dragOverlay=true;
        void api.command('chrome-overlay',true);
      }
      document.body.classList.add('tab-dragging');
      tabStrip.querySelectorAll('.tab[data-tab-id]').forEach(el=>{
        el.classList.toggle('tab-drag-source',Number(el.dataset.tabId)===draggingTabId);
      });
      try {tabStrip.setPointerCapture(event.pointerId);}catch{}
    }
    event.preventDefault();
    if(ghost){
      ghost.style.left=Math.round(event.clientX+11)+'px';ghost.style.top=Math.round(event.clientY+9)+'px';
      const beyondChrome=event.clientY>document.querySelector('.chrome').getBoundingClientRect().bottom+6;
      ghost.classList.toggle('split-drag-preview',beyondChrome);
      if(beyondChrome){
        ghost.textContent='◫  Snap into Split View';
        if(!splitPreview){
          splitPreview=document.createElement('div');
          splitPreview.className='split-drag-zones';
          splitPreview.setAttribute('aria-hidden','true');
          for(let i=0;i<4;i++){
            const zone=document.createElement('div');zone.className='split-drag-zone';
            splitPreview.append(zone);
          }
          document.body.append(splitPreview);
        }
        const top=document.querySelector('.chrome').getBoundingClientRect().bottom;
        splitPreview.style.top=Math.round(top)+'px';
        const cell=(event.clientY-top)<(innerHeight-top)/2?0:2;
        const index=cell+(event.clientX<innerWidth/2?0:1);
        [...splitPreview.children].forEach((zone,i)=>zone.classList.toggle('active',i===index));
      }else{
        splitPreview?.remove();splitPreview=null;
      }
    }
    updateHover(event.clientX,event.clientY);
  }
  function finishPointer(event){
    if(!gesture||event.pointerId!==gesture.pointerId)return;
    const finished=gesture;
    gesture=null;
    if(!finished.active)return;
    event.preventDefault();
    suppressedClick={id:finished.id,until:performance.now()+350};
    const hit=document.elementFromPoint(event.clientX,event.clientY);
    const chip=hit?.closest('.group-chip[data-group-id]');
    const tab=hit?.closest('.tab[data-tab-id]');
    const groupId=chip?.dataset.groupId;
    if(event.clientY>document.querySelector('.chrome').getBoundingClientRect().bottom+6){
      const top=document.querySelector('.chrome').getBoundingClientRect().bottom;
      const x=Math.max(0,Math.min(1,event.clientX/Math.max(innerWidth,1)));
      const y=Math.max(0,Math.min(1,(event.clientY-top)/Math.max(innerHeight-top,1)));
      void api.command('split-add',{id:finished.id,x,y});
    }else if(groupId)dropIntoGroup(event,groupId);
    else if(tab&&Number(tab.dataset.tabId)!==finished.id)
      dropNextTo(event,Number(tab.dataset.tabId),tab);
    else if(hit?.closest('#tabs')){
      const rect=tabStrip.getBoundingClientRect();
      const source=latest.tabs.find(t=>t.id===finished.id);
      if(source&&!source.pinned&&event.clientX<=rect.left+24){
        event.preventDefault();event.stopPropagation();
        void pin(finished.id,true);
      }else dropOutsideGroup(event);
    }else if(hit?.closest('#tabUngroupDrop'))dropOutsideGroup(event);
    try {if(tabStrip.hasPointerCapture(event.pointerId))tabStrip.releasePointerCapture(event.pointerId);}catch{}
    clearDropState();
  }
  function cancelPointer(event){
    if(!gesture||(event.pointerId!=null&&gesture.pointerId!==event.pointerId))return;
    gesture=null;clearDropState();
  }
  tabStrip.addEventListener('pointerdown',beginPointer);
  // Capture does not depend on HTML DataTransfer and keeps tracking over the
  // group chip, ordinary tabs, blank strip or ungroup affordance.
  document.addEventListener('pointermove',movePointer,{capture:true,passive:false});
  document.addEventListener('pointerup',finishPointer,{capture:true,passive:false});
  document.addEventListener('pointercancel',cancelPointer,true);
  window.addEventListener('blur',()=>cancelPointer({}));
  function openEditor(groupId=null,withActive=false) {
    window.minternetBookmarks?.closeOverlay();
    const group=groupId?model.get(state,groupId):null;
    editing=group?.id??null;
    assignTarget=withActive === true ? latest.activeId
      : Number.isSafeInteger(withActive) ? withActive : null;
    $('groupEditorTitle').textContent=group?'Edit Tab Group':'New Tab Group';
    $('groupEditorName').value=group?.name??'';
    $('groupEditorColor').replaceChildren();
    for(const [key,hex] of Object.entries(palette).filter(([key])=>['red','orange','yellow','green','blue','purple','pink','white','black'].includes(key))){
      const circle=document.createElement('button');
      circle.type='button';circle.className='group-color-option';
      circle.style.backgroundColor=hex;
      circle.dataset.color=key;circle.title=key;
      circle.setAttribute('aria-label',key+' color');
      circle.setAttribute('aria-pressed',String((group?.color??'violet')===key));
      circle.addEventListener('click',()=>{
        for(const c of $('groupEditorColor').children)c.setAttribute('aria-pressed',String(c===circle));
      });
      $('groupEditorColor').append(circle);
    }
    $('groupEditorScreen').hidden=false;
    if(window.__TAURI__)void api.command('chrome-overlay',true);
    $('groupEditorName').focus();
    $('groupEditorName').select();
  }
  function closeEditor(){
    if($('groupEditorScreen').hidden)return;
    $('groupEditorScreen').hidden=true;
    if(window.__TAURI__)void api.command('chrome-overlay',false);
    $('tabGroups').focus();
  }
  $('groupEditorForm').addEventListener('submit',event=>{
    event.preventDefault();
    const name=$('groupEditorName').value.trim().slice(0,42);
    const selected=[...$('groupEditorColor').children].find(x=>x.getAttribute('aria-pressed')==='true');
    const color=selected?.dataset.color??'purple';
    if(editing)updateGroup(editing,{name,color});
    else createGroup(name||'New Group',color,assignTarget);
    closeEditor();
  });
  $('groupEditorCancel').addEventListener('click',closeEditor);
  $('groupEditorClose').addEventListener('click',closeEditor);
  $('groupEditorBackdrop').addEventListener('click',closeEditor);
  $('tabGroups').addEventListener('click',event=>window.minternetMenus?.groups({x:event.currentTarget.getBoundingClientRect().left,y:event.currentTarget.getBoundingClientRect().bottom}));
  $('tabGroups').addEventListener('contextmenu',event=>{event.preventDefault();window.minternetMenus?.groups({x:event.clientX,y:event.clientY});});
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('groupEditorScreen').hidden){event.preventDefault();closeEditor();}});
  window.minternetGroups={
    getState:()=>state, getLatest:()=>latest, get:model.get.bind(null,state),
    displayName, groupColor, createGroup, updateGroup, toggleVisible, toggleCollapsed,
    assign, ungroup, pin, removeGroup, openEditor, closeEditor, renderTabs, repaint,
    isVisibleTab:id=>model.isVisibleTab(state,id),
    restoreUndoGroup,beginColorUndo,endColorUndo,
    applySyncedGroups:(groups,tabs)=>{
      if(!Array.isArray(groups)||!Array.isArray(tabs))return false;
      const parsed=model.hydrate({groups});
      // Private/Tor groups and their memberships NEVER follow cloud updates.
      const protectedTabs=latest.tabs.filter(t=>t.private||t.tor||t.isTor);
      const protectedIds=new Set(protectedTabs.map(t=>state.assignments[String(t.id)]).filter(Boolean));
      const protectedGroups=state.groups.filter(g=>protectedIds.has(g.id));
      const preserved=Object.fromEntries(protectedTabs.map(tab=>[
        String(tab.id),state.assignments[String(tab.id)]||null
      ]).filter(([,group])=>group));
      state.groups=[...protectedGroups,...parsed.groups.filter(g=>!protectedIds.has(g.id))];
      state.assignments=Object.assign(Object.create(null),preserved);
      const available=latest.tabs.filter(t=>!t.private&&!t.tor&&!t.isTor);
      const used=new Set();
      for(const item of tabs){
        if(!item?.groupId)continue;
        const matching=available.find(tab=>
          (item.syncId&&tab.syncId===item.syncId || (!item.syncId&&tab.url===item.url)) &&
          !used.has(tab.id));
        if(matching&&model.get(state,item.groupId)){
          state.assignments[String(matching.id)]=item.groupId;
          used.add(matching.id);
        }
      }
      model.prune(state,latest.tabs.map(t=>t.id));
      persist(true);return true;
    }
  };
})();
