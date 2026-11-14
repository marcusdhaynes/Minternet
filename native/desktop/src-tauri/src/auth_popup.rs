//! Popup routing. OAuth/federated login commonly depends on window.opener,
//! postMessage, and a live WebView2 NewWindowRequested relationship.
//! Replacing its window with a separately navigated tab destroys that link.
use tauri::Url;

fn login_path(path: &str) -> bool {
    path.split(|c:char| c=='/' || c=='-' || c=='_')
        .any(|segment| matches!(segment,
            "login"|"signin"|"sign"|"auth"|"oauth"|"oidc"|"saml"|"sso"|
            "authorize"|"authorization"|"callback"|"connect"|"account"|
            "identity"|"federation"))
}
fn trusted_identity_host(host: &str) -> bool {
    // Exact host or specific, well-defined subdomains; never suffix substrings.
    matches!(host,
        "accounts.google.com"|"login.microsoftonline.com"|"login.live.com"|
        "appleid.apple.com"|"github.com"|"id.kraken.com"|
        "accounts.youtube.com"|"login.yahoo.com"|"auth0.com") ||
        host.ends_with(".auth0.com") || host.ends_with(".okta.com") ||
        host.ends_with(".onelogin.com")
}

/// The native WebView2 popup must remain connected to its opener. Normal links
/// still open tabs; only identity popups (and blank bootstrap windows) are
/// allowed to use WebView2's NewWindowRequested implementation.
pub fn preserve_opener(opener_url: &str, target: &Url) -> bool {
    if target.as_str()=="about:blank" {
        // An OAuth SDK often opens about:blank before setting its URL. A
        // disconnected surrogate tab cannot later reattach window.opener.
        return true;
    }
    if target.scheme()!="https" || target.host_str().is_none() ||
       !target.username().is_empty() || target.password().is_some() {
        return false;
    }
    let target_host=target.host_str().unwrap_or("").to_ascii_lowercase();
    if trusted_identity_host(&target_host) {return true;}
    if login_path(&target.path().to_ascii_lowercase()) {return true;}
    if target.query_pairs().any(|(key,_)|
        matches!(key.as_ref(),"client_id"|"redirect_uri"|"response_type"|
            "code_challenge"|"samlrequest"|"SAMLRequest")) {return true;}
    // Login forms sometimes open a branded authorization page whose URL has
    // no indicative path. Use the opener's HTTPS login route in that case.
    Url::parse(opener_url).ok().is_some_and(|origin| {
        origin.scheme()=="https" && login_path(&origin.path().to_ascii_lowercase())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn url(s:&str)->Url{Url::parse(s).unwrap()}
    #[test] fn preserves_oauth_popup_relationship(){
        for u in ["about:blank","https://accounts.google.com/o/oauth2/v2/auth",
            "https://identity.example.com/oauth2/authorize?client_id=123",
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            "https://id.kraken.com/auth/callback/google"] {
            assert!(preserve_opener("https://example.com/",&url(u)), "{u}");
        }
    }
    #[test] fn ordinary_web_links_stay_in_tabs(){
        for u in ["https://example.com/articles/2026",
            "https://accounts.google.com.attacker.test/ordinary",
            "http://example.com/login"] {
            assert!(!preserve_opener("https://example.com/",&url(u)), "{u}");
        }
    }
    #[test] fn opener_auth_path_supports_branded_login(){
        assert!(preserve_opener("https://store.example.com/signin",
            &url("https://branded-idp.example.net/")));
        assert!(!preserve_opener("https://store.example.com/products",
            &url("https://branded-idp.example.net/")));
    }
}
