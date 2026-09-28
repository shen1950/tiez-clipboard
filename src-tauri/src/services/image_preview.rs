use crate::domain::models::ClipboardEntry;
use tauri::{AppHandle, Manager};

/// Grant access before exposing local image paths to any clipboard view.
/// The default asset scope does not cover user-selected data directories.
pub fn prepare_image_preview(app: &AppHandle, item: &mut ClipboardEntry) {
    if item.content_type != "image" {
        return;
    }
    let path = std::path::Path::new(&item.content);
    if !path.is_absolute() {
        return;
    }
    item.file_preview_exists = path.is_file();
    if item.file_preview_exists && app.asset_protocol_scope().allow_file(path).is_err() {
        item.file_preview_exists = false;
    }
}
