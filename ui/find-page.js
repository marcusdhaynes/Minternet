'use strict';
// A compact per-window Find bar lives in trusted chrome, immediately after
// the Bookmark Bar. Native WebView2 keeps the website fully interactive below.
(() => {
  const $=id=>document.getElementById(id);
  const bar=$('findBar'),input=$('findQuery'),output=$('findResult');
  if(!bar||!input||!window.minternet)return;
  const call=(name,arg)=>window.minternet.command(name,arg);
  let visible=false,searchTimer=0;
  async function open(){
    if(visible){input.focus();input.select();return;}
    visible=true;bar.hidden=false;
    try{await call('find-bar-set',true);}catch{}
    input.focus({preventScroll:true});input.select();
    if(input.value)search();
  }
  async function close(){
    if(!visible)return;
    visible=false;bar.hidden=true;
    clearTimeout(searchTimer);output.value='';
    try{await call('find-bar-set',false);}catch{}
  }
  function search(backward=false){
    const query=input.value.trim();
    if(!query){output.textContent='';return;}
    output.textContent='Searching…';
    void call('find-page',{query,backward}).then(result=>{
      if(result?.message)output.textContent='Find unavailable';
    });
  }
  input.addEventListener('input',()=>{
    clearTimeout(searchTimer);
    if(!input.value.trim()){output.textContent='';return;}
    searchTimer=setTimeout(()=>search(),85);
  });
  for(const [id,backward] of [['findNext',false],['findPrevious',true]])
    $(id)?.addEventListener('click',()=>search(backward));
  $('findClose')?.addEventListener('click',()=>void close());
  input.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();search(event.shiftKey);}
    if(event.key==='Escape'){event.preventDefault();void close();}
  });
  window.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'&&!event.altKey){
      event.preventDefault();void open();
    }else if(event.key==='Escape'&&visible){
      event.preventDefault();void close();
    }else if(event.key==='F3'&&visible){
      event.preventDefault();search(event.shiftKey);
    }
  },true);
  if(window.__TAURI__?.event?.listen){
    void window.__TAURI__.event.listen('minternet:find-open',()=>void open());
    void window.__TAURI__.event.listen('minternet:find-result',event=>{
      const result=event.payload;
      if(visible&&result?.query===input.value.trim()){
        output.textContent=result.found?'Match':'No matches';
      }
    });
  }
  window.minternetFind={open,close};
})();
