'use strict';
// Identical "Lock in" control and after-close policy used by Secret Bookmarks.
// Only a non-sensitive amount/unit is saved in localStorage. The actual
// section lock is enforced by native vault-lock (shared-key aware).
(() => {
  const sections=new Set(['identities','logins','payments']);
  const active=new Map();
  const MAX=999999,MAX_TIMEOUT=2147483647;
  const units={seconds:1000,minutes:60000,hours:3600000};
  const normalize=(value,unit)=>({
    amount:Math.max(0,Math.min(MAX,Math.trunc(Number(value)||0))),
    unit:Object.hasOwn(units,unit)?unit:'seconds'
  });
  function forSection(section){
    if(!sections.has(section))throw Error('Unknown encrypted vault section');
    if(active.has(section))return active.get(section);
    const key='minternet.'+section+'-close-lock.v1';
    let preference={amount:0,unit:'seconds'};
    try{
      const saved=JSON.parse(localStorage.getItem(key)||'null');
      preference=normalize(saved?.amount,saved?.unit);
    }catch{/* A corrupted preference uses the secure zero-second default. */}
    let opened=false,unlocked=false,timer=null,deadline=0,locking=null;
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
      try{return await locking;}
      finally{locking=null;}
    }
    function schedule(){
      stop();
      if(opened||!unlocked)return;
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
      for(const [value,text] of [['seconds','sec'],['minutes','min'],['hours','hours']]){
        const option=document.createElement('option');
        option.value=value;option.textContent=text;unit.append(option);
      }
      unit.value=preference.unit;
      const save=()=>{
        preference=normalize(amount.value,unit.value);
        amount.value=String(preference.amount);unit.value=preference.unit;
        try{localStorage.setItem(key,JSON.stringify(preference));}catch{}
      };
      amount.addEventListener('change',save);
      unit.addEventListener('change',save);
      label.append(caption,amount,unit);
      header.append(label);
      return label;
    }
    const controller={
      mount,
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
  window.minternetVaultAutoLock={forSection};
})();
