// Last resort for a WebView2 OAuth popup that is still truly empty after one
// automatic reload. Keeps the original popup/window.opener alive; no tokens,
// credentials, URLs or page content cross into the Minternet chrome.
(() => {
  try {
    if (location.protocol !== 'https:' || !document.body ||
        document.body.querySelector('#minternet-auth-recovery')) return;
    const root = document.createElement('main');
    root.id = 'minternet-auth-recovery';
    root.style.cssText = 'box-sizing:border-box;min-height:100vh;display:flex;'+
      'flex-direction:column;justify-content:center;align-items:center;'+
      'gap:14px;padding:24px;background:#111827;color:#f3f4f6;'+
      'font:14px system-ui,-apple-system,Segoe UI,sans-serif;text-align:center';
    const title = document.createElement('h1');
    title.textContent = 'This sign-in page did not load';
    title.style.cssText = 'font-size:20px;margin:0';
    const body = document.createElement('p');
    body.textContent = 'Minternet retried this authentication page, but it is still blank. '+
      'Some sign-in services do not permit embedded webviews. '+
      'You can try reloading, or close this window and sign in again.';
    body.style.cssText = 'max-width:370px;margin:0;line-height:1.5';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Reload Sign-In';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    for (const button of [retry,close]) {
      button.style.cssText = 'padding:10px 14px;border-radius:7px;'+
        'border:1px solid #72809b;background:#273549;color:#fff;'+
        'cursor:pointer;font:inherit';
    }
    retry.addEventListener('click', () => location.reload());
    close.addEventListener('click', () => window.close());
    actions.append(retry,close);
    root.append(title,body,actions);
    document.body.replaceChildren(root);
    document.body.style.margin = '0';
  } catch { /* do not interfere with the provider's own error handling */ }
})()
