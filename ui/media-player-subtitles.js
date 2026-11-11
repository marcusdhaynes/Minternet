'use strict';
// Small, zero-dependency caption parser for the local mini-player.
// Cues are displayed with textContent (never injected as HTML).
(function(root){
  const toSeconds=stamp=>{
    const t=String(stamp||'').trim().replace(',', '.');
    const parts=t.split(':').map(Number);
    if(parts.length<2||parts.length>3||parts.some(n=>!Number.isFinite(n)))return NaN;
    return parts.reduce((n,p)=>n*60+p,0);
  };
  function parse(text,name=''){
    const plain=String(text||'').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
    let cues=[];
    if(/\.(ass|ssa)$/i.test(name)||/^\s*\[Script Info\]/i.test(plain)){
      const lines=plain.split('\n');
      let mapping=['layer','start','end','style','name','marginl','marginr','marginv','effect','text'];
      for(const line of lines){
        if(/^Format\s*:/i.test(line)){mapping=line.slice(line.indexOf(':')+1).split(',').map(s=>s.trim().toLowerCase());}
        if(!/^Dialogue\s*:/i.test(line))continue;
        const fields=line.slice(line.indexOf(':')+1).split(',');
        if(fields.length<mapping.length)continue;
        const start=toSeconds(fields[mapping.indexOf('start')]);
        const end=toSeconds(fields[mapping.indexOf('end')]);
        const contents=fields.slice(mapping.indexOf('text')).join(',').replace(/\{[^}]*\}/g,'').replace(/\\N|\\n/g,'\n');
        if(Number.isFinite(start)&&end>start&&contents.trim())cues.push({start,end,text:contents.trim()});
      }
    }else{
      for(const block of plain.split(/\n\s*\n/g)){
        const lines=block.split('\n').map(l=>l.trim()).filter(Boolean);
        let idx=lines.findIndex(l=>l.includes('-->'));
        if(idx<0)continue;
        const parts=lines[idx].split(/\s*-->\s*/);
        if(parts.length!==2)continue;
        const start=toSeconds(parts[0]),end=toSeconds(parts[1].split(/\s+/)[0]);
        const contents=lines.slice(idx+1).join('\n').replace(/<[^>]*>/g,'').trim();
        if(Number.isFinite(start)&&Number.isFinite(end)&&end>start&&contents)
          cues.push({start,end,text:contents});
      }
    }
    cues.sort((a,b)=>a.start-b.start);
    return cues;
  }
  const api={parse,toSeconds};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.MinternetSubtitles=api;
})(typeof window==='undefined'?globalThis:window);
