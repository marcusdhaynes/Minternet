/* Native-only login injection. This script runs in the selected HTTPS website
   WebView. Secret values are injected by trusted Rust and never returned to
   the chrome UI. Do not use on arbitrary untrusted preview pages. */
(function(){
      'use strict';
      const credential=__MINTERNET_LOGIN_PAYLOAD__;
      if(location.protocol!=='https:'||location.origin!==credential.origin||
         window!==window.top)return;
      const isWgu=/^https:\/\/(?:[a-z0-9-]+\.)*wgu\.edu$/i.test(location.origin);
      // Automatic submission is deliberately limited to the real WGU sign-on
      // path. Other sites are autofill-only, and every MFA step stays with WGU.
      const wguSignOn=isWgu&&
        /^\/(?:pingfed|signin|signon|login|sso|auth)(?:\/|$)/i.test(location.pathname);
      const submitEnabled=credential.autoSubmit===true&&wguSignOn;
      const previous=window.__minternetLoginStatus;
      const status={usernameFilled:false,passwordFilled:false,
        submitted:previous?.submitted===true,waiting:true};
      window.__minternetLoginStatus=status;
      const submittedForms=window.__minternetWguSubmittedForms||new WeakSet();
      window.__minternetWguSubmittedForms=submittedForms;
      // WGU and other SPA sign-in pages sometimes clear an existing input.
      // Recover from website resets, but never undo a real user's edits.
      const marked=window.__minternetFilledLoginInputs||new WeakSet();
      const userTouched=window.__minternetUserChangedLoginInputs||new WeakSet();
      const lastFilled=window.__minternetLastLoginFillTime||new WeakMap();
      window.__minternetFilledLoginInputs=marked;
      window.__minternetUserChangedLoginInputs=userTouched;
      window.__minternetLastLoginFillTime=lastFilled;
      try{window.__minternetLoginJob?.stop?.();}catch{}
      const register=/(?:sign.?up|register|create.?account|join|forgot.?password|reset.?password|change.?password)/i;
      const signin=/(?:log.?in|sign.?in|sign.?on|pingfed|saml|sso|auth|account|session|identify)/i;
      const safeRoute=()=>!register.test(location.pathname+' '+(location.hash||''));
      const visible=el=>el?.tagName==='INPUT'&&
        !el.disabled&&!el.readOnly&&el.getClientRects().length>0&&
        el.type!=='hidden'&&el.type!=='file';
      const token=el=>(el.getAttribute('autocomplete')||'').toLowerCase().split(/\s+/);
      const hint=el=>[
        el.name||'',el.id||'',el.placeholder||'',el.getAttribute('aria-label')||'',
        el.labels?.[0]?.textContent||'',el.closest('label')?.textContent||'',
        el.getAttribute('title')||'',el.getAttribute('data-testid')||''
      ].join(' ').toLowerCase();
      // Revisit delayed iframe and shadow-DOM login forms without bypassing
      // the same-origin policy. Never bridge to a different origin.
      const frameNodes=new Set();
      function roots(){
        const result=[document],seen=new Set(result),queue=[document];
        let budget=0;
        while(queue.length&&budget<6000&&result.length<28){
          const root=queue.shift();
          let nodes;
          try{nodes=root.querySelectorAll('*');}catch{continue;}
          for(const node of nodes){
            if(++budget>6000)break;
            if(node.shadowRoot&&!seen.has(node.shadowRoot)){
              seen.add(node.shadowRoot);queue.push(node.shadowRoot);result.push(node.shadowRoot);
              if(observer)try{observer.observe(node.shadowRoot,watchOptions);}catch{}
            }
            if(node.tagName==='IFRAME'){
              if(!frameNodes.has(node)){
                frameNodes.add(node);
                try{node.addEventListener('load',attempt);}catch{}
              }
              try{
                const frame=node.contentDocument;
                if(frame&&frame.defaultView?.location.origin===credential.origin&&!seen.has(frame)){
                  seen.add(frame);queue.push(frame);result.push(frame);
                  if(observer&&frame.documentElement)try{
                    observer.observe(frame.documentElement,watchOptions);
                  }catch{}
                }
              }catch{}
            }
          }
        }
        return result;
      }
      function fields(){
        const list=[];
        for(const root of roots()){
          try{list.push(...root.querySelectorAll('input'));}catch{}
        }
        return list.filter(visible);
      }
      const put=(element,value)=>{
        if(!element||element.value||userTouched.has(element)||
           typeof value!=='string'||!value)return false;
        // Avoid a hot loop when a site instantly empties its own form.
        const now=Date.now();
        if(lastFilled.has(element)&&now-lastFilled.get(element)<900)return false;
        // Use the input's own Window: same-origin frames have different DOM
        // prototypes, so the parent Window's setter can silently fail.
        const win=element.ownerDocument?.defaultView||window;
        const setter=Object.getOwnPropertyDescriptor(
          win.HTMLInputElement?.prototype||HTMLInputElement.prototype,'value')?.set;
        if(setter)setter.call(element,value);else element.value=value;
        const EventType=win.Event||Event;
        element.dispatchEvent(new EventType('input',{bubbles:true,composed:true}));
        element.dispatchEvent(new EventType('change',{bubbles:true,composed:true}));
        marked.add(element);
        lastFilled.set(element,now);
        element.addEventListener?.('input',event=>{
          if(event.isTrusted)userTouched.add(element);
        });
        return true;
      };
      const userCandidate=el=>
        token(el).includes('username') || token(el).includes('email') ||
        el.type==='email' || (el.type==='text' &&
          /user|email|e.?mail|login|account|identifier|net.?id|student.?id|sign.?on/i.test(hint(el)));
      const invalidAccount=el=>token(el).includes('one-time-code')||
        /otp|one.?time|verification|mfa|auth.?code|search|security.?code|captcha/i.test(hint(el));
      const accountFor=(inputs,password)=>{
        const local=password.form?
          inputs.filter(el=>el.form===password.form):inputs;
        const candidates=local.filter(el=>el!==password &&
          ['text','email'].includes(el.type)&&!invalidAccount(el));
        // Autocomplete attributes and labels are reliable when present.
        const named=candidates.find(userCandidate);
        if(named)return named;
        if(candidates.length===1)return candidates[0];
        // Some PingFederate/SPA login templates render the username outside
        // the password's HTML form. Only permit a single unambiguous account
        // field across the visible document; never choose a random text input.
        if(password.form){
          const others=inputs.filter(el=>el!==password &&
            ['text','email'].includes(el.type)&&!invalidAccount(el));
          const matches=others.filter(userCandidate);
          if(matches.length===1)return matches[0];
          if(others.length===1)return others[0];
        }
        return null;
      };
      const dangerousForm=el=>{
        const form=el?.form;
        return form instanceof HTMLFormElement &&
          register.test([form.getAttribute('action')||'',form.id,form.className].join(' '));
      };
      let done=false,observer=null,delayed=0,submissionTimer=0;
      const rememberUserChanged=window.__minternetRememberUserChanged||new WeakSet();
      window.__minternetRememberUserChanged=rememberUserChanged;
      function checkRemember(form,password){
        if(!submitEnabled)return;
        const doc=password.ownerDocument||document;
        const boxes=[...doc.querySelectorAll('input[type="checkbox"]')].filter(box=>
          !box.disabled&&!box.readOnly&&!rememberUserChanged.has(box)&&
          (!form||box.form===form||!box.form));
        for(const box of boxes){
          const name=hint(box)+' '+(
            box.parentElement?.textContent||'')+' '+
            (box.closest('label')?.textContent||'');
          if(!/(?:remember(?:\\s+(?:me|my|this|username|login|sign.?in|device|account))?|keep\\s+me\\s+signed\\s+in|stay\\s+signed\\s+in|trust\\s+this\\s+device)/i.test(name)||
             /(?:do\\s+not|don.t|never|forgot|terms|agree|consent|unsubscribe)/i.test(name))
            continue;
          if(box.checked)continue;
          // A direct checked setter plus synthetic input/change is recognized
          // by ordinary and React-backed checkboxes without clicking a label
          // that might submit the form unexpectedly.
          const win=box.ownerDocument?.defaultView||window;
          const setter=Object.getOwnPropertyDescriptor(
            win.HTMLInputElement?.prototype||HTMLInputElement.prototype,'checked')?.set;
          if(setter)setter.call(box,true);else box.checked=true;
          const EventType=win.Event||Event;
          box.dispatchEvent(new EventType('input',{bubbles:true,composed:true}));
          box.dispatchEvent(new EventType('change',{bubbles:true,composed:true}));
          box.addEventListener?.('change',event=>{
            if(event.isTrusted)rememberUserChanged.add(box);
          });
          status.rememberChecked=true;
        }
      }
      function queueSignOn(form,account,password){
        const target=form||password;
        if(!submitEnabled||!account||!password||submissionTimer||
           submittedForms.has(target)||userTouched.has(account)||
           userTouched.has(password)||
           account.value!==credential.username||
           password.value!==credential.password)return;
        if(form){
          // Never auto-post an encrypted saved login across origins, even if
          // a site or extension inserted an unrelated form.
          try{
            const action=new URL(form.getAttribute('action')||location.href,location.href);
            if(action.protocol!=='https:'||action.origin!==credential.origin)return;
          }catch{return;}
        }
        const challenge=fields().some(input=>
          (!form||input.form===form)&&input!==account&&input!==password&&
          (invalidAccount(input)||token(input).includes('one-time-code')));
        if(challenge)return;
        let previous;
        try{previous=JSON.parse(sessionStorage.getItem('minternet.wgu.signon.last.v1')||'null');}catch{}
        // Browser Refresh is a fresh user-requested sign-on; network
        // redirects retain an eight-second retry guard against loops.
        const navType=window.performance?.getEntriesByType?.('navigation')?.[0]?.type;
        if(navType!=='reload'&&previous?.path===location.pathname &&
           Date.now()-Number(previous.at||0)<8000)return;
        submissionTimer=setTimeout(()=>{
          submissionTimer=0;
          if(done||(form?.isConnected===false)||account.isConnected===false||
             password.isConnected===false||
             account.value!==credential.username||
             password.value!==credential.password||userTouched.has(account)||
             userTouched.has(password))return;
          // Prefer WGU's actual Sign On button so its event handlers and
          // client-side validation run normally. Never use form.submit(),
          // which bypasses submit events and HTML validity checks.
          checkRemember(form,password);
          const buttons=[...(form||password.ownerDocument).querySelectorAll?.(
            'button,input[type="submit"],input[type="button"]')||[]];
          const signOn=buttons.find(button=>{
            const label=(button.tagName==='INPUT'?button.value:button.textContent)||'';
            return !button.disabled&&
              /^(sign\s*on|sign\s*in|log\s*in)$/i.test(label.trim());
          });
          let issued=false;
          try{
            if(signOn&&typeof signOn.click==='function'){
              signOn.click();issued=true;
            }else if(form&&typeof form.requestSubmit==='function'){
              form.requestSubmit();issued=true;
            }
          }catch{/* A failed WGU handler must remain visible; do not force-submit. */}
          if(!issued)return;
          submittedForms.add(target);
          status.submitted=true;
          try{sessionStorage.setItem('minternet.wgu.signon.last.v1',JSON.stringify({
            path:location.pathname,at:Date.now()
          }));}catch{}
        },180);
      }
      const watchOptions={childList:true,subtree:true,attributes:true,
        attributeFilter:['type','autocomplete','style','class']};
      const stop=()=>{
        done=true;
        if(observer)observer.disconnect();
        for(const frame of frameNodes)try{frame.removeEventListener('load',attempt);}catch{}
        frameNodes.clear();
        document.removeEventListener('focusin',onFocus,true);
        window.removeEventListener('pageshow',attempt);
        window.removeEventListener('popstate',attempt);
        window.removeEventListener('hashchange',attempt);
        if(delayed)clearTimeout(delayed);
        if(submissionTimer)clearTimeout(submissionTimer);
        // Avoid retaining the password in a long-lived page closure.
        credential.password='';
        if(window.__minternetLoginJob?.stop===stop)
          window.__minternetLoginJob=null;
      };
      window.__minternetLoginJob={stop};
      function tryFill(){
        if(done)return true;
        if(location.origin!==credential.origin||!safeRoute()){stop();return true;}
        const inputs=fields(),passwords=inputs.filter(el=>el.type==='password');
        const current=passwords.filter(el=>token(el).includes('current-password'));
        // A register/reset form can expose multiple new password inputs:
        // never choose an arbitrary field.
        const newPasswords=passwords.filter(el=>token(el).includes('new-password')||
          token(el).includes('one-time-code'));
        if(newPasswords.length && current.length===0)return false;
        const password=current.length===1?current[0]:
          (passwords.length===1&&newPasswords.length===0?passwords[0]:null);
        if(password){
          if(dangerousForm(password)){stop();return true;}
          const account=accountFor(inputs,password);
          // Never replace anything the person has already entered.
          if((password.value&&!marked.has(password)) ||
             (account?.value&&account.value!==credential.username)){
            // Existing unrecognized input is user-typed; never overwrite it.
            stop();return true;
          }
          if(account)put(account,credential.username);
          // Do not stop observing after one successful fill: PingFederate
          // and other SPAs can replace an already-filled input with a new
          // blank node without issuing a navigation event.
          put(password,credential.password);
          status.usernameFilled=Boolean(account&&
            account.value===credential.username);
          status.passwordFilled=password.value===credential.password;
          status.waiting=!(status.usernameFilled&&status.passwordFilled);
          if(status.usernameFilled&&status.passwordFilled){
            queueSignOn(password.form,account,password);
          }
          return false;
        }
        // Username-first providers (Google, Microsoft and many SPAs) show
        // the email field before creating a password input.
        const accountInputs=inputs.filter(el=>
          ['text','email'].includes(el.type)&&!invalidAccount(el));
        const username=accountInputs.find(el=>token(el).includes('username'))||
          accountInputs.find(el=>userCandidate(el)&&
            (signin.test(location.pathname+' '+(location.hash||''))||
             signin.test((el.form?.getAttribute('action')||'')+' '+
               (el.form?.id||'')+' '+(el.form?.className||''))||
             // A sole email input may be step one even on a neutral URL.
             (accountInputs.length===1&&
               (el.type==='email'||token(el).includes('email')))));
        if(username&&!dangerousForm(username) && !username.value){
          put(username,credential.username);
        }
        // Retain the bounded observer until the password step mounts.
        return false;
      }
      let last=0;
      function attempt(){
        if(done)return;
        const now=Date.now();
        if(now-last<70){
          if(!delayed)delayed=setTimeout(()=>{delayed=0;attempt();},75);
          return;
        }
        last=now;
        tryFill();
      }
      function onFocus(event){
        if(!event.target || event.target.tagName!=='INPUT')return;
        attempt();
      }
      attempt();
      if(done||!document.documentElement)return;
      observer=new MutationObserver(attempt);
      observer.observe(document.documentElement,watchOptions);
      // Observe currently available same-origin nested forms as well.
      roots();
      document.addEventListener('focusin',onFocus,true);
      window.addEventListener('pageshow',attempt);
      window.addEventListener('popstate',attempt);
      window.addEventListener('hashchange',attempt);
      setTimeout(stop,90000);
    })()
