'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const b = require('../ui/bookmark-model.js');

test('nested unnamed folders and emoji icons survive serialization', () => {
 const s=b.blank(), root=b.add(s,'folder',null,{name:'',icon:'🌌'});
 const child=b.add(s,'folder',root.id,{name:'',icon:'🪐'});
 const link=b.add(s,'link',child.id,{name:'Example',url:'https://example.com'});
 assert.equal(b.find(s,child.id).name,'');
 assert.equal(b.location(s,link.id).parent.id,child.id);
 assert.equal(b.hydrate(JSON.stringify(s)).items[0].children[0].icon,'🪐');
 assert.equal(b.folders(s).length,2);
});
test('rejects unsafe bookmark URLs and injected icons',()=>{
 const s=b.blank();
 assert.equal(b.add(s,'link',null,{url:'javascript:alert(1)'}),null);
 assert.equal(b.add(s,'link',null,{url:'http://example.com'}),null);
 assert.equal(b.add(s,'link',null,{url:'https://u:p@example.com'}),null);
 assert.equal(b.icon('data:image/svg+xml;base64,PHN2Zz4='),'');
 assert.equal(b.url('https://example.com/path'),'https://example.com/path');
});
test('rejects moving folder into its own descendants',()=>{
 const s=b.blank(),a=b.add(s,'folder',null,{name:'A'}),c=b.add(s,'folder',a.id,{name:'C'});
 assert.equal(b.move(s,a.id,c.id),false);
 assert.equal(b.move(s,c.id,null),true);
 assert.equal(b.folders(s).length,2);
 assert.equal(b.location(s,c.id).parent,null);
});
test('bookmark editing, deletion, URL matching',()=>{
 const s=b.blank(),l=b.add(s,'link',null,{url:'https://example.com',name:'old'});
 assert.equal(b.update(s,l.id,{name:'new',url:'https://example.org'}),true);
 assert.equal(b.byUrl(s,'https://example.org').name,'new');
 assert.equal(b.remove(s,l.id),true);
 assert.equal(b.count(s),0);
});
test('normalizes corrupt JSON and strips unsafe imported data',()=>{
 assert.equal(b.hydrate('{bad').items.length,0);
 const state=b.hydrate({visible:false,items:[{id:'a',kind:'link',url:'data:text/html,test'},{id:'b',kind:'folder',name:'',children:[]}]});
 assert.equal(state.visible,false);
 assert.equal(state.items.length,1);
});

test('bookmark favicon uses only its own secure website origin',()=>{
 assert.equal(b.favicon('https://example.com/folder/page?token=private#hash'),
   'https://example.com/favicon.ico');
 assert.equal(b.favicon('https://sub.example.com:8443/path'),
   'https://sub.example.com:8443/favicon.ico');
 assert.equal(b.favicon('http://example.com'),null);
 assert.equal(b.favicon('https://name:secret@example.com/path'),null);
 assert.equal(b.favicon('javascript:alert(1)'),null);
});
test('existing bookmarks without custom icons retain URL for automatic favicon display',()=>{
 const s=b.hydrate({visible:true,items:[
   {id:'old',kind:'link',name:'Home',url:'https://example.org/home'}
 ]});
 assert.equal(s.items[0].icon,'');
 assert.equal(b.favicon(s.items[0].url),'https://example.org/favicon.ico');
 const custom=b.add(s,'link',null,{url:'https://example.com',icon:'🌟'});
 assert.equal(custom.icon,'🌟');
});
