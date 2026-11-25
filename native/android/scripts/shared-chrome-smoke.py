"""Exercise the packaged desktop UI and Android site engine in a debug emulator."""
import json, subprocess, time, urllib.request, urllib.parse, websocket

ORIGIN = "https://appassets.androidplatform.net/assets/chrome/index.html"
PACKAGE = "app.minternet.browser"

def adb(*args):
    return subprocess.check_output(["adb", *args], text=True).strip()

def retry(fn, timeout=45):
    deadline=time.monotonic()+timeout
    error=None
    while time.monotonic()<deadline:
        try:
            result=fn()
            if result:return result
        except Exception as exc:error=exc
        time.sleep(1)
    raise AssertionError(f"Timed out: {error}")

def targets(process):
    pid=adb("shell","pidof",process).split()[0]
    port=adb("forward","tcp:0","localabstract:webview_devtools_remote_"+pid)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json",timeout=4) as response:
            rows=json.load(response)
        return port,rows
    except Exception:
        adb("forward","--remove","tcp:"+port)
        raise

class Page:
    def __init__(self,process=PACKAGE):
        def connect():
            port,rows=targets(process)
            for row in rows:
                if row.get("url")==ORIGIN:
                    parsed=urllib.parse.urlsplit(row["webSocketDebuggerUrl"])
                    url=f"ws://127.0.0.1:{port}{parsed.path}"
                    try:
                        conn=websocket.create_connection(url,timeout=8,suppress_origin=True)
                        self.port,self.conn=port,conn
                        self.seq=0
                        return True
                    except Exception:pass
            adb("forward","--remove","tcp:"+port)
            return False
        retry(connect)
        retry(lambda:self.eval("document.documentElement.classList.contains('android-shared-chrome') && !!window.minternetMenus && !!document.querySelector('#tabs .tab')"))
    def eval(self,expression):
        self.seq+=1
        self.conn.send(json.dumps({"id":self.seq,"method":"Runtime.evaluate","params":{"expression":expression,"returnByValue":True,"awaitPromise":True}}))
        while True:
            result=json.loads(self.conn.recv())
            if result.get("id")!=self.seq:continue
            if "error" in result or result.get("result",{}).get("exceptionDetails"):
                raise AssertionError(result)
            return result.get("result",{}).get("result",{}).get("value")
    def click(self,selector):
        assert self.eval(f"(()=>{{const e=document.querySelector({json.dumps(selector)});if(!e)return false;e.click();return true}})()"),selector
    def visible(self,selector):
        return self.eval(f"(()=>{{const e=document.querySelector({json.dumps(selector)});return !!e&&!e.hidden&&e.getClientRects().length>0}})()")
    def close(self):
        self.conn.close()
        adb("forward","--remove","tcp:"+self.port)

def screenshot(name):
    subprocess.run(["adb","shell","screencap","-p","/sdcard/minternet-"+name+".png"],check=True)
    subprocess.run(["adb","pull","/sdcard/minternet-"+name+".png","/tmp/minternet-"+name+".png"],check=True)

page=Page()
screenshot("initial")
assert page.visible("#tabGroups")
assert page.visible("#bookmarkBar")
page.click("#settings")
retry(lambda:page.visible("#bookmarkSettings"))
assert page.visible("#defaultSearchEngine")
assert page.visible("#tabLimit")
screenshot("desktop-settings")
page.click("#bookmarkSettingsClose")
retry(lambda:not page.visible("#bookmarkSettings"))
page.click("#connectionIcon")
retry(lambda:page.visible(".search-provider-menu"))
screenshot("desktop-dropdown")
page.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
retry(lambda:not page.visible(".search-provider-menu"))
assert page.eval("(()=>{const t=document.querySelector('#tabs .tab');const r=t.getBoundingClientRect();t.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.x+3,clientY:r.y+3,button:2}));return true})()")
retry(lambda:page.visible(".minternet-context-menu"))
screenshot("desktop-context")
page.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
page.click("#newPrivate")
private=Page(PACKAGE+":minternet_private")
assert private.eval("document.querySelector('#newPrivate').getAttribute('aria-label')==='Close isolated private window'")
screenshot("private")
private.click("#newPrivate")
private.close()
page.close()
page=Page()
page.click("#newTab")
result=page.eval("window.minternet.command('navigate','example.com')")
assert not result.get("message"),result
def site_loaded():
    port,rows=targets(PACKAGE)
    try:return any("example.com" in x.get("url","") for x in rows)
    finally:adb("forward","--remove","tcp:"+port)
retry(site_loaded,60)
retry(lambda:page.eval("document.querySelector('#address').value.includes('example.com')"),60)
screenshot("web")
page.close()
print("Minternet Android: desktop settings, dropdown, custom context menu, private process, and native HTTPS navigation passed.")
