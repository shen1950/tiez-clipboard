import { useRef, useEffect, useLayoutEffect, useState, useMemo, memo } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cursorPosition, getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
    Pin,
    PinOff,
    Eye,
    EyeOff,
    ExternalLink,
    Tag,
    X,
    FileText,
    Image as ImageIcon,
    Link as LinkIcon,
    Code,
    File,
    Plus,
    Video,
    Sparkles,
    Loader2,
    FileArchive,
    Music,
    FileCode,
    Cpu,
    Files,
    ImageOff,
    FileQuestion,
    GripVertical
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { ClipboardItemProps } from "../types";
import {
    formatSensitivePreview,
    getConciseTime,
    getTagColor,
    getTagTextColor
} from "../../../shared/lib/utils";
import HtmlContent from "../../../shared/components/HtmlContent";
import { toTauriLocalImageSrc } from "../../../shared/lib/localImageSrc";
import { getRichTextSnapshotDataUrl } from "../../../shared/lib/richTextSnapshot";
import { getFileIcon as getSystemFileIcon, peekFileIcon } from "../../../shared/lib/fileIcon";
import { getSourceAppIcon, peekSourceAppIcon } from "../../../shared/lib/sourceAppIcon";
import { registerCompactPreviewControls } from "../lib/compactPreviewControls";
import {
    PREVIEW_PANEL,
    computePreviewPanelSize,
    resolvePreviewMonitor,
    cardRectToPhysical,
    resolvePreviewPlacement,
    type PreviewRect
} from "../lib/previewPanelSize";

const COMPACT_PREVIEW_LABEL = "compact-preview";
const RICH_IMAGE_FALLBACK_PREFIX = "<!--TIEZ_RICH_IMAGE:";
const RICH_IMAGE_FALLBACK_SUFFIX = "-->";
const TABULAR_RICH_HTML_RE = /<(table|tr|td|th|thead|tbody|tfoot|colgroup|col)\b/i;
const SPREADSHEET_SOURCE_RE = /\b(excel|et|wps|sheet|spreadsheet|calc)\b/i;
const SPREADSHEET_APP_RE = /(?:^|[\\/])(excel|et|wps|wpssheet|soffice)(?:\.exe|\.app)?$/i;
const STANDALONE_COLOR_RE = /^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\(\s*[^)]+\s*\))$/i;
const COMPACT_PREVIEW_DEBUG = false;
const IS_MACOS =
    typeof navigator !== "undefined" &&
    (/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform));
const COMPACT_PREVIEW_WINDOW_SUPPORTED = true;
const COMPACT_PREVIEW_WARMUP_SUPPORTED = !IS_MACOS;
const compactPreviewLog = (...args: unknown[]) => {
    if (!COMPACT_PREVIEW_DEBUG) return;
    const ts = new Date().toISOString();
    console.log(`[CompactPreview][Main][${ts}]`, ...args);
};
const richPreviewFailureLog = (stage: string, detail?: Record<string, unknown>) => {
    console.warn("[RichTextPreview][MainList]", stage, detail || {});
};
const extractRichImageFallback = (html?: string): { cleanHtml?: string; imagePayload?: string } => {
    if (!html) return {};
    const start = html.lastIndexOf(RICH_IMAGE_FALLBACK_PREFIX);
    if (start < 0) return { cleanHtml: html };

    const markerStart = start + RICH_IMAGE_FALLBACK_PREFIX.length;
    const endRel = html.slice(markerStart).indexOf(RICH_IMAGE_FALLBACK_SUFFIX);
    if (endRel < 0) return { cleanHtml: html };

    const markerEnd = markerStart + endRel;
    const payload = html.slice(markerStart, markerEnd).trim();
    const cleanHtml = `${html.slice(0, start)}${html.slice(markerEnd + RICH_IMAGE_FALLBACK_SUFFIX.length)}`.trim();
    return {
        cleanHtml: cleanHtml || html,
        imagePayload: payload || undefined
    };
};

const resolveRichImageSrc = (payload?: string): string | null => {
    if (!payload) return null;
    const value = payload.trim();
    if (!value) return null;
    if (value.startsWith("data:image/")) return value;
    if (/^https?:\/\/asset\.localhost\//i.test(value)) return value;
    return toTauriLocalImageSrc(value);
};

const isAnimatedGifSrc = (src?: string | null): boolean => {
    const value = (src || "").trim().toLowerCase();
    if (!value) return false;
    return value.startsWith("data:image/gif") || /\.gif(?:$|[?#])/i.test(value);
};

const richHtmlLooksTabular = (html?: string): boolean => {
    if (!html) return false;
    return TABULAR_RICH_HTML_RE.test(html);
};

const isSpreadsheetLikeSource = (...candidates: Array<string | undefined>): boolean => {
    return candidates.some((candidate) => {
        const value = (candidate || "").trim();
        if (!value) return false;
        return SPREADSHEET_APP_RE.test(value) || SPREADSHEET_SOURCE_RE.test(value);
    });
};

const getStandaloneColorValue = (contentType: string, content: string): string | null => {
    if (contentType !== "text" && contentType !== "code") {
        return null;
    }

    const normalized = content.trim();
    if (!normalized || normalized.includes("\n")) {
        return null;
    }

    return STANDALONE_COLOR_RE.test(normalized) ? normalized : null;
};

let compactPreviewWindow: WebviewWindow | null = null;
let compactPreviewCreating = false;
let compactPreviewReady: Promise<WebviewWindow | null> | null = null;
let compactPreviewMounted = false;
let compactPreviewMountedPromise: Promise<boolean> | null = null;
let compactPreviewLifecycleListenersReady: Promise<void> | null = null;
// KwikPaste：方向只按条目判定一次并锁定，指针在卡片内横移不会让面板换边。
const previewSideLatch = new Map<string, boolean>();
// 最近一次摆放的面板矩形（物理 px）：隐藏定时器触发时用它判断鼠标是否悬停在面板上，
// 不依赖预览窗口自己的鼠标事件是否送达。
let previewPanelRectPhysical: { left: number; top: number; width: number; height: number } | null = null;
// 离开卡片后的隐藏缓冲：卡片间移动时先不收起，进入新卡片会取消（KwikPaste 240ms）。
const PREVIEW_HIDE_BUFFER_MS = 500;
let previewHideTimer: ReturnType<typeof setTimeout> | null = null;

const loadWebviewWindowModule = async () => import("@tauri-apps/api/webviewWindow");

const setIgnoreBlurSafe = (ignore: boolean) => {
    compactPreviewLog("set_ignore_blur", { ignore });
    invoke("set_ignore_blur", { ignore }).catch(() => { });
};

const cancelPreviewHideTimer = () => {
    if (previewHideTimer) {
        clearTimeout(previewHideTimer);
        previewHideTimer = null;
    }
};

const schedulePreviewHide = (hide: () => void) => {
    cancelPreviewHideTimer();
    previewHideTimer = setTimeout(async () => {
        previewHideTimer = null;
        // 面板悬停保护：鼠标还在预览面板上时绝不隐藏（即使面板自身的
        // 鼠标事件没送达，这里也能在主窗口侧兜底）。
        const rect = previewPanelRectPhysical;
        if (rect) {
            try {
                const cursor = await cursorPosition();
                const inside =
                    cursor.x >= rect.left
                    && cursor.x < rect.left + rect.width
                    && cursor.y >= rect.top
                    && cursor.y < rect.top + rect.height;
                if (inside) {
                    schedulePreviewHide(hide);
                    return;
                }
            } catch {
                // 拿不到光标位置就按原逻辑隐藏。
            }
        }
        hide();
    }, PREVIEW_HIDE_BUFFER_MS);
};

/**
 * KwikPaste 式一次性开窗：尺寸与位置在显示前就算好，setSize → setPosition → show
 * 一气呵成。窗口显示后不再有任何 resize 往返，所以面板不会跳、不会闪。
 */
const showPreviewWindowAt = async (
    bounds: { x: number; y: number },
    widthLogical: number,
    heightLogical: number
) => {
    const previewWindow = compactPreviewWindow;
    if (!previewWindow) return;

    setIgnoreBlurSafe(true);
    try {
        // 面板接受鼠标（可悬停、可滚动）；每次显示前再确保一次。
        await previewWindow.setIgnoreCursorEvents(false).catch(() => { });
        await previewWindow.setSize(new LogicalSize(widthLogical, heightLogical));
        await previewWindow.setPosition(new PhysicalPosition(bounds.x, bounds.y));
        await previewWindow.show();
        // Force top-most z-order refresh so preview is not occluded by the main top-most window.
        // macOS skips this toggle because frequent style-mask sync can cause UI stalls.
        if (!IS_MACOS) {
            try {
                await previewWindow.setAlwaysOnTop(false);
                await previewWindow.setAlwaysOnTop(true);
            } catch (stackErr) {
                compactPreviewLog("refresh always-on-top stacking failed", stackErr);
            }
        }
        compactPreviewLog("preview window shown", { bounds, widthLogical, heightLogical });
    } catch (err) {
        setIgnoreBlurSafe(false);
        compactPreviewLog("preview show failed", err);
        throw err;
    }
};

const hideCompactPreviewGlobal = async () => {
    const previewWindow = compactPreviewWindow;
    compactPreviewLog("hide preview requested", { hasWindow: !!previewWindow });
    cancelPreviewHideTimer();
    previewSideLatch.clear();
    setIgnoreBlurSafe(false);

    if (!previewWindow) return;

    try {
        await previewWindow.hide();
        const visible = await previewWindow.isVisible().catch(() => null);
        compactPreviewLog("preview window hidden", { visible });
    } catch (err) {
        console.error("Failed to hide compact preview window:", err);
        compactPreviewLog("hide preview failed, reset window reference", err);
        compactPreviewWindow = null;
        compactPreviewMounted = false;
        compactPreviewMountedPromise = null;
    }
};


const seekVideoPreviewFrame = (video: HTMLVideoElement | null) => {
    if (!video) return;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const maxSeek = Math.max(duration - 0.05, 0);
    if (maxSeek <= 0) return;
    const preferred = Math.min(duration * 0.1, 2);
    const target = Math.min(Math.max(preferred, 0.1), maxSeek);
    if (target <= 0) return;
    try {
        video.currentTime = target;
    } catch {
        // Ignore seek errors; fallback will just show the first frame.
    }
};

const waitForCompactPreviewMounted = async (): Promise<boolean> => {
    if (compactPreviewMounted) {
        compactPreviewLog("mounted already true, skip wait");
        return true;
    }
    if (!compactPreviewMountedPromise) {
        compactPreviewLog("waiting compact preview mounted event...");
        compactPreviewMountedPromise = new Promise(async (resolve) => {
            const timeout = setTimeout(() => {
                compactPreviewLog("wait compact-preview-mounted timeout");
                resolve(false);
            }, 1200);
            try {
                const unlisten = await listen("compact-preview-mounted", () => {
                    compactPreviewMounted = true;
                    clearTimeout(timeout);
                    unlisten();
                    compactPreviewLog("received compact-preview-mounted");
                    resolve(true);
                });
            } catch (err) {
                clearTimeout(timeout);
                console.error("Failed to listen for compact preview ready:", err);
                compactPreviewLog("listen compact-preview-mounted failed", err);
                resolve(false);
            }
        });
    }
    return compactPreviewMountedPromise;
};

const ensureCompactPreviewLifecycleListeners = async (): Promise<void> => {
    if (compactPreviewLifecycleListenersReady) {
        await compactPreviewLifecycleListenersReady;
        return;
    }

    compactPreviewLifecycleListenersReady = (async () => {
        const lifecycleEvents = ["tauri://hide", "tauri://close-requested", "tauri://destroyed"];
        await Promise.all([
            ...lifecycleEvents.map(async (eventName) => {
                try {
                    compactPreviewLog("bind lifecycle listener", eventName);
                    await listen(eventName, () => {
                        compactPreviewLog("lifecycle event -> hide preview", eventName);
                        void hideCompactPreviewGlobal();
                    });
                } catch (err) {
                    console.error(`Failed to bind compact preview lifecycle listener: ${eventName}`, err);
                    compactPreviewLog("bind lifecycle listener failed", { eventName, err });
                }
            }),
            // 预览面板接受鼠标（KwikPaste 同款）：指针停在面板上时取消收起，
            // 离开面板后按同样的缓冲收起——这样面板可以滚动、可以悬停阅读。
            (async () => {
                try {
                    await listen<boolean>("compact-preview-pointer", (event) => {
                        if (event.payload) {
                            cancelPreviewHideTimer();
                        } else {
                            schedulePreviewHide(() => { void hideCompactPreviewGlobal(); });
                        }
                    });
                } catch (err) {
                    console.error("Failed to bind preview pointer listener:", err);
                }
            })()
        ]);
    })();

    await compactPreviewLifecycleListenersReady;
};

const tryReuseExistingCompactPreviewWindow = async (): Promise<WebviewWindow | null> => {
    try {
        const { WebviewWindow } = await loadWebviewWindowModule();
        const existing = await WebviewWindow.getByLabel(COMPACT_PREVIEW_LABEL);
        if (!existing) {
            compactPreviewLog("no existing compact preview window by label");
            return null;
        }

        const visible = await existing.isVisible().catch(() => null);
        compactPreviewLog("reuse compact preview window by label", { visible });
        compactPreviewWindow = existing;
        compactPreviewMounted = true;
        compactPreviewMountedPromise = Promise.resolve(true);
        try {
            await existing.setIgnoreCursorEvents(false);
        } catch { }
        try {
            await existing.setAlwaysOnTop(true);
        } catch { }
        return existing;
    } catch (err) {
        compactPreviewLog("reuse compact preview window by label failed", err);
        return null;
    }
};

const ensureCompactPreviewWindow = async (): Promise<WebviewWindow | null> => {
    if (!COMPACT_PREVIEW_WINDOW_SUPPORTED) return null;
    if (compactPreviewWindow) {
        compactPreviewMounted = true;
        compactPreviewMountedPromise = Promise.resolve(true);
        compactPreviewLog("reuse existing compact preview window");
        return compactPreviewWindow;
    }
    if (compactPreviewReady) return compactPreviewReady;
    if (compactPreviewCreating) return null;
    const reusedBeforeCreate = await tryReuseExistingCompactPreviewWindow();
    if (reusedBeforeCreate) {
        return reusedBeforeCreate;
    }
    compactPreviewLog("create compact preview window start");
    compactPreviewCreating = true;
    compactPreviewReady = (async () => {
        try {
            const { WebviewWindow } = await loadWebviewWindowModule();
            const previewWindow = new WebviewWindow(COMPACT_PREVIEW_LABEL, {
                url: "index.html?window=compact-preview",
                decorations: false,
                transparent: true,
                resizable: false,
                skipTaskbar: true,
                alwaysOnTop: true,
                visible: false,
                focus: false,
                focusable: false,
                shadow: false
            });

            compactPreviewMounted = false;
            compactPreviewMountedPromise = null;
            compactPreviewLog("compact preview window instance created, waiting tauri://created");

            const created = await new Promise<boolean>((resolve) => {
                const timeout = setTimeout(() => resolve(false), 1500);
                previewWindow.once("tauri://created", () => {
                    clearTimeout(timeout);
                    compactPreviewLog("compact preview tauri://created");
                    resolve(true);
                });
                previewWindow.once("tauri://error", (event) => {
                    clearTimeout(timeout);
                    compactPreviewLog("compact preview tauri://error", event.payload);
                    resolve(false);
                });
            });

            if (!created) {
                compactPreviewLog("compact preview create timeout/failure, try reuse by label");
                const reusedAfterFailedCreate = await tryReuseExistingCompactPreviewWindow();
                if (reusedAfterFailedCreate) {
                    return reusedAfterFailedCreate;
                }
                return null;
            }

            try {
                await previewWindow.setSize(new PhysicalSize(1, 1));
            } catch (err) {
                console.error("Failed to initialize compact preview size:", err);
            }

            try {
                await previewWindow.setIgnoreCursorEvents(false);
            } catch (err) {
                console.error("Failed to enable ignore cursor events:", err);
            }

            compactPreviewWindow = previewWindow;
            compactPreviewLog("compact preview window ready");
            return previewWindow;
        } catch (err) {
            console.error("Failed to create compact preview window:", err);
            compactPreviewLog("create compact preview window failed", err);
            return null;
        } finally {
            compactPreviewCreating = false;
            compactPreviewReady = null;
        }
    })();
    return compactPreviewReady;
};

/**
 * Pre-warm the compact preview window so it's ready before the user hovers.
 * On macOS we deliberately skip warmup to reduce startup-time UI stalls.
 */
const warmupCompactPreviewWindow = () => {
    if (!COMPACT_PREVIEW_WINDOW_SUPPORTED || !COMPACT_PREVIEW_WARMUP_SUPPORTED) return;
    // Only warm up if not already created/creating
    if (compactPreviewWindow || compactPreviewCreating || compactPreviewReady) return;
    compactPreviewLog("warmup: pre-creating compact preview window");
    // Fire and forget - creates the window in the background
    ensureCompactPreviewWindow().catch((err) => {
        compactPreviewLog("warmup: failed", err);
    });
};

const isCompactPreviewWindowSupported = () => COMPACT_PREVIEW_WINDOW_SUPPORTED;
const isCompactPreviewWarmupSupported = () => COMPACT_PREVIEW_WARMUP_SUPPORTED;

const forceHideCompactPreviewWindow = () => {
    void hideCompactPreviewGlobal();
};

registerCompactPreviewControls({
    forceHide: forceHideCompactPreviewWindow,
    warmup: warmupCompactPreviewWindow,
    supported: isCompactPreviewWindowSupported,
    warmupSupported: isCompactPreviewWarmupSupported,
});

const getIcon = (type: string) => {
    switch (type) {
        case "text": return <FileText size={14} />;
        case "image": return <ImageIcon size={14} />;
        case "url": return <LinkIcon size={14} />;
        case "code": return <Code size={14} />;
        case "file": return <File size={14} />;
        case "video": return <Video size={14} />;
        default: return <FileText size={14} />;
    }
};

const renderSourceAppIcon = (iconSrc: string | null, contentType: string, sourceApp: string) => {
    if (!iconSrc) {
        return getIcon(contentType);
    }

    return (
        <img
            src={iconSrc}
            alt={`${sourceApp} icon`}
            className="source-app-icon"
            loading="lazy"
        />
    );
};

const getFallbackFileIcon = (filePath: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'zip':
        case 'rar':
        case '7z':
        case 'tar':
        case 'gz':
            return <FileArchive size={20} />;
        case 'mp3':
        case 'wav':
        case 'flac':
        case 'm4a':
            return <Music size={20} />;
        case 'exe':
        case 'msi':
        case 'bat':
        case 'sh':
            return <Cpu size={20} />;
        case 'pdf':
        case 'doc':
        case 'docx':
        case 'ppt':
        case 'pptx':
        case 'xls':
        case 'xlsx':
            return <FileText size={20} />;
        case 'js':
        case 'ts':
        case 'tsx':
        case 'jsx':
        case 'py':
        case 'rs':
        case 'c':
        case 'cpp':
        case 'go':
        case 'java':
        case 'html':
        case 'css':
        case 'json':
            return <FileCode size={20} />;
        default:
            return <File size={20} />;
    }
};

const ClipboardItem = ({
    item,
    isSelected,
    isSensitiveHidden,
    isRevealed,
    isEditingTags,
    tagInput,
    tagSuggestions = [],
    theme,
    language,
    t,
    isAIProcessing,
    onSelect,
    onCopy,
    onToggleReveal,
    onOpen,
    onTogglePin,
    onDelete,
    onToggleTagEditor,
    onTagInput,
    onTagAdd,
    onTagPick,
    onTagEditCancel,
    onTagDelete,
    onAIAction,
    onInputSubmit,
    aiEnabled,
    aiOptionsOpen,
    onAIOptionsToggle,
    tagColors,
    richTextSnapshotPreview = false,
    showSourceAppIcon = true,
    sensitiveMaskPrefixVisible = 3,
    sensitiveMaskSuffixVisible = 3,
    sensitiveMaskEmailDomain = false,
    quickPasteHint,
    dragControls,
    id,
    compactMode,
    className,
    disableLayout
}: ClipboardItemProps & { compactMode?: boolean, className?: string }) => {
    const itemRef = useRef<HTMLDivElement | null>(null);
    const tagInputRef = useRef<HTMLInputElement>(null);
    const [localTagInput, setLocalTagInput] = useState(tagInput);
    const [localAiOptionsOpen, setLocalAiOptionsOpen] = useState(!!aiOptionsOpen);
    const [snapshotFailed, setSnapshotFailed] = useState(false);
    const [failedImageSource, setFailedImageSource] = useState<string | null>(null);
    const [richImageFallbackFailed, setRichImageFallbackFailed] = useState(false);
    const [sourceAppIcon, setSourceAppIcon] = useState<string | null>(() => peekSourceAppIcon(item.source_app_path) ?? null);
    const filePaths = useMemo(
        () => item.content_type === "file" ? item.content.split('\n').filter((p) => p.trim()) : [],
        [item.content, item.content_type]
    );
    const singleFilePath = filePaths.length === 1 ? filePaths[0] : null;
    const [fileIcon, setFileIcon] = useState<string | null>(() => peekFileIcon(singleFilePath) ?? null);
    const isComposing = useRef(false);
    const richSnapshotImgRef = useRef<HTMLImageElement | null>(null);
    const richSnapshotFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverRequestIdRef = useRef(0);
    // Rich-text HTML is fetched on demand: list/search responses no longer carry
    // html_content (it dominates storage), so visible items lazy-load it by id.
    const [lazyHtml, setLazyHtml] = useState<string | null>(null);
    const lazyHtmlIdRef = useRef<number | null>(null);
    useEffect(() => {
        if (lazyHtmlIdRef.current !== item.id) {
            lazyHtmlIdRef.current = item.id;
            setLazyHtml(null);
        }
        if (item.content_type !== "rich_text" || item.html_content != null) return;
        let cancelled = false;
        invoke<string | null>("get_entry_html", { id: item.id })
            .then((html) => {
                if (!cancelled && html) setLazyHtml(html);
            })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [item.id, item.content_type, item.html_content]);
    const itemHtml = item.html_content ?? lazyHtml ?? undefined;
    const richTextFallback = item.content_type === "rich_text" && itemHtml
        ? (() => {
            const { cleanHtml, imagePayload } = extractRichImageFallback(itemHtml);
            return {
                cleanHtml: cleanHtml || itemHtml,
                imagePayload,
                imageSrc: resolveRichImageSrc(imagePayload)
            };
        })()
        : null;
    const pickableTagSuggestions = useMemo(() => {
        if (!isEditingTags) return [];
        const existing = new Set(item.tags || []);
        const q = localTagInput.trim().toLowerCase();
        // Show every tag from the DB (popover scrolls); truncating here made
        // some tags impossible to pick from the suggestion list.
        return tagSuggestions
            .filter((tag) => !existing.has(tag))
            .filter((tag) => !q || tag.toLowerCase().includes(q));
    }, [isEditingTags, item.tags, localTagInput, tagSuggestions]);

    const [tagSuggestIndex, setTagSuggestIndex] = useState(-1);
    const tagSuggestListRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!isEditingTags) setTagSuggestIndex(-1);
    }, [isEditingTags]);

    useEffect(() => {
        setTagSuggestIndex((prev) => {
            if (pickableTagSuggestions.length === 0) return -1;
            if (prev < 0) return -1;
            return Math.min(prev, pickableTagSuggestions.length - 1);
        });
    }, [pickableTagSuggestions]);

    useLayoutEffect(() => {
        if (tagSuggestIndex < 0 || !tagSuggestListRef.current) return;
        const row = tagSuggestListRef.current.children[tagSuggestIndex] as HTMLElement | undefined;
        row?.scrollIntoView({ block: "nearest" });
    }, [tagSuggestIndex, pickableTagSuggestions]);

    useEffect(() => {
        if (!isEditingTags || !onTagEditCancel) return;

        const onDocMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            const root = itemRef.current;
            if (!root) return;
            const t = e.target as HTMLElement;

            if (root.contains(t)) {
                if (t.closest(".tag-edit-anchor")) return;
                if (t.closest(".item-tags-container .tag-chip")) return;
                if (
                    t.closest("button") ||
                    t.closest("input") ||
                    t.closest("textarea") ||
                    t.closest('[role="button"]') ||
                    t.closest(".drag-handle")
                ) {
                    return;
                }
            }

            onTagEditCancel();
            e.preventDefault();
            e.stopPropagation();
        };

        document.addEventListener("mousedown", onDocMouseDown, true);
        return () => document.removeEventListener("mousedown", onDocMouseDown, true);
    }, [isEditingTags, onTagEditCancel]);

    const sensitivePreview = useMemo(
        () => formatSensitivePreview(item.content, item.content_type, {
            prefixVisible: sensitiveMaskPrefixVisible,
            suffixVisible: sensitiveMaskSuffixVisible,
            maskEmailDomain: sensitiveMaskEmailDomain,
        }),
        [
            item.content,
            item.content_type,
            sensitiveMaskPrefixVisible,
            sensitiveMaskSuffixVisible,
            sensitiveMaskEmailDomain
        ]
    );
    const richTextCleanHtml = richTextFallback?.cleanHtml || itemHtml || "";
    const richTextSnapshotDisplayMaxHeight = compactMode ? 40 : 64;
    const richTextSnapshotRenderMaxHeight = compactMode ? 100 : 200;
    const spreadsheetLikeRichSource = item.content_type === "rich_text"
        && !!itemHtml
        && isSpreadsheetLikeSource(item.source_app, item.source_app_path);
    const richTextHasAnimatedImageFallback = isAnimatedGifSrc(
        richTextFallback?.imagePayload || richTextFallback?.imageSrc || null
    );
    const preferHtmlRichPreview = item.content_type === "rich_text"
        && !!itemHtml
        && !richTextHasAnimatedImageFallback
        && !richHtmlLooksTabular(richTextCleanHtml)
        && !spreadsheetLikeRichSource;
    const preferGeneratedRichPreview = item.content_type === "rich_text"
        && !!itemHtml
        && !preferHtmlRichPreview
        && (
            !!richTextSnapshotPreview
            || richHtmlLooksTabular(richTextCleanHtml)
            || spreadsheetLikeRichSource
        );
    const richTextSnapshotSrc = useMemo(() => {
        if (!preferGeneratedRichPreview) return null;
        if (item.content_type !== "rich_text" || !itemHtml) return null;
        if (!richTextCleanHtml) return null;
        return getRichTextSnapshotDataUrl(richTextCleanHtml, {
            width: compactMode ? 360 : 560,
            // Keep source snapshot height bounded so list-item preview does not over-shrink text.
            maxHeight: richTextSnapshotRenderMaxHeight
        });
    }, [
        preferGeneratedRichPreview,
        item.content_type,
        itemHtml,
        richTextCleanHtml,
        compactMode,
        richTextSnapshotRenderMaxHeight
    ]);
    const effectiveRichTextSnapshotSrc = !snapshotFailed ? richTextSnapshotSrc : null;
    const effectiveRichImageFallbackSrc = !richImageFallbackFailed
        ? (richTextFallback?.imageSrc || null)
        : null;
    const preferImageFallbackForTabular = (
        richHtmlLooksTabular(richTextCleanHtml) || spreadsheetLikeRichSource
    ) && !!effectiveRichImageFallbackSrc;
    const richTextPreviewSrc = richTextHasAnimatedImageFallback
        ? (effectiveRichImageFallbackSrc || effectiveRichTextSnapshotSrc)
        : preferImageFallbackForTabular
            ? (effectiveRichImageFallbackSrc || effectiveRichTextSnapshotSrc)
            : (effectiveRichTextSnapshotSrc || null);
    const useSnapshotPreviewImage = !!richTextPreviewSrc && richTextPreviewSrc === effectiveRichTextSnapshotSrc;
    const useRichImageFallback = !!richTextPreviewSrc && richTextPreviewSrc === effectiveRichImageFallbackSrc;
    const visibleTagCount = item.tags?.length || 0;
    const hasTagsSection = visibleTagCount > 0 || isEditingTags;
    const overlayTagsInPreview = !compactMode && !isEditingTags && visibleTagCount > 0;
    const standaloneColorValue = useMemo(
        () => getStandaloneColorValue(item.content_type, item.content),
        [item.content, item.content_type]
    );

    useEffect(() => {
        let cancelled = false;
        const sourceAppPath = item.source_app_path?.trim();
        const cachedIcon = peekSourceAppIcon(sourceAppPath);

        if (!showSourceAppIcon) {
            setSourceAppIcon(null);
            return () => {
                cancelled = true;
            };
        }

        if (cachedIcon !== undefined) {
            setSourceAppIcon(cachedIcon ?? null);
            return () => {
                cancelled = true;
            };
        }

        setSourceAppIcon(null);
        if (!sourceAppPath) {
            return () => {
                cancelled = true;
            };
        }

        getSourceAppIcon(sourceAppPath).then((icon) => {
            if (!cancelled) {
                setSourceAppIcon(icon);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [item.source_app_path, showSourceAppIcon]);

    useEffect(() => {
        let cancelled = false;
        const cachedIcon = peekFileIcon(singleFilePath);

        if (item.content_type !== "file" || item.file_preview_exists === false || !singleFilePath) {
            setFileIcon(null);
            return () => {
                cancelled = true;
            };
        }

        if (cachedIcon !== undefined) {
            setFileIcon(cachedIcon ?? null);
            return () => {
                cancelled = true;
            };
        }

        setFileIcon(null);
        getSystemFileIcon(singleFilePath).then((icon) => {
            if (!cancelled) {
                setFileIcon(icon);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [item.content_type, item.file_preview_exists, singleFilePath]);

    // Hover preview is available in both normal and compact modes (KwikPaste-style).
    // Files are excluded (they show a rich card already) and sensitive-masked items
    // are excluded so the popup never bypasses the blur.
    const compactPreviewEnabled =
        COMPACT_PREVIEW_WINDOW_SUPPORTED &&
        item.content_type !== "file" &&
        !isSensitiveHidden;

    const isHoverPreviewRequestCurrent = (requestId: number) => {
        const node = itemRef.current;
        return (
            hoverRequestIdRef.current === requestId &&
            !!node &&
            node.isConnected &&
            node.matches(":hover")
        );
    };

    const cancelHoverPreview = () => {
        hoverRequestIdRef.current += 1;
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
    };

    const hideCompactPreviewNow = async () => {
        cancelHoverPreview();
        cancelPreviewHideTimer();
        await hideCompactPreviewGlobal();
    };

    // KwikPaste 的隐藏缓冲：离开卡片先不收起，240ms 内进入新卡片/预览会取消。
    const scheduleHideCompactPreview = () => {
        cancelHoverPreview();
        schedulePreviewHide(() => { void hideCompactPreviewGlobal(); });
    };

    const showCompactPreview = async (pointerClientX: number, requestId: number) => {
        if (!compactPreviewEnabled) return;
        if (!isHoverPreviewRequestCurrent(requestId)) {
            compactPreviewLog("show preview aborted: stale hover request before start", {
                itemId: item.id,
                requestId
            });
            return;
        }
        const node = itemRef.current;
        if (!node || !node.isConnected) return;
        const cardRect = node.getBoundingClientRect();
        if (cardRect.width <= 0 || cardRect.height <= 0) return;

        compactPreviewLog("show preview requested", {
            itemId: item.id,
            contentType: item.content_type
        });
        let previewWindow = await ensureCompactPreviewWindow();
        if (!isHoverPreviewRequestCurrent(requestId)) {
            compactPreviewLog("show preview aborted: stale hover request after ensure window", {
                itemId: item.id,
                requestId
            });
            return;
        }
        if (!previewWindow) {
            compactPreviewLog("show preview aborted: window unavailable");
            return;
        }
        await ensureCompactPreviewLifecycleListeners();
        if (!isHoverPreviewRequestCurrent(requestId)) {
            compactPreviewLog("show preview aborted: stale hover request after lifecycle listeners", {
                itemId: item.id,
                requestId
            });
            return;
        }
        const mounted = await waitForCompactPreviewMounted();
        if (!isHoverPreviewRequestCurrent(requestId)) {
            compactPreviewLog("show preview aborted: stale hover request after mounted wait", {
                itemId: item.id,
                requestId
            });
            return;
        }
        compactPreviewLog("mounted state before emit", { mounted });

        try {
            const rootStyle = getComputedStyle(document.documentElement);
            const clipboardItemFontSizeRaw = parseInt(
                rootStyle.getPropertyValue("--clipboard-item-font-size")
            );
            const clipboardTagFontSizeRaw = parseInt(
                rootStyle.getPropertyValue("--clipboard-tag-font-size")
            );
            const clipboardItemFontSize = Number.isFinite(clipboardItemFontSizeRaw)
                ? clipboardItemFontSizeRaw
                : undefined;
            const clipboardTagFontSize = Number.isFinite(clipboardTagFontSizeRaw)
                ? clipboardTagFontSizeRaw
                : undefined;
            const colorMode = document.documentElement.classList.contains("dark-mode") ? "dark" : "light";

            if (!isHoverPreviewRequestCurrent(requestId)) {
                compactPreviewLog("show preview aborted: stale hover request before emit", {
                    itemId: item.id,
                    requestId
                });
                return;
            }

            // KwikPaste：面板尺寸在开窗前按内容度量算好（一次性开窗，无 resize 往返）。
            const monitorInfo = await resolvePreviewMonitor();
            const listImage = node.querySelector<HTMLImageElement>("img.image-preview");
            const imageNatural = listImage && listImage.naturalWidth > 0 && listImage.naturalHeight > 0
                ? { width: listImage.naturalWidth, height: listImage.naturalHeight }
                : null;
            const panel = computePreviewPanelSize(
                {
                    contentType: item.content_type,
                    content: item.content,
                    htmlContent: itemHtml,
                    imageNatural
                },
                {
                    width: monitorInfo.width - PREVIEW_PANEL.MARGIN * 2,
                    height: monitorInfo.height - PREVIEW_PANEL.MARGIN * 2
                }
            );

            // 卡片矩形（视口 CSS px）→ 屏幕物理 → 显示器局部逻辑坐标。
            const appWindow = getCurrentWindow();
            const innerOrigin = await appWindow.innerPosition().catch(() => null);
            const innerSize = await appWindow.innerSize().catch(() => null);
            if (!innerOrigin || !innerSize) return;
            const cardPhysical = cardRectToPhysical(cardRect, innerOrigin, monitorInfo.scaleFactor);
            const cardLogical: PreviewRect = {
                left: (cardPhysical.left - monitorInfo.origin.x) / monitorInfo.scaleFactor,
                top: (cardPhysical.top - monitorInfo.origin.y) / monitorInfo.scaleFactor,
                width: cardPhysical.width / monitorInfo.scaleFactor,
                height: cardPhysical.height / monitorInfo.scaleFactor
            };
            const windowWidthLogical = innerSize.width / monitorInfo.scaleFactor;
            const sideLatchKey = String(item.id);
            const preferLeft = previewSideLatch.get(sideLatchKey)
                ?? (pointerClientX < windowWidthLogical / 2);
            previewSideLatch.set(sideLatchKey, preferLeft);

            const available: PreviewRect = {
                left: PREVIEW_PANEL.MARGIN,
                top: PREVIEW_PANEL.MARGIN,
                width: monitorInfo.width - PREVIEW_PANEL.MARGIN * 2,
                height: monitorInfo.height - PREVIEW_PANEL.MARGIN * 2
            };
            const { rect: panelRect } = resolvePreviewPlacement(cardLogical, panel, available, preferLeft);

            compactPreviewLog("emit compact-preview-update", {
                itemId: item.id,
                contentType: item.content_type,
                hasHtml: !!itemHtml,
                panel
            });
            await previewWindow.emit("compact-preview-update", {
                contentType: item.content_type,
                content: item.content,
                preview: item.preview,
                htmlContent: itemHtml,
                sourceApp: item.source_app,
                timestamp: item.timestamp,
                language,
                theme,
                colorMode,
                richTextSnapshotPreview,
                clipboardItemFontSize,
                clipboardTagFontSize,
                imageNatural,
                imageDisplay: panel.imageDisplay
            });

            // 一次性定位开窗：setSize + setPosition + show，之后不再调整。
            const panelX = monitorInfo.origin.x + Math.round(panelRect.left * monitorInfo.scaleFactor);
            const panelY = monitorInfo.origin.y + Math.round(panelRect.top * monitorInfo.scaleFactor);
            previewPanelRectPhysical = {
                left: panelX,
                top: panelY,
                width: Math.round(panelRect.width * monitorInfo.scaleFactor),
                height: Math.round(panelRect.height * monitorInfo.scaleFactor)
            };
            await showPreviewWindowAt(
                { x: panelX, y: panelY },
                panelRect.width,
                panelRect.height
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("window not found")) {
                compactPreviewLog("window not found, reset for recreate on next hover", err);
                compactPreviewWindow = null;
                compactPreviewMounted = false;
                compactPreviewMountedPromise = null;
                return;
            }
            console.error("Failed to show compact preview window:", err);
            compactPreviewLog("show preview failed", err);
        }
    };

    // Sync local state when prop changes (e.g. when editor opens)
    useEffect(() => {
        setLocalTagInput(tagInput);
    }, [tagInput]);

    useEffect(() => {
        setLocalAiOptionsOpen(!!aiOptionsOpen);
    }, [aiOptionsOpen]);

    useEffect(() => {
        setSnapshotFailed(false);
        setRichImageFallbackFailed(false);
    }, [item.id, itemHtml, richTextSnapshotPreview, compactMode]);

    // Keep the latest sensitive-mask state reachable inside the hover timer callback,
    // and dismiss an open preview as soon as the item gets masked.
    const isSensitiveHiddenRef = useRef(isSensitiveHidden);
    useEffect(() => {
        isSensitiveHiddenRef.current = isSensitiveHidden;
        if (isSensitiveHidden) {
            void hideCompactPreviewNow();
        }
    }, [isSensitiveHidden]);

    useEffect(() => {
        if (richSnapshotFallbackTimerRef.current) {
            clearTimeout(richSnapshotFallbackTimerRef.current);
            richSnapshotFallbackTimerRef.current = null;
        }
        if (!useSnapshotPreviewImage) return;

        // Safety net: some WebView failures do not reliably fire <img onError>.
        richSnapshotFallbackTimerRef.current = setTimeout(() => {
            const img = richSnapshotImgRef.current;
            if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
                richPreviewFailureLog("snapshot image timeout -> fallback to html", {
                    itemId: item.id,
                    hasImageElement: !!img,
                    complete: img?.complete ?? false,
                    naturalWidth: img?.naturalWidth ?? 0,
                    naturalHeight: img?.naturalHeight ?? 0
                });
                setSnapshotFailed(true);
            }
        }, 700);

        return () => {
            if (richSnapshotFallbackTimerRef.current) {
                clearTimeout(richSnapshotFallbackTimerRef.current);
                richSnapshotFallbackTimerRef.current = null;
            }
        };
    }, [useSnapshotPreviewImage, effectiveRichTextSnapshotSrc, item.id]);

    const showAIOptions = localAiOptionsOpen;
    const inlineAiVariants = {
        open: { opacity: 1, height: "auto", marginTop: 8, marginBottom: 8 },
        collapsed: { opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }
    };
    useEffect(() => {
        if (isEditingTags && tagInputRef.current) {
            tagInputRef.current.focus();
        }
    }, [isEditingTags]);

    useEffect(() => {
        if (!compactPreviewEnabled) {
            void hideCompactPreviewNow();
        }
    }, [compactPreviewEnabled]);

    useEffect(() => {
        return () => {
            cancelHoverPreview();
            void hideCompactPreviewGlobal();
        };
    }, []);

    const renderFilePreview = () => {
        if (item.file_preview_exists === false) {
            return (
                <div className="file-thumbnail-card error-bg" title={t('file_deleted') || "File Deleted"}>
                    <div className="file-icon-wrapper error-icon">
                        <FileQuestion size={24} />
                    </div>
                    <div className="file-info-wrapper">
                        <div className="file-name error-text">{t('file_deleted') || "Deleted"}</div>
                        <div className="file-hint error-text">{item.content}</div>
                    </div>
                </div>
            );
        }

        if (filePaths.length > 1) {
            return (
                <div className="file-thumbnail-card" title={item.content}>
                    <div className="file-icon-wrapper">
                        <Files size={24} />
                    </div>
                    <div className="file-info-wrapper">
                        <div className="file-name">{filePaths.length} {t('items')}</div>
                        <div className="file-hint">{filePaths[0].split(/[\\/]/).pop()} ...</div>
                    </div>
                </div>
            );
        }

        const filePath = filePaths[0];
        if (!filePath) {
            return (
                <div className="file-thumbnail-card" title={item.content}>
                    <div className="file-icon-wrapper">
                        <File size={24} />
                    </div>
                    <div className="file-info-wrapper">
                        <div className="file-name">{t('file') || "File"}</div>
                        <div className="file-hint">{item.content}</div>
                    </div>
                </div>
            );
        }

        const fileName = filePath.split(/[\\/]/).pop();
        const dirPath = filePath.split(/[\\/]/).slice(0, -1).join('\\');

        return (
            <div className="file-thumbnail-card" title={item.content}>
                <div className={`file-icon-wrapper${fileIcon ? " file-icon-wrapper-system" : ""}`}>
                    {fileIcon ? (
                        <img
                            src={fileIcon}
                            alt={`${fileName || "file"} icon`}
                            className="file-icon-image"
                            loading="lazy"
                        />
                    ) : (
                        getFallbackFileIcon(filePath)
                    )}
                </div>
                <div className="file-info-wrapper">
                    <div className="file-name">{fileName}</div>
                    <div className="file-hint">{dirPath}</div>
                </div>
            </div>
        );
    };

    const renderTagsContainer = (overlay = false) => (
        <div
            className={`item-tags-container${overlay ? ' overlay' : ''}${isEditingTags ? ' tag-edit-active' : ''}`}
            style={{
                marginTop: overlay ? '0' : '2px',
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
                gap: '4px',
                paddingTop: '0'
            }}
        >
            {item.tags?.map((tag) => {
                const tagBackground = tagColors?.[tag] || getTagColor(tag, theme);
                const tagTextColor = getTagTextColor(tagBackground);
                return (
                    <span
                        key={tag}
                        className="tag-chip"
                        style={{
                            background: tagBackground,
                            color: tagTextColor,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                        }}
                    >
                        {tag}
                        {isEditingTags && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onTagDelete(tag);
                                }}
                                style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', opacity: 0.72, cursor: 'pointer', display: 'flex' }}
                            >
                                <X size={8} />
                            </button>
                        )}
                    </span>
                );
            })}

            {isEditingTags && (
                <div className="tag-edit-anchor">
                    <div className="tag-edit-input-row">
                        <input
                            ref={tagInputRef}
                            type="text"
                            value={localTagInput}
                            onCompositionStart={() => {
                                isComposing.current = true;
                            }}
                            onCompositionEnd={(e) => {
                                isComposing.current = false;
                                const val = (e.target as HTMLInputElement).value;
                                setLocalTagInput(val);
                                onTagInput(val);
                            }}
                            onMouseDown={() => {
                                invoke('activate_window_focus').catch(console.error);
                            }}
                            onFocus={() => {
                                invoke('activate_window_focus').catch(console.error);
                            }}
                            onChange={(e) => {
                                const val = e.target.value;
                                setLocalTagInput(val);
                                if (!isComposing.current) {
                                    onTagInput(val);
                                }
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onTagEditCancel?.();
                                    return;
                                }
                                const suggestionCount = pickableTagSuggestions.length;
                                if (e.key === 'ArrowDown' && suggestionCount > 0 && onTagPick) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setTagSuggestIndex((prev) =>
                                        prev < 0 ? 0 : Math.min(prev + 1, suggestionCount - 1)
                                    );
                                    return;
                                }
                                if (e.key === 'ArrowUp' && suggestionCount > 0 && onTagPick) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setTagSuggestIndex((prev) => (prev <= 0 ? -1 : prev - 1));
                                    return;
                                }
                                if (e.key === 'Enter' && !isComposing.current) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (
                                        onTagPick &&
                                        tagSuggestIndex >= 0 &&
                                        tagSuggestIndex < suggestionCount
                                    ) {
                                        const picked = pickableTagSuggestions[tagSuggestIndex];
                                        onTagPick(picked);
                                        setLocalTagInput('');
                                        setTagSuggestIndex(-1);
                                    } else {
                                        onTagAdd();
                                    }
                                }
                            }}
                            className="tag-input"
                            aria-autocomplete="list"
                            aria-controls={
                                pickableTagSuggestions.length > 0 && onTagPick
                                    ? `tag-suggest-list-${item.id}`
                                    : undefined
                            }
                            aria-activedescendant={
                                tagSuggestIndex >= 0 && pickableTagSuggestions.length > 0 && onTagPick
                                    ? `tag-suggest-opt-${item.id}-${tagSuggestIndex}`
                                    : undefined
                            }
                            placeholder={t('enter_tag_name')}
                            style={{
                                background: 'var(--bg-input)',
                                border: 'none',
                                borderRadius: '0',
                                padding: '2px 6px',
                                fontSize: '10px',
                                color: 'var(--text-primary)',
                                outline: 'none'
                            }}
                            onClick={(e) => e.stopPropagation()}
                        />
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onTagAdd();
                            }}
                            className="btn-icon"
                            style={{ padding: '2px', height: '16px', width: '16px' }}
                        >
                            <Plus size={10} />
                        </button>
                    </div>
                    {pickableTagSuggestions.length > 0 && onTagPick && (
                        <div
                            ref={tagSuggestListRef}
                            id={`tag-suggest-list-${item.id}`}
                            className="tag-edit-suggestions-popover"
                            role="listbox"
                            aria-label={t('find_tags')}
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            {pickableTagSuggestions.map((sTag, sIdx) => {
                                const bg = tagColors?.[sTag] || getTagColor(sTag, theme);
                                const fg = getTagTextColor(bg);
                                return (
                                    <button
                                        key={sTag}
                                        type="button"
                                        role="option"
                                        id={`tag-suggest-opt-${item.id}-${sIdx}`}
                                        aria-selected={tagSuggestIndex === sIdx}
                                        className={`tag-suggest-item${tagSuggestIndex === sIdx ? ' tag-suggest-item--active' : ''}`}
                                        onMouseEnter={() => setTagSuggestIndex(sIdx)}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onTagPick(sTag);
                                            setLocalTagInput('');
                                            setTagSuggestIndex(-1);
                                        }}
                                    >
                                        <span
                                            className="tag-suggest-pill"
                                            style={{
                                                background: bg,
                                                color: fg
                                            }}
                                        >
                                            {sTag}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );

    return (
        <motion.div
            ref={itemRef}
            id={id}
            data-test-clipboard-item
            layout={!disableLayout}
            initial={false}
            animate={{ marginBottom: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1 }}
            className={`history-item ${isSelected ? "selected" : ""} ${compactMode ? "compact" : ""} ${item.is_pinned ? "pinned" : ""} ${className || ''}`}
            onMouseDown={(e) => {
                const target = e.target as HTMLElement;
                if (e.button !== 0) return;

                if (isEditingTags) {
                    if (target.closest(".tag-edit-anchor")) return;
                    if (target.closest(".item-tags-container .tag-chip")) return;
                    if (target.closest('button, input, textarea, [role="button"], .drag-handle')) {
                        return;
                    }
                    if (target.closest('a')) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onTagEditCancel?.();
                    return;
                }

                if (target.closest('button, input, textarea, [role="button"], .drag-handle')) {
                    return;
                }
                if (target.closest('a')) {
                    return;
                }
                // e.preventDefault() stops macOS from transferring key-window focus to TieZ
                // when the user clicks on a clipboard item, including pinned mode.
                // Without this, the first click activates TieZ and the original input
                // target loses focus before we dispatch the paste keystroke.
                e.preventDefault();
                void hideCompactPreviewNow();
                onCopy(false); // Plain text by default
                onSelect();
            }}
            onClick={(e) => {
                if (isEditingTags) return;
                const target = e.target as HTMLElement;
                if (target.closest('button') || target.closest('input') || target.closest('textarea')) {
                    return;
                }
                // Prevent link navigation - we want to copy, not open links
                if (target.closest('a')) {
                    e.preventDefault();
                }
                // Copy is handled on mousedown so the source app keeps focus.
            }}
            onContextMenu={(e) => {
                const target = e.target as HTMLElement;
                if (isEditingTags) {
                    if (target.closest(".tag-edit-anchor")) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onTagEditCancel?.();
                    return;
                }
                if (target.closest('button') || target.closest('input') || target.closest('textarea')) {
                    return;
                }
                void hideCompactPreviewNow();
                e.preventDefault();
                // Prevent link navigation on right-click too
                if (target.closest('a')) {
                    e.stopPropagation();
                }
                onCopy(true); // Formatted text for right-click

                onSelect();
            }}
            onMouseEnter={(e) => {
                if (!compactPreviewEnabled) return;
                // Don't show preview if AI options are open to avoid interference
                if (showAIOptions) return;
                // KwikPaste 的隐藏缓冲：卡片间移动时取消上一张卡片的收起。
                cancelPreviewHideTimer();
                compactPreviewLog("mouseenter schedule preview", { itemId: item.id });
                const requestId = hoverRequestIdRef.current + 1;
                hoverRequestIdRef.current = requestId;
                const pointerX = e.clientX;
                const target = e.currentTarget;

                // Clear any pending hide timer
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);

                // Set a delay to show
                hoverTimerRef.current = setTimeout(() => {
                    hoverTimerRef.current = null;
                    // Double-check AI options are still closed before showing
                    if (showAIOptions) return;
                    // Re-check mask state: it may have changed during the hover delay
                    if (isSensitiveHiddenRef.current) return;
                    if (!target.isConnected) return;
                    if (!isHoverPreviewRequestCurrent(requestId)) return;
                    compactPreviewLog("mouseenter timer fired, show preview", { itemId: item.id });
                    void showCompactPreview(pointerX, requestId);
                }, 400); // 0.4s delay: snappy like KwikPaste, still avoids drive-by hovers
            }}
            onMouseLeave={() => {
                compactPreviewLog("mouseleave schedule hide preview", { itemId: item.id });
                scheduleHideCompactPreview();
            }}
        >
            <div className="item-meta">
                <div className="item-meta-left">
                    {dragControls && (
                        <div
                            className="drag-handle"
                            onPointerDown={(e) => dragControls.start(e)}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                                cursor: 'grab',
                                opacity: 0.5,
                                display: 'flex',
                                alignItems: 'center',
                                touchAction: 'none'
                            }}
                        >
                            <GripVertical size={14} />
                        </div>
                    )}
                    <div className="app-info">
                        {item.is_pinned && !dragControls && <Pin size={10} style={{ color: 'var(--accent-color)', marginRight: '-2px' }} />}
                        {showSourceAppIcon
                            ? renderSourceAppIcon(sourceAppIcon, item.content_type, item.source_app)
                            : getIcon(item.content_type)}
                        <span>{item.source_app}</span>
                    </div>
                </div>

                <div className="item-meta-right">
                    <div className="item-actions">
                        {(item.tags?.includes('sensitive') || item.tags?.includes('密码') || item.tags?.includes('password')) && (
                            <button
                                className={`btn-icon ${isRevealed ? "active" : ""}`}
                                onClick={onToggleReveal}
                                title={isRevealed ? t('hide') : t('reveal')}
                            >
                                {isRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                            </button>
                        )}
                        <button
                            className="btn-icon"
                            onClick={onOpen}
                            title={t('open')}
                        >
                            <ExternalLink size={12} />
                        </button>
                        <button
                            className={`btn-icon ${item.is_pinned ? "active" : ""}`}
                            onClick={onTogglePin}
                            title={item.is_pinned ? t('unpin') : t('pin')}
                        >
                            {item.is_pinned ? <PinOff size={12} /> : <Pin size={12} />}
                        </button>
                        <button
                            className={`btn-icon ${item.tags && item.tags.length > 0 ? "active" : ""}`}
                            onClick={onToggleTagEditor}
                            title="Tags"
                        >
                            <Tag size={12} />
                        </button>
                        {(item.content_type === 'text' || item.content_type === 'rich_text') && aiEnabled && (
                            <button
                                className={`btn-icon ai-btn ${isAIProcessing || showAIOptions ? 'active' : ''}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (!isAIProcessing) {
                                        // Close preview window when opening AI options
                                        if (!showAIOptions) {
                                            hideCompactPreviewNow();
                                        }
                                        setLocalAiOptionsOpen(prev => !prev);
                                        onAIOptionsToggle?.();
                                    }
                                }}
                                title={t('ai_assistant')}
                            >
                                {isAIProcessing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                            </button>
                        )}
                        <button className="btn-icon" onClick={onDelete} title={t('delete')}>
                            <X size={12} />
                        </button>
                    </div>
                    <div className="item-meta-right-info">
                        {quickPasteHint && item.is_pinned && (
                            <span
                                className="quick-paste-hint"
                                title={`${t('quick_paste_modifier')}: ${quickPasteHint.combo}`}
                            >
                                {quickPasteHint.combo}
                            </span>
                        )}
                        <span>{getConciseTime(item.timestamp, language)}</span>
                    </div>
                </div>
            </div>

            {
                compactMode && item.is_pinned && (
                    <div className="compact-pinned-indicator" title={t('pinned')}>
                        <Pin size={10} fill="currentColor" />
                    </div>
                )
            }
            <div className={`content-preview-shell${overlayTagsInPreview ? ' has-overlay-tags' : ''}`}>
                <div className={`content-preview ${item.content_type === 'rich_text' ? 'rich-text' : ''} ${item.content_type === 'file' ? 'file-preview' : ''} ${isSensitiveHidden ? 'sensitive-blur' : ''}`}>
                {item.content_type === "image" ? (
                    <div style={{ position: 'relative' }}>
                        {(item.is_external && item.file_preview_exists === false) || failedImageSource === item.content ? (
                            <div className="image-preview error-placeholder" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', height: '100px', fontSize: '12px' }}>
                                <ImageOff size={24} style={{ marginBottom: '8px', opacity: 0.5 }} />
                                <span>{t('image_content')}</span>
                            </div>
                        ) : (
                            <img
                                src={
                                    item.content.startsWith("data:")
                                        ? item.content
                                        : (
                                            toTauriLocalImageSrc(item.content) ||
                                            (item.is_external ? convertFileSrc(item.content) : item.content)
                                        )
                                }
                                alt={t('image_preview')}
                                className="image-preview"
                                loading="lazy"
                                style={isSensitiveHidden ? { filter: 'blur(8px)' } : {}}
                                onError={() => setFailedImageSource(item.content)}
                            />
                        )}
                        {isSensitiveHidden && (
                            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontWeight: 'bold', opacity: 0.5, fontSize: '10px' }}>
                                SENSITIVE
                            </div>
                        )}
                    </div>
                ) : item.content_type === "video" ? (
                    <div className="video-thumbnail-card">
                        <div className="video-thumbnail-wrapper">
                            <video
                                src={item.content.startsWith("data:")
                                    ? item.content
                                    : (toTauriLocalImageSrc(item.content) || item.content)}
                                preload="metadata"
                                muted
                                playsInline
                                className="video-thumbnail-element"
                                onLoadedMetadata={(e) => seekVideoPreviewFrame(e.currentTarget)}
                            />
                            <div className="video-play-overlay">
                                <Video size={16} />
                            </div>
                        </div>
                        <div className="video-info-wrapper">
                            <div className="video-name">{item.content.split(/[\\/]/).pop()}</div>
                        </div>
                    </div>
                ) : item.content_type === "file" ? (
                    renderFilePreview()
                ) : isAIProcessing ? (
                    <div className="ai-skeleton-wrapper">
                        <div className="ai-skeleton-line" style={{ width: '90%' }}></div>
                        <div className="ai-skeleton-line" style={{ width: '75%' }}></div>
                        <div className="ai-skeleton-line" style={{ width: '85%' }}></div>
                    </div>
                ) : item.isInputting ? (
                    <div className="ai-input-wrapper">
                        <input
                            autoFocus
                            className="search-input"
                            onMouseDown={() => invoke('activate_window_focus').catch(console.error)}
                            onFocus={() => invoke('activate_window_focus').catch(console.error)}
                            style={{ width: '100%', fontSize: '12px', padding: '8px', border: '1px solid var(--accent-color)' }}
                            placeholder={item.content}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const val = e.currentTarget.value.trim();
                                    if (onInputSubmit) {
                                        onInputSubmit(val);
                                    }
                                }
                            }}
                            onClick={(e) => e.stopPropagation()}
                        />
                        <div style={{ fontSize: '10px', opacity: 0.6, marginTop: '4px' }}>
                            {language === 'zh' ? '输入补充信息后按回车提交' : 'Press Enter to submit supplementary info'}
                        </div>
                    </div>
                ) : item.content_type === "rich_text" && itemHtml && !isSensitiveHidden ? (
                    richTextPreviewSrc ? (
                        <img
                            ref={richSnapshotImgRef}
                            src={richTextPreviewSrc}
                            alt="rich text preview"
                            onLoad={() => {
                                if (useSnapshotPreviewImage && richSnapshotFallbackTimerRef.current) {
                                    clearTimeout(richSnapshotFallbackTimerRef.current);
                                    richSnapshotFallbackTimerRef.current = null;
                                }
                            }}
                            onError={() => {
                                if (useRichImageFallback) {
                                    richPreviewFailureLog("fallback image load error -> switch to snapshot", {
                                        itemId: item.id,
                                        srcLength: (richTextPreviewSrc || "").length,
                                        srcSample: (richTextPreviewSrc || "").slice(0, 140)
                                    });
                                    setRichImageFallbackFailed(true);
                                    return;
                                }
                                if (richSnapshotFallbackTimerRef.current) {
                                    clearTimeout(richSnapshotFallbackTimerRef.current);
                                    richSnapshotFallbackTimerRef.current = null;
                                }
                                if (effectiveRichTextSnapshotSrc) {
                                    richPreviewFailureLog("snapshot image load error -> fallback to html", {
                                        itemId: item.id,
                                        srcLength: (richTextPreviewSrc || "").length,
                                        srcSample: (richTextPreviewSrc || "").slice(0, 140)
                                    });
                                    setSnapshotFailed(true);
                                }
                            }}
                            style={{
                                width: 'auto',
                                maxWidth: '100%',
                                maxHeight: `${richTextSnapshotDisplayMaxHeight}px`,
                                display: 'block',
                                marginRight: 'auto',
                                pointerEvents: 'none',
                                borderRadius: '4px',
                                maskImage: 'linear-gradient(to bottom, black 78%, transparent 100%)',
                                WebkitMaskImage: 'linear-gradient(to bottom, black 78%, transparent 100%)'
                            }}
                        />
                    ) : (
                        <HtmlContent
                            className="rich-text-preview"
                            htmlContent={richTextCleanHtml || itemHtml}
                            fallbackText={item.preview}
                            preview={true}
                            style={{
                                maxHeight: `${richTextSnapshotDisplayMaxHeight}px`,
                                overflow: 'hidden',
                                fontSize: 'var(--clipboard-item-font-size)',
                                lineHeight: '1.4',
                                position: 'relative',
                                pointerEvents: 'none', // Prevent interacting with links in the list
                                maskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)',
                                WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)'
                            }}
                        />
                    )
                ) : standaloneColorValue && !isSensitiveHidden ? (
                    <div className="color-code-preview">
                        <span
                            className="color-code-swatch"
                            style={{ background: standaloneColorValue }}
                            aria-hidden="true"
                        />
                        <span className="color-code-value">{standaloneColorValue}</span>
                    </div>
                ) : (
                    isSensitiveHidden
                        ? (
                            <div style={{ minHeight: '24px', opacity: 0.6, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-mono)' }}>
                                <span style={{ letterSpacing: '1px' }}>
                                    {sensitivePreview}
                                </span>
                                <span style={{ fontSize: '10px', opacity: 0.7 }}>
                                    ({item.content.length} {t('chars') || 'chars'})
                                </span>
                            </div>
                        )
                        : item.preview
                )}
                {overlayTagsInPreview && renderTagsContainer(true)}
                </div>
            </div>

            {/* AI Options - Compact Mode: Dropdown Panel, Normal Mode: Inline */}
            <AnimatePresence>
                {showAIOptions && (
                    <motion.div
                        className={compactMode ? "ai-options-dropdown" : ""}
                        initial={compactMode ? { opacity: 0, y: -10 } : "collapsed"}
                        animate={compactMode ? { opacity: 1, y: 0 } : "open"}
                        exit={compactMode ? { opacity: 0, y: -10 } : "collapsed"}
                        variants={compactMode ? undefined : inlineAiVariants}
                        transition={compactMode ? { duration: 0.16 } : { duration: 0.18 }}
                        style={compactMode ? {
                            position: 'absolute',
                            top: '100%',
                            right: '4px',
                            zIndex: 100000,
                            marginTop: '4px',
                            background: 'var(--bg-element)',
                            border: '2px solid var(--border-dark)',
                            borderRadius: '4px',
                            boxShadow: '4px 4px 0 0 var(--shadow-color)',
                            padding: '6px',
                            minWidth: '140px',
                            maxHeight: '200px',
                            overflowY: 'auto'
                        } : { overflow: 'hidden' }}
                    >
                        <div style={compactMode ? {
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px'
                        } : {
                            padding: '8px 10px',
                            background: 'rgba(72, 123, 219, 0.05)',
                            border: '1.5px dashed var(--accent-color)',
                            borderRadius: '4px',
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '6px',
                            alignItems: 'center'
                        }}>
                            {['task', 'mouthpiece', 'translate'].map(actionType => (
                                <button
                                    key={actionType}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onAIAction?.(actionType);
                                        onAIOptionsToggle?.();
                                    }}
                                    className="btn-icon"
                                    style={compactMode ? {
                                        width: '100%',
                                        fontSize: '11px',
                                        height: '32px',
                                        boxShadow: '2px 2px 0 0 var(--shadow-color)',
                                        textTransform: 'none',
                                        justifyContent: 'flex-start',
                                        paddingLeft: '10px'
                                    } : {
                                        flex: 1,
                                        minWidth: '90px',
                                        fontSize: '11px',
                                        height: '32px',
                                        padding: '0 12px',
                                        boxShadow: '2px 2px 0 0 var(--shadow-color)',
                                        textTransform: 'none',
                                        whiteSpace: 'nowrap'
                                    }}
                                >
                                    {t(`ai_${actionType}`)}
                                </button>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {!overlayTagsInPreview && hasTagsSection && renderTagsContainer()}
        </motion.div >
    );
};

export default memo(ClipboardItem, (prevProps, nextProps) => {
    return prevProps.isSelected === nextProps.isSelected &&
        prevProps.item.id === nextProps.item.id &&
        prevProps.item.content_type === nextProps.item.content_type &&
        prevProps.item.timestamp === nextProps.item.timestamp &&
        prevProps.item.content === nextProps.item.content &&
        prevProps.item.preview === nextProps.item.preview &&
        prevProps.item.html_content === nextProps.item.html_content &&
        prevProps.item.source_app === nextProps.item.source_app &&
        prevProps.item.source_app_path === nextProps.item.source_app_path &&
        prevProps.item.is_pinned === nextProps.item.is_pinned &&
        prevProps.item.is_external === nextProps.item.is_external &&
        prevProps.item.file_preview_exists === nextProps.item.file_preview_exists &&
        prevProps.item.tags === nextProps.item.tags &&
        prevProps.isRevealed === nextProps.isRevealed &&
        prevProps.isEditingTags === nextProps.isEditingTags &&
        prevProps.isAIProcessing === nextProps.isAIProcessing &&
        prevProps.aiOptionsOpen === nextProps.aiOptionsOpen &&
        prevProps.aiEnabled === nextProps.aiEnabled &&
        prevProps.richTextSnapshotPreview === nextProps.richTextSnapshotPreview &&
        prevProps.showSourceAppIcon === nextProps.showSourceAppIcon &&
        prevProps.quickPasteHint?.slot === nextProps.quickPasteHint?.slot &&
        prevProps.quickPasteHint?.combo === nextProps.quickPasteHint?.combo &&
        prevProps.compactMode === nextProps.compactMode &&
        prevProps.theme === nextProps.theme &&
        prevProps.language === nextProps.language &&
        prevProps.tagInput === nextProps.tagInput &&
        (prevProps.tagSuggestions ?? []).join('\u0000') === (nextProps.tagSuggestions ?? []).join('\u0000');
});
