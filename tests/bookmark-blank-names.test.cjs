'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../ui/bookmark-model.js');
const ui = fs.readFileSync(path.join(__dirname, '../ui/bookmark-ui.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');

function editorHarness() {
  const data = model.blank();
  const fields = {
    bookmarkParent: {value:model.BOOKMARK_BAR_ID},
    bookmarkName: {value:''},
    bookmarkUrl: {value:'https://example.com/'}
  };
  let saves = 0, closes = 0;
  const context = {
    model, data, customIcon:'', draft:null,
    $: id => fields[id],
    persist: () => { saves++; },
    closeOverlay: () => { closes++; },
    toast: message => { throw new Error(message); }
  };
  const start = ui.indexOf('  function saveEditor(event) {');
  const end = ui.indexOf('  function deleteEditor()', start);
  assert.ok(start >= 0 && end > start, 'bookmark editor save function exists');
  const saveEditor = vm.runInNewContext('(' + ui.slice(start, end).trim() + ')', context);
  return {data, fields, context, save:() => saveEditor({preventDefault(){}}),
    get saves(){return saves;},get closes(){return closes;}};
}

test('clearing the Name field on an existing bookmark saves the empty string', () => {
  const h = editorHarness();
  const bookmark = model.add(h.data,'link',null,{name:'Old site name',url:'https://example.com/'});
  h.context.draft={kind:'link',id:bookmark.id,parentId:model.BOOKMARK_BAR_ID};
  h.save();
  assert.equal(model.find(h.data,bookmark.id).name,'');
  assert.equal(h.saves,1);
  assert.equal(h.closes,1);
  assert.equal(model.byUrl(model.hydrate(JSON.stringify(h.data)),bookmark.url).name,'');
});

test('creating a bookmark with an empty Name field stays unnamed after hydration', () => {
  const h = editorHarness();
  h.context.draft={kind:'link',id:null,parentId:model.BOOKMARK_BAR_ID};
  h.save();
  const bookmark=model.byUrl(h.data,'https://example.com/');
  assert.ok(bookmark);
  assert.equal(bookmark.name,'');
  assert.equal(model.byUrl(model.hydrate(JSON.stringify(h.data)),bookmark.url).name,'');
});

test('editing an unnamed bookmark does not prefill its Name with the website title', () => {
  const start=ui.indexOf('  function openEditor(');
  const end=ui.indexOf('  function isDescendant(',start);
  assert.ok(start>=0 && end>start);
  const editor=ui.slice(start,end);
  assert.match(editor,/\$\('bookmarkName'\)\.value\s*=\s*node\s*\?\s*node\.name\s*:/);
  assert.doesNotMatch(editor,/node\?\.name\s*\|\|/);
  assert.match(editor,/\$\('bookmarkName'\)\.value\s*=\s*node\s*\?\s*node\.name\s*:\s*''/);
  assert.doesNotMatch(editor,/currentTitle\s*&&/);
});

test('unnamed bookmarks keep icon-only Bookmark Bar rendering and an optional Name field', () => {
  const start=ui.indexOf('  function renderBar()');
  const end=ui.indexOf('  function renderStar()',start);
  assert.ok(start>=0 && end>start);
  const bar=ui.slice(start,end);
  assert.match(bar,/if\s*\(item\.name\)\s*\{/);
  assert.match(html,/Name <small>\(optional\)<\/small><input id="bookmarkName"/);
});
