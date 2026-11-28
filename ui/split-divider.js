'use strict';
document.body.addEventListener('pointerdown',event=>{
  if(event.button!==0||event.isPrimary===false)return;
  event.preventDefault();
  document.body.classList.add('dragging');
  try{document.body.setPointerCapture(event.pointerId);}catch{}
  location.href='https://minternet.invalid/resize';
});
for(const name of ['pointerup','pointercancel','lostpointercapture']){
  document.body.addEventListener(name,()=>document.body.classList.remove('dragging'));
}
document.body.addEventListener('dragstart',event=>event.preventDefault());
