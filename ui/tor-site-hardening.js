'use strict';
// Mitigation applied ONLY inside Tor website WebViews before page scripts.
// This does NOT make WebView2 fingerprint-resistant like Tor Browser.
(() => {
  const deny=()=>Promise.reject(new DOMException('Blocked in Minternet Tor mode','NotAllowedError'));
  for(const name of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel']){
    try{Object.defineProperty(window,name,{value:undefined,configurable:false,writable:false});}catch{}
  }
  try{const media=navigator.mediaDevices;
    if(media){
      for(const method of ['getUserMedia','getDisplayMedia','enumerateDevices']){
        try{Object.defineProperty(media,method,{value:deny,configurable:false,writable:false});}catch{}
      }
    }
  }catch{}
  try{Object.defineProperty(navigator,'geolocation',{value:undefined,configurable:false});}catch{}
  try{Object.defineProperty(navigator,'bluetooth',{value:undefined,configurable:false});}catch{}
  try{Object.defineProperty(navigator,'usb',{value:undefined,configurable:false});}catch{}
  try{Object.defineProperty(navigator,'serial',{value:undefined,configurable:false});}catch{}
  try{Object.defineProperty(navigator,'hid',{value:undefined,configurable:false});}catch{}
  try{Object.defineProperty(navigator,'share',{value:deny,configurable:false});}catch{}
})();
