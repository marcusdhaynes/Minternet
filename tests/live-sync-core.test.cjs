'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const sync=require('../ui/live-sync-core.js');
const wire=require('../ui/live-sync-transport.js');
const crypto=webcrypto;
const user='39e50c06-d6dc-4715-8221-efda98dc7b6b';

test('Cross-platform AES-256-GCM payloads are authenticated and bound to item key',async()=>{
 const a=await sync.derive('correct horse battery staple #4529',user,crypto.subtle);
 const b=await sync.derive('correct horse battery staple #4529',user,crypto.subtle);
 const original={url:'https://example.org/',pinned:true,groupId:null,syncId:'f'.repeat(32)};
 const encoded=await sync.encrypt('tab','f'.repeat(32),original,a,crypto.subtle,crypto);
 assert.match(encoded,/^enc1:[\w-]+\.[\w-]+$/);
 assert.deepEqual(await sync.decrypt('tab','f'.repeat(32),encoded,b,crypto.subtle),original);
 await assert.rejects(sync.decrypt('tab','a'.repeat(32),encoded,b,crypto.subtle));
 const c=await sync.derive('a different secret passphrase 987',user,crypto.subtle);
 await assert.rejects(sync.decrypt('tab','f'.repeat(32),encoded,c,crypto.subtle));
});
test('Per-entity snapshot excludes private tabs and private/Tor-only groups',async()=>{
 const items=await sync.makeRecords({
  tabs:[
    {id:1,syncId:'a'.repeat(32),url:'https://example.org',title:'Public'},
    {id:2,syncId:'b'.repeat(32),url:'https://secret.org',private:true},
    {id:3,syncId:'c'.repeat(32),url:'https://hidden.onion',isTor:true}],
  groups:[{id:'public',name:'Research'},{id:'private',name:'Hidden'}],
  assignments:{'1':'public','2':'private','3':'private'},
  bookmarks:{items:[]},logins:[],cards:[]
 },crypto.subtle);
 assert.equal([...items.values()].filter(v=>v.kind==='tab').length,1);
 const serialized=JSON.stringify([...items.values()]);
 assert.ok(!serialized.includes('secret.org'));
 assert.ok(!serialized.includes('hidden.onion'));
 assert.ok(!serialized.includes('Hidden'));
});
test('Secrets have independent identities and latest server revision wins',async()=>{
 const map=await sync.makeRecords({tabs:[],groups:[],
  logins:[{origin:'https://example.org',username:'alice',password:'old'},
          {origin:'https://example.org',username:'bob',password:'other'}],
  cards:[{id:'123456789012345678901234',number:'4111111111111111',month:1,year:2030}]},crypto.subtle);
 assert.equal([...map.values()].filter(x=>x.kind==='login').length,2);
 assert.equal([...map.values()].filter(x=>x.kind==='payment').length,1);
 const older={revision:109,server_at:'2026-11-05T02:00:00.000Z',ciphertext:'old'};
 const newer={revision:110,server_at:'2026-11-05T02:00:00.000Z',ciphertext:'new'};
 assert.equal(sync.decide(older,newer),newer);
 assert.equal(sync.decide(newer,older),newer);
});
test('Bookmark data can be reconstructed after tombstone deletion',()=>{
 const records=[
   {kind:'bookmark',deleted:false,value:{id:'f',kind:'folder',name:'Work',parent:null,index:0}},
   {kind:'bookmark',deleted:false,value:{id:'a',kind:'link',name:'Home',url:'https://example.org/',parent:'f',index:1}},
   {kind:'bookmark',deleted:true,value:{id:'b',kind:'link',name:'Old',url:'https://old.example/',parent:'f',index:2}}
 ];
 const tree=sync.buildBookmarkTree(records);
 assert.equal(tree.items.length,1);
 assert.equal(tree.items[0].children.length,1);
 assert.equal(tree.items[0].children[0].name,'Home');
});
test('Cloud transport requires HTTPS Supabase project and never polls for sync',()=>{
 assert.equal(wire.safeProject('https://dedicated.supabase.co'), 'https://dedicated.supabase.co');
 assert.throws(()=>wire.safeProject('http://dedicated.supabase.co'));
 assert.throws(()=>wire.safeProject('https://someone.example.org'));
 const script=fs.readFileSync(path.join(__dirname,'../ui/google-sync-ui.js'),'utf8');
 assert.doesNotMatch(script,/google-drive-(pull|push)/);
 assert.doesNotMatch(script,/setInterval\s*\([^)]*syncOnce/);
 const transport=fs.readFileSync(path.join(__dirname,'../ui/live-sync-transport.js'),'utf8');
 assert.match(transport,/WebSocket/);
 assert.match(transport,/socket\.onmessage/);
});
