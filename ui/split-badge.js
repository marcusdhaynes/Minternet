'use strict';
(() => {
  const send=action=>{location.href='https://minternet.invalid/'+action;};
  const normal=document.getElementById('return');
  const badge=document.querySelector('.split-badge');
  let gesture=null;
  const moved=event=>gesture&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>=6;
  normal?.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.isPrimary===false||gesture)return;
    gesture={id:event.pointerId,x:event.clientX,y:event.clientY,dragging:false};
    try{normal.setPointerCapture(event.pointerId);}catch{}
    // Native Windows capture also tracks release outside this child WebView.
    send('drag');
  });
  normal?.addEventListener('pointermove',event=>{
    if(gesture?.id!==event.pointerId)return;
    if(moved(event)){gesture.dragging=true;badge?.classList.add('dragging');}
  });
  normal?.addEventListener('pointerup',event=>{
    if(gesture?.id!==event.pointerId)return;
    const dragged=gesture.dragging||moved(event);
    gesture=null;badge?.classList.remove('dragging');
    if(dragged){
      event.preventDefault();
      send('drop?x='+encodeURIComponent(event.clientX)+'&y='+encodeURIComponent(event.clientY));
    }else send('focus');
  });
  const cancel=()=>{gesture=null;badge?.classList.remove('dragging');};
  normal?.addEventListener('pointercancel',cancel);
  normal?.addEventListener('lostpointercapture',cancel);
  normal?.addEventListener('click',event=>{if(event.detail===0)send('focus');});
  normal?.addEventListener('dblclick',()=>send('return'));
  normal?.addEventListener('dragstart',event=>event.preventDefault());
})();
