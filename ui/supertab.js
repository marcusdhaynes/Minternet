'use strict';
// Logical split cell order is not tab strip/group order. Icons follow the
// screen: upper row first, left before right, then lower row.
(function(root,factory){
 const api=factory();
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 if(root)root.MinternetSuperTab=api;
})(typeof window!=='undefined'?window:null,()=>{
 function ordered(ids,splitLeft){
   if(!Array.isArray(ids)||ids.length<2||ids.length>4)return [];
   if(!ids.every(id=>Number.isSafeInteger(id)&&id>0)||new Set(ids).size!==ids.length)return [];
   return ids.length===3&&splitLeft?[ids[0],ids[2],ids[1]]:ids.slice();
 }
 function build(tabs,activeId,renderIcon,activate,context){
   const node=document.createElement('div');
   node.className='tab split-supertab'+(tabs.some(t=>t.id===activeId)?' selected':'');
   node.setAttribute('role','tab');
   node.setAttribute('aria-selected',String(tabs.some(t=>t.id===activeId)));
   node.setAttribute('aria-label','Split View: '+tabs.map(t=>t.title||'New Tab').join(' | '));
   node.title=tabs.map((t,i)=>(i+1)+'. '+(t.title||'New Tab')).join(' · ');
   node.dataset.splitTabIds=tabs.map(t=>t.id).join(',');
   tabs.forEach((tab,i)=>{
     if(i){
       const divider=document.createElement('span');
       divider.className='split-super-divider';
       divider.setAttribute('aria-hidden','true');
       node.append(divider);
     }
     const button=document.createElement('button');
     button.type='button';
     button.className='split-super-pane'+(tab.id===activeId?' current':'');
     button.dataset.tabId=String(tab.id);
     button.title=(tab.title||'New Tab')+' · Split pane '+(i+1);
     button.setAttribute('aria-label','Focus split pane '+(i+1)+': '+(tab.title||'New Tab'));
     const slot=document.createElement('span');
     slot.className='tab-symbol';
     renderIcon?.(tab,slot);
     button.append(slot);
     button.addEventListener('click',event=>{event.stopPropagation();activate?.(tab.id);});
     button.addEventListener('contextmenu',event=>{
       event.preventDefault();event.stopPropagation();
       context?.(tab.id,{x:event.clientX,y:event.clientY});
     });
     node.append(button);
   });
   node.draggable=false;
   return node;
 }
 return {ordered,build};
});