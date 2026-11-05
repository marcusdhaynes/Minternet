'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const m=require('../ui/tab-group-model.js');
test('create, rename, color, membership, visibility, collapse',()=>{
  const s=m.blank(),g=m.create(s,{name:'Research',color:'teal'});
  assert.ok(g.id);
  assert.equal(m.assign(s,2,g.id),true);
  assert.equal(m.findTab(s,2).name,'Research');
  assert.equal(m.update(s,g.id,{visible:false}),true);
  assert.equal(m.isVisibleTab(s,2),false);
  assert.equal(m.visibleFallback(s,[{id:1},{id:2}],2),1);
  m.update(s,g.id,{visible:true,collapsed:true,name:'Work'});
  assert.equal(m.isVisibleTab(s,2),false);
  assert.equal(m.get(s,g.id).name,'Work');
});
test('save definitions without stale native tab IDs',()=>{
  const s=m.blank(),g=m.create(s,{name:'🛡 Privacy',color:'slate'});
  m.assign(s,1,g.id);
  const stored=m.serialize(s),restored=m.hydrate(stored);
  assert.equal(restored.groups.length,1);
  assert.equal(m.findTab(restored,1),undefined);
  assert.deepEqual(Object.keys(restored.assignments),[]);
  assert.equal(restored.groups[0].name,'🛡 Privacy');
});
test('delete group unassigns tabs but does not close native tabs',()=>{
  const s=m.blank(),g=m.create(s,{name:'Work'});
  m.assign(s,1,g.id);m.assign(s,2,g.id);
  assert.equal(m.remove(s,g.id),true);
  assert.equal(m.findTab(s,1),undefined);
  assert.equal(m.findTab(s,2),undefined);
  assert.equal(m.isVisibleTab(s,1),true);
});
test('prune disappeared tabs and reject malformed data',()=>{
 const s=m.hydrate({groups:[{id:'groupA',name:'hello',color:'unknown',visible:false},{id:'groupA',name:'duplicate'}]});
 assert.equal(s.groups.length,1);
 assert.equal(s.groups[0].color,'violet');
 assert.equal(m.assign(s,4,'missing'),false);
 assert.equal(m.assign(s,4,'groupA'),true);
 m.prune(s,[1,3]);
 assert.equal(m.findTab(s,4),undefined);
 assert.equal(m.hydrate('nonsense').groups.length,0);
});
test('invisible group does not remove ungrouped tabs',()=>{
 const s=m.blank(),g=m.create(s,{name:'A',color:'pink'});
 m.assign(s,2,g.id);m.update(s,g.id,{visible:false});
 assert.equal(m.visibleFallback(s,[{id:1},{id:2},{id:3}],2),1);
 assert.equal(m.isVisibleTab(s,3),true);
});

test('drag reorder adjacent tabs and across group boundaries without closing tabs',()=>{
 const s=m.blank(),grp=m.create(s,{name:'Work'});
 m.prune(s,[1,2,3,4]);
 m.assign(s,2,grp.id);m.assign(s,3,grp.id);
 assert.equal(m.moveRelative(s,4,2,false),true);
 m.assign(s,4,grp.id);
 assert.deepEqual(m.tabsIn(s,grp.id,[{id:1},{id:2},{id:3},{id:4}]).map(t=>t.id),[4,2,3]);
 assert.equal(m.moveRelative(s,2,1,true),true);
 m.assign(s,2,null);
 assert.deepEqual(m.sortedTabs(s,[{id:1},{id:2},{id:3},{id:4}]).map(t=>t.id),[1,2,4,3]);
 assert.equal(m.findTab(s,2),undefined);
 assert.equal(m.moveRelative(s,2,2),false);
});

test('pinned tab is preferred over hidden group and no fallback is a valid tabless state',()=>{
 const s=m.blank(),g=m.create(s,{name:'Archive'});
 m.assign(s,1,g.id);m.assign(s,2,g.id);
 m.update(s,g.id,{visible:false});
 assert.equal(m.visibleFallback(s,[{id:1},{id:2}],1),null);
 assert.equal(m.visibleFallback(s,[{id:1},{id:2},{id:3,pinned:true}],1),3);
});

test('Ctrl-clicked background tab inserts immediately right of opener, not the end',()=>{
 const s=groups.blank();
 s.order=[3,1,5,2];
 assert.equal(groups.insertAfter(s,7,1),true);
 assert.deepEqual(s.order,[3,1,7,5,2]);
 assert.equal(groups.insertAfter(s,8,7),true);
 assert.deepEqual(s.order,[3,1,7,8,5,2]);
 assert.equal(groups.insertAfter(s,9,12345),false);
});
