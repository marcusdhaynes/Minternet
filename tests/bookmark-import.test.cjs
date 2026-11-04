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
test('External HTML is never trusted: javascript, file, http and credential URLs rejected',()=>{
 const data=imp.parseHtml(`<DL><DT><A HREF="javascript:alert(1)">Unsafe</A>
 <DT><A HREF="file:///etc/passwd">Local</A>
 <DT><A HREF="http://example.com/">HTTP</A>
 <DT><A HREF="https://user:password@example.com/">Credentials</A>
 <DT><A HREF="https://safe.example.com/">Good</A></DL>`);
 assert.equal(data.length,1);
 assert.equal(data[0].url,'https://safe.example.com/');
 assert.equal(model.url(data[0].url),data[0].url);
});
