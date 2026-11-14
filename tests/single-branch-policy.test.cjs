'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('Windows release source is exclusively main',()=>{
 const s=read('.github/workflows/native-windows.yml');
 assert.match(s,/branches: \[main\]/);
 assert.doesNotMatch(s,/tags: \['v\*'\]/);
 assert.match(s,/if: github.ref == 'refs\/heads\/main'/);
});
test('central archiver rejects non-main build runs',()=>{
 const s=read('.github/workflows/publish-current-portable.yml');
 assert.match(s,/test "\$BRANCH" = "main"/);
 assert.match(s,/github.event.workflow_run.head_branch == 'main'/);
 assert.doesNotMatch(s,/Windows preview branches are allowed/);
});
test('branch cleanup can archive unique commits before removing refs',()=>{
 const s=read('.github/workflows/single-main-branch.yml');
 const history=JSON.parse(read('docs/retired-branches-2026-11-14.json'));
 assert.equal(history.canonical_branch,'main');
 assert.equal(history.retired_branches.length,21);
 for(const token of ['create:','schedule:','refs/tags/$tag','git/refs/heads/'])
   assert.ok(s.includes(token),'Missing '+token);
});
test('automatic branch spawners and obsolete publisher are disabled',()=>{
 assert.equal(fs.existsSync(path.join(root,'.github/dependabot.yml')),false);
 assert.equal(fs.existsSync(path.join(root,'.github/workflows/publish-portable-release.yml')),false);
});
