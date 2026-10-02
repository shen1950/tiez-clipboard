import { useEffect, useMemo, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
    FileText,
    Image as ImageIcon,
    Link as LinkIcon,
    Code,
    File,
    Video
} from "lucide-react";
import HtmlContent from "../../../shared/components/HtmlContent";
import {
    applyThemeClasses,
    DEFAULT_THEME,
    normalizeThemeId
} from "../../../shared/config/themes";
import { formatFileSize, getConciseTime } from "../../../shared/lib/utils";
import type { Locale } from "../../../shared/types";
import { translations } from "../../../locales";
import { toTauriLocalImageSrc } from "../../../shared/lib/localImageSrc";

type ImageSize = { width: number; height: number };

type PreviewPayload = {
    contentType: string;
    content: string;
    preview?: string;
    htmlContent?: string;
    sourceApp?: string;
    timestamp?: number;
    language?: Locale;
    theme?: string;
    colorMode?: "light" | "dark";
    richTextSnapshotPreview?: boolean;
    clipboardItemFontSize?: number;
    clipboardTagFontSize?: number;
    /** 图片原始尺寸（来自列表里已加载的 <img>），用于信息行。 */
    imageNatural?: ImageSize | null;
    /** 图片按面板算好的显示尺寸，CSS 按此精确渲染（KwikPaste：开窗前定尺寸）。 */
    imageDisplay?: ImageSize;
};

const RICH_IMAGE_FALLBACK_PREFIX = "<!--TIEZ_RICH_IMAGE:";
const RICH_IMAGE_FALLBACK_SUFFIX = "-->";
const TABULAR_RICH_HTML_RE = /<(table|tr|td|th|thead|tbody|tfoot|colgroup|col)\b/i;
const SPREADSHEET_SOURCE_RE = /\b(excel|et|wps|sheet|spreadsheet|calc)\b/i;

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

const resolveRichImageSrc = (payload: string): string | null => {
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

const isSpreadsheetLikeSource = (sourceApp?: string): boolean => {
    const value = (sourceApp || "").trim();
    if (!value) return false;
    return SPREADSHEET_SOURCE_RE.test(value);
};

const RICH_PREVIEW_DEBUG = import.meta.env.DEV;
const richPreviewFailureLog = (stage: string, detail?: Record<string, unknown>) => {
    if (!RICH_PREVIEW_DEBUG) return;
    console.warn("[RichTextPreview][CompactWindow]", stage, detail || {});
};

const getIcon = (type: string) => {
    switch (type) {
        case "text": return <FileText size={16} />;
        case "image": return <ImageIcon size={16} />;
        case "url": return <LinkIcon size={16} />;
        case "code": return <Code size={16} />;
        case "file": return <File size={16} />;
        case "video": return <Video size={16} />;
        default: return <FileText size={16} />;
    }
};

const TYPE_LABEL_KEYS: Record<string, string> = {
    image: "type_image",
    text: "type_text",
    url: "type_url",
    code: "type_code",
    file: "type_file",
    video: "type_video",
    rich_text: "type_rich_text"
};

const resolveTypeLabel = (contentType: string, language?: Locale): string => {
    const key = TYPE_LABEL_KEYS[contentType];
    if (!key || !language) return contentType;
    const dict = translations[language] as Record<string, string> | undefined;
    return dict?.[key] || contentType;
};

// KwikPaste 式面板标题：「图片预览」/「圖片預覽」/ "Image Preview"。
const resolvePanelTitle = (contentType: string, language?: Locale): string => {
    const label = resolveTypeLabel(contentType, language);
    if (language === "en") return `${label} Preview`;
    if (language === "tw") return `${label}預覽`;
    return `${label}预览`;
};

// 估算 base64 data URL 的字节大小（不解码）。
const getDataUrlBytes = (dataUrl: string): number | null => {
    const match = /^data:[^;,]+;base64,([\s\S]*)$/i.exec(dataUrl.trim());
    if (!match) return null;
    const base64 = match[1].replace(/\s/g, "");
    if (!base64) return null;
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

// 图片/视频条目存的是 data URL 或附件绝对路径；远程 URL 没有本地大小可读。
const resolveLocalPath = (content: string): string | null => {
    const value = content.trim();
    if (!value || /^(data:|https?:|blob:|asset:|tauri:|file:)/i.test(value)) return null;
    return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") ? value : null;
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

const applyTheme = (payload: PreviewPayload) => {
    const theme = normalizeThemeId(payload.theme || DEFAULT_THEME);
    const colorMode = payload.colorMode || "light";

    const root = document.documentElement;
    const body = document.body;

    applyThemeClasses(theme, root, body);

    root.classList.remove("light-mode", "dark-mode");
    body.classList.remove("light-mode", "dark-mode");
    if (colorMode === "dark") {
        root.classList.add("dark-mode");
        body.classList.add("dark-mode");
    } else {
        root.classList.add("light-mode");
        body.classList.add("light-mode");
    }

    body.classList.add("compact-preview");

    if (payload.clipboardItemFontSize) {
        root.style.setProperty("--clipboard-item-font-size", `${payload.clipboardItemFontSize}px`);
    }
    if (payload.clipboardTagFontSize) {
        root.style.setProperty("--clipboard-tag-font-size", `${payload.clipboardTagFontSize}px`);
    }
};

/**
 * 预览面板是纯渲染器：窗口尺寸与位置由主窗口按内容度量在开窗前算好
 * （KwikPaste 的核心设计），这里只负责渲染内容，不做任何 resize。
 */
const CompactPreviewWindow = () => {
    const [payload, setPayload] = useState<PreviewPayload | null>(null);
    const [richImageFallbackFailed, setRichImageFallbackFailed] = useState(false);
    const [sizeBytes, setSizeBytes] = useState<number | null>(null);
    // 渲染结果为空时回退纯文本：富文本快照/HTML 在个别内容上可能静默渲染成空白。
    const [plainTextFallback, setPlainTextFallback] = useState(false);

    useEffect(() => {
        getCurrentWindow()
            .setAlwaysOnTop(true)
            .catch((err) => console.error(err));
        const unlisten = listen<PreviewPayload>("compact-preview-update", (event) => {
            setPayload(event.payload);
            applyTheme(event.payload);
        });
        emitTo("main", "compact-preview-mounted", true)
            .catch((err) => console.error(err));
        return () => {
            unlisten.then((f) => f());
        };
    }, []);

    useEffect(() => {
        setRichImageFallbackFailed(false);
        setSizeBytes(null);
        setPlainTextFallback(false);
    }, [payload?.content, payload?.htmlContent, payload?.richTextSnapshotPreview]);

    // 兜底检查：内容区既没有图片也没有文字、但数据里有文本时，切换为纯文本渲染。
    useEffect(() => {
        if (!payload || plainTextFallback) return;
        if (payload.contentType !== "rich_text") return;
        const raf = window.requestAnimationFrame(() => {
            const el = document.querySelector(".preview-content");
            if (!el) return;
            const hasImage = !!el.querySelector("img");
            const text = (el.textContent || "").trim();
            if (!hasImage && !text && (payload.content || payload.preview)) {
                setPlainTextFallback(true);
            }
        });
        return () => window.cancelAnimationFrame(raf);
    });

    // 附件字节大小（信息行用）：data URL 直接估算，本地文件读磁盘。
    useEffect(() => {
        if (!payload || (payload.contentType !== "image" && payload.contentType !== "video")) return;
        const content = payload.content || "";
        if (content.startsWith("data:")) {
            const bytes = getDataUrlBytes(content);
            if (bytes != null) setSizeBytes(bytes);
            return;
        }
        const path = resolveLocalPath(content);
        if (!path) return;
        let cancelled = false;
        invoke<{ size: number }>("get_file_size", { path })
            .then((result) => {
                if (!cancelled && result && Number.isFinite(result.size)) {
                    setSizeBytes(result.size);
                }
            })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [payload?.contentType, payload?.content]);

    const isMediaPayload = payload?.contentType === "image" || payload?.contentType === "video";

    const mediaMetaText = useMemo(() => {
        if (!isMediaPayload) return "";
        const parts: string[] = [];
        if (payload?.imageNatural) {
            parts.push(`${payload.imageNatural.width} x ${payload.imageNatural.height}`);
        }
        if (sizeBytes != null && sizeBytes > 0) {
            const size = formatFileSize(sizeBytes);
            if (size) parts.push(size);
        }
        return parts.join(" · ");
    }, [isMediaPayload, payload?.imageNatural, sizeBytes]);

    const typeLabel = resolveTypeLabel(payload?.contentType || "text", payload?.language);
    const panelTitle = resolvePanelTitle(payload?.contentType || "text", payload?.language);
    const showMetaLine = !!payload?.sourceApp || !!payload?.timestamp;

    const richImageFallback = useMemo(() => {
        if (!payload || payload.contentType !== "rich_text" || !payload.htmlContent) return null;
        const { imagePayload } = extractRichImageFallback(payload.htmlContent);
        if (!imagePayload) return null;
        const src = resolveRichImageSrc(imagePayload);
        if (!src) return null;
        return { src };
    }, [payload]);
    const richTextCleanHtml = useMemo(() => {
        if (!payload || payload.contentType !== "rich_text" || !payload.htmlContent) return "";
        const { cleanHtml } = extractRichImageFallback(payload.htmlContent);
        return cleanHtml || payload.htmlContent;
    }, [payload]);
    const richTextHasAnimatedImageFallback = useMemo(() => (
        isAnimatedGifSrc(richImageFallback?.src || null)
    ), [richImageFallback]);
    const effectiveRichImageFallbackSrc = richImageFallbackFailed ? null : (richImageFallback?.src || null);
    const useRichImageFallback = richTextHasAnimatedImageFallback
        || (
            (richHtmlLooksTabular(richTextCleanHtml) || isSpreadsheetLikeSource(payload?.sourceApp))
            && !!effectiveRichImageFallbackSrc
        );

    const content = useMemo(() => {
        if (!payload) return null;
        if (payload.contentType === "image") {
            const src = payload.content.startsWith("data:")
                ? payload.content
                : (toTauriLocalImageSrc(payload.content) || payload.content);
            // 面板在开窗前已按图片比例算好尺寸；这里用 max 约束渲染，
            // 吸收窗口边框带来的 1-2px 误差，永不溢出、永不出现滚动条。
            return (
                <img
                    src={src}
                    alt="preview"
                    style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto" }}
                />
            );
        }
        if (payload.contentType === "video") {
            const src = payload.content.startsWith("data:")
                ? payload.content
                : (toTauriLocalImageSrc(payload.content) || payload.content);
            return (
                <video
                    src={src}
                    preload="metadata"
                    muted
                    playsInline
                    controls
                    onLoadedMetadata={(e) => seekVideoPreviewFrame(e.currentTarget)}
                    style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto" }}
                />
            );
        }
        if (payload.contentType === "rich_text" && payload.htmlContent) {
            // Excel 表格等"真图片"富文本：直接显示位图。
            if (!plainTextFallback && useRichImageFallback && effectiveRichImageFallbackSrc) {
                return (
                    <img
                        src={effectiveRichImageFallbackSrc}
                        alt="rich text preview"
                        onError={() => {
                            richPreviewFailureLog("fallback image load error -> switch to html", {
                                srcLength: (effectiveRichImageFallbackSrc || "").length,
                                sourceApp: payload.sourceApp || ""
                            });
                            setRichImageFallbackFailed(true);
                        }}
                    />
                );
            }
            if (plainTextFallback) {
                return payload.content || payload.preview || "";
            }
            const { cleanHtml } = extractRichImageFallback(payload.htmlContent);
            return (
                <HtmlContent
                    className="rich-text-preview"
                    htmlContent={cleanHtml || payload.htmlContent}
                    fallbackText={payload.preview || payload.content}
                    preview={false}
                    style={{
                        fontSize: "var(--clipboard-item-font-size)",
                        lineHeight: "22px"
                    }}
                />
            );
        }
        return payload.content || payload.preview || "";
    }, [payload, effectiveRichImageFallbackSrc, plainTextFallback, useRichImageFallback]);

    return (
        <div
            className={`compact-preview-panel theme-${normalizeThemeId(payload?.theme || DEFAULT_THEME)} ${payload?.colorMode === "dark" ? "dark-mode" : "light-mode"}`}
            onMouseEnter={() => {
                emitTo("main", "compact-preview-pointer", true).catch(() => { });
            }}
            onMouseLeave={() => {
                emitTo("main", "compact-preview-pointer", false).catch(() => { });
            }}
        >
            <div className="preview-header">
                <div className="preview-header-row">
                    <div className="preview-title">
                        {getIcon(payload?.contentType || "text")}
                        <span>{panelTitle}</span>
                    </div>
                    <span className="preview-type-badge">{typeLabel}</span>
                </div>
                {(mediaMetaText || showMetaLine) && (
                    <div className="preview-subtitle">
                        {mediaMetaText}
                        {mediaMetaText && showMetaLine ? " · " : ""}
                        {payload?.sourceApp || ""}
                        {payload?.sourceApp && payload?.timestamp && payload?.language ? " · " : ""}
                        {payload?.timestamp && payload?.language
                            ? getConciseTime(payload.timestamp, payload.language)
                            : ""}
                    </div>
                )}
            </div>
            <div className={`preview-content${payload?.contentType === "image" || payload?.contentType === "video" ? " preview-content-media" : ""}`}>{content}</div>
        </div>
    );
};

export default CompactPreviewWindow;
