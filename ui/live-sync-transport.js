'use strict';
/* Event-driven Supabase Realtime transport. No setInterval for sync and no
 * Drive polling. A WebSocket delivers instant change signals; REST reads only
 * at initial sign-in, reconnect, or after a concrete server broadcast.
 * A 25-second Phoenix heartbeat keeps the socket alive (NOT a sync scan). */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.MinternetLiveTransport=api;
})(typeof window!=='undefined'?window:null,()=>{
  const TEXT='application/json';
  const safeProject=url=>{
    const u=new URL(url);
    if(u.protocol!=='https:'||!(/^[a-z0-9-]+\.supabase\.co$/i.test(u.hostname))||
       u.port||u.username||u.password||u.pathname!=='/')throw Error('Invalid Minternet sync backend');
    return u.origin;
  };
  const freeze=record=>({
    kind:record.kind,item_key:record.item_key,
    ciphertext:record.ciphertext||null,deleted:!!record.deleted,
    revision:Number(record.revision)||0,server_at:record.server_at||null
  });
  class Realtime {
    constructor({url,key,accessToken,refreshToken,userId,onChange,onStatus}){
      this.url=safeProject(url.endsWith('/')?url:url+'/');
      if(!key||!accessToken||!/^[a-f0-9-]{36}$/i.test(userId))
        throw Error('Google account and Supabase publishable key required');
      this.key=key;this.jwt=accessToken;this.refresh=refreshToken||null;this.uid=userId;
      this.onChange=onChange||(()=>{});this.onStatus=onStatus||(()=>{});
      this.topic='realtime:minternet:'+this.uid;
      this.socket=null;this.stopped=true;this.retry=null;this.heartbeat=null;
      this.retryDelay=500;this.seq=0;this.joinRef=null;this.last=new Map();
      this.pending=new Map();this.expiry=Date.now()+50*60_000;
    }
    headers(){return {apikey:this.key,Authorization:'Bearer '+this.jwt,Accept:TEXT};}
    async request(path,options={}){
      let result=await fetch(this.url+path,{...options,headers:{
        ...this.headers(),...(options.headers||{})}});
      if(result.status===401&&this.refresh){
        await this.refreshToken();
        result=await fetch(this.url+path,{...options,headers:{
          ...this.headers(),...(options.headers||{})}});
      }
      if(!result.ok)throw Error('Sync service HTTP '+result.status);
      const text=await result.text();
      return text?JSON.parse(text):null;
    }
    async refreshToken(){
      if(!this.refresh)throw Error('Google sync session expired');
      const response=await fetch(this.url+'/auth/v1/token?grant_type=refresh_token',{
        method:'POST',headers:{apikey:this.key,'Content-Type':TEXT},
        body:JSON.stringify({refresh_token:this.refresh})});
      if(!response.ok)throw Error('Google sync session expired; sign in again');
      const next=await response.json();
      this.jwt=next.access_token;
      this.refresh=next.refresh_token||this.refresh;
      this.expiry=Date.now()+Number(next.expires_in||3600)*1000;
      this.send('access_token',{access_token:this.jwt});
    }
    async listAll(){
      const result=[];
      for(let offset=0;offset<10000;offset+=500){
        const page=await this.request('/rest/v1/minternet_sync_state?select=kind,item_key,ciphertext,deleted,revision,server_at'+
          '&user_id=eq.'+encodeURIComponent(this.uid)+'&order=revision.asc&limit=500&offset='+offset);
        if(!Array.isArray(page))throw Error('Invalid cloud state');
        result.push(...page.map(freeze));
        if(page.length<500)break;
      }
      return result;
    }
    async read(kind,itemKey){
      const fields='kind,item_key,ciphertext,deleted,revision,server_at';
      const q='/rest/v1/minternet_sync_state?select='+fields+
        '&kind=eq.'+encodeURIComponent(kind)+
        '&item_key=eq.'+encodeURIComponent(itemKey)+
        '&user_id=eq.'+encodeURIComponent(this.uid)+'&limit=1';
      const result=await this.request(q);
      return Array.isArray(result)&&result[0]?freeze(result[0]):null;
    }
    async write(kind,itemKey,ciphertext,deleted=false){
      if(!windowMinternetValid(kind,itemKey))throw Error('Invalid sync item');
      if(!deleted&&(!ciphertext?.startsWith('enc1:')||ciphertext.length>262144))
        throw Error('Refusing unencrypted sync write');
      return this.request('/rest/v1/minternet_sync_state?on_conflict=user_id,kind,item_key',{
        method:'POST',headers:{'Content-Type':TEXT,
          Prefer:'resolution=merge-duplicates,return=representation'},
        body:JSON.stringify({user_id:this.uid,kind,item_key:itemKey,
          ciphertext:deleted?null:ciphertext,deleted:!!deleted})
      });
    }
    async undo(){
      return this.request('/rest/v1/rpc/minternet_undo_last',{
        method:'POST',headers:{'Content-Type':TEXT},body:'{}'});
    }
    async start(){
      if(!this.stopped)return;
      this.stopped=false;
      // Bootstrap snapshot exactly once and on reconnect (not on a timer).
      await this.reconcile();
      this.connect();
    }
    async reconcile(){
      const records=await this.listAll();
      for(const record of records)await this.deliver(record);
    }
    async deliver(record){
      if(!record||!windowMinternetValid(record.kind,record.item_key))return;
      const key=record.kind+':'+record.item_key;
      const previous=this.last.get(key)||0;
      if(record.revision<=previous)return;
      this.last.set(key,record.revision);
      await this.onChange(record);
    }
    async changed(payload){
      if(!payload||!windowMinternetValid(payload.kind,payload.item_key))return;
      const key=payload.kind+':'+payload.item_key;
      if((Number(payload.revision)||0)<=(this.last.get(key)||0))return;
      // Coalesce identical burst notifications. The database, not the
      // broadcast sender, is the authoritative winner for an item.
      if(this.pending.has(key))return;
      const promise=this.read(payload.kind,payload.item_key)
        .then(record=>this.deliver(record)).catch(err=>this.onStatus('Realtime resync: '+err.message))
        .finally(()=>this.pending.delete(key));
      this.pending.set(key,promise);
      await promise;
    }
    send(event,payload,topic=this.topic,joinRef=this.joinRef){
      if(!this.socket||this.socket.readyState!==1)return false;
      const ref=String(++this.seq);
      this.socket.send(JSON.stringify({topic,event,payload,ref,join_ref:joinRef}));
      return ref;
    }
    connect(){
      if(this.stopped)return;
      if(this.socket&&(this.socket.readyState===0||this.socket.readyState===1))return;
      const uri=this.url.replace(/^https:/,'wss:')+
        '/realtime/v1/websocket?apikey='+encodeURIComponent(this.key)+'&vsn=2.0.0';
      let socket;
      try{socket=new WebSocket(uri);}catch(err){this.scheduleRetry();return;}
      this.socket=socket;
      socket.onopen=()=>{
        this.retryDelay=500;
        this.joinRef=String(++this.seq);
        this.send('phx_join',{
          config:{broadcast:{ack:false,self:false},presence:{key:''},private:true},
          access_token:this.jwt
        },this.topic,this.joinRef);
        this.heartbeat=setInterval(()=>{this.send('heartbeat',{},'phoenix',null);},25000);
      };
      socket.onmessage=event=>{
        let value;
        try{value=JSON.parse(event.data);}catch{return;}
        if(value.topic!==this.topic)return;
        if(value.event==='phx_reply'&&value.ref===this.joinRef){
          if(value.payload?.status==='ok'){
            this.onStatus('Live sync connected');
            // Covers commits made during WebSocket disconnection/join.
            void this.reconcile().catch(err=>this.onStatus('Sync reconnect: '+err.message));
          }else this.onStatus('Live sync permission denied');
        }
        if(value.event==='broadcast'&&value.payload?.event==='sync'){
          void this.changed(value.payload.payload);
        }
        if(value.event==='system'&&value.payload?.status==='error')
          this.onStatus('Live sync connection error');
      };
      socket.onerror=()=>this.onStatus('Live sync reconnecting');
      socket.onclose=()=>{
        clearInterval(this.heartbeat);this.heartbeat=null;
        if(this.socket===socket)this.socket=null;
        this.scheduleRetry();
      };
    }
    scheduleRetry(){
      if(this.stopped||this.retry!==null)return;
      this.retry=setTimeout(()=>{
        this.retry=null;
        if(this.stopped)return;
        this.retryDelay=Math.min(30000,this.retryDelay*2);
        this.connect();
      },this.retryDelay);
    }
    stop(){
      this.stopped=true;clearTimeout(this.retry);this.retry=null;
      clearInterval(this.heartbeat);this.heartbeat=null;
      const socket=this.socket;this.socket=null;
      if(socket)socket.close(1000,'Sign out');
      this.last.clear();this.pending.clear();
    }
  }
  function windowMinternetValid(kind,key){
    return ['tab','group','bookmark','login','payment','undo','prefs'].includes(kind)&&
      typeof key==='string'&&/^[A-Za-z0-9_:.@-]{1,180}$/.test(key);
  }
  return {Realtime,safeProject,windowMinternetValid};
});