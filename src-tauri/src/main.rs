#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod app;
pub mod app_state;
pub mod database;
pub mod domain;
pub mod error;
pub mod global_state;
pub mod infrastructure;
pub mod logger;
pub mod migration;
pub mod services;

use crate::app::setup;
use crate::global_state::*;
use std::sync::atomic::Ordering;

/// 托盘「重启应用」给新进程带的接力参数：新进程先等这么久再起来，
/// 让旧进程有机会把单实例互斥量释放掉。
const RESTART_RELAY_ARG: &str = "--restart-after=";

/// 新进程在构建 Tauri 应用之前先等一小会儿。
///
/// tauri-plugin-single-instance 的互斥量由活着的进程持有，旧进程没退干净时
/// 新进程一初始化插件就被判成"第二实例"直接静默退出（连 setup 都不进）。
/// 托盘重启传了这个参数就说明是接力，让新进程等旧进程退干净再起来。
fn wait_for_restart_relay() {
    let delay = std::env::args().find_map(|a| {
        let rest = a.strip_prefix(RESTART_RELAY_ARG)?.to_string();
        rest.parse::<u64>().ok()
    });
    if let Some(ms) = delay {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

fn main() {
    // 显式安装 rustls 的 crypto provider，防止 rumqttc 因缺少 provider 而 panic
    let _ = rustls::crypto::ring::default_provider().install_default();

    let _ = dotenvy::dotenv();

    wait_for_restart_relay();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        setup::handle_global_shortcut(app, shortcut);
                    }
                })
                .build(),
        )
        // 只记住主窗口和设置窗口的位置大小。插件对任何没有存档的窗口都会调
        // show()，所以隐藏创建的 compact-preview 第一次创建时就被弹到桌面上；
        // VISIBLE 整个排除掉，否则退出时正好开着的窗口会在静默启动时自己弹出来。
        // 这里是显式白名单：以后新增的窗口默认不被插件接管。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .with_filter(|label| label == "main" || label == "settings")
                .build(),
        )
        // 已经有实例在跑时，把主窗口叫出来，而不是无声退出。
        // 原来是空回调：第二次启动 exe 什么也不发生，用户只看到"启动不了"。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            crate::app::setup::show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            setup::init(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app::window_manager::toggle_window_cmd,
            app::window_manager::hide_window_cmd,
            app::window_manager::activate_window_focus,
            app::window_manager::focus_clipboard_window,
            app::window_manager::force_window_foreground,
            app::window_manager::set_navigation_enabled,
            app::window_manager::set_navigation_mode,
            app::hooks::set_recording_mode,
            services::content_handler::open_content,
            services::clipboard_ops::copy_to_clipboard,
            services::clipboard_ops::paste_latest_rich,
            app::commands::get_clipboard_history,
            app::commands::search_clipboard_history,
            app::commands::delete_clipboard_entry,
            app::commands::restore_from_recycle_bin,
            app::commands::permanent_delete_entry,
            app::commands::get_recycle_bin_items,
            app::commands::empty_recycle_bin,
            app::commands::cleanup_expired_recycle_bin,
            app::commands::get_recycle_bin_count,
            app::commands::clear_clipboard_history,
            app::commands::get_tag_items,
            app::commands::get_all_tags_info,
            app::commands::rename_tag_globally,
            app::commands::delete_tag_from_all,
            app::commands::create_new_tag,
            app::commands::update_pinned_order,
            app::commands::get_db_count,
            app::commands::get_clipboard_content,
            app::commands::get_entry_html,
            app::commands::set_sequential_mode,
            app::commands::set_sequential_hotkey,
            app::commands::set_rich_paste_hotkey,
            app::commands::set_search_hotkey,
            app::commands::set_deduplication,
            app::commands::set_duplicate_mode,
            app::commands::save_setting,
            app::commands::set_ignore_blur,
            app::commands::set_window_pinned,
            app::commands::get_settings,
            app::commands::set_file_server_auto_close,
            app::commands::set_file_transfer_auto_close_seconds,
            app::commands::set_persistence,
            app::commands::set_capture_files,
            app::commands::set_capture_rich_text,
            app::commands::set_auto_copy_file,
            app::commands::set_silent_start,
            app::commands::set_delete_after_paste,
            app::commands::set_privacy_protection,
            app::commands::set_privacy_protection_kinds,
            app::commands::set_privacy_protection_custom_rules,
            app::commands::set_cleanup_rules,
            app::commands::set_app_cleanup_policies,
            app::commands::reset_settings,
            app::commands::get_mqtt_status,
            app::commands::get_mqtt_running,
            app::commands::restart_mqtt_client,
            app::commands::get_cloud_sync_status,
            app::commands::restart_cloud_sync_client,
            app::commands::request_cloud_sync,
            app::commands::cloud_sync_now,
            app::commands::set_sound_enabled,
            app::commands::set_file_transfer_auto_open,
            app::commands::set_arrow_key_selection,
            app::commands::set_tray_visible,
            app::commands::set_edge_docking,
            app::commands::set_follow_mouse,
            app::commands::get_data_path,
            app::commands::open_folder,
            app::commands::open_data_folder,
            app::commands::open_file_with_default_app,
            app::commands::open_file_location,
            app::commands::set_data_path,
            app::commands::toggle_autostart,
            app::commands::is_autostart_enabled,
            app::commands::set_windows_clipboard_history,
            app::commands::get_windows_clipboard_history,
            app::commands::set_win_clipboard_disabled,
            app::commands::trigger_registry_win_v_optimization,
            app::commands::is_registry_win_v_optimized,
            app::commands::restart_explorer,
            app::commands::restart_as_admin,
            app::commands::check_is_admin,
            app::commands::quit,
            app::commands::relaunch,
            app::commands::set_theme,
            app::commands::get_platform_info,
            app::commands::send_system_notification,
            app::commands::register_hotkey,
            app::commands::test_hotkey_available,
            app::commands::toggle_clipboard_pin,
            app::commands::update_tags,
            app::commands::add_manual_item,
            app::commands::update_item_content,
            app::commands::save_emoji_favorite,
            app::commands::remove_emoji_favorite,
            app::commands::list_emoji_favorites,
            app::commands::save_emoji_favorite_data_url,
            app::commands::save_emoji_favorite_url,
            app::commands::get_file_size,
            app::commands::save_file_copy,
            app::commands::append_debug_log,
            services::clipboard_ops::paste_text_directly,
            services::clipboard_ops::paste_content_transiently,
            services::file_transfer::send_chat_message,
            services::file_transfer::get_chat_history,
            services::file_transfer::send_file_to_client,
            services::file_transfer::get_clipboard_file_paths,
            services::file_transfer::get_clipboard_image_base64,
            services::file_transfer::set_window_zoom,
            services::file_transfer::get_app_logo,
            services::file_transfer::get_local_ip_addr,
            services::file_transfer::get_available_ips,
            services::file_transfer::get_file_server_status,
            services::file_transfer::get_online_devices,
            services::file_transfer::get_download_url,
            services::file_transfer::toggle_file_server,
            services::file_transfer::get_active_file_transfer_path,
            services::paste_queue::get_paste_queue,
            services::paste_queue::set_paste_queue,
            services::paste_queue::paste_next_step,
            app::commands::get_tag_colors,
            app::commands::set_tag_color,
            app::commands::call_ai,
            app::commands::check_ai_connectivity,
            infrastructure::windows_api::apps::get_system_default_app,
            infrastructure::windows_api::apps::get_executable_icon,
            infrastructure::windows_api::apps::get_file_icon,
            infrastructure::windows_api::apps::scan_installed_apps,
            infrastructure::windows_api::apps::get_associated_apps
        ])
        .on_window_event(|window, event| {
            setup::handle_window_event(window, event);
        })
        .build(tauri::generate_context!());

    match app {
        Ok(app) => {
            info!(">>> [STARTUP] Tauri app built successfully.");
            app.run(|_app_handle, _event| {});
        }
        Err(e) => {
            error!(">>> [STARTUP] Failed to build tauri app: {}", e);
        }
    }

    // Cleanup Hooks on exit
    unsafe {
        let h_hook = HOOK_HANDLE.swap(std::ptr::null_mut(), Ordering::SeqCst);
        if !h_hook.is_null() {
            let _ = windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx(
                windows::Win32::UI::WindowsAndMessaging::HHOOK(h_hook as _),
            );
        }
        let h_mouse = HOOK_MOUSE_HANDLE.swap(std::ptr::null_mut(), Ordering::SeqCst);
        if !h_mouse.is_null() {
            let _ = windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx(
                windows::Win32::UI::WindowsAndMessaging::HHOOK(h_mouse as _),
            );
        }
    }
}
