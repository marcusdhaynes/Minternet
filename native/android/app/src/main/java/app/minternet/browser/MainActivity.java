package app.minternet.browser;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.graphics.drawable.BitmapDrawable;
import android.content.Intent;
import android.webkit.WebStorage;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.os.Message;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.text.InputType;
import android.view.KeyEvent;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import java.util.Map;
import java.util.HashMap;
import java.util.UUID;

public class MainActivity extends Activity {
    private boolean isolatedPrivate=false;
    private static final int BG=0xff111728;
    private static final int SURFACE=0xff313a51;
    private static final int ACCENT=0xffb3b2ff;
    private final List<BrowserTab> tabs=new ArrayList<>();
    private final Map<String,Bitmap> fallbackTabIcons=new HashMap<>();
    private int currentIndex=-1;
    private LinearLayout tabRow;
    private EditText address;
    private FrameLayout content;
    private View dashboard;
    private boolean dashboardOpen=false;
    private WebView sharedChrome;
    private ChromeLayer chromeLayer;
    private View legacyChrome;
    private Button privateAction;
    private boolean sharedReady=false,sharedOverlay=false;
    private int sharedHeader=0,nextLocalTabId=1;
    private float lastSiteX,lastSiteY;
    private String lastSharedSnapshot="";
    private Button back,forward,reload;
    private boolean updatingAddress=false;
    private MinternetSync sync;
    private boolean applyingSync=false;
    private final Map<String,JSONObject> pendingRemoteTabs=new HashMap<>();
    private final Handler idleHandler=new Handler(Looper.getMainLooper());
    private final Runnable idleSweep=new Runnable(){@Override public void run(){checkIdleTabs();idleHandler.postDelayed(this,10000);}};

    private static final class BrowserTab {
        WebView web;
        int localId;
        String title="New Tab";
        String findQuery="";
        String url="about:blank";
        Button button;
        Button closeButton;
        LinearLayout slot;
        Bitmap icon;
        boolean loading=false,suspended=false,checking=false;
        long inactiveSince=0;
        String syncId=UUID.randomUUID().toString().replace("-","");
        boolean pinned=false;
    }

    private int dp(int n) { return (int)(getResources().getDisplayMetrics().density*n+0.5f); }

    // Native equivalent of desktop ui/styles.css chrome tokens.
    private android.graphics.drawable.GradientDrawable shape(int color,int border,int radius) {
        android.graphics.drawable.GradientDrawable d=new android.graphics.drawable.GradientDrawable();
        d.setColor(color); d.setCornerRadius(dp(radius));
        if(border!=0)d.setStroke(dp(1),border);
        return d;
    }
    private Button button(String text, String description) {
        Button b=new Button(this);
        b.setText(text); b.setContentDescription(description);
        b.setTextColor(0xffaebad4); b.setAllCaps(false);
        b.setTypeface(Typeface.DEFAULT); b.setIncludeFontPadding(false);
        b.setBackground(new android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(0x30ffffff),
            shape(Color.TRANSPARENT,0,5),shape(Color.WHITE,0,5)));
        b.setStateListAnimator(null);
        b.setPadding(0,0,0,0);
        b.setMinWidth(0); b.setMinimumWidth(0);
        b.setMinHeight(0); b.setMinimumHeight(0);
        b.setTextSize(16); b.setGravity(android.view.Gravity.CENTER);
        return b;
    }
    private void chromeButton(LinearLayout row,Button b,int width,int height) {
        row.addView(b,new LinearLayout.LayoutParams(dp(width),dp(height)));
    }
    private void updateDashboard() {
        BrowserTab tab=current();
        if(dashboard==null||tab==null)return;
        boolean visible=dashboardOpen||"about:blank".equals(tab.url);
        dashboard.setVisibility(visible?View.VISIBLE:View.GONE);
        if(visible)dashboard.bringToFront();
    }
    private final class DashboardView extends View {
        private final Paint dots=new Paint(Paint.ANTI_ALIAS_FLAG);
        DashboardView(){super(MainActivity.this);setBackgroundColor(0xff0b1120);
            dots.setColor(0x668091bf);setContentDescription("Dashboard");setClickable(true);}
        @Override protected void onDraw(Canvas canvas){
            super.onDraw(canvas);
            int step=dp(24);
            for(int y=0;y<getHeight();y+=step)
                for(int x=0;x<getWidth();x+=step)
                    canvas.drawCircle(x,y,Math.max(1f,dp(1)),dots);
        }
    }

    @Override public void onCreate(Bundle savedInstanceState) {
        // Android WebView stores cookies per *process*, not per tab. Isolate the
        // private Activity into a dedicated process and separate data directory.
        // Must happen before invoking any other WebView API in this process.
        isolatedPrivate=this instanceof PrivateActivity;
        if(isolatedPrivate && Build.VERSION.SDK_INT>=28) {
            WebView.setDataDirectorySuffix("minternet-private");
        }
        super.onCreate(savedInstanceState);
        if(isolatedPrivate && Build.VERSION.SDK_INT<28) {
            finish(); // no safe private profile on this Android version
            return;
        }
        if(isolatedPrivate) {
            CookieManager.getInstance().removeAllCookies(null);
            WebStorage.getInstance().deleteAllData();
        }
        getWindow().setStatusBarColor(isolatedPrivate?0xff27203e:BG);
        getWindow().setNavigationBarColor(BG);
        // Only emulator/debug APKs expose DevTools; distributed APKs never do.
        if((getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0)
            WebView.setWebContentsDebuggingEnabled(true);
        else WebView.setWebContentsDebuggingEnabled(false);
        LinearLayout root=new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        setContentView(root);
        // Android 15 enforces edge-to-edge layout for modern targetSdk apps.
        // Respect status/navigation-bar insets so the clock cannot overlap tabs.
        if(Build.VERSION.SDK_INT>=30) {
            root.setOnApplyWindowInsetsListener((view,insets)->{
                android.graphics.Insets bars=insets.getInsets(
                    android.view.WindowInsets.Type.statusBars() |
                    android.view.WindowInsets.Type.navigationBars() |
                    android.view.WindowInsets.Type.displayCutout());
                root.setPadding(0,bars.top,0,bars.bottom);
                return insets;
            });
            root.requestApplyInsets();
        }
        LinearLayout chrome=new LinearLayout(this);
        chrome.setOrientation(LinearLayout.VERTICAL);
        chrome.setBackground(new android.graphics.drawable.GradientDrawable(
            android.graphics.drawable.GradientDrawable.Orientation.TL_BR,
            new int[]{0xff1d2333,BG}));
        root.addView(chrome,new LinearLayout.LayoutParams(-1,dp(52)));
        legacyChrome=chrome;
        LinearLayout top=new LinearLayout(this);
        top.setGravity(android.view.Gravity.CENTER_VERTICAL);
        top.setPadding(dp(5),0,dp(4),0);
        chrome.addView(top,new LinearLayout.LayoutParams(-1,dp(22)));
        android.widget.ImageView brand=new android.widget.ImageView(this);
        brand.setImageResource(R.mipmap.ic_launcher);
        brand.setScaleType(android.widget.ImageView.ScaleType.FIT_CENTER);
        brand.setContentDescription("Minternet");
        top.addView(brand,new LinearLayout.LayoutParams(dp(18),dp(18)));
        HorizontalScrollView strip=new HorizontalScrollView(this);
        strip.setHorizontalScrollBarEnabled(false);
        tabRow=new LinearLayout(this);
        tabRow.setGravity(android.view.Gravity.BOTTOM);
        tabRow.setOrientation(LinearLayout.HORIZONTAL);
        tabRow.setPadding(dp(3),0,dp(2),0);
        strip.addView(tabRow,new HorizontalScrollView.LayoutParams(-2,-1));
        top.addView(strip,new LinearLayout.LayoutParams(0,-1,1));
        Button add=button("+","New tab");
        Button privateButton=button("◉",isolatedPrivate?"Return to normal browser":"Open isolated private window");
        privateButton.setTextColor(0xffb3a0e8);
        privateAction=privateButton;
        Button home=button("⠿","Open Dashboard");
        chromeButton(top,add,20,20);
        chromeButton(top,privateButton,21,20);
        chromeButton(top,home,21,20);
        home.setOnClickListener(v->{dashboardOpen=true;updateDashboard();});

        LinearLayout controls=new LinearLayout(this);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        controls.setGravity(android.view.Gravity.CENTER_VERTICAL);
        controls.setPadding(dp(3),0,dp(3),0);
        back=button("←","Back");
        forward=button("→","Forward");
        reload=button("↻","Reload");
        chromeButton(controls,back,23,23);
        chromeButton(controls,forward,23,23);
        chromeButton(controls,reload,23,23);
        address=new EditText(this);
        address.setSingleLine(true);
        address.setTextColor(0xfff1f3ff);
        address.setHintTextColor(0xff828fa9);
        address.setHint("Search or enter address");
        address.setTextSize(11);
        address.setIncludeFontPadding(false);
        address.setSelectAllOnFocus(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_GO);
        address.setPadding(dp(7),0,dp(7),0);
        address.setBackground(shape(0xff0c1423,0xff3b435a,7));
        LinearLayout.LayoutParams addressSize=new LinearLayout.LayoutParams(0,dp(24),1);
        addressSize.setMargins(dp(4),0,dp(2),0);
        controls.addView(address,addressSize);
        Button go=button("→","Go");
        Button settings=button("⚙","Settings and Google Sync");
        chromeButton(controls,go,23,23);
        chromeButton(controls,settings,22,23);
        settings.setOnClickListener(v->openSettings());
        chrome.addView(controls,new LinearLayout.LayoutParams(-1,dp(30)));
        content=new FrameLayout(this);
        content.setBackgroundColor(0xff0b1120);
        chromeLayer=new ChromeLayer();
        root.addView(chromeLayer,new LinearLayout.LayoutParams(-1,0,1));
        chromeLayer.addView(content,new FrameLayout.LayoutParams(-1,-1));
        dashboard=new DashboardView();
        content.addView(dashboard,new FrameLayout.LayoutParams(-1,-1));

        back.setOnClickListener(v->{BrowserTab t=current();if(t!=null&&t.web.canGoBack()){dashboardOpen=false;t.web.goBack();}});
        forward.setOnClickListener(v->{BrowserTab t=current();if(t!=null&&t.web.canGoForward()){dashboardOpen=false;t.web.goForward();}});
        reload.setOnClickListener(v->{
            BrowserTab t=current();
            if(t==null)return;
            if(t.web==null||t.suspended){
                prepareWebView(t);
                if(t.web!=null && t.url.startsWith("https://"))t.web.loadUrl(t.url);
            }else t.web.reload();
        });
        go.setOnClickListener(v->navigate(address.getText().toString()));
        address.setOnEditorActionListener((v,action,event)->{
            navigate(address.getText().toString());return true;
        });
        add.setOnClickListener(v->newTab("about:blank",true));
        privateButton.setOnClickListener(v->{
            if(isolatedPrivate) {
                // The previously opened normal browser remains untouched.
                finish();
                return;
            }
            if(Build.VERSION.SDK_INT<28) {
                new AlertDialog.Builder(this)
                    .setTitle("Private mode requires Android 9+")
                    .setMessage("Android WebView data-directory isolation requires Android 9 (API 28) or newer.")
                    .setPositiveButton("OK",null).show();
                return;
            }
            // Creating a new Activity in a dedicated process is necessary;
            // ordinary WebView tabs share persistent cookies and site storage.
            String activeUrl=current()==null?"about:blank":current().url;
            if(!"about:blank".equals(activeUrl) && !activeUrl.startsWith("https://")) activeUrl="about:blank";
            Intent intent=new Intent(this,PrivateActivity.class);
            intent.putExtra("url",activeUrl);
            startActivity(intent);
        });
        if(isolatedPrivate) {
            privateButton.setText("◉");
            privateButton.setContentDescription("Close isolated private window");
            address.setHint("ISOLATED PRIVATE • HTTPS search or address");
        }
        String startUrl=isolatedPrivate?getIntent().getStringExtra("url"):null;
        if(startUrl==null || (!"about:blank".equals(startUrl) && !startUrl.startsWith("https://"))) startUrl="about:blank";
        newTab(startUrl,true);
        if(!isolatedPrivate){
            sync=new MinternetSync(this,new MinternetSync.Listener(){
                @Override public void onStatus(String message){
                    if(sync!=null&&sync.isActive()&&message.contains("active"))broadcastTabs();
                    android.widget.Toast.makeText(MainActivity.this,message,
                        android.widget.Toast.LENGTH_SHORT).show();
                }
                @Override public void onRemoteTab(JSONObject item,boolean deleted){
                    applyRemoteTab(item,deleted);
                }
                @Override public void onDataChanged(String kind){
                    // Bookmarks, groups and encrypted vault records remain in
                    // the app-private encrypted sync cache for native surfaces.
                }
            });
        }
        idleHandler.postDelayed(idleSweep,10000);
        installSharedChrome();
    }

    // Desktop chrome is a separate, trusted asset-only WebView. Remote site
    // WebViews never receive the privileged bridge or access to chrome storage.
    private static final String CHROME_ORIGIN="https://appassets.androidplatform.net";
    private static final String CHROME_URL=CHROME_ORIGIN+"/assets/chrome/index.html";
    private final class ChromeLayer extends FrameLayout {
        private boolean routeSite=false;
        ChromeLayer(){super(MainActivity.this);}
        @Override public boolean dispatchTouchEvent(android.view.MotionEvent event){
            if(event.getActionMasked()==android.view.MotionEvent.ACTION_DOWN){
                lastSiteX=event.getX()/getResources().getDisplayMetrics().density;
                lastSiteY=event.getY()/getResources().getDisplayMetrics().density;
                routeSite=sharedReady&&!sharedOverlay&&!dashboardOpen&&current()!=null
                    &&!"about:blank".equals(current().url)&&event.getY()>=sharedHeader;
            }
            if(!routeSite)return super.dispatchTouchEvent(event);
            android.view.MotionEvent translated=android.view.MotionEvent.obtain(event);
            translated.offsetLocation(-content.getLeft(),-content.getTop());
            boolean handled=content.dispatchTouchEvent(translated);
            translated.recycle();
            return handled;
        }
    }
    private void installSharedChrome(){
        if(!androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.WEB_MESSAGE_LISTENER))return;
        try{
            sharedChrome=new WebView(this);
            sharedChrome.setBackgroundColor(Color.TRANSPARENT);
            sharedChrome.setVisibility(View.INVISIBLE);
            WebSettings settings=sharedChrome.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setSupportMultipleWindows(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            final androidx.webkit.WebViewAssetLoader assets=new androidx.webkit.WebViewAssetLoader.Builder()
                .addPathHandler("/assets/",new androidx.webkit.WebViewAssetLoader.AssetsPathHandler(this)).build();
            sharedChrome.setWebViewClient(new WebViewClient(){
                @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest request){
                    return assets.shouldInterceptRequest(request.getUrl());
                }
                @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest request){
                    return !request.isForMainFrame()||!CHROME_URL.equals(request.getUrl().toString());
                }
                @Override public void onReceivedSslError(WebView v,SslErrorHandler handler,SslError error){handler.cancel();}
                @Override public void onReceivedError(WebView v,WebResourceRequest request,android.webkit.WebResourceError error){
                    if(request.isForMainFrame())restoreLegacyChrome();
                }
                @Override public boolean onRenderProcessGone(WebView v,android.webkit.RenderProcessGoneDetail detail){
                    restoreLegacyChrome();
                    if(v.getParent() instanceof ViewGroup)((ViewGroup)v.getParent()).removeView(v);
                    v.destroy();sharedChrome=null;return true;
                }
            });
            androidx.webkit.WebViewCompat.addWebMessageListener(sharedChrome,"MinternetAndroid",
                java.util.Collections.singleton(CHROME_ORIGIN),(view,message,origin,isMainFrame,reply)->{
                    if(view!=sharedChrome||!isMainFrame||!CHROME_ORIGIN.equals(origin.toString()))return;
                    String raw=message.getData();
                    if(raw==null||raw.length()>262144)return;
                    try{
                        JSONObject req=new JSONObject(raw);
                        long id=req.optLong("id",-1);
                        String name=req.optString("name");
                        Object value=req.opt("value");
                        Object result=sharedCommand(name,value);
                        reply.postMessage(new JSONObject().put("id",id).put("result",result).toString());
                    }catch(Exception ignored){}
                });
            chromeLayer.addView(sharedChrome,new FrameLayout.LayoutParams(-1,-1));
            sharedChrome.loadUrl(CHROME_URL);
            idleHandler.postDelayed(()->{if(!sharedReady&&sharedChrome!=null)restoreLegacyChrome();},15000);
        }catch(Exception error){restoreLegacyChrome();}
    }
    private void restoreLegacyChrome(){
        sharedReady=false;sharedOverlay=false;sharedHeader=0;
        if(sharedChrome!=null)sharedChrome.setVisibility(View.GONE);
        legacyChrome.setVisibility(View.VISIBLE);
        FrameLayout.LayoutParams size=(FrameLayout.LayoutParams)content.getLayoutParams();
        size.topMargin=0;content.setLayoutParams(size);
    }
    private JSONObject sharedSnapshot() throws Exception{
        org.json.JSONArray items=new org.json.JSONArray();
        for(BrowserTab t:tabs){
            items.put(new JSONObject().put("id",t.localId).put("url",t.url)
                .put("title",t.title).put("private",isolatedPrivate).put("pinned",t.pinned)
                .put("loading",t.loading).put("suspended",t.suspended)
                .put("canBack",t.web!=null&&t.web.canGoBack())
                .put("canForward",t.web!=null&&t.web.canGoForward()).put("error",""));
        }
        return new JSONObject().put("tabs",items).put("activeId",
            dashboardOpen||current()==null?JSONObject.NULL:current().localId)
            .put("extensionsCount",0);
    }
    private void publishSharedState(){
        if(!sharedReady||sharedChrome==null)return;
        try{
            String json=sharedSnapshot().toString();
            if(json.equals(lastSharedSnapshot))return;
            lastSharedSnapshot=json;
            sharedChrome.evaluateJavascript("window.__minternetMobileState?.("+json+")",null);
        }catch(Exception ignored){}
    }
    private BrowserTab sharedTab(Object value){
        if(!(value instanceof Number))return null;
        int id=((Number)value).intValue();
        for(BrowserTab t:tabs)if(t.localId==id)return t;
        return null;
    }
    private boolean validHttps(String input){
        try{Uri uri=Uri.parse(input);return "https".equalsIgnoreCase(uri.getScheme())&&uri.getHost()!=null&&uri.getUserInfo()==null;}
        catch(Exception ignored){return false;}
    }
    private String sharedNewUrl(){
        android.content.SharedPreferences prefs=getSharedPreferences("minternet.settings",MODE_PRIVATE);
        return "website".equals(prefs.getString("newTabMode","dashboard"))?
            prefs.getString("homepage","https://www.google.com/"):"about:blank";
    }
    private boolean showSharedSiteMenu(BrowserTab tab,WebView web){
        if(!sharedReady||tab!=current())return false;
        WebView.HitTestResult hit=web.getHitTestResult();
        if(hit!=null&&hit.getType()==WebView.HitTestResult.EDIT_TEXT_TYPE)return false;
        int kind=hit==null?0:hit.getType();
        // Keep platform text selection usable; link/image/page context uses
        // the exact desktop menu renderer and validated native hit-test data.
        if(kind==WebView.HitTestResult.UNKNOWN_TYPE)return false;
        try{
            JSONObject payload=new JSONObject().put("tabId",tab.localId)
                .put("x",lastSiteX).put("y",lastSiteY).put("url",tab.url)
                .put("pageUrl",tab.url);
            String extra=hit.getExtra();
            if(extra!=null&&validHttps(extra)){
                if(kind==WebView.HitTestResult.IMAGE_TYPE)payload.put("sourceUrl",extra).put("kind","image");
                else payload.put("linkUrl",extra).put("kind","link");
            }else return false;
            sharedOverlay=true;
            sharedChrome.evaluateJavascript("window.minternetMenus?.site("+payload.toString()+")",null);
            return true;
        }catch(Exception error){return false;}
    }
    private Object sharedCommand(String name,Object value) throws Exception{
        JSONObject ok=new JSONObject().put("ok",true);
        android.content.SharedPreferences prefs=getSharedPreferences("minternet.settings",MODE_PRIVATE);
        BrowserTab active=current(),target=sharedTab(value);
        String string=value instanceof String?(String)value:"";
        switch(name){
            case "mobile-ready":
                sharedReady=true;legacyChrome.setVisibility(View.GONE);sharedChrome.setVisibility(View.VISIBLE);
                lastSharedSnapshot="";publishSharedState();return sharedSnapshot();
            case "mobile-layout":{
                if(!(value instanceof JSONObject))return ok;
                JSONObject layout=(JSONObject)value;
                int height=Math.max(dp(22),Math.min(dp(160),dp(layout.optInt("header",52))));
                sharedOverlay=layout.optBoolean("overlay",false);
                if(height!=sharedHeader){
                    sharedHeader=height;
                    FrameLayout.LayoutParams size=(FrameLayout.LayoutParams)content.getLayoutParams();
                    size.topMargin=height;content.setLayoutParams(size);
                }
                return ok;}
            case "snapshot":return sharedSnapshot();
            case "chrome-overlay":sharedOverlay=Boolean.TRUE.equals(value);return ok;
            case "new":newTab(sharedNewUrl(),true);break;
            case "new-url":case "new-background-url":case "site-link-new-tab":case "open-new-browser-window":{
                String url=value instanceof JSONObject?((JSONObject)value).optString("url"):string;
                if(!validHttps(url))return new JSONObject().put("message","Only HTTPS addresses are allowed.");
                newTab(url,!"new-background-url".equals(name));break;}
            case "new-private":case "privacy":privateAction.performClick();return ok;
            case "activate":if(target!=null)switchTab(tabs.indexOf(target));break;
            case "deselect":dashboardOpen=true;updateDashboard();break;
            case "close":
                if(target!=null){boolean wasActive=target==active;closeTab(target);if(wasActive){dashboardOpen=true;updateDashboard();}}break;
            case "close-many":
                if(value instanceof org.json.JSONArray){org.json.JSONArray ids=(org.json.JSONArray)value;for(int i=0;i<ids.length();i++){BrowserTab t=sharedTab(ids.opt(i));if(t!=null)closeTab(t);}}break;
            case "duplicate":if(target!=null)newTab(target.url,true);break;
            case "pin":case "unpin":case "toggle-pin":
                if(target!=null){target.pinned="pin".equals(name)||("toggle-pin".equals(name)&&!target.pinned);broadcastTabs();}break;
            case "navigate":{
                String input=value instanceof JSONObject?((JSONObject)value).optString("address"):string;
                if(input.trim().isEmpty())return ok;
                if(dashboardOpen&&active!=null&&!"about:blank".equals(active.url)){
                    if(newTab("about:blank",true)==null)return new JSONObject().put("message","Tab limit reached.");
                }
                String engine=value instanceof JSONObject?((JSONObject)value).optString("searchEngine","google"):"google";
                navigate(input,engine);break;}
            case "home":dashboardOpen=true;updateDashboard();break;
            case "back":if(active!=null&&active.web!=null&&active.web.canGoBack()){dashboardOpen=false;active.web.goBack();}break;
            case "forward":if(active!=null&&active.web!=null&&active.web.canGoForward()){dashboardOpen=false;active.web.goForward();}break;
            case "reload":if(active!=null)reload.performClick();break;
            case "reload-tab":
                if(target!=null){if(target.web!=null)target.web.reload();else{switchTab(tabs.indexOf(target));}}break;
            case "unload-tab":if(target!=null)unloadTab(target,true);break;
            case "unload-others":for(BrowserTab t:new ArrayList<>(tabs))if(t!=active&&t!=target)unloadTab(t,true);break;
            case "history-search":return historyResults(string,0,12);
            case "history-list":{
                JSONObject filter=value instanceof JSONObject?(JSONObject)value:new JSONObject();
                return historyResults(filter.optString("query"),Math.max(0,filter.optInt("offset",0)),Math.max(1,Math.min(100,filter.optInt("limit",75))));}
            case "history-remove":if(!isolatedPrivate)removeHistory(string);return ok;
            case "history-clear":if(!isolatedPrivate)getSharedPreferences("minternet.history",MODE_PRIVATE).edit().remove("visits").apply();return ok;
            case "navigation-history-list":{
                org.json.JSONArray list=new org.json.JSONArray();
                if(active==null||active.web==null)return list;
                android.webkit.WebBackForwardList history=active.web.copyBackForwardList();
                int direction="back".equals(string)?-1:1;
                for(int i=history.getCurrentIndex()+direction;i>=0&&i<history.getSize()&&list.length()<50;i+=direction){
                    android.webkit.WebHistoryItem item=history.getItemAtIndex(i);
                    list.put(new JSONObject().put("index",i).put("url",item.getUrl()).put("title",item.getTitle()));
                }return list;}
            case "navigation-history-jump":
                if(active!=null&&active.web!=null&&value instanceof Number){
                    android.webkit.WebBackForwardList h=active.web.copyBackForwardList();
                    int i=((Number)value).intValue();
                    if(i>=0&&i<h.getSize()){dashboardOpen=false;active.web.goBackOrForward(i-h.getCurrentIndex());}
                }break;
            case "find-bar-set":
                if(!Boolean.TRUE.equals(value)&&active!=null&&active.web!=null){active.web.clearMatches();active.findQuery="";}return ok;
            case "find-page":{
                if(active==null||active.web==null||!(value instanceof JSONObject))return new JSONObject().put("message","No active page");
                JSONObject query=(JSONObject)value;
                String needle=query.optString("query");
                WebView site=active.web;
                if(needle.isEmpty()){site.clearMatches();return ok;}
                site.setFindListener((ordinal,count,done)->{
                    if(!done||sharedChrome==null||current()==null||current().web!=site)return;
                    String label=count==0?"No matches":(ordinal+1)+"/"+count;
                    sharedChrome.evaluateJavascript("window.__minternetMobileFind?.("+JSONObject.quote(needle)+","+JSONObject.quote(label)+")",null);
                });
                if(needle.equals(active.findQuery))site.findNext(!query.optBoolean("backward",false));
                else{active.findQuery=needle;site.findAllAsync(needle);}
                return ok;}
            case "tab-limit-get":return ok.put("tabLimit",configuredTabLimit());
            case "tab-limit-set":{
                if(!(value instanceof Number))return new JSONObject().put("message","Invalid Tab Limit.");
                int n=((Number)value).intValue();
                if(n<0||n>1000000)return new JSONObject().put("message","Invalid Tab Limit.");
                prefs.edit().putInt("tabLimit",n).apply();return ok.put("tabLimit",n);}
            case "browser-preferences":return ok.put("homepage",prefs.getString("homepage","https://www.google.com/"))
                .put("newTabMode",prefs.getString("newTabMode","dashboard")).put("tabLimit",configuredTabLimit())
                .put("privateLoginSharing",false).put("autoUnloadMinutes",autoUnloadMinutes()).put("usingSystemDownloads",true);
            case "browser-homepage-set":
                if(!validHttps(string))return new JSONObject().put("message","Only HTTPS homepages are allowed.");
                prefs.edit().putString("homepage",string).apply();return ok.put("homepage",string);
            case "browser-new-tab-mode-set":
                if(!"website".equals(string)&&!"dashboard".equals(string))return new JSONObject().put("message","Invalid New Tab mode.");
                prefs.edit().putString("newTabMode",string).apply();return ok.put("newTabMode",string);
            case "mobile-auto-unload-set":
                if(value instanceof Number){int n=((Number)value).intValue();if(n>=0&&n<=120)prefs.edit().putInt("autoUnloadMinutes",n).apply();}return ok;
            case "auto-unload-check":checkIdleTabs();return ok;
            case "site-context-copy":
                ((android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(android.content.ClipData.newPlainText("Minternet",string));return ok;
            case "mobile-google":if(!isolatedPrivate)configureGoogle();return ok;
            case "mobile-sync-stop":if(sync!=null)sync.stop();return ok;
            case "undo":if(sync!=null&&sync.isActive()){sync.undo();return ok;}return new JSONObject().put("undone",false);
            case "focus-address":sharedChrome.requestFocus();return ok;
            case "quit":finish();return ok;
            case "prepare-tab":case "session-refresh-urls":case "bookmark-bar-visibility":return ok;
            case "extensions-list":return new JSONObject().put("extensions",new org.json.JSONArray());
            case "split-status":return new JSONObject().put("active",false);
            case "startup-status":return new JSONObject().put("armed",false);
            default:return new JSONObject().put("message","This desktop action is not implemented on Android: "+name);
        }
        publishSharedState();return ok;
    }

    private org.json.JSONArray storedHistory(){
        if(isolatedPrivate)return new org.json.JSONArray();
        try{return new org.json.JSONArray(getSharedPreferences("minternet.history",MODE_PRIVATE).getString("visits","[]"));}
        catch(Exception ignored){return new org.json.JSONArray();}
    }
    private void saveHistory(org.json.JSONArray entries){
        if(!isolatedPrivate)getSharedPreferences("minternet.history",MODE_PRIVATE).edit().putString("visits",entries.toString()).apply();
    }
    private void recordHistory(BrowserTab tab){
        if(isolatedPrivate||!validHttps(tab.url))return;
        try{
            org.json.JSONArray previous=storedHistory(),next=new org.json.JSONArray();
            next.put(new JSONObject().put("url",tab.url).put("title",tab.title));
            for(int i=0;i<previous.length()&&next.length()<1000;i++){
                JSONObject entry=previous.optJSONObject(i);
                if(entry!=null&&!tab.url.equals(entry.optString("url")))next.put(entry);
            }
            saveHistory(next);
        }catch(Exception ignored){}
    }
    private void removeHistory(String url){
        org.json.JSONArray previous=storedHistory(),next=new org.json.JSONArray();
        for(int i=0;i<previous.length();i++){
            JSONObject entry=previous.optJSONObject(i);
            if(entry!=null&&!url.equals(entry.optString("url")))next.put(entry);
        }
        saveHistory(next);
    }
    private org.json.JSONArray historyResults(String query,int offset,int limit){
        org.json.JSONArray previous=storedHistory(),results=new org.json.JSONArray();
        String q=query.toLowerCase(java.util.Locale.ROOT);int skipped=0;
        for(int i=0;i<previous.length()&&results.length()<limit;i++){
            JSONObject entry=previous.optJSONObject(i);
            if(entry==null)continue;
            String text=(entry.optString("url")+" "+entry.optString("title")).toLowerCase(java.util.Locale.ROOT);
            if(!text.contains(q))continue;
            if(skipped++<offset)continue;
            results.put(entry);
        }
        return results;
    }

    private static final String SAFE_TO_UNLOAD="(()=>{try{\n if(document.readyState!=='complete'||document.hasFocus()||window.onbeforeunload!==null)return false;\n if(document.querySelector('iframe,canvas,[aria-busy=\"true\"],[role=\"progressbar\"],progress,.loading,.spinner'))return false;\n if([...document.querySelectorAll('audio,video')].some(m=>!m.paused||m.seeking||m.networkState===m.NETWORK_LOADING))return false;\n if([...document.querySelectorAll('input,textarea,select')].some(e=>{\n  if(['hidden','submit','button','reset'].includes(e.type))return false;\n  if(e.type==='checkbox'||e.type==='radio')return e.checked!==e.defaultChecked;\n  if(e.type==='file')return e.files?.length>0;\n  if(e.tagName==='SELECT')return [...e.options].some(o=>o.selected!==o.defaultSelected);\n  return !!e.value;\n }))return false;\n if([...document.querySelectorAll('[contenteditable=\"true\"],[role=\"textbox\"]')].some(e=>e.textContent?.trim()))return false;\n const r=performance.getEntriesByType('resource');if(r.length&&performance.now()-(r[r.length-1].responseEnd||r[r.length-1].startTime)<15000)return false;\n return true;\n }catch(e){return false}})()";

    private void openSettings(){
        if(isolatedPrivate){
            new AlertDialog.Builder(this).setTitle("Minternet Settings")
                .setItems(new String[]{"Unload Inactive Tabs","Tab Limit (0 = Unlimited)"},
                    (dialog,choice)->{
                        if(choice==0)openIdleSettings();
                        else openTabLimitSettings();
                    }).show();
            return;
        }
        new AlertDialog.Builder(this).setTitle("Minternet Settings")
            .setItems(new String[]{"Google Account · Live Sync","Unload Inactive Tabs",
                "Tab Limit (0 = Unlimited)","Undo Across All Devices","Stop Google Sync"},(dialog,choice)->{
                if(choice==0)configureGoogle();
                else if(choice==1)openIdleSettings();
                else if(choice==2)openTabLimitSettings();
                else if(choice==3){
                    if(sync!=null&&sync.isActive())sync.undo();
                    else new AlertDialog.Builder(this)
                        .setMessage("Enable Google Live Sync to use shared Undo.")
                        .setPositiveButton("OK",null).show();
                }else if(choice==4){
                    if(sync!=null)sync.stop();
                    android.widget.Toast.makeText(this,"Google sync stopped",
                        android.widget.Toast.LENGTH_SHORT).show();
                }
            }).show();
    }
    private void configureGoogle(){
        android.content.SharedPreferences preferences=
            getSharedPreferences("minternet.sync.public",MODE_PRIVATE);
        LinearLayout body=new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(16),dp(5),dp(16),0);
        EditText webClient=new EditText(this);
        webClient.setHint("Google Web OAuth Client ID");
        webClient.setText(preferences.getString("webClientId",""));
        webClient.setSingleLine(true);
        EditText backend=new EditText(this);
        backend.setHint("https://your-project.supabase.co");
        backend.setText(preferences.getString("url",""));
        backend.setSingleLine(true);
        EditText publishable=new EditText(this);
        publishable.setHint("Supabase sb_publishable_…");
        publishable.setText(preferences.getString("publishable",""));
        publishable.setSingleLine(true);
        EditText passphrase=new EditText(this);
        passphrase.setHint("16+ character sync encryption passphrase");
        passphrase.setInputType(InputType.TYPE_CLASS_TEXT|
            InputType.TYPE_TEXT_VARIATION_PASSWORD);
        for(EditText field:new EditText[]{webClient,backend,publishable,passphrase}){
            field.setTextColor(Color.WHITE);
            field.setHintTextColor(0xffa3b0cb);
            field.setTextSize(12);
            body.addView(field,new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,dp(52)));
        }
        new AlertDialog.Builder(this).setTitle("Google Account & Live Sync")
            .setView(body)
            .setMessage("Sign in with Google first. Private/Tor data never sync. "+
                "Encryption passphrases and Google tokens are kept in memory only.")
            .setNegativeButton("Cancel",null)
            .setPositiveButton("Sign In With Google",(d,which)->{
                final String googleId=webClient.getText().toString().trim();
                final String server=backend.getText().toString().trim();
                final String key=publishable.getText().toString().trim();
                final String phrase=passphrase.getText().toString();
                passphrase.setText("");
                preferences.edit().putString("webClientId",googleId)
                    .putString("url",server).putString("publishable",key).apply();
                if(phrase.length()<16){
                    new AlertDialog.Builder(this).setMessage(
                        "Use the same 16+ character encryption passphrase on every device.")
                        .setPositiveButton("OK",null).show();
                    return;
                }
                GoogleAccount.signIn(this,googleId,token->
                    new AlertDialog.Builder(this)
                        .setTitle("Sync This Minternet?")
                        .setMessage("Yes: normal tabs, groups, bookmarks, encrypted logins,"+
                            " payments and Undo synchronize with your other devices."+
                            " No: keep this Minternet local.")
                        .setPositiveButton("Yes, Sync",(ok,button)->{
                            if(sync!=null)sync.start(server,key,token,phrase);
                        })
                        .setNegativeButton("No, Keep Local",(cancel,button)->{}).show(),
                    error->new AlertDialog.Builder(this).setMessage(error)
                        .setPositiveButton("OK",null).show());
            }).show();
    }
    private void broadcastTabs(){
        if(sync==null||!sync.isActive()||isolatedPrivate||applyingSync)return;
        List<JSONObject> publicTabs=new ArrayList<>();
        for(BrowserTab tab:tabs){
            if(tab.url==null||!tab.url.startsWith("https://")||
               tab.url.contains(".onion"))continue;
            try{
                publicTabs.add(new JSONObject().put("syncId",tab.syncId)
                    .put("url",tab.url).put("title",tab.title)
                    .put("pinned",tab.pinned).put("private",false));
            }catch(Exception ignored){}
        }
        sync.changedTabs(publicTabs);
    }
    private void applyRemoteTab(JSONObject record,boolean deleted){
        if(isolatedPrivate)return;
        final String id=record.optString("syncId");
        if(!id.matches("[a-fA-F0-9]{32}"))return;
        BrowserTab found=null;
        for(BrowserTab tab:tabs)if(tab.syncId.equals(id)){found=tab;break;}
        if(found==current()){
            // A local form may have unsaved edits. Defer cloud navigation or
            // closure until the user switches away from this tab.
            pendingRemoteTabs.put(id,new JSONObjectRecord(record,deleted).asJson());
            return;
        }
        applyingSync=true;
        try{
            if(deleted){
                if(found!=null)closeTab(found);
            }else{
                final String url=record.optString("url");
                if(!url.startsWith("https://")||url.contains(".onion"))return;
                if(found==null){
                    BrowserTab added=newTab(url,false);
                    if(added!=null){
                        added.syncId=id;
                        added.pinned=record.optBoolean("pinned",false);
                        unloadTab(added,false); // Keep synced tabs dormant.
                    }
                }else{
                    if(!url.equals(found.url)){
                        if(found.web!=null){found.web.stopLoading();found.web.destroy();}
                        found.web=null;found.suspended=true;found.url=url;
                        found.title=record.optString("title","Synced Tab");
                    }
                    found.pinned=record.optBoolean("pinned",false);
                }
                updateTabLabels();
            }
        }finally{applyingSync=false;}
    }
    // A wrapper avoids retaining a mutable input JSON object across callbacks.
    private static final class JSONObjectRecord {
        final JSONObject payload;
        JSONObjectRecord(JSONObject source,boolean deleted){
            JSONObject copy;
            try{copy=new JSONObject(source.toString());copy.put("_syncDeleted",deleted);}
            catch(Exception e){copy=new JSONObject();}
            payload=copy;
        }
        JSONObject asJson(){return payload;}
    }
    private void flushDeferred(){
        if(pendingRemoteTabs.isEmpty())return;
        for(Map.Entry<String,JSONObject> item:new HashMap<>(pendingRemoteTabs).entrySet()){
            BrowserTab selected=current();
            if(selected!=null&&selected.syncId.equals(item.getKey()))continue;
            pendingRemoteTabs.remove(item.getKey());
            JSONObject value=item.getValue();
            applyRemoteTab(value,value.optBoolean("_syncDeleted",false));
        }
    }

    private int configuredTabLimit(){
        return getSharedPreferences("minternet.settings",MODE_PRIVATE).getInt("tabLimit",0);
    }
    private void openTabLimitSettings(){
        EditText input=new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_NUMBER);
        input.setText(String.valueOf(configuredTabLimit()));
        input.setSelectAllOnFocus(true);
        new AlertDialog.Builder(this).setTitle("Tab Limit")
            .setMessage("0 = Unlimited. Reducing the limit will not close existing tabs.")
            .setView(input)
            .setPositiveButton("Save",(dialog,which)->{
                try{
                    int limit=Integer.parseInt(input.getText().toString().trim());
                    if(limit<0||limit>1000000)throw new NumberFormatException();
                    getSharedPreferences("minternet.settings",MODE_PRIVATE).edit()
                        .putInt("tabLimit",limit).apply();
                }catch(NumberFormatException ex){
                    android.widget.Toast.makeText(this,"Enter a whole number from 0 to 1000000",
                        android.widget.Toast.LENGTH_SHORT).show();
                }
            }).setNegativeButton("Cancel",null).show();
    }
    private int autoUnloadMinutes(){
        return getSharedPreferences("minternet.settings",MODE_PRIVATE).getInt("autoUnloadMinutes",1);
    }
    private void openIdleSettings(){
        final int[] values={0,1,2,5,10,15,30,60,120};
        final String[] labels={"Never","1 minute","2 minutes","5 minutes","10 minutes","15 minutes","30 minutes","1 hour","2 hours"};
        int selected=1;
        for(int i=0;i<values.length;i++)if(values[i]==autoUnloadMinutes()){selected=i;break;}
        new AlertDialog.Builder(this).setTitle("Unload Inactive Tabs")
            .setSingleChoiceItems(labels,selected,(d,choice)->{
                getSharedPreferences("minternet.settings",MODE_PRIVATE).edit()
                    .putInt("autoUnloadMinutes",values[choice]).apply();
                d.dismiss();
            }).setNegativeButton("Cancel",null).show();
    }
    private void unloadTab(BrowserTab tab,boolean manual){
        if(tab.web==null)return;
        if(tab==current()){
            int ix=tabs.indexOf(tab),other=ix==0?1:0;
            if(other>=tabs.size())newTab("about:blank",true);
            else switchTab(other);
        }
        if(tab==current())return;
        if(tab.web.getParent() instanceof ViewGroup)((ViewGroup)tab.web.getParent()).removeView(tab.web);
        tab.web.stopLoading();
        tab.web.destroy();
        tab.web=null;
        tab.loading=false;tab.checking=false;tab.suspended=true;
        updateTabLabels();
    }
    private void checkIdleTabs(){
        int minutes=autoUnloadMinutes();
        if(minutes<=0)return;
        long now=SystemClock.elapsedRealtime();
        for(BrowserTab tab:new ArrayList<>(tabs)){
            if(tab==current()||tab.web==null||tab.suspended||tab.loading||tab.checking||
                !tab.url.startsWith("https://")||tab.inactiveSince<=0||
                now-tab.inactiveSince<minutes*60000L)continue;
            tab.checking=true;
            WebView web=tab.web;
            web.evaluateJavascript(SAFE_TO_UNLOAD,result->{
                tab.checking=false;
                if("true".equals(result)&&tab.web==web&&tab!=current()&&
                    !tab.loading&&tab.inactiveSince>0&&
                    SystemClock.elapsedRealtime()-tab.inactiveSince>=autoUnloadMinutes()*60000L){
                    unloadTab(tab,false);
                }
            });
        }
    }

    private BrowserTab current() {
        return currentIndex>=0&&currentIndex<tabs.size()?tabs.get(currentIndex):null;
    }

    private String normalized(String input) {return normalized(input,"google");}
    private String normalized(String input,String engine) {
        String s=input.trim();
        if(s.isEmpty())return "about:blank";
        if(s.equals("about:blank"))return s;
        if(s.matches("(?i)^[a-z][a-z0-9+.-]*:.*")&&!s.toLowerCase().startsWith("https://"))return null;
        if(s.toLowerCase().startsWith("https://")) {
            try{
                Uri u=Uri.parse(s);
                return (u.getHost()!=null&&u.getUserInfo()==null)?u.toString():null;
            }catch(Exception e){return null;}
        }
        if(s.matches("(?i)^(?:[a-z0-9-]+\\.)+[a-z]{2,}(?::[0-9]+)?(?:[/?:#].*)?$"))
            return "https://"+s;
        String prefix;
        switch(engine){
            case "chatgpt":prefix="https://chatgpt.com/?q=";break;
            case "chatgpt-private":prefix="https://chatgpt.com/?temporary-chat=true&q=";break;
            case "duckduckgo":prefix="https://duckduckgo.com/?q=";break;
            default:prefix="https://www.google.com/search?q=";
        }
        return prefix+Uri.encode(s);
    }

    private void navigate(String input){navigate(input,"google");}
    private void navigate(String input,String engine) {
        String url=normalized(input,engine);
        if(url==null){
            new AlertDialog.Builder(this).setMessage("Only HTTPS addresses and searches are allowed. Insecure or local schemes are blocked.").setPositiveButton("OK",null).show();
            return;
        }
        BrowserTab tab=current();
        if(tab!=null){dashboardOpen=false;tab.web.loadUrl(url);if(!"about:blank".equals(url))dashboard.setVisibility(View.GONE);}
        InputMethodManager imm=(InputMethodManager)getSystemService(Context.INPUT_METHOD_SERVICE);
        if(imm!=null)imm.hideSoftInputFromWindow(address.getWindowToken(),0);
        address.clearFocus();
    }

    private void prepareWebView(BrowserTab tab) {
        WebView web=new WebView(this);
        tab.web=web;
        web.setOnLongClickListener(v->showSharedSiteMenu(tab,web));
        web.setBackgroundColor(Color.WHITE);
        WebSettings s=web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(true);
        s.setSafeBrowsingEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request) {
                Uri uri=request.getUrl();
                if(request.isForMainFrame()&&!"https".equalsIgnoreCase(uri.getScheme()))return true;
                return false;
            }
            @Override public void onPageStarted(WebView v,String url,Bitmap icon) {
                if(tab.web!=v)return;
                try{
                    String oldHost=Uri.parse(tab.url).getHost();
                    String newHost=Uri.parse(url).getHost();
                    if(oldHost==null?newHost!=null:!oldHost.equalsIgnoreCase(newHost))tab.icon=null;
                }catch(Exception ignored){tab.icon=null;}
                if(icon!=null)tab.icon=icon;
                tab.url=url;tab.loading=true;
                if(current()==tab){dashboardOpen=false;updateUI();}
            }
            @Override public void onPageFinished(WebView v,String url) {
                if(tab.web!=v)return;
                tab.url=url;tab.loading=false;
                if(v.getTitle()!=null&&!v.getTitle().isEmpty())tab.title=v.getTitle();
                recordHistory(tab);
                Bitmap favicon=v.getFavicon();
                if(favicon!=null)tab.icon=favicon;
                updateTabLabels();
                if(current()==tab)updateUI();
                broadcastTabs();
            }
            @Override public void onReceivedSslError(WebView v,SslErrorHandler handler,SslError error) {
                handler.cancel(); // Never bypass certificate errors.
            }
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public void onReceivedTitle(WebView v,String title) {
                if(title!=null&&!title.isEmpty()){tab.title=title; updateTabLabels();}
            }
            @Override public void onReceivedIcon(WebView v,Bitmap favicon) {
                if(tab.web==v && favicon!=null){tab.icon=favicon;updateTabLabels();}
            }
            @Override public boolean onCreateWindow(WebView v,boolean dialog,boolean userGesture,Message resultMsg){
                // Browser popups are allowed regardless of gesture source.
                BrowserTab child=newTab("about:blank",true);
                if(child==null)return false;
                WebView.WebViewTransport transport=(WebView.WebViewTransport)resultMsg.obj;
                transport.setWebView(child.web);
                resultMsg.sendToTarget();
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request){
                request.deny(); // Require explicit user-facing permission controls before enabling.
            }
            @Override public void onGeolocationPermissionsShowPrompt(String origin,android.webkit.GeolocationPermissions.Callback cb){
                cb.invoke(origin,false,false);
            }
        });
        tab.suspended=false;
    }

    private BrowserTab newTab(String url,boolean activate) {
        int limit=configuredTabLimit();
        if(limit>0 && tabs.size()>=limit){
            new AlertDialog.Builder(this).setMessage(
                "Tab limit reached ("+limit+"). Set Tab Limit to 0 for unlimited.")
                .setPositiveButton("OK",null).show();
            return null;
        }
        BrowserTab tab=new BrowserTab();
        tab.localId=nextLocalTabId++;
        prepareWebView(tab);
        tab.url=url;
        tab.inactiveSince=SystemClock.elapsedRealtime();
        tab.button=button("New Tab","Select tab");
        tab.button.setTextSize(10);
        tab.button.setSingleLine(true);
        tab.button.setEllipsize(android.text.TextUtils.TruncateAt.END);
        tab.button.setGravity(android.view.Gravity.CENTER_VERTICAL|android.view.Gravity.START);
        tab.button.setPadding(dp(5),0,0,0);
        tab.button.setCompoundDrawablePadding(dp(3));
        tab.closeButton=button("×","Close tab");
        tab.closeButton.setTextSize(14);
        tab.slot=new LinearLayout(this);
        tab.slot.setGravity(android.view.Gravity.CENTER_VERTICAL);
        tab.slot.addView(tab.button,new LinearLayout.LayoutParams(0,dp(20),1));
        tab.slot.addView(tab.closeButton,new LinearLayout.LayoutParams(dp(16),dp(16)));
        tabs.add(tab);
        LinearLayout.LayoutParams slotSize=new LinearLayout.LayoutParams(dp(71),dp(20));
        slotSize.setMargins(0,0,dp(2),0);
        tabRow.addView(tab.slot,slotSize);
        tab.button.setOnClickListener(v->switchTab(tabs.indexOf(tab)));
        tab.button.setOnLongClickListener(v->{new AlertDialog.Builder(this)
            .setTitle(tab.title).setItems(new String[]{"Unload Tab","Close Tab"},(d,which)->{
                if(which==0)unloadTab(tab,true);else closeTab(tab);
            }).show();return true;});
        tab.closeButton.setOnClickListener(v->closeTab(tab));
        if(activate)switchTab(tabs.indexOf(tab));
        if(!"about:blank".equals(url)){tab.loading=true;tab.web.loadUrl(url);}
        broadcastTabs();
        return tab;
    }

    private void switchTab(int index) {
        if(index<0||index>=tabs.size())return;
        BrowserTab prev=current();
        if(prev!=null){
            if(prev.web!=null)content.removeView(prev.web);
            prev.inactiveSince=SystemClock.elapsedRealtime();
        }
        currentIndex=index;
        dashboardOpen=false;
        BrowserTab tab=current();
        tab.inactiveSince=0;
        if(tab.suspended||tab.web==null){
            prepareWebView(tab);
            if(tab.url.startsWith("https://")){tab.loading=true;tab.web.loadUrl(tab.url);}
        }
        if(tab.web.getParent() instanceof ViewGroup)((ViewGroup)tab.web.getParent()).removeView(tab.web);
        content.addView(tab.web,new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));
        updateUI();
        flushDeferred();
    }

    // Every tab has a real bitmap icon even on sites (including ChatGPT) that
    // never notify WebChromeClient of their favicon. Cache by hostname.
    private Bitmap fallbackTabIcon(String address){
        String host="";
        try{String parsed=Uri.parse(address).getHost();if(parsed!=null)host=parsed.toLowerCase(java.util.Locale.ROOT);}
        catch(Exception ignored){}
        Bitmap cached=fallbackTabIcons.get(host);
        if(cached!=null)return cached;
        final boolean chatgpt=host.equals("chatgpt.com")||host.endsWith(".chatgpt.com");
        String glyph=chatgpt?"✳":host.isEmpty()?"◆":host.substring(0,1).toUpperCase(java.util.Locale.ROOT);
        int size=dp(16);
        Bitmap icon=Bitmap.createBitmap(size,size,Bitmap.Config.ARGB_8888);
        Canvas canvas=new Canvas(icon);
        Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        int color=chatgpt?0xff10a37f:Color.HSVToColor(new float[]{
            (host.hashCode()&0x7fffffff)%360,0.48f,0.65f});
        paint.setColor(color);
        canvas.drawRoundRect(0,0,size,size,chatgpt?size/2f:size/4f,chatgpt?size/2f:size/4f,paint);
        paint.setColor(Color.WHITE);paint.setTypeface(Typeface.DEFAULT_BOLD);
        paint.setTextSize(size*(chatgpt?0.79f:0.67f));paint.setTextAlign(Paint.Align.CENTER);
        Paint.FontMetrics metrics=paint.getFontMetrics();
        canvas.drawText(glyph,size/2f,(size-metrics.ascent-metrics.descent)/2f,paint);
        if(fallbackTabIcons.size()>80)fallbackTabIcons.clear();
        fallbackTabIcons.put(host,icon);
        return icon;
    }
    private void updateTabLabels() {
        for(BrowserTab tab:tabs){
            Bitmap image=tab.icon!=null?tab.icon:fallbackTabIcon(tab.url);
            Bitmap scaled=image.getWidth()==dp(16)&&image.getHeight()==dp(16)?image:
                Bitmap.createScaledBitmap(image,dp(16),dp(16),true);
            android.graphics.drawable.Drawable favicon="about:blank".equals(tab.url)
                ?getDrawable(R.mipmap.ic_launcher):new BitmapDrawable(getResources(),scaled);
            if(favicon!=null)favicon.setBounds(0,0,dp(12),dp(12));
            tab.button.setCompoundDrawables(favicon,null,null,null);
            tab.button.setText("about:blank".equals(tab.url)?"New Tab":tab.title);
            tab.button.setContentDescription((tab.suspended?"Unloaded · ":"")+tab.title);
            boolean selected=tab==current();
            tab.slot.setBackground(shape(tab.suspended?0xff41434b:selected?SURFACE:0x09ffffff,
                selected?0xff505a76:0,6));
            tab.button.setTextColor(tab.suspended?0xff8a8c96:tab==current()?Color.WHITE:0xffc5cde6);
        }
        publishSharedState();
    }
    private void updateUI() {
        BrowserTab tab=current();
        if(tab==null)return;
        if(!address.hasFocus())address.setText("about:blank".equals(tab.url)?"":tab.url);
        back.setEnabled(tab.web.canGoBack());
        forward.setEnabled(tab.web.canGoForward());
        updateTabLabels();
        updateDashboard();
    }

    private void closeTab(BrowserTab tab) {
        int index=tabs.indexOf(tab);
        if(index<0)return;
        if(tab==current() && tab.web!=null)content.removeView(tab.web);
        boolean wasCurrent=index==currentIndex;
        tabRow.removeView(tab.slot);
        tabs.remove(index);
        if(tab.web!=null){tab.web.stopLoading();tab.web.destroy();tab.web=null;}
        if(tabs.isEmpty()){currentIndex=-1;newTab("about:blank",true);}
        else if(wasCurrent) {
            currentIndex=-1;
            switchTab(Math.min(index,tabs.size()-1));
        }else {
            if(index<currentIndex)currentIndex--;
            updateUI();
        }
        broadcastTabs();
    }

    @Override public void onBackPressed() {
        if(sharedReady&&sharedOverlay){sharedChrome.evaluateJavascript("window.__minternetMobileCloseMenu?.()",null);return;}
        BrowserTab tab=current();
        if(tab!=null&&tab.web.canGoBack())tab.web.goBack();
        else if(tabs.size()>1)closeTab(tab);
        else super.onBackPressed();
    }

    @Override protected void onResume(){
        super.onResume();
        if(sync!=null)sync.resume();
    }
    @Override protected void onDestroy() {
        if(sync!=null)sync.stop();
        if(sharedChrome!=null){if(sharedChrome.getParent() instanceof ViewGroup)((ViewGroup)sharedChrome.getParent()).removeView(sharedChrome);sharedChrome.destroy();sharedChrome=null;sharedReady=false;}
        idleHandler.removeCallbacks(idleSweep);
        for(BrowserTab tab:new ArrayList<>(tabs)){
            if(tab.web==null)continue;
            if(tab.web.getParent() instanceof ViewGroup)((ViewGroup)tab.web.getParent()).removeView(tab.web);
            if(isolatedPrivate) {
                tab.web.clearHistory();
                tab.web.clearCache(true);
            }
            tab.web.destroy();
        }
        tabs.clear();
        if(isolatedPrivate) {
            // Best effort: clear private cookies/storage at session end.
            // WebView may still leave recoverable filesystem traces after a crash.
            CookieManager.getInstance().removeAllCookies(null);
            WebStorage.getInstance().deleteAllData();
            CookieManager.getInstance().flush();
        }
        super.onDestroy();
    }
}
