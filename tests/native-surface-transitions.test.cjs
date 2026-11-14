'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const source = readFileSync(join(__dirname, '../native/desktop/src-tauri/src/main.rs'), 'utf8');
function body(start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, 'expected native browser functions');
  return source.slice(begin, finish);
}
test('surface restore preserves a live WebView2 frame rather than hiding or showing it', () => {
  const recovery = body('fn restore_visible_surfaces(', 'fn display_active(');
  assert.doesNotMatch(recovery, /\.hide\(\)|\.show\(\)|invalidate_layout\(app\)/);
  assert.match(recovery, /notify_native_compositor\(&view\)/);
});
test('tab transition shows the next surface before hiding the previous one', () => {
  const active = body('fn display_active(', 'fn is_real_page_url(');
  assert.ok(active.indexOf('for label in &to_show') < active.indexOf('for label in &to_hide'));
  assert.doesNotMatch(active, /view\.set_zoom\(/);
});
test('a failed show cannot replace the working frame or poison the visibility cache', () => {
  const active = body('fn display_active(', 'fn is_real_page_url(');
  assert.match(active, /if view\.show\(\)\.is_ok\(\)/);
  assert.match(active, /if ready\s*\{[\s\S]*?for label in &to_hide/);
  assert.match(active, /cache\.shown=actual/);
  assert.doesNotMatch(active, /state\.shown=targets\.clone\(\)/);
});
test('real resize invalidates bounds cache and repaints through the compositor', () => {
  const handler = body('window.on_window_event(move |event|', '.run(tauri::generate_context!())');
  assert.match(handler, /WindowEvent::Resized/);
  assert.match(handler, /invalidate_layout\(&callback_app\);\s*refresh_layout\(&callback_app\)/);
  assert.match(handler, /WindowEvent::Moved/);
  assert.match(source, /NotifyParentWindowPositionChanged\(\)/);
});
