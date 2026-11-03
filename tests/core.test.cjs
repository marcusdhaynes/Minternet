'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { navigateTarget, isSafePageUrl, isHttpPageUrl } = require('../src/core/url.cjs');
const { createTab, replacePrivacy } = require('../src/core/tab-model.cjs');

test('direct addresses use HTTPS while free text searches', () => {
  assert.equal(navigateTarget('example.com').url, 'https://example.com/');
  assert.equal(navigateTarget('http://example.com/').url, 'http://example.com/');
  assert.equal(navigateTarget('http://example.com/').kind, 'insecure');
  assert.equal(navigateTarget('example.com').kind, 'web');
  assert.match(navigateTarget('privacy tools').url, /duckduckgo\.com/);
});
test('dangerous URLs are rejected', () => {
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi',
    'ftp://example.com', 'chrome://settings', 'https://u:p@example.com', 'custom://payload'])
    assert.equal(navigateTarget(value).url, null, value);
  assert.equal(isSafePageUrl('http://example.com'), false);
  assert.equal(isSafePageUrl('https://example.com'), true);
  assert.equal(isHttpPageUrl('http://example.com/'), true);
  assert.equal(isHttpPageUrl('http://u:p@example.com/'), false);
  assert.equal(isHttpPageUrl('file:///tmp/x'), false);
});
test('switching privacy creates a new tab model', () => {
  const normal = createTab(1, 'https://example.com/', false);
  const priv = replacePrivacy(normal, true);
  assert.equal(priv.private, true);
  assert.equal(priv.url, normal.url);
  assert.notEqual(priv, normal);
  assert.equal(priv.suspended, false);
});
