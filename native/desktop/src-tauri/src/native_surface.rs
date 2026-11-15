//! Verify Windows' *actual* WebView2 child HWND and COM viewport. Tauri's
//! cached Webview::position/size can be correct while WebView2 displays an
//! offset, undersized white/black compositor rectangle.
#![cfg(windows)]
use windows::Win32::Foundation::{HWND,POINT,RECT};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;

// [parent-client x, parent-client y, physical width, physical height]
type Bounds=[i32;4];

fn actual(hwnd:HWND,parent:HWND)->Option<Bounds>{
    let mut rect=RECT::default();
    if unsafe{GetWindowRect(hwnd,&mut rect)}.is_err(){return None;}
    let mut point=POINT{x:rect.left,y:rect.top};
    if !unsafe{ScreenToClient(parent,&mut point)}.as_bool(){return None;}
    Some([point.x,point.y,rect.right-rect.left,rect.bottom-rect.top])
}
fn different(a:Bounds,b:Bounds)->bool{
    a.iter().zip(b.iter()).any(|(v,w)|(v-w).abs()>3)
}

fn correct(hwnd:HWND,parent:HWND,controller:&ICoreWebView2Controller,
           wanted:Bounds)->bool{
    let [x,y,w,h]=wanted;
    if w<16||h<16{return false;}
    let mut fixed=false;
    // WRY's container HWND and WebView2 controller have separate rectangles.
    // Comparing only Tauri's logical geometry misses both types of drift.
    if actual(hwnd,parent).is_some_and(|found|different(found,wanted)){
        if unsafe{SetWindowPos(hwnd,None,x,y,w,h,SWP_NOACTIVATE|SWP_NOZORDER)}.is_ok(){
            fixed=true;
        }
    }
    let mut viewport=RECT::default();
    if unsafe{controller.Bounds(&mut viewport)}.is_ok(){
        let current=[viewport.left,viewport.top,
            viewport.right-viewport.left,viewport.bottom-viewport.top];
        let desired=[0,0,w,h];
        if different(current,desired){
            if unsafe{controller.SetBounds(RECT{
                left:0,top:0,right:w,bottom:h,
            })}.is_ok(){fixed=true;}
        }
    }
    if fixed{
        // WebView2's compositor needs an ancestor-position notification after
        // the *actual* native rect changes. No hide/show, reload, or new profile.
        let _=unsafe{controller.NotifyParentWindowPositionChanged()};
    }
    fixed
}

pub fn verify(view:&tauri::Webview,parent:isize,wanted:Bounds){
    if parent==0{return;}
    let _=view.with_webview(move|native|{
        let controller=native.controller();
        let mut hwnd=HWND::default();
        if unsafe{controller.ParentWindow(&mut hwnd)}.is_ok(){
            let _=correct(hwnd,HWND(parent as _),&controller,wanted);
        }
    });
}

/// CI deliberately corrupts both HWND and controller bounds, then proves
/// they are repaired while the original WebView2 controller remains alive.
pub fn smoke(view:&tauri::Webview,parent:isize,wanted:Bounds){
    if parent==0{return;}
    let _=view.with_webview(move|native|{
        let controller=native.controller();
        let mut hwnd=HWND::default();
        let ok=if unsafe{controller.ParentWindow(&mut hwnd)}.is_ok(){
            let expected_parent=HWND(parent as _);
            let bad=[
                wanted[0]+192,wanted[1]+112,
                (wanted[2]-350).max(100),(wanted[3]-250).max(100),
            ];
            let moved=unsafe{SetWindowPos(
                hwnd,None,bad[0],bad[1],bad[2],bad[3],
                SWP_NOACTIVATE|SWP_NOZORDER)}.is_ok();
            let viewport_changed=unsafe{controller.SetBounds(RECT{
                left:0,top:0,right:bad[2],bottom:bad[3],
            })}.is_ok();
            let was_wrong=actual(hwnd,expected_parent)
                .is_some_and(|now|different(now,wanted));
            let corrected=correct(hwnd,expected_parent,&controller,wanted);
            let host_right=actual(hwnd,expected_parent)
                .is_some_and(|now|!different(now,wanted));
            let mut inner=RECT::default();
            let viewport_right=unsafe{controller.Bounds(&mut inner)}.is_ok()
                && !different([inner.left,inner.top,
                    inner.right-inner.left,inner.bottom-inner.top],
                    [0,0,wanted[2],wanted[3]]);
            moved&&viewport_changed&&was_wrong&&corrected&&host_right&&viewport_right
        }else{false};
        let marker=std::env::temp_dir().join(format!(
            "minternet-native-surface-{}.{}",
            std::process::id(),if ok{"ok"}else{"failed"}));
        let _=std::fs::write(marker,if ok{
            "PASS: actual WebView2 child HWND and controller corrected without navigation"
        }else{
            "FAIL: real Win32/WebView2 native child and controller bounds not corrected"
        });
    });
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn detects_displaced_and_undersized_compositor_without_false_positives(){
        assert!(different([192,192,1200,800],[0,80,1600,1000]));
        assert!(!different([0,80,1600,1000],[0,80,1600,1000]));
        assert!(!different([1,81,1601,999],[0,80,1600,1000]));
    }
}
