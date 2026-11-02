'use strict';
const SEARCH = 'https://duckduckgo.com/?q=';
const FORBIDDEN = /^(?:javascript|data|file|chrome|devtools|about|blob|ftp|ws|wss):/i;
function navigateTarget(input) {
  const text = String(input ?? '').trim();
  if (!text) return { kind: 'blank', url: 'about:blank' };
  if (FORBIDDEN.test(text)) return { kind: 'blocked', url: null };
  if (/^[a-z][\w+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return { kind: 'blocked', url: null };
  const likelyHost = /^(?:localhost|(?:[a-z\d-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i.test(text);
  const candidate = /^https?:\/\//i.test(text) ? text : likelyHost ? 'https://' + text : null;
  if (!candidate) return { kind: 'search', url: SEARCH + encodeURIComponent(text) };
  try {
    const url = new URL(candidate);
    url.protocol = 'https:';
    if (!url.hostname || url.username || url.password) return { kind: 'blocked', url: null };
    return { kind: 'web', url: url.toString() };
  } catch { return { kind: 'blocked', url: null }; }
}
function isSafePageUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch { return false; }
}
module.exports = { navigateTarget, isSafePageUrl };
