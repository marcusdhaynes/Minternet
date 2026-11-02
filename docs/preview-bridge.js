'use strict';
// Minternet's STATIC GitHub Pages demo. No site is loaded inside this shell.
// The real desktop app supplies window.minternet through its secure preload.
if (!window.minternet) {
  let nextId = 1;
  let activeId = 1;
  const state = { tabs: [{ id: 1, title: 'New Tab', url: 'about:blank', private: false, history: ['about:blank'], pos: 0 }], activeId: 1, extensionsCount: 0 };
  const stateListeners = [];
  const focusListeners = [];
  const active = () => state.tabs.find(t => t.id === activeId);
  const titleFor = url => url === 'about:blank' ? 'New Tab' : (() => { try { return new URL(url).hostname; } catch { return 'Preview'; } })();
  const normalizedUrl = input => {
    const value = String(input || '').trim();
    if (!value) return null;
    if (value === 'about:blank') return 'about:blank';
    if (/^https:\/\//i.test(value)) {
      try { return new URL(value).href; } catch { return null; }
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
    if (/^[\w-]+(\.[\w-]+)+(?::\d+)?(?:\/.*)?$/i.test(value)) {
      try { return new URL('https://' + value).href; } catch { return null; }
    }
    return 'https://www.google.com/search?q=' + encodeURIComponent(value);
  };
  function emit() {
    state.activeId = activeId;
    const snapshot = {
      ...state,
      tabs: state.tabs.map(t => ({
        id: t.id, url: t.url, title: t.title, private: t.private,
        loading: false, canBack: t.pos > 0, canForward: t.pos < t.history.length - 1
      }))
    };
    stateListeners.forEach(fn => fn(snapshot));
    const content = document.getElementById('preview-content');
    if (content) {
      const t = active();
      content.hidden = !t || t.url === 'about:blank';
      if (t && t.url !== 'about:blank') {
        document.getElementById('preview-host').textContent = titleFor(t.url);
        document.getElementById('preview-url').textContent = t.url;
        document.getElementById('preview-mode').textContent = t.private ? 'Private mode (UI demonstration)' : 'Normal mode (UI demonstration)';
        document.getElementById('preview-open').href = t.url;
      }
    }
  }
  function addTab(isPrivate=false) {
    const id = ++nextId;
    state.tabs.push({id,title:'New Tab',url:'about:blank',private:isPrivate,history:['about:blank'],pos:0});
    activeId=id;
  }
  function nav(url) {
    const t=active();
    t.url=url; t.title=titleFor(url);
    t.history=t.history.slice(0,t.pos+1);
    t.history.push(url);t.pos++;
  }
  window.minternet = {
    onState(callback) { stateListeners.push(callback); queueMicrotask(emit); },
    onFocusAddress(callback) { focusListeners.push(callback); },
    async command(name, value) {
      const t=active();
      switch(name) {
        case 'new': addTab(); break;
        case 'new-private': addTab(true); break;
        case 'activate': if(state.tabs.some(x=>x.id===value)) activeId=value; break;
        case 'close':
          state.tabs=state.tabs.filter(x=>x.id!==value);
          if(!state.tabs.length) addTab();
          if(!state.tabs.some(x=>x.id===activeId)) activeId=state.tabs[state.tabs.length-1].id;
          break;
        case 'privacy':
          // This is a simulated session reset, NOT a security/privacy guarantee.
          t.private=!t.private; t.history=[t.url]; t.pos=0; break;
        case 'home': nav('about:blank'); break;
        case 'navigate': {
          const url=normalizedUrl(value);
          if(!url) return {message:'Only HTTPS destinations and search terms are accepted in this preview.'};
          nav(url); break;
        }
        case 'back': if(t.pos>0){t.pos--;t.url=t.history[t.pos];t.title=titleFor(t.url);} break;
        case 'forward': if(t.pos<t.history.length-1){t.pos++;t.url=t.history[t.pos];t.title=titleFor(t.url);} break;
        case 'reload': break;
        case 'tor': return {message:'Tor is NOT integrated in this demo or desktop prototype. Use official Tor Browser for anonymity.'};
        case 'extension-install': return {message:'Extensions cannot be installed in a static web preview.'};
        case 'minimize': case 'maximize': case 'quit':
          return {message:'Window controls only work in the desktop application.'};
        default: return {message:'This is a UI-only demonstration.'};
      }
      emit();
      return null;
    }
  };
  window.addEventListener('DOMContentLoaded', () => {
    const note = document.createElement('div');
    note.className = 'preview-badge';
    note.textContent = 'LIVE UI DEMO · NOT A FUNCTIONAL OR PRIVATE BROWSER';
    document.body.append(note);
    const view = document.createElement('section');
    view.id = 'preview-content';
    view.hidden=true;
    view.className='preview-content';
    view.innerHTML = '<div class="preview-page"><div class="preview-icon" aria-hidden="true">M</div><p id="preview-mode"></p><h2 id="preview-host"></h2><p id="preview-url"></p><p>This web-hosted version demonstrates the Minternet interface. Websites cannot be rendered here as independent browser tabs. The desktop app handles navigation in native browser views.</p><a id="preview-open" target="_blank" rel="noopener noreferrer">Open this address in your current browser ↗</a></div>';
    document.body.append(view);
    const css = document.createElement('style');
    css.textContent = '.preview-badge{position:fixed;z-index:10;bottom:35px;right:15px;background:#312c46;border:1px solid #81739d;color:#f0ddff;padding:6px 11px;font:600 10px sans-serif;letter-spacing:.04em;border-radius:8px;pointer-events:none}.preview-content{position:fixed;inset:106px 0 26px;background:radial-gradient(circle at 50% 30%,#1e2b49,#0d1424 65%);display:grid;place-items:center;padding:30px}.preview-content[hidden]{display:none}.preview-page{width:min(590px,100%);text-align:center;color:#b7c5e0;font:14px/1.6 system-ui}.preview-page h2{color:white;font:600 clamp(22px,4vw,38px) system-ui;overflow-wrap:anywhere;margin:10px}.preview-page p{overflow-wrap:anywhere}.preview-icon{margin:auto;width:62px;height:62px;border-radius:18px;background:linear-gradient(130deg,#8179dd,#779bc7);display:grid;place-items:center;color:white;font-size:34px}.preview-page a{display:inline-block;margin-top:15px;color:#c5caff;text-decoration:none;border:1px solid #6773a5;border-radius:10px;padding:11px 15px}.preview-page a:hover{background:#343e5c}';
    document.head.append(css);
    emit();
  });
}
