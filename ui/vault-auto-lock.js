'use strict';
// Identical "Lock in" control and after-close policy used by Secret Bookmarks.
// Only a non-sensitive amount/unit is saved in localStorage. The actual
// section lock is enforced by native vault-lock (shared-key aware).
(() => {
  const sections=new Set(['identities','logins','payments']);
  const active=new Map();
  const listeners=new Set();
  const MAX=999999,MAX_TIMEOUT=2147483647;
  const units={seconds:1000,minutes:60000,hours:3600000,days:86400000};
  const validUnit=unit=>unit==='never'||Object.hasOwn(units,unit);
  const normalize=(value,unit)=>({
    amount:Math.max(0,Math.min(MAX,Math.trunc(Number(value)||0))),
    unit:validUnit(unit)?unit:'seconds'
  });
  const defaultDelay={amount:5,unit:'minutes'};
  const changed=(section,enabled)=>{
    for(const listener of listeners){
      try{listener(section,enabled);}catch{/* A Settings listener cannot block locking. */}
    }
  };
  const validSection=section=>sections.has(section);
  function onChange(listener){
    if(typeof listener!=='function')throw Error('Expected auto-lock listener');
    listeners.add(listener);
    return ()=>listeners.delete(listener);
  }
  function forSection(section){
    if(!sections.has(section))throw Error('Unknown encrypted vault section');
    if(active.has(section))return active.get(section);
    const key='minternet.'+section+'-close-lock.v1';
    // Logins must stay unlocked while the application is running unless the
    // user chooses a shorter auto-lock policy. This never bypasses the master
    // password required after launch, a manual Lock, or OS session shutdown.
    let preference=section==='logins'
      ?{amount:0,unit:'never'}:{amount:0,unit:'seconds'};
    let lastFinite={...defaultDelay};
    try{
      const saved=JSON.parse(localStorage.getItem(key)||'null');
      if(saved&&typeof saved==='object'&&!Array.isArray(saved)){
        preference=normalize(saved.amount,saved.unit);
        if(validUnit(saved.lastUnit)&&saved.lastUnit!=='never'){
          lastFinite=normalize(saved.lastAmount,saved.lastUnit);
        }else if(preference.unit!=='never'){
          lastFinite={...preference};
        }
      }
    }catch{/* Corrupted preference uses the original per-section default. */}
    let opened=false,unlocked=false,timer=null,deadline=0,locking=null;
    const controls=new Set();
    const syncControls=()=>{
      for(const {amount,unit} of controls){
        amount.value=String(preference.amount);
        unit.value=preference.unit;
        amount.disabled=preference.unit==='never';
      }
    };
    const persist=()=>{
      try{
        localStorage.setItem(key,JSON.stringify({...preference,
          lastAmount:lastFinite.amount,lastUnit:lastFinite.unit}));
      }catch{/* Never save vault passwords, only this local UI preference. */}
      syncControls();
      changed(section,preference.unit!=='never');
      if(!opened&&unlocked)schedule();
      else if(preference.unit==='never')stop();
    };
    function setEnabled(enabled){
      const wantEnabled=Boolean(enabled);
      if((preference.unit!=='never')===wantEnabled)return wantEnabled;
      if(wantEnabled){
        preference={...lastFinite};
      }else{
        if(preference.unit!=='never')lastFinite={...preference};
        preference={...preference,unit:'never'};
      }
      persist();
      return wantEnabled;
    }
    const stop=()=>{clearTimeout(timer);timer=null;deadline=0;};
    async function lock(){
      if(locking)return locking;
      stop();
      if(opened||!unlocked)return false;
      locking=(async()=>{
        try{
          const response=await window.minternet?.command('vault-lock',section);
          if(response?.ok){unlocked=false;return true;}
        }catch{/* A temporary IPC failure must not forge a locked state. */}
        return false;
      })();
      let success=false;
      try{
        success=await locking;
        return success;
      }finally{
        locking=null;
        // If IPC was temporarily unavailable, keep the vault closed in the
        // UI and retry the native revocation instead of silently giving up.
        if(!success&&!opened&&unlocked){
          timer=setTimeout(()=>{void lock();},2000);
        }
      }
    }
    function schedule(){
      stop();
      if(opened||!unlocked||preference.unit==='never')return;
      const ms=preference.amount*units[preference.unit];
      if(ms===0){void lock();return;}
      deadline=Date.now()+ms;
      const step=()=>{
        if(opened||!unlocked)return;
        const remaining=deadline-Date.now();
        if(remaining<=0){void lock();return;}
        timer=setTimeout(step,Math.min(remaining,MAX_TIMEOUT));
      };
      step();
    }
    function mount(header){
      const label=document.createElement('label');
      label.className='secret-close-lock';
      label.title='Automatically lock '+section+' this long after closing the vault. Zero locks instantly.';
      const caption=document.createElement('span');
      caption.textContent='Lock in';
      const amount=document.createElement('input');
      amount.type='number';amount.min='0';amount.max=String(MAX);amount.step='1';
      amount.inputMode='numeric';amount.value=String(preference.amount);
      amount.setAttribute('aria-label','Delay after closing before '+section+' lock');
      const unit=document.createElement('select');
      unit.setAttribute('aria-label',section+' lock delay unit');
      for(const [value,text] of [
        ['seconds','Seconds'],['minutes','Minutes'],['hours','Hours'],
        ['days','Days'],['never','Never']]){
        const option=document.createElement('option');
        option.value=value;option.textContent=text;unit.append(option);
      }
      unit.value=preference.unit;
      amount.disabled=unit.value==='never';
      const save=()=>{
        // Switching Never → a timed mode restores a sensible non-zero delay
        // unless the user explicitly chose zero after enabling the timer.
        if(preference.unit==='never'&&unit.value!=='never'&&Number(amount.value)===0)
          amount.value=String(lastFinite.amount||5);
        preference=normalize(amount.value,unit.value);
        if(preference.unit!=='never')lastFinite={...preference};
        persist();
      };
      amount.addEventListener('change',save);
      unit.addEventListener('change',save);
      controls.add({amount,unit});
      label.append(caption,amount,unit);
      header.append(label);
      return label;
    }
    const controller={
      mount,setEnabled,isEnabled:()=>preference.unit!=='never',
      async openManager(){
        opened=true;
        stop();
        // A zero-second lock from the previous close may still be in flight.
        // Never fetch/display stale secret records until that lock completes.
        if(locking)await locking;
      },
      closeManager(wasUnlocked){
        opened=false;unlocked=Boolean(wasUnlocked);
        schedule();
      },
      setUnlocked(value){
        unlocked=Boolean(value);
        if(!unlocked)stop();
      }
    };
    active.set(section,controller);
    return controller;
  }
  window.minternetVaultAutoLock={
    forSection,
    getEnabled(section){
      if(!validSection(section))throw Error('Unknown encrypted vault section');
      return forSection(section).isEnabled();
    },
    setEnabled(section,enabled){
      if(!validSection(section))throw Error('Unknown encrypted vault section');
      return forSection(section).setEnabled(enabled);
    },
    onChange
  };
})();
