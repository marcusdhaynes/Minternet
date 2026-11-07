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
 assert.equal(b.hydrate(JSON.stringify(s)).items[0].children[0].children[0].icon,'🪐');
 assert.equal(b.folders(s).length,3);
});
test('rejects unsafe bookmark URLs and injected icons',()=>{
 const s=b.blank();
 assert.equal(b.add(s,'link',null,{url:'javascript:alert(1)'}),null);
 assert.equal(b.add(s,'link',null,{url:'http://example.com'}).url,'http://example.com/');
 assert.equal(b.add(s,'link',null,{url:'https://u:p@example.com'}),null);
 assert.equal(b.icon('data:image/svg+xml;base64,PHN2Zz4='),'');
 assert.equal(b.url('https://example.com/path'),'https://example.com/path');
});
test('rejects moving folder into its own descendants',()=>{
 const s=b.blank(),a=b.add(s,'folder',null,{name:'A'}),c=b.add(s,'folder',a.id,{name:'C'});
 assert.equal(b.move(s,a.id,c.id),false);
 assert.equal(b.move(s,c.id,null),true);
 assert.equal(b.folders(s).length,3);
 assert.equal(b.location(s,c.id).parent.id,b.BOOKMARK_BAR_ID);
});
test('bookmark editing, deletion, URL matching',()=>{
 const s=b.blank(),l=b.add(s,'link',null,{url:'https://example.com',name:'old'});
 assert.equal(b.update(s,l.id,{name:'new',url:'https://example.org'}),true);
 assert.equal(b.byUrl(s,'https://example.org').name,'new');
 assert.equal(b.remove(s,l.id),true);
 assert.equal(b.count(s),0);
});
test('normalizes corrupt JSON and strips unsafe imported data',()=>{
 assert.equal(b.hydrate('{bad').items.length,1);
 const state=b.hydrate({visible:false,items:[{id:'a',kind:'link',url:'data:text/html,test'},{id:'b',kind:'folder',name:'',children:[]}]});
 assert.equal(state.visible,false);
 assert.equal(state.items.length,1);
 assert.equal(state.items[0].name,'Bookmark Bar');
 assert.equal(state.items[0].children.length,1);
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
 assert.equal(s.items[0].children[0].icon,'');
 assert.equal(b.favicon(s.items[0].children[0].url),'https://example.org/favicon.ico');
 const custom=b.add(s,'link',null,{url:'https://example.com',icon:'🌟'});
 assert.equal(custom.icon,'🌟');
});

test('folder icons can copy HTTPS favicons, emojis and uploaded image data safely',()=>{
 const s=b.blank(),folder=b.add(s,'folder',null,{name:'Projects'});
 const link=b.add(s,'link',folder.id,{url:'https://docs.example.org/page',icon:'🌿'});
 const icon=b.favicon(link.url);
 assert.equal(icon,'https://docs.example.org/favicon.ico');
 assert.equal(b.update(s,folder.id,{icon}),true);
 assert.equal(b.hydrate(JSON.stringify(s)).items[0].children[0].icon,icon);
 assert.equal(b.update(s,folder.id,{icon:link.icon}),true);
 assert.equal(b.find(s,folder.id).icon,'🌿');
 assert.equal(b.icon('https://u:secret@example.com/favicon.ico'),'');
 assert.equal(b.icon('http://example.org/favicon.ico').startsWith('http://'),true);
 const tinyPng='data:image/png;base64,iVBORw0KGgo=';
 assert.equal(b.update(s,folder.id,{icon:tinyPng}),true);
 assert.equal(b.find(s,folder.id).icon,tinyPng);
});


test('no duplicate website bookmarks across root, folders, edits or drops',()=>{
 const s=b.blank();
 const folder=b.add(s,'folder',null,{name:'Research'});
 const first=b.add(s,'link',null,{url:'https://example.com',name:'One'});
 assert.ok(first);
 assert.equal(b.add(s,'link',folder.id,{url:'https://example.com/',name:'Duplicate'}),null);
 assert.equal(b.count(s),2);
 const second=b.add(s,'link',folder.id,{url:'https://example.org/',name:'Two'});
 assert.equal(b.update(s,second.id,{url:'https://example.com/'}),false);
 assert.equal(b.find(s,second.id).url,'https://example.org/');
 const restored=b.hydrate(JSON.stringify({...s,items:[
   ...s.items,{id:'legacy',kind:'link',name:'Legacy',url:'https://example.com/'}
 ]}));
 assert.equal(b.count(restored),3);
});
test('site favicons are restricted to HTTPS and do not reveal credentials',()=>{
 assert.equal(b.favicon('https://example.org/article'),'https://example.org/favicon.ico');
 assert.equal(b.favicon('http://example.org/article'),null);
 assert.equal(b.favicon('https://user:secret@example.org/'),null);
});

test('Bookmark Bar is a permanent real folder with automatic legacy migration',()=>{
 const legacy={visible:true,items:[
   {id:'saved',kind:'link',name:'Saved',url:'https://youtube.com/watch?v=123'},
   {id:'project',kind:'folder',name:'Projects',icon:'🌿',
      children:[{id:'nested',kind:'link',name:'Nested',url:'https://example.com/deep'}]}
 ]};
 const moved=b.hydrate(legacy),bar=b.barFolder(moved);
 assert.equal(moved.items.length,1);
 assert.equal(bar.name,'Bookmark Bar');
 assert.deepEqual(bar.children.map(x=>x.id),['saved','project']);
 assert.equal(b.location(moved,'saved').parent.id,b.BOOKMARK_BAR_ID);
 assert.equal(b.location(moved,'nested').parent.id,'project');
 assert.equal(b.remove(moved,b.BOOKMARK_BAR_ID),false);
 assert.equal(b.update(moved,b.BOOKMARK_BAR_ID,{name:'Other'}),false);
 assert.equal(b.move(moved,b.BOOKMARK_BAR_ID,'project'),false);
 const copy=b.hydrate(JSON.stringify(moved));
 assert.equal(copy.items.length,1);
 assert.equal(copy.items[0].children.length,2);
 assert.equal(copy.items[0].children[0].id,'saved');
 const link=b.add(copy,'link',null,{name:'New',url:'https://example.org/'});
 assert.equal(b.location(copy,link.id).parent.id,b.BOOKMARK_BAR_ID);
 assert.equal(b.byUrl(copy,'https://youtube.com/watch?v=123').id,'saved');
});


test('drag ordering moves original bar folders and links without touching contents',()=>{
 const s=b.blank();
 const a=b.add(s,'folder',null,{name:'A',icon:'🌌'});
 const link=b.add(s,'link',null,{name:'Google',url:'https://google.com/'});
 const bFolder=b.add(s,'folder',null,{name:'B',icon:'🌿'});
 const c=b.add(s,'folder',null,{name:'C'});
 const nested=b.add(s,'folder',a.id,{name:'Inside A'});
 const page=b.add(s,'link',nested.id,{name:'Preserved',url:'https://example.org/private'});
 const ids=()=>b.barItems(s).map(x=>x.id);
 assert.deepEqual(ids(),[a.id,link.id,bFolder.id,c.id]);

 // Drop C before A, then A after B, then the web link between two folders.
 assert.equal(b.reorderBar(s,c.id,a.id,false),true);
 assert.deepEqual(ids(),[c.id,a.id,link.id,bFolder.id]);
 assert.equal(b.reorderBar(s,a.id,bFolder.id,true),true);
 assert.deepEqual(ids(),[c.id,link.id,bFolder.id,a.id]);
 assert.equal(b.reorderBar(s,link.id,a.id,false),true);
 assert.deepEqual(ids(),[c.id,bFolder.id,link.id,a.id]);

 // Dropping onto the same item or the adjacent position is a no-op.
 assert.equal(b.reorderBar(s,a.id,a.id,true),false);
 assert.equal(b.reorderBar(s,bFolder.id,link.id,false),false);
 assert.deepEqual(ids(),[c.id,bFolder.id,link.id,a.id]);

 // Dropping at the end works, including after the rightmost item.
 assert.equal(b.reorderBar(s,c.id),true);
 assert.deepEqual(ids(),[bFolder.id,link.id,a.id,c.id]);
 assert.equal(b.reorderBar(s,c.id),false);

 // Root and nested entries must not be moved by bar-only drop operations.
 assert.equal(b.reorderBar(s,b.BOOKMARK_BAR_ID,a.id,true),false);
 assert.equal(b.reorderBar(s,nested.id,a.id,true),false);
 assert.equal(b.reorderBar(s,a.id,nested.id,true),false);
 assert.equal(b.reorderBar(s,a.id,'does-not-exist',true),false);
 assert.equal(b.find(s,page.id).url,'https://example.org/private');
 assert.equal(b.location(s,nested.id).parent.id,a.id);
 assert.equal(b.find(s,a.id).icon,'🌌');
 assert.equal(b.count(s),6);
 const restored=b.hydrate(JSON.stringify(s));
 assert.deepEqual(b.barItems(restored).map(x=>x.id),ids());
 assert.equal(b.location(restored,page.id).parent.id,nested.id);
});

test('atomic moves preserve nested folders, sibling order, and reject descendant moves',()=>{
 const s=b.blank(),a=b.add(s,'folder',null,{name:'A'}),z=b.add(s,'folder',null,{name:'Z'});
 const l=b.add(s,'link',a.id,{name:'first',url:'https://example.com/1'});
 const n=b.add(s,'folder',a.id,{name:'nested'});
 const nested=b.add(s,'link',n.id,{name:'inner',url:'https://example.com/inside'});
 const l2=b.add(s,'link',a.id,{name:'second',url:'https://example.com/2'});
 assert.equal(b.moveMany(s,[l.id,l2.id],z.id),true);
 assert.deepEqual(b.find(s,z.id).children.map(x=>x.id),[l.id,l2.id]);
 assert.equal(b.moveMany(s,[n.id],z.id,l.id,false),true);
 assert.deepEqual(b.find(s,z.id).children.map(x=>x.id),[n.id,l.id,l2.id]);
 assert.equal(b.location(s,nested.id).parent.id,n.id);
 const before=JSON.stringify(s);
 assert.equal(b.moveMany(s,[z.id],n.id),false);
 assert.equal(b.moveMany(s,[z.id,n.id],a.id),false);
 assert.equal(b.moveMany(s,[b.BOOKMARK_BAR_ID],a.id),false);
 assert.equal(b.moveMany(s,[l.id],z.id,'invalid'),false);
 assert.equal(JSON.stringify(s),before);
 assert.equal(b.moveMany(s,[l2.id],z.id,n.id,true),true);
 assert.deepEqual(b.find(s,z.id).children.map(x=>x.id),[n.id,l2.id,l.id]);
 assert.deepEqual(b.find(b.hydrate(JSON.stringify(s)),z.id).children.map(x=>x.id),[n.id,l2.id,l.id]);
});
