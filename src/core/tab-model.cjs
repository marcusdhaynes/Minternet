'use strict';
function createTab(id, url = 'about:blank', isPrivate = false) {
  return { id, url, title: 'New Tab', private: Boolean(isPrivate), loading: false,
    canBack: false, canForward: false, error: '' };
}
function replacePrivacy(tab, toPrivate) {
  return createTab(tab.id, tab.url, toPrivate);
}
function sanitizeTab(tab) {
  return { id: tab.id, title: String(tab.title).slice(0, 160),
    url: tab.url, private: tab.private, loading: tab.loading,
    canBack: tab.canBack, canForward: tab.canForward, error: tab.error };
}
module.exports = { createTab, replacePrivacy, sanitizeTab };
