import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../../../shared/lib/tauriRuntime";

export const SETTINGS_WINDOW_LABEL = "settings";

/**
 * 冷启动时设置窗口的前端还没挂上监听，emitTo 的事件会被直接丢掉
 * （表现：点“打开对话窗口”没反应）。两个窗口同源、共用同一个 WebView2
 * 用户数据目录，所以用 localStorage 当一次性的交接位：3 秒内有效，
 * 过期即忽略，不会让后来的普通开设置被带进对话模式。
 */
export const PENDING_CHAT_KEY = "tiez.pending_open_chat";
const PENDING_CHAT_TTL_MS = 3000;

export const markPendingOpenChat = (): void => {
    try {
        localStorage.setItem(PENDING_CHAT_KEY, String(Date.now()));
    } catch { /* 隐私模式下 localStorage 会抛，忽略 */ }
};

export const takePendingOpenChat = (): boolean => {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(PENDING_CHAT_KEY);
        if (raw) localStorage.removeItem(PENDING_CHAT_KEY);
    } catch {
        return false;
    }
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at < PENDING_CHAT_TTL_MS;
};

type WebviewWindowCtor = new (
    label: string,
    options: Record<string, unknown>
) => {
    once: (event: string, handler: (e: { payload: unknown }) => void) => void;
    setFocus: () => Promise<void>;
    show: () => Promise<void>;
    unminimize: () => Promise<void>;
};

let cachedCtor: WebviewWindowCtor | null = null;
const loadCtor = async (): Promise<WebviewWindowCtor | null> => {
    if (cachedCtor) return cachedCtor;
    if (!isTauriRuntime()) return null;
    try {
        const mod = await import("@tauri-apps/api/webviewWindow");
        cachedCtor = mod.WebviewWindow as unknown as WebviewWindowCtor;
        return cachedCtor;
    } catch (err) {
        console.error("failed to load webviewWindow module", err);
        return null;
    }
};

let opening: Promise<void> | null = null;

/**
 * Re-raises and focuses the settings window from the Rust side. Windows denies
 * SetForegroundWindow to processes that don't own the foreground (e.g. when
 * settings is opened from the no-activate clipboard popup), which dropped the
 * freshly created window to the bottom of the z-order ("flash then vanish").
 */
const forceSettingsForeground = async (): Promise<void> => {
    await invoke("force_window_foreground", { label: SETTINGS_WINDOW_LABEL }).catch(() => { });
};

/**
 * Opens (or focuses) the standalone settings window. Safe to call repeatedly.
 * options.chat: 打开/聚焦后让设置窗口跳到“文件传输”并进入对话模式。
 */
export const openSettingsWindow = async (options?: { chat?: boolean }): Promise<void> => {
    if (!isTauriRuntime()) return;
    if (opening) return opening;
    opening = (async () => {
        try {
            const notifyChat = async () => {
                if (!options?.chat) return;
                markPendingOpenChat();
                // 窗口已经开着时走事件，等前端挂载的时间留得比冷启动短。
                setTimeout(() => {
                    emitTo(SETTINGS_WINDOW_LABEL, "settings-open-chat", true).catch(() => { });
                }, 350);
            };
            const Ctor = await loadCtor();
            if (!Ctor) return;
            const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
            const existing = await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL);
            if (existing) {
                await existing.unminimize().catch(() => { });
                await existing.show().catch(() => { });
                await existing.setFocus().catch(() => { });
                await forceSettingsForeground();
                await notifyChat();
                return;
            }
            const win = new Ctor(SETTINGS_WINDOW_LABEL, {
                url: "index.html?window=settings",
                title: "TieZ-GuLing",
                width: 980,
                height: 720,
                minWidth: 720,
                minHeight: 480,
                resizable: true,
                decorations: false,
                transparent: true,
                shadow: false,
                skipTaskbar: false,
                alwaysOnTop: false,
                center: true,
                // Created hidden; force_window_foreground shows it in one step
                // so it never flashes on top and then sinks behind the desktop.
                visible: false,
                focus: true,
                dragDropEnabled: true
            });
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(resolve, 2500);
                win.once("tauri://created", () => { clearTimeout(timeout); resolve(); });
                win.once("tauri://error", (event) => {
                    clearTimeout(timeout);
                    console.error("settings window create error", event.payload);
                    resolve();
                });
            });
            await forceSettingsForeground();
            await notifyChat();
        } catch (err) {
            console.error("openSettingsWindow failed", err);
        } finally {
            opening = null;
        }
    })();
    return opening;
};
