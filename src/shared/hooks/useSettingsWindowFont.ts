import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveUiFontFamily } from "../config/fonts";

export const SETTINGS_ZOOM_MIN = 0.8;
export const SETTINGS_ZOOM_MAX = 1.6;
export const DEFAULT_SETTINGS_ZOOM = 1;

export const clampSettingsZoom = (value: number) =>
    Math.min(SETTINGS_ZOOM_MAX, Math.max(SETTINGS_ZOOM_MIN, value));

/** 只改字体族：--font-main 是 base.css 里 body 的字体来源，覆盖它即整窗生效。 */
export const applySettingsFontFamily = (value?: string | null) => {
    const family = resolveUiFontFamily(value);
    const root = document.documentElement;
    if (family) root.style.setProperty("--font-main", family);
    else root.style.removeProperty("--font-main");
};

/**
 * 字号走 webview zoom：整窗（含图标、间距）一起缩放，比逐个改 px 变量可靠。
 * 值完全由用户在「界面设置」里定，这里不做任何自动 DPI 校正——
 * 上一轮那个自动校正会把窗口压到 0.667，字反而变小。
 */
export const applySettingsZoom = (zoom: number) =>
    invoke("set_window_zoom", { label: "settings", scale: clampSettingsZoom(zoom) }).catch(() => { });

export const useSettingsWindowFont = (ready: boolean) => {
    useEffect(() => {
        if (!ready) return;
        let cancelled = false;
        invoke<Record<string, string>>("get_settings")
            .then((settings) => {
                if (cancelled) return;
                applySettingsFontFamily(settings?.["app.settings_font_family"]);
                const raw = parseFloat(settings?.["app.settings_zoom"] || "");
                const zoom = Number.isFinite(raw) ? raw : DEFAULT_SETTINGS_ZOOM;
                if (zoom !== 1) applySettingsZoom(zoom);
            })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [ready]);
};
