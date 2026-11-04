'use strict';
// Local history never records private tabs. URL completion combines the native
// non-private visit index with all saved bookmarks; no network suggestions.
(() => {
  const $=id=>document.getElementById(id);
  const address=$('address'),form=$('addressForm'),historyButton=$('historyButton');
  if(!address||!form||!historyButton||!window.minternet)return;
  const api=window.minternet;
  const command=(name,value)=>api.command(name,value);
  let dropdown=null,manager=null,entries=[],selected=-1,revision=0,hidden=false;
  let historyShown=0,historyRevision=0;
  const safe=url=>{try{const parsed=new URL(url);return parsed.protocol==='https:'&&!parsed.username&&!parsed.password;}catch{return false;}};
  const privateActive=()=>{
    const data=window.minternetGroups?.getLatest();
    return Boolean(data?.tabs?.find(t=>t.id===data.activeId)?.private);
  };
  const compact=url=>{try{return new URL(url).hostname.replace(/^www\./,'');}catch{return url;}};
  const bookmarks=()=>{
    const state=window.minternetBookmarks?.getState();
    const result=[];
    const visit=nodes=>{
      for(const node of nodes||[]){
        if(node.kind==='folder')visit(node.children);
        else if(safe(node.url))result.push({url:node.url,title:node.name||compact(node.url),bookmark:true});
      }
    };
    visit(state?.items);
    return result;
  };
  function hideSuggestions(){
    revision++;selected=-1;entries=[];
    dropdown?.remove();dropdown=null;
    address.setAttribute('aria-expanded','false');
    address.removeAttribute('aria-activedescendant');
    if(!manager&&window.__TAURI__)void command('chrome-overlay',false);
  }
  function suggestionHost(){
    if(dropdown)return dropdown;
    const host=document.createElement('div');
    host.id='addressSuggestions';
    host.className='system-popup-root minternet-context-menu address-suggestions';
    host.setAttribute('role','listbox');
    host.setAttribute('aria-label','Address suggestions');
    document.body.append(host);dropdown=host;
    address.setAttribute('aria-expanded','true');
    if(window.__TAURI__)void command('chrome-overlay',true);
    return host;
  }
  function positionSuggestions(){
    if(!dropdown)return;
    const box=form.getBoundingClientRect();
    dropdown.style.top=(box.bottom+3)+'px';
    dropdown.style.left=Math.max(4,box.left)+'px';
    dropdown.style.width=Math.max(240,Math.min(box.width,innerWidth-box.left-8))+'px';
  }
  function highlight(){
    if(!dropdown)return;
    [...dropdown.querySelectorAll('.history-suggestion')].forEach((el,i)=>{
      el.classList.toggle('chosen',i===selected);
      if(i===selected)address.setAttribute('aria-activedescendant',el.id);
    });
    if(selected<0)address.removeAttribute('aria-activedescendant');
  }
  function choose(url){
    if(!safe(url))return;
    hideSuggestions();
    address.value=url;
    address.blur();
    void command('navigate',url);
  }
  function show(items){
    entries=items.slice(0,9);selected=-1;
    if(!entries.length){hideSuggestions();return;}
    const host=suggestionHost();
    host.replaceChildren();
    for(const [i,entry] of entries.entries()){
      const row=document.createElement('button');row.type='button';row.className='history-suggestion';
      row.id='address-suggestion-'+i;row.setAttribute('role','option');
      row.title=entry.url;
      const icon=document.createElement('span');icon.className='history-suggestion-symbol';
      icon.textContent=entry.bookmark?'☆':'◷';
      const text=document.createElement('span');text.className='history-suggestion-text';
      const title=document.createElement('strong');title.textContent=entry.title||compact(entry.url);
      const subtitle=document.createElement('small');subtitle.textContent=entry.url;
      text.append(title,subtitle);row.append(icon,text);
      row.addEventListener('pointerdown',event=>event.preventDefault());
      row.addEventListener('click',()=>choose(entry.url));
      host.append(row);
    }
    positionSuggestions();
  }
  async function updateSuggestions(){
    const token=++revision,query=address.value.trim().toLowerCase();
    if(document.activeElement!==address||manager||hidden)return;
    const recent=privateActive()?[]:await command('history-search',query);
    if(token!==revision||document.activeElement!==address||manager)return;
    const filteredBookmarks=bookmarks().filter(entry=>!query||
      entry.url.toLowerCase().includes(query)||entry.title.toLowerCase().includes(query));
    const seen=new Set(),merged=[];
    // History comes first, already sorted newest visit to oldest.
    for(const entry of [...(Array.isArray(recent)?recent:[]),...filteredBookmarks]){
      if(!safe(entry.url)||seen.has(entry.url))continue;
      seen.add(entry.url);merged.push(entry);
      if(merged.length>=9)break;
    }
    show(merged);
  }
  address.addEventListener('focus',()=>{hidden=false;void updateSuggestions();});
  address.addEventListener('input',()=>{hidden=false;void updateSuggestions();});
  address.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&dropdown){event.preventDefault();hidden=true;hideSuggestions();}
    else if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      if(!entries.length)return;
      event.preventDefault();
      selected=event.key==='ArrowDown'?(selected+1)%entries.length:
        selected<0?entries.length-1:(selected-1+entries.length)%entries.length;
      highlight();
    }else if(event.key==='Enter'&&selected>=0&&entries[selected]){
      event.preventDefault();event.stopPropagation();
      choose(entries[selected].url);
    }
  });
  address.addEventListener('blur',()=>setTimeout(()=>{
    if(document.activeElement!==address)hideSuggestions();
  },110));
  form.addEventListener('submit',hideSuggestions);
  window.addEventListener('resize',positionSuggestions);
  function closeHistory(){
    if(!manager)return;
    manager.remove();manager=null;
    historyButton.setAttribute('aria-expanded','false');
    document.removeEventListener('pointerdown',outside,true);
    document.removeEventListener('keydown',escape,true);
    if(window.__TAURI__)void command('chrome-overlay',false);
  }
  function outside(event){
    if(manager&&!manager.contains(event.target)&&!historyButton.contains(event.target))closeHistory();
  }
  function escape(event){if(event.key==='Escape'){event.preventDefault();closeHistory();}}
  function row(entry){
    const r=document.createElement('div');r.className='history-entry';
    const open=document.createElement('button');open.type='button';open.className='history-entry-open';
    const name=document.createElement('strong');name.textContent=entry.title||compact(entry.url);
    const url=document.createElement('small');url.textContent=entry.url;
    open.append(name,url);open.title=entry.url;
    open.addEventListener('click',event=>{
      if(event.ctrlKey||event.metaKey||event.button===1)void command('new-background-url',entry.url);
      else choose(entry.url);
      closeHistory();
    });
    open.addEventListener('auxclick',event=>{if(event.button===1){event.preventDefault();void command('new-background-url',entry.url);}});
    const remove=document.createElement('button');remove.className='history-remove';remove.type='button';
    remove.textContent='×';remove.title='Remove from history';remove.setAttribute('aria-label','Remove '+entry.title);
    remove.addEventListener('click',async()=>{
      const result=await command('history-remove',entry.url);
      if(result?.ok)await renderHistory();
    });
    r.append(open,remove);return r;
  }
  async function renderHistory(more=false){
    if(!manager)return;
    const token=++historyRevision,host=manager;
    const list=manager.querySelector('.history-entries');
    const load=manager.querySelector('.history-more');
    if(!more){historyShown=0;list.replaceChildren();}
    if(privateActive()){
      list.textContent='Browsing history is not saved or suggested in private tabs.';
      load.hidden=true;
      return;
    }
    const query=manager.querySelector('.history-filter')?.value.trim()||'';
    const recent=await command('history-list',{query,offset:historyShown,limit:75});
    if(!manager||manager!==host||token!==historyRevision)return;
    if(!Array.isArray(recent)||(!recent.length&&!historyShown)){
      list.textContent='No matching browsing history.';
      load.hidden=true;return;
    }
    for(const entry of recent){
      if(safe(entry.url))list.append(row(entry));
    }
    historyShown+=recent.length;
    load.hidden=recent.length<75;
  }
  async function openHistory(){
    if(manager){closeHistory();return;}
    hideSuggestions();
    window.minternetBookmarks?.closeOverlay();
    window.minternetPayment?.close?.();
    const panel=document.createElement('section');
    panel.className='system-popup-root minternet-context-menu history-popup';
    panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Browsing History');
    const head=document.createElement('div');head.className='history-head';
    const title=document.createElement('strong');title.textContent='Browsing History';
    const clear=document.createElement('button');clear.type='button';clear.textContent='Clear';
    clear.title='Delete all saved browsing history';
    clear.addEventListener('click',async()=>{
      if(!window.confirm('Clear all saved browsing history? Bookmarks will be kept.'))return;
      const result=await command('history-clear');
      if(result?.ok)await renderHistory();
    });
    const filter=document.createElement('input');
    filter.type='search';filter.className='history-filter';
    filter.autocomplete='off';filter.placeholder='Search browsing history';
    filter.setAttribute('aria-label','Search browsing history');
    filter.addEventListener('input',()=>void renderHistory());
    const list=document.createElement('div');list.className='history-entries';
    const load=document.createElement('button');load.type='button';
    load.className='history-more';load.textContent='Show More';load.hidden=true;
    load.addEventListener('click',()=>void renderHistory(true));
    head.append(title,clear);panel.append(head,filter,list,load);
    document.body.append(panel);manager=panel;
    const rect=historyButton.getBoundingClientRect();
    panel.style.top=Math.max(4,Math.min(innerHeight-310,rect.bottom+5))+'px';
    panel.style.left=Math.max(4,Math.min(innerWidth-275,rect.right-275))+'px';
    historyButton.setAttribute('aria-expanded','true');
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',escape,true);
    if(window.__TAURI__)void command('chrome-overlay',true);
    await renderHistory();
  }
  historyButton.addEventListener('click',()=>void openHistory());
  $('historyManagerOpen')?.addEventListener('click',()=>void openHistory());
  window.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='h'){
      event.preventDefault();void openHistory();
    }
  });
  if(window.__TAURI__?.event?.listen)
    window.__TAURI__.event.listen('minternet:history-changed',()=>{
      if(manager)void renderHistory();
      if(document.activeElement===address)void updateSuggestions();
    }).catch(()=>{});
  window.minternetHistory={open:openHistory,close:closeHistory};
})();
