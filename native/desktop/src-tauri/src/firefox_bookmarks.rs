//! Explicit-drop-only Firefox folder import.
//! The app does NOT scan or sync Firefox bookmarks in the background. A
//! Firefox Places drag supplies a GUID/ID identifying one folder. We read
//! just that folder's descendants from local, read-only places.sqlite.
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, path::PathBuf};

const MAX_ROWS: usize = 2000;
const MAX_DEPTH: i64 = 11;

fn profile_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(target_os = "windows")]
    if let Some(base) = std::env::var_os("APPDATA") {
        out.push(PathBuf::from(base).join("Mozilla").join("Firefox").join("Profiles"));
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        out.push(PathBuf::from(home).join("Library/Application Support/Firefox/Profiles"));
    }
    #[cfg(target_os = "linux")]
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        out.push(home.join(".mozilla/firefox"));
        out.push(home.join(".var/app/org.mozilla.firefox/.mozilla/firefox"));
        out.push(home.join("snap/firefox/common/.mozilla/firefox"));
    }
    out
}

fn profile_databases() -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for root in profile_roots() {
        if let Ok(children) = std::fs::read_dir(root) {
            for child in children.filter_map(Result::ok).take(100) {
                let path = child.path().join("places.sqlite");
                if path.is_file() {
                    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
                    if seen.insert(canonical.clone()) { found.push(canonical); }
                }
            }
        }
    }
    found
}

#[derive(Clone)]
struct BookmarkRow {
    id: i64,
    parent: i64,
    kind: i64,
    title: String,
    url: Option<String>,
    depth: i64,
}

fn safe_web_url(value: &str) -> bool {
    // Other protocols, Firefox "place:" queries, credential-bearing URLs,
    // and nonweb bookmarks are not navigable Minternet bookmarks.
    if value.len() > 4096 { return false; }
    let Ok(url) = tauri::Url::parse(value) else { return false };
    matches!(url.scheme(), "https" | "http")
        && url.host_str().is_some() && url.username().is_empty()
        && url.password().is_none()
}

fn read_subtree(connection: &Connection, folder_id: i64) -> Result<Value, String> {
    let mut stmt = connection.prepare(
        "WITH RECURSIVE descendants (id,parent,type,title,fk,depth,sortpath) AS (
           SELECT id,parent,type,title,fk,0,printf('%08d',position)
           FROM moz_bookmarks WHERE id=?1 AND type=2
           UNION ALL
           SELECT child.id,child.parent,child.type,child.title,child.fk,
                  parent.depth+1,
                  parent.sortpath || '/' || printf('%08d',child.position)
           FROM moz_bookmarks child
           JOIN descendants parent ON child.parent=parent.id
           WHERE parent.depth < ?2
         )
         SELECT d.id,d.parent,d.type,coalesce(d.title,''),p.url,d.depth
         FROM descendants d LEFT JOIN moz_places p ON d.fk=p.id
         ORDER BY d.sortpath,d.id LIMIT ?3")
        .map_err(|e|format!("Cannot read Firefox folder: {e}"))?;
    let records = stmt.query_map(params![folder_id, MAX_DEPTH, (MAX_ROWS+1) as i64], |r| {
        Ok(BookmarkRow {
            id: r.get(0)?, parent: r.get(1)?, kind: r.get(2)?,
            title: r.get(3)?, url: r.get(4)?, depth: r.get(5)?,
        })
    }).map_err(|e|e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    if records.is_empty() { return Err("Firefox folder not found".into()); }
    if records.len() > MAX_ROWS {
        return Err("The dragged folder exceeds Minternet's 2,000-item bookmark limit".into());
    }
    // Do not silently truncate deeply nested folders.
    for item in records.iter().filter(|r|r.depth == MAX_DEPTH && r.kind == 2) {
        let has_children: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM moz_bookmarks WHERE parent=?1)",
            params![item.id], |row|row.get(0),
        ).map_err(|e|e.to_string())?;
        if has_children {
            return Err("Folder nesting is deeper than Minternet can currently import".into());
        }
    }
    let mut descendants: HashMap<i64,Vec<Value>> = HashMap::new();
    let mut root = None;
    // Reverse pre-order makes descendants available when their parent is built.
    for item in records.into_iter().rev() {
        let node = match item.kind {
            2 => Some(json!({
                "kind": "folder", "name": item.title,
                "icon": "", "children": descendants.remove(&item.id).unwrap_or_default()
            })),
            1 => item.url.as_deref().filter(|url|safe_web_url(url)).map(|url|json!({
                "kind":"link","name":if item.title.is_empty(){url}else{&item.title},
                "url":url,"icon":""
            })),
            _ => None,
        };
        if let Some(node) = node {
            if item.id == folder_id { root=Some(node); }
            else { descendants.entry(item.parent).or_default().insert(0,node); }
        }
    }
    root.ok_or_else(||"Firefox bookmark folder could not be reconstructed".into())
}

/// Look up one locally dragged Firefox bookmark folder. No arbitrary path is
/// accepted from JavaScript, and SQLite is opened read-only.
pub fn resolve_folder(guid: &str, id: Option<i64>, title: &str) -> Result<Value,String> {
    let valid_guid = guid.len()==12 &&
        guid.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b'-');
    if !valid_guid && !id.is_some_and(|id|id>0) {
        return Err("Firefox bookmark-folder identity is missing".into());
    }
    if title.len() > 100 { return Err("Firefox folder title is too long".into()); }
    let profiles=profile_databases();
    if profiles.is_empty() {
        return Err("Firefox's local bookmark profiles were not found. Export the folder as bookmarks HTML and drop that file instead.".into());
    }
    let mut candidates = Vec::new();
    for path in profiles {
        let Ok(conn)=Connection::open_with_flags(
            &path,OpenFlags::SQLITE_OPEN_READ_ONLY|OpenFlags::SQLITE_OPEN_NO_MUTEX
        ) else {continue};
        let found: Option<(i64,String)> = if valid_guid {
            conn.query_row(
                "SELECT id,coalesce(title,'') FROM moz_bookmarks WHERE type=2 AND guid=?1",
                params![guid],|row|Ok((row.get(0)?,row.get(1)?))
            ).optional().ok().flatten()
        } else {
            conn.query_row(
                "SELECT id,coalesce(title,'') FROM moz_bookmarks WHERE type=2 AND id=?1",
                params![id],|row|Ok((row.get(0)?,row.get(1)?))
            ).optional().ok().flatten()
        };
        if let Some((node_id,actual_title))=found {
            // Check the visible title too, especially when the drag lacks a
            // GUID. Never silently select an unrelated profile's folder.
            if title.is_empty() || actual_title.trim()==title.trim() {
                candidates.push((path,node_id));
            }
        }
    }
    match candidates.len() {
        0 => Err("That Firefox folder is not available in the local bookmark database. Drag a bookmarks HTML export to import it.".into()),
        1 => {
            let (path,id)=candidates.remove(0);
            let conn=Connection::open_with_flags(
                path,OpenFlags::SQLITE_OPEN_READ_ONLY|OpenFlags::SQLITE_OPEN_NO_MUTEX
            ).map_err(|_|"Cannot open Firefox bookmark folder".to_string())?;
            read_subtree(&conn,id)
        },
        _ => Err("The folder exists in multiple Firefox profiles; select a single Firefox profile or import its bookmarks HTML export.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_folder_order_is_preserved_and_unsafe_links_excluded() {
        let conn=Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY,parent INTEGER,type INTEGER,
              title TEXT,fk INTEGER,position INTEGER,guid TEXT);
             CREATE TABLE moz_places (id INTEGER PRIMARY KEY,url TEXT);
             INSERT INTO moz_bookmarks VALUES(1,0,2,'Outer',NULL,0,'123456789012');
             INSERT INTO moz_bookmarks VALUES(2,1,2,'Inside',NULL,0,'abcdefghijkl');
             INSERT INTO moz_bookmarks VALUES(3,2,1,'Good',10,0,'000000000003');
             INSERT INTO moz_bookmarks VALUES(4,1,1,'Next',11,1,'000000000004');
             INSERT INTO moz_bookmarks VALUES(5,1,1,'Unsafe',12,2,'000000000005');
             INSERT INTO moz_places VALUES(10,'https://example.org/');
             INSERT INTO moz_places VALUES(11,'http://example.com/');
             INSERT INTO moz_places VALUES(12,'javascript:alert(1)');"
        ).unwrap();
        let tree=read_subtree(&conn,1).unwrap();
        assert_eq!(tree["name"],"Outer");
        assert_eq!(tree["children"][0]["name"],"Inside");
        assert_eq!(tree["children"][0]["children"][0]["name"],"Good");
        assert_eq!(tree["children"][1]["name"],"Next");
        assert_eq!(tree["children"].as_array().unwrap().len(),2);
    }
}
