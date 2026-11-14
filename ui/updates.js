/* Uniform auto-update system — see updates/UPDATES_SPEC.md.
   Shared module: latest-release check + Updates section + update ribbon.
   Ribbon: thin, top-center, neutral/theme-aware; the ribbon itself is the
   button (click = update); its × dismisses that version permanently. */
(function () {
  'use strict';
  var REPO = 'marcusdhaynes/Minternet';
  // Always prefer the compiled native version/build identity. The fallback
  // supports the static web preview; never display the old hardcoded v0.1.0.
  var CURRENT_VERSION = '0.3.0';
  var CURRENT_BUILD = '';
  var pendingCheck = null;
  var lastCheck = null;
  var lastCheckTime = 0;
  function dismissedKey(version) { return 'updates:dismissed:' + version; }
  function parseSemver(v) {
    return String(v).replace(/^v/i, '').split('.').map(function(p) { return parseInt(p,10)||0; });
  }
  function isNewer(candidate,current) {
    var a=parseSemver(candidate),b=parseSemver(current);
    for(var i=0;i<Math.max(a.length,b.length);i++){
      var d=(a[i]||0)-(b[i]||0);
      if(d!==0)return d>0;
    }
    return false;
  }
  function applyInstalled(info) {
    if(!info||typeof info.version!=='string')return;
    CURRENT_VERSION=info.version;
    CURRENT_BUILD=info.buildId && info.buildId!=='0' ? String(info.buildId) : '';
    if(window.MuseUpdates){
      window.MuseUpdates.CURRENT_VERSION=CURRENT_VERSION;
      window.MuseUpdates.CURRENT_BUILD=CURRENT_BUILD;
    }
  }
  function normalizedRelease(release) {
    if(release?.draft || !/^minternet-build-\d+$/.test(release?.tag_name||''))return null;
    var assets=Array.isArray(release.assets)?release.assets:[];
    var asset=assets.find(function(a){
      return /^Minternet-.*\.exe$/i.test(a.name||'') &&
        !/setup/i.test(a.name||'') &&
        /^https:\/\/github\.com\/marcusdhaynes\/Minternet\/releases\/download\//.test(a.browser_download_url||'');
    });
    if(!asset)return null;
    var version=(release.name||'').match(/v(\d+\.\d+\.\d+)/);
    var next=version?version[1]:CURRENT_VERSION;
    var build=Number((release.tag_name||'').replace('minternet-build-',''));
    if(!Number.isSafeInteger(build)||build<=0)return null;
    if(CURRENT_BUILD && build<=Number(CURRENT_BUILD))return null;
    if(!CURRENT_BUILD && !isNewer(next,CURRENT_VERSION) && next!==CURRENT_VERSION)return null;
    return {version:next,buildId:String(build),tag:release.tag_name,
      notes:release.body||'',url:release.html_url,
      downloadUrl:asset.browser_download_url};
  }
  function queryReleases(){
    if(window.__TAURI__ && window.minternet?.command){
      return window.minternet.command('updates-check').then(function(result){
        if(result?.message)throw Error(result.message);
        applyInstalled(result?.installed);
        return result?.update||null;
      });
    }
    return fetch('https://api.github.com/repos/'+REPO+'/releases?per_page=30',{
      headers:{Accept:'application/vnd.github+json'}
    }).then(function(res){
      if(!res.ok)throw Error('Release check failed: HTTP '+res.status);
      return res.json();
    }).then(function(list){
      if(!Array.isArray(list))throw Error('Invalid release list');
      return list.map(normalizedRelease).filter(Boolean)
        .sort(function(a,b){return Number(b.buildId)-Number(a.buildId);})[0]||null;
    });
  }
  function checkForUpdate(force) {
    var now=Date.now();
    if(pendingCheck)return pendingCheck;
    if(!force && lastCheck && now-lastCheckTime<30000)return Promise.resolve(lastCheck);
    pendingCheck=queryReleases().then(function(info){
      lastCheck=info;lastCheckTime=Date.now();
      return info;
    }).finally(function(){pendingCheck=null;});
    return pendingCheck;
  }
  function isDismissed(version) {
    try { return localStorage.getItem(dismissedKey(version)) !== null; } catch (e) { return false; }
  }
  function dismissVersion(version) {
    try { localStorage.setItem(dismissedKey(version), '1'); } catch (e) { /* ignore */ }
  }
  function applyUpdate(info) {
    // Updates are explicit: open the verified GitHub release in a new tab
    // for the user to download. Never reload a live session or silently
    // replace the running EXE.
    if(!info?.url?.startsWith('https://github.com/marcusdhaynes/Minternet/releases/'))return;
    if(window.__TAURI__ && window.minternet?.command){
      window.minternet.command('new-url',info.url).catch(function(){
        window.open(info.url,'_blank','noopener');
      });
    }else window.open(info.url,'_blank','noopener');
  }

  // Render using the same small, native-style rows as other Settings
  // accordions. No standalone headers or unbounded raw release-note blocks.
  function renderSection(el, info, status, checking) {
    el.replaceChildren();
    var infoGrid = document.createElement('div');
    infoGrid.className = 'updates-versions';
    function versionRow(label, value) {
      var row = document.createElement('div');
      row.className = 'updates-version-row';
      var caption = document.createElement('span');
      caption.textContent = label;
      var number = document.createElement('strong');
      number.textContent = value;
      row.append(caption, number);
      return row;
    }
    infoGrid.appendChild(versionRow('Installed Version', 'v' + CURRENT_VERSION + (CURRENT_BUILD ? ' · build ' + CURRENT_BUILD : '')));
    if (info) infoGrid.appendChild(versionRow('Available Version', 'v' + info.version + (info.buildId ? ' · build ' + info.buildId : '')));
    el.appendChild(infoGrid);

    var updateStatus = document.createElement('div');
    updateStatus.className = 'updates-current-status';
    updateStatus.setAttribute('role', 'status');
    updateStatus.setAttribute('aria-live', 'polite');
    updateStatus.textContent = status ||
      (info ? 'A newer version is available.' : 'No newer version found.');
    updateStatus.dataset.state = checking ? 'checking' : (info ? 'available' :
      (status && status.toLowerCase().includes('could not') ? 'error' : 'current'));
    el.appendChild(updateStatus);

    if (info && info.notes) {
      var notes = document.createElement('details');
      notes.className = 'updates-release-notes';
      var summary = document.createElement('summary');
      summary.textContent = "What's New";
      var text = document.createElement('p');
      text.textContent = info.notes;
      notes.append(summary, text);
      el.appendChild(notes);
    }
    var actions = document.createElement('div');
    actions.className = 'updates-actions';
    var check = document.createElement('button');
    check.type = 'button';
    check.className = 'updates-check-button';
    check.textContent = checking ? 'Checking…' : 'Check for Updates';
    check.disabled = Boolean(checking);
    check.addEventListener('click', function () { mountSection(el); });
    actions.appendChild(check);
    if (info) {
      var update = document.createElement('button');
      update.type = 'button';
      update.className = 'updates-install-button';
      update.textContent = 'Get v' + info.version;
      update.addEventListener('click', function () { applyUpdate(info); });
      actions.appendChild(update);
    }
    el.appendChild(actions);
  }
  function mountSection(el) {
    renderSection(el, null, 'Checking for updates…', true);
    checkForUpdate(true).then(function (info) {
      renderSection(el, info, info ? 'A newer version is available.' : 'No newer release found.', false);
    }).catch(function (error) {
      var message=String(error?.message||'Network unavailable').slice(0,160);
      renderSection(el,null,'Could not check updates: '+message,false);
    });
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
