use crate::domain::models::ClipboardEntry;
use tauri::{AppHandle, Manager};

/// Grant access before exposing local image paths to any clipboard view.
/// The default asset scope does not cover user-selected data directories.
pub fn prepare_image_preview(app: &AppHandle, item: &mut ClipboardEntry) {
    // 视频条目同样走附件路径渲染（列表缩略图与预览播放都要 asset 协议放行）。
    if item.content_type != "image" && item.content_type != "video" {
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
