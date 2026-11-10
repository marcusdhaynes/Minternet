'use strict';
// Presentation-only hostname labels. Never fetch page metadata or overwrite
// manually provided names, and never infer credentials from website content.
window.MinternetSiteNames=Object.freeze({
  label(address){
    try{
      const u=new URL(address);
      const hostname=u.hostname.toLowerCase().replace(/^www\./,'');
      if(!/^https?:$/.test(u.protocol))return '';
      const canonical=hostname.replace(/^(accounts|login|auth|app|m|mail)\./,'');
      const pieces=canonical.split('.');
      const compound=['co.uk','org.uk','com.au','co.id','com.br','co.jp'];
      const suffix=pieces.slice(-2).join('.');
      const key=pieces[Math.max(0,pieces.length-(compound.includes(suffix)?3:2))]||pieces[0];
      const special={github:'GitHub',youtube:'YouTube',google:'Google',
        chatgpt:'ChatGPT',reddit:'Reddit',linkedin:'LinkedIn',microsoft:'Microsoft',
        instagram:'Instagram',facebook:'Facebook',whatsapp:'WhatsApp',
        gmail:'Gmail',amazon:'Amazon',x:'X',netflix:'Netflix'};
      const label=special[key]||key.replace(/[-_]+/g,' ').replace(/\b\p{L}/gu,c=>c.toUpperCase());
      return label||hostname;
    }catch{return '';}
  }
});
