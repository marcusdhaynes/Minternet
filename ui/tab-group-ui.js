'use strict';
(() => {
  const model=window.MinternetGroupModel, api=window.minternet;
  if (!model || !api) return;
  const $=id=>document.getElementById(id);
  const KEY='minternet.tab-groups.v1';
  let state;
  try { state=model.hydrate(localStorage.getItem(KEY)); } catch {state=model.blank();}
  let latest={tabs:[],activeId:null};
  let lastRenderKey='', lastStoredGroupJson='', editing=null, assignTarget=null, fallbackPending=false;
  // Keyed DOM reuse: changing one active tab must not recreate and rebind
  // listeners for every other tab on each title/audio/loading notification.
  const reusedTabs=new Map();
  const reusedChips=new Map(),reusedEndCaps=new Map();
  let draggingTabId=null;
  let gesture=null, ghost=null, splitPreview=null, dragOverlay=false, suppressedClick=null;
  let insertionMarker=null;
  // The chrome WebView is only toolbar-height until a native tab drag expands
  // its overlay. During that async transition innerHeight is not the parent
  // browser height; use the logical client bounds returned by native code.
  let dragViewport=null;
  function dropViewport(){
    return {width:Math.max(innerWidth,dragViewport?.width||0),
      height:Math.max(innerHeight,dragViewport?.height||0)};
  }
  let splitPaneIds=[];
  let splitThreeLeft=false;
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
  // Save group membership in a single pass. The previous implementation
  // scanned every native tab again for each ordered tab (quadratic work).
  function savedTabSlots(tabs) {
    const normal=tabs.filter(tab=>!tab.private);
    const positions=new Map(normal.map((tab,index)=>[tab.id,index]));
    return {
      slots:normal.map(tab=>state.assignments[String(tab.id)]||null),
      visualOrder:state.order.map(id=>positions.get(id)).filter(index=>index!==undefined)
    };
  }
  function persist(skipUndo=false) {
    const current=groupUndoJson();
    if(!skipUndo&&current!==lastGroupUndoJson&&(!colorUndoActive||!colorUndoRecorded)){
      if(window.__TAURI__)void api.command('undo-ui-checkpoint',{kind:'groups',before:lastGroupUndoJson});
      if(colorUndoActive)colorUndoRecorded=true;
    }
    lastGroupUndoJson=current;
    try {const stored=JSON.parse(model.serialize(state));Object.assign(stored,savedTabSlots(latest.tabs));localStorage.setItem(KEY,JSON.stringify(stored));}
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
  function supertabMembers(tabId){
    const ids=window.MinternetSuperTab?.ordered(latest.splitIds,latest.splitLeft)||[];
    const live=ids.filter(id=>latest.tabs.some(tab=>tab.id===id));
    // A supertab is one movable/groupable item, not separate split panes.
    return live.length>1&&live.includes(tabId)?live:[tabId];
  }
  function assign(tabId,groupId) {
    const ids=supertabMembers(tabId);
    if(!ids.every(id=>latest.tabs.some(tab=>tab.id===id)))return false;
    if(groupId!=null&&!model.get(state,groupId))return false;
    const pinned=groupId==null?[]:latest.tabs.filter(tab=>ids.includes(tab.id)&&tab.pinned);
    if(pinned.length){
      // All native unpins must complete before applying the group atomically.
      void (async()=>{
        for(const tab of pinned){
          try{
            const response=await api.command('unpin',tab.id);
            if(response?.ok!==true||response?.message){
              window.minternetToast?.(response?.message||'Could not unpin a split pane.');
              return;
            }
          }catch{window.minternetToast?.('Could not unpin a split pane.');return;}
        }
        if(model.assignMany(state,ids,groupId))persist();
      })();
      return true;
    }
    if(!model.assignMany(state,ids,groupId))return false;
    // Group a supertab without expanding/altering the group or replacing its
    // live pages. A single undo checkpoint captures the complete membership.
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
    insertionMarker?.remove();
    insertionMarker=null;
    splitPaneIds=[];
    ghost?.remove();
    ghost=null;
    splitPreview?.remove();
    splitPreview=null;
    dragViewport=null;
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
    const ids=supertabMembers(id);
    const members=model.tabsIn(state,gid,latest.tabs).filter(tab=>!ids.includes(tab.id));
    const last=members[members.length-1];
    if(last)model.moveBlockRelative(state,ids,last.id,true);
    clearDropState();
    return assign(id,gid);
  }
  function dropNextTo(event,targetId,after) {
    const id=currentDraggedTab();
    if(id===null||id===targetId)return false;
    const target=latest.tabs.find(t=>t.id===targetId);
    if(!target)return false;
    event.preventDefault();
    event.stopPropagation();
    const targetGroup=model.findTab(state,targetId);
    const source=latest.tabs.find(t=>t.id===id);
    const moving=supertabMembers(id);
    const destination=supertabMembers(targetId);
    if(target.pinned&&moving.length>1){
      window.minternetToast?.('A SuperTab cannot be pinned as a single tab.');
      return false;
    }
    const anchor=after?destination[destination.length-1]:destination[0];
    model.moveBlockRelative(state,moving,anchor,after);
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
    const takeChip=(group,members)=>{
      const signature=JSON.stringify([group.name,group.color,group.visible,
        group.collapsed,members.length]);
      let cache=reusedChips.get(group.id);
      if(!cache||cache.signature!==signature){
        cache={signature,node:buildChip(group,members)};
        reusedChips.set(group.id,cache);
      }
      return cache.node;
    };
    const takeEndCap=group=>{
      const color=groupColor(group);
      let cache=reusedEndCaps.get(group.id);
      if(!cache||cache.color!==color){
        const node=document.createElement('span');
        node.className='group-end-cap';
        node.style.setProperty('--group-accent',color);
        node.setAttribute('aria-hidden','true');
        cache={color,node};
        reusedEndCaps.set(group.id,cache);
      }
      return cache.node;
    };
    const takeTab=(tab,active)=>{
      const signature=JSON.stringify([
        tab.title,tab.url,tab.private,tab.tor,tab.pinned,tab.suspended,tab.loading,
        tab.audioPlaying,tab.audioMuted,tab.secretTab,tab.secretPending,
        tab.syncId,active,
        tab.secretTab?window.minternetSecretTabNames?.get(tab.id):''
      ]);
      let cache=reusedTabs.get(tab.id);
      if(!cache||cache.signature!==signature){
        const node=buildTab(tab,active);
        node.dataset.tabId=String(tab.id);
        attachTabMenu(node,tab.id);
        cache={signature,node};
        reusedTabs.set(tab.id,cache);
      }
      cache.node.classList.remove('group-member');
      cache.node.style.removeProperty('--group-accent');
      return cache.node;
    };
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
        // A background tab inherits its source group without changing
        // the group's collapsed/hidden state.
        model.assign(state,tab.id,parentGroup.id);
      }
    }
    model.prune(state,data.tabs.map(t=>t.id));
    if(state.restoredOrder){
      const native=data.tabs.filter(t=>!t.private);
      state.order=[...new Set([...state.restoredOrder.map(i=>native[i]?.id).filter(Boolean),...data.tabs.map(t=>t.id)])];
      state.restoredOrder=null;
    }
    eligibleFallback();
    const splitIds=window.MinternetSuperTab?.ordered(data.splitIds,data.splitLeft)||[];
    const splitSet=new Set(splitIds);
    const splitTabs=splitIds.map(id=>data.tabs.find(tab=>tab.id===id)).filter(Boolean);
    if(splitTabs.length<2)splitSet.clear();
    // Only a supertab whose panes all share one group is shown inside it.
    // Do not display copies of split panes elsewhere in the tab strip.
    const firstGroup=splitTabs.length>1?model.findTab(state,splitTabs[0].id):null;
    const splitGroup=firstGroup&&splitTabs.every(tab=>
      model.findTab(state,tab.id)?.id===firstGroup.id)?firstGroup:null;
    const signature=JSON.stringify([
      data.activeId,data.splitIds||[],Boolean(data.splitLeft),
      data.tabs.map(t=>[t.id,t.title,t.url,t.private,t.pinned,t.loading,t.suspended,t.audioPlaying,t.audioMuted,t.secretTab,t.secretPending,t.syncId,
        t.secretTab?window.minternetSecretTabNames?.get(t.id):'']),
      state.order,
      state.groups.map(g=>[g.id,g.name,g.color,g.visible,g.collapsed]),
      Object.entries(state.assignments).sort()
    ]);
    if(lastRenderKey===signature)return;
    lastRenderKey=signature;
    // Save the current slot order so group membership survives native restarts.
    try {const stored=JSON.parse(model.serialize(state));Object.assign(stored,savedTabSlots(data.tabs));const updated=JSON.stringify(stored);if(updated!==lastStoredGroupJson){localStorage.setItem(KEY,updated);lastStoredGroupJson=updated;}}catch{}
    const items=[];
    let superNode=null;
    const takeSuper=()=>{
      if(!superNode){
        superNode=window.MinternetSuperTab.build(splitTabs,data.activeId,
          window.minternetRenderSplitIcon,
          id=>window.minternet?.command('activate',id),
          (id,point)=>window.minternetMenus?.tab(id,point));
        attachTabMenu(superNode,splitTabs[0].id);
      }
      superNode.classList.remove('group-member');
      superNode.style.removeProperty('--group-accent');
      return superNode;
    };
    // Chrome/Firefox-style pinned tabs precede groups and show no close X.
    for(const tab of model.sortedTabs(state,data.tabs).filter(t=>t.pinned&&!splitSet.has(t.id))){
      if(model.findTab(state,tab.id))model.assign(state,tab.id,null);
      items.push(takeTab(tab,tab.id===data.activeId));
    }
    for(const g of state.groups){
      if(!g.visible)continue;
      const allMembers=model.tabsIn(state,g.id,data.tabs).filter(t=>!t.pinned);
      const members=allMembers.filter(t=>!splitSet.has(t.id));
      const containsSuper=splitGroup?.id===g.id;
      // A split supertab counts as one visible group item, regardless of its
      // two, three or four underlying panes.
      const visualMembers=containsSuper?[...members,splitTabs[0]]:members;
      items.push(takeChip(g,visualMembers));
      if(!g.collapsed){
        let placedSuper=false;
        for(const tab of allMembers){
          if(splitSet.has(tab.id)){
            if(containsSuper&&!placedSuper){
              const node=takeSuper();
              node.classList.add('group-member');
              node.style.setProperty('--group-accent',groupColor(g));
              items.push(node);
              placedSuper=true;
            }
            continue;
          }
          const item=takeTab(tab,tab.id===data.activeId);
          item.classList.add('group-member');
          item.style.setProperty('--group-accent',groupColor(g));
          items.push(item);
        }
        // Decorative end-cap follows the full group, including a supertab.
        if(visualMembers.length)items.push(takeEndCap(g));
      }
    }
    let placedUngroupedSuper=false;
    for(const tab of model.sortedTabs(state,data.tabs)){
      if(splitSet.has(tab.id)){
        if(!splitGroup&&!placedUngroupedSuper){
          items.push(takeSuper());
          placedUngroupedSuper=true;
        }
        continue;
      }
      if(tab.pinned||model.findTab(state,tab.id))continue;
      items.push(takeTab(tab,tab.id===data.activeId));
    }
    // Minimal keyed reconciliation: do not detach and recreate every tab
    // when just one page changes title or the active selection changes.
    // insertBefore moves only nodes whose order actually differs.
    for(let index=0;index<items.length;index++){
      const next=items[index];
      if(host.children[index]!==next)
        host.insertBefore(next,host.children[index]||null);
    }
    while(host.children.length>items.length)host.lastElementChild.remove();
    const surviving=new Set(data.tabs.map(tab=>tab.id));
    for(const id of reusedTabs.keys())if(!surviving.has(id))reusedTabs.delete(id);
    const groups=new Set(state.groups.map(group=>group.id));
    for(const id of reusedChips.keys())if(!groups.has(id))reusedChips.delete(id);
    for(const id of reusedEndCaps.keys())if(!groups.has(id))reusedEndCaps.delete(id);
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
    const panes=supertabMembers(tabId);
    ghost.textContent=panes.length>1?'◫  SuperTab · '+panes.length+' panes':
      '◉  '+(tab?.title||'New Tab');
    document.body.append(ghost);
  }
  // One hit test drives both the preview and the committed insertion.
  // The tiny gaps between consecutive tabs are real insertion targets too.
  function insertionTarget(hit,x,y){
    let tab=hit?.closest('.tab[data-tab-id]');
    let after;
    if(tab){
      const rect=tab.getBoundingClientRect();
      after=x>=rect.left+rect.width/2;
    }else if(hit?.closest('#tabs')){
      const strip=tabStrip.getBoundingClientRect();
      if(y<strip.top||y>strip.bottom)return null;
      const children=Array.from(tabStrip.children);
      for(let i=1;i<children.length;i++){
        const left=children[i-1],right=children[i];
        if(!left.matches('.tab[data-tab-id]')||!right.matches('.tab[data-tab-id]'))continue;
        const a=left.getBoundingClientRect(),b=right.getBoundingClientRect();
        if(a.width>0&&b.width>0&&x>=a.right&&x<=b.left){
          tab=x<(a.right+b.left)/2?left:right;
          after=tab===left;
          break;
        }
      }
    }
    if(!tab)return null;
    return {tab,after,id:Number(tab.dataset.tabId)};
  }
  function showInsertionMarker(target){
    const {tab,after,id}=target;
    const moving=supertabMembers(draggingTabId);
    if(moving.includes(id))return;
    if(moving.length>1&&latest.tabs.find(t=>t.id===id)?.pinned)return;
    const rect=tab.getBoundingClientRect(),strip=tabStrip.getBoundingClientRect();
    const neighbor=after?tab.nextElementSibling:tab.previousElementSibling;
    let edge=after?rect.right:rect.left;
    if(neighbor?.matches('.tab[data-tab-id]')){
      const adjacent=neighbor.getBoundingClientRect();
      if(adjacent.width>0)edge=(edge+(after?adjacent.left:adjacent.right))/2;
    }
    if(edge<strip.left||edge>strip.right)return;
    if(!insertionMarker){
      insertionMarker=document.createElement('div');
      insertionMarker.className='tab-insertion-marker';
      insertionMarker.setAttribute('aria-hidden','true');
      document.body.append(insertionMarker);
    }
    insertionMarker.style.left=Math.round(edge)+'px';
    insertionMarker.style.top=Math.round(Math.max(rect.top,strip.top))+'px';
    insertionMarker.style.height=Math.max(1,Math.round(Math.min(rect.bottom,strip.bottom)-Math.max(rect.top,strip.top)))+'px';
    insertionMarker.hidden=false;
  }
  function updateHover(x,y){
    if(insertionMarker)insertionMarker.hidden=true;
    tabStrip.querySelectorAll('.drag-target,.group-drop-target,.drop-before,.drop-after')
      .forEach(node=>node.classList.remove('drag-target','group-drop-target','drop-before','drop-after'));
    tabStrip.classList.remove('drag-ungroup-over','drag-pin-over');
    ungroupTarget?.classList.remove('drag-target');
    const hit=document.elementFromPoint(x,y);
    const chip=hit?.closest('.group-chip[data-group-id]');
    if(chip){chip.classList.add('drag-target');return;}
    const target=insertionTarget(hit,x,y);
    if(target){
      showInsertionMarker(target);
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
  // Preview the *actual* resulting geometry, not four advertised boxes
  // that the native two-/three-pane layout would subsequently rearrange.
  function splitPaneCount(id){
    return Math.max(2,Math.min(4,splitPaneIds.length+(splitPaneIds.includes(id)?0:1)));
  }
  function draggedQuadrant(x,y,top){
    const viewport=dropViewport();
    const col=x<viewport.width/2?0:1;
    const row=y<top+(viewport.height-top)/2?0:2;
    return col+row;
  }
  function visibleSplitSlot(count,quadrant,sideLeft=false){
    if(count<=2)return quadrant%2;
    if(count===3){
      return sideLeft?(quadrant%2===0?(quadrant<2?0:1):2):
        (quadrant%2===0?0:quadrant<2?1:2);
    }
    return quadrant;
  }
  function updateSplitPreview(x,y,top){
    const count=splitPaneCount(draggingTabId);
    if(!splitPreview){
      splitPreview=document.createElement('div');
      splitPreview.className='split-drag-zones';
      splitPreview.setAttribute('aria-hidden','true');
      document.body.append(splitPreview);
    }
    const viewport=dropViewport();
    // When adding a third pane the pointer chooses WHICH side is divided.
    // Preserve existing panes on the opposite side.
    const sideLeft=count===3?
      (splitPaneIds.length===2?x<viewport.width/2:splitThreeLeft):false;
    if(Number(splitPreview.dataset.panes)!==count||
       (count===3&&splitPreview.dataset.side!==(sideLeft?'left':'right'))){
      splitPreview.dataset.panes=String(count);
      splitPreview.dataset.side=sideLeft?'left':'right';
      splitPreview.replaceChildren();
      const labels=count===2?['Left','Right']:
        count===3?(sideLeft?['Upper Left','Lower Left','Right']:
                        ['Left','Upper Right','Lower Right']):
        ['Upper Left','Upper Right','Lower Left','Lower Right'];
      for(const label of labels){
        const zone=document.createElement('div');
        zone.className='split-drag-zone';
        zone.textContent=label;
        splitPreview.append(zone);
      }
    }
    splitPreview.style.top=Math.round(top)+'px';
    splitPreview.style.width=Math.round(viewport.width)+'px';
    splitPreview.style.height=Math.round(Math.max(0,viewport.height-top))+'px';
    const slot=visibleSplitSlot(count,draggedQuadrant(x,y,top),sideLeft);
    [...splitPreview.children].forEach((zone,i)=>zone.classList.toggle('active',i===slot));
    ghost.textContent='◫  Drop in '+splitPreview.children[slot]?.textContent;
  }
  function movePointer(event){
    if(!gesture||event.pointerId!==gesture.pointerId)return;
    if(!gesture.active){
      const distance=Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y);
      // Supertabs are narrow icon clusters: require only a small, deliberate
      // movement to start dragging from any pane. Regular tabs retain their
      // longer resistance to protect normal clicking/context menus.
      const supertab=supertabMembers(gesture.id).length>1;
      const minimum=supertab?6:12, deliberate=supertab?10:20;
      const grace=supertab?90:125;
      if(distance<minimum||(distance<deliberate&&performance.now()-gesture.started<grace))return;
      gesture.active=true;
      draggingTabId=gesture.id;
      createGhost(gesture.id);
      if(window.__TAURI__){
        dragOverlay=true;
        void api.command('chrome-overlay',true).then(result=>{
          if(!gesture?.active)return;
          const width=Number(result?.viewport?.width),height=Number(result?.viewport?.height);
          if(width>0&&height>0&&Number.isFinite(width)&&Number.isFinite(height)){
            dragViewport={width,height};
          }
        });
      }
      // Read existing panes once per gesture. A regular tab drag must not
      // affect site-level HTML5 file drops or introduce a native drop handler.
      void api.command('split-status').then(status=>{
        if(gesture?.active&&gesture.id===draggingTabId &&
           Array.isArray(status?.ids)){
          splitPaneIds=status.ids.filter(Number.isSafeInteger);
          splitThreeLeft=status.splitLeft===true;
        }
      });
      document.body.classList.add('tab-dragging');
      tabStrip.querySelectorAll('.tab[data-tab-id]').forEach(el=>{
        el.classList.toggle('tab-drag-source',Number(el.dataset.tabId)===draggingTabId);
      });
      try {tabStrip.setPointerCapture(event.pointerId);}catch{}
    }
    event.preventDefault();
    if(ghost){
      ghost.style.left=Math.round(event.clientX+11)+'px';ghost.style.top=Math.round(event.clientY+9)+'px';
      const top=document.querySelector('.chrome').getBoundingClientRect().bottom;
      const viewport=dropViewport();
      const overPage=supertabMembers(gesture.id).length===1&&
        event.clientY>top+6&&event.clientY<=viewport.height &&
        event.clientX>=0&&event.clientX<=viewport.width;
      ghost.classList.toggle('split-drag-preview',overPage);
      if(overPage)updateSplitPreview(event.clientX,event.clientY,top);
      else{splitPreview?.remove();splitPreview=null;}
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
    const target=insertionTarget(hit,event.clientX,event.clientY);
    const groupId=chip?.dataset.groupId;
    const top=document.querySelector('.chrome').getBoundingClientRect().bottom;
    const viewport=dropViewport();
    if(supertabMembers(finished.id).length===1&&
       event.clientY>top+6&&event.clientY<=viewport.height &&
       event.clientX>=0&&event.clientX<=viewport.width){
      const x=Math.max(0,Math.min(1,event.clientX/Math.max(viewport.width,1)));
      const y=Math.max(0,Math.min(1,(event.clientY-top)/Math.max(viewport.height-top,1)));
      // Pass the literal quadrant that was highlighted at drop, so the
      // native allocator never guesses or shifts unrelated split panes.
      const quadrant=draggedQuadrant(event.clientX,event.clientY,top);
      void api.command('split-add',{id:finished.id,x,y,quadrant});
    }else if(groupId)dropIntoGroup(event,groupId);
    else if(target){
      if(!supertabMembers(finished.id).includes(target.id))
        dropNextTo(event,target.id,target.after);
    }
    else if(hit?.closest('#tabs')){
      const rect=tabStrip.getBoundingClientRect();
      const source=latest.tabs.find(t=>t.id===finished.id);
      if(source&&!source.pinned&&supertabMembers(finished.id).length===1&&
         event.clientX<=rect.left+24){
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
  document.addEventListener('pointerdown',event=>{
    if($('groupEditorScreen').hidden)return;
    if($('groupEditorForm').contains(event.target))return;
    closeEditor();
  },true);
  window.addEventListener?.('blur',()=>{
    if(!$('groupEditorScreen').hidden)closeEditor();
  });
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
