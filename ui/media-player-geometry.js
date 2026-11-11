'use strict';
// Pure pixel geometry used by the floating local player and Node regression tests.
(function(root){
  function aspectSize(width,ratio,minWidth=80,minHeight=45){
    const r=Number.isFinite(ratio)&&ratio>0?ratio:16/9;
    const minimum=Math.ceil(Math.max(minWidth,minHeight*r));
    const w=Math.max(minimum,Math.round(Number.isFinite(width)?width:minimum));
    return {width:w,height:Math.max(minHeight,Math.round(w/r))};
  }
  function validRect(r){
    return r&&[r.left,r.top,r.right,r.bottom].every(Number.isFinite)&&
      r.right>r.left&&r.bottom>r.top;
  }
  function snapPosition(position,size,viewport,workArea,threshold=26){
    let x=position.x,y=position.y;
    if(!Number.isFinite(x)||!Number.isFinite(y)||
       !Number.isFinite(size.width)||!Number.isFinite(size.height)||
       size.width<=0||size.height<=0)return {x,y};
    const horizontal=[],vertical=[];
    function offer(target,values,priority){
      if(!validRect(target))return;
      const overlappingY=y+size.height>=target.top-threshold&&
        y<=target.bottom+threshold;
      const overlappingX=x+size.width>=target.left-threshold&&
        x<=target.right+threshold;
      if(overlappingY){
        for(const candidate of values.x)horizontal.push({value:candidate,priority});
      }
      if(overlappingX){
        for(const candidate of values.y)vertical.push({value:candidate,priority});
      }
    }
    if(validRect(viewport)){
      // Align to any segment of the content-area perimeter, not only corners.
      // Keep the player *inside* Minternet's web content when it fits.
      const xs=[viewport.left,viewport.right-size.width];
      const ys=[viewport.top,viewport.bottom-size.height];
      offer(viewport,{x:xs,y:ys},0);
    }
    if(validRect(workArea)){
      // The working area ends at the taskbar (bottom, top, left or right).
      offer(workArea,{
        x:[workArea.left,workArea.right-size.width],
        y:[workArea.top,workArea.bottom-size.height]
      },1);
    }
    function best(current,options){
      let choice=current,distance=threshold+1,priority=Infinity;
      for(const option of options){
        const d=Math.abs(option.value-current);
        if(d<=threshold&&(d<distance||(d===distance&&option.priority<priority))){
          choice=option.value;distance=d;priority=option.priority;
        }
      }
      return Math.round(choice);
    }
    x=best(x,horizontal);y=best(y,vertical);
    return {x,y};
  }
  const geometry={aspectSize,snapPosition};
  if(typeof module!=='undefined'&&module.exports)module.exports=geometry;
  if(root)root.MinternetMediaGeometry=geometry;
})(typeof window==='undefined'?globalThis:window);
