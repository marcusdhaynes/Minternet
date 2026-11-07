'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { actionForPoint, actionFromRects } = require('../ui/tab-blank-zones.js');

const rect = (left, right, height = 20) => ({ left, right, width: right - left, height });

test('empty tab strip gap is divided exactly into two invisible double-click zones', () => {
  const strip = rect(48, 1000);
  const plus = rect(1003, 1023);
  const tabs = [rect(48, 98), rect(99, 149)];
  assert.equal(actionFromRects(149, strip, plus, tabs), 'new');
  assert.equal(actionFromRects(575, strip, plus, tabs), 'new');
  assert.equal(actionFromRects(576, strip, plus, tabs), 'maximize');
  assert.equal(actionFromRects(999, strip, plus, tabs), 'maximize');
  assert.equal(actionFromRects(1003, strip, plus, tabs), null);
  assert.equal(actionFromRects(125, strip, plus, tabs), null);
});

test('last group chip and collapsed/hidden tabs define the actual blank area', () => {
  const strip = rect(40, 900);
  const plus = rect(903, 923);
  const items = [rect(40, 92), rect(94, 150), rect(150, 150, 0)];
  assert.equal(actionFromRects(151, strip, plus, items), 'new');
  assert.equal(actionFromRects(527, strip, plus, items), 'maximize');
  assert.equal(actionFromRects(100, strip, plus, items), null);
});

test('empty tab strip and crowded scrollable strip remain well-defined', () => {
  assert.equal(actionFromRects(80, rect(40, 1000), rect(1003, 1023), []), 'new');
  assert.equal(actionFromRects(950, rect(40, 1000), rect(1003, 1023), []), 'maximize');
  const overflowing = [rect(700, 1025)];
  assert.equal(actionFromRects(970, rect(40, 1000), rect(1003, 1023), overflowing), null);
  assert.equal(actionFromRects(1001, rect(40, 1000), rect(1003, 1023), overflowing), 'new');
});

test('invalid positions do not trigger a tab or window action', () => {
  assert.equal(actionForPoint(5, 10, 20), null);
  assert.equal(actionForPoint(20, 10, 20), null);
  assert.equal(actionForPoint(NaN, 10, 20), null);
  assert.equal(actionFromRects(20, null, rect(50, 70), []), null);
});

test('HTML loads the geometry helper before the existing title bar handler', () => {
  const ui = path.join(__dirname, '..', 'ui');
  const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ui, 'app.js'), 'utf8');
  const helperIndex = html.indexOf('src="./tab-blank-zones.js"');
  const appIndex = html.indexOf('src="./app.js"');
  assert.ok(helperIndex >= 0 && helperIndex < appIndex);
  assert.match(app, /MinternetTabBlankZones\.actionFromRects/);
  assert.match(app, /api\.command\(action\|\|'maximize'\)/);
});
