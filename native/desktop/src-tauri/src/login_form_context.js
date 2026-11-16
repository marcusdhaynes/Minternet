/* Read-only native form probe. Never returns entered password, identity or
   payment values to browser chrome. All origin checks remain in Rust. */
(function(){
  'use strict';
  if(window!==window.top||!document.hasFocus())return null;
  // Site frameworks may put their focused input inside open shadow roots
  // or same-origin frames. Follow only the focused path (not the entire DOM).
  let field=document.activeElement;
  for(let depth=0;field&&depth<8;depth++){
    let child=field.shadowRoot?.activeElement;
    if(!child&&field.tagName==='IFRAME'){
      try{
        const frame=field.contentDocument;
        if(frame?.defaultView?.location.origin===location.origin)
          child=frame.activeElement;
      }catch{}
    }
    if(!child)break;
    field=child;
  }
  if(!field||!['INPUT','TEXTAREA','SELECT'].includes(field.tagName)||
      field.disabled||field.readOnly||['hidden','file'].includes(field.type))return null;
  let r=field.getBoundingClientRect();
  if(r.width<16||r.height<10)return null;
  // Rectangles inside same-origin frames use frame-local coordinates.
  const owner=field.ownerDocument;
  if(owner!==document){
    try{
      const frame=owner.defaultView?.frameElement;
      if(frame){
        const parent=frame.getBoundingClientRect();
        r={left:r.left+parent.left,bottom:r.bottom+parent.top,
          width:r.width,height:r.height};
      }
    }catch{}
  }
  const auto=(field.autocomplete||'').toLowerCase().split(/\s+/);
  const desc=[
    field.name||'',field.id||'',field.placeholder||'',
    field.getAttribute('aria-label')||'',field.labels?.[0]?.textContent||'',
    field.closest('label')?.textContent||''
  ].join(' ').toLowerCase();
  const root=field.getRootNode?.()||document;
  const inputs=[...root.querySelectorAll('input')];
  const hasPassword=inputs.filter(e=>e.type==='password'&&
    !e.disabled&&e.getBoundingClientRect().width>0);
  const possibleUsers=inputs.filter(e=>['text','email'].includes(e.type)&&
    !e.disabled&&!e.readOnly&&e.getBoundingClientRect().width>0&&
    !/(otp|one.?time|verification|mfa|security.?code|captcha|search)/i.test(
      [e.name,e.id,e.placeholder,e.getAttribute('aria-label')].join(' ')));
  const loginUser=possibleUsers.find(e=>
    (e.autocomplete||'').toLowerCase().split(/\s+/).includes('username')||
    e.type==='email'||/user|email|login|account|identifier|student.?id|net.?id/i.test(
      [e.name,e.id,e.placeholder,e.getAttribute('aria-label'),
       e.labels?.[0]?.textContent].join(' ')))||
    (hasPassword.length===1&&possibleUsers.length===1?possibleUsers[0]:null);
  const routeHint=[location.hostname,location.pathname,
    document.title||'',document.querySelector('h1')?.textContent||'',
    field.form?.getAttribute('action')||'',field.form?.id||'',
    field.form?.className||''].join(' ');
  const registration=/(?:sign.?up|register|create.?account|forgot.?password|reset.?password|new.?password)/i.test(routeHint);
  const loginRoute=/(?:log.?in|sign.?in|sign.?on|auth|account|session|identify|sso|pingfed|saml)/i.test(routeHint);
  const usernameField=auto.includes('username')||loginUser===field||
    (field.type==='text'&&/username|user.?id|email|net.?id|student.?id/i.test(desc));
  // Username-first SSO pages have no password input until the next step.
  // Do not misclassify ordinary email/newsletter boxes or signup forms.
  const login=!registration && (
    (hasPassword.length===1&&(field.type==='password'||usernameField))||
    (hasPassword.length===0&&usernameField&&loginRoute)
  );
  let kind='',key='';
  if(login){kind='login';key='login';}
  else if(auto.some(x=>x.startsWith('cc-'))||/credit.?card|card.?number|cc.?number|expir/i.test(desc)){
    kind='payment';key='payment';
  }else{
    const pairs=[
      ['passport-number',/passport.{0,25}(number|no|id)/],
      ['passport-country',/passport.{0,25}country|issuing.?country/],
      ['passport-expiry',/passport.{0,25}(expir|valid)/],
      ['drivers-license',/driver.s?.?licen[cs]e.{0,25}(number|no|id)/],
      ['drivers-license-state',/driver.s?.?licen[cs]e.{0,25}(state|region)/],
      ['national-id',/national.?id|identity.?number/],
      ['tax-id',/tax.?id|taxpayer.?number/],
      ['vehicle-make',/vehicle.?make|car.?make/],
      ['vehicle-model',/vehicle.?model|car.?model/],
      ['vehicle-year',/vehicle.?year|model.?year/],
      ['vehicle-color',/vehicle.?colou?r/],
      ['license-plate',/licen[cs]e.?plate|plate.?number/],
      ['vin',/\bvin\b|vehicle.?identification.?number/],
      ['given-name',/first.?name|given.?name/],
      ['family-name',/last.?name|surname|family.?name/],
      ['middle-name',/middle.?name/],
      ['full-name',/full.?name|your.?name/],
      ['street-address',/street.?address|full.?address/],
      ['address-line1',/address.?1|address.?line.?1/],
      ['address-line2',/address.?2|address.?line.?2|apartment|suite/],
      ['city',/\bcity\b|\btown\b/],
      ['region',/state|province|region/],
      ['postal-code',/zip|postal/],
      ['country',/\bcountry\b/],
      ['date-of-birth',/date.?of.?birth|\bdob\b/],
      ['email',/email|e-mail/],
      ['phone',/phone|mobile|telephone/],
      ['company',/company|organization/],
      ['job-title',/job.?title|occupation/],
      ['website',/web.?site|\burl\b/]
    ];
    const tokens={
      name:'full-name','given-name':'given-name','family-name':'family-name',
      'additional-name':'middle-name','nickname':'nickname',email:'email',
      tel:'phone','tel-national':'phone',organization:'company',
      'organization-title':'job-title','street-address':'street-address',
      'address-line1':'address-line1','address-line2':'address-line2',
      'address-level2':'city','address-level1':'region','postal-code':'postal-code',
      country:'country','country-name':'country',bday:'date-of-birth',url:'website'
    };
    key=auto.map(x=>tokens[x]).find(Boolean)||pairs.find(p=>p[1].test(desc))?.[0]||'';
    if(key)kind='identity';
  }
  if(!kind)return null;
  const entered=Boolean(field.value);
  const loginReady=kind==='login'&&hasPassword.length===1&&
    Boolean(hasPassword[0].value)&&(!loginUser||Boolean(loginUser.value));
  const fieldIndex=[...root.querySelectorAll('input,textarea,select')].indexOf(field);
  return {kind,key,fieldIndex,hasValue:entered,saveReady:loginReady,
    x:Math.round(r.left),y:Math.round(r.bottom),width:Math.round(r.width),
    height:Math.round(r.height)};
})()
