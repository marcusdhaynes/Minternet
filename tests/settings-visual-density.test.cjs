'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');

const sections=read('ui/settings-sections.js');
const updateCode=read('ui/updates.js');
const html=read('ui/index.html');
const css=read('ui/styles.css');
const extCode=read('ui/extensions-ui.js');

test('General starts collapsed and Updates is a real Settings accordion',()=>{
  assert.match(sections,/const general=section\('General'\);/);
  assert.doesNotMatch(sections,/section\('General',sections,true\)/);
  assert.match(sections,/const updates=section\('Updates'\);/);
  assert.match(sections,/move\(updates,'updatesSection'\)/);
  assert.match(html,/id="updatesSection"/);
  assert.match(sections,/detail\.open=open/);
  assert.ok(sections.indexOf("section('Updates')")>sections.indexOf("section('Accounts & Sync')"));
});
test('Updates renders compact native-style rows and collapsed notes',()=>{
  assert.match(updateCode,/updates-versions/);
  assert.match(updateCode,/updates-version-row/);
  assert.match(updateCode,/updates-current-status/);
  assert.match(updateCode,/updates-actions/);
  assert.match(updateCode,/updates-release-notes/);
  assert.match(updateCode,/document\.createElement\('details'\)/);
  assert.doesNotMatch(updateCode,/document\.createElement\('h2'\)/);
  assert.doesNotMatch(updateCode,/document\.createElement\('pre'\)/);
  assert.match(css,/\.bookmark-settings \.updates-settings/);
  assert.match(css,/\.bookmark-settings \.updates-versions/);
  assert.match(css,/\.bookmark-settings \.updates-actions/);
});
test('Extensions context menu is less than 310px wide while retaining equal square sources',()=>{
  assert.match(css,/\.extensions-popup\s*\{[\s\S]*?width:min\(306px/);
  assert.doesNotMatch(css,/width:min\(490px/);
  assert.match(css,/\.extensions-source-card\s*\{[\s\S]*?aspect-ratio:1/);
  assert.match(css,/\.extensions-card-half\s*\{[\s\S]*?flex:1 1 50%/);
  assert.match(extCode,/const width=panel\.getBoundingClientRect\(\)\.width\|\|306/);
  assert.match(html,/<details class="extensions-explainer">/);
  assert.match(html,/<summary>Compatibility &amp; Privacy<\/summary>/);
  assert.match(html,/id="extensionsInstalled"/);
  assert.match(html,/data-extension-import="minternet"/);
  assert.match(html,/data-extension-import="firefox"/);
  assert.match(html,/data-extension-import="chrome"/);
});
