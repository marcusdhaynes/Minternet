'use strict';
// Embedded by the native WebView only after the user presses Enter with the
// ChatGPT provider selected. No external website can invoke this feature.
// minternetChatRequest is a native-serialized {text,temporary} value.
(() => {
  if (location.hostname !== 'chatgpt.com' || location.protocol !== 'https:') return;
  const request=minternetChatRequest;
  if (!request || typeof request.text!=='string' || !request.text.trim() ||
      request.text.length>4096 || window.__minternetChatSent) return;
  // A subsequent navigation/re-evaluation in the same document cannot resubmit.
  window.__minternetChatSent='pending';
  const expected=request.text.trim().replace(/\r\n/g,'\n');
  const started=Date.now();
  let inserted=false,selectedPrivacy=false,submitted=false;
  const composerSelectors=[
    '#prompt-textarea',
    '[data-testid="composer-input"] [contenteditable="true"]',
    '[data-testid="composer-input"][contenteditable="true"]',
    '[data-testid="prompt-textarea"]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]'
  ];
  const trimText=value=>String(value||'').trim().replace(/\r\n/g,'\n');
  function composer(){
    for(const selector of composerSelectors){
      const item=document.querySelector(selector);
      if(item && (item.isContentEditable || item.tagName==='TEXTAREA'))return item;
    }
    return null;
  }
  function textOf(editor){
    return trimText(editor?.tagName==='TEXTAREA' ? editor.value :
      (editor?.innerText ?? editor?.textContent));
  }
  function visible(node){
    if(!node||node.disabled||node.getAttribute('aria-disabled')==='true')return false;
    const box=node.getBoundingClientRect?.();
    return !box || (box.width>0&&box.height>0);
  }
  function userMessageExists(){
    return [...document.querySelectorAll('[data-message-author-role="user"]')]
      .some(el=>trimText(el.innerText||el.textContent)===expected);
  }
  function temporaryReady(){
    if(!request.temporary)return true;
    // An opt-in to "temporary" is not a proof of temporary mode. Never send
    // potentially sensitive user prompts into an unverified regular chat.
    const text=String(document.body?.innerText||document.body?.textContent||'').slice(0,30000);
    if(/this chat won.t appear in history/i.test(text))return true;
    if(/temporary chat/i.test(text) &&
        /won.t (appear|show) in (your )?history/i.test(text))return true;
    const active=document.querySelector('[data-testid="temporary-chat-indicator"],[data-testid="temporary-chat-badge"]');
    return Boolean(active && visible(active));
  }
  function choosePrivateDefault(){
    if(!request.temporary||selectedPrivacy)return;
    const body=String(document.body?.innerText||'').slice(0,30000);
    if(!/temporary chat/i.test(body))return;
    const button=[...document.querySelectorAll('button')].find(b=>
      visible(b) && /^unpersonalized$/i.test(trimText(b.innerText||b.textContent)));
    if(button){selectedPrivacy=true;button.click();}
  }
  function disableSearchMode(editor){
    const form=editor.closest('form');
    if(!form)return false;
    const buttons=[...form.querySelectorAll('button[aria-pressed="true"],button[data-state="on"]')];
    const search=buttons.find(b=>/^(search|web search|search the web)$/i.test(
      trimText(b.getAttribute('aria-label')||b.getAttribute('title')||b.innerText)));
    if(search){search.click();return true;}
    return false;
  }
  function fill(editor){
    if(inserted||textOf(editor))return;
    inserted=true;
    editor.focus();
    if(editor.tagName==='TEXTAREA'){
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      if(setter)setter.call(editor,request.text);else editor.value=request.text;
      editor.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    }else{
      try{
        const selection=window.getSelection();
        selection?.selectAllChildren(editor);
        const worked=document.execCommand('insertText',false,request.text);
        if(!worked){
          editor.textContent=request.text;
          editor.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,data:request.text,inputType:'insertText'}));
        }
      }catch{
        editor.textContent=request.text;
        editor.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
      }
    }
  }
  function send(editor){
    const form=editor.closest('form') || document;
    const selectors=[
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'button[type="submit"]'
    ];
    let sendButton=null;
    for(const selector of selectors){
      const found=form.querySelector(selector)||document.querySelector(selector);
      if(visible(found)){sendButton=found;break;}
    }
    if(!sendButton)return false;
    // Exactly one deliberate send action; not a Search hint or search tool.
    submitted=true;
    window.__minternetChatSent='submitted';
    sendButton.click();
    return true;
  }
  let observer;
  let interval;
  const stop=()=>{
    observer?.disconnect();
    if(interval)clearInterval(interval);
  };
  function check(){
    if(submitted||userMessageExists()){
      window.__minternetChatSent='submitted';
      stop();return;
    }
    if(Date.now()-started>60000){
      window.__minternetChatSent='not-submitted';
      stop();
      return;
    }
    choosePrivateDefault();
    if(!temporaryReady())return;
    const editor=composer();
    if(!editor)return;
    let text=textOf(editor);
    // Wait for ChatGPT's own ?q= prefill so we don't fight hydration.
    if(!text && Date.now()-started>2200){
      fill(editor);
      text=textOf(editor);
    }
    if(text!==expected)return; // Never overwrite a different user draft.
    if(disableSearchMode(editor))return;
    send(editor);
  }
  // React can mount the composer well after WebView's PageLoad::Finished.
  interval=setInterval(check,250);
  observer=new MutationObserver(check);
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:false});
  check();
})();