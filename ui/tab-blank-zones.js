'use strict';
// Pure tab-strip gap geometry shared by the native and web title bars.
// Only the actual unused space between the last visible tab/group and +
// receives split behavior; rendered tabs and buttons remain interactive.
(function (root) {
  function actionForPoint(x, start, end) {
    if (![x, start, end].every(Number.isFinite) || end <= start ||
        x < start || x >= end) return null;
    return x < start + (end - start) / 2 ? 'new' : 'maximize';
  }

  function actionFromRects(x, strip, newTab, children = []) {
    if (!strip || !newTab ||
        ![strip.left, strip.right, newTab.left].every(Number.isFinite) ||
        strip.right < strip.left) return null;
    let gapStart = strip.left;
    for (const rect of children) {
      if (!rect || ![rect.left, rect.right, rect.width, rect.height].every(Number.isFinite) ||
          rect.width <= 0 || rect.height <= 0 ||
          rect.left >= strip.right || rect.right <= strip.left) continue;
      gapStart = Math.max(gapStart, Math.min(rect.right, strip.right));
    }
    return actionForPoint(x, gapStart, newTab.left);
  }

  const api = Object.freeze({ actionForPoint, actionFromRects });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MinternetTabBlankZones = api;
})(typeof window !== 'undefined' ? window : null);
