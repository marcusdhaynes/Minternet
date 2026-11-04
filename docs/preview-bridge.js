'use strict';
// Hosted companion only. The real desktop app supplies window.minternet through preload.
if (!window.minternet) {
  const tabs=[];
  let activeId=0,nextId=0,renderedUrl='',listeners=[];
  const $=id=>document.getElementById(id);
  const current=()=>tabs.find(t=>t.id===activeId);
  const title=url=>url==='about:blank'?'New Tab':new URL(url).hostname.replace(/^www\./,'');
  const restricted=url=>{
    const host=new URL(url).hostname;
    return /(^|\.)((google|youtube|reddit|github|facebook|instagram|microsoft|openai|chatgpt|linkedin|amazon|paypal)\.com|x\.com)$/.test(host);
  };
  function parse(input){
    const s=String(input||'').trim();
    if(!s)return 'about:blank';
    if(/^[a-z][\w+.-]*:/i.test(s)&&!/^https:\/\//i.test(s))return null;
    const host=/^(?:localhost|(?:[a-z\d-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#]|$)/i;
    const engines={
      google:'https://www.google.com/search?q=',
      duckduckgo:'https://duckduckgo.com/?q=',
      bing:'https://www.bing.com/search?q=',
      brave:'https://search.brave.com/search?q=',
      startpage:'https://www.startpage.com/sp/search?query=',
      ecosia:'https://www.ecosia.org/search?q='
    };
    const chosen=window.minternetSearch?.getEngine?.()||'google';
    const target=/^https:\/\//i.test(s)?s:host.test(s)?'https://'+s:
      (engines[chosen]||engines.google)+encodeURIComponent(s);
    try{const u=new URL(target);return u.protocol==='https:'&&!u.username&&!u.password&&u.hostname?u.href:null}
    catch{return null}
  }
  function show(){
    const t=current(),panel=$('preview-content'),frame=$('preview-frame');
    if(!panel)return;
    panel.hidden=!t||t.url==='about:blank';
    if(!t||t.url==='about:blank'){
      if(renderedUrl!==''){frame.removeAttribute('src');renderedUrl=''}
      return;
    }
    const isRestricted=restricted(t.url);
    $('preview-host').textContent=title(t.url);
    $('preview-target').textContent=t.url;
    $('preview-open').href=t.url;
    $('preview-open-top').href=t.url;
    $('preview-frame-wrap').hidden=isRestricted;
    $('preview-launch').hidden=!isRestricted;
    if(isRestricted){
      if(renderedUrl!==''){frame.removeAttribute('src');renderedUrl=''}
    }else if(renderedUrl!==t.url){frame.src=t.url;renderedUrl=t.url}
  }
  function emit(){
    const t=current();
    listeners.forEach(cb=>cb({
      activeId,extensionsCount:0,
      tabs:tabs.map(x=>({
        id:x.id,title:x.title,url:x.url,private:!!x.private,pinned:!!x.pinned,
        loading:false,suspended:false,error:'',
        canBack:x.at>0,canForward:x.at<x.history.length-1
      }))
    }));
    show();
  }
  function addTab(){
    if(tabs.length>=35)return false;
    const id=++nextId;tabs.push({id,title:'New Tab',url:'about:blank',private:false,
      pinned:false,history:['about:blank'],at:0});activeId=id;return true;
  }
  function go(url){
    const t=current();t.history=t.history.slice(0,t.at+1);t.history.push(url);t.at++;t.url=url;t.title=title(url)
  }
  window.minternet={
    onState(cb){listeners.push(cb);queueMicrotask(emit);return()=>{listeners=listeners.filter(x=>x!==cb)}},
    onFocusAddress(){return()=>{}},
    async command(name,value){
      switch(name){
        case 'new':if(!addTab())return {message:'Maximum 35 tabs.'};break;
        case 'activate':if(tabs.some(t=>t.id===value))activeId=value;break;
        case 'deselect':activeId=0;break;
        case 'pin':case 'unpin':case 'toggle-pin':{
          const tab=tabs.find(t=>t.id===value);
          if(!tab)return {message:'Tab not found.'};
          tab.pinned=name==='pin'?true:name==='unpin'?false:!tab.pinned;
          break;
        }
        case 'duplicate':{
          const original=tabs.find(t=>t.id===value);
          if(!original)return {message:'Tab not found.'};
          if(!addTab())return {message:'Maximum 35 tabs.'};
          const fresh=current();
          fresh.url=original.url;fresh.title=original.title;
          fresh.private=original.private;fresh.history=[original.url];fresh.at=0;
          break;
        }
        case 'close':{
          const i=tabs.findIndex(t=>t.id===value);
          if(i<0)break;
          tabs.splice(i,1);
          if(activeId===value){
            activeId=tabs.find(t=>t.pinned)?.id ??
              tabs[Math.min(i,tabs.length-1)]?.id ?? 0;
          }
          break;
        }
        case 'navigate':{
          const url=parse(value);if(!url)return {message:'Only HTTPS addresses and search terms are permitted.'};
          if(!current()&&!addTab())return {message:'Maximum 35 tabs.'};
          go(url);
          if (url !== 'about:blank' && restricted(url)) {
            // GitHub Pages cannot embed these websites. Do not silently open
            // the system browser; this would misrepresent the desktop app.
            emit();
            return {message:'GitHub Pages cannot embed this site. The portable Minternet EXE opens it inside Minternet.'};
          }
          break;
        }
        case 'home':if(current())go('about:blank');break;
        case 'back':case 'forward':{
          const t=current();
          if(!t)break;
          const next=t.at+(name==='back'?-1:1);
          if(next>=0&&next<t.history.length){t.at=next;t.url=t.history[next];t.title=title(t.url)}
          break;
        }
        case 'reload':renderedUrl='';break;
        case 'privacy':case 'new-private':
          return {message:'A hosted website cannot create a real private browser. Use a private window or the Minternet desktop app.'};
        case 'tor':return {message:'Tor is not integrated. Use official Tor Browser for anonymity.'};
        case 'extension-install':return {message:'Install extensions in your real browser; GitHub Pages cannot install browser extensions.'};
        case 'free-memory':$('preview-frame')?.removeAttribute('src');renderedUrl='';return {message:'Embedded page released. Reload to restore it.'};
        case 'minimize':case 'maximize':case 'quit':return {message:'Window controls are available in the desktop app.'};
        default:return {message:'Available in the desktop application.'};
      }
      emit();return null;
    }
  };
  document.addEventListener('DOMContentLoaded',()=>{
    const panel=document.createElement('section');panel.id='preview-content';panel.className='preview-content';panel.hidden=true;
    panel.innerHTML='<div class="preview-top"><span class="preview-legend">WEB VIEW</span><span id="preview-host"></span><a id="preview-open-top" target="_blank" rel="noopener noreferrer">Open Website ↗</a></div>'+
      '<div id="preview-frame-wrap" class="preview-frame-wrap"><iframe id="preview-frame" title="Embedded website" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe><div class="preview-note">Some websites prevent embedding. If the page is blank or blocked, choose Open Website.</div></div>'+
      '<div id="preview-launch" class="preview-launch" hidden><div class="preview-mark"><img src="./minternet-brand.webp" alt="Minternet"></div><div class="preview-caption">OPEN REAL WEBSITE</div><h2 id="preview-target"></h2><p>This website blocks embedded browsing. Open the real site in your existing browser.</p><a id="preview-open" target="_blank" rel="noopener noreferrer">Open Website ↗</a></div>';
    document.body.append(panel);
    const link=document.createElement('a');link.className='preview-build-link';
    link.href='https://github.com/marcusdhaynes/Minternet/actions/workflows/native-windows.yml';
    link.target='_blank';link.rel='noopener noreferrer';link.textContent='Get the PORTABLE Windows browser (one EXE) ↗';
    $('homeScreen')?.querySelector('.hero')?.append(link);
    const badge=document.createElement('a');badge.className='preview-badge';
    badge.href=link.href;badge.target='_blank';badge.rel='noopener noreferrer';badge.textContent='PORTABLE EXE ↗';document.body.append(badge);
    addEventListener('keydown',event=>{
      if(!(event.ctrlKey||event.metaKey))return;
      if(event.key.toLowerCase()==='t'){event.preventDefault();addTab();emit()}
      if(event.key.toLowerCase()==='w'&&current()){
        event.preventDefault();
        void window.minternet.command('close',activeId);
      }
    });
    emit();
  });
}
