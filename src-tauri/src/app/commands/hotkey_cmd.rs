use crate::app_state::SettingsState;
use crate::error::{AppError, AppResult};
use crate::global_state::{HOTKEY_STRING, IS_RECORDING};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

fn uses_win_modifier(hotkey: &str) -> bool {
    hotkey.split('+').any(|part| {
        matches!(
            part.trim().to_ascii_uppercase().as_str(),
            "WIN" | "SUPER" | "COMMAND" | "META"
        )
    })
}

fn is_configured_hotkey(settings: &SettingsState, normalized: &str) -> bool {
    [
        &settings.main_hotkey,
        &settings.sequential_paste_hotkey,
        &settings.rich_paste_hotkey,
        &settings.search_hotkey,
    ]
    .iter()
    .any(|slot| {
        let value = slot.lock().unwrap();
        !value.is_empty() && value.replace("Win", "Super") == normalized
    })
}

fn register_shortcut(app_handle: &AppHandle, hotkey: &str) {
    if hotkey.is_empty()
        || hotkey.eq_ignore_ascii_case("MouseMiddle")
        || hotkey.eq_ignore_ascii_case("MButton")
    {
        return;
    }

    let normalized = hotkey.replace("Win", "Super");
    if let Ok(shortcut) = normalized.parse::<Shortcut>() {
        if let Err(err) = app_handle.global_shortcut().register(shortcut) {
            eprintln!("[HOTKEY] failed to register {}: {:?}", hotkey, err);
        }
    }
}

pub(crate) fn sync_registered_hotkeys(app_handle: &AppHandle) -> AppResult<()> {
    let _ = app_handle.global_shortcut().unregister_all();

    let Some(settings) = app_handle.try_state::<SettingsState>() else {
        return Ok(());
    };

    let main_hotkey = settings.main_hotkey.lock().unwrap().clone();
    register_shortcut(app_handle, &main_hotkey);

    let sequential_mode = settings.sequential_mode.load(Ordering::Relaxed);
    let sequential_hotkey = settings.sequential_paste_hotkey.lock().unwrap().clone();
    if sequential_mode {
        register_shortcut(app_handle, &sequential_hotkey);
    }

    let rich_hotkey = settings.rich_paste_hotkey.lock().unwrap().clone();
    register_shortcut(app_handle, &rich_hotkey);

    let search_hotkey = settings.search_hotkey.lock().unwrap().clone();
    register_shortcut(app_handle, &search_hotkey);

    Ok(())
}

#[tauri::command]
pub fn register_hotkey(app_handle: AppHandle, hotkey: String) -> AppResult<()> {
    {
        let mut guard = HOTKEY_STRING.lock().unwrap();
        *guard = hotkey.clone();
    }

    if let Some(settings) = app_handle.try_state::<SettingsState>() {
        let mut guard = settings.main_hotkey.lock().unwrap();
        *guard = hotkey.clone();
    }

    sync_registered_hotkeys(&app_handle)
}

#[tauri::command]
pub fn test_hotkey_available(app_handle: AppHandle, hotkey: String) -> AppResult<bool> {
    if hotkey.is_empty()
        || hotkey.eq_ignore_ascii_case("MouseMiddle")
        || hotkey.eq_ignore_ascii_case("MButton")
    {
        return Ok(true);
    }

    let normalized = hotkey.replace("Win", "Super");
    let shortcut = normalized
        .parse::<Shortcut>()
        .map_err(|_| AppError::Validation("快捷键格式无效".to_string()))?;

    // Recording mode registers every Win+key itself to block the shell, so
    // probing those combos would report our own block as a conflict.
    if IS_RECORDING.load(Ordering::SeqCst) && uses_win_modifier(&hotkey) {
        return Ok(true);
    }

    // Re-recording an existing TieZ shortcut is not a third-party conflict.
    if let Some(settings) = app_handle.try_state::<SettingsState>() {
        if is_configured_hotkey(&settings, &normalized) {
            return Ok(true);
        }
    }

    match app_handle.global_shortcut().register(shortcut.clone()) {
        Ok(_) => {
            let _ = app_handle.global_shortcut().unregister(shortcut);
            Ok(true)
        }
        Err(e) => {
            let err_str = format!("{:?}", e);
            let user_msg = if err_str.contains("AlreadyRegistered") {
                "该快捷键已被其他程序占用".to_string()
            } else {
                "快捷键不可用".to_string()
            };
            Err(AppError::Internal(user_msg))
        }
    }
}
