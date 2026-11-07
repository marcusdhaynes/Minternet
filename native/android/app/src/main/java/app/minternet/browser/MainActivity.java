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
    private static final int BG=0xff111827;
    private static final int SURFACE=0xff1e293b;
    private static final int ACCENT=0xffb9b7ff;
    private final List<BrowserTab> tabs=new ArrayList<>();
    private final Map<String,Bitmap> fallbackTabIcons=new HashMap<>();
    private int currentIndex=-1;
    private LinearLayout tabRow;
    private EditText address;
    private FrameLayout content;
    private Button back,forward,reload;
    private boolean updatingAddress=false;
    private MinternetSync sync;
    private boolean applyingSync=false;
    private final Map<String,JSONObject> pendingRemoteTabs=new HashMap<>();
    private final Handler idleHandler=new Handler(Looper.getMainLooper());
    private final Runnable idleSweep=new Runnable(){@Override public void run(){checkIdleTabs();idleHandler.postDelayed(this,10000);}};

    private static final class BrowserTab {
        WebView web;
        String title="New Tab";
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

    private Button button(String text, String description) {
        Button b=new Button(this);
        b.setText(text);
        b.setContentDescription(description);
        b.setTextColor(0xfff3f4ff);
        b.setBackgroundTintList(android.content.res.ColorStateList.valueOf(SURFACE));
        b.setAllCaps(false);
        b.setPadding(0,0,0,0);
        b.setMinWidth(dp(38));
        b.setMinimumWidth(dp(38));
        b.setMinHeight(dp(38));
        b.setMinimumHeight(dp(38));
        b.setTextSize(14);
        return b;
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
        WebView.setWebContentsDebuggingEnabled(false);
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
        HorizontalScrollView strip=new HorizontalScrollView(this);
        strip.setHorizontalScrollBarEnabled(false);
        strip.setFillViewport(true);
        tabRow=new LinearLayout(this);
        tabRow.setOrientation(LinearLayout.HORIZONTAL);
        tabRow.setPadding(dp(3),dp(2),dp(3),dp(2));
        strip.addView(tabRow,new HorizontalScrollView.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,dp(36)));
        root.addView(strip,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,dp(37)));

        LinearLayout controls=new LinearLayout(this);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        controls.setGravity(android.view.Gravity.CENTER_VERTICAL);
        controls.setPadding(dp(3),0,dp(3),dp(3));
        android.widget.ImageView brand=new android.widget.ImageView(this);
        brand.setImageResource(R.mipmap.ic_launcher);
        brand.setScaleType(android.widget.ImageView.ScaleType.FIT_CENTER);
        brand.setContentDescription("Minternet");
        brand.setPadding(dp(2),dp(2),dp(2),dp(2));
        controls.addView(brand,new LinearLayout.LayoutParams(dp(29),dp(29)));
        back=button("‹","Back");
        forward=button("›","Forward");
        reload=button("↻","Reload");
        controls.addView(back);controls.addView(forward);controls.addView(reload);
        address=new EditText(this);
        address.setSingleLine(true);
        address.setTextColor(Color.WHITE);
        address.setHintTextColor(0xff9ca3af);
        address.setHint("Search or enter HTTPS address");
        address.setTextSize(12);
        address.setSelectAllOnFocus(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);
        address.setBackgroundTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        controls.addView(address,new LinearLayout.LayoutParams(0,dp(38),1));
        Button go=button("→","Go");
        Button add=button("+","New tab");
        Button privateButton=button("◈",isolatedPrivate?"Return to normal browser":"Open isolated private window");
        controls.addView(go);controls.addView(add);controls.addView(privateButton);
        Button settings=button("⚙","Settings and Google Sync");
        controls.addView(settings,new LinearLayout.LayoutParams(dp(34),dp(38)));
        settings.setOnClickListener(v->openSettings());
        root.addView(controls,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,dp(42)));
        content=new FrameLayout(this);
        content.setBackgroundColor(Color.WHITE);
        root.addView(content,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1));

        back.setOnClickListener(v->{BrowserTab t=current();if(t!=null&&t.web.canGoBack())t.web.goBack();});
        forward.setOnClickListener(v->{BrowserTab t=current();if(t!=null&&t.web.canGoForward())t.web.goForward();});
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
            privateButton.setText("◈");
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

    private String normalized(String input) {
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
        return "https://duckduckgo.com/?q="+Uri.encode(s);
    }

    private void navigate(String input) {
        String url=normalized(input);
        if(url==null){
            new AlertDialog.Builder(this).setMessage("Only HTTPS addresses and searches are allowed. Insecure or local schemes are blocked.").setPositiveButton("OK",null).show();
            return;
        }
        BrowserTab tab=current();
        if(tab!=null)tab.web.loadUrl(url);
        InputMethodManager imm=(InputMethodManager)getSystemService(Context.INPUT_METHOD_SERVICE);
        if(imm!=null)imm.hideSoftInputFromWindow(address.getWindowToken(),0);
        address.clearFocus();
    }

    private void prepareWebView(BrowserTab tab) {
        WebView web=new WebView(this);
        tab.web=web;
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
        s.setJavaScriptCanOpenWindowsAutomatically(false);
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
                if(current()==tab)updateUI();
            }
            @Override public void onPageFinished(WebView v,String url) {
                if(tab.web!=v)return;
                tab.url=url;tab.loading=false;
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
                if(!userGesture)return false;
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
        prepareWebView(tab);
        tab.url=url;
        tab.inactiveSince=SystemClock.elapsedRealtime();
        tab.button=button("◆","Select tab");
        tab.button.setMinWidth(0);tab.button.setMinimumWidth(0);
        tab.button.setTextSize(13);
        tab.closeButton=button("×","Close tab");
        tab.closeButton.setMinWidth(0);tab.closeButton.setMinimumWidth(0);
        tab.closeButton.setTextSize(15);
        tab.slot=new LinearLayout(this);
        tab.slot.addView(tab.button,new LinearLayout.LayoutParams(dp(29),dp(32)));
        tab.slot.addView(tab.closeButton,new LinearLayout.LayoutParams(dp(22),dp(32)));
        tabs.add(tab);
        tabRow.addView(tab.slot,new LinearLayout.LayoutParams(dp(53),dp(32)));
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
            tab.button.setCompoundDrawablesWithIntrinsicBounds(new BitmapDrawable(getResources(),scaled),null,null,null);
            tab.button.setText("");
            tab.button.setContentDescription((tab.suspended?"Unloaded · ":"")+tab.title);
            tab.button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(
                tab.suspended?0xff41434b:tab==current()?0xff474570:SURFACE));
            tab.button.setTextColor(tab.suspended?0xff8a8c96:tab==current()?Color.WHITE:0xffc5cde6);
        }
    }
    private void updateUI() {
        BrowserTab tab=current();
        if(tab==null)return;
        if(!address.hasFocus())address.setText("about:blank".equals(tab.url)?"":tab.url);
        back.setEnabled(tab.web.canGoBack());
        forward.setEnabled(tab.web.canGoForward());
        updateTabLabels();
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
