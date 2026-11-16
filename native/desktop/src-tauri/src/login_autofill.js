/* Native-only login injection. This script runs in the selected HTTPS website
   WebView. Secret values are injected by trusted Rust and never returned to
   the chrome UI. Do not use on arbitrary untrusted preview pages. */
(function(){
      'use strict';
      const credential=__MINTERNET_LOGIN_PAYLOAD__;
      if(location.protocol!=='https:'||location.origin!==credential.origin||
         window!==window.top)return;
      const register=/(?:sign.?up|register|create.?account|join|forgot.?password|reset.?password|change.?password)/i;
      const signin=/(?:log.?in|sign.?in|auth|account|session|identify)/i;
      const safeRoute=()=>!register.test(location.pathname);
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
        if(!element||element.value||typeof value!=='string'||!value)return false;
        // Use the input's own Window: same-origin frames have different DOM
        // prototypes, so the parent Window's setter can silently fail.
        const win=element.ownerDocument?.defaultView||window;
        const setter=Object.getOwnPropertyDescriptor(
          win.HTMLInputElement?.prototype||HTMLInputElement.prototype,'value')?.set;
        if(setter)setter.call(element,value);else element.value=value;
        const EventType=win.Event||Event;
        element.dispatchEvent(new EventType('input',{bubbles:true,composed:true}));
        element.dispatchEvent(new EventType('change',{bubbles:true,composed:true}));
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
        // Common enterprise SSO forms (including WGU/PingFederate) have one
        // unlabeled-in-markup username field plus one password field.
        return candidates.length===1?candidates[0]:null;
      };
      const dangerousForm=el=>{
        const form=el?.form;
        return form instanceof HTMLFormElement &&
          register.test([form.getAttribute('action')||'',form.id,form.className].join(' '));
      };
      let usernamePrepared=false,done=false,observer=null,delayed=0;
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
        // Avoid retaining the password in a long-lived page closure.
        credential.password='';
      };
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
          if(password.value || (account?.value&&account.value!==credential.username)){
            stop();return true;
          }
          if(account)put(account,credential.username);
          if(put(password,credential.password)){stop();return true;}
          return false;
        }
        // Username-first providers (Google, Microsoft and many SPAs) show
        // the email field before creating a password input.
        const username=inputs.find(el=>token(el).includes('username'))||
          inputs.find(el=>userCandidate(el)&&
            (signin.test(location.pathname)||signin.test(
              (el.form?.getAttribute('action')||'')+' '+
              (el.form?.id||'')+' '+(el.form?.className||''))));
        if(username&&!dangerousForm(username) &&
           !usernamePrepared && !username.value){
          usernamePrepared=put(username,credential.username);
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
