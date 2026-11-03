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
  let gesture=null, ghost=null, suppressedClick=null;
  const ungroupTarget=$('tabUngroupDrop');
  const tabStrip=$('tabs');
  const palette={
    violet:'#ad9cf9',blue:'#82aefa',teal:'#69d4c9',green:'#8bda9a',
    amber:'#e8c16d',orange:'#e7a16c',pink:'#e89acb',red:'#e18591',slate:'#a1adbf'
  };
  function persist() {
    try {localStorage.setItem(KEY,model.serialize(state));}
    catch { window.minternetToast?.('Cannot save tab groups locally.');}
    repaint();
  }
  function displayName(g) {return g.name || 'Unnamed Group';}
  function groupColor(g) {return palette[g.color]||palette.violet;}
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
  function createGroup(name='New Group',color='violet',tabId=null) {
    const group=model.create(state,{name,color});
    if(!group) {window.minternetToast?.('Too many tab groups.');return null;}
    if(tabId!=null) {
      // Pinned tabs cannot be children of groups. Unpin before grouping.
      const tab=latest.tabs.find(t=>t.id===tabId);
      if(tab?.pinned)void api.command('unpin',tabId);
      model.assign(state,tabId,group.id);
    }
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
    if(tab?.pinned&&groupId)void api.command('unpin',tabId);
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
    if(!latest.tabs.some(t=>t.id===tabId))return false;
    // Pinning detaches the page from its group; never close or reload it.
    if(willPin)model.assign(state,tabId,null);
    const response=await api.command(willPin?'pin':'unpin',tabId);
    if(response?.message){window.minternetToast?.(response.message);return false;}
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
    document.body.classList.remove('tab-dragging');
    tabStrip.classList.remove('drag-ungroup-over');
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
    model.moveRelative(state,id,targetId,after);
    clearDropState();
    // Dropping a tab beside an ordinary tab removes it from its group;
    // beside a grouped tab places it in that group at the chosen position.
    return assign(id,targetGroup?.id||null);
  }
  function dropOutsideGroup(event){
    const id=currentDraggedTab();
    if(id===null)return false;
    event.preventDefault();
    event.stopPropagation();
    clearDropState();
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
    node.className='group-chip';
    node.style.setProperty('--group-accent',groupColor(g));
    node.dataset.groupId=g.id;
    node.setAttribute('aria-label',(g.collapsed?'Expand':'Collapse')+' Tab Group: '+displayName(g));
    node.setAttribute('aria-expanded',String(!g.collapsed));
    node.title=displayName(g)+' · '+tabs.length+' tabs · Click to '+(g.collapsed?'expand':'collapse');
    const dot=document.createElement('span');
    dot.className='group-chip-symbol';dot.setAttribute('aria-hidden','true');dot.textContent='▣';
    const name=document.createElement('span');name.className='group-chip-label';name.textContent=g.name;
    const count=document.createElement('span');count.className='group-chip-count';count.textContent=String(tabs.length);
    node.append(dot,name,count);
    node.addEventListener('click',()=>toggleCollapsed(g.id));
    node.addEventListener('contextmenu',event=>{
      event.preventDefault();
      window.minternetMenus?.group(g.id,{x:event.clientX,y:event.clientY});
    });
    return node;
  }
  function renderTabs(data,host,buildTab) {
    latest=data;
    model.prune(state,data.tabs.map(t=>t.id));
    eligibleFallback();
    const signature=JSON.stringify([
      data.activeId,
      data.tabs.map(t=>[t.id,t.title,t.url,t.private,t.pinned,t.loading,t.suspended]),
      state.order,
      state.groups.map(g=>[g.id,g.name,g.color,g.visible,g.collapsed]),
      Object.entries(state.assignments).sort()
    ]);
    if(lastRenderKey===signature)return;
    lastRenderKey=signature;
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
    element.addEventListener('contextmenu',event=>{
      event.preventDefault();
      window.minternetMenus?.tab(tabId,{x:event.clientX,y:event.clientY});
    });
  }
  function beginPointer(event){
    if(event.button!==0||event.isPrimary===false||gesture)return;
    if(event.target.closest('.tab-close'))return;
    const tab=event.target.closest('.tab[data-tab-id]');
    const id=Number(tab?.dataset.tabId);
    if(!tab||!Number.isSafeInteger(id)||!latest.tabs.some(t=>t.id===id))return;
    gesture={id,pointerId:event.pointerId,x:event.clientX,y:event.clientY,active:false};
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
    tabStrip.classList.remove('drag-ungroup-over');
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
    else if(hit?.closest('#tabs'))tabStrip.classList.add('drag-ungroup-over');
  }
  function movePointer(event){
    if(!gesture||event.pointerId!==gesture.pointerId)return;
    if(!gesture.active){
      if(Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)<5)return;
      gesture.active=true;
      draggingTabId=gesture.id;
      createGhost(gesture.id);
      document.body.classList.add('tab-dragging');
      tabStrip.querySelectorAll('.tab[data-tab-id]').forEach(el=>{
        el.classList.toggle('tab-drag-source',Number(el.dataset.tabId)===draggingTabId);
      });
      try {tabStrip.setPointerCapture(event.pointerId);}catch{}
    }
    event.preventDefault();
    if(ghost){ghost.style.left=Math.round(event.clientX+11)+'px';ghost.style.top=Math.round(event.clientY+9)+'px';}
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
    if(groupId)dropIntoGroup(event,groupId);
    else if(tab&&Number(tab.dataset.tabId)!==finished.id)
      dropNextTo(event,Number(tab.dataset.tabId),tab);
    else if(hit?.closest('#tabUngroupDrop')||hit?.closest('#tabs'))
      dropOutsideGroup(event);
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
    for(const [key,hex] of Object.entries(palette)){
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
    const color=selected?.dataset.color??'violet';
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
    isVisibleTab:id=>model.isVisibleTab(state,id)
  };
})();
