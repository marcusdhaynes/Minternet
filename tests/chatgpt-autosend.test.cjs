'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../ui/chatgpt-autosend.js'),'utf8');

function simulate({prompt='Explain stars',temporary=false,body='',host='chatgpt.com',prefilled=true,otherDraft='' }={}){
  let sends=0,filled=0;
  const sendButton={disabled:false,getAttribute:()=>null,
    getBoundingClientRect:()=>({width:22,height:22}),click(){sends++;}};
  const form={querySelector:selector=>selector.includes('send-button')?sendButton:null,
    querySelectorAll:()=>[]};
  const editor={tagName:'TEXTAREA',value:prefilled?prompt:otherDraft,
    closest:()=>form,focus(){},getAttribute:()=>null,
    dispatchEvent(){filled++}};
  const document={
    body:{innerText:body},
    documentElement:{},
    querySelector:selector=>selector==='#prompt-textarea'?editor:null,
    querySelectorAll:()=>[],
    execCommand:()=>true
  };
  const context={document,location:{hostname:host,protocol:'https:'},
    window:{},Date,HTMLTextAreaElement,Event,MutationObserver:class{observe(){}disconnect(){}},
    setInterval(){return 1;},clearInterval(){}};
  context.minternetChatRequest={text:prompt,temporary};
  vm.runInNewContext(source,context);
  return {sends,filled,editor,window:context.window};
}
test('ChatGPT normal prompts are sent once from composer, not search',()=>{
  const h=simulate();
  assert.equal(h.sends,1);
  assert.equal(h.window.__minternetChatSent,'submitted');
});
test('Temporary prompts fail closed until page confirms Temporary Chat',()=>{
  const normal=simulate({temporary:true,body:'New chat'});
  assert.equal(normal.sends,0);
  const safe=simulate({temporary:true,body:"Temporary chat. This chat won't appear in history."});
  assert.equal(safe.sends,1);
});
test('Untrusted hosts and different in-progress drafts are never submitted',()=>{
  assert.equal(simulate({host:'example.org'}).sends,0);
  assert.equal(simulate({prefilled:false,otherDraft:'My existing draft'}).sends,0);
});
