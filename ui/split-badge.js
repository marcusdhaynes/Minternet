'use strict';
(() => {
  const control=document.getElementById('return');
  if(!control)return;
  const send=action=>{location.href='https://minternet.invalid/'+action;};
  control.addEventListener('pointerdown',event=>{
    if(event.button===0&&event.isPrimary!==false)send('drag');
  });
  control.addEventListener('click',()=>send('return'));
  control.addEventListener('dragstart',event=>event.preventDefault());
})();
