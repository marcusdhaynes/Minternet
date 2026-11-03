'use strict';
// Hosted companion only. The real desktop app supplies window.minternet through preload.
if (!window.minternet) {
  const tabs=[{id:1,title:'New Tab',url:'about:blank',history:['about:blank'],at:0}];
  let activeId=1,nextId=1,renderedUrl='',listeners=[];
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
    const target=/^https:\/\//i.test(s)?s:host.test(s)?'https://'+s:'https://duckduckgo.com/?q='+encodeURIComponent(s);
    try{const u=new URL(target);return u.protocol==='https:'&&!u.username&&!u.password&&u.hostname?u.href:null}
    catch{return null}
  }
  function show(){
    const t=current(),panel=$('preview-content'),frame=$('preview-frame');
    if(!panel)return;
    panel.hidden=t.url==='about:blank';
    if(t.url==='about:blank'){
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
        id:x.id,title:x.title,url:x.url,private:false,loading:false,suspended:false,error:'',
        canBack:x.at>0,canForward:x.at<x.history.length-1
      }))
    }));
    show();
  }
  function addTab(){
    if(tabs.length>=35)return false;
    const id=++nextId;tabs.push({id,title:'New Tab',url:'about:blank',history:['about:blank'],at:0});activeId=id;return true;
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
        case 'close':{
          const i=tabs.findIndex(t=>t.id===value);
          if(i!==-1)tabs.splice(i,1);
          if(!tabs.length)addTab();
          if(!tabs.some(t=>t.id===activeId))activeId=tabs[Math.max(0,Math.min(i,tabs.length-1))].id;
          break;
        }
        case 'navigate':{
          const url=parse(value);if(!url)return {message:'Only HTTPS addresses and search terms are permitted.'};
          go(url);
          if (url !== 'about:blank' && restricted(url)) {
            // User explicitly asked to navigate here; open the real site now.
            // Popup blockers may refuse it, so the ordinary Open Website anchor remains.
            window.open(url, '_blank', 'noopener,noreferrer');
            emit();
            return {message:'This site cannot appear inside GitHub Pages. Opened it in your browser; use Open Website if it was blocked.'};
          }
          break;
        }
        case 'home':go('about:blank');break;
        case 'back':case 'forward':{
          const t=current(),next=t.at+(name==='back'?-1:1);
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
      '<div id="preview-launch" class="preview-launch" hidden><div class="preview-mark">M</div><div class="preview-caption">OPEN REAL WEBSITE</div><h2 id="preview-target"></h2><p>This website blocks embedded browsing. Open the real site in your existing browser.</p><a id="preview-open" target="_blank" rel="noopener noreferrer">Open Website ↗</a></div>';
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
      if(event.key.toLowerCase()==='w'&&tabs.length>1){
        event.preventDefault();const i=tabs.findIndex(t=>t.id===activeId);
        tabs.splice(i,1);activeId=tabs[Math.min(i,tabs.length-1)].id;emit()
      }
    });
    emit();
  });
}
