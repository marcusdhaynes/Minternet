'use strict';
(() => {
  const host=document.getElementById('minternetMediaServer');
  if(!host||!window.minternet)return;
  const folders=host.querySelector('[data-media-folders]');
  const status=host.querySelector('[data-media-status]');
  const add=host.querySelector('[data-media-add]');
  const refresh=host.querySelector('[data-media-refresh]');
  const say=msg=>{status.textContent=String(msg||'');};
  const call=async(name,value=null)=>{
    const result=await window.minternet.command(name,value);
    if(result?.message)throw Error(result.message);
    return result;
  };
  async function render(){
    try{
      const lib=await call('media-library-get');
      folders.replaceChildren();
      for(const f of lib.folders||[]){
        const row=document.createElement('div');
        row.style.cssText='display:flex;align-items:center;gap:8px;padding:5px 0';
        const name=document.createElement('span');name.style.flex='1';
        const count=(lib.items||[]).filter(item=>item.folderId===f.id).length;
        name.textContent=f.name+' · '+count+' videos';name.title=f.path;
        const remove=document.createElement('button');remove.type='button';
        remove.textContent='Remove';remove.className='bookmark-menu-action';
        remove.addEventListener('click',async()=>{
          try{await call('media-library-remove-folder',{folderId:f.id});await render();}
          catch(e){say(e.message);}
        });
        row.append(name,remove);folders.append(row);
      }
      if(!lib.folders?.length)folders.textContent='No media folders added yet.';
      say((lib.items||[]).length+' videos indexed locally.');
    }catch(e){say('Native Media Server unavailable: '+e.message);}
  }
  add.addEventListener('click',async()=>{
    add.disabled=true;
    try{
      const result=await call('media-library-choose-folder');
      if(!result?.cancelled)await render();
    }catch(e){say(e.message);}finally{add.disabled=false;}
  });
  refresh.addEventListener('click',async()=>{
    refresh.disabled=true;
    try{await call('media-library-rescan');await render();}
    catch(e){say(e.message);}finally{refresh.disabled=false;}
  });
  // This panel belongs to the user-imported .mext add-on, not to Minternet
  // itself. Do not show an apparently usable built-in server before install.
  void (async()=>{
    try{
      const state=await call('extensions-list');
      const installed=(state.extensions||[]).some(extension=>
        extension.source==='minternet'&&extension.enabled&&extension.nativeMediaServer);
      host.hidden=!installed;
      if(installed)await render();
    }catch{host.hidden=true;}
  })();
})();