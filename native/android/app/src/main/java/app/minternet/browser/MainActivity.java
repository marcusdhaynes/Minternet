package app.minternet.browser;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Build;
import android.content.Intent;
import android.webkit.WebStorage;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.Bitmap;
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

public class MainActivity extends Activity {
    private boolean isolatedPrivate=false;
    private static final int BG=0xff111827;
    private static final int SURFACE=0xff1e293b;
    private static final int ACCENT=0xffb9b7ff;
    private final List<BrowserTab> tabs=new ArrayList<>();
    private int currentIndex=-1;
    private LinearLayout tabRow;
    private EditText address;
    private FrameLayout content;
    private Button back,forward,reload;
    private boolean updatingAddress=false;

    private static final class BrowserTab {
        WebView web;
        String title="New Tab";
        String url="about:blank";
        Button button;
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
        root.addView(controls,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,dp(42)));
        content=new FrameLayout(this);
        content.setBackgroundColor(Color.WHITE);
        root.addView(content,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1));

        back.setOnClickListener(v->{BrowserTab t=current();if(t!=null&&t.web.canGoBack())t.web.goBack();});
        forward.setOnClickListener(v->{BrowserTab t=current();if(t!=null&&t.web.canGoForward())t.web.goForward();});
        reload.setOnClickListener(v->{BrowserTab t=current();if(t!=null)t.web.reload();});
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

    private BrowserTab newTab(String url,boolean activate) {
        if(tabs.size()>=24){
            new AlertDialog.Builder(this).setMessage("Maximum 24 tabs. Close some before opening more.").setPositiveButton("OK",null).show();
            return null;
        }
        BrowserTab tab=new BrowserTab();
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
                tab.url=url;
                if(current()==tab)updateUI();
            }
            @Override public void onPageFinished(WebView v,String url) {
                tab.url=url;
                if(current()==tab)updateUI();
            }
            @Override public void onReceivedSslError(WebView v,SslErrorHandler handler,SslError error) {
                handler.cancel(); // Never bypass certificate errors.
            }
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public void onReceivedTitle(WebView v,String title) {
                if(title!=null&&!title.isEmpty()){tab.title=title; updateTabLabels();}
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
        tab.button=button("New Tab  ×","Tab");
        tabs.add(tab);
        tabRow.addView(tab.button,new LinearLayout.LayoutParams(dp(136),dp(32)));
        tab.button.setOnClickListener(v->switchTab(tabs.indexOf(tab)));
        tab.button.setOnLongClickListener(v->{closeTab(tab);return true;});
        if(activate)switchTab(tabs.indexOf(tab));
        if(!"about:blank".equals(url))web.loadUrl(url);
        return tab;
    }

    private void switchTab(int index) {
        if(index<0||index>=tabs.size())return;
        BrowserTab prev=current();
        if(prev!=null)content.removeView(prev.web);
        currentIndex=index;
        BrowserTab tab=current();
        if(tab.web.getParent() instanceof ViewGroup)((ViewGroup)tab.web.getParent()).removeView(tab.web);
        content.addView(tab.web,new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));
        updateUI();
    }

    private void updateTabLabels() {
        for(BrowserTab tab:tabs){
            String label=tab.title.length()>15?tab.title.substring(0,15)+"…":tab.title;
            tab.button.setText((tab==current()?"● ":"")+" "+label+"  ×");
            tab.button.setTextColor(tab==current()?Color.WHITE:0xffa5b4cf);
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
        if(tab==current())content.removeView(tab.web);
        tabRow.removeView(tab.button);
        tabs.remove(index);
        tab.web.stopLoading();tab.web.destroy();
        if(tabs.isEmpty()){currentIndex=-1;newTab("about:blank",true);}
        else if(tab==current()||index==currentIndex) {
            currentIndex=-1;
            switchTab(Math.min(index,tabs.size()-1));
        }else {
            if(index<currentIndex)currentIndex--;
            updateUI();
        }
    }

    @Override public void onBackPressed() {
        BrowserTab tab=current();
        if(tab!=null&&tab.web.canGoBack())tab.web.goBack();
        else if(tabs.size()>1)closeTab(tab);
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        for(BrowserTab tab:new ArrayList<>(tabs)){
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
