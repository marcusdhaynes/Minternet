'use strict';
// Pure bookmark import parser. Imported HTML is tokenized, never executed or
// inserted as markup. All URLs go through the existing HTTPS-only bookmark model.
(function(root,factory){
 const api=factory(root?.MinternetBookmarks||(typeof require==='function'?require('./bookmark-model.js'):null));
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 if(root)root.MinternetBookmarkImport=api;
})(typeof window!=='undefined'?window:null,model=>{
 const MAX_NODES=2000,MAX_DEPTH=12,MAX_TEXT=2_000_000;
 const clean=(s,max=180)=>String(s||'').replace(/<[^>]*>/g,' ').replace(/&(?:amp|#38);/gi,'&')
   .replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
   .replace(/\s+/g,' ').trim().slice(0,max);
 function attrs(tag){
   const map=Object.create(null);
   const reg=/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
   let m;while((m=reg.exec(tag)))map[m[1].toLowerCase()]=m[2]??m[3]??m[4];
   return map;
 }
 function link(address,name){
   const target=model?.url(address);
   if(!target)return null;
   return {kind:'link',name:clean(name)||new URL(target).hostname,url:target,icon:''};
 }
 function folder(name,children=[]){return {kind:'folder',name:clean(name,100),icon:'',children};}
 function parseHtml(input){
   if(typeof input!=='string'||input.length>MAX_TEXT)return [];
   const root=[],frames=[{children:root}],tags=/<\/?(?:DL|DT|H3|A)\b[^>]*>|<[^>]*>|[^<]+/gi;
   let token,pending=null,capture=null,num=0;
   while((token=tags.exec(input))&&num<MAX_NODES+10000){
     const raw=token[0],lower=raw.toLowerCase();
     if(/^<h3\b/.test(lower)){capture={kind:'folder',text:''};continue;}
     if(/^<a\b/.test(lower)){capture={kind:'link',text:'',attrs:attrs(raw)};continue;}
     if(/^<\/h3\s*>/.test(lower)&&capture?.kind==='folder'){
       if(num++<MAX_NODES){pending=folder(capture.text);frames.at(-1).children.push(pending);}
       capture=null;continue;
     }
     if(/^<\/a\s*>/.test(lower)&&capture?.kind==='link'){
       const item=link(capture.attrs.href,capture.text);
       if(item && typeof capture.attrs.icon==='string')item.icon=model.icon(capture.attrs.icon);
       if(item&&num++<MAX_NODES)frames.at(-1).children.push(item);
       capture=null;continue;
     }
     if(/^<dl\b/.test(lower)){
       if(pending&&frames.length<MAX_DEPTH){frames.push(pending);pending=null;}
       else if(pending){pending=null;}
       else if(frames.length===1){frames.push(frames[0]);}
       continue;
     }
     if(/^<\/dl\s*>/.test(lower)){if(frames.length>1)frames.pop();pending=null;continue;}
     if(/^<dt\b/.test(lower)){pending=null;continue;}
     if(raw.startsWith('<'))continue;
     if(capture)capture.text+=raw;
   }
   return root;
 }
 function parseJson(source){
   if(typeof source!=='string'||source.length>MAX_TEXT)return [];
   let raw;try{raw=JSON.parse(source);}catch{return [];}
   let count=0;
   function convert(node,depth=0){
     if(count>=MAX_NODES||depth>=MAX_DEPTH||!node||typeof node!=='object')return null;
     const address=node.url||node.uri;
     if(typeof address==='string'){
       const item=link(address,node.name||node.title);
       if(item)count++;
       return item;
     }
     if(Array.isArray(node.children)||node.type==='text/x-moz-place-container'||node.type==='folder'||node.kind==='folder'){
       // Firefox's Places drag object can be a *reference* (GUID and ID)
       // with no children. Never import it as an incorrectly empty folder:
       // the trusted native bridge resolves only the dropped subtree.
       if(node.type==='text/x-moz-place-container'&&!Array.isArray(node.children))return null;
       count++;
       const children=(node.children||[]).map(x=>convert(x,depth+1)).filter(Boolean);
       return folder(node.name||node.title||'Imported Folder',children);
     }
     return null;
   }
   // A dragged Firefox container IS the folder. A generic export wrapper
   // is not: its children are the actual import roots.
   const isFolder=raw?.type==='text/x-moz-place-container'||raw?.type==='folder'
     || raw?.kind==='folder' || raw?.type==='container';
   const roots=Array.isArray(raw)?raw:raw?.roots?Object.values(raw.roots)
     :Array.isArray(raw?.items)?raw.items
     :Array.isArray(raw?.children)&&!isFolder?raw.children:[raw];
   return roots.flatMap(item=>{
     if(Array.isArray(item))return item.map(x=>convert(x)).filter(Boolean);
     const result=convert(item);
     return result?[result]:[];
   });
 }
 function parseUrlList(raw){
   if(typeof raw!=='string'||raw.length>MAX_TEXT)return [];
   return raw.split(/\r?\n/).map(line=>line.trim()).filter(x=>x&&!x.startsWith('#'))
     .slice(0,MAX_NODES).map(x=>link(x,'')).filter(Boolean);
 }
 function parseInternetShortcut(text){
   const match=String(text).match(/^URL\s*=\s*(.+)$/im);
   return match?parseUrlList(match[1]):[];
 }
 // Firefox native bookmark folder drags usually identify a Places node by
 // GUID/ID but do not send its descendants. Keep these references separate
 // from complete bookmark trees; only the trusted app may resolve them.
 function mozillaFolderReference(dt){
   if(!dt)return null;
   for(const type of ['text/x-moz-place','text/x-moz-place-container',
      'application/x-moz-place-container','application/x-moz-place']){
     let content='';
     try{content=dt.getData(type)||'';}catch{}
     if(!content||content.length>200000)continue;
     let parsed;try{parsed=JSON.parse(content);}catch{continue;}
     const nodes=Array.isArray(parsed)?parsed:[parsed];
     if(nodes.length!==1)continue;
     const node=nodes[0];
     if(!node||typeof node!=='object')continue;
     if(node.type!=='text/x-moz-place-container'&&node.type!=='folder')continue;
     const guid=typeof(node.itemGuid||node.guid)==='string'?(node.itemGuid||node.guid):'';
     const id=Number(node.id??node.itemId);
     const title=clean(node.title||node.name,100);
     if(!/^[a-zA-Z0-9_-]{12}$/.test(guid) && !(Number.isSafeInteger(id)&&id>0))continue;
     // The native code checks the title and GUID/ID against read-only local
     // Firefox profile databases, never trusting these values as file paths.
     return {guid:/^[a-zA-Z0-9_-]{12}$/.test(guid)?guid:'',id:Number.isSafeInteger(id)&&id>0?id:null,title};
   }
   return null;
 }
 function parseMozillaDrag(raw){
   const entries=parseJson(raw);
   if(entries.length)return entries;
   return parseUrlList(raw);
 }
 function parseTransfer(dt){
   if(!dt)return [];
   const get=type=>{try{return dt.getData(type)||'';}catch{return '';}};
   // Firefox exposes structured container JSON for bookmark-folder drags.
   for(const type of ['application/x-moz-place-container','text/x-moz-place-container','text/x-moz-place','application/x-bookmark-folder','application/json']){
     const content=get(type);if(content){
       const items=parseMozillaDrag(content);if(items.length)return items;
     }
   }
   const html=get('text/html');
   if(html){
     const items=parseHtml(html);
     if(items.length)return items;
   }
   const uri=get('text/uri-list'),plain=get('text/plain'),moz=get('text/x-moz-url');
   if(uri){const items=parseUrlList(uri);if(items.length)return items;}
   if(moz){
     const lines=moz.split(/\r?\n/);
     const item=link(lines[0],lines[1]);
     if(item)return [item];
   }
   if(plain){
     const items=parseUrlList(plain);
     if(items.length)return items;
     if(plain.trim().startsWith('{')||plain.trim().startsWith('['))return parseJson(plain);
   }
   return [];
 }
 function parseFile(name,text){
   const lower=String(name).toLowerCase();
   if(lower.endsWith('.html')||lower.endsWith('.htm'))return parseHtml(text);
   if(lower.endsWith('.json'))return parseJson(text);
   if(lower.endsWith('.url'))return parseInternetShortcut(text);
   if(lower.endsWith('.txt'))return parseUrlList(text);
   return [];
 }
 return {parseHtml,parseJson,parseTransfer,parseFile,parseUrlList,parseMozillaDrag,mozillaFolderReference,link};
});
