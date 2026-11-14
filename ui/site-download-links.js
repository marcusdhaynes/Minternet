/* Site-local download compatibility: same-context WebView2 downloads for
   generated files that would otherwise be lost to a denied popup window.
   No native bridge, filesystem access, remote requests or privileged state. */
(() => {
  'use strict';
  const generated=url=>/^(blob:|data:)/i.test(String(url||''));
  const trustedFileHost=url=>{
    try {
      const address=new URL(url,location.href);
      if(address.protocol!=='https:')return false;
      // ChatGPT attachments often use a signed object URL rather than a
      // filename extension. Do not turn unrelated cross-origin links into
      // same-tab navigations.
      return /(?:^|\.)oaiusercontent\.com$/i.test(address.hostname) ||
        (address.hostname==='chatgpt.com' &&
          /^\/backend-api\/(?:files|assets|artifact|download)(?:\/|\?|$)/i.test(address.pathname));
    }catch{return false;}
  };
  function isDownloadLink(link){
    const raw=link.getAttribute('href');
    return !!raw && (link.hasAttribute('download')||generated(raw)||trustedFileHost(raw));
  }
  // On some WebView2/Tauri builds, <a target="_blank"> download requests
  // never reach the new-window handler. In the originating document the
  // existing native on_download callback can receive the transfer normally.
  document.addEventListener('click',event=>{
    const element=event.target;
    const link=element?.closest?.('a[href]');
    if(!link || !isDownloadLink(link))return;
    if(link.target?.toLowerCase()==='_blank'){
      link.target='_self';
    }
  },true);
  // Websites sometimes call window.open(blobUrl) for generated files.
  // A popup loses the blob's originating renderer context when rejected by
  // the browser; a temporary anchor with download keeps that same context.
  const originalOpen=window.open;
  if(typeof originalOpen==='function'){
    window.open=function(url,target,features){
      const uri=String(url??'');
      if(generated(uri) && (target==null || target==='' || target==='_blank')){
        const link=document.createElement('a');
        link.href=uri;
        link.download='download';
        link.hidden=true;
        (document.body||document.documentElement).appendChild(link);
        try{link.click();}finally{link.remove();}
        return null;
      }
      return Reflect.apply(originalOpen,this,arguments);
    };
  }
})();
