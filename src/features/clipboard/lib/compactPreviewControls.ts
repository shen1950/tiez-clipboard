type CompactPreviewControls = {
  forceHide: () => void;
  warmup: () => void;
  supported: () => boolean;
  warmupSupported: () => boolean;
};

let controls: CompactPreviewControls | null = null;

type HoverRecheckSubscriber = () => void;
const hoverRecheckSubscribers = new Set<HoverRecheckSubscriber>();
let hoverRecheckTimer: ReturnType<typeof setTimeout> | null = null;

export const registerHoverRecheckSubscriber = (subscriber: HoverRecheckSubscriber) => {
  hoverRecheckSubscribers.add(subscriber);
  return () => {
    hoverRecheckSubscribers.delete(subscriber);
  };
};

// 列表增删/重排后，补位到光标下的卡片收不到原生 mouseenter
// （WebView2 不为静止光标下的 DOM 位移补发边界事件），
// 由列表在数据变化后调用本函数，让各卡片按光标位置重判悬停。
export const scheduleHoverRecheckAfterListChange = () => {
  if (hoverRecheckTimer) clearTimeout(hoverRecheckTimer);
  hoverRecheckTimer = setTimeout(() => {
    hoverRecheckTimer = null;
    hoverRecheckSubscribers.forEach((subscriber) => subscriber());
  }, 120);
};

export const registerCompactPreviewControls = (next: CompactPreviewControls) => {
  controls = next;
};

export const forceHideCompactPreviewWindow = () => {
  controls?.forceHide();
};

export const warmupCompactPreviewWindow = () => {
  controls?.warmup();
};

export const isCompactPreviewWindowSupported = () =>
  controls?.supported() ?? false;

export const isCompactPreviewWarmupSupported = () =>
  controls?.warmupSupported() ?? false;
