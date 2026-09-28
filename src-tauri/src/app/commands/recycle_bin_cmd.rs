use crate::app_state::{AppDataDir, SessionHistory};
use crate::database::DbState;
use crate::error::{AppError, AppResult};
use crate::infrastructure::repository::clipboard_repo::ClipboardRepository;
use crate::services::cloud_sync;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Soft-delete an entry: move it to the recycle bin instead of permanently deleting.
#[tauri::command]
pub fn delete_clipboard_entry(
    app_handle: AppHandle,
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    _app_data: State<'_, AppDataDir>,
    id: i64,
) -> AppResult<()> {
    {
        let mut session_items = session.inner().0.lock().unwrap();
        session_items.retain(|item| item.id != id);
    }

    if id > 0 {
        let deleted_at = now_ms();
        state.repo.soft_delete(id, deleted_at).map_err(AppError::from)?;
    }
    let _ = app_handle.emit("clipboard-removed", id);
    Ok(())
}

/// Restore a soft-deleted entry from the recycle bin.
#[tauri::command]
pub fn restore_from_recycle_bin(
    app_handle: AppHandle,
    state: State<'_, DbState>,
    id: i64,
) -> AppResult<()> {
    state.repo.restore(id).map_err(AppError::from)?;
    let _ = app_handle.emit("clipboard-changed", ());
    Ok(())
}

/// Permanently delete a single entry (bypass recycle bin). Used by recycle bin "delete now".
#[tauri::command]
pub fn permanent_delete_entry(
    app_handle: AppHandle,
    state: State<'_, DbState>,
    session: State<'_, SessionHistory>,
    app_data: State<'_, AppDataDir>,
    id: i64,
) -> AppResult<()> {
    {
        let mut session_items = session.inner().0.lock().unwrap();
        session_items.retain(|item| item.id != id);
    }
    if id > 0 {
        let data_dir = app_data.0.lock().unwrap();
        state.repo.permanent_delete(id, Some(&data_dir)).map_err(AppError::from)?;
    }
    let _ = app_handle.emit("clipboard-changed", ());
    cloud_sync::request_cloud_sync(app_handle);
    Ok(())
}

/// List items currently in the recycle bin, newest first.
#[tauri::command]
pub fn get_recycle_bin_items(
    app_handle: AppHandle,
    state: State<'_, DbState>,
    limit: i32,
    offset: i32,
) -> AppResult<Vec<crate::domain::models::ClipboardEntry>> {
    let mut items = state
        .repo
        .get_recycle_bin_items(limit, offset)
        .map_err(AppError::from)?;
    for item in &mut items {
        crate::services::image_preview::prepare_image_preview(&app_handle, item);
    }
    Ok(items)
}

/// Permanently delete ALL items in the recycle bin.
#[tauri::command]
pub fn empty_recycle_bin(
    app_handle: AppHandle,
    state: State<'_, DbState>,
    app_data: State<'_, AppDataDir>,
) -> AppResult<i64> {
    let data_dir = app_data.0.lock().unwrap();
    let count = state
        .repo
        .empty_recycle_bin(Some(&data_dir))
        .map_err(AppError::from)?;
    let _ = app_handle.emit("clipboard-changed", ());
    cloud_sync::request_cloud_sync(app_handle);
    Ok(count)
}

/// Clean up items that have been in the recycle bin longer than the retention period.
/// Returns the number of items permanently deleted.
#[tauri::command]
pub fn cleanup_expired_recycle_bin(
    app_handle: AppHandle,
    state: State<'_, DbState>,
    retention_days: i64,
) -> AppResult<i64> {
    let retention_ms = retention_days * 24 * 60 * 60 * 1000;
    let count = state
        .repo
        .cleanup_expired(retention_ms)
        .map_err(AppError::from)?;
    if count > 0 {
        let _ = app_handle.emit("clipboard-changed", ());
        cloud_sync::request_cloud_sync(app_handle);
    }
    Ok(count)
}

/// Get the count of items currently in the recycle bin.
#[tauri::command]
pub fn get_recycle_bin_count(state: State<'_, DbState>) -> AppResult<i64> {
    state.repo.get_recycle_bin_count().map_err(AppError::from)
}
