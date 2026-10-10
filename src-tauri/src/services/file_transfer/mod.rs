pub mod handlers;
pub mod models;
pub mod utils;
pub mod web_ui;

use axum::{
    extract::DefaultBodyLimit,
    routing::{get, post},
    Router,
};
use base64::Engine;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::app_state::{SessionHistory, SettingsState};
use crate::database::ClipboardEntry;
use crate::database::DbState;
use crate::infrastructure::repository::clipboard_repo::ClipboardRepository;
use crate::infrastructure::repository::settings_repo::SettingsRepository;
pub use models::*;
pub use utils::*;

pub static SERVER_HANDLE: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

/// 局域网传输的诊断日志：发布版没有 devtools，出问题时只能靠 tiez.log。
fn xlog(msg: &str) {
    crate::logger::log(&format!("[FILE_XFER] {}", msg));
}

#[tauri::command]
pub fn get_local_ip_addr(app_handle: AppHandle) -> String {
    let server_info = app_handle.state::<ServerInfo>();
    if let Ok(guard) = server_info.ip.lock() {
        if !guard.is_empty() && *guard != "0.0.0.0" {
            return guard.clone();
        }
    }

    let ips = get_available_ips();
    if !ips.is_empty() {
        return ips[0].clone();
    }

    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or("127.0.0.1".to_string())
}

#[tauri::command]
pub fn set_display_ip(app_handle: AppHandle, ip: String) {
    let server_info = app_handle.state::<ServerInfo>();
    {
        let mut guard = server_info.ip.lock().unwrap();
        *guard = ip.clone();
    }
    let port = server_info.port.load(Ordering::Relaxed);
    let _ = app_handle.emit(
        "file-server-status-changed",
        StatusPayload {
            enabled: port != 0,
            port,
            ip,
        },
    );
}

#[tauri::command]
pub fn get_active_file_transfer_path(app_handle: AppHandle) -> String {
    let db_state = app_handle.state::<DbState>();
    let mut dir = app_handle
        .path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    if let Ok(Some(custom)) = db_state.settings_repo.get("file_transfer_path") {
        if !custom.trim().is_empty() {
            dir = std::path::PathBuf::from(custom);
        }
    }
    dir.to_string_lossy().to_string()
}

#[tauri::command]
pub fn send_chat_message(app_handle: AppHandle, msg_type: String, content: String) {
    append_message(&app_handle, "out", &msg_type, &content, "pc", "电脑", None);
}

#[tauri::command]
pub fn get_chat_history(app_handle: AppHandle) -> Vec<Message> {
    if let Ok(msgs) = app_handle.state::<ChatState>().0.lock() {
        return msgs.clone();
    }
    vec![]
}

#[tauri::command]
pub async fn send_file_to_client(app_handle: AppHandle, file_path: String) -> Result<(), String> {
    let shared_state = app_handle.state::<SharedFileState>();
    update_activity(&app_handle);

    if !std::path::Path::new(&file_path).is_file() {
        xlog(&format!("send aborted, file missing: {}", file_path));
        return Err(format!("文件已不存在或已被清理：{}", file_path));
    }

    let token = uuid::Uuid::new_v4().to_string();
    if let Ok(mut map) = shared_state.0.lock() {
        map.insert(token.clone(), file_path.clone());
    }

    let server_info = app_handle.state::<ServerInfo>();
    let mut port = server_info.port.load(Ordering::Relaxed);
    let mut ip = server_info.ip.lock().unwrap().clone();

    // 服务未运行（手动关闭/自动关闭/开机未开）时自动拉起，保证聊天粘贴发送永远可用
    if port == 0 || ip.is_empty() || ip == "0.0.0.0" {
        xlog(&format!(
            "server down (port={}, ip={}), auto-starting for {}",
            port, ip, file_path
        ));
        let started = toggle_file_server(app_handle.clone(), true, None).await;
        port = match started {
            Ok(port_str) => port_str.parse::<u16>().unwrap_or(0),
            Err(err) => {
                xlog(&format!("auto-start failed: {}", err));
                return Err(format!("文件服务自动开启失败：{}", err));
            }
        };
        ip = server_info.ip.lock().unwrap().clone();
        if port == 0 || ip.is_empty() || ip == "0.0.0.0" {
            xlog("auto-start reported success but port/ip still invalid");
            return Err("文件服务未能启动（端口或本机 IP 不可用）".to_string());
        }
    }

    let path_lower = file_path.to_lowercase();
    let is_image = path_lower.ends_with(".png")
        || path_lower.ends_with(".jpg")
        || path_lower.ends_with(".jpeg")
        || path_lower.ends_with(".gif")
        || path_lower.ends_with(".webp")
        || path_lower.ends_with(".bmp")
        || path_lower.ends_with(".svg")
        || path_lower.ends_with(".ico");

    let is_video = path_lower.ends_with(".mp4")
        || path_lower.ends_with(".mkv")
        || path_lower.ends_with(".avi")
        || path_lower.ends_with(".mov")
        || path_lower.ends_with(".wmv")
        || path_lower.ends_with(".flv")
        || path_lower.ends_with(".webm");

    let msg_type = if is_image {
        "image"
    } else if is_video {
        "video"
    } else {
        "file"
    };

    append_message(
        &app_handle,
        "out",
        msg_type,
        &file_path,
        "pc",
        "电脑",
        Some(&file_path),
    );

    Ok(())
}

/// 读取剪贴板里的文件路径列表（资源管理器里 Ctrl+C 复制的文件）。
/// WebView 的 paste 事件拿不到真实路径，聊天输入框粘贴文件时靠这个命令。
/// 只返回仍然存在的文件：截图工具常往 CF_HDROP 塞一个用完即删的临时路径，
/// 留着它会让前端放弃后面那条更好的位图兜底。
#[tauri::command]
pub fn get_clipboard_file_paths() -> Option<Vec<String>> {
    let files = unsafe { crate::infrastructure::windows_api::win_clipboard::get_clipboard_files() }?;
    let existing: Vec<String> = files
        .into_iter()
        .filter(|path| std::path::Path::new(path).is_file())
        .collect();
    if existing.is_empty() {
        None
    } else {
        Some(existing)
    }
}

/// 预览/设置窗口 DPR 偏差补偿：WebView2 在隐藏窗口上初始化时会把显示器缩放
/// 算错（150% 屏上报 2.25），导致视口/字号全错。自定义命令绕开插件 ACL，
/// 直接给指定 webview 设置 zoom。label 限死在本应用自己的三个窗口，
/// 免得前端拿它去动别的进程窗口。
#[tauri::command]
pub fn set_window_zoom(app_handle: AppHandle, label: String, scale: f64) -> Result<(), String> {
    const ALLOWED: [&str; 3] = ["compact-preview", "settings", "main"];
    if !ALLOWED.contains(&label.as_str()) {
        return Err(format!("zoom is not allowed for window: {}", label));
    }
    if !(0.2..=5.0).contains(&scale) {
        return Err(format!("zoom scale out of range: {}", scale));
    }
    if let Some(w) = app_handle.get_webview_window(&label) {
        w.set_zoom(scale).map_err(|e| e.to_string())
    } else {
        Err(format!("webview window not found: {}", label))
    }
}

/// 兜底：直接从 Win32 剪贴板读位图并编码为 PNG base64。
/// 某些截图/复制来源在 WebView 的 paste 事件里拿不到 File 对象，用它兜底。
#[tauri::command]
pub fn get_clipboard_image_base64() -> Option<String> {
    let img = unsafe { crate::infrastructure::windows_api::win_clipboard::get_clipboard_image() }?;
    if img.width == 0 || img.height == 0 || img.bytes.is_empty() {
        return None;
    }
    let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes)?;
    let mut png_bytes: std::io::Cursor<Vec<u8>> = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut png_bytes, image::ImageFormat::Png)
        .ok()?;
    use base64::Engine;
    Some(base64::engine::general_purpose::STANDARD.encode(png_bytes.into_inner()))
}

#[tauri::command]
pub fn save_temp_image(app_handle: AppHandle, base64_data: String) -> Result<String, String> {
    use std::io::Write;
    let b64 = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Base64 Error: {}", e))?;
    let save_dir = app_handle
        .path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    if !save_dir.exists() {
        let _ = std::fs::create_dir_all(&save_dir);
    }
    let filename = format!("paste_{}.png", chrono::Utc::now().format("%Y%m%d%H%M%S%f"));
    let path = save_dir.join(&filename);
    let mut file = std::fs::File::create(&path).map_err(|e| format!("File Error: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("Write Error: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_download_url(app_handle: AppHandle, file_path: String) -> Result<String, String> {
    let port = {
        let server_info = app_handle.state::<ServerInfo>();
        let p = server_info.port.load(Ordering::Relaxed);
        if p == 0 {
            match toggle_file_server(app_handle.clone(), true, None).await {
                Ok(p_str) => p_str.parse::<u16>().unwrap_or(0),
                Err(_) => 0,
            }
        } else {
            p
        }
    };
    if port == 0 {
        return Err("Failed to start server".to_string());
    }
    let shared_state = app_handle.state::<SharedFileState>();
    let token = format!("fallback_{}", uuid::Uuid::new_v4());
    if let Ok(mut map) = shared_state.0.lock() {
        map.insert(token.clone(), file_path.clone());
    }
    let filename = std::path::Path::new(&file_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    Ok(format!(
        "/download/{}?name={}",
        token,
        urlencoding::encode(&filename)
    ))
}

/// 自动关闭看门狗：服务运行期间每 5 秒检查一次活动时间，
/// 超过 `file_transfer_auto_close_seconds`（默认 300，0 = 不自动关闭）未
/// 收发任何文件/消息就停掉服务。跟随服务生命周期，服务停了看门狗也退出。
fn spawn_auto_close_watchdog(app_handle: AppHandle) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            {
                let handle = SERVER_HANDLE.lock().unwrap();
                if handle.is_none() {
                    break;
                }
            }
            let enabled = app_handle
                .state::<crate::app_state::SettingsState>()
                .file_server_auto_close
                .load(Ordering::Relaxed);
            if !enabled {
                continue;
            }
            let timeout_secs: u64 = {
                let db_state = app_handle.state::<DbState>();
                match db_state.settings_repo.get("file_transfer_auto_close_seconds") {
                    Ok(Some(v)) => v.parse().unwrap_or(300),
                    _ => 300,
                }
            };
            if timeout_secs == 0 {
                continue;
            }
            // 手机还连着就不关：关端口会让已打开的页面静默失联，
            // 而 PC 侧重启服务时端口可能已经变了。
            {
                let devices = app_handle.state::<OnlineDevices>();
                let online = devices.0.lock().map(|g| g.len()).unwrap_or(0);
                if online > 0 {
                    continue;
                }
            }
            let activity_state = app_handle.state::<ServerActivityState>();
            let idle = {
                let guard = match activity_state.last_activity.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                match *guard {
                    Some(t) => t.elapsed().unwrap_or_default(),
                    None => std::time::Duration::from_secs(0),
                }
            };
            drop(activity_state);
            if idle >= std::time::Duration::from_secs(timeout_secs) {
                xlog(&format!(
                    "idle {}s >= {}s -> stopping server",
                    idle.as_secs(),
                    timeout_secs
                ));
                let _ = toggle_file_server(app_handle.clone(), false, None).await;
                break;
            }
        }
    });
}

#[tauri::command]
pub async fn toggle_file_server(
    app_handle: AppHandle,
    enabled: bool,
    port: Option<u16>,
) -> Result<String, String> {
    if enabled {
        {
            let mut handle = SERVER_HANDLE.lock().unwrap();
            if let Some(task) = handle.as_ref() {
                let live_port = app_handle.state::<ServerInfo>().port.load(Ordering::Relaxed);
                // 端口归零或任务已结束 = 僵死句柄：必须重新绑定。
                // 早退返回非数字的 "Server already running" 会让自动拉起
                // 永远解析出 port=0，用户看到的就是“发送失败”。
                if live_port != 0 && !task.is_finished() {
                    return Ok(live_port.to_string());
                }
                xlog(&format!(
                    "stale server handle (port={}, finished={}), restarting",
                    live_port,
                    task.is_finished()
                ));
                if let Some(stale) = handle.take() {
                    stale.abort();
                }
            }
        }
        let target_port = match port {
            Some(p) => p,
            None => {
                // 自动拉起要用上次保存的端口：换端口会让手机已打开的页面失效。
                let db_state = app_handle.state::<DbState>();
                db_state
                    .settings_repo
                    .get("file_server_port")
                    .ok()
                    .flatten()
                    .and_then(|v| v.parse::<u16>().ok())
                    .filter(|p| *p > 0)
                    .unwrap_or(12345)
            }
        };
        let (listener, actual_port) = bind_listener(target_port).await;
        if actual_port == 0 {
            return Err("Failed to bind any port".to_string());
        }
        if actual_port != target_port {
            xlog(&format!(
                "port {} busy, bound {} instead",
                target_port, actual_port
            ));
        }
        let actual_ip = get_local_ip_addr(app_handle.clone());
        let server_info = app_handle.state::<ServerInfo>();
        server_info.port.store(actual_port, Ordering::SeqCst);
        {
            let mut ip_guard = server_info.ip.lock().unwrap();
            *ip_guard = actual_ip.clone();
        }
        let app_handle_clone = app_handle.clone();
        let h = tokio::spawn(async move {
            run_server(listener, app_handle_clone).await;
        });
        {
            let mut handle = SERVER_HANDLE.lock().unwrap();
            *handle = Some(h);
        }
        update_activity(&app_handle);
        spawn_auto_close_watchdog(app_handle.clone());
        xlog(&format!(
            "server started on {}:{}",
            actual_ip, actual_port
        ));
        let _ = app_handle.emit(
            "file-server-status-changed",
            StatusPayload {
                enabled: true,
                port: actual_port,
                ip: if actual_ip.is_empty() || actual_ip.contains("0.0.0.0") {
                    "127.0.0.1".to_string()
                } else {
                    actual_ip
                },
            },
        );
        let db_state = app_handle.state::<DbState>();
        let _ = db_state.settings_repo.set("file_server_enabled", "true");
        let _ = db_state
            .settings_repo
            .set("file_server_port", &actual_port.to_string());
        Ok(format!("{}", actual_port))
    } else {
        let mut handle = SERVER_HANDLE.lock().unwrap();
        if let Some(h) = handle.take() {
            h.abort();
            let db_state = app_handle.state::<DbState>();
            let _ = db_state.settings_repo.set("file_server_enabled", "false");
            let server_info = app_handle.state::<ServerInfo>();
            server_info.port.store(0, Ordering::SeqCst);
            {
                let mut ip_guard = server_info.ip.lock().unwrap();
                *ip_guard = String::new();
            }
            // 服务停了所有 WS 连接都不作数：清掉设备表，别让计数停在旧值上。
            if let Ok(mut devices) = app_handle.state::<OnlineDevices>().0.lock() {
                devices.clear();
            }
            let _ = app_handle.emit(
                "file-server-status-changed",
                StatusPayload {
                    enabled: false,
                    port: 0,
                    ip: String::new(),
                },
            );
            Ok("Server stopped".to_string())
        } else {
            Ok("Server not running".to_string())
        }
    }
}

pub async fn run_server(listener: tokio::net::TcpListener, app_handle: AppHandle) {
    let (ws_tx, _) = broadcast::channel::<String>(100);
    {
        let ws_state = app_handle.state::<WsBroadcaster>();
        if let Ok(mut guard) = ws_state.0.lock() {
            *guard = Some(ws_tx.clone());
        };
    }
    let state = Arc::new(AppState {
        app_handle: app_handle.clone(),
        ws_tx: ws_tx.clone(),
    });
    let app = Router::new()
        .route("/", get(handlers::index))
        .route("/ws", get(handlers::ws_handler))
        .route("/poll", get(handlers::poll_messages))
        .route("/upload", post(handlers::upload))
        .route("/upload_chunk", post(handlers::upload_chunk))
        .route("/upload-chunk", post(handlers::upload_chunk))
        .route("/send_text", post(handlers::handle_text))
        .route("/send-text", post(handlers::handle_text))
        .route(
            "/download/{token}",
            get(handlers::handle_file_download_proxy),
        )
        .with_state(state)
        .layer(DefaultBodyLimit::disable());

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("Server error: {}", e);
    }

    let server_info = app_handle.state::<ServerInfo>();
    server_info.port.store(0, Ordering::SeqCst);
    {
        let mut ip_guard = server_info.ip.lock().unwrap();
        *ip_guard = String::new();
    }
    let _ = app_handle.emit(
        "file-server-status-changed",
        StatusPayload {
            enabled: false,
            port: 0,
            ip: String::new(),
        },
    );
}

pub fn append_message(
    app: &AppHandle,
    direction: &str,
    msg_type: &str,
    content: &str,
    sender_id: &str,
    sender_name: &str,
    file_path: Option<&str>,
) {
    let chat_state = app.state::<ChatState>();
    let mut msgs = match chat_state.0.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let id = msgs.len() as u64 + 1;
    let mut final_content = content.to_string();
    if (msg_type == "image" || msg_type == "video" || msg_type == "file")
        && !final_content.starts_with("data:")
        && !final_content.starts_with("/download/")
    {
        if let Some(path) = file_path {
            // 聊天窗口的缩略图走 convertFileSrc（asset 协议）。数据目录被重定向到
            // 非默认位置时，asset 默认 scope 覆盖不到，图片就全成了破图——
            // 和剪贴板列表一样，先把路径放行再交给前端。
            let path_obj = std::path::Path::new(path);
            if path_obj.is_file() {
                let _ = app.asset_protocol_scope().allow_file(path_obj);
            }
            let token = format!(
                "{}_{}",
                chrono::Utc::now().timestamp_millis(),
                uuid::Uuid::new_v4()
            );
            let shared_files = app.state::<SharedFileState>();
            if let Ok(mut map) = shared_files.0.lock() {
                map.insert(token.clone(), path.to_string());
            }
            let filename = std::path::Path::new(path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            final_content = format!(
                "/download/{}?name={}",
                token,
                urlencoding::encode(&filename)
            );
        }
    }
    let msg = Message {
        id,
        direction: direction.to_string(),
        msg_type: msg_type.to_string(),
        content: final_content,
        timestamp: chrono::Utc::now().timestamp_millis(),
        sender_id: sender_id.to_string(),
        sender_name: sender_name.to_string(),
        file_path: file_path.map(|s| s.to_string()),
    };
    msgs.push(msg.clone());
    drop(msgs);
    if let Some(ws_state) = app.try_state::<WsBroadcaster>() {
        if let Ok(guard) = ws_state.0.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(serde_json::to_string(&msg).unwrap_or_default());
            }
        }
    }
    let _ = app.emit("new-chat-message", msg);
}

pub async fn register_received_file(
    app_handle: &AppHandle,
    final_path: std::path::PathBuf,
    file_name: String,
    content_type: String,
    sender_id: String,
    sender_name: String,
) {
    let settings = app_handle.state::<SettingsState>();
    let session_hist = app_handle.state::<SessionHistory>();
    let is_image = content_type.starts_with("image/");
    let file_name_lower = file_name.to_lowercase();
    let is_video = content_type.starts_with("video/")
        || [".mp4", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm"]
            .iter()
            .any(|ext| file_name_lower.ends_with(ext));
    let saved_path = final_path.to_string_lossy().to_string();
    let mut preview = format!("[File] {}", file_name);
    let mut type_enum = "file";
    if is_image {
        preview = "[Image]".to_string();
        type_enum = "image";
    } else if is_video {
        preview = "[Video]".to_string();
        type_enum = "video";
    }
    append_message(
        app_handle,
        "in",
        type_enum,
        &saved_path,
        &sender_id,
        &sender_name,
        Some(&saved_path),
    );
    if settings.auto_copy_file.load(Ordering::Relaxed) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let entry = ClipboardEntry {
            id: 0,
            content_type: type_enum.to_string(),
            content: saved_path.clone(),
            html_content: None,
            source_app: "File Transfer".to_string(),
            source_app_path: None,
            timestamp,
            preview,
            is_pinned: false,
            tags: Vec::new(),
            use_count: 0,
            is_external: false,
            pinned_order: 0,
            deleted_at: None,
            file_preview_exists: true,
        };
        if settings.persistent.load(Ordering::Relaxed) {
            let db_state = app_handle.state::<DbState>();
            if let Ok(id) = db_state.repo.save(&entry, None) {
                if id != 0 {
                    let _ = app_handle.emit("clipboard-changed", id);
                }
            }
        } else {
            let id = -(SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_micros() as i64
                / 1000);
            let mut entry_mem = entry;
            entry_mem.id = id;
            if let Ok(mut session) = session_hist.0.lock() {
                session.push_back(entry_mem);
                if session.len() > 500 {
                    if let Some(removed) = session.pop_front() {
                        let _ = app_handle.emit("clipboard-removed", removed.id);
                    }
                }
            }
            let _ = app_handle.emit("clipboard-changed", id);
        }
    }
    if settings.auto_copy_file.load(Ordering::Relaxed) {
        unsafe {
            let _ = crate::infrastructure::windows_api::win_clipboard::set_clipboard_files(vec![
                saved_path,
            ]);
        }
    }
    let db_state = app_handle.state::<DbState>();
    if let Ok(Some(val)) = db_state.settings_repo.get("file_transfer_auto_open") {
        if val == "true" {
            let parent = final_path.parent().unwrap_or(std::path::Path::new("."));
            #[cfg(target_os = "windows")]
            let _ = std::process::Command::new("explorer").arg(parent).spawn();
            #[cfg(target_os = "macos")]
            let _ = std::process::Command::new("open").arg(parent).spawn();
        }
    }
}

#[tauri::command]
pub fn get_file_server_status(app_handle: AppHandle) -> StatusPayload {
    let server_info = app_handle.state::<ServerInfo>();
    let port = server_info.port.load(Ordering::Relaxed);
    let ip = server_info.ip.lock().unwrap().clone();
    StatusPayload {
        enabled: port != 0,
        port,
        ip,
    }
}

#[tauri::command]
pub fn get_app_logo(app_handle: AppHandle) -> String {
    get_app_logo_base64(&app_handle)
}

/// 在线设备快照。设置页挂载时必须主动拉一次：只 listen
/// `online-devices-updated` 的话，手机先连上、设置页后打开，
/// 事件早就发完了，界面会一直停在“0 台设备已连接”。
#[tauri::command]
pub fn get_online_devices(app_handle: AppHandle) -> Vec<DeviceInfo> {
    let devices = app_handle.state::<OnlineDevices>();
    let guard = match devices.0.lock() {
        Ok(guard) => guard,
        Err(_) => return vec![],
    };
    guard.values().cloned().collect()
}
