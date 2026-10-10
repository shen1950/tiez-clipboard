use chrono::{DateTime, Utc};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 诊断日志只追加、从不轮转，一次失控的前端补偿循环 15 分钟就能写出 30MB。
/// 启动时把超限的旧日志整体挪到 .old（只留一份，不静默丢历史）。
const LOG_MAX_BYTES: u64 = 16 * 1024 * 1024;

pub fn init(path: PathBuf) {
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > LOG_MAX_BYTES {
            let old = path.with_extension("log.old");
            let _ = std::fs::rename(&path, &old);
        }
    }
    let mut guard = LOG_PATH.lock().unwrap();
    *guard = Some(path);
}

pub fn log(msg: &str) {
    if let Ok(guard) = LOG_PATH.lock() {
        if let Some(path) = &*guard {
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
                let now: DateTime<Utc> = SystemTime::now().into();
                let timestamp = now.format("%Y-%m-%d %H:%M:%S%.3f").to_string();
                let _ = writeln!(f, "[{}] {}", timestamp, msg);
            }
        }
    }
    // Also print to console for development
    println!("{}", msg);
}

#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => {
        $crate::logger::log(&format!($($arg)*))
    };
}

#[macro_export]
macro_rules! warn {
    ($($arg:tt)*) => {
        $crate::logger::log(&format!("[WARN] {}", format!($($arg)*)))
    };
}

#[macro_export]
macro_rules! error {
    ($($arg:tt)*) => {
        $crate::logger::log(&format!("[ERROR] {}", format!($($arg)*)))
    };
}
