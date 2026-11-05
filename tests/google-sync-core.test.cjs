'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const s=require('../ui/google-sync-core.js');
test('Google sync never includes private or Tor tabs or private-only groups',()=>{
 const tabs=[
   {id:1,url:'https://example.com/',private:false,pinned:true},
   {id:2,url:'https://secret.example/',private:true},
   {id:3,url:'https://hidden.onion/',tor:true},
   {id:4,url:'https://mail.example.com/',private:false}
 ];
 const groups=[{id:'regular',name:'Work'},{id:'private',name:'Secret'}];
 const assignments={'1':'regular','2':'private','3':'private','4':'regular'};
 const state=s.snapshot({visible:true,items:[]},{groups,assignments},{tabs});
 assert.equal(state.tabs.length,2);
 assert.deepEqual(state.tabs.map(t=>t.url),['https://example.com/','https://mail.example.com/']);
 assert.deepEqual(state.groups.map(g=>g.id),['regular']);
 assert.equal(JSON.stringify(state).includes('secret.example'),false);
 assert.equal(JSON.stringify(state).includes('hidden.onion'),false);
});
test('invalid and credential-bearing URLs are never synchronized',()=>{
 assert.equal(s.safeUrl('https://u:p@example.com'),null);
 assert.equal(s.safeUrl('http://example.com'),null);
 assert.equal(s.safeUrl('https://foo.onion'),null);
 assert.equal(s.safeUrl('https://example.com/path'),'https://example.com/path');
});
test('bookmark merge preserves local and cloud branches without duplicates',()=>{
 const cloud={visible:true,items:[{id:'folder',kind:'folder',name:'Work',children:[
   {id:'1',kind:'link',url:'https://example.com'}]}]};
 const local={visible:true,items:[{id:'folder',kind:'folder',name:'Work',children:[
   {id:'2',kind:'link',url:'https://another.example'}]}]};
 const merged=s.mergeBookmarks(local,cloud);
 assert.equal(merged.items[0].children.length,2);
 assert.equal(cloud.items[0].children.length,1);
});
test('remote sync payload does not accept Tor or unsafe urls',()=>{
 const data=s.validate({version:1,bookmarks:{items:[]},groups:[],tabs:[
   {url:'https://a.example/'},{url:'file:///secret'},{url:'https://foo.onion/'}
 ]});
 assert.deepEqual(data.tabs.map(t=>t.url),['https://a.example/']);
});