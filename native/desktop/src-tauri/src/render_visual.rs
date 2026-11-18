//! Detect a visually white WebView2 surface that a DOM-only health probe misses.
//! CapturePreview stays strictly in memory: no screenshot is saved, logged,
//! exposed to the toolbar, or sent over the network. Only a boolean survives.
#![cfg(windows)]
use std::{collections::HashMap,io::Cursor,
    sync::{Mutex,OnceLock,atomic::{AtomicBool,AtomicU64,Ordering}},time::{Duration,Instant}};
use tauri::Manager;
use windows::Win32::{
    Foundation::HGLOBAL,
    System::Com::{IStream,STREAM_SEEK_SET,
        StructuredStorage::CreateStreamOnHGlobal},
};
use webview2_com::{CapturePreviewCompletedHandler,
    Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG};

const MAX_CAPTURE_BYTES:usize=12*1024*1024;
static BUSY:OnceLock<Mutex<HashMap<u32,(Instant,u64)>>>=OnceLock::new();
static CAPTURE_SEQ:AtomicU64=AtomicU64::new(1);
static VISUAL_SMOKE_CONFIRMED:AtomicBool=AtomicBool::new(false);
pub fn smoke_confirmed()->bool{
    VISUAL_SMOKE_CONFIRMED.load(Ordering::Acquire)
}
static WHITE:OnceLock<Mutex<HashMap<u32,(String,Instant,u8)>>>=OnceLock::new();

fn pending()->&'static Mutex<HashMap<u32,(Instant,u64)>>{
    BUSY.get_or_init(||Mutex::new(HashMap::new()))
}
fn begin_capture(id:u32)->Option<u64>{
    let Ok(mut entries)=pending().lock() else{return None};
    // WebView2 can return S_OK without a completion callback if its surface
    // becomes hidden. Expire such probes, but never replace an active one.
    entries.retain(|_,(when,_)|when.elapsed()<Duration::from_secs(18));
    if entries.contains_key(&id){return None;}
    let token=CAPTURE_SEQ.fetch_add(1,Ordering::Relaxed);
    entries.insert(id,(Instant::now(),token));
    Some(token)
}
fn clear_pending(id:u32,token:u64)->bool{
    if let Ok(mut pending)=pending().lock(){
        if pending.get(&id).is_some_and(|(_,current)|*current==token){
            pending.remove(&id);
            return true;
        }
    }
    false
}
// Two white captures, separated by a compositor rebind, are required.
// A healthy/colored frame resets the suspicion. A visual failure alone
// never justifies discarding unsaved user work.
fn white_seen(id:u32,url:&str,is_white:bool)->u8{
    let Ok(mut map)=WHITE.get_or_init(||Mutex::new(HashMap::new())).lock()
        else{return 0};
    map.retain(|_,(_,when,_)|when.elapsed()<Duration::from_secs(90));
    if !is_white{map.remove(&id);return 0;}
    let current=map.entry(id).or_insert_with(||
        (url.to_string(),Instant::now(),0));
    if current.0!=url||current.1.elapsed()>Duration::from_secs(20){
        *current=(url.to_string(),Instant::now(),0);
    }
    current.1=Instant::now();
    current.2=current.2.saturating_add(1).min(3);
    current.2
}
fn read_preview(stream:&IStream)->Option<Vec<u8>>{
    unsafe{stream.Seek(0,STREAM_SEEK_SET,None)}.ok()?;
    let mut result=Vec::with_capacity(65536);
    let mut buffer=[0u8;65536];
    loop{
        let mut received=0u32;
        let status=unsafe{stream.Read(buffer.as_mut_ptr().cast(),
            buffer.len() as u32,Some(&mut received))};
        if status.is_err(){return None;}
        if received==0{break;}
        if result.len().saturating_add(received as usize)>MAX_CAPTURE_BYTES{
            return None;
        }
        result.extend_from_slice(&buffer[..received as usize]);
        if received<buffer.len() as u32{break;}
    }
    Some(result)
}
// Ignore a narrow native scrollbar or anti-aliased edge while requiring
// the center of the viewport to be essentially pure white. A legitimate
// content page with text in the center remains excluded. The second captured
// sample and the SAFE_TO_RESTART check still guard against false positives.
// The source PNG and uncompressed pixels are discarded immediately afterward.
fn fully_white(png:&[u8])->bool{
    if png.len()<32||png.len()>MAX_CAPTURE_BYTES{return false;}
    let mut decoder=png::Decoder::new(Cursor::new(png));
    decoder.set_transformations(png::Transformations::EXPAND|png::Transformations::STRIP_16);
    let Ok(mut reader)=decoder.read_info() else{return false};
    let Some(required)=usize::try_from(reader.output_buffer_size()).ok() else{return false};
    if required>64*1024*1024{return false;}
    let mut pixels=vec![0u8;required];
    let Ok(info)=reader.next_frame(&mut pixels) else{return false};
    if info.width<200||info.height<140{return false;}
    let channels=match info.color_type{
        png::ColorType::Rgb=>3,
        png::ColorType::Rgba=>4,
        png::ColorType::Grayscale=>1,
        png::ColorType::GrayscaleAlpha=>2,
        png::ColorType::Indexed=>return false,
    };
    let stride=info.line_size;
    let (mut count,mut nonwhite,mut center_count,mut center_nonwhite)=(0usize,0usize,0usize,0usize);
    for y in (0..info.height as usize).step_by(5){
        for x in (0..info.width as usize).step_by(5){
            let Some(p)=y.checked_mul(stride).and_then(|v|
                v.checked_add(x*channels)) else{return false};
            if p+channels>info.buffer_size(){return false;}
            let rgb=if channels<=2{
                let gray=pixels[p];
                [gray,gray,gray]
            }else{[pixels[p],pixels[p+1],pixels[p+2]]};
            count+=1;
            let marked=rgb.iter().any(|&channel|channel<248);
            let central=x>=info.width as usize/6 &&
                x<info.width as usize*5/6 &&
                y>=info.height as usize/6 && y<info.height as usize*5/6;
            if central{center_count+=1;}
            if marked{
                nonwhite+=1;
                if central{center_nonwhite+=1;}
            }
        }
    }
    // A 15-pixel scrollbar on a typical Windows WebView is ~1–2% of
    // screenshot pixels. The interior cannot contain normal dark page text.
    count>1000 && center_count>300 &&
        nonwhite*100<=count*3 &&
        center_nonwhite*1000<=center_count*5
}
const SAFE_TO_RESTART:&str=r#"(() => {
    try {
      if(document.readyState!=='complete'||!document.body)return 0;
      if(document.querySelector('[role="dialog"],[aria-busy="true"],video,canvas'))return 0;
      if([...document.querySelectorAll('input,textarea,select,[contenteditable]')]
          .some(el=>el.isContentEditable ? !!el.textContent?.trim() :
            !!el.value?.trim()))return 0;
      return Number((document.body.innerText||'').trim().length>24 ||
        !!document.querySelector('textarea,input,[role="textbox"]'));
    } catch { return 0; }
})()"#;

fn match_active(app:&tauri::AppHandle,id:u32,url:&str)->Option<String>{
    let storage=app.state::<Mutex<super::Browser>>();
    let browser=storage.lock().ok()?;
    let tab=browser.active()?;
    if browser.active_id!=id||tab.url!=url||tab.loading||
        tab.private||tab.tor||tab.secret_id.is_some()||
        !super::is_real_page_url(url){return None;}
    tab.view.clone()
}
fn handle_visual_result(app:tauri::AppHandle,id:u32,url:String,white:bool){
    let Some(label)=match_active(&app,id,&url) else{return};
    super::white_smoke_stage(if white{"preview-white"}else{"preview-not-white"});
    super::startup_super::white_smoke_stage(if white{"visual-preview-white"}
        else{"visual-preview-painted"});
    if !white{
        // Native window startup is protected by an opaque Chrome curtain.
        // An actual painted frame is required before releasing it: a
        // successful navigation, geometry check or ready DOM is insufficient.
        let Some(view)=app.get_webview(&label) else{return};
        let task=app.clone();
        let expected=url.clone();
        let _=view.eval_with_callback(r#"Boolean(
            document.readyState==='complete' && document.body &&
            (document.body.children.length>0 ||
             (document.body.innerText||'').trim().length>0)
        )"#,move|response|{
            if response.trim()!="true"{
                super::startup_super::white_smoke_stage("painted-frame-dom-not-ready");
                return;
            }
            super::startup_super::white_smoke_stage("painted-frame-dom-ready");
            let on_main=task.clone();
            let expected_url=expected.clone();
            let _=task.run_on_main_thread(move||{
                if match_active(&on_main,id,&expected_url).is_some(){
                    super::finish_restored_chrome(&on_main,id,&expected_url);
                }
            });
        });
    }
    let stage=white_seen(id,&url,white);
    if stage==0{return;}
    let Some(view)=app.get_webview(&label) else{return};
    if stage==1{
        // Non-destructive DirectComposition repaint FIRST. This preserves the
        // user's DOM, drafts, scroll position, audio, profile and cookies.
        super::native_surface::force_compositor_rebind(&view);
        super::white_smoke_stage("compositor-rebound");
        super::render_health::record(&app,id,"visual-surface-rebound");
        schedule(&app,id,url,1800);
    }else if stage>=2{
        // A page with unsaved form input is not reconstructed. Keep checking
        // later: once its draft is saved/cleared, recovery can proceed.
        let task=app.clone();
        let expected=url.clone();
        let _=view.eval_with_callback(SAFE_TO_RESTART,move|reply|{
            if reply.trim()!="1"{
                super::white_smoke_stage("safe-restart-declined");
                return;
            }
            super::white_smoke_stage("safe-restart-accepted");
            let after=task.clone();
            let expected_url=expected.clone();
            let _=task.run_on_main_thread(move||{
                if match_active(&after,id,&expected_url).is_some(){
                    super::render_health::record(&after,id,"visual-white-confirmed");
                    if std::env::args().any(|arg|arg=="--minternet-white-surface-smoke"){
                        VISUAL_SMOKE_CONFIRMED.store(true,Ordering::Release);
                    }
                    // The existing bounded recovery registry avoids looping.
                    super::white_smoke_stage("visual-recovery-requested");
                    super::recover_stalled_site_if_url(&after,id,
                        &expected_url,"visual-white");
                }
            });
        });
    }
}
pub fn schedule(app:&tauri::AppHandle,id:u32,url:String,delay_ms:u64){
    if !super::is_real_page_url(&url){return;}
    super::white_smoke_stage("preview-scheduled");
    let task=app.clone();
    std::thread::spawn(move||{
        std::thread::sleep(Duration::from_millis(delay_ms));
        let worker=task.clone();
        let _=task.run_on_main_thread(move||{
            let Some(label)=match_active(&worker,id,&url) else{
                super::white_smoke_stage("preview-inactive");return;
            };
            let Some(token)=begin_capture(id) else{
                super::white_smoke_stage("preview-pending");return;
            };
            let Some(view)=worker.get_webview(&label) else{
                super::white_smoke_stage("preview-no-view");
                clear_pending(id,token);return;
            };
            let expected=url.clone();
            let app=worker.clone();
            let result=view.with_webview(move|native|{
                let Ok(core)=(unsafe{native.controller().CoreWebView2()})else{
                    super::white_smoke_stage("preview-no-core");
                    clear_pending(id,token);return
                };
                let Ok(stream)=(unsafe{CreateStreamOnHGlobal(HGLOBAL::default(),true)})else{
                    super::white_smoke_stage("preview-no-stream");
                    clear_pending(id,token);return
                };
                let callback_stream=stream.clone();
                let callback=CapturePreviewCompletedHandler::create(Box::new(move|status|{
                    let pixels=if status.is_ok(){
                        read_preview(&callback_stream)
                    }else{
                        super::white_smoke_stage("preview-callback-error");
                        None
                    };
                    // An expired callback from a previously destroyed
                    // controller must never act on a newer tab generation.
                    if !clear_pending(id,token){return Ok(());}
                    if let Some(pixels)=pixels{
                        super::white_smoke_stage("preview-png-received");
                        let completed=app.clone();
                        let uri=expected.clone();
                        std::thread::spawn(move||{
                            let white=fully_white(&pixels);
                            let on_main=completed.clone();
                            let _=completed.run_on_main_thread(move||
                                handle_visual_result(on_main,id,uri,white));
                        });
                    }else{
                        super::white_smoke_stage("preview-no-png");
                    }
                    Ok(())
                }));
                if unsafe{core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,&callback)}.is_err(){
                    super::white_smoke_stage("preview-capture-error");
                    clear_pending(id,token);
                }
            });
            if result.is_err(){
                super::white_smoke_stage("preview-capture-error");
                clear_pending(id,token);
            }
        });
    });
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test] fn invalid_png_is_not_a_white_page(){
        assert!(!fully_white(&[]));
        assert!(!fully_white(b"not an image"));
    }
    fn sample_png(with_mark:bool)->Vec<u8>{
        let (width,height)=(300usize,220usize);
        let mut source=vec![255u8;width*height*3];
        if with_mark{
            for y in 30..100{
                for x in 50..200{
                    let i=(y*width+x)*3;
                    source[i]=15;source[i+1]=15;source[i+2]=15;
                }
            }
        }
        let mut output=Vec::new();
        {
            let mut encoder=png::Encoder::new(&mut output,width as u32,height as u32);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer=encoder.write_header().unwrap();
            writer.write_image_data(&source).unwrap();
        }
        output
    }
    #[test]fn captured_compositor_pixels_classify_white_not_ordinary_pages(){
        assert!(fully_white(&sample_png(false)));
        assert!(!fully_white(&sample_png(true)));
    }
    #[test] fn white_screenshot_allows_windows_scrollbar_but_not_page_text(){
        assert!(fully_white(&sample_png(false)));
        assert!(!fully_white(&sample_png(true)));
        // The natural white mask can leave a narrow dark native scrollbar.
        let (width,height)=(600usize,400usize);
        let mut source=vec![255u8;width*height*3];
        for y in 0..height{
            for x in (width-10)..width{
                let i=(y*width+x)*3;
                source[i]=70;source[i+1]=70;source[i+2]=70;
            }
        }
        let mut output=Vec::new();
        {
            let mut encoder=png::Encoder::new(&mut output,width as u32,height as u32);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer=encoder.write_header().unwrap();
            writer.write_image_data(&source).unwrap();
        }
        assert!(fully_white(&output));
    }
    #[test] fn repeated_white_frames_required_for_destructive_recovery(){
        let id=std::process::id();
        assert_eq!(white_seen(id,"https://a.example/",true),1);
        assert_eq!(white_seen(id,"https://a.example/",false),0);
        assert_eq!(white_seen(id,"https://a.example/",true),1);
        assert_eq!(white_seen(id,"https://a.example/",true),2);
        assert_eq!(white_seen(id,"https://b.example/",true),1);
    }
}
