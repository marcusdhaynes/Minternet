'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const importFile=require('../ui/bookmark-import.js');
const bookmarks=require('../ui/bookmark-model.js');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('bookmark browser exports flatten only the actual toolbar root',()=>{
 const html='<DL><p><DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Bar</H3><DL><p>'+
  '<DT><H3>Work</H3><DL><p><DT><A HREF="https://one.example/">One</A>'+
  '<DT><H3>Deep</H3><DL><p><DT><A HREF="https://two.example/">Two</A></DL></DL>'+
  '<DT><A HREF="https://three.example/">Three</A></DL>'+
  '<DT><H3>Other Bookmarks</H3><DL><p><DT><A HREF="https://other.example/">Other</A></DL></DL>';
 const entries=importFile.parseHtml(html);
 const roots=importFile.normalizeBrowserRoots(entries);
 assert.deepEqual(roots.map(x=>x.name),['Work','Three','Other Bookmarks']);
 assert.equal(roots[0].children[1].children[0].url,'https://two.example/');
 assert.equal(roots[2].children[0].url,'https://other.example/');
 // A user-created folder called Work must not be flattened.
 assert.equal(importFile.normalizeBrowserRoots([{kind:'folder',name:'Work',children:[]}]).length,1);
});
test('Firefox and Chromium exported JSON roots preserve nested descendants',()=>{
 const input=JSON.stringify({roots:{
  bookmark_bar:{type:'folder',name:'Bookmarks toolbar',children:[
   {type:'folder',name:'A',children:[{type:'folder',name:'B',
    children:[{type:'url',name:'C',url:'https://nested.example/'}]}]}]},
  other:{type:'folder',name:'Other bookmarks',children:[{type:'url',url:'https://other.example/',name:'Other'}]}
 }});
 const result=importFile.normalizeBrowserRoots(importFile.parseFile('bookmarks.json',input));
 assert.equal(result[0].name,'A');
 assert.equal(result[0].children[0].name,'B');
 assert.equal(result[0].children[0].children[0].name,'C');
 assert.equal(result[1].name,'Other bookmarks');
});
test('settings exposes direct native file picker and explicit non-destructive default',()=>{
 const html=read('ui/index.html');
 const sections=read('ui/settings-sections.js');
 const ui=read('ui/bookmark-ui.js');
 assert.match(html,/id="importBookmarksFile"/);
 assert.match(html,/id="bookmarkImportMode"/);
 assert.match(html,/<option value="merge" selected>/);
 assert.match(html,/<option value="replace">Replace Bookmark Bar/);
 assert.match(sections,/move\(imports,'importBookmarksFile','\.bookmark-import-settings'\)/);
 assert.match(ui,/addEventListener\('change',async event=>\{/);
 assert.match(ui,/imported\.normalizeBrowserRoots\(parsed\)/);
 assert.match(ui,/appendImported\(normalized,model\.BOOKMARK_BAR_ID,replacement\)/);
 assert.match(ui,/const draftState=replaceBar\?model\.blank\(\):model\.hydrate/);
 assert.match(ui,/data=draftState;\s*persist\(\)/);
 assert.match(ui,/if\(JSON\.stringify\(draftState\)\.length>950000\)/);
});
