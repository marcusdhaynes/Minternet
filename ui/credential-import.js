'use strict';
// User-selected local exports only. Never inspect another browser's profile,
// automatically read files, transmit plaintext credentials, or save export text.
(() => {
  const $=id=>document.getElementById(id);
  const passwords=$('importPasswords'),cards=$('importPaymentMethods');
  const chooser=$('credentialImportFile'),status=$('credentialImportSummary');
  if(!passwords||!cards||!chooser||!status||!window.minternet)return;
  const api=window.minternet;
  let kind='password';
  const say=message=>{status.hidden=false;status.textContent=message;};
  const cleanHeader=h=>String(h||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
  const norm=r=>Object.fromEntries(Object.entries(r||{}).map(([k,v])=>[cleanHeader(k),v]));
  const field=(row,names)=>names.map(cleanHeader).map(k=>row[k])
    .find(v=>v!==null&&v!==undefined&&String(v).trim()!=='');
  // Supports quoted commas, multiline quoted cells, CRLF and UTF-8 BOM.
  function parseDelimited(source,sep){
    const records=[],row=[];let cell='',quoted=false;
    const text=source.replace(/^\uFEFF/,'');
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(c==='"'){
        if(quoted&&text[i+1]==='"'){cell+='"';i++;}
        else quoted=!quoted;
      }else if(c===sep&&!quoted){row.push(cell);cell='';}
      else if((c==='\n'||c==='\r')&&!quoted){
        if(c==='\r'&&text[i+1]==='\n')i++;
        row.push(cell);cell='';
        if(row.some(value=>value.trim()))records.push(row.slice());
        row.length=0;
        if(records.length>2200)throw Error('Export has too many rows; split it into smaller files.');
      }else cell+=c;
    }
    if(quoted)throw Error('Export has an unmatched CSV quote.');
    row.push(cell);
    if(row.some(value=>value.trim()))records.push(row);
    const header=(records.shift()||[]).map(cleanHeader);
    if(!header.length)throw Error('This file has no column headers.');
    return records.map(cols=>Object.fromEntries(header.map((key,i)=>[key,cols[i]||''])));
  }
  function recordsFrom(source,name){
    const data=source.replace(/^\uFEFF/,'').trim();
    if(!data)throw Error('This export is empty.');
    if(name.toLowerCase().endsWith('.json')){
      const root=JSON.parse(data);
      if(Array.isArray(root))return root;
      if(Array.isArray(root?.items)){
        // Bitwarden JSON: type 1 = login; type 3 = card.
        if(kind==='password')return root.items
          .filter(item=>item?.type===1||item?.login).map(item=>({
            origin:item.login?.uris?.find(x=>x?.uri)?.uri||'',
            username:item.login?.username||'',password:item.login?.password||'',
            name:item.name||''
          }));
        return root.items.filter(item=>item?.type===3||item?.card).map(item=>({
          label:item.name||'',name:item.card?.cardholderName||'',
          number:item.card?.number||'',month:item.card?.expMonth||'',
          year:item.card?.expYear||'',postal:item.card?.postal||''
        }));
      }
      const dataRows=kind==='password'
        ?root?.logins||root?.passwords||root?.entries
        :root?.cards||root?.paymentMethods||root?.payment_methods;
      if(Array.isArray(dataRows))return dataRows;
      throw Error('Unrecognized JSON export. Choose a CSV export instead.');
    }
    const firstLine=data.split(/\r?\n/,1)[0]||'';
    const sep=name.toLowerCase().endsWith('.tsv')?'\t':
      firstLine.split('\t').length>firstLine.split(',').length?'\t':',';
    return parseDelimited(data,sep);
  }
  function asLogin(raw){
    if(!raw||typeof raw!=='object')return null;
    const row=norm(raw),record=raw.login||{};
    const address=String(field(row,['url','origin','website','site','login_uri',
      'loginuri','loginurl','hostname','loginwebsite','websites'])||
      record.uris?.[0]?.uri||'').trim();
    const username=String(field(row,['username','user','login_username',
      'loginusername','email','userid','account','login'])||record.username||'').trim();
    const password=String(field(row,['password','login_password','loginpassword',
      'pass','passphrase'])||record.password||'');
    if(!address||!password||username.length>320||password.length>4096)return null;
    try{
      const url=new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(address)?address:'https://'+address);
      if(url.protocol!=='https:'||!url.hostname||url.username||url.password)return null;
      return {origin:url.origin,username,password,autofill:false};
    }catch{return null;}
  }
  function asCard(raw){
    if(!raw||typeof raw!=='object')return null;
    const row=norm(raw);
    const number=String(field(row,['number','cardnumber','card_number','creditcardnumber',
      'credit_card_number','ccnumber','pan'])||'').replace(/[ -]/g,'');
    const name=String(field(row,['cardholder','cardholdername','nameoncard','cardname',
      'card_holder','name'])||'').trim();
    const label=String(field(row,['label','title','nickname','cardlabel','name'])||'').slice(0,80);
    const postal=String(field(row,['postal','zipcode','zipcodebilling','postalcode',
      'billingpostalcode','billingzip','zip'])||'').slice(0,40);
    const expiry=String(field(row,['expiry','expiration','expirationdate',
      'expirydate','expdate','expires'])||'').trim();
    let month=Number(field(row,['month','expmonth','expiry_month','expirationmonth','ccmonth']));
    let year=Number(field(row,['year','expyear','expiry_year','expirationyear','ccyear']));
    if((!month||!year)&&expiry){
      const parts=expiry.match(/^(\d{1,2})\s*[\/-]\s*(\d{2,4})$/);
      if(parts){month=Number(parts[1]);year=Number(parts[2]);}
    }
    if(year>=0&&year<100)year+=2000;
    if(!/^\d{12,19}$/.test(number)||!name||!(month>=1&&month<=12)||
       !(year>=2020&&year<=2100))return null;
    return {label,name,number,month,year,postal};
  }
  function begin(which){
    kind=which;
    if(!window.__TAURI__){say('Importing into the encrypted vault requires the desktop app.');return;}
    // Opening a file picker must occur synchronously inside the user's click:
    // an awaited native status check can consume transient user activation.
    chooser.value='';
    chooser.click();
  }
  passwords.addEventListener('click',()=>begin('password'));
  cards.addEventListener('click',()=>begin('card'));
  chooser.addEventListener('change',async()=>{
    const file=chooser.files?.[0];
    if(!file)return;
    if(file.size>10_000_000){say('Export exceeds 10 MB. Split it into smaller files.');return;}
    passwords.disabled=cards.disabled=true;
    try{
      const state=await api.command('vault-status');
      if(!state?.unlocked)
        throw Error('Unlock Passwords or Payment Methods in Settings first.');
      const text=await file.text();
      const parsed=recordsFrom(text,file.name);
      const candidates=parsed.map(kind==='password'?asLogin:asCard).filter(Boolean);
      // Keep a batch bounded. Extra rows are never silently discarded.
      if(parsed.length>2000||candidates.length>2000)
        throw Error('Import up to 2,000 records at a time; split larger exports.');
      if(!candidates.length)throw Error(kind==='password'
        ?'No usable HTTPS usernames/passwords found in this export.'
        :'No complete payment cards found. Many browsers export masked cards only.');
      const answer=await api.command('vault-import',{kind,entries:candidates});
      if(!answer?.ok)throw Error(answer?.message||'Encrypted vault import failed.');
      const label=kind==='password'?'passwords':'payment methods';
      say('Imported '+answer.imported+' '+label+'; skipped '+
        (Number(answer.skipped||0)+parsed.length-candidates.length)+
        ' invalid or existing entries. The export file was not saved by Minternet.');
    }catch(error){
      // Never include file contents, login names, or card numbers in status.
      const message=String(error?.message||'Unsupported export');
      say('Import was not completed: '+message.slice(0,180));
    }finally{
      chooser.value='';passwords.disabled=cards.disabled=false;
    }
  });
})();
