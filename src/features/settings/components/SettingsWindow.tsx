import { useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronLeft, X } from "lucide-react";
import { translations } from "../../../locales";
import SettingsPanel from "./SettingsPanel";
import ToastContainer from "../../../shared/components/ToastContainer";
import ConfirmDialog from "../../../shared/components/ConfirmDialog";
import { useAppState } from "../../app/hooks/useAppState";
import { useSettingsInit } from "../../../shared/hooks/useSettingsInit";
import { useSettingsPostInit } from "../../../shared/hooks/useSettingsPostInit";
import { useSettingsApply } from "../../../shared/hooks/useSettingsApply";
import { useSettingsSync } from "../../../shared/hooks/useSettingsSync";
import { useAppBootstrap } from "../../../shared/hooks/useAppBootstrap";
import { useCustomBackground } from "../../../shared/hooks/useCustomBackground";
import { useHotkeyConfig } from "../../../shared/hooks/useHotkeyConfig";
import { useAppActions } from "../../../shared/hooks/useAppActions";
import { useOverlays } from "../../../shared/hooks/useOverlays";
import { useToastListener } from "../../../shared/hooks/useToastListener";
import { useSettingsPanelProps } from "../hooks/useSettingsPanelProps";
import { requestFileTransferInMainWindow } from "../lib/settingsWindowControls";

/**
 * Standalone settings window (label: "settings", routed via ?window=settings).
 * Fully separated from the clipboard window: it keeps its own state instance
 * and syncs changes back through the debounced "settings-changed" event,
 * which makes the main window reload settings from the backend.
 */
const SettingsWindow = () => {
    const appState = useAppState();
    const {
        appSettings,
        setAppSettings,
        settingsSubpage,
        setSettingsSubpage,
        setCollapsedGroups,
        settingsLoaded,
        language,
        setLanguage,
        theme,
        setTheme,
        colorMode,
        setColorMode,
        compactMode,
        setCompactMode,
        hotkey,
        setHotkey,
        sequentialHotkey,
        setSequentialHotkey,
        richPasteHotkey,
        setRichPasteHotkey,
        searchHotkey,
        setSearchHotkey,
        quickPasteModifier,
        sequentialMode,
        isRecording,
        setIsRecording,
        isRecordingSequential,
        setIsRecordingSequential,
        isRecordingRich,
        setIsRecordingRich,
        isRecordingSearch,
        setIsRecordingSearch,
        customBackground,
        customBackgroundOpacity,
        surfaceOpacity,
        showAppBorder,
        clipboardItemFontSize,
        clipboardTagFontSize,
        deduplicate,
        captureFiles,
        captureRichText,
        fileTransferAutoCopy,
        fileServerAutoClose,
        fileTransferAutoOpen,
        persistent,
        soundVolume,
        arrowKeySelection,
        setIsKeyboardMode,
        setSelectedIndex,
        setFileTransferPath,
        setInstalledApps,
        setAutoStart,
        setDefaultApps,
        setFileServerEnabled,
        setActualPort,
        setLocalIp,
        setAvailableIps,
        setWinClipboardDisabled,
        mqttEnabled,
        cloudSyncEnabled
    } = appState;

    const tagManagerSizeRef = useRef<{ width: number; height: number } | null>(null);

    const t = useCallback((key: string) => {
        const k = key as keyof typeof translations['zh'];
        return translations[language][k] || translations['en'][k] || key;
    }, [language]);

    // --- Cross-window sync -------------------------------------------------
    const notifyTimerRef = useRef<number | null>(null);
    const notifySettingsChanged = useCallback(() => {
        if (notifyTimerRef.current) window.clearTimeout(notifyTimerRef.current);
        notifyTimerRef.current = window.setTimeout(() => {
            notifyTimerRef.current = null;
            emit("settings-changed").catch(() => { });
        }, 400);
    }, []);

    // --- Persistence helpers (mirror App.tsx, with cross-window notify) ----
    const saveAppSetting = useCallback(async (type: string, path: string) => {
        const key = `app.${type}`;
        setAppSettings(prev => ({ ...prev, [key]: path }));
        try {
            if (type === 'theme') localStorage.setItem('tiez_theme', path);
            if (type === 'color_mode') localStorage.setItem('tiez_color_mode', path);
            if (type === 'compact_mode') localStorage.setItem('tiez_compact_mode', path);
        } catch {
            // Ignore localStorage errors
        }
        try {
            await invoke("save_setting", { key, value: path });
        } catch (err) {
            console.error("保存设置失败", err);
        }
    }, [setAppSettings]);

    const saveSetting = useCallback((key: string, val: string) => {
        invoke("save_setting", { key, value: val })
            .then(() => {
                if (key === "app.emoji_favorites") {
                    return invoke("request_cloud_sync");
                }
                return undefined;
            })
            .catch(console.error);
        notifySettingsChanged();
    }, [notifySettingsChanged]);

    const fetchEffectiveTransferPath = useCallback(() => {
        invoke<string>("get_active_file_transfer_path")
            .then(setFileTransferPath)
            .catch(console.error);
    }, [setFileTransferPath]);

    // --- Settings load/apply pipeline (same hooks as the main window) ------
    const settings = useSettingsInit({
        setAppSettings,
        setHotkey,
        setTheme,
        setColorMode,
        setCompactMode,
        setLanguage
    });

    const postInitProps = { settings, tagManagerSizeRef, ...appState };
    useSettingsPostInit(postInitProps as Parameters<typeof useSettingsPostInit>[0]);

    useAppBootstrap({
        fetchEffectiveTransferPath,
        setDataPath: appState.setDataPath,
        setInstalledApps,
        setAutoStart,
        setDefaultApps,
        setFileServerEnabled,
        setActualPort,
        setLocalIp,
        setAvailableIps,
        setWinClipboardDisabled
    });

    useSettingsApply({
        theme,
        colorMode,
        compactMode,
        settingsLoaded,
        clipboardItemFontSize,
        clipboardTagFontSize,
        surfaceOpacity,
        showAppBorder
    });

    useCustomBackground({ customBackground, customBackgroundOpacity, theme });

    useSettingsSync({
        settingsLoaded,
        deduplicate,
        saveAppSetting,
        captureFiles,
        captureRichText,
        fileTransferAutoCopy,
        fileServerAutoClose,
        fileTransferAutoOpen,
        persistent,
        soundVolume,
        arrowKeySelection,
        setIsKeyboardMode,
        setSelectedIndex
    });

    const { toasts, pushToast, confirmDialog, openConfirm, closeConfirm } = useOverlays();
    useToastListener({ pushToast });

    const {
        saveMqtt: saveMqttBase,
        saveCloudSync: saveCloudSyncBase,
        handleResetSettings
    } = useAppActions({
        t,
        mqttEnabled,
        cloudSyncEnabled,
        openConfirm,
        closeConfirm,
        pushToast,
        fetchHistory: async () => { /* history lives in the main window */ }
    });

    const saveMqtt = useCallback(async (key: string, value: string) => {
        await saveMqttBase(key, value);
        notifySettingsChanged();
    }, [saveMqttBase, notifySettingsChanged]);

    const saveCloudSync = useCallback(async (key: string, value: string) => {
        await saveCloudSyncBase(key, value);
        notifySettingsChanged();
    }, [saveCloudSyncBase, notifySettingsChanged]);

    const {
        checkHotkeyConflict,
        updateHotkey,
        updateSequentialHotkey,
        updateRichPasteHotkey,
        updateSearchHotkey
    } = useHotkeyConfig({
        hotkey,
        setHotkey,
        sequentialHotkey,
        setSequentialHotkey,
        richPasteHotkey,
        setRichPasteHotkey,
        searchHotkey,
        setSearchHotkey,
        sequentialMode,
        isRecording,
        setIsRecording,
        isRecordingSequential,
        setIsRecordingSequential,
        isRecordingRich,
        setIsRecordingRich,
        isRecordingSearch,
        setIsRecordingSearch,
        saveAppSetting,
        t,
        pushToast
    });

    const toggleGroup = useCallback((group: string) => {
        setCollapsedGroups(prev => ({
            ...prev,
            [group]: !prev[group],
        }));
    }, [setCollapsedGroups]);

    const hotkeyParts = useMemo(
        () => (hotkey || '').split('+').map((part) => part.trim()).filter(Boolean),
        [hotkey]
    );

    const settingsPanelProps = useSettingsPanelProps({
        t,
        theme,
        language,
        colorMode,
        hotkeyParts,
        checkHotkeyConflict,
        updateHotkey,
        updateSequentialHotkey,
        updateRichPasteHotkey,
        updateSearchHotkey,
        saveAppSetting,
        saveSetting,
        saveMqtt,
        saveCloudSync,
        fetchEffectiveTransferPath,
        handleResetSettings,
        toggleGroup,
        onOpenChat: requestFileTransferInMainWindow,
        state: appState
    });

    // Live sync: broadcast whenever a persisted setting changes in this window.
    const lastSnapshotRef = useRef<string | null>(null);
    useEffect(() => {
        if (!settingsLoaded) return;
        const snapshot = JSON.stringify({
            appSettings, theme, colorMode, compactMode, language,
            hotkey, sequentialHotkey, richPasteHotkey, searchHotkey, quickPasteModifier
        });
        if (lastSnapshotRef.current === null) {
            lastSnapshotRef.current = snapshot;
            return;
        }
        if (snapshot === lastSnapshotRef.current) return;
        lastSnapshotRef.current = snapshot;
        notifySettingsChanged();
    }, [
        appSettings, theme, colorMode, compactMode, language,
        hotkey, sequentialHotkey, richPasteHotkey, searchHotkey, quickPasteModifier,
        settingsLoaded, notifySettingsChanged
    ]);

    // Final sync on close/reload (covers backend-only writes: MQTT/cloud/reset).
    useEffect(() => {
        const handler = () => { emit("settings-changed").catch(() => { }); };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, []);

    // --- Window chrome ------------------------------------------------------
    const settingsWindow = useMemo(() => {
        try {
            return getCurrentWindow();
        } catch {
            return null;
        }
    }, []);

    const closeWindow = useCallback(() => {
        settingsWindow?.close().catch(() => { });
    }, [settingsWindow]);

    const isSubpage = settingsSubpage !== "home";

    useEffect(() => {
        document.title = t("settings");
    }, [t]);

    return (
        <div className="settings-window-root">
            <header className="settings-window-header">
                <div className="settings-window-drag" data-tauri-drag-region>
                    {isSubpage && (
                        <button
                            className="btn-icon window-no-drag"
                            onClick={() => setSettingsSubpage("home")}
                        >
                            <ChevronLeft size={16} />
                        </button>
                    )}
                    <span className="settings-window-title">
                        {settingsSubpage === "advanced" ? t("advanced_settings") : t("settings")}
                    </span>
                </div>
                <button className="btn-icon window-no-drag" title={t("close")} onClick={closeWindow}>
                    <X size={16} />
                </button>
            </header>

            <main className="settings-window-main">
                <div className="settings-view">
                    <SettingsPanel {...settingsPanelProps} />
                </div>
            </main>

            <ToastContainer toasts={toasts} />

            <ConfirmDialog
                open={confirmDialog.show}
                title={confirmDialog.title}
                message={confirmDialog.message}
                theme={theme}
                confirmLabel={t('confirm')}
                cancelLabel={t('cancel')}
                onClose={closeConfirm}
                onConfirm={confirmDialog.onConfirm}
            />
        </div>
    );
};

export default SettingsWindow;
