'use strict';
/* Minternet encrypted, push-only sync protocol v2.
 * Shared data model for Tauri, Android and iOS. Metadata reveals only kind
 * and opaque item id. Contents never leave the device unencrypted.
 * No polling: local commits + database broadcasts + reconnect replay only. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.MinternetLiveSync=api;
})(typeof window!=='undefined'?window:null,()=>{
  const MAX=250_000;
  const categories=new Set(['tab','group','bookmark','login','payment','identity','undo','prefs']);
  const canonical=x=>JSON.stringify(x);
  const toBytes=text=>new TextEncoder().encode(text);
  const fromBytes=bytes=>new TextDecoder().decode(bytes);
  const b64=bytes=>{
    let str='';for(let i=0;i<bytes.length;i+=8192)
      str+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  };
  const unb64=str=>{
    const binary=atob(str.replace(/-/g,'+').replace(/_/g,'/'));
    return Uint8Array.from(binary,c=>c.charCodeAt(0));
  };
  const validKey=(kind,key)=>categories.has(kind) && typeof key==='string' &&
    key.length>0&&key.length<=180&&/^[A-Za-z0-9_:.@-]+$/.test(key);
  const eligibleTab=t=>{
    if(!t||t.private||t.tor||t.isTor||t.container==='tor')return false;
    try{
      const u=new URL(t.url);
      return u.protocol==='https:'&&!u.username&&!u.password&&
        !u.hostname.endsWith('.onion');
    }catch{return false;}
  };
  async function derive(passphrase,userId,subtle=crypto.subtle){
    if(typeof passphrase!=='string'||passphrase.length<16)
      throw Error('Use a sync passphrase of at least 16 characters');
    if(!/^[a-f0-9-]{36}$/i.test(userId))throw Error('Invalid account identity');
    const digest=new Uint8Array(await subtle.digest('SHA-256',
      toBytes('minternet-e2ee-v2:'+userId.toLowerCase())));
    const material=await subtle.importKey('raw',toBytes(passphrase),'PBKDF2',false,['deriveKey']);
    return subtle.deriveKey({name:'PBKDF2',salt:digest.slice(0,16),
      iterations:310000,hash:'SHA-256'},material,
      {name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  async function encrypt(kind,itemKey,value,key,subtle=crypto.subtle,random=crypto){
    if(!validKey(kind,itemKey))throw Error('Invalid sync record');
    const plain=toBytes(canonical(value));
    if(plain.length>180000)throw Error('Sync record too large');
    const nonce=random.getRandomValues(new Uint8Array(12));
    const ciphertext=await subtle.encrypt({name:'AES-GCM',iv:nonce,
      additionalData:toBytes('minternet:'+kind+':'+itemKey)},key,plain);
    const out='enc1:'+b64(nonce)+'.'+b64(new Uint8Array(ciphertext));
    if(out.length>MAX)throw Error('Encrypted record too large');
    return out;
  }
  async function decrypt(kind,itemKey,envelope,key,subtle=crypto.subtle){
    if(!validKey(kind,itemKey)||typeof envelope!=='string'||
       !envelope.startsWith('enc1:')||envelope.length>MAX)throw Error('Invalid encrypted record');
    const [iv,value]=envelope.slice(5).split('.');
    const nonce=unb64(iv||'');
    if(nonce.length!==12||!value)throw Error('Invalid encrypted nonce');
    const bytes=await subtle.decrypt({name:'AES-GCM',iv:nonce,
      additionalData:toBytes('minternet:'+kind+':'+itemKey)},key,unb64(value));
    return JSON.parse(fromBytes(new Uint8Array(bytes)));
  }
  async function opaqueId(kind,str,subtle=crypto.subtle){
    const hash=new Uint8Array(await subtle.digest('SHA-256',
      toBytes(kind+':'+str)));
    return b64(hash).slice(0,42);
  }
  async function makeRecords({tabs=[],groups=[],assignments={},
      bookmarks={items:[]},logins=[],cards=[],identities=[],prefs={}},subtle=crypto.subtle){
    const out=new Map();
    const normal=tabs.filter(eligibleTab);
    const normalIds=new Set(normal.map(t=>String(t.id)));
    const visibleGroups=groups.filter(g=>{
      if(!g||typeof g.id!=='string')return false;
      const members=tabs.filter(t=>assignments[String(t.id)]===g.id);
      return members.length===0||members.some(t=>normalIds.has(String(t.id)));
    });
    const groupIds=new Set(visibleGroups.map(g=>g.id));
    for(const group of visibleGroups){
      const id=await opaqueId('group',group.id,subtle);
      out.set('group:'+id,{kind:'group',item_key:id,value:{
        id:group.id,name:group.name,color:group.color,visible:group.visible,
        collapsed:group.collapsed}});
    }
    for(const tab of normal){
      const id=tab.syncId||await opaqueId('tab',tab.url,subtle);
      const group=assignments[String(tab.id)];
      out.set('tab:'+id,{kind:'tab',item_key:id,value:{
        syncId:id,url:tab.url,title:tab.title||'',pinned:!!tab.pinned,
        groupId:groupIds.has(group)?group:null}});
    }
    const walk=async(items,parent=null)=>{
      for(let i=0;i<(items||[]).length;i++){
        const item=items[i];
        if(!item||typeof item.id!=='string'||!['folder','link'].includes(item.kind))continue;
        const key=await opaqueId('bookmark',item.id,subtle);
        if(item.kind==='link'&&!eligibleTab({url:item.url}))continue;
        out.set('bookmark:'+key,{kind:'bookmark',item_key:key,value:{
          id:item.id,parent,index:i,kind:item.kind,name:item.name||'',
          icon:item.icon||'',url:item.kind==='link'?item.url:null}});
        if(item.kind==='folder')await walk(item.children||[],item.id);
      }
    };
    await walk(bookmarks.items);
    for(const login of logins){
      if(!eligibleTab({url:login.origin})||!login.username||!login.password)continue;
      const key=await opaqueId('login',login.origin+'\0'+login.username,subtle);
      out.set('login:'+key,{kind:'login',item_key:key,value:{
        origin:login.origin,username:login.username,password:login.password,
        autofill:login.autofill!==false}});
    }
    for(const card of cards){
      if(!card.id||!card.number||!/^[0-9]{12,19}$/.test(card.number))continue;
      const key=await opaqueId('payment',card.id,subtle);
      out.set('payment:'+key,{kind:'payment',item_key:key,value:{
        id:card.id,label:card.label,name:card.name,number:card.number,
        month:card.month,year:card.year,postal:card.postal}});
    }
    for(const identity of identities){
      if(!identity?.id||!identity.label||!identity.fields||
         typeof identity.fields!=='object')continue;
      const key=await opaqueId('identity',identity.id,subtle);
      out.set('identity:'+key,{kind:'identity',item_key:key,value:{
        id:identity.id,label:identity.label,fields:identity.fields
      }});
    }
    if(Object.keys(prefs).length){
      out.set('prefs:general',{kind:'prefs',item_key:'general',value:prefs});
    }
    return out;
  }
  const compare=(a,b)=>Number(a?.revision||0)-Number(b?.revision||0);
  function decide(current,incoming){
    if(!current)return incoming;
    if(!incoming)return current;
    if(compare(current,incoming)>0)return current;
    if(compare(current,incoming)<0)return incoming;
    // Server revisions are unique. Equal-revision events must be idempotent.
    return current;
  }
  function buildBookmarkTree(records){
    const items=[...records].filter(r=>r?.kind==='bookmark'&&!r.deleted)
      .map(r=>({...r.value,children:[]}));
    const dict=new Map(items.map(i=>[i.id,i]));
    const roots=[];
    // Stable array ordering protects drag/drop placement and folder contents.
    items.sort((a,b)=>(a.index||0)-(b.index||0));
    for(const item of items){
      if(item.parent&&dict.has(item.parent)&&dict.get(item.parent).kind==='folder' &&
         item.parent!==item.id)dict.get(item.parent).children.push(item);
      else roots.push(item);
    }
    const clean=list=>list.map(i=>i.kind==='folder'
      ?{id:i.id,kind:'folder',name:i.name,icon:i.icon,children:clean(i.children)}
      :{id:i.id,kind:'link',name:i.name,icon:i.icon,url:i.url});
    return {visible:true,items:clean(roots)};
  }
  return {derive,encrypt,decrypt,makeRecords,opaqueId,eligibleTab,
    decide,compare,buildBookmarkTree,validKey};
});