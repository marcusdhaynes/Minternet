'use strict';
// Shared, dependency-free sync boundary. Never send private tabs, private-only
// groups, Tor URLs, credential-bearing URLs, or raw password/card contents.
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.MinternetSyncCore=api;
})(typeof window!=='undefined'?window:null,()=>{
  function safeUrl(value){
    if(typeof value!=='string'||value.length>2048)return null;
    try{
      const u=new URL(value);
      return u.protocol==='https:'&&!u.username&&!u.password&&u.hostname&&!u.hostname.endsWith('.onion')
        ?u.href:null;
    }catch{return null;}
  }
  function snapshot(bookmarks,groupState,browser){
    const state=groupState||{},tabs=Array.isArray(browser?.tabs)?browser.tabs:[];
    const normal=tabs.filter(t=>!t.private&&!t.tor&&!t.isTor);
    const valid=new Set(normal.map(t=>t.id));
    const membership=state.assignments||{};
    const groups=Array.isArray(state.groups)?state.groups:[];
    const publicGroups=groups.filter(group=>{
      if(!group||typeof group.id!=='string')return false;
      const members=tabs.filter(t=>membership[String(t.id)]===group.id);
      // A group containing only private/Tor tabs is never exported.
      return members.length===0||members.some(t=>valid.has(t.id));
    }).map(g=>({id:g.id,name:g.name,color:g.color,visible:g.visible!==false,collapsed:g.collapsed===true}));
    const groupIds=new Set(publicGroups.map(g=>g.id));
    const publicTabs=normal.map(t=>{
      const url=safeUrl(t.url);
      if(!url)return null;
      const groupId=membership[String(t.id)];
      return {url,pinned:!!t.pinned,
        groupId:groupIds.has(groupId)?groupId:null};
    }).filter(Boolean);
    // Bookmarks already belong to trusted non-private chrome and are validated
    // by MinternetBookmarks.hydrate before application.
    return {version:1,
      bookmarks:bookmarks&&Array.isArray(bookmarks.items)?bookmarks:{visible:true,items:[]},
      groups:publicGroups,tabs:publicTabs};
  }
  function validate(raw){
    if(!raw||raw.version!==1||!Array.isArray(raw.tabs)||
       !Array.isArray(raw.groups)||!raw.bookmarks||!Array.isArray(raw.bookmarks.items))
      throw Error('Invalid synced Minternet data');
    if(raw.tabs.length>35||raw.groups.length>40||JSON.stringify(raw).length>4_000_000)
      throw Error('Synced data exceeds safe limits');
    return {...raw,tabs:raw.tabs.filter(t=>safeUrl(t?.url)).map(t=>({
      url:safeUrl(t.url),pinned:!!t.pinned,
      groupId:typeof t.groupId==='string'?t.groupId:null}))};
  }
  function mergeBookmarks(local,remote){
    const clone=x=>JSON.parse(JSON.stringify(x));
    const output=clone(remote||{visible:true,items:[]});
    output.items=Array.isArray(output.items)?output.items:[];
    const merge=(target,items)=>{
      for(const item of items||[]){
        if(!item||!['folder','link'].includes(item.kind))continue;
        const found=target.find(existing=>existing.id===item.id);
        if(found&&found.kind==='folder'&&item.kind==='folder'){
          found.children=Array.isArray(found.children)?found.children:[];
          merge(found.children,item.children);
        }else if(!found){
          // Avoid duplicating identical links within a single folder.
          if(item.kind==='link'&&target.some(t=>t.kind==='link'&&t.url===item.url))continue;
          target.push(clone(item));
        }
      }
    };
    merge(output.items,local?.items||[]);
    return output;
  }
  return {safeUrl,snapshot,validate,mergeBookmarks};
});