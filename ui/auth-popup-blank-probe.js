// Read-only, provider-agnostic blank-page check for a managed OAuth popup.
// Executed with WebView2 eval_with_callback after an HTTPS page has finished.
// Never reads form values, URL parameters, credentials or page text into native.
(() => {
  try {
    if (location.protocol !== 'https:' || document.readyState !== 'complete')
      return false;
    const body = document.body;
    if (!body) return true;
    const visible = el => {
      if (!el || !el.getBoundingClientRect) return false;
      const bounds = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return bounds.width >= 6 && bounds.height >= 6 &&
        style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity) > 0;
    };
    // An account chooser, provider error, challenge, or loading indicator
    // must NEVER be reloaded just because the visible text is temporarily empty.
    if ((body.innerText || '').trim().length > 0) return false;
    if ([...body.querySelectorAll(
      'input,button,select,iframe,img,svg,canvas,video,progress,[role="dialog"],[role="progressbar"],[aria-busy="true"]'
    )].some(visible)) return false;
    // A substantial app shell may be hydrated asynchronously. Do not force
    // reloads merely because a React root has not yet populated its content.
    if (body.querySelectorAll('*').length > 12) return false;
    return true;
  } catch {
    return false; // unknown state is never a reason to reset auth
  }
})()
