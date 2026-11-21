'use strict';
// Browser-chrome-only bookmark folder appearance. No website data, icon bytes,
// or colors are sent to webpages; these tiny preferences remain in the user's
// Minternet chrome settings and leave custom bookmark artwork unchanged.
(() => {
  const KEY='minternet.bookmark-folder-appearance.v1';
  const DEFAULT={bevel:false,gloss:false,glass:false,tint:false,color:'#b99cff'};
  const root=document.documentElement;
  const $=id=>document.getElementById(id);
  const controls=[
    ['bevel','bookmarkFolderBevel'],
    ['gloss','bookmarkFolderGloss'],
    ['glass','bookmarkFolderGlass'],
    ['tint','bookmarkFolderTintEnabled']
  ];
  const validColor=color=>typeof color==='string'&&/^#[0-9a-f]{6}$/i.test(color);
  function read(){
    let stored;
    try{stored=JSON.parse(localStorage.getItem(KEY)||'null');}catch{}
    if(!stored||typeof stored!=='object'||Array.isArray(stored))
      return {...DEFAULT};
    const next={...DEFAULT};
    for(const [field] of controls){
      if(typeof stored[field]==='boolean')next[field]=stored[field];
    }
    if(validColor(stored.color))next.color=stored.color.toLowerCase();
    return next;
  }
  let state=read();
  function update(){
    root.classList.toggle('minternet-folder-style-active',
      state.bevel||state.gloss||state.glass||state.tint);
    for(const [field] of controls)
      root.classList.toggle('minternet-folder-style-'+field,state[field]);
    root.style.setProperty('--minternet-folder-tint',state.color);
    root.style.setProperty('--minternet-folder-art-color',
      state.tint?state.color:'#eabf61');
    for(const [field,id] of controls){
      const input=$(id);
      if(input)input.checked=state[field];
    }
    if($('bookmarkFolderTintColor'))
      $('bookmarkFolderTintColor').value=state.color;
  }
  function save(){
    try{localStorage.setItem(KEY,JSON.stringify(state));}catch{}
    window.dispatchEvent(new CustomEvent('minternet:folder-appearance-changed',
      {detail:{enabled:state.bevel||state.gloss||state.glass||state.tint}}));
  }
  for(const [field,id] of controls){
    $(id)?.addEventListener('change',event=>{
      state[field]=Boolean(event.target.checked);
      update();save();
    });
  }
  $('bookmarkFolderTintColor')?.addEventListener('input',event=>{
    const color=event.target.value;
    if(!validColor(color))return;
    state.color=color.toLowerCase();
    // Selecting a color from the minimalist picker immediately enables tint.
    state.tint=true;
    update();save();
  });
  $('bookmarkFolderAppearanceReset')?.addEventListener('click',()=>{
    state={...DEFAULT};update();save();
  });
  window.addEventListener('storage',event=>{
    if(event.key!==KEY)return;
    state=read();update();
  });
  update();
  window.minternetFolderAppearance={
    get:()=>({...state}),
    defaults:{...DEFAULT}
  };
})();
