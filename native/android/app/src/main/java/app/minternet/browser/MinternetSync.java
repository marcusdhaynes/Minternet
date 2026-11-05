package app.minternet.browser;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** Per-record AES-256-GCM encrypted push-only Minternet sync for Android.
 * No sync polling. Google consent is performed separately in Credential Manager;
 * the ID token is verified by Supabase Auth and all rows have owner RLS.
 * Only non-private HTTPS tab data can leave this process.
 */
final class MinternetSync {
    interface Listener {
        void onStatus(String message);
        void onRemoteTab(JSONObject value,boolean deleted);
        void onDataChanged(String kind);
    }
    private static final MediaType JSON_TYPE=MediaType.parse("application/json");
    private final Activity activity;
    private final Listener listener;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService executor=Executors.newSingleThreadExecutor();
    private final OkHttpClient http=new OkHttpClient.Builder()
        .retryOnConnectionFailure(true).build();
    private final Map<String,CloudRecord> cloud=new HashMap<>();
    private final Map<String,JSONObject> lastLocalTabs=new HashMap<>();
    private final SecureRandom random=new SecureRandom();
    private String url,apiKey,jwt,refresh,userId;
    private SecretKeySpec encryptionKey;
    private WebSocket socket;
    private boolean active=false,firstLoad=true;
    private int retryDelay=500,reference=0;
    private Runnable retry,heartbeat;

    private static final class CloudRecord {
        String kind,id,ciphertext;
        long revision;
        boolean deleted;
        JSONObject value;
    }
    MinternetSync(Activity activity,Listener listener){
        this.activity=activity;this.listener=listener;
    }
    private void status(String message){main.post(()->listener.onStatus(message));}
    boolean isActive(){return active;}
    private static boolean validUrl(String candidate){
        if(candidate==null||candidate.length()>2048)return false;
        try{
            android.net.Uri uri=android.net.Uri.parse(candidate);
            String h=uri.getHost();
            return "https".equals(uri.getScheme())&&h!=null&&!h.endsWith(".onion")&&
                uri.getUserInfo()==null;
        }catch(Exception ignored){return false;}
    }
    private static String encoded(byte[] bytes){
        return Base64.encodeToString(bytes,Base64.URL_SAFE|Base64.NO_PADDING|Base64.NO_WRAP);
    }
    private static byte[] decoded(String value){
        return Base64.decode(value,Base64.URL_SAFE|Base64.NO_WRAP);
    }
    private SecretKeySpec derive(String passphrase,String identity)throws Exception{
        if(passphrase==null||passphrase.length()<16)throw new IllegalArgumentException(
            "Use at least 16 characters for sync encryption");
        byte[] salt=MessageDigest.getInstance("SHA-256").digest(
            ("minternet-e2ee-v2:"+identity.toLowerCase()).getBytes(StandardCharsets.UTF_8));
        byte[] first16=new byte[16];
        System.arraycopy(salt,0,first16,0,16);
        PBEKeySpec spec=new PBEKeySpec(passphrase.toCharArray(),first16,310000,256);
        byte[] raw=SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            .generateSecret(spec).getEncoded();
        spec.clearPassword();
        SecretKeySpec secret=new SecretKeySpec(raw,"AES");
        java.util.Arrays.fill(raw,(byte)0);
        return secret;
    }
    private String encrypt(String kind,String id,JSONObject value)throws Exception{
        byte[] nonce=new byte[12];random.nextBytes(nonce);
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE,encryptionKey,new GCMParameterSpec(128,nonce));
        cipher.updateAAD(("minternet:"+kind+":"+id).getBytes(StandardCharsets.UTF_8));
        byte[] payload=cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        return "enc1:"+encoded(nonce)+"."+encoded(payload);
    }
    private JSONObject decrypt(String kind,String id,String envelope)throws Exception{
        if(envelope==null||!envelope.startsWith("enc1:"))throw new IOException("Missing encryption");
        String[] pieces=envelope.substring(5).split("\\.",2);
        if(pieces.length!=2)throw new IOException("Invalid encrypted envelope");
        byte[] nonce=decoded(pieces[0]);
        if(nonce.length!=12)throw new IOException("Invalid encrypted nonce");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE,encryptionKey,new GCMParameterSpec(128,nonce));
        cipher.updateAAD(("minternet:"+kind+":"+id).getBytes(StandardCharsets.UTF_8));
        return new JSONObject(new String(cipher.doFinal(decoded(pieces[1])),StandardCharsets.UTF_8));
    }
    private Response rawRequest(String path,String method,JSONObject body)throws Exception{
        RequestBody post=body==null?null:RequestBody.create(JSON_TYPE,body.toString());
        Request.Builder builder=new Request.Builder().url(url+path)
            .addHeader("apikey",apiKey).addHeader("Authorization","Bearer "+jwt);
        if("POST".equals(method)){
            builder.addHeader("Prefer","resolution=merge-duplicates,return=representation");
            builder.post(post);
        }else if("PATCH".equals(method)){builder.patch(post);}
        okhttp3.Call call=http.newCall(builder.build());
        return call.execute();
    }
    private String request(String path,String method,JSONObject body)throws Exception{
        try(Response response=rawRequest(path,method,body)){
            if(response.code()==401&&refresh!=null){
                refresh();
                try(Response next=rawRequest(path,method,body)){
                    if(!next.isSuccessful())throw new IOException("Sync server HTTP "+next.code());
                    return next.body()!=null?next.body().string():"";
                }
            }
            if(!response.isSuccessful())throw new IOException("Sync server HTTP "+response.code());
            return response.body()!=null?response.body().string():"";
        }
    }
    private void refresh()throws Exception{
        JSONObject args=new JSONObject().put("refresh_token",refresh);
        Request r=new Request.Builder().url(url+"/auth/v1/token?grant_type=refresh_token")
            .addHeader("apikey",apiKey).post(RequestBody.create(JSON_TYPE,args.toString())).build();
        try(Response response=http.newCall(r).execute()){
            if(!response.isSuccessful())throw new IOException("Please sign in to Google again");
            JSONObject newTokens=new JSONObject(response.body().string());
            jwt=newTokens.getString("access_token");
            refresh=newTokens.optString("refresh_token",refresh);
        }
    }
    void start(String backend,String publishableKey,String idToken,String passphrase){
        executor.execute(()->{
            try{
                android.net.Uri target=android.net.Uri.parse(backend);
                if(!"https".equals(target.getScheme())||target.getHost()==null||
                   !target.getHost().matches("^[a-z0-9-]+\\.supabase\\.co$")||
                   target.getPort()!=-1||!publishableKey.startsWith("sb_publishable_")){
                    throw new IllegalArgumentException("Enter a dedicated HTTPS Minternet Supabase backend");
                }
                url=backend.replaceAll("/$","");
                apiKey=publishableKey;
                JSONObject body=new JSONObject().put("provider","google").put("id_token",idToken);
                Request req=new Request.Builder()
                    .url(url+"/auth/v1/token?grant_type=id_token")
                    .addHeader("apikey",apiKey)
                    .post(RequestBody.create(JSON_TYPE,body.toString())).build();
                JSONObject response;
                try(Response answer=http.newCall(req).execute()){
                    if(!answer.isSuccessful())throw new IOException(
                        "Supabase Google provider must be configured. HTTP "+answer.code());
                    response=new JSONObject(answer.body().string());
                }
                userId=response.getJSONObject("user").getString("id");
                if(!userId.matches("^[a-fA-F0-9-]{36}$"))throw new IOException("Invalid account ID");
                jwt=response.getString("access_token");
                refresh=response.getString("refresh_token");
                encryptionKey=derive(passphrase,userId);
                active=true;
                firstLoad=true;
                fetchAll();
                firstLoad=false;
                connect();
                status("Encrypted live sync active");
            }catch(Exception error){
                status("Cannot enable sync: "+error.getMessage());
                stopInternal();
            }
        });
    }
    private CloudRecord parse(JSONObject item)throws Exception{
        CloudRecord record=new CloudRecord();
        record.kind=item.getString("kind");
        record.id=item.getString("item_key");
        if(!record.kind.matches("tab|group|bookmark|login|payment|undo|prefs") ||
           !record.id.matches("^[A-Za-z0-9_:.@-]{1,180}$"))
            throw new IOException("Invalid sync item");
        record.revision=item.getLong("revision");
        record.deleted=item.optBoolean("deleted");
        record.ciphertext=item.isNull("ciphertext")?null:item.getString("ciphertext");
        if(record.ciphertext!=null)record.value=decrypt(record.kind,record.id,record.ciphertext);
        return record;
    }
    private void apply(CloudRecord record){
        CloudRecord previous=cloud.get(record.kind+":"+record.id);
        if(previous!=null && previous.revision>=record.revision)return;
        cloud.put(record.kind+":"+record.id,record);
        if(firstLoad)return;
        deliver(record);
    }
    private void deliver(CloudRecord record){
        if("tab".equals(record.kind) && record.value!=null){
            main.post(()->listener.onRemoteTab(record.value,record.deleted));
        }else{
            // All non-tab records stay in an encrypted private local cache.
            // Plaintext is not saved to Android shared preferences.
            activity.getSharedPreferences("minternet.sync.encrypted",Activity.MODE_PRIVATE)
                .edit().putString(record.kind+":"+record.id,
                    record.deleted?"tombstone:"+record.ciphertext:record.ciphertext).apply();
            main.post(()->listener.onDataChanged(record.kind));
        }
    }
    private void fetchAll()throws Exception{
        for(int offset=0;offset<10000;offset+=500){
            String path="/rest/v1/minternet_sync_state?select=kind,item_key,ciphertext,deleted,revision"+
                "&user_id=eq."+userId+"&order=revision.asc&limit=500&offset="+offset;
            JSONArray list=new JSONArray(request(path,"GET",null));
            for(int i=0;i<list.length();i++)apply(parse(list.getJSONObject(i)));
            if(list.length()<500)break;
        }
        for(CloudRecord item:cloud.values())deliver(item);
    }
    private void refreshItem(String kind,String id){
        try{
            String path="/rest/v1/minternet_sync_state?select=kind,item_key,ciphertext,deleted,revision"+
                "&kind=eq."+kind+"&item_key=eq."+id+"&user_id=eq."+userId+"&limit=1";
            JSONArray result=new JSONArray(request(path,"GET",null));
            if(result.length()>0)apply(parse(result.getJSONObject(0)));
        }catch(Exception error){status("Live sync item failed: "+error.getMessage());}
    }
    private void send(String topic,String event,JSONObject payload,String joinRef){
        if(socket==null)return;
        try{
            JSONObject message=new JSONObject().put("topic",topic).put("event",event)
                .put("payload",payload).put("ref",String.valueOf(++reference))
                .put("join_ref",joinRef==null?JSONObject.NULL:joinRef);
            socket.send(message.toString());
        }catch(Exception ignored){}
    }
    private void connect(){
        if(!active||socket!=null)return;
        Request request=new Request.Builder().url(
            url.replaceFirst("^https:","wss:")+
            "/realtime/v1/websocket?apikey="+android.net.Uri.encode(apiKey)+"&vsn=2.0.0").build();
        socket=http.newWebSocket(request,new WebSocketListener(){
            private String joinRef;
            @Override public void onOpen(WebSocket ws,Response response){
                retryDelay=500;
                joinRef=String.valueOf(++reference);
                try{
                    JSONObject config=new JSONObject().put("broadcast",
                        new JSONObject().put("ack",false).put("self",false))
                        .put("presence",new JSONObject().put("key","")).put("private",true);
                    send("realtime:minternet:"+userId,"phx_join",
                        new JSONObject().put("config",config).put("access_token",jwt),joinRef);
                    startHeartbeat();
                }catch(Exception ignored){}
            }
            @Override public void onMessage(WebSocket ws,String value){
                try{
                    JSONObject message=new JSONObject(value);
                    if(!("realtime:minternet:"+userId).equals(message.optString("topic")))return;
                    String event=message.optString("event");
                    JSONObject payload=message.optJSONObject("payload");
                    if("phx_reply".equals(event)&&payload!=null&&
                       "ok".equals(payload.optString("status"))){
                        executor.execute(()->{
                            try{fetchAll();status("Live sync connected");}
                            catch(Exception e){status("Reconnect sync failed");}
                        });
                    }
                    if("broadcast".equals(event)&&payload!=null&&
                       "sync".equals(payload.optString("event"))){
                        JSONObject change=payload.optJSONObject("payload");
                        if(change!=null){
                            String kind=change.optString("kind"),id=change.optString("item_key");
                            if(kind.matches("tab|group|bookmark|login|payment|undo|prefs")&&
                               id.matches("^[A-Za-z0-9_:.@-]{1,180}$"))
                                executor.execute(()->refreshItem(kind,id));
                        }
                    }
                }catch(Exception ignored){}
            }
            @Override public void onMessage(WebSocket ws,ByteString data){}
            @Override public void onFailure(WebSocket ws,Throwable error,Response response){
                if(socket==ws)socket=null;
                scheduleReconnect();
            }
            @Override public void onClosed(WebSocket ws,int code,String reason){
                if(socket==ws)socket=null;
                scheduleReconnect();
            }
        });
    }
    private void startHeartbeat(){
        if(heartbeat!=null)main.removeCallbacks(heartbeat);
        heartbeat=new Runnable(){
            @Override public void run(){
                if(!active||socket==null)return;
                send("phoenix","heartbeat",new JSONObject(),null);
                main.postDelayed(this,25000); // Phoenix liveness, NOT sync polling.
            }
        };
        main.postDelayed(heartbeat,25000);
    }
    private void scheduleReconnect(){
        if(heartbeat!=null)main.removeCallbacks(heartbeat);
        if(!active||retry!=null)return;
        retry=()->{
            retry=null;
            if(active)executor.execute(()->{
                try{refresh();}catch(Exception ignored){}
                connect();
            });
        };
        main.postDelayed(retry,retryDelay);
        retryDelay=Math.min(30000,retryDelay*2);
    }
    private void write(String kind,String id,JSONObject value,boolean deleted)throws Exception{
        String enc=encrypt(kind,id,value);
        JSONObject payload=new JSONObject().put("user_id",userId).put("kind",kind)
            .put("item_key",id).put("ciphertext",enc).put("deleted",deleted);
        String response=request("/rest/v1/minternet_sync_state?on_conflict=user_id,kind,item_key",
            "POST",payload);
        JSONArray arr=new JSONArray(response);
        if(arr.length()==0)throw new IOException("No server sync confirmation");
        CloudRecord current=parse(arr.getJSONObject(0));
        cloud.put(kind+":"+id,current);
    }
    void changedTabs(List<JSONObject> tabs){
        if(!active)return;
        final List<JSONObject> snapshot=new ArrayList<>(tabs);
        executor.execute(()->{
            try{
                Map<String,JSONObject> incoming=new HashMap<>();
                for(JSONObject tab:snapshot){
                    if(tab.optBoolean("private")||!validUrl(tab.optString("url")))continue;
                    String id=tab.optString("syncId");
                    if(!id.matches("[a-fA-F0-9]{32}"))continue;
                    incoming.put(id,tab);
                }
                // Never let absent remote tabs be treated as locally deleted
                // until a first local baseline is registered.
                for(Map.Entry<String,JSONObject> pair:incoming.entrySet()){
                    String id=pair.getKey();
                    JSONObject now=pair.getValue();
                    JSONObject old=lastLocalTabs.get(id);
                    if(old!=null&&old.toString().equals(now.toString()))continue;
                    CloudRecord existing=cloud.get("tab:"+id);
                    if(old==null&&existing!=null)continue; // Cloud identity wins initial hydration.
                    write("tab",id,now,false);
                }
                for(Map.Entry<String,JSONObject> old:new HashMap<>(lastLocalTabs).entrySet()){
                    if(!incoming.containsKey(old.getKey())){
                        write("tab",old.getKey(),old.getValue(),true);
                    }
                }
                lastLocalTabs.clear();
                lastLocalTabs.putAll(incoming);
            }catch(Exception e){status("Tab sync will resume after reconnect");}
        });
    }
    void undo(){
        if(!active)return;
        executor.execute(()->{
            try{
                String response=request("/rest/v1/rpc/minternet_undo_last","POST",new JSONObject());
                JSONObject answer=new JSONObject(response);
                if(!answer.optBoolean("ok"))status("Nothing to undo on this account");
                else refreshItem(answer.getString("kind"),answer.getString("item_key"));
            }catch(Exception e){status("Shared Undo failed: "+e.getMessage());}
        });
    }
    void stop(){
        executor.execute(this::stopInternal);
    }
    private void stopInternal(){
        active=false;firstLoad=true;
        if(retry!=null){main.removeCallbacks(retry);retry=null;}
        if(heartbeat!=null){main.removeCallbacks(heartbeat);heartbeat=null;}
        if(socket!=null){socket.close(1000,"Signed out");socket=null;}
        jwt=null;refresh=null;encryptionKey=null;userId=null;
        cloud.clear();lastLocalTabs.clear();
    }
    void resume(){
        if(active&&socket==null)executor.execute(this::connect);
    }
}
