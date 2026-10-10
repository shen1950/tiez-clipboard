import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
// currentMonitor 是模块级函数（该版本 Tauri API 的 Window 实例上没有）
import { invoke } from "@tauri-apps/api/core";
import { toTauriLocalImageSrc } from "../../../shared/lib/localImageSrc";
import { sanitizeRichPreviewHtml } from "../../../shared/components/HtmlContent";
import { resolveUiFontFamily } from "../../../shared/config/fonts";

/**
 * KwikPaste 预览面板的尺寸与摆放算法，移植自 KwikPaste
 * `src-tauri/src/window/preview.rs`（前端版）。
 *
 * 核心原则：面板尺寸在开窗前就按内容度量算好，窗口一次到位——
 * 不发 resize 事件、显示后不二次调整，所以不会跳、不会闪。
 * 文本类高度用主窗口里的隐藏探针按真实 CSS 排版测量（与预览窗口
 * 同一套样式表、同字体链，测量即所见），画布估行只作兜底。
 * 常量单位是逻辑 px，与预览页 CSS 保持一致：
 * header 固定 72px，图片区四周各 32px。
 */
export const PREVIEW_PANEL = {
    MIN_WIDTH: 288,
    // 上限给到接近半屏（KwikPaste 在 125% 缩放的 1080p 屏上有效宽约 820 逻辑像素），
    // 小屏由 available（显示器尺寸 - 边距）自然收紧。
    MAX_WIDTH: 860,
    MIN_HEIGHT: 96,
    // 高度上限交给显示器可用空间兜（长文预览应尽量铺满屏幕而不是留大片空白），
    // 这里只挡住超巨屏上的极端值。
    MAX_HEIGHT: 2000,
    HEADER_HEIGHT: 72,
    IMAGE_PADDING: 32,
    TEXT_ROW_HEIGHT: 22,
    TEXT_V_PADDING: 32,
    /** 图片/视频缺少原始尺寸时的兜底面板。 */
    FALLBACK_WIDTH: 320,
    FALLBACK_HEIGHT: 240,
    /** 面板与卡片之间的间距。 */
    GAP: 40,
    /** 面板到屏幕边缘的安全边距。 */
    MARGIN: 32,
} as const;

export type PreviewSize = { width: number; height: number };
export type ImageDisplaySize = { width: number; height: number };
export type PreviewRect = { left: number; top: number; width: number; height: number };
/** 面板只能落在主窗口左右两侧（上下会盖住列表本身）。 */
export type PreviewPlacement = "right" | "left";

const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

export type MonitorInfo = {
    /** 显示器原点（物理 px）。 */
    origin: { x: number; y: number };
    /** 显示器尺寸（逻辑 px，已除以缩放）。 */
    width: number;
    height: number;
    scaleFactor: number;
};

/** 主窗口所在显示器的信息，供面板度量与摆放使用。 */
export const resolvePreviewMonitor = async (): Promise<MonitorInfo> => {
    const appWindow = getCurrentWindow();
    const [monitor, scale] = await Promise.all([
        currentMonitor().catch(() => null),
        appWindow.scaleFactor().catch(() => 1)
    ]);
    const safeScale = scale > 0 ? scale : 1;
    return {
        origin: { x: monitor?.position.x ?? 0, y: monitor?.position.y ?? 0 },
        width: (monitor?.size.width ?? 1920) / safeScale,
        height: (monitor?.size.height ?? 1080) / safeScale,
        scaleFactor: safeScale
    };
};

/** 文本行数估算：按行测量宽度后除以内容宽度（CJK 按字符折行，误差可接受）。 */
export const measureTextRows = (text: string, contentWidth: number): number => {
    if (!text || contentWidth <= 0) return 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return 1;
    ctx.font = "13px 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif";
    let rows = 0;
    for (const line of text.split("\n")) {
        if (!line) {
            rows += 1;
            continue;
        }
        rows += Math.max(1, Math.ceil(ctx.measureText(line).width / contentWidth));
    }
    return rows;
};

const stripHtml = (html: string): string =>
    html
        .replace(/<!--TIEZ_RICH_IMAGE:[\s\S]*?-->/g, "")
        .replace(/<(style|script)[^>]*>[\s\S]*?<\/(style|script)>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

// 富文本里的“真图片”回退标记：Excel 表格等复制会带一张位图兜底，
// 预览与测量都要先把这段注释剥掉再渲染。
const RICH_IMAGE_FALLBACK_PREFIX = "<!--TIEZ_RICH_IMAGE:";
const RICH_IMAGE_FALLBACK_SUFFIX = "-->";

export const extractRichImageFallback = (html?: string): { cleanHtml?: string; imagePayload?: string } => {
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

// 与 CompactPreviewWindow 的渲染决策保持一致：表格类 HTML / 表格类来源应用 /
// 动图回退时，预览渲染的是“真图片”而不是富文本 HTML，测量也必须走同一分支。
const TABULAR_RICH_HTML_RE = /<(table|tr|td|th|thead|tbody|tfoot|colgroup|col)\b/i;
const SPREADSHEET_SOURCE_RE = /\b(excel|et|wps|sheet|spreadsheet|calc)\b/i;

export const richHtmlLooksTabular = (html?: string): boolean =>
    !!html && TABULAR_RICH_HTML_RE.test(html);

export const isSpreadsheetLikeSource = (sourceApp?: string): boolean =>
    !!sourceApp && SPREADSHEET_SOURCE_RE.test(sourceApp.trim());

export const isAnimatedGifSrc = (src?: string | null): boolean => {
    const value = (src || "").trim().toLowerCase();
    if (!value) return false;
    return value.startsWith("data:image/gif") || /\.gif(?:$|[?#])/i.test(value);
};

export const resolveRichImageSrc = (payload: string): string | null => {
    const value = payload.trim();
    if (!value) return null;
    if (value.startsWith("data:image/")) return value;
    if (/^https?:\/\/asset\.localhost\//i.test(value)) return value;
    return toTauriLocalImageSrc(value);
};

/** 富文本预览最终渲染的是位图回退时的图片 src（无回退时为 null）。 */
export const resolveRichImageFallbackSrc = (
    html: string | undefined,
    sourceApp?: string
): string | null => {
    if (!html) return null;
    const { imagePayload } = extractRichImageFallback(html);
    if (!imagePayload) return null;
    const src = resolveRichImageSrc(imagePayload);
    if (!src) return null;
    return isAnimatedGifSrc(src)
        || ((richHtmlLooksTabular(html) || isSpreadsheetLikeSource(sourceApp)) && !!src)
        ? src
        : null;
};

/**
 * 隐藏测量探针：主窗口里复刻一个 .compact-preview-panel（预览窗口同一套
 * 样式表、同一字体链、同一主题变量），把内容按真实 CSS 排版后量高度。
 * 相比画布估行数，这里的结果与预览窗口的实际渲染逐像素一致。
 */
let probePanel: HTMLDivElement | null = null;

const IMG_LAZY_SRC_ATTRS = [
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-actualsrc",
    "data-url"
] as const;

const ensurePreviewProbe = (): HTMLDivElement | null => {
    if (probePanel?.isConnected) return probePanel;
    if (typeof document === "undefined" || !document.body) return null;
    const panel = document.createElement("div");
    panel.className = "compact-preview-panel compact-preview-probe";
    panel.setAttribute("aria-hidden", "true");
    const content = document.createElement("div");
    content.className = "preview-content";
    panel.appendChild(content);
    const s = panel.style;
    s.position = "fixed";
    s.left = "-99999px";
    s.top = "0px";
    s.visibility = "hidden";
    s.pointerEvents = "none";
    s.zIndex = "-1";
    // 覆盖面板默认的 width/height:100% 与 overflow:hidden，让内容自然撑开。
    s.width = "0px";
    s.height = "auto";
    s.overflow = "visible";
    s.display = "flex";
    s.flexDirection = "column";
    document.body.appendChild(panel);
    probePanel = panel;
    return panel;
};

// 探针里的懒加载图与预览窗口一样要解析出真实 src，否则图片按 0 高参与排版。
const repairProbeImageSrcs = (root: HTMLElement) => {
    root.querySelectorAll("img").forEach((img) => {
        if (img.getAttribute("src")?.trim()) return;
        const lazy = IMG_LAZY_SRC_ATTRS
            .map((name) => img.getAttribute(name)?.trim() || "")
            .find(Boolean);
        const srcsetPrimary = (img.getAttribute("srcset") || "")
            .split(",")[0]?.trim().split(/\s+/)[0] || "";
        const resolved = lazy || srcsetPrimary;
        if (!resolved) return;
        const finalSrc = /^(data:|https?:|blob:|asset:|tauri:|file:)/i.test(resolved)
            ? resolved
            : (toTauriLocalImageSrc(resolved) || resolved);
        if (finalSrc) img.setAttribute("src", finalSrc);
    });
};

export type ContentMeasurer = (content: HTMLDivElement) => void;

/** 预览字号/字体：探针和预览窗口必须走同一套变量，量出来的才等于渲染出来的。 */
export type PreviewFont = { size?: number; family?: string };

/** 预览字号/字体只存设置库：主窗测量、预览窗渲染、设置面板回显都读同一份，
 *  省掉跨窗口同步（设置窗改了主窗不一定知道）。没设置过时给 14px，
 *  比原来写死的 13px 更易读。 */
export const DEFAULT_PREVIEW_FONT_SIZE = 14;

export const resolvePreviewFont = async (): Promise<PreviewFont> => {
    try {
        const settings = await invoke<Record<string, string>>("get_settings");
        const size = parseInt(settings?.["app.preview_font_size"] || "", 10);
        return {
            size: Number.isFinite(size) ? size : DEFAULT_PREVIEW_FONT_SIZE,
            family: settings?.["app.preview_font_family"] || "default"
        };
    } catch {
        return { size: DEFAULT_PREVIEW_FONT_SIZE };
    }
};

export const applyPreviewFontVars = (el: HTMLElement, font?: PreviewFont) => {
    const size = font?.size;
    if (size) {
        el.style.setProperty("--preview-font-size", `${size}px`);
        el.style.setProperty("--preview-line-height", `${Math.round(size * 1.65)}px`);
    } else {
        el.style.removeProperty("--preview-font-size");
        el.style.removeProperty("--preview-line-height");
    }
    const family = resolveUiFontFamily(font?.family);
    if (family) el.style.setProperty("--preview-font-family", family);
    else el.style.removeProperty("--preview-font-family");
};

/** 按真实排版量出 .preview-content 的内容高度（含自身 32px 内边距）。 */
export const measurePreviewContentHeight = async (
    render: ContentMeasurer,
    panelWidth: number,
    font?: PreviewFont
): Promise<number | null> => {
    const panel = ensurePreviewProbe();
    if (!panel) return null;
    const content = panel.querySelector<HTMLDivElement>(".preview-content");
    if (!content) return null;

    panel.style.width = `${Math.max(1, Math.round(panelWidth))}px`;
    applyPreviewFontVars(panel, font);
    content.textContent = "";
    try {
        render(content);
        repairProbeImageSrcs(content);
        const images = Array.from(content.querySelectorAll("img"));
        const pending = images
            .filter((img) => !img.complete)
            .map((img) => new Promise<void>((resolve) => {
                img.addEventListener("load", () => resolve(), { once: true });
                img.addEventListener("error", () => resolve(), { once: true });
            }));
        if (pending.length > 0) {
            await Promise.race([
                Promise.all(pending),
                new Promise((resolve) => setTimeout(resolve, 250))
            ]);
        }
        const height = Math.ceil(content.scrollHeight);
        return height > 0 ? height : null;
    } catch {
        return null;
    } finally {
        content.textContent = "";
    }
};

export type PreviewPanelInput = {
    contentType: string;
    /** 纯文本内容（text/code/url 直接用；rich_text 传 HTML，内部会剥标签）。 */
    content: string;
    htmlContent?: string;
    /** 列表里已加载 <img> 读到的原始尺寸，缺省时图片用兜底面板。 */
    imageNatural?: ImageDisplaySize | null;
    /** 来源应用：用于判断富文本是否走“真图片”回退（Excel 等）。 */
    sourceApp?: string;
    /** 预览字号/字体，测量探针按它排版。 */
    font?: PreviewFont;
};

export type PreviewPanelPlan = PreviewSize & {
    /** 图片按原始比例缩放后的显示尺寸；面板 CSS 按此精确渲染。 */
    imageDisplay?: ImageDisplaySize;
};

/** 按内容度量算出面板尺寸（KwikPaste `resolve_panel_size` 的移植）。 */
export const computePreviewPanelSize = async (
    input: PreviewPanelInput,
    available: { width: number; height: number }
): Promise<PreviewPanelPlan> => {
    const maxW = Math.min(PREVIEW_PANEL.MAX_WIDTH, Math.max(1, available.width));
    const maxH = Math.min(PREVIEW_PANEL.MAX_HEIGHT, Math.max(1, available.height));

    if (input.contentType === "image") {
        const natural = input.imageNatural;
        if (!natural || natural.width <= 0 || natural.height <= 0) {
            return { width: PREVIEW_PANEL.FALLBACK_WIDTH, height: PREVIEW_PANEL.FALLBACK_HEIGHT };
        }
        // KwikPaste `image_panel_size`：等比缩放到上限内，面板正好裹住图 + 内边距 + 头部。
        const maxImageW = Math.max(1, maxW - PREVIEW_PANEL.IMAGE_PADDING);
        const maxImageH = Math.max(1, maxH - PREVIEW_PANEL.HEADER_HEIGHT - PREVIEW_PANEL.IMAGE_PADDING);
        const scale = Math.min(1, maxImageW / natural.width, maxImageH / natural.height);
        const displayWidth = Math.max(1, Math.floor(natural.width * scale));
        const displayHeight = Math.max(1, Math.floor(natural.height * scale));
        return {
            width: clamp(displayWidth + PREVIEW_PANEL.IMAGE_PADDING, PREVIEW_PANEL.MIN_WIDTH, maxW),
            height: clamp(
                displayHeight + PREVIEW_PANEL.HEADER_HEIGHT + PREVIEW_PANEL.IMAGE_PADDING,
                PREVIEW_PANEL.MIN_HEIGHT,
                maxH
            ),
            imageDisplay: { width: displayWidth, height: displayHeight }
        };
    }

    if (input.contentType === "video") {
        return {
            width: clamp(PREVIEW_PANEL.FALLBACK_WIDTH + PREVIEW_PANEL.IMAGE_PADDING, PREVIEW_PANEL.MIN_WIDTH, maxW),
            height: clamp(
                PREVIEW_PANEL.FALLBACK_HEIGHT + PREVIEW_PANEL.HEADER_HEIGHT,
                PREVIEW_PANEL.MIN_HEIGHT,
                maxH
            )
        };
    }

    // 文本类：宽度固定取上限，高度按真实排版测量（隐藏探针与预览窗口同 CSS 同字体），
    // 探针不可用时退回画布估行数。注意这里必须原样保留尾部空白，与预览渲染一致。
    const width = maxW;
    const isRichText = input.contentType === "rich_text" && !!input.htmlContent;
    const plainText = input.content || "";

    const measured = await measurePreviewContentHeight((el) => {
        if (isRichText) {
            const fallbackSrc = resolveRichImageFallbackSrc(input.htmlContent, input.sourceApp);
            if (fallbackSrc) {
                const img = document.createElement("img");
                img.src = fallbackSrc;
                el.appendChild(img);
                return;
            }
            // 与预览窗口的 HtmlContent 渲染同源：先净化再入 DOM，空内容时回落纯文本。
            const { html: cleanHTML, hasRenderable } = sanitizeRichPreviewHtml(
                extractRichImageFallback(input.htmlContent).cleanHtml || ""
            );
            if (!hasRenderable && plainText) {
                el.textContent = plainText;
                return;
            }
            const wrap = document.createElement("div");
            wrap.className = "rich-text-preview";
            wrap.innerHTML = cleanHTML;
            el.appendChild(wrap);
            return;
        }
        el.textContent = plainText;
    }, width, input.font);
    if (measured != null) {
        return {
            width,
            height: clamp(
                PREVIEW_PANEL.HEADER_HEIGHT + measured + 2,
                PREVIEW_PANEL.MIN_HEIGHT,
                maxH
            )
        };
    }

    const contentWidth = maxW - PREVIEW_PANEL.IMAGE_PADDING;
    const text = (isRichText ? stripHtml(input.htmlContent!) : plainText);
    const rows = measureTextRows(text, contentWidth);
    const height = PREVIEW_PANEL.HEADER_HEIGHT
        + rows * PREVIEW_PANEL.TEXT_ROW_HEIGHT
        + PREVIEW_PANEL.TEXT_V_PADDING;
    return {
        width,
        height: clamp(height, PREVIEW_PANEL.MIN_HEIGHT, maxH)
    };
};

/** 把视口内的卡片矩形（CSS px）映射为屏幕物理矩形。 */
export const cardRectToPhysical = (
    rect: { left: number; top: number; width: number; height: number },
    windowInnerOrigin: { x: number; y: number },
    scaleFactor: number
) => ({
    left: Math.round(windowInnerOrigin.x + rect.left * scaleFactor),
    top: Math.round(windowInnerOrigin.y + rect.top * scaleFactor),
    width: Math.round(rect.width * scaleFactor),
    height: Math.round(rect.height * scaleFactor)
});

/**
 * 主窗口左右两侧还能容下面板的空隙宽度（逻辑 px，可能为负）。
 * 注意锚点是整个主窗口而不只是悬停的那张卡片：卡片只有 352px 宽，
 * 按卡片算会让面板压到列表其余行上。
 */
export const computePreviewSideRooms = (
    windowLogical: PreviewRect,
    available: PreviewRect
): Record<PreviewPlacement, number> => ({
    left: windowLogical.left - PREVIEW_PANEL.GAP - available.left,
    right: available.left + available.width - (windowLogical.left + windowLogical.width) - PREVIEW_PANEL.GAP
});

/**
 * 定侧：偏好侧放得下就用偏好侧，否则换对侧；两侧都放不下时取空隙更大的那侧
 * （此时只能让面板收窄到该侧空隙，仍保证不盖住主窗口）。
 */
export const resolvePreviewSide = (
    rooms: Record<PreviewPlacement, number>,
    preferLeft: boolean,
    minWidth: number
): PreviewPlacement => {
    const preferred: PreviewPlacement = preferLeft ? "left" : "right";
    const opposite: PreviewPlacement = preferLeft ? "right" : "left";
    if (rooms[preferred] >= minWidth) return preferred;
    if (rooms[opposite] >= minWidth) return opposite;
    return rooms[preferred] >= rooms[opposite] ? preferred : opposite;
};

/**
 * KwikPaste `resolve_placement` + `raw_panel_rect` + `clamp_rect` 的改造版：
 * 面板紧贴主窗口某一侧（留出 GAP），垂直居中于悬停卡片。
 * 宽度由调用方按该侧空隙量体裁衣，所以水平方向天然放得下、不会与主窗口相交；
 * 这里只对屏幕安全区做兜底夹取（极端小屏上空隙不足最小宽度时才会略微重叠）。
 */
export const resolvePreviewPlacement = (
    cardLogical: PreviewRect,
    windowLogical: PreviewRect,
    size: PreviewSize,
    available: PreviewRect,
    side: PreviewPlacement
): { rect: PreviewRect; placement: PreviewPlacement } => {
    const anchoredLeft = side === "right"
        ? windowLogical.left + windowLogical.width + PREVIEW_PANEL.GAP
        : windowLogical.left - PREVIEW_PANEL.GAP - size.width;
    const centeredTop = cardLogical.top + cardLogical.height / 2 - size.height / 2;
    const maxLeft = Math.max(available.left, available.left + available.width - size.width);
    const maxTop = Math.max(available.top, available.top + available.height - size.height);
    return {
        placement: side,
        rect: {
            width: size.width,
            height: size.height,
            left: clamp(anchoredLeft, available.left, maxLeft),
            top: clamp(centeredTop, available.top, maxTop)
        }
    };
};
