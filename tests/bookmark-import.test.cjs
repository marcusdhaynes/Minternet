'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const imp=require('../ui/bookmark-import.js');
const model=require('../ui/bookmark-model.js');

test('Chromium/Firefox exported Netscape HTML retains nested bookmark folders',()=>{
 const html=`<!DOCTYPE NETSCAPE-Bookmark-file-1><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
 <DL><p><DT><H3 ADD_DATE="12">Research &amp; Work</H3><DL><p>
 <DT><A HREF="https://example.com/docs" ADD_DATE="1">Reference</A>
 <DT><H3>Other</H3><DL><p><DT><A HREF="https://example.org/">Site</A></DL><p>
 </DL><p></DL><p>`;
 const parsed=imp.parseHtml(html);
 assert.equal(parsed.length,1);
 assert.equal(parsed[0].name,'Research & Work');
 assert.equal(parsed[0].children.length,2);
 assert.equal(parsed[0].children[0].url,'https://example.com/docs');
 assert.equal(parsed[0].children[1].children[0].url,'https://example.org/');
});
test('Firefox Places drag with nested children creates full folder hierarchy',()=>{
 const transfer={'application/x-moz-place-container':JSON.stringify({
   type:'text/x-moz-place-container',title:'Bookmarks',children:[
     {type:'text/x-moz-place',title:'Article',uri:'https://example.com/news'},
     {type:'text/x-moz-place-container',title:'Subfolder',children:[
       {uri:'https://example.net/',title:'Network'}]}
   ]
 })};
 const items=imp.parseTransfer({types:Object.keys(transfer),getData:type=>transfer[type]||''});
 assert.equal(items.length,1);
 assert.equal(items[0].children[1].children[0].name,'Network');
});
test('Chrome JSON export and Safari HTML both parse without executing embedded markup',()=>{
 const exported=JSON.stringify({roots:{
   bookmark_bar:{type:'folder',name:'Bookmarks bar',children:[
     {type:'url',name:'Welcome',url:'https://example.com/'}]},
   other:{type:'folder',name:'Other bookmarks',children:[
     {type:'folder',name:'Nested',children:[{type:'url',url:'https://example.org/'}]}]}
 }});
 const items=imp.parseFile('Bookmarks.json',exported);
 assert.equal(items.length,2);
 assert.equal(items[1].children[0].children[0].url,'https://example.org/');
 const html='<a href="https://example.com/path">Safe <img src=x onerror=alert(1)> Link</a>';
 assert.equal(imp.parseTransfer({getData:t=>t==='text/html'?html:''})[0].name,'Safe Link');
});
test('Windows internet shortcuts and Ctrl-drag URLs import correctly',()=>{
 assert.equal(imp.parseFile('Saved.url','[InternetShortcut]\nURL=https://example.com/')[0].url,'https://example.com/');
 assert.equal(imp.parseTransfer({getData:t=>t==='text/x-moz-url'?'https://example.org/\nMozilla':''})[0].name,'Mozilla');
 assert.equal(imp.parseTransfer({getData:t=>t==='text/uri-list'?'#comment\nhttps://example.net/':''})[0].url,'https://example.net/');
});
test('External HTML keeps HTTP/HTTPS while rejecting scripts, local files and credential URLs',()=>{
 const data=imp.parseHtml(`<DL><DT><A HREF="javascript:alert(1)">Unsafe</A>
 <DT><A HREF="file:///etc/passwd">Local</A>
 <DT><A HREF="http://example.com/">HTTP</A>
 <DT><A HREF="https://user:password@example.com/">Credentials</A>
 <DT><A HREF="https://safe.example.com/">Good</A></DL>`);
 assert.equal(data.length,2);
 assert.equal(data[0].url,'http://example.com/');
 assert.equal(data[1].url,'https://safe.example.com/');
 assert.equal(model.url(data[1].url),data[1].url);
});

test('dragged folder remains a single folder including every nested bookmark',()=>{
 const payload=JSON.stringify({
   type:'text/x-moz-place-container',title:'Imported Work',
   children:[{type:'text/x-moz-place',title:'Inbox',uri:'https://mail.example.org/'},
     {type:'text/x-moz-place-container',title:'Projects',children:[
       {type:'text/x-moz-place',title:'Repository',uri:'https://code.example.org/repo'}]}]
 });
 const items=imp.parseTransfer({types:['application/x-moz-place-container','text/uri-list'],
    getData:type=>type==='application/x-moz-place-container'?payload:'https://flattened.invalid'});
 assert.equal(items.length,1);
 assert.equal(items[0].kind,'folder');
 assert.equal(items[0].name,'Imported Work');
 assert.equal(items[0].children[1].kind,'folder');
 assert.equal(items[0].children[1].children[0].url,'https://code.example.org/repo');
});
test('HTML bookmark export retains a safe explicitly chosen icon',()=>{
 const items=imp.parseHtml('<DL><DT><H3>Folder</H3><DL><DT><A HREF="https://example.com/" ICON="data:image/png;base64,iVBORw0KGgo=">Site</A></DL></DL>');
 assert.equal(items.length,1);
 assert.equal(items[0].kind,'folder');
 assert.equal(items[0].children[0].icon,'data:image/png;base64,iVBORw0KGgo=');
});

test('Firefox metadata-only folder drag resolves by GUID and does not create empty folder',()=>{
 const record=JSON.stringify({type:'text/x-moz-place-container',title:'Imported Work',
   itemGuid:'AbCdE123_-45',id:541});
 const transfer={
   types:['text/x-moz-place'],
   getData:type=>type==='text/x-moz-place'?record:''
 };
 assert.deepEqual(imp.parseTransfer(transfer),[]);
 assert.deepEqual(imp.mozillaFolderReference(transfer),{
   guid:'AbCdE123_-45',id:541,title:'Imported Work'
 });
});
test('Malformed Firefox folder reference is ignored',()=>{
 const data=JSON.stringify({type:'text/x-moz-place-container',title:'Fake',itemGuid:'../etc',id:0});
 const transfer={getData:type=>type==='text/x-moz-place'?data:''};
 assert.equal(imp.mozillaFolderReference(transfer),null);
});
test('Complete drag keeps folder with children; no unrelated flattened links',()=>{
 const record=JSON.stringify({type:'text/x-moz-place-container',title:'Recipes',children:[
    {type:'text/x-moz-place',title:'Potatoes',uri:'https://example.org/potatoes'},
    {type:'text/x-moz-place-container',title:'Rice',children:[
      {type:'text/x-moz-place',title:'Fried Rice',uri:'https://example.org/rice'}
    ]}
  ]});
 const items=imp.parseTransfer({types:['text/x-moz-place','text/uri-list'],
   getData:type=>type==='text/x-moz-place'?record:'https://wrong.example.org/'});
 assert.equal(items.length,1);
 assert.equal(items[0].name,'Recipes');
 assert.equal(items[0].children[1].name,'Rice');
 assert.equal(items[0].children[1].children[0].name,'Fried Rice');
});
