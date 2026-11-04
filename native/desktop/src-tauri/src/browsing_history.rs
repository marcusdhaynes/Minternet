use std::{fs,path::PathBuf,time::{SystemTime,UNIX_EPOCH}};
use serde::{Serialize,Deserialize};
use tauri::Manager;
const MAX_ITEMS:usize=5000;
const MAX_FILE_SIZE:usize=2_500_000;
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Entry {
    pub url:String,
    pub title:String,
    pub last_visit:u64,
    pub visits:u32,
}
#[derive(Default)]
pub struct History {
    pub items:Vec<Entry>,
}
pub fn file(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(app.path().app_data_dir().map_err(|e|e.to_string())?.join("browsing-history.v1.json"))
}
fn safe(url:&str)->bool{
    if url.len()>4096 {return false;}
    let Ok(url)=tauri::Url::parse(url) else{return false};
    url.scheme()=="https"&&url.host_str().is_some()&&url.username().is_empty()&&url.password().is_none()
}
impl History {
    pub fn load(app:&tauri::AppHandle)->Self{
        let Ok(path)=file(app) else{return Self::default()};
        let Ok(data)=fs::read(path) else{return Self::default()};
        if data.len()>MAX_FILE_SIZE{return Self::default();}
        let Ok(items)=serde_json::from_slice::<Vec<Entry>>(&data) else{return Self::default()};
        Self{items:items.into_iter().filter(|e|safe(&e.url)&&e.title.len()<=240)
            .take(MAX_ITEMS).collect()}
    }
    pub fn save(&self,app:&tauri::AppHandle)->Result<(),String>{
        let path=file(app)?;
        let bytes=serde_json::to_vec(&self.items).map_err(|e|e.to_string())?;
        if bytes.len()>MAX_FILE_SIZE{return Err("History exceeds safe size limit".into());}
        if let Some(parent)=path.parent(){fs::create_dir_all(parent).map_err(|e|e.to_string())?;}
        let temp=path.with_extension("tmp");
        fs::write(&temp,bytes).map_err(|e|e.to_string())?;
        if fs::rename(&temp,&path).is_err(){fs::copy(&temp,&path).map_err(|e|e.to_string())?;let _=fs::remove_file(&temp);}
        Ok(())
    }
    pub fn visit(&mut self,url:&str,title:&str)->bool{
        if !safe(url){return false;}
        let now=SystemTime::now().duration_since(UNIX_EPOCH).map(|x|x.as_secs()).unwrap_or(0);
        let index=self.items.iter().position(|e|e.url==url);
        if let Some(i)=index {
            let mut entry=self.items.remove(i);
            // Skip duplicate navigation events for the same page within a second.
            if now.saturating_sub(entry.last_visit)>1 {entry.visits=entry.visits.saturating_add(1);}
            entry.last_visit=now;
            if title!="" {entry.title=title.chars().take(180).collect();}
            self.items.insert(0,entry);
        }else{
            self.items.insert(0,Entry{
                url:url.to_string(),title:title.chars().take(180).collect(),
                last_visit:now,visits:1
            });
            if self.items.len()>MAX_ITEMS {self.items.truncate(MAX_ITEMS);}
        }
        true
    }
    pub fn retitle(&mut self,url:&str,title:&str)->bool {
        if title.trim().is_empty(){return false;}
        if let Some(entry)=self.items.iter_mut().find(|e|e.url==url){
            let clean=title.chars().take(180).collect::<String>();
            if entry.title!=clean{entry.title=clean;return true;}
        }
        false
    }
    pub fn search(&self,needle:&str,limit:usize)->Vec<Entry>{
        self.search_page(needle,0,limit)
    }
    pub fn search_page(&self,needle:&str,offset:usize,limit:usize)->Vec<Entry>{
        let q=needle.trim().to_lowercase();
        self.items.iter().filter(|e|q.is_empty()||
            e.url.to_lowercase().contains(&q)||e.title.to_lowercase().contains(&q))
            .skip(offset.min(MAX_ITEMS)).take(limit.min(100)).cloned().collect()
    }
    pub fn remove(&mut self,url:&str)->bool{
        let before=self.items.len();
        self.items.retain(|e|e.url!=url);
        self.items.len()!=before
    }
    pub fn clear(&mut self)->bool {
        if self.items.is_empty(){return false;}
        self.items.clear();true
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn history_is_recent_first_and_deduped(){
        let mut history=History::default();
        assert!(history.visit("https://example.com/a","First"));
        assert!(history.visit("https://example.com/b","Second"));
        assert!(history.visit("https://example.com/a","First again"));
        assert_eq!(history.items.len(),2);
        assert_eq!(history.search("first",5)[0].url,"https://example.com/a");
        assert_eq!(history.search_page("",1,1)[0].url,"https://example.com/b");
        assert!(history.remove("https://example.com/a"));
        assert_eq!(history.items.len(),1);
    }
    #[test]
    fn unsafe_websites_cannot_be_in_history(){
        let mut h=History::default();
        for url in ["javascript:alert(1)","file:///c:/secret","http://example.com",
                    "https://user:pass@example.com"]{
            assert!(!h.visit(url,"No"));
        }
        assert!(h.items.is_empty());
    }
}
