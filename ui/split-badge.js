'use strict';
(() => {
  const send=action=>{location.href='https://minternet.invalid/'+action;};
  const normal=document.getElementById('return');
  const resize=document.getElementById('resize');
  normal?.addEventListener('pointerdown',event=>{
    if(event.button===0&&event.isPrimary!==false)send('drag');
  });
  normal?.addEventListener('click',()=>send('return'));
  resize?.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.isPrimary===false)return;
    event.preventDefault();event.stopPropagation();
    send('resize');
  });
  for(const button of [normal,resize])
    button?.addEventListener('dragstart',event=>event.preventDefault());
})();