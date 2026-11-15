'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'..','native/desktop/src-tauri/src/site_context_menu.rs'),'utf8');
test('a generic "Spellcheck" is never passed to Minternet as a purported correction',()=>{
 assert.match(src,/fn has_generic_spellcheck/);
 assert.match(src,/looks_like_spellcheck\(&name\)\|\|looks_like_spellcheck\(&label\)/);
 assert.match(src,/compact=="spellcheck"/);
 assert.match(src,/let label=read_string\(\|p\|unsafe\{item.Label\(p\)\}\)/);
 const block=src.slice(src.indexOf('// A stable WebView2 spellcheck command'),src.indexOf('let request_id=NEXT_REQUEST'));
 assert.match(block,/has_generic_spellcheck\(&items,0\)/);
 assert.match(block,/args\.SetHandled\(false\)/);
 assert.match(block,/return Ok\(\(\)\)/);
 assert.ok(block.indexOf('args.SetHandled(false)')<block.indexOf('args.SetHandled(true)'));
});
test('all other context commands retain original exact WebView2 command IDs',()=>{
 assert.match(src,/pending\.args\.SetSelectedCommandId\(id\)/);
 assert.match(src,/pending\.allowed\.contains\(id\)/);
 assert.match(src,/item_tree\(&items,&mut allowed,0\)/);
});
