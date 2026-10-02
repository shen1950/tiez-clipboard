import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
// currentMonitor 是模块级函数（该版本 Tauri API 的 Window 实例上没有）

/**
 * KwikPaste 预览面板的尺寸与摆放算法，移植自 KwikPaste
 * `src-tauri/src/window/preview.rs`（前端版）。
 *
 * 核心原则：面板尺寸在开窗前就按内容度量算好，窗口一次到位——
 * 不做 DOM 测量、不发 resize 事件、不二次调整，所以不会跳、不会闪。
 * 常量单位是逻辑 px，与预览页 CSS 保持一致：
 * header 固定 72px，文本行 22px，图片区四周各 32px。
 */
export const PREVIEW_PANEL = {
    MIN_WIDTH: 288,
    // 上限给到接近半屏（KwikPaste 在 125% 缩放的 1080p 屏上有效宽约 820 逻辑像素），
    // 小屏由 available（显示器尺寸 - 边距）自然收紧。
    MAX_WIDTH: 860,
    MIN_HEIGHT: 96,
    MAX_HEIGHT: 940,
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
export type PreviewPlacement = "right" | "left" | "bottom" | "top";

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

export type PreviewPanelInput = {
    contentType: string;
    /** 纯文本内容（text/code/url 直接用；rich_text 传 HTML，内部会剥标签）。 */
    content: string;
    htmlContent?: string;
    /** 列表里已加载 <img> 读到的原始尺寸，缺省时图片用兜底面板。 */
    imageNatural?: ImageDisplaySize | null;
};

export type PreviewPanelPlan = PreviewSize & {
    /** 图片按原始比例缩放后的显示尺寸；面板 CSS 按此精确渲染。 */
    imageDisplay?: ImageDisplaySize;
};

/** 按内容度量算出面板尺寸（KwikPaste `resolve_panel_size` 的移植）。 */
export const computePreviewPanelSize = (
    input: PreviewPanelInput,
    available: { width: number; height: number }
): PreviewPanelPlan => {
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

    // 文本类：宽度固定取上限，高度按行数估（KwikPaste `text_content_height`）。
    const contentWidth = maxW - PREVIEW_PANEL.IMAGE_PADDING;
    const text = (input.contentType === "rich_text" && input.htmlContent
        ? stripHtml(input.htmlContent)
        : (input.content || "")).replace(/\s+$/, "");
    const rows = measureTextRows(text, contentWidth);
    const height = PREVIEW_PANEL.HEADER_HEIGHT
        + rows * PREVIEW_PANEL.TEXT_ROW_HEIGHT
        + PREVIEW_PANEL.TEXT_V_PADDING;
    return {
        width: maxW,
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
 * KwikPaste `resolve_placement` + `raw_panel_rect` + `clamp_rect`：
 * 按偏好侧顺序（偏好 → 对侧 → 下 → 上）找第一个在安全区内放得下的方位，
 * 面板垂直居中于卡片、水平留出间距；都放不下时回落到偏好侧并夹进安全区。
 */
export const resolvePreviewPlacement = (
    cardLogical: PreviewRect,
    size: PreviewSize,
    available: PreviewRect,
    preferLeft: boolean
): { rect: PreviewRect; placement: PreviewPlacement } => {
    const candidates: PreviewPlacement[] = preferLeft
        ? ["left", "right", "bottom", "top"]
        : ["right", "left", "bottom", "top"];

    const fits = (placement: PreviewPlacement) => {
        switch (placement) {
            case "right":
                return cardLogical.left + cardLogical.width + PREVIEW_PANEL.GAP + size.width <= available.left + available.width;
            case "left":
                return cardLogical.left - PREVIEW_PANEL.GAP - size.width >= available.left;
            case "bottom":
                return cardLogical.top + cardLogical.height + PREVIEW_PANEL.GAP + size.height <= available.top + available.height;
            case "top":
                return cardLogical.top - PREVIEW_PANEL.GAP - size.height >= available.top;
        }
    };

    const rawRect = (placement: PreviewPlacement): PreviewRect => {
        const centeredTop = cardLogical.top + cardLogical.height / 2 - size.height / 2;
        const centeredLeft = cardLogical.left + cardLogical.width / 2 - size.width / 2;
        switch (placement) {
            case "right":
                return { left: cardLogical.left + cardLogical.width + PREVIEW_PANEL.GAP, top: centeredTop, width: size.width, height: size.height };
            case "left":
                return { left: cardLogical.left - PREVIEW_PANEL.GAP - size.width, top: centeredTop, width: size.width, height: size.height };
            case "bottom":
                return { left: centeredLeft, top: cardLogical.top + cardLogical.height + PREVIEW_PANEL.GAP, width: size.width, height: size.height };
            case "top":
                return { left: centeredLeft, top: cardLogical.top - PREVIEW_PANEL.GAP - size.height, width: size.width, height: size.height };
        }
    };

    let placement = candidates.find(fits) ?? (preferLeft ? "left" : "right");
    let rect = rawRect(placement);
    // 夹进安全区（KwikPaste `clamp_rect`）。
    const maxLeft = Math.max(available.left, available.left + available.width - rect.width);
    const maxTop = Math.max(available.top, available.top + available.height - rect.height);
    rect = {
        width: rect.width,
        height: rect.height,
        left: clamp(rect.left, available.left, maxLeft),
        top: clamp(rect.top, available.top, maxTop)
    };
    if (!candidates.includes(placement)) placement = preferLeft ? "left" : "right";
    return { rect, placement };
};
