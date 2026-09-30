import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../../../shared/lib/tauriRuntime";

export const SETTINGS_WINDOW_LABEL = "settings";

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

/** Opens (or focuses) the standalone settings window. Safe to call repeatedly. */
export const openSettingsWindow = async (): Promise<void> => {
    if (!isTauriRuntime()) return;
    if (opening) return opening;
    opening = (async () => {
        try {
            const Ctor = await loadCtor();
            if (!Ctor) return;
            const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
            const existing = await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL);
            if (existing) {
                await existing.unminimize().catch(() => { });
                await existing.show().catch(() => { });
                await existing.setFocus().catch(() => { });
                await forceSettingsForeground();
                return;
            }
            const win = new Ctor(SETTINGS_WINDOW_LABEL, {
                url: "index.html?window=settings",
                title: "TieZ Settings",
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
                dragDropEnabled: false
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
            // WebView2 settles after init and can re-order windows; re-assert.
            setTimeout(() => { void forceSettingsForeground(); }, 250);
        } catch (err) {
            console.error("openSettingsWindow failed", err);
        } finally {
            opening = null;
        }
    })();
    return opening;
};

/** Used by the settings window itself: request the main window to open file-transfer chat. */
export const requestFileTransferInMainWindow = async (): Promise<void> => {
    try {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("open-file-transfer");
        // focus_clipboard_window shows + focuses the main window (activate_window_focus
        // only focuses, which would leave a docked/hidden main window invisible).
        await invoke("focus_clipboard_window").catch(() => { });
    } catch (err) {
        console.error("requestFileTransferInMainWindow failed", err);
    }
};
