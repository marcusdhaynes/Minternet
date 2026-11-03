'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { navigateTarget, isSafePageUrl, isHttpPageUrl } = require('./core/url.cjs');
const { createTab, replacePrivacy, sanitizeTab } = require('./core/tab-model.cjs');

app.enableSandbox();
const TOP = 52;
const FOOTER = 14;
const MAX_TABS = 35;
const tabs = [];
const preparedSessions = new WeakSet();
const GRANTABLE_PERMISSIONS = new Set(['media', 'geolocation', 'geolocation-approximate', 'notifications', 'clipboard-read', 'pointerLock', 'mediaKeySystem']);
const PRIVACY_FREE_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
const HTTP_WARNING = 'This page uses unencrypted HTTP. Anyone on the network may be able to read or alter it.';

let activeId = null;
let nextId = 1;
let mainWindow = null;
const normalSession = () => session.fromPartition('persist:minternet-normal');
const currentTab = () => tabs.find(t => t.id === activeId);

function safeOrigin(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

function lockDown(s) {
  if (preparedSessions.has(s)) return;
  preparedSessions.add(s);
  const grants = new Set();
  s.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    if (PRIVACY_FREE_PERMISSIONS.has(permission)) return true;
    const origin = safeOrigin(requestingOrigin);
    return Boolean(origin && GRANTABLE_PERMISSIONS.has(permission) && grants.has(origin + '|' + permission));
  });
  s.setPermissionRequestHandler((contents, permission, respond, details) => {
    if (PRIVACY_FREE_PERMISSIONS.has(permission)) return respond(true);
    const origin = safeOrigin(details?.requestingUrl || contents?.getURL?.());
    if (!origin || !GRANTABLE_PERMISSIONS.has(permission)) return respond(false);
    const key = origin + '|' + permission;
    if (grants.has(key)) return respond(true);
    if (!mainWindow || mainWindow.isDestroyed()) return respond(false);
    // Never persist grants: approvals end when Minternet exits (or a private session closes).
    void dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Minternet site permission',
      message: origin + ' requests ' + permission,
      detail: permission === 'media'
        ? 'This may access your camera and/or microphone. Approve only if you trust this site.'
        : 'The permission is limited to this site and the current browser session.',
      buttons: ['Deny', 'Allow for this session'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }).then(({ response }) => {
      const allowed = response === 1 && !contents.isDestroyed();
      if (allowed) grants.add(key);
      respond(allowed);
    }).catch(() => respond(false));
  });
  // Every download requires the OS save dialog; never silently write or execute files.
  s.on('will-download', (event, item) => {
    const origin = safeOrigin(item.getInitiatorOrigin?.());
    if (!origin) {
      event.preventDefault();
      return;
    }
    const name = path.basename(item.getFilename() || 'download').replace(/[\x00-\x1f]/g, '').slice(0, 180) || 'download';
    item.setSaveDialogOptions({
      title: 'Save download from ' + origin,
      defaultPath: path.join(app.getPath('downloads'), name),
      buttonLabel: 'Save'
    });
    // Electron uses its native save dialog when no save path is assigned.
    // The user can cancel; nothing is ever opened automatically.
  });
}

function bounds() {
  const [width, height] = mainWindow.getContentSize();
  return { x: 0, y: TOP, width: Math.max(1, width), height: Math.max(1, height - TOP - FOOTER) };
}

function emitState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('minternet:state', {
    tabs: tabs.map(sanitizeTab),
    activeId,
    extensionsCount: normalSession().extensions.getAllExtensions().length,
    platform: process.platform,
    maximized: mainWindow.isMaximized()
  });
}

function redraw() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const tab of tabs) {
    if (tab.view && mainWindow.contentView.children.includes(tab.view))
      mainWindow.contentView.removeChildView(tab.view);
  }
  const active = currentTab();
  if (active?.view && active.url !== 'about:blank') {
    mainWindow.contentView.addChildView(active.view);
    active.view.setBounds(bounds());
  }
  emitState();
}

function refresh(tab) {
  if (!tab?.view || tab.view.webContents.isDestroyed()) return;
  const wc = tab.view.webContents;
  if (isSafePageUrl(wc.getURL())) tab.url = wc.getURL();
  tab.loading = wc.isLoading();
  tab.canBack = wc.navigationHistory.canGoBack();
  tab.canForward = wc.navigationHistory.canGoForward();
  const title = wc.getTitle();
  if (title) tab.title = String(title).slice(0, 160);
  emitState();
}

function keyHandler(event, input) {
  if (input.type !== 'keyDown') return;
  const mod = process.platform === 'darwin' ? input.meta : input.control;
  const key = String(input.key).toLowerCase();
  if (mod && key === 'l') {
    event.preventDefault();
    mainWindow.webContents.focus();
    mainWindow.webContents.send('minternet:focus-address');
    return;
  }
  if (mod && key === 't') { event.preventDefault(); addTab(false); return; }
  if (mod && input.shift && key === 'p') { event.preventDefault(); addTab(true); return; }
  if (mod && key === 'w') { event.preventDefault(); closeTab(); return; }
  const active = currentTab();
  const wc = active?.view?.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (mod && key === 'r') { event.preventDefault(); wc.reload(); return; }
  if (input.alt && key === 'left' && wc.navigationHistory.canGoBack()) {
    event.preventDefault(); wc.navigationHistory.goBack();
  }
  if (input.alt && key === 'right' && wc.navigationHistory.canGoForward()) {
    event.preventDefault(); wc.navigationHistory.goForward();
  }
}

function makeView(tab) {
  const s = tab.private ? session.fromPartition('private-' + crypto.randomUUID()) : normalSession();
  lockDown(s);
  const view = new WebContentsView({
    webPreferences: {
      session: s,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: true
    }
  });
  tab.view = view;
  const wc = view.webContents;
  wc.setWindowOpenHandler(details => {
    // Sandboxed, HTTPS-only popup windows enable common login/authentication flows.
    if (!isSafePageUrl(details.url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 780, height: 680, minWidth: 340, minHeight: 260,
        autoHideMenuBar: true, backgroundColor: '#0b101c',
        webPreferences: {
          session: s, sandbox: true, nodeIntegration: false,
          contextIsolation: true, webSecurity: true,
          allowRunningInsecureContent: false, backgroundThrottling: true
        }
      }
    };
  });
  wc.on('did-create-window', child => {
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (event, url) => {
      if (!isSafePageUrl(url)) event.preventDefault();
    });
    child.webContents.on('will-redirect', (event, url) => {
      if (!isSafePageUrl(url)) event.preventDefault();
    });
  });
  wc.on('before-input-event', keyHandler);
  const rejectNavigation = (event, url) => {
    if (!isSafePageUrl(url) && !(
      /^http:\/\//i.test(url) &&
      isHttpPageUrl(url) &&
      tab.allowedHttpOrigin === new URL(url).origin
    )) {
      event.preventDefault();
      tab.error = 'Blocked unsafe navigation. To open an HTTP site, explicitly enter its http:// URL.';
      emitState();
    }
  };
  wc.on('will-navigate', rejectNavigation);
  wc.on('will-redirect', rejectNavigation);
  wc.on('did-start-loading', () => { tab.loading = true; emitState(); });
  wc.on('did-stop-loading', () => refresh(tab));
  wc.on('did-navigate', () => { tab.error = ''; refresh(tab); });
  wc.on('did-navigate-in-page', () => refresh(tab));
  wc.on('page-title-updated', (_event, title) => { tab.title = String(title).slice(0, 160); emitState(); });
  wc.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (code !== -3 && mainFrame) {
      tab.error = String(description).slice(0, 160);
      if (isSafePageUrl(url)) tab.url = url;
      emitState();
    }
  });
  wc.on('render-process-gone', () => { tab.error = 'Web page stopped unexpectedly'; emitState(); });
}

async function navigate(tab, input) {
  const dest = navigateTarget(input);
  if (!dest.url) {
    tab.error = 'Blocked unsafe URL';
    emitState();
    return;
  }
  if (dest.kind === 'insecure') {
    const origin = new URL(dest.url).origin;
    if (tab.allowedHttpOrigin !== origin) {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Insecure HTTP connection',
        message: 'Open ' + origin + ' over HTTP?',
        detail: HTTP_WARNING + '\\n\\nUse HTTPS whenever possible.',
        buttons: ['Cancel', 'Open HTTP'],
        defaultId: 0,
        cancelId: 0
      });
      if (choice.response !== 1 || !tabs.includes(tab)) return;
      tab.allowedHttpOrigin = origin;
    }
  }
  tab.error = '';
  if (dest.kind === 'blank') {
    const oldView = tab.view;
    if (oldView && mainWindow.contentView.children.includes(oldView))
      mainWindow.contentView.removeChildView(oldView);
    tab.view = null;
    tab.allowedHttpOrigin = null;
    if (oldView && !oldView.webContents.isDestroyed()) oldView.webContents.close();
    tab.url = 'about:blank';
    tab.title = 'New Tab';
    tab.loading = false;
    redraw();
    return;
  }
  if (!tab.view) makeView(tab);
  tab.url = dest.url;
  tab.title = new URL(dest.url).hostname;
  tab.suspended = false;
  redraw();
  try { await tab.view.webContents.loadURL(dest.url); }
  catch (err) { tab.error = 'Navigation failed: ' + String(err.message).slice(0, 120); emitState(); }
}

function addTab(privateMode = false, url = 'about:blank') {
  if (tabs.length >= MAX_TABS) return;
  const tab = createTab(nextId++, 'about:blank', privateMode);
  // Blank tabs are lightweight models until they are actually navigated.
  tab.view = null;
  tab.allowedHttpOrigin = null;
  tab.suspended = false;
  tabs.push(tab);
  activeId = tab.id;
  redraw();
  if (url !== 'about:blank') void navigate(tab, url);
}

function closeTab(id = activeId) {
  const index = tabs.findIndex(t => t.id === id);
  if (index < 0) return;
  const [tab] = tabs.splice(index, 1);
  if (tab.view && mainWindow.contentView.children.includes(tab.view))
    mainWindow.contentView.removeChildView(tab.view);
  if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  if (activeId === id) activeId = (tabs[Math.min(index, tabs.length - 1)] || {}).id || null;
  if (!tabs.length) addTab();
  else redraw();
}

function changePrivacy() {
  const old = currentTab();
  if (!old) return;
  const index = tabs.indexOf(old);
  const replacement = replacePrivacy(old, !old.private);
  // Session permissions and HTTP exceptions never transfer across privacy modes.
  replacement.view = null;
  replacement.allowedHttpOrigin = null;
  replacement.suspended = false;
  tabs[index] = replacement;
  if (old.view && mainWindow.contentView.children.includes(old.view))
    mainWindow.contentView.removeChildView(old.view);
  if (old.view && !old.view.webContents.isDestroyed()) old.view.webContents.close();
  redraw();
  if (replacement.url !== 'about:blank') void navigate(replacement, replacement.url);
}

async function addExtension() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose an unpacked Chromium extension directory',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, message: 'Cancelled' };
  const folder = result.filePaths[0];
  let manifest;
  try {
    const data = fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8');
    if (data.length > 200000) throw Error('Manifest exceeds size limit');
    manifest = JSON.parse(data);
    if (![2, 3].includes(manifest.manifest_version)) throw Error('Unsupported manifest version');
  } catch (err) { return { ok: false, message: 'Invalid extension: ' + err.message }; }
  const grants = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Extension permissions',
    message: 'Install ' + String(manifest.name || 'Unnamed').slice(0, 80) + '?',
    detail: 'Extensions can read and modify sites. This is an experimental Chromium extension loader, not Firefox XPI or full Chrome Web Store support.\n\nPermissions: ' + (grants.join(', ').slice(0, 650) || 'None listed'),
    buttons: ['Cancel', 'Install'],
    defaultId: 0,
    cancelId: 0
  });
  if (choice.response !== 1) return { ok: false, message: 'Cancelled' };
  try {
    await normalSession().extensions.loadExtension(folder, { allowFileAccess: false });
    emitState();
    return { ok: true, message: 'Extension loaded for normal tabs until restart.' };
  } catch (err) { return { ok: false, message: 'Failed to load extension: ' + err.message }; }
}

async function command(event, payload) {
  if (event.sender !== mainWindow?.webContents)
    return { ok: false, message: 'Unauthorized sender' };
  if (!payload || typeof payload.name !== 'string')
    return { ok: false, message: 'Invalid command' };
  if (typeof payload.value === 'string' && payload.value.length > 4096)
    return { ok: false, message: 'Input too long' };
  const { name, value } = payload;
  const tab = currentTab();
  const wc = tab?.view?.webContents;
  switch (name) {
    case 'new': addTab(); break;
    case 'new-private': addTab(true); break;
    case 'activate': if (Number.isSafeInteger(value) && tabs.some(t => t.id === value)) {
      activeId = value;
      const selected = currentTab();
      if (!selected.view && selected.url !== 'about:blank') void navigate(selected, selected.url);
      else redraw();
    } break;
    case 'close': if (Number.isSafeInteger(value)) closeTab(value); break;
    case 'navigate': if (tab && typeof value === 'string') void navigate(tab, value); break;
    case 'home': if (tab) void navigate(tab, 'about:blank'); break;
    case 'back': if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': if (tab && tab.url !== 'about:blank') wc.reload(); break;
    case 'privacy': changePrivacy(); break;
    case 'extension-install': return addExtension();
    case 'free-memory': {
      let count = 0;
      for (const background of tabs) {
        if (background.id === activeId || !background.view || background.loading) continue;
        const contents = background.view.webContents;
        if (contents.isDestroyed() || contents.isCurrentlyAudible()) continue;
        if (mainWindow.contentView.children.includes(background.view))
          mainWindow.contentView.removeChildView(background.view);
        background.view = null;
        background.suspended = background.url !== 'about:blank';
        contents.close();
        count++;
      }
      emitState();
      return { ok: true, message: count
        ? count + ' inactive tab(s) released from RAM. Reloading one may lose unsaved page state.'
        : 'No inactive tabs could be released.' };
    }
    case 'tor': {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Tor is not integrated',
        message: 'Tor is not embedded in this prototype.',
        detail: 'Routing Chromium through Tor is not equivalent to Tor Browser anonymity. Use official Tor Browser for sensitive activity.',
        buttons: ['Close', 'Official Tor Browser'],
        defaultId: 0,
        cancelId: 0
      });
      if (choice.response === 1) await shell.openExternal('https://www.torproject.org/download/');
      return { ok: true };
    }
    case 'minimize': mainWindow.minimize(); break;
    case 'maximize': mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); break;
    case 'quit': mainWindow.close(); break;
    default: return { ok: false, message: 'Unsupported command' };
  }
  emitState();
  return { ok: true };
}

app.on('web-contents-created', (_event, contents) => {
  // Prevent remote pages from attaching privileged Electron webviews.
  contents.on('will-attach-webview', event => event.preventDefault());
});

app.whenReady().then(async () => {
  lockDown(normalSession());
  mainWindow = new BrowserWindow({
    width: 1380, height: 880, minWidth: 700, minHeight: 520, show: false,
    frame: false, titleBarStyle: 'hidden', backgroundColor: '#0b101c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('before-input-event', keyHandler);
  mainWindow.on('resize', () => {
    const tab = currentTab();
    if (tab && mainWindow.contentView.children.includes(tab.view))
      tab.view.setBounds(bounds());
  });
  mainWindow.on('maximize', emitState);
  mainWindow.on('unmaximize', emitState);
  mainWindow.on('closed', () => {
    for (const tab of tabs) if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    mainWindow = null;
  });
  ipcMain.handle('minternet:command', command);
  await mainWindow.loadFile(path.join(__dirname, '../ui/index.html'));
  addTab();
  mainWindow.show();
});
app.on('window-all-closed', () => app.quit());
