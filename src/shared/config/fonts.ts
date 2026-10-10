/** 界面里可选的字体栈；default 表示不覆盖，用主题自己的字体。 */
export const UI_FONT_FAMILIES: Record<string, string> = {
    default: "",
    sans: "'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif",
    serif: "'Times New Roman', Georgia, 'Songti SC', SimSun, serif",
    songti: "SimSun, '宋体', 'Songti SC', serif",
    kaiti: "KaiTi, '楷体', 'Kaiti SC', serif",
    mono: "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
};

export const FONT_FAMILY_VALUES = ["default", "sans", "serif", "songti", "kaiti", "mono"] as const;

export const resolveUiFontFamily = (value?: string | null): string =>
    UI_FONT_FAMILIES[value && value in UI_FONT_FAMILIES ? value : "default"];
