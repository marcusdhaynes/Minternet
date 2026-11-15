'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const selector=$('renderCompatibilityMode');
  const status=$('renderCompatibilityStatus');
  const repair=$('renderSurfaceRepair');
  if(!selector||!status||!repair)return;
  const report=text=>{status.textContent=text;};
  const command=(name,value)=>window.minternet?.command(name,value);
  async function load(){
    try{
      const result=await command('render-compat-get');
      if(!result?.supported){
        selector.disabled=true;repair.disabled=true;
        report('Compatibility mode is available in the Windows desktop build.');
        return;
      }
      selector.value=result.saved?'software':'hardware';
      report(result.restartRequired
        ?'Rendering mode saved. Close and reopen Minternet to apply it.'
        :result.current
          ?'Software compatibility mode is active for this launch.'
          :'Hardware acceleration is active (recommended).');
    }catch(e){report('Could not check rendering mode: '+String(e?.message||e));}
  }
  selector.addEventListener('change',async()=>{
    selector.disabled=true;
    try{
      const result=await command('render-compat-set',selector.value==='software');
      if(result?.message)throw Error(result.message);
      report('Rendering mode saved. Close and reopen Minternet to apply it. Existing cookies and bookmarks are preserved.');
    }catch(e){report('Unable to change rendering: '+String(e?.message||e));}
    selector.disabled=false;
  });
  repair.addEventListener('click',async()=>{
    try{
      const result=await command('render-surface-repair');
      if(result?.message)throw Error(result.message);
      report('Rechecked the native page surface without reloading or clearing the browser profile.');
    }catch(e){report('Page repair failed: '+String(e?.message||e));}
  });
  void load();
})();
