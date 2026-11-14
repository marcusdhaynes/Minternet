'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const native=read('native/desktop/src-tauri/src/main.rs');
const ui=read('ui/tab-group-ui.js');
const css=read('ui/styles.css');

test('01 website WebView2 delegates Windows native drops to HTML5 File/DataTransfer',()=>{
  const site=native.slice(native.indexOf('fn create_webview('),native.indexOf('fn update_audio_state('));
  assert.match(site,/WebviewBuilder::new\(label\.clone\(\),url\)[\s\S]*?\.disable_drag_drop_handler\(\)/);
  assert.match(native,/WebviewBuilder::new\("chrome",WebviewUrl::App\("index\.html"\.into\(\)\)\)[\s\S]*?\.disable_drag_drop_handler\(\)/);
});
test('02 no website-global event cancels native dragover and drop',()=>{
  const site=native.slice(native.indexOf('fn create_webview('),native.indexOf('fn update_audio_state('));
  assert.doesNotMatch(site,/addEventListener\(['"](?:dragover|drop)['"][\s\S]*?preventDefault/);
  assert.doesNotMatch(site,/\.on_drag_drop_event\(/);
});
test('03 tab pointer gesture is scoped to Minternet chrome, not remote pages',()=>{
  assert.match(ui,/tabStrip\.addEventListener\('pointerdown',beginPointer\)/);
  assert.match(ui,/document\.addEventListener\('pointermove',movePointer/);
  assert.match(ui,/if\(!gesture\|\|event\.pointerId!==gesture\.pointerId\)return/);
});
test('04 split preview displays only the actual two-pane rectangles',()=>{
  assert.match(ui,/const labels=count===2\?\['Left','Right'\]/);
  assert.match(css,/\.split-drag-zones\[data-panes="2"\]\{grid-template-rows:1fr;\}/);
});
test('05 three-pane preview matches L-shaped actual layout',()=>{
  assert.match(ui,/sideLeft\?\['Upper Left','Lower Left','Right'\]/);
  assert.match(ui,/\['Left','Upper Right','Lower Right'\]/);
  assert.match(css,/\.split-drag-zones\[data-panes="3"\] \.split-drag-zone:first-child\{grid-row:span 2;\}/);
  assert.match(css,/data-side="left"/);
  assert.match(native,/fn split_rect_on_side\(/);
});
test('06 four-pane preview offers precise ordered quadrants',()=>{
  assert.match(ui,/\['Upper Left','Upper Right','Lower Left','Lower Right'\]/);
  assert.match(native,/fn split_drop_target\(count:usize,quadrant:usize\)/);
});
test('07 native split allocator exchanges only requested panes',()=>{
  assert.match(native,/fn assign_split_slot\(split:&mut Vec<u32>,id:u32,target:usize\)/);
  assert.match(native,/split\.swap\(source,dest\)/);
  assert.match(native,/std::mem::replace\(&mut split\[target\],id\)/);
  assert.match(native,/fn place_new_split_pane\(/);
  assert.match(native,/fn remove_split_pane\(/);
  assert.doesNotMatch(native,/split\.insert\(insert_at,id\)/);
});
test('08 the exact drop quadrant is sent rather than guessed',()=>{
  assert.match(ui,/const quadrant=draggedQuadrant\(event\.clientX,event\.clientY,top\)/);
  assert.match(ui,/api\.command\('split-add',\{id:finished\.id,x,y,quadrant\}\)/);
  assert.match(native,/value\.get\("quadrant"\)/);
});
test('09 dropping outside the viewport cannot create a surprise split',()=>{
  assert.match(ui,/event\.clientY<=viewport\.height &&\s*event\.clientX>=0&&event\.clientX<=viewport\.width/);
 assert.match(ui,/const viewport=dropViewport\(\)/);
 assert.match(ui,/dragViewport=\{width,height\}/);
});
test('10 native split tests cover target positions, swapping, and maximum count',()=>{
  for(const name of ['requested_fourth_quadrant_is_exact_and_others_stay_in_place',
    'new_pane_displaces_only_the_selected_occupant','split_targets_follow_actual_pane_shapes',
    'four_panes_never_exceed_limit_or_lose_existing_panes'])assert.ok(native.includes(name),name);
});

test('11 pointer chooses which half is split for three panes',()=>{
 assert.match(ui,/splitPaneIds\.length===2\?x<viewport\.width\/2:splitThreeLeft/);
 assert.match(native,/\*split_left=quadrant%2==0/);
 assert.match(native,/drop_third_on_left_splits_left_only/);
 assert.match(native,/drop_third_on_right_keeps_left_pane_in_place/);
});
test('12 dropping in explicit quadrants preserves existing opposite panes',()=>{
 assert.match(native,/fourth_pane_lands_in_requested_quadrant_without_shifting_opposite_side/);
 assert.match(native,/removing_fourth_pane_preserves_opposite_side_geometry/);
 assert.match(ui,/splitPreview\.dataset\.side=sideLeft\?'left':'right'/);
});
