import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ToastContainer from "./shared/components/ToastContainer";
import ConfirmDialog from "./shared/components/ConfirmDialog";

import { translations } from "./locales";
import AppHeader from "./features/app/components/AppHeader";
import AppMainContent from "./features/app/components/AppMainContent";
import { useAppState } from "./features/app/hooks/useAppState";
import { useDebounce } from "./shared/hooks/useDebounce";
import { useHistoryFetch } from "./shared/hooks/useHistoryFetch";
import { useInputFocus } from "./shared/hooks/useInputFocus";
import { useSearchScroll } from "./shared/hooks/useSearchScroll";
import { useSettingsApply } from "./shared/hooks/useSettingsApply";
import { useSettingsInit } from "./shared/hooks/useSettingsInit";
import { useSettingsPostInit } from "./shared/hooks/useSettingsPostInit";
import { useSettingsSync } from "./shared/hooks/useSettingsSync";
import { useTagColors } from "./shared/hooks/useTagColors";
import { useClipboardEvents } from "./shared/hooks/useClipboardEvents";
import { useClipboardActions } from "./shared/hooks/useClipboardActions";
import { useMqttListener } from "./shared/hooks/useMqttListener";
import { useSoundEffects } from "./shared/hooks/useSoundEffects";
import { useWindowPinnedListener } from "./shared/hooks/useWindowPinnedListener";
import { useCustomBackground } from "./shared/hooks/useCustomBackground";
import { useToastListener } from "./shared/hooks/useToastListener";
import { useAppBootstrap } from "./shared/hooks/useAppBootstrap";
import { openSettingsWindow } from "./features/settings/lib/settingsWindowControls";
import { useAppActions } from "./shared/hooks/useAppActions";
import { useNavigationSync } from "./shared/hooks/useNavigationSync";
import { useContextMenuBlock } from "./shared/hooks/useContextMenuBlock";
import { useTagManagerRefresh } from "./shared/hooks/useTagManagerRefresh";
import { useAiActions } from "./shared/hooks/useAiActions";
import { matchesHotkey } from "./shared/hooks/useHotkeyMatching";
import { usePinnedSort } from "./shared/hooks/usePinnedSort";
import { useFilteredHistory } from "./shared/hooks/useFilteredHistory";
import { useKeyboardNavigation } from "./shared/hooks/useKeyboardNavigation";
import { useListSelectionReset } from "./shared/hooks/useListSelectionReset";
import { useSearchFetchTrigger } from "./shared/hooks/useSearchFetchTrigger";
import { useScrollToSelection } from "./shared/hooks/useScrollToSelection";
import { useClipboardItemRenderer } from "./shared/hooks/useClipboardItemRenderer";
import { AnnouncementSystem } from "./shared/components/Announcement";
import { useAnnouncements } from "./shared/hooks/useAnnouncements";
import { useOverlays } from "./shared/hooks/useOverlays";
import { useAutoUpdate } from "./shared/hooks/useAutoUpdate";
import UpdateDialog from "./shared/components/UpdateDialog";
import type { ClipboardEntry } from "./shared/types";
import type { QuickPasteHint, VirtualClipboardListHandle } from "./features/clipboard/types";

/** Must match privacy blur checks in `useClipboardItemRenderer` / `ClipboardItem`. */
const BUILTIN_SENSITIVE_TAG_NAMES = ["sensitive", "密码", "password"] as const;
import type { QuickPasteModifier } from "./features/app/types";
import {
  forceHideCompactPreviewWindow,
  isCompactPreviewWindowSupported,
  isCompactPreviewWarmupSupported,
  warmupCompactPreviewWindow
} from "./features/clipboard/lib/compactPreviewControls";
import { isMacPlatform } from "./shared/lib/platform";
import { isTauriRuntime } from "./shared/lib/tauriRuntime";

const insertHistoryItem = (list: ClipboardEntry[], item: ClipboardEntry) => {
  const next = list.slice();
  const isPinned = !!item.is_pinned;
  let insertIndex = 0;

  if (isPinned) {
    while (insertIndex < next.length) {
      const current = next[insertIndex];
      if (!current.is_pinned) break;
      if (current.timestamp < item.timestamp) break;
      insertIndex++;
    }
  } else {
    while (insertIndex < next.length && next[insertIndex].is_pinned) {
      insertIndex++;
    }
    while (insertIndex < next.length) {
      const current = next[insertIndex];
      if (current.is_pinned) {
        insertIndex++;
        continue;
      }
      if (current.timestamp < item.timestamp) break;
      insertIndex++;
    }
  }

  next.splice(insertIndex, 0, item);
  return next;
};

const QUICK_PASTE_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const;

const buildQuickPasteHintsById = (
  items: ClipboardEntry[],
  quickPasteModifier: QuickPasteModifier
): Record<number, QuickPasteHint> => {
  if (quickPasteModifier === "disabled") {
    return {};
  }

  const modifierLabels: Record<Exclude<QuickPasteModifier, "disabled">, string> = isMacPlatform()
    ? {
        ctrl: "⌃",
        alt: "⌥",
        shift: "⇧",
        win: "⌘"
      }
    : {
        ctrl: "Ctrl+",
        alt: "Alt+",
        shift: "Shift+",
        win: "Win+"
      };
  const pinnedItems = items.filter((item) => item.is_pinned).slice(0, QUICK_PASTE_KEYS.length);

  return pinnedItems.reduce<Record<number, QuickPasteHint>>((acc, item, index) => {
    acc[item.id] = {
      slot: index + 1,
      combo: `${modifierLabels[quickPasteModifier]}${QUICK_PASTE_KEYS[index]}`
    };
    return acc;
  }, {});
};

const App = () => {
  type FileTransferSourceView = "clipboard" | "tag_manager" | "emoji_panel";

  const appState = useAppState();
  const {
    showSettings,
    setShowSettings,
    showTagManager,
    setShowTagManager,
    tagManagerEnabled,
    setTagManagerEnabled,
    history,
    setHistory,
    search,
    setSearch,
    isComposing,
    setIsComposing,
    searchIsFocused,
    setSearchIsFocused,
    showTagFilter,
    setShowTagFilter,
    tagInput,
    setTagInput,
    showEmojiPanel,
    setShowEmojiPanel,
    emojiFavorites,
    setEmojiFavorites,
    aiOptionsOpenId,
    setAiOptionsOpenId,
    editingTagsId,
    setEditingTagsId,
    revealedIds,
    setRevealedIds,
    setAutoStart,
    duplicateMode,
    setDuplicateMode,
    persistent,
    setPersistent,
    persistentLimitEnabled,
    setPersistentLimitEnabled,
    persistentLimit,
    setPersistentLimit,
    appSettings,
    setAppSettings,
    setDefaultApps,
    chatMode,
    setChatMode,
    setInstalledApps,
    setDataPath,
    hotkey,
    setHotkey,
    setSequentialHotkey,
    richPasteHotkey,
    setRichPasteHotkey,
    setSearchHotkey,
    quickPasteModifier,
    setQuickPasteModifier,
    setSequentialModeState,
    isRecording,
    isRecordingSequential,
    isRecordingRich,
    isRecordingSearch,
    deleteAfterPaste,
    setDeleteAfterPaste,
    moveToTopAfterPaste,
    setMoveToTopAfterPaste,
    privacyProtection,
    setPrivacyProtection,
    sensitiveMaskPrefixVisible,
    setSensitiveMaskPrefixVisible,
    sensitiveMaskSuffixVisible,
    setSensitiveMaskSuffixVisible,
    sensitiveMaskEmailDomain,
    setSensitiveMaskEmailDomain,
    setPrivacyProtectionKinds,
    setPrivacyProtectionCustomRules,
    setCleanupRules,
    setAppCleanupPolicies,
    captureFiles,
    setCaptureFiles,
    captureRichText,
    setCaptureRichText,
    richTextSnapshotPreview,
    setRichTextSnapshotPreview,
    setSilentStart,
    followMouse: _followMouse,
    setFollowMouse,
    showAppBorder,
    setShowAppBorder,
    winClipboardDisabled: _winClipboardDisabled,
    setWinClipboardDisabled,
    registryWinVEnabled: _registryWinVEnabled,
    setRegistryWinVEnabled,
    pasteMethod: _pasteMethod,
    setPasteMethod,
    theme,
    setTheme,
    colorMode,
    setColorMode,
    showSourceAppIcon,
    setShowSourceAppIcon,

    compactMode,
    setCompactMode,
    clipboardItemFontSize,
    setClipboardItemFontSize,
    clipboardTagFontSize,
    setClipboardTagFontSize,
    emojiPanelEnabled,
    setEmojiPanelEnabled,
    emojiPanelTab,
    setEmojiPanelTab,
    language,
    setLanguage,
    settingsLoaded,
    setSettingsLoaded,
    isWindowPinned,
    setIsWindowPinned,
    showSearchBox,
    setShowSearchBox,
    scrollTopButtonEnabled,
    setScrollTopButtonEnabled,
    arrowKeySelection,
    setArrowKeySelection,
    setHideTrayIcon,
    setHideDockIcon,
    setEdgeDocking,
    customBackground,
    setCustomBackground,
    customBackgroundOpacity,
    setCustomBackgroundOpacity,
    surfaceOpacity,
    setSurfaceOpacity,
    selectedIndex,
    setSelectedIndex,
    isKeyboardMode,
    setIsKeyboardMode,
    isLoadingMore,
    setIsLoadingMore,
    hasMore,
    setHasMore,
    currentOffset,
    setCurrentOffset,
    mqttEnabled,
    setMqttEnabled,
    setMqttServer,
    setMqttPort,
    setMqttUser,
    setMqttPass,
    setMqttTopic,
    setMqttProtocol,
    setMqttWsPath,
    mqttNotificationEnabled,
    setMqttNotificationEnabled,
    cloudSyncEnabled,
    setCloudSyncEnabled,
    setCloudSyncAuto,
    setCloudSyncProvider,
    setCloudSyncServer,
    setCloudSyncApiKey,
    setCloudSyncIntervalSec,
    setCloudSyncSnapshotIntervalMin,
    setCloudSyncWebdavUrl,
    setCloudSyncWebdavUsername,
    setCloudSyncWebdavPassword,
    setCloudSyncWebdavBasePath,
    setCloudSyncContentPrefs,
    fileServerEnabled,
    setFileServerEnabled,
    setFileServerPort,
    localIp,
    setLocalIp,
    setAvailableIps,
    actualPort,
    setActualPort,
    setFileTransferPath,
    setFileTransferAutoOpen,
    setFileTransferAutoCopy,
    setFileServerAutoClose,
    fileTransferAutoOpen,
    fileTransferAutoCopy,
    fileServerAutoClose,
    soundEnabled,
    setSoundEnabled,
    pasteSoundEnabled,
    setPasteSoundEnabled,
    soundVolume,
    setSoundVolume,
    aiEnabled,
    setAiEnabled,
    setAiTargetLang,
    setAiThinkingBudget,
    aiProfiles,
    setAiProfiles,
    setAiAssignedProfileTask,
    setAiAssignedProfileMouthpiece,
    setAiAssignedProfileTranslate,
    processingAiId,
    setProcessingAiId,
    typeFilter,
    setTypeFilter,
    showRecycleBin,
    setShowRecycleBin,
    recycleBinRetentionDays,
    setRecycleBinRetentionDays
  } = appState;

  // --- Auto Update Logic ---
  const {
    isOpen: isUpdateOpen,
    status: updateStatus,
    version: updateVersion,
    notes: updateNotes,
    downloadProgress: updateProgress,
    onStartDownload,
    onApplyUpdate,
    onClose: closeUpdateDialog,
  } = useAutoUpdate();
  // -------------------------

  const effectiveShowEmojiPanel = showEmojiPanel && emojiPanelEnabled;
  const effectiveShowTagManager = showTagManager && tagManagerEnabled;
  const [fileTransferSourceView, setFileTransferSourceView] =
    useState<FileTransferSourceView>("clipboard");

  const debouncedSearch = useDebounce(search, 400);
  const searchInputRef = useInputFocus<HTMLInputElement>();
  const tagColors = useTagColors();
  const virtualListRef = useRef<VirtualClipboardListHandle | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [quickPasteHintsById, setQuickPasteHintsById] = useState<Record<number, QuickPasteHint>>(
    {}
  );
  const PAGE_SIZE = 80;
  const { fetchHistory, loadMoreHistory } = useHistoryFetch({
    debouncedSearch,
    typeFilter,
    persistentLimitEnabled,
    persistentLimit,
    pageSize: PAGE_SIZE,
    currentOffset,
    historyLength: history.length,
    setHistory,
    setCurrentOffset,
    setHasMore,
    isLoadingMore,
    hasMore,
    setIsLoadingMore
  });

  const t = useCallback((key: string) => {
    const k = key as keyof typeof translations['zh'];
    return translations[language][k] || translations['en'][k] || key;
  }, [language]);

  const { handleListScroll: handleSearchScroll, handleMainWheel } = useSearchScroll({
    showSearchBox,
    setShowSearchBox,
    search,
    showSettings,
    showTagManager: effectiveShowTagManager,
    appSettings
  });

  const showScrollTopVisible = showScrollTop && scrollTopButtonEnabled;

  const getCurrentSourceView = useCallback((): FileTransferSourceView => {
    if (effectiveShowTagManager) return "tag_manager";
    if (effectiveShowEmojiPanel) return "emoji_panel";
    return "clipboard";
  }, [effectiveShowEmojiPanel, effectiveShowTagManager]);

  const restoreViewAfterChat = useCallback(
    (sourceView: FileTransferSourceView) => {
      setShowTagManager(sourceView === "tag_manager");
      setShowEmojiPanel(sourceView === "emoji_panel");
    },
    [setShowEmojiPanel, setShowTagManager]
  );

  const openFileTransfer = useCallback(() => {
    const sourceView = getCurrentSourceView();
    setFileTransferSourceView(sourceView);
    setShowTagManager(false);
    setShowEmojiPanel(false);
    setShowRecycleBin(false);
    setChatMode(true);
  }, [getCurrentSourceView, setChatMode, setShowEmojiPanel, setShowRecycleBin, setShowTagManager]);

  const closeFileTransfer = useCallback(() => {
    setChatMode(false);
    restoreViewAfterChat(fileTransferSourceView);
  }, [fileTransferSourceView, restoreViewAfterChat, setChatMode]);

  const handleHeaderBack = useCallback(() => {
    if (chatMode) {
      closeFileTransfer();
      return;
    }
    if (showRecycleBin) {
      setShowRecycleBin(false);
      return;
    }
    if (effectiveShowEmojiPanel) {
      setShowEmojiPanel(false);
      return;
    }
    if (effectiveShowTagManager) {
      setShowTagManager(false);
    }
  }, [
    chatMode,
    closeFileTransfer,
    effectiveShowEmojiPanel,
    effectiveShowTagManager,
    setShowEmojiPanel,
    setShowRecycleBin,
    setShowTagManager,
    showRecycleBin
  ]);

  const handleToggleHeaderChat = useCallback(() => {
    if (chatMode) {
      closeFileTransfer();
      return;
    }
    openFileTransfer();
  }, [chatMode, closeFileTransfer, openFileTransfer]);

  const handleListScroll = useCallback((offset: number) => {
    handleSearchScroll(offset);
    setShowScrollTop(offset > 200);
  }, [handleSearchScroll]);

  const handleScrollTop = useCallback(() => {
    if (virtualListRef.current?.scrollToTop) {
      virtualListRef.current.scrollToTop();
      return;
    }
    virtualListRef.current?.scrollToItem(0);
  }, []);

  // Fetch all tags from the database (not just from loaded history) so the
  // tag filter dropdown and per-item tag suggestions always show every tag.
  const [dbAllTags, setDbAllTags] = useState<string[]>([]);
  const fetchAllTags = useCallback(() => {
    invoke<Record<string, number>>("get_all_tags_info")
      .then((tagCounts) => {
        const tags = [
          ...new Set([
            ...BUILTIN_SENSITIVE_TAG_NAMES,
            ...Object.keys(tagCounts)
          ])
        ].sort((a, b) => a.localeCompare(b));
        setDbAllTags(tags);
      })
      .catch(console.error);
  }, []);

  // Fetch once on mount and re-fetch whenever clipboard history changes
  useEffect(() => { fetchAllTags(); }, [fetchAllTags]);
  useEffect(() => {
    const unlisten = listen("clipboard-changed", () => fetchAllTags());
    const unlistenRemoved = listen("clipboard-removed", () => fetchAllTags());
    return () => { unlisten.then((f) => f()); unlistenRemoved.then((f) => f()); };
  }, [fetchAllTags]);

  const allTags = useMemo(() => {
    if (!effectiveShowTagManager && !showTagFilter && editingTagsId === null) return [];
    return dbAllTags;
  }, [dbAllTags, effectiveShowTagManager, showTagFilter, editingTagsId]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (isRecording || isRecordingSequential || isRecordingRich || isRecordingSearch) return;
      if (!hotkey || hotkey === t('not_set')) return;

      const activeEl = document.activeElement as HTMLElement | null;
      const isEditable = !!activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable
      );

      if (matchesHotkey(event, hotkey)) {
        event.preventDefault();
        invoke("toggle_window_cmd").catch(console.error);
        return;
      }

      if (!isEditable && hotkey.toUpperCase().includes('WIN') && matchesHotkey(event, hotkey, { ignoreWin: true })) {
        event.preventDefault();
        invoke("toggle_window_cmd").catch(console.error);
      }
    };

    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  }, [hotkey, isRecording, isRecordingSequential, isRecordingRich, isRecordingSearch, t]);


  const { toasts, pushToast, confirmDialog, openConfirm, closeConfirm } = useOverlays();

  useSoundEffects({ soundEnabled, pasteSoundEnabled, soundVolume });

  const fetchEffectiveTransferPath = useCallback(() => {
    invoke<string>("get_active_file_transfer_path")
      .then(setFileTransferPath)
      .catch(console.error);
  }, [setFileTransferPath]);

  const { announcements, dismissAnnouncement } = useAnnouncements();

  const tagManagerSizeRef = useRef<{ width: number; height: number } | null>(null);

  const settings = useSettingsInit({
    setAppSettings,
    setHotkey,
    setTheme,
    setColorMode,
    setCompactMode,
    setLanguage
  });

  useSettingsPostInit({
    settings,
    tagManagerSizeRef,
    setCustomBackground,
    setCustomBackgroundOpacity,
    setSurfaceOpacity,
    setClipboardItemFontSize,
    setClipboardTagFontSize,
    setEmojiPanelEnabled,
    setTagManagerEnabled,
    setEmojiPanelTab,
    setEmojiFavorites,
    setPersistent,
    setPersistentLimitEnabled,
    setPersistentLimit,
    setDuplicateMode,
    setCaptureFiles,
    setCaptureRichText,
    setRichTextSnapshotPreview,
    setPrivacyProtection,
    setPrivacyProtectionKinds,
    setPrivacyProtectionCustomRules,
    setSensitiveMaskPrefixVisible,
    setSensitiveMaskSuffixVisible,
    setSensitiveMaskEmailDomain,
    setCleanupRules,
    setAppCleanupPolicies,
    setSilentStart,
    setFollowMouse,
    setShowAppBorder,
    setRegistryWinVEnabled,
    setPasteMethod,
    setShowSourceAppIcon,

    setDeleteAfterPaste,
    setMoveToTopAfterPaste,
    setHideTrayIcon,
    setHideDockIcon,
    setEdgeDocking,
    setShowSearchBox,
    setScrollTopButtonEnabled,
    setArrowKeySelection,
    setMqttEnabled,
    setMqttServer,
    setMqttPort,
    setMqttUser,
    setMqttPass,
    setMqttTopic,
    setMqttProtocol,
    setMqttWsPath,
    setMqttNotificationEnabled,
    setCloudSyncEnabled,
    setCloudSyncAuto,
    setCloudSyncProvider,
    setCloudSyncServer,
    setCloudSyncApiKey,
    setCloudSyncIntervalSec,
    setCloudSyncSnapshotIntervalMin,
    setCloudSyncWebdavUrl,
    setCloudSyncWebdavUsername,
    setCloudSyncWebdavPassword,
    setCloudSyncWebdavBasePath,
    setCloudSyncContentPrefs,
    setFileServerAutoClose,
    setFileTransferAutoOpen,
    setFileTransferAutoCopy,
    setFileServerPort,
    setSequentialHotkey,
    setRichPasteHotkey,
    setSearchHotkey,
    setQuickPasteModifier,
    setSequentialModeState,
    setSoundEnabled,
    setPasteSoundEnabled,
    setSoundVolume,
    setAiEnabled,
    setAiTargetLang,
    setAiThinkingBudget,
    setIsWindowPinned,
    setAiProfiles,
    setAiAssignedProfileTask,
    setAiAssignedProfileMouthpiece,
    setAiAssignedProfileTranslate,
    setSettingsLoaded,
    setRecycleBinRetentionDays
  });

  useEffect(() => {
    if (!isTauriRuntime()) return;

    const unlisten = listen("focus-search-input", () => {
      setShowSettings(false);
      setShowTagManager(false);
      setChatMode(false);
      setShowEmojiPanel(false);
      setShowSearchBox(true);
      setSearchIsFocused(true);
      invoke("activate_window_focus")
        .catch(console.error)
        .finally(() => {
          requestAnimationFrame(() => {
            searchInputRef.current?.focus();
          });
        });
    });

    return () => {
      unlisten.then((off) => off());
    };
  }, [
    setShowSettings,
    setShowTagManager,
    setChatMode,
    setShowEmojiPanel,
    setShowSearchBox,
    setSearchIsFocused,
    searchInputRef
  ]);

  useEffect(() => {
    if (!emojiPanelEnabled && showEmojiPanel) {
      setShowEmojiPanel(false);
    }
  }, [emojiPanelEnabled, showEmojiPanel, setShowEmojiPanel]);

  useEffect(() => {
    if (!tagManagerEnabled && showTagManager) {
      setShowTagManager(false);
    }
  }, [tagManagerEnabled, showTagManager, setShowTagManager]);

  // The standalone settings window asks the main window to open file-transfer chat.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlisten = listen("open-file-transfer", () => {
      openFileTransfer();
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [openFileTransfer]);

  // Tray menu / tray click actions ask the app to open the settings window.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlisten = listen("open-settings-request", () => {
      openSettingsWindow();
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  useAppBootstrap({
    fetchEffectiveTransferPath,
    setDataPath,
    setInstalledApps,
    setAutoStart,
    setDefaultApps,
    setFileServerEnabled,
    setActualPort,
    setLocalIp,
    setAvailableIps,
    setWinClipboardDisabled
  });

  useWindowPinnedListener({
    onPinnedChange: setIsWindowPinned
  });

  useContextMenuBlock();

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

  // Pre-warm compact preview window only where warmup is safe.
  // macOS keeps hover preview enabled but skips warmup to reduce UI stalls.
  // Hover preview works in both normal and compact modes, so warm up unconditionally.
  useEffect(() => {
    if (!isCompactPreviewWindowSupported() || !isCompactPreviewWarmupSupported()) return;
    const timer = setTimeout(() => {
      warmupCompactPreviewWindow();
    }, 2000); // 2s delay: avoids impacting app startup performance
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlisten = listen("force-hide-compact-preview", () => {
      forceHideCompactPreviewWindow();
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  useCustomBackground({ customBackground, customBackgroundOpacity, theme });

  useClipboardEvents({
    onUpdated: (updatedItem) => {
      setHistory(prev => {
        const withoutItem = prev.filter(item => item.id !== updatedItem.id);
        return insertHistoryItem(withoutItem, updatedItem);
      });
    },
    onRemoved: (id) => {
      setHistory(prev => prev.filter(item => item.id !== id));
    },
    onChanged: () => {
      fetchHistory(true);
    }
  });

  useMqttListener({ enabled: mqttNotificationEnabled, t });

  useEffect(() => {
    fetchHistory();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const seededHints = buildQuickPasteHintsById(history, quickPasteModifier);
    setQuickPasteHintsById(seededHints);

    if (quickPasteModifier === "disabled") {
      return () => {
        cancelled = true;
      };
    }

    invoke<ClipboardEntry[]>("get_clipboard_history", {
      limit: 256,
      offset: 0,
      contentType: null
    })
      .then((items) => {
        if (!cancelled) {
          setQuickPasteHintsById(buildQuickPasteHintsById(items, quickPasteModifier));
        }
      })
      .catch((error) => {
        console.error("Failed to refresh quick paste hints:", error);
        if (!cancelled) {
          setQuickPasteHintsById(seededHints);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [history, quickPasteModifier]);

  useToastListener({ pushToast });

  useTagManagerRefresh({
    showTagManager: effectiveShowTagManager,
    settingsLoaded,
    persistentLimitEnabled,
    persistentLimit,
    fetchHistory
  });

  const saveAppSetting = useCallback(async (type: string, path: string) => {
    const key = `app.${type}`;
    console.log(`[THEME DEBUG] saveAppSetting called: key=${key}, value=${path}`);
    setAppSettings(prev => ({ ...prev, [key]: path }));

    // Sync theme-related settings to localStorage for instant startup (prevents flash)
    try {
      if (type === 'theme') localStorage.setItem('tiez_theme', path);
      if (type === 'color_mode') localStorage.setItem('tiez_color_mode', path);
      if (type === 'compact_mode') localStorage.setItem('tiez_compact_mode', path);
    } catch (e) {
      // Ignore localStorage errors
    }

    try {
      await invoke("save_setting", { key, value: path });
      console.log(`[THEME DEBUG] saveAppSetting success: key=${key}`);
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
  }, []);

  useSettingsSync({
    settingsLoaded,
    duplicateMode,
    saveAppSetting,
    captureFiles,
    captureRichText,
    fileTransferAutoCopy,
    fileServerAutoClose,
    fileTransferAutoOpen,
    persistent,
    arrowKeySelection,
    soundVolume,
    setIsKeyboardMode,
    setSelectedIndex
  });

  useNavigationSync({ showSettings, showTagManager: effectiveShowTagManager, chatMode, showEmojiPanel: effectiveShowEmojiPanel });

  const { copyToClipboard, openContent, deleteEntry, togglePin, handleUpdateTags } =
    useClipboardActions({
      t,
      pushToast,
      deleteAfterPaste,
      moveToTopAfterPaste,
      setSearch,
      setHistory,
      virtualListRef
    });

  const { clearHistory } = useAppActions({
    t,
    mqttEnabled,
    cloudSyncEnabled,
    openConfirm,
    closeConfirm,
    pushToast,
    fetchHistory
  });

  const { handleAIAction } = useAiActions({
    aiProfiles,
    language,
    pushToast,
    onOpenSettings: openSettingsWindow,
    setProcessingAiId,
    setHistory
  });

  /* 
  const updateItemContent = async (id: number, newContent: string) => {
    try {
      await invoke("update_item_content", { id, newContent });
      // Local state will be refreshed by fetchHistory triggered by clipboard-changed event
    } catch (err) {
      console.error("Failed to update item content", err);
    }
  };
  */

  const filteredHistory = useFilteredHistory({
    history,
    search,
    typeFilter
  });

  const effectiveHasMore = hasMore && filteredHistory.length >= PAGE_SIZE;

  const { pinnedItems, unpinnedItems, handlePinnedReorder } = usePinnedSort({
    filteredHistory,
    history,
    setHistory
  });

  useListSelectionReset({ filteredHistory, setSelectedIndex });

  useSearchFetchTrigger({ debouncedSearch, isComposing, typeFilter, fetchHistory });

  useScrollToSelection({
    filteredHistory,
    selectedIndex,
    isKeyboardMode,
    pinnedCount: pinnedItems.length,
    virtualListRef
  });

  useKeyboardNavigation({
    filteredHistory,
    selectedIndex,
    setSelectedIndex,
    isKeyboardMode,
    setIsKeyboardMode,
    showSettings,
    showTagManager: effectiveShowTagManager,
    chatMode,
    editingTagsId,
    arrowKeySelection,
    richPasteHotkey,
    searchInputRef,
    copyToClipboard,
    setSearch
  });


  const { renderItemContent } = useClipboardItemRenderer({
    privacyProtection,
    revealedIds,
    isKeyboardMode,
    selectedIndex,
    isWindowPinned,
    editingTagsId,
    tagInput,
    allTags,
    tagColors,
    theme,
    language,
    t,
    showSourceAppIcon,
    compactMode,
    richTextSnapshotPreview,
    sensitiveMaskPrefixVisible,
    sensitiveMaskSuffixVisible,
    sensitiveMaskEmailDomain,
    quickPasteHintsById,
    processingAiId,
    aiEnabled,
    aiOptionsOpenId,
    setAiOptionsOpenId,
    copyToClipboard,
    setSelectedIndex,
    setRevealedIds,
    openContent,
    togglePin,
    deleteEntry,
    setEditingTagsId,
    setTagInput,
    handleUpdateTags,
    handleAIAction
  });

  return (
    <div
      className="app-container"
    >
      <AppHeader
        t={t}
        showSettings={showSettings}
        showTagManager={effectiveShowTagManager}
        setShowTagManager={setShowTagManager}
        tagManagerEnabled={tagManagerEnabled}
        showEmojiPanel={effectiveShowEmojiPanel}
        setShowEmojiPanel={setShowEmojiPanel}
        emojiPanelEnabled={emojiPanelEnabled}
        chatMode={chatMode}
        fileServerEnabled={fileServerEnabled}
        showRecycleBin={showRecycleBin}
        setShowRecycleBin={setShowRecycleBin}
        isWindowPinned={isWindowPinned}
        setIsWindowPinned={setIsWindowPinned}
        clearHistory={clearHistory}
        showSearchBox={showSearchBox}
        search={search}
        setSearch={setSearch}
        setIsComposing={setIsComposing}
        searchInputRef={searchInputRef}
        showTagFilter={showTagFilter}
        setShowTagFilter={setShowTagFilter}
        allTags={allTags}
        tagColors={tagColors}
        searchIsFocused={searchIsFocused}
        setSearchIsFocused={setSearchIsFocused}
        setEditingTagsId={setEditingTagsId}
        theme={theme}
        colorMode={colorMode}
        typeFilter={typeFilter}
        setTypeFilter={setTypeFilter}
        onBack={handleHeaderBack}
        onToggleChat={handleToggleHeaderChat}
        onOpenSettings={openSettingsWindow}
      />

      <AnnouncementSystem
        announcements={announcements}
        onDismiss={dismissAnnouncement}
      />

      <main
        className={`main-content${chatMode ? " file-transfer-mode" : ""}${effectiveShowTagManager ? " tag-manager-mode" : ""}`}
        style={{ 
          overflowY: (showSettings || effectiveShowTagManager) ? 'auto' : 'hidden',
          padding: effectiveShowTagManager ? '0' : undefined
        }}
        onWheel={handleMainWheel}
      >
        <AppMainContent
          t={t}
          theme={theme}
          showTagManager={effectiveShowTagManager}
          tagManagerEnabled={tagManagerEnabled}
          showEmojiPanel={effectiveShowEmojiPanel}
          showRecycleBin={showRecycleBin}
          recycleBinRetentionDays={recycleBinRetentionDays}
          onCloseRecycleBin={() => setShowRecycleBin(false)}
          tagColors={tagColors}
          chatMode={chatMode}
          localIp={localIp}
          actualPort={actualPort}
          emojiFavorites={emojiFavorites}
          setEmojiFavorites={setEmojiFavorites}
          emojiPanelTab={emojiPanelTab}
          setEmojiPanelTab={setEmojiPanelTab}
          saveSetting={saveSetting}
          filteredHistory={filteredHistory}
          search={search}
          pinnedItems={pinnedItems}
          unpinnedItems={unpinnedItems}
          compactMode={compactMode}
          selectedIndex={selectedIndex}
          isKeyboardMode={isKeyboardMode}
          virtualListRef={virtualListRef}
          handlePinnedReorder={handlePinnedReorder}
          renderItemContent={renderItemContent}
          loadMoreHistory={loadMoreHistory}
          handleListScroll={handleListScroll}
          hasMore={effectiveHasMore}
          isLoadingMore={isLoadingMore}
          showScrollTop={showScrollTopVisible}
          onScrollTop={handleScrollTop}
        />
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

      <UpdateDialog
        isOpen={isUpdateOpen}
        version={updateVersion}
        notes={updateNotes}
        downloadProgress={updateProgress}
        status={updateStatus}
        onUpdate={updateStatus === "ready" ? onApplyUpdate : onStartDownload}
        onClose={closeUpdateDialog}
      />
    </div >
  );
}

export default App;
