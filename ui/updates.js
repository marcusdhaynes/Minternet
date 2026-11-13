/* Uniform auto-update system — see updates/UPDATES_SPEC.md.
   Shared module: latest-release check + Updates section + update ribbon.
   Ribbon: thin, top-center, neutral/theme-aware; the ribbon itself is the
   button (click = update); its × dismisses that version permanently. */
(function () {
  'use strict';
  var REPO = 'marcusdhaynes/Minternet';
  var CURRENT_VERSION = '0.1.0';
  // Dismissal is persisted PER VERSION: localStorage key
  // `updates:dismissed:<version>` — that version's ribbon never reappears.
  function dismissedKey(version) { return 'updates:dismissed:' + version; }

  function parseSemver(v) {
    return String(v).replace(/^v/i, '').split('.').map(function (p) { return parseInt(p, 10) || 0; });
  }
  function isNewer(candidate, current) {
    var a = parseSemver(candidate), b = parseSemver(current);
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var d = (a[i] || 0) - (b[i] || 0);
      if (d !== 0) return d > 0;
    }
    return false;
  }
  function checkForUpdate() {
    return fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (!data || !data.tag_name || !isNewer(data.tag_name, CURRENT_VERSION)) return null;
      var asset = Array.isArray(data.assets) && data.assets[0];
      return {
        version: String(data.tag_name).replace(/^v/i, ''),
        tag: String(data.tag_name),
        notes: String(data.body || ''),
        url: String(data.html_url || ''),
        downloadUrl: (asset && asset.browser_download_url) || data.html_url || null,
      };
    });
  }
  function isDismissed(version) {
    try { return localStorage.getItem(dismissedKey(version)) !== null; } catch (e) { return false; }
  }
  function dismissVersion(version) {
    try { localStorage.setItem(dismissedKey(version), '1'); } catch (e) { /* ignore */ }
  }
  function applyUpdate(info) {
    // Web: open the release asset/page, then refresh to the new deployed
    // version. APK/native builds hand the download to the platform
    // installer; Android still requires the user's install tap.
    if (info.downloadUrl) window.open(info.downloadUrl, '_blank', 'noopener');
    window.location.reload();
  }

  function renderSection(el, info, status) {
    el.innerHTML = '';
    var title = document.createElement('h2'); title.textContent = 'Updates'; el.appendChild(title);
    var cur = document.createElement('p'); cur.textContent = 'Current version: v' + CURRENT_VERSION; el.appendChild(cur);
    var avail = document.createElement('p');
    avail.textContent = 'Available version: ' + (info ? 'v' + info.version : '—'); el.appendChild(avail);
    if (info && info.notes) {
      var h = document.createElement('h3'); h.textContent = "What's New"; el.appendChild(h);
      var pre = document.createElement('pre'); pre.style.whiteSpace = 'pre-wrap'; pre.textContent = info.notes; el.appendChild(pre);
    }
    if (status) { var s = document.createElement('p'); s.setAttribute('role', 'status'); s.textContent = status; el.appendChild(s); }
    var row = document.createElement('div');
    var check = document.createElement('button'); check.type = 'button'; check.textContent = 'Check for updates';
    check.addEventListener('click', function () { mountSection(el); });
    row.appendChild(check);
    if (info) {
      var upd = document.createElement('button'); upd.type = 'button';
      upd.textContent = 'Update to v' + info.version;
      upd.addEventListener('click', function () { applyUpdate(info); });
      row.appendChild(upd);
    }
    el.appendChild(row);
  }
  function mountSection(el) {
    renderSection(el, null, 'Checking…');
    checkForUpdate().then(function (info) {
      renderSection(el, info, info ? '' : 'You are up to date.');
    }).catch(function () { renderSection(el, null, 'Could not check for updates.'); });
  }

  function mountRibbon(info) {
    if (document.getElementById('museUpdateRibbon')) return;
    var ribbon = document.createElement('div');
    ribbon.id = 'museUpdateRibbon';
    ribbon.setAttribute('role', 'button');
    ribbon.setAttribute('aria-label', 'Update available, version ' + info.version + '. Activate to update.');
    ribbon.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;' +
      'display:flex;align-items:center;gap:8px;padding:3px 6px 3px 12px;border-radius:999px;' +
      'font-size:12px;line-height:1.4;background:rgba(127,127,127,.16);' +
      'border:1px solid rgba(127,127,127,.35);backdrop-filter:blur(6px);cursor:pointer;';
    var label = document.createElement('span');
    label.textContent = 'Update available · v' + info.version;
    var close = document.createElement('button');
    close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss this update');
    close.style.cssText = 'background:none;border:none;color:inherit;cursor:pointer;padding:0 4px;font-size:12px;';
    close.addEventListener('click', function (e) {
      e.stopPropagation(); dismissVersion(info.version); ribbon.remove();
    });
    ribbon.appendChild(label); ribbon.appendChild(close);
    ribbon.addEventListener('click', function () { applyUpdate(info); });
    document.body.appendChild(ribbon);
  }

  window.MuseUpdates = {
    CURRENT_VERSION: CURRENT_VERSION,
    checkForUpdate: checkForUpdate,
    applyUpdate: applyUpdate,
    mountSection: mountSection,
    mountRibbon: mountRibbon,
  };

  // Live wiring entry point: a no-op on pages without the mount points.
  function init() {
    var section = document.getElementById('updatesSection');
    if (section) mountSection(section);
    checkForUpdate().then(function (info) {
      if (info && !isDismissed(info.version)) mountRibbon(info);
    }).catch(function () { /* silent */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
