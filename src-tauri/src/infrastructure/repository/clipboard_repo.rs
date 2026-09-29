use crate::database::{
    calc_image_hash, calc_text_hash, has_sensitive_tag, is_text_type, save_image_to_file,
    ENCRYPT_PREFIX,
};
use crate::domain::models::ClipboardEntry;
use crate::infrastructure::encryption;
use crate::infrastructure::repository::settings_repo::SqliteSettingsRepository;
use rusqlite::params;
use rusqlite::Connection;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use urlencoding::decode;

const RICH_IMAGE_FALLBACK_PREFIX: &str = "<!--TIEZ_RICH_IMAGE:";
const RICH_IMAGE_FALLBACK_SUFFIX: &str = "-->";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn is_syncable_content_type(content_type: &str) -> bool {
    matches!(
        content_type,
        "text" | "code" | "url" | "rich_text" | "image" | "file" | "video" | "emoji_sync"
    )
}

fn sensitive_tags_sql_clause() -> String {
    let parts: Vec<String> = crate::database::SENSITIVE_TAGS
        .iter()
        .map(|t| format!("'{}'", t.replace('\'', "''")))
        .collect();
    format!("({})", parts.join(","))
}

pub trait ClipboardRepository {
    fn save(
        &self,
        entry: &ClipboardEntry,
        data_dir: Option<&std::path::Path>,
    ) -> Result<i64, String>;
    fn get_history(
        &self,
        limit: i32,
        offset: i32,
        content_type: Option<&str>,
    ) -> Result<Vec<ClipboardEntry>, String>;
    fn search(&self, query: &str, limit: i32, tag_only: bool) -> Result<Vec<ClipboardEntry>, String>;
    fn delete(&self, id: i64, data_dir: Option<&std::path::Path>) -> Result<(), String>;
    fn clear(&self, data_dir: Option<&std::path::Path>) -> Result<(), String>;
    // Recycle bin (soft delete)
    fn soft_delete(&self, id: i64, deleted_at: i64) -> Result<(), String>;
    fn restore(&self, id: i64) -> Result<(), String>;
    fn permanent_delete(&self, id: i64, data_dir: Option<&std::path::Path>) -> Result<(), String>;
    fn get_recycle_bin_items(&self, limit: i32, offset: i32) -> Result<Vec<ClipboardEntry>, String>;
    fn cleanup_expired(&self, retention_ms: i64) -> Result<i64, String>;
    fn empty_recycle_bin(&self, data_dir: Option<&std::path::Path>) -> Result<i64, String>;
    fn get_recycle_bin_count(&self) -> Result<i64, String>;
    fn get_count(&self) -> Result<i64, String>;
    fn increment_use_count(&self, id: i64) -> Result<(), String>;
    fn touch_entry(&self, id: i64, timestamp: i64) -> Result<(), String>;
    fn toggle_pin(&self, id: i64, is_pinned: bool) -> Result<(), String>;
    fn update_pinned_order(&self, orders: Vec<(i64, i64)>) -> Result<(), String>;
    fn get_entry_by_id(&self, id: i64) -> Result<Option<ClipboardEntry>, String>;
    fn get_entry_by_content(
        &self,
        content: &str,
        content_type: Option<&str>,
    ) -> Result<Option<i64>, String>;
    fn update_entry_content(&self, id: i64, content: &str, preview: &str) -> Result<(), String>;
    fn get_entry_content(&self, id: i64) -> Result<Option<String>, String>;
    fn get_entry_content_full(&self, id: i64) -> Result<Option<(String, String)>, String>;
    fn get_entry_content_with_html(
        &self,
        id: i64,
    ) -> Result<Option<(String, String, Option<String>)>, String>;
}

pub struct SqliteClipboardRepository {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteClipboardRepository {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    pub fn encrypt_entry_with_conn(&self, conn: &Connection, id: i64) -> Result<(), String> {
        let (content_raw, preview_raw, html_raw, content_type, content_hash): (String, String, Option<String>, String, i64) =
            conn.query_row(
                "SELECT content, preview, html_content, content_type, content_hash FROM clipboard_history WHERE id = ?",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2).ok(), row.get(3)?, row.get(4)?)),
            ).map_err(|e| e.to_string())?;

        let already_encrypted = content_raw.starts_with(ENCRYPT_PREFIX)
            && preview_raw.starts_with(ENCRYPT_PREFIX)
            && html_raw
                .as_ref()
                .map(|h| h.starts_with(ENCRYPT_PREFIX))
                .unwrap_or(true);
        if already_encrypted {
            return Ok(());
        }

        let content_plain = self.maybe_decrypt_text(&content_raw);
        let preview_plain = self.maybe_decrypt_text(&preview_raw);
        let html_plain = html_raw.map(|h| self.maybe_decrypt_text(&h));

        let content_enc = self.maybe_encrypt_text(&content_plain);
        let preview_enc = self.maybe_encrypt_text(&preview_plain);
        let html_enc = html_plain.as_ref().map(|h| self.maybe_encrypt_text(h));
        let new_hash = if is_text_type(&content_type) {
            calc_text_hash(&content_plain) as i64
        } else {
            content_hash
        };

        conn.execute(
            "UPDATE clipboard_history SET content = ?, preview = ?, html_content = ?, content_hash = ? WHERE id = ?",
            params![content_enc, preview_enc, html_enc, new_hash, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn decrypt_entry_with_conn(&self, conn: &Connection, id: i64) -> Result<(), String> {
        let (content_raw, preview_raw, html_raw, content_type, content_hash): (String, String, Option<String>, String, i64) =
            conn.query_row(
                "SELECT content, preview, html_content, content_type, content_hash FROM clipboard_history WHERE id = ?",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2).ok(), row.get(3)?, row.get(4)?)),
            ).map_err(|e| e.to_string())?;

        let any_encrypted = content_raw.starts_with(ENCRYPT_PREFIX)
            || preview_raw.starts_with(ENCRYPT_PREFIX)
            || html_raw
                .as_ref()
                .map(|h| h.starts_with(ENCRYPT_PREFIX))
                .unwrap_or(false);
        if !any_encrypted {
            return Ok(());
        }

        let content_plain = self.maybe_decrypt_text(&content_raw);
        let preview_plain = self.maybe_decrypt_text(&preview_raw);
        let html_plain = html_raw.map(|h| self.maybe_decrypt_text(&h));
        let new_hash = if is_text_type(&content_type) {
            calc_text_hash(&content_plain) as i64
        } else {
            content_hash
        };

        conn.execute(
            "UPDATE clipboard_history SET content = ?, preview = ?, html_content = ?, content_hash = ? WHERE id = ?",
            params![content_plain, preview_plain, html_plain, new_hash, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn sync_entry_tags_with_conn(
        &self,
        conn: &Connection,
        entry_id: i64,
        tags: &[String],
    ) -> Result<(), String> {
        conn.execute(
            "DELETE FROM entry_tags WHERE entry_id = ?",
            params![entry_id],
        )
        .map_err(|e| e.to_string())?;
        for tag in tags {
            let clean = tag.trim();
            if clean.is_empty() {
                continue;
            }
            conn.execute(
                "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?1, ?2)",
                params![entry_id, clean],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn upsert_tombstone_with_conn(
        &self,
        conn: &Connection,
        content_type: &str,
        content_hash: i64,
        deleted_at: i64,
    ) -> Result<(), String> {
        if !is_syncable_content_type(content_type) || content_hash == 0 {
            return Ok(());
        }

        conn.execute(
            "INSERT INTO cloud_sync_tombstones (content_type, content_hash, deleted_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(content_type, content_hash)
             DO UPDATE SET deleted_at = MAX(cloud_sync_tombstones.deleted_at, excluded.deleted_at)",
            params![content_type, content_hash, deleted_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn clear_tombstone_with_conn(
        &self,
        conn: &Connection,
        content_type: &str,
        content_hash: i64,
    ) -> Result<(), String> {
        if !is_syncable_content_type(content_type) || content_hash == 0 {
            return Ok(());
        }

        conn.execute(
            "DELETE FROM cloud_sync_tombstones WHERE content_type = ?1 AND content_hash = ?2",
            params![content_type, content_hash],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn maybe_encrypt_text(&self, value: &str) -> String {
        #[cfg(not(feature = "portable"))]
        {
            if value.starts_with(ENCRYPT_PREFIX) {
                return value.to_string();
            }
            encryption::encrypt_value(value).unwrap_or_else(|| value.to_string())
        }
        #[cfg(feature = "portable")]
        {
            value.to_string()
        }
    }

    fn maybe_decrypt_text(&self, value: &str) -> String {
        if value.starts_with(ENCRYPT_PREFIX) {
            encryption::decrypt_value(value).unwrap_or_else(|| value.to_string())
        } else {
            value.to_string()
        }
    }

    fn extract_rich_image_fallback_payload(html: &str) -> Option<String> {
        if let Some(start) = html.rfind(RICH_IMAGE_FALLBACK_PREFIX) {
            let marker_start = start + RICH_IMAGE_FALLBACK_PREFIX.len();
            if let Some(end_rel) = html[marker_start..].find(RICH_IMAGE_FALLBACK_SUFFIX) {
                let marker_end = marker_start + end_rel;
                let payload = html[marker_start..marker_end].trim();
                if !payload.is_empty() {
                    return Some(payload.to_string());
                }
            }
        }
        None
    }

    fn fallback_payload_to_path(payload: &str) -> Option<PathBuf> {
        let value = payload.trim();
        if value.is_empty() || value.starts_with("data:image/") {
            return None;
        }

        let path_raw = if value.starts_with("file://") {
            value.trim_start_matches("file://")
        } else {
            value
        };

        let path_without_drive_prefix =
            if path_raw.starts_with('/') && path_raw.chars().nth(2) == Some(':') {
                &path_raw[1..]
            } else {
                path_raw
            };

        let decoded_path = decode(path_without_drive_prefix)
            .map(|p| p.into_owned())
            .unwrap_or_else(|_| path_without_drive_prefix.to_string());

        if decoded_path.is_empty() {
            None
        } else {
            Some(PathBuf::from(decoded_path))
        }
    }

    fn collect_attachment_paths_for_cleanup(
        &self,
        content_raw: &str,
        html_raw: Option<&str>,
        is_external: bool,
        attachments_dir: &std::path::Path,
    ) -> Vec<PathBuf> {
        let mut paths = HashSet::new();

        if is_external {
            let content_path = PathBuf::from(self.maybe_decrypt_text(content_raw));
            if content_path.starts_with(attachments_dir) {
                paths.insert(content_path);
            }
        }

        if let Some(html_raw_value) = html_raw {
            let html = self.maybe_decrypt_text(html_raw_value);
            if let Some(payload) = Self::extract_rich_image_fallback_payload(&html) {
                if let Some(path) = Self::fallback_payload_to_path(&payload) {
                    if path.starts_with(attachments_dir) {
                        paths.insert(path);
                    }
                }
            }
        }

        paths.into_iter().collect()
    }

    pub fn save_with_conn(
        &self,
        conn: &Connection,
        entry: &ClipboardEntry,
        data_dir: Option<&std::path::Path>,
    ) -> Result<i64, String> {
        // Encrypt only when explicitly marked as sensitive
        let should_encrypt = has_sensitive_tag(&entry.tags);

        let mut final_content = entry.content.clone();
        let mut final_is_external = entry.is_external;

        // Externalize image if possible
        if entry.content_type == "image" && entry.content.starts_with("data:image/") {
            if let Some(dir) = data_dir {
                if let Some(path) = save_image_to_file(&entry.content, dir) {
                    final_content = path;
                    final_is_external = true;
                }
            }
        }

        let calculated_hash = if entry.content_type == "image" {
            if entry.content.starts_with("data:") {
                calc_image_hash(&entry.content).unwrap_or(0)
            } else {
                if let Ok(img) = image::open(&entry.content) {
                    let thumb = img.resize_exact(32, 32, image::imageops::FilterType::Nearest);
                    use std::collections::hash_map::DefaultHasher;
                    use std::hash::{Hash, Hasher};
                    let mut hasher = DefaultHasher::new();
                    thumb.as_bytes().hash(&mut hasher);
                    hasher.finish() as i64
                } else {
                    0
                }
            }
        } else {
            calc_text_hash(&final_content) as i64
        };

        // Re-adding an item should clear an older delete tombstone for the same fingerprint.
        let _ = self.clear_tombstone_with_conn(conn, &entry.content_type, calculated_hash);

        let (content, preview, content_hash, html_content) = if should_encrypt {
            let encrypted_content = self.maybe_encrypt_text(&final_content);
            let encrypted_preview = self.maybe_encrypt_text(&entry.preview);
            let encrypted_html = entry
                .html_content
                .as_ref()
                .map(|html| self.maybe_encrypt_text(html));
            (
                encrypted_content,
                encrypted_preview,
                calculated_hash,
                encrypted_html,
            )
        } else {
            (
                final_content,
                entry.preview.clone(),
                calculated_hash,
                entry.html_content.clone(),
            )
        };

        let mut seen: HashSet<String> = HashSet::new();
        let mut cleaned_tags: Vec<String> = Vec::new();
        for tag in &entry.tags {
            let t = tag.trim();
            if t.is_empty() {
                continue;
            }
            let t_owned = t.to_string();
            if seen.insert(t_owned.clone()) {
                cleaned_tags.push(t_owned);
            }
        }

        if entry.id > 0 {
            // Update existing entry (Move to top logic)
            conn.execute(
                "UPDATE clipboard_history SET 
                    content_type = ?1, 
                    content = ?2, 
                    html_content = ?3, 
                    source_app = ?4, 
                    timestamp = ?5, 
                    preview = ?6, 
                    content_hash = ?7, 
                    tags = ?8, 
                    is_external = ?9,
                    source_app_path = ?10,
                    use_count = use_count + 1
                 WHERE id = ?11",
                params![
                    entry.content_type,
                    content,
                    html_content,
                    entry.source_app,
                    entry.timestamp,
                    preview,
                    content_hash,
                    serde_json::to_string(&cleaned_tags).unwrap_or_else(|_| "[]".to_string()),
                    if final_is_external { 1 } else { 0 },
                    entry.source_app_path.as_deref(),
                    entry.id
                ],
            )
            .map_err(|e| e.to_string())?;
            self.sync_entry_tags_with_conn(conn, entry.id, &cleaned_tags)?;
            Ok(entry.id)
        } else {
            // Insert new entry
            conn.execute(
                "INSERT INTO clipboard_history (content_type, content, html_content, source_app, timestamp, preview, is_pinned, content_hash, tags, is_external, pinned_order, source_app_path) 
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    entry.content_type,
                    content,
                    html_content,
                    entry.source_app,
                    entry.timestamp,
                    preview,
                    if entry.is_pinned { 1 } else { 0 },
                    content_hash,
                    serde_json::to_string(&cleaned_tags).unwrap_or_else(|_| "[]".to_string()),
                    if final_is_external { 1 } else { 0 },
                    entry.pinned_order,
                    entry.source_app_path.as_deref()
                ],
            ).map_err(|e| e.to_string())?;

            let new_id = conn.last_insert_rowid();
            self.sync_entry_tags_with_conn(conn, new_id, &cleaned_tags)?;
            Ok(new_id)
        }
    }

    pub fn delete_with_conn(
        &self,
        conn: &Connection,
        id: i64,
        data_dir: Option<&std::path::Path>,
    ) -> Result<(), String> {
        let mut tombstone: Option<(String, i64)> = None;
        // Check for external files to delete
        if let Some(dir) = data_dir {
            let attachments_dir = dir.join("attachments");
            let mut stmt = conn
                 .prepare("SELECT content, html_content, is_external, content_type, content_hash FROM clipboard_history WHERE id = ?")
                 .map_err(|e| e.to_string())?;

            if let Ok(entry) = stmt.query_row([id], |row| {
                let content_raw: String = row.get(0)?;
                let html_raw: Option<String> = row.get(1).ok();
                let is_ext: i32 = row.get(2)?;
                let content_type: String = row.get(3)?;
                let content_hash: i64 = row.get(4)?;
                Ok((
                    content_raw,
                    html_raw,
                    is_ext == 1,
                    content_type,
                    content_hash,
                ))
            }) {
                let files_to_remove = self.collect_attachment_paths_for_cleanup(
                    &entry.0,
                    entry.1.as_deref(),
                    entry.2,
                    &attachments_dir,
                );
                for path in files_to_remove {
                    if path.exists() {
                        let _ = std::fs::remove_file(path);
                    }
                }
                tombstone = Some((entry.3, entry.4));
            }
        } else {
            let mut stmt = conn
                .prepare("SELECT content_type, content_hash FROM clipboard_history WHERE id = ?")
                .map_err(|e| e.to_string())?;
            if let Ok(entry) = stmt.query_row([id], |row| {
                let content_type: String = row.get(0)?;
                let content_hash: i64 = row.get(1)?;
                Ok((content_type, content_hash))
            }) {
                tombstone = Some(entry);
            }
        }

        if let Some((content_type, content_hash)) = tombstone {
            let _ = self.upsert_tombstone_with_conn(conn, &content_type, content_hash, now_ms());
        }

        conn.execute("DELETE FROM clipboard_history WHERE id = ?", [id])
            .map_err(|e| e.to_string())?;
        let _ = conn.execute("DELETE FROM entry_tags WHERE entry_id = ?", params![id]);
        Ok(())
    }

    pub fn delete_metadata_with_conn(&self, conn: &Connection, id: i64) -> Result<(), String> {
        conn.execute("DELETE FROM clipboard_history WHERE id = ?", params![id])
            .map_err(|e| e.to_string())?;
        let _ = conn.execute("DELETE FROM entry_tags WHERE entry_id = ?", params![id]);
        Ok(())
    }

    pub fn find_by_content_with_conn(
        &self,
        conn: &Connection,
        content: &str,
        content_type: Option<&str>,
    ) -> Result<Option<i64>, String> {
        if content_type == Some("image") {
            if let Some(hash) = calc_image_hash(content) {
                let mut stmt = conn
                    .prepare(
                        "SELECT id FROM clipboard_history \
                     WHERE (content_type = 'image' AND content_hash = ?) OR content = ?",
                    )
                    .map_err(|e| e.to_string())?;
                let mut rows = stmt
                    .query(params![hash, content])
                    .map_err(|e| e.to_string())?;
                if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    return Ok(Some(row.get(0).map_err(|e| e.to_string())?));
                }
                return Ok(None);
            }
        }

        let hash = calc_text_hash(content) as i64;

        if let Some(ct) = content_type {
            let mut stmt = conn.prepare(
                "SELECT id FROM clipboard_history \
                 WHERE (content_type = ? AND content_hash = ?) OR (content_type = ? AND content = ?)",
            ).map_err(|e| e.to_string())?;
            let mut rows = stmt
                .query(params![ct, hash, ct, content])
                .map_err(|e| e.to_string())?;
            if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                Ok(Some(row.get(0).map_err(|e| e.to_string())?))
            } else {
                Ok(None)
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id FROM clipboard_history \
                 WHERE ((content_type IN ('text', 'rich_text', 'code', 'url')) AND content_hash = ?) OR content = ?",
            ).map_err(|e| e.to_string())?;
            let mut rows = stmt
                .query(params![hash, content])
                .map_err(|e| e.to_string())?;
            if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                Ok(Some(row.get(0).map_err(|e| e.to_string())?))
            } else {
                Ok(None)
            }
        }
    }

    pub fn enforce_limit_with_conn(
        &self,
        conn: &Connection,
        data_dir: Option<&std::path::Path>,
    ) -> Result<Vec<i64>, String> {
        // Check if storage limit is enabled
        if let Ok(Some(limit_enabled_str)) =
            SqliteSettingsRepository::get_raw(conn, "app.persistent_limit_enabled")
        {
            if limit_enabled_str == "false" {
                return Ok(Vec::new());
            }
        }

        // Get the storage limit
        if let Ok(Some(limit_str)) = SqliteSettingsRepository::get_raw(conn, "app.persistent_limit")
        {
            if let Ok(limit) = limit_str.parse::<i32>() {
                // Count non-pinned entries
                let count: i32 = conn.query_row(
                    "SELECT COUNT(*) FROM clipboard_history WHERE is_pinned = 0 AND (tags = '[]' OR tags IS NULL)",
                    [],
                    |row| row.get(0)
                ).map_err(|e| e.to_string())?;

                if count > limit {
                    // First, get the IDs that will be deleted
                    let to_delete = count - limit;
                    let deleted_ids: Vec<i64> = {
                        let mut stmt = conn
                            .prepare(
                                "SELECT id FROM clipboard_history 
                             WHERE is_pinned = 0 AND (tags = '[]' OR tags IS NULL)
                             ORDER BY timestamp ASC 
                             LIMIT ?",
                            )
                            .map_err(|e| e.to_string())?;

                        let rows = stmt
                            .query_map([to_delete], |row| row.get(0))
                            .map_err(|e| e.to_string())?;
                        rows.filter_map(|r| r.ok()).collect()
                    };
                    // Actually delete records (and files if needed)
                    for id in &deleted_ids {
                        let _ = self.delete_with_conn(conn, *id, data_dir);
                    }
                    return Ok(deleted_ids);
                }
            }
        }

        Ok(Vec::new())
    }
    pub fn toggle_pin_with_conn(
        &self,
        conn: &Connection,
        id: i64,
        is_pinned: bool,
    ) -> Result<(), String> {
        if is_pinned {
            // Set pinned_order to max + 1 so it appears at top
            conn.execute(
                "UPDATE clipboard_history 
                 SET is_pinned = 1, 
                     pinned_order = (SELECT COALESCE(MAX(pinned_order), 0) + 1 FROM clipboard_history WHERE is_pinned = 1) 
                 WHERE id = ?",
                params![id],
            ).map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE clipboard_history SET is_pinned = 0, pinned_order = 0 WHERE id = ?",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn update_pinned_order_with_conn(
        &self,
        conn: &Connection,
        orders: Vec<(i64, i64)>,
    ) -> Result<(), String> {
        for (id, order) in orders {
            conn.execute(
                "UPDATE clipboard_history SET pinned_order = ? WHERE id = ?",
                params![order, id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn get_entry_by_id_with_conn(
        &self,
        conn: &Connection,
        id: i64,
    ) -> Result<Option<ClipboardEntry>, String> {
        let mut stmt = conn.prepare(
            "SELECT id, content_type, content, html_content, source_app, timestamp, preview, is_pinned, tags, use_count, is_external, pinned_order, source_app_path, deleted_at
             FROM clipboard_history
             WHERE id = ?
             LIMIT 1",
        ).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let tags_str: String = row.get(8).unwrap_or_else(|_| "[]".to_string());
            let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();

            let content_raw: String = row.get(2).map_err(|e| e.to_string())?;
            let html_raw: Option<String> = row.get(3).map_err(|e| e.to_string()).unwrap_or(None);
            let preview_raw: String = row.get(6).map_err(|e| e.to_string())?;
            let content = self.maybe_decrypt_text(&content_raw);
            let preview = self.maybe_decrypt_text(&preview_raw);
            let html_content = html_raw.map(|v| self.maybe_decrypt_text(&v));

            Ok(Some(ClipboardEntry {
                id: row.get(0).map_err(|e| e.to_string())?,
                content_type: row.get(1).map_err(|e| e.to_string())?,
                content,
                html_content,
                source_app: row.get(4).map_err(|e| e.to_string())?,
                timestamp: row.get(5).map_err(|e| e.to_string())?,
                preview,
                is_pinned: row.get::<_, i32>(7).map_err(|e| e.to_string())? == 1,
                tags,
                use_count: row.get(9).unwrap_or(0),
                is_external: row.get::<_, i32>(10).unwrap_or(0) == 1,
                pinned_order: row.get(11).unwrap_or(0),
                source_app_path: row.get(12).unwrap_or(None),
                deleted_at: row.get(13).unwrap_or(None),
                file_preview_exists: true,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn update_entry_content_with_conn(
        &self,
        conn: &Connection,
        id: i64,
        content: &str,
        preview: &str,
    ) -> Result<(), String> {
        let (old_content_raw, content_type, tags_json, has_html) = conn
            .query_row(
                "SELECT content, content_type, tags, (html_content IS NOT NULL) FROM clipboard_history WHERE id = ?",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, bool>(3)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;

        let old_content = self.maybe_decrypt_text(&old_content_raw);
        // Procceed if content changed, OR if content is same but we need to transition away from rich text/clear HTML
        if old_content == content && content_type != "rich_text" && !has_html {
            return Ok(());
        }

        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
        let should_encrypt = has_sensitive_tag(&tags);

        if is_text_type(&content_type) {
            let hash = calc_text_hash(content) as i64;
            let new_type = if content_type == "rich_text" {
                "text"
            } else {
                &content_type
            };
            if should_encrypt {
                let encrypted_content = self.maybe_encrypt_text(content);
                let encrypted_preview = self.maybe_encrypt_text(preview);
                conn.execute(
                    "UPDATE clipboard_history SET content = ?, preview = ?, content_hash = ?, html_content = NULL, content_type = ? WHERE id = ?",
                    params![encrypted_content, encrypted_preview, hash, new_type, id],
                ).map_err(|e| e.to_string())?;
            } else {
                conn.execute(
                    "UPDATE clipboard_history SET content = ?, preview = ?, content_hash = ?, html_content = NULL, content_type = ? WHERE id = ?",
                    params![content, preview, hash, new_type, id],
                ).map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        if should_encrypt {
            let encrypted_content = self.maybe_encrypt_text(content);
            let encrypted_preview = self.maybe_encrypt_text(preview);
            conn.execute(
                "UPDATE clipboard_history SET content = ?, preview = ?, html_content = NULL WHERE id = ?",
                params![encrypted_content, encrypted_preview, id],
            ).map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE clipboard_history SET content = ?, preview = ?, html_content = NULL WHERE id = ?",
                params![content, preview, id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn get_entry_content_full_with_conn(
        &self,
        conn: &Connection,
        id: i64,
    ) -> Result<Option<(String, String)>, String> {
        let mut stmt = conn
            .prepare("SELECT content, content_type FROM clipboard_history WHERE id = ?")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let content: String = row.get(0).map_err(|e| e.to_string())?;
            let content_type: String = row.get(1).map_err(|e| e.to_string())?;
            Ok(Some((self.maybe_decrypt_text(&content), content_type)))
        } else {
            Ok(None)
        }
    }

    pub fn get_entry_content_with_html_with_conn(
        &self,
        conn: &Connection,
        id: i64,
    ) -> Result<Option<(String, String, Option<String>)>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT content, content_type, html_content FROM clipboard_history WHERE id = ?",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let content: String = row.get(0).map_err(|e| e.to_string())?;
            let content_type: String = row.get(1).map_err(|e| e.to_string())?;
            let html_raw: Option<String> = row.get(2).map_err(|e| e.to_string()).unwrap_or(None);
            let html_content = html_raw.map(|v| self.maybe_decrypt_text(&v));
            Ok(Some((
                self.maybe_decrypt_text(&content),
                content_type,
                html_content,
            )))
        } else {
            Ok(None)
        }
    }

    // --- Search helpers -----------------------------------------------------
    // List/search responses intentionally omit html_content: rich-text HTML
    // snapshots dominate storage while the list only renders text previews.
    // Copy/paste paths refetch full content (incl. HTML) from the backend by id.

    const SEARCH_COLUMNS: &'static str = "ch.id, ch.content_type, ch.content, ch.source_app, ch.timestamp, ch.preview, ch.is_pinned, ch.tags, ch.use_count, ch.is_external, ch.pinned_order, ch.source_app_path";

    fn map_search_row(&self, row: &rusqlite::Row) -> rusqlite::Result<ClipboardEntry> {
        let tags_str: String = row.get(7).unwrap_or_else(|_| "[]".to_string());
        let content_raw: String = row.get(2)?;
        let preview_raw: String = row.get(5)?;
        Ok(ClipboardEntry {
            id: row.get(0)?,
            content_type: row.get(1)?,
            content: self.maybe_decrypt_text(&content_raw),
            html_content: None,
            source_app: row.get(3)?,
            timestamp: row.get(4)?,
            preview: self.maybe_decrypt_text(&preview_raw),
            is_pinned: row.get::<_, i32>(6)? == 1,
            tags: serde_json::from_str(&tags_str).unwrap_or_default(),
            use_count: row.get(8).unwrap_or(0),
            is_external: row.get::<_, i32>(9)? == 1,
            pinned_order: row.get(10).unwrap_or(0),
            source_app_path: row.get(11).unwrap_or(None),
            deleted_at: None,
            file_preview_exists: true,
        })
    }

    /// FTS5 trigram fast path (substring semantics, CJK friendly).
    /// Errors when the clipboard_fts index is unavailable so callers fall back to LIKE.
    fn search_fts(
        &self,
        conn: &Connection,
        term: &str,
        limit: i32,
    ) -> Result<Vec<ClipboardEntry>, String> {
        // Quoted FTS5 phrase = literal substring match under the trigram tokenizer.
        let phrase = format!("\"{}\"", term.replace('"', "\"\""));

        #[cfg(feature = "portable")]
        let sql = format!(
            "SELECT {} FROM clipboard_fts
             JOIN clipboard_history ch ON ch.id = clipboard_fts.rowid
             WHERE clipboard_fts MATCH ?1
               AND ch.deleted_at IS NULL
             ORDER BY ch.timestamp DESC, ch.id DESC
             LIMIT ?2",
            Self::SEARCH_COLUMNS
        );
        #[cfg(not(feature = "portable"))]
        let sql = format!(
            "SELECT {} FROM clipboard_fts
             JOIN clipboard_history ch ON ch.id = clipboard_fts.rowid
             WHERE clipboard_fts MATCH ?1
               AND ch.deleted_at IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM entry_tags se
                   WHERE se.entry_id = ch.id
                     AND se.tag COLLATE NOCASE IN {}
               )
             ORDER BY ch.timestamp DESC, ch.id DESC
             LIMIT ?2",
            Self::SEARCH_COLUMNS,
            sensitive_tags_sql_clause()
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![phrase, limit], |row| self.map_search_row(row))
            .map_err(|e| e.to_string())?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| e.to_string())?);
        }
        Ok(results)
    }

    /// LIKE-based search (fallback for short queries, tag-only search, or missing FTS index).
    fn search_like(
        &self,
        conn: &Connection,
        term: &str,
        limit: i32,
        tag_only: bool,
    ) -> Result<Vec<ClipboardEntry>, String> {
        #[cfg(feature = "portable")]
        let sql = if tag_only {
            format!(
                "SELECT DISTINCT ch.id, ch.content_type, ch.content, ch.source_app, ch.timestamp, ch.preview, ch.is_pinned, ch.tags, ch.use_count, ch.is_external, ch.pinned_order, ch.source_app_path
                 FROM clipboard_history ch
                 INNER JOIN entry_tags et ON ch.id = et.entry_id
                 WHERE et.tag LIKE '%' || ?1 || '%'
                   AND ch.deleted_at IS NULL
                 ORDER BY ch.timestamp DESC
                 LIMIT ?2"
            )
        } else {
            format!(
                "SELECT DISTINCT ch.id, ch.content_type, ch.content, ch.source_app, ch.timestamp, ch.preview, ch.is_pinned, ch.tags, ch.use_count, ch.is_external, ch.pinned_order, ch.source_app_path
                 FROM clipboard_history ch
                 LEFT JOIN entry_tags et ON ch.id = et.entry_id
                 WHERE ch.deleted_at IS NULL
                   AND (
                     ch.content LIKE '%' || ?1 || '%'
                     OR ch.source_app LIKE '%' || ?1 || '%'
                     OR et.tag LIKE '%' || ?1 || '%'
                   )
                 ORDER BY ch.timestamp DESC
                 LIMIT ?2"
            )
        };

        #[cfg(not(feature = "portable"))]
        let sql = if tag_only {
            format!(
                "SELECT DISTINCT ch.id, ch.content_type, ch.content, ch.source_app, ch.timestamp, ch.preview, ch.is_pinned, ch.tags, ch.use_count, ch.is_external, ch.pinned_order, ch.source_app_path
                 FROM clipboard_history ch
                 INNER JOIN entry_tags et ON ch.id = et.entry_id
                 WHERE NOT EXISTS (
                     SELECT 1 FROM entry_tags se
                     WHERE se.entry_id = ch.id
                       AND se.tag COLLATE NOCASE IN {}
                 )
                   AND et.tag LIKE '%' || ?1 || '%'
                   AND ch.deleted_at IS NULL
                 ORDER BY ch.timestamp DESC, ch.id DESC
                 LIMIT ?2",
                sensitive_tags_sql_clause()
            )
        } else {
            format!(
                "SELECT DISTINCT ch.id, ch.content_type, ch.content, ch.source_app, ch.timestamp, ch.preview, ch.is_pinned, ch.tags, ch.use_count, ch.is_external, ch.pinned_order, ch.source_app_path
                 FROM clipboard_history ch
                 LEFT JOIN entry_tags et ON ch.id = et.entry_id
                 WHERE NOT EXISTS (
                     SELECT 1 FROM entry_tags se
                     WHERE se.entry_id = ch.id
                       AND se.tag COLLATE NOCASE IN {}
                 )
                   AND ch.deleted_at IS NULL
                   AND (
                     ch.content LIKE '%' || ?1 || '%'
                     OR ch.source_app LIKE '%' || ?1 || '%'
                     OR et.tag LIKE '%' || ?1 || '%'
                   )
                 ORDER BY ch.timestamp DESC, ch.id DESC
                 LIMIT ?2",
                sensitive_tags_sql_clause()
            )
        };

        // Column order matches map_search_row (12 columns, no html_content).
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![term, limit], |row| self.map_search_row(row))
            .map_err(|e| e.to_string())?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| e.to_string())?);
        }
        Ok(results)
    }

    /// Decrypt-scan for sensitive/encrypted entries that SQL cannot match (non-portable builds).
    /// Appends matches to `results` until `limit` is reached.
    #[cfg(not(feature = "portable"))]
    fn search_encrypted_scan(
        &self,
        conn: &Connection,
        term: &str,
        limit: i32,
        results: &mut Vec<ClipboardEntry>,
        seen: &mut HashSet<i64>,
    ) -> Result<(), String> {
        let mut cursor_ts = i64::MAX;
        let mut cursor_id = i64::MAX;
        let batch_size = 500;
        let enc_like = format!("{}%", ENCRYPT_PREFIX);
        let sql_sensitive = format!(
            "SELECT ch.id, ch.content_type, ch.content, ch.source_app, ch.timestamp, ch.preview, ch.is_pinned, ch.tags, ch.use_count, ch.is_external, ch.pinned_order, ch.source_app_path
             FROM clipboard_history ch
             WHERE ch.deleted_at IS NULL
               AND (
                 EXISTS (
                     SELECT 1 FROM entry_tags se
                     WHERE se.entry_id = ch.id
                       AND se.tag COLLATE NOCASE IN {}
                 )
                 OR ch.content LIKE ?1
                 OR ch.preview LIKE ?1
               )
               AND ((ch.timestamp < ?2) OR (ch.timestamp = ?2 AND ch.id < ?3))
             ORDER BY ch.timestamp DESC, ch.id DESC
             LIMIT ?4",
            sensitive_tags_sql_clause()
        );

        loop {
            let mut stmt = conn.prepare(&sql_sensitive).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![enc_like, cursor_ts, cursor_id, batch_size], |row| {
                    self.map_search_row(row)
                })
                .map_err(|e| e.to_string())?;

            let mut batch: Vec<ClipboardEntry> = Vec::new();
            for row in rows {
                if let Ok(entry) = row {
                    batch.push(entry);
                }
            }

            if batch.is_empty() {
                break;
            }

            for entry in batch.iter() {
                let matches = entry.content.to_lowercase().contains(term)
                    || entry.source_app.to_lowercase().contains(term)
                    || entry.tags.iter().any(|t| t.to_lowercase().contains(term));

                if matches && seen.insert(entry.id) {
                    results.push(entry.clone());
                    if results.len() >= limit as usize {
                        break;
                    }
                }
            }

            if results.len() >= limit as usize {
                break;
            }

            if let Some(last) = batch.last() {
                cursor_ts = last.timestamp;
                cursor_id = last.id;
            } else {
                break;
            }
        }
        Ok(())
    }
}

impl ClipboardRepository for SqliteClipboardRepository {
    fn save(
        &self,
        entry: &ClipboardEntry,
        data_dir: Option<&std::path::Path>,
    ) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.save_with_conn(&conn, entry, data_dir)
    }

    fn get_history(
        &self,
        limit: i32,
        offset: i32,
        content_type: Option<&str>,
    ) -> Result<Vec<ClipboardEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // List responses omit html_content (rich-text HTML snapshots dominate storage).
        // The frontend renders text previews and lazily fetches HTML per visible item
        // via get_entry_html; copy/paste refetch full content by id in the backend.
        let map_row = |row: &rusqlite::Row| {
            let tags_str: String = row.get(7).unwrap_or_else(|_| "[]".to_string());
            let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
            let content_type: String = row.get(1)?;
            let content_raw: String = row.get(2)?;
            let preview_raw: String = row.get(5)?;
            let content = self.maybe_decrypt_text(&content_raw);
            let preview = self.maybe_decrypt_text(&preview_raw);

            Ok((
                ClipboardEntry {
                    id: row.get(0)?,
                    content_type,
                    content,
                    html_content: None,
                    source_app: row.get(3)?,
                    timestamp: row.get(4)?,
                    preview,
                    is_pinned: row.get::<_, i32>(6)? == 1,
                    tags,
                    use_count: row.get(8).unwrap_or(0),
                    is_external: row.get::<_, i32>(9)? == 1,
                    pinned_order: row.get(10).unwrap_or(0),
                    source_app_path: row.get(11).unwrap_or(None),
                    deleted_at: row.get(12).unwrap_or(None),
                    // Avoid synchronous filesystem existence checks in history query.
                    // Missing files are still handled by frontend image/file preview error fallback.
                    file_preview_exists: true,
                },
                content_raw,
                preview_raw,
            ))
        };

        let mut mapped_rows = Vec::new();
        if let Some(ct) = content_type {
            let mut stmt = conn.prepare(
                "SELECT id, content_type, content, source_app, timestamp, preview, is_pinned, tags, use_count, is_external, pinned_order, source_app_path, deleted_at
                 FROM clipboard_history
                 WHERE content_type = ? AND deleted_at IS NULL
                 ORDER BY is_pinned DESC, pinned_order DESC, timestamp DESC, id DESC
                 LIMIT ? OFFSET ?",
            ).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![ct, limit, offset], map_row)
                .map_err(|e| e.to_string())?;
            for row in rows {
                mapped_rows.push(row.map_err(|e| e.to_string())?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, content_type, content, source_app, timestamp, preview, is_pinned, tags, use_count, is_external, pinned_order, source_app_path, deleted_at
                 FROM clipboard_history
                 WHERE deleted_at IS NULL
                 ORDER BY is_pinned DESC, pinned_order DESC, timestamp DESC, id DESC
                 LIMIT ? OFFSET ?",
            ).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([limit, offset], map_row)
                .map_err(|e| e.to_string())?;
            for row in rows {
                mapped_rows.push(row.map_err(|e| e.to_string())?);
            }
        }

        let mut history = Vec::new();
        for (entry, content_raw, preview_raw) in mapped_rows {
            #[cfg(not(feature = "portable"))]
            {
                let is_sensitive = has_sensitive_tag(&entry.tags);
                let content_encrypted = content_raw.starts_with(ENCRYPT_PREFIX);
                let preview_encrypted = preview_raw.starts_with(ENCRYPT_PREFIX);

                if is_sensitive && (!content_encrypted || !preview_encrypted)
                {
                    // encrypt_entry_with_conn covers html_content as well
                    let _ = self.encrypt_entry_with_conn(&conn, entry.id);
                } else if !is_sensitive && (content_encrypted || preview_encrypted)
                {
                    let _ = self.decrypt_entry_with_conn(&conn, entry.id);
                }
            }

            history.push(entry);
        }
        Ok(history)
    }

    fn search(&self, query: &str, limit: i32, tag_only: bool) -> Result<Vec<ClipboardEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let term = query.trim().to_lowercase();
        if term.is_empty() {
            return Ok(Vec::new());
        }

        // FTS5 trigram fast path (requires >= 3 chars for substring matching).
        // Falls through to LIKE when the index is unavailable, the query is too
        // short, or FTS yields nothing (safety net against an empty/stale index).
        if !tag_only && term.chars().count() >= 3 {
            if let Ok(results) = self.search_fts(&conn, &term, limit) {
                if !results.is_empty() {
                    #[cfg(feature = "portable")]
                    return Ok(results);

                    #[cfg(not(feature = "portable"))]
                    {
                        let mut results = results;
                        if (results.len() as i32) < limit {
                            let mut seen: HashSet<i64> = results.iter().map(|e| e.id).collect();
                            self.search_encrypted_scan(&conn, &term, limit, &mut results, &mut seen)?;
                        }
                        results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then(b.id.cmp(&a.id)));
                        if results.len() > limit as usize {
                            results.truncate(limit as usize);
                        }
                        return Ok(results);
                    }
                }
            }
        }

        let mut results = self.search_like(&conn, &term, limit, tag_only)?;

        #[cfg(not(feature = "portable"))]
        {
            if (results.len() as i32) < limit {
                let mut seen: HashSet<i64> = results.iter().map(|e| e.id).collect();
                self.search_encrypted_scan(&conn, &term, limit, &mut results, &mut seen)?;
            }
            results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then(b.id.cmp(&a.id)));
            if results.len() > limit as usize {
                results.truncate(limit as usize);
            }
        }

        Ok(results)
    }

    fn delete(&self, id: i64, data_dir: Option<&std::path::Path>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.delete_with_conn(&conn, id, data_dir)
    }

    fn clear(&self, _data_dir: Option<&std::path::Path>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = now_ms();

        // Get IDs of unpinned items without tags.
        let mut stmt = conn
            .prepare(
                "SELECT id FROM clipboard_history
             WHERE is_pinned = 0
               AND NOT EXISTS (SELECT 1 FROM entry_tags WHERE entry_id = clipboard_history.id)",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        let ids: Vec<i64> = rows.filter_map(Result::ok).collect();

        // Soft-delete (move to recycle bin) instead of hard delete.
        for id in &ids {
            conn.execute(
                "UPDATE clipboard_history SET deleted_at = ? WHERE id = ?",
                params![now, id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn get_count(&self) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT COUNT(*) FROM clipboard_history")
            .map_err(|e| e.to_string())?;
        let count: i64 = stmt
            .query_row([], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        Ok(count)
    }

    fn increment_use_count(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE clipboard_history SET use_count = use_count + 1 WHERE id = ?",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn touch_entry(&self, id: i64, timestamp: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE clipboard_history SET timestamp = ? WHERE id = ?",
            params![timestamp, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn toggle_pin(&self, id: i64, is_pinned: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.toggle_pin_with_conn(&conn, id, is_pinned)
    }

    fn update_pinned_order(&self, orders: Vec<(i64, i64)>) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        self.update_pinned_order_with_conn(&tx, orders)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn get_entry_by_id(&self, id: i64) -> Result<Option<ClipboardEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.get_entry_by_id_with_conn(&conn, id)
    }

    fn get_entry_by_content(
        &self,
        content: &str,
        content_type: Option<&str>,
    ) -> Result<Option<i64>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.find_by_content_with_conn(&conn, content, content_type)
    }

    fn update_entry_content(&self, id: i64, content: &str, preview: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.update_entry_content_with_conn(&conn, id, content, preview)
    }

    fn get_entry_content(&self, id: i64) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT content FROM clipboard_history WHERE id = ?")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let content: String = row.get(0).map_err(|e| e.to_string())?;
            Ok(Some(self.maybe_decrypt_text(&content)))
        } else {
            Ok(None)
        }
    }

    fn get_entry_content_full(&self, id: i64) -> Result<Option<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.get_entry_content_full_with_conn(&conn, id)
    }

    fn get_entry_content_with_html(
        &self,
        id: i64,
    ) -> Result<Option<(String, String, Option<String>)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.get_entry_content_with_html_with_conn(&conn, id)
    }

    // ---- Recycle bin (soft delete) ----

    fn soft_delete(&self, id: i64, deleted_at: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE clipboard_history SET deleted_at = ? WHERE id = ?",
            params![deleted_at, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn restore(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Fetch content_hash + content_type to clear any tombstone created by the soft-delete.
        let mut stmt = conn
            .prepare("SELECT content_type, content_hash FROM clipboard_history WHERE id = ?")
            .map_err(|e| e.to_string())?;
        let tc: Option<(String, i64)> = stmt
            .query_row([id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .ok();
        drop(stmt);
        if let Some((content_type, content_hash)) = tc {
            let _ = self.clear_tombstone_with_conn(&conn, &content_type, content_hash);
        }
        conn.execute(
            "UPDATE clipboard_history SET deleted_at = NULL WHERE id = ?",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn permanent_delete(&self, id: i64, data_dir: Option<&std::path::Path>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.delete_with_conn(&conn, id, data_dir)
    }

    fn get_recycle_bin_items(&self, limit: i32, offset: i32) -> Result<Vec<ClipboardEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, content_type, content, source_app, timestamp, preview,
                        is_pinned, tags, use_count, is_external, pinned_order, source_app_path, deleted_at
                 FROM clipboard_history
                 WHERE deleted_at IS NOT NULL
                 ORDER BY deleted_at DESC
                 LIMIT ? OFFSET ?",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([limit, offset], |row| {
                let tags_str: String = row.get(7).unwrap_or_else(|_| "[]".to_string());
                let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
                let content_type: String = row.get(1)?;
                let content_raw: String = row.get(2)?;
                let preview_raw: String = row.get(5)?;
                let content = self.maybe_decrypt_text(&content_raw);
                let preview = self.maybe_decrypt_text(&preview_raw);
                Ok(ClipboardEntry {
                    id: row.get(0)?,
                    content_type,
                    content,
                    html_content: None,
                    source_app: row.get(3)?,
                    timestamp: row.get(4)?,
                    preview,
                    is_pinned: row.get::<_, i32>(6)? == 1,
                    tags,
                    use_count: row.get(8).unwrap_or(0),
                    is_external: row.get::<_, i32>(9)? == 1,
                    pinned_order: row.get(10).unwrap_or(0),
                    source_app_path: row.get(11).unwrap_or(None),
                    deleted_at: row.get(12).unwrap_or(None),
                    file_preview_exists: true,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e: rusqlite::Error| e.to_string())
    }

    fn cleanup_expired(&self, retention_ms: i64) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let cutoff = now_ms() - retention_ms;
        // Collect expired IDs and their data_dir-relevant info for file cleanup.
        let mut stmt = conn
            .prepare("SELECT id FROM clipboard_history WHERE deleted_at IS NOT NULL AND deleted_at < ?")
            .map_err(|e| e.to_string())?;
        let ids: Vec<i64> = stmt
            .query_map([cutoff], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);
        let count = ids.len() as i64;
        for id in &ids {
            let _ = self.delete_with_conn(&conn, *id, None);
        }
        Ok(count)
    }

    fn empty_recycle_bin(&self, data_dir: Option<&std::path::Path>) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id FROM clipboard_history WHERE deleted_at IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let ids: Vec<i64> = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);
        let count = ids.len() as i64;
        for id in &ids {
            let _ = self.delete_with_conn(&conn, *id, data_dir);
        }
        Ok(count)
    }

    fn get_recycle_bin_count(&self) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT COUNT(*) FROM clipboard_history WHERE deleted_at IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let count: i64 = stmt
            .query_row([], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        Ok(count)
    }
}

#[cfg(test)]
mod fts_tests {
    use super::*;
    use crate::infrastructure::repository::migrations::run_migrations;

    fn setup_db() -> (Arc<Mutex<Connection>>, SqliteClipboardRepository) {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        let arc = Arc::new(Mutex::new(conn));
        let repo = SqliteClipboardRepository::new(arc.clone());
        (arc, repo)
    }

    fn text_entry(content: &str, ts: i64) -> ClipboardEntry {
        ClipboardEntry {
            id: 0,
            content_type: "text".to_string(),
            content: content.to_string(),
            deleted_at: None,
            html_content: None,
            source_app: "TestApp".to_string(),
            source_app_path: None,
            timestamp: ts,
            preview: content.chars().take(40).collect(),
            is_pinned: false,
            tags: vec![],
            use_count: 0,
            is_external: false,
            pinned_order: 0,
            file_preview_exists: true,
        }
    }

    #[test]
    fn fts_migration_creates_index_and_triggers_sync() {
        let (arc, repo) = setup_db();
        repo.save(&text_entry("hello fts world", 1000), None).unwrap();
        repo.save(&text_entry("锂电池RUL预测研究笔记", 2000), None).unwrap();

        // >=3 chars goes through FTS5 trigram
        let hits = repo.search("fts", 50, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "hello fts world");

        // CJK substring via trigram
        let hits = repo.search("RUL预测", 50, false).unwrap();
        assert_eq!(hits.len(), 1);

        // Update keeps index in sync (trigger)
        let id = hits[0].id;
        {
            let conn = arc.lock().unwrap();
            conn.execute(
                "UPDATE clipboard_history SET content = 'totally different body' WHERE id = ?",
                params![id],
            )
            .unwrap();
        }
        assert_eq!(repo.search("RUL预测", 50, false).unwrap().len(), 0);
        assert_eq!(repo.search("different body", 50, false).unwrap().len(), 1);

        // Short query (<3 chars) falls back to LIKE and still matches
        let hits = repo.search("he", 50, false).unwrap();
        assert!(hits.iter().any(|e| e.content == "hello fts world"));
    }

    #[test]
    fn fts_search_excludes_soft_deleted_and_returns_no_html() {
        let (_arc, repo) = setup_db();
        let id = repo
            .save(&text_entry("payload for recycle test", 1000), None)
            .unwrap();
        repo.save(
            &ClipboardEntry {
                content_type: "rich_text".to_string(),
                html_content: Some("<b>rich payload marker</b>".to_string()),
                ..text_entry("rich payload text", 1500)
            },
            None,
        )
        .unwrap();

        // rich_text search hit must not carry html_content (slim payload)
        let hits = repo.search("rich payload", 50, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].html_content.is_none());

        // soft delete removes from results
        repo.soft_delete(id, now_ms()).unwrap();
        let hits = repo.search("recycle test", 50, false).unwrap();
        assert_eq!(hits.len(), 0);

        // restore brings it back
        repo.restore(id).unwrap();
        let hits = repo.search("recycle test", 50, false).unwrap();
        assert_eq!(hits.len(), 1);

        // permanent delete removes from index via trigger
        repo.permanent_delete(id, None).unwrap();
        let hits = repo.search("recycle test", 50, false).unwrap();
        assert_eq!(hits.len(), 0);
    }

    #[test]
    fn fts_rebuild_backfills_from_existing_rows() {
        // Regression: external-content FTS column names must match clipboard_history,
        // otherwise 'rebuild' fails with "no such column" (seen with a tags_text mismatch).
        let (arc, repo) = setup_db();
        repo.save(&text_entry("existing row before rebuild", 1000), None).unwrap();
        repo.save(&text_entry("锂电池RUL预测", 2000), None).unwrap();

        {
            let conn = arc.lock().unwrap();
            // Wipe the index, then rebuild from the content table by column name.
            conn.execute("INSERT INTO clipboard_fts (clipboard_fts) VALUES ('delete-all')", [])
                .unwrap();
            assert_eq!(repo.search_fts(&conn, "rebuild", 50).unwrap().len(), 0);
            conn.execute("INSERT INTO clipboard_fts (clipboard_fts) VALUES ('rebuild')", [])
                .unwrap();
        }

        // After rebuild the pre-existing rows must be findable again.
        assert_eq!(repo.search("before rebuild", 50, false).unwrap().len(), 1);
        assert_eq!(repo.search("RUL预测", 50, false).unwrap().len(), 1);
    }

    #[test]
    fn fts_search_matches_source_app() {
        let (_arc, repo) = setup_db();
        repo.save(&text_entry("plain body", 1000), None).unwrap();
        let hits = repo.search("testapp", 50, false).unwrap();
        assert_eq!(hits.len(), 1);
    }
}
