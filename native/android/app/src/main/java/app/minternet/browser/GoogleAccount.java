package app.minternet.browser;

import android.app.Activity;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.util.function.Consumer;

/** Explicit user-driven Google sign-in via Android Credential Manager.
 * The token is never written to disk or passed into a website WebView.
 * The backend validates this Google ID token before authorizing sync.
 */
final class GoogleAccount {
    private GoogleAccount(){}
    static void signIn(Activity activity,String webClientId,
                       Consumer<String> onToken,Consumer<String> onError){
        if(webClientId==null || !webClientId.matches(
            "^[0-9]+-[A-Za-z0-9.-]+\\.apps\\.googleusercontent\\.com$")){
            onError.accept("Configure a Google OAuth Web Client ID first");
            return;
        }
        try{
            GetSignInWithGoogleOption option=
                new GetSignInWithGoogleOption.Builder(webClientId).build();
            GetCredentialRequest request=new GetCredentialRequest.Builder()
                .addCredentialOption(option).build();
            CredentialManager.create(activity).getCredentialAsync(
                activity,request,null,activity::runOnUiThread,
                new CredentialManagerCallback<GetCredentialResponse,GetCredentialException>(){
                    @Override public void onResult(GetCredentialResponse result){
                        Credential credential=result.getCredential();
                        if(!(credential instanceof CustomCredential) ||
                           !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(
                               credential.getType())){
                            onError.accept("Google sign-in did not return a Google identity token");
                            return;
                        }
                        try{
                            GoogleIdTokenCredential google=
                                GoogleIdTokenCredential.createFrom(credential.getData());
                            String token=google.getIdToken();
                            if(token==null||token.isEmpty()){
                                onError.accept("Google returned an empty identity token");return;
                            }
                            onToken.accept(token);
                        }catch(RuntimeException ex){
                            onError.accept("Google identity token could not be verified");
                        }
                    }
                    @Override public void onError(GetCredentialException err){
                        onError.accept("Google sign-in was canceled or failed: "+
                            err.getClass().getSimpleName());
                    }
                });
        }catch(RuntimeException ex){
            onError.accept("Google Credential Manager is unavailable: "+
                ex.getClass().getSimpleName());
        }
    }
}
