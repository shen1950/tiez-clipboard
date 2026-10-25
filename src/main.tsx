import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import CompactPreviewWindow from "./features/clipboard/components/CompactPreviewWindow";
import AdvancedSettingsWindow from "./features/settings/components/AdvancedSettingsWindow";
import SettingsWindow from "./features/settings/components/SettingsWindow";
import "./index.css";
import "./styles/components/index.css";
import "./styles/themes/load";

// 预览窗和设置窗不走 App 的路由，App 里的 useContextMenuBlock 对它们无效，
// 所以右键图片会弹出 WebView2 的默认菜单（将图像另存为／复制图像…）。
// 那个菜单是属主为面板窗口的独立顶层 HWND，面板一旦在它开着时被 hide() 就会
// 变成留在最上层的孤儿窗口，所以拦截必须放在路由之前、对所有窗口生效。
if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  }, true);
}

const params = new URLSearchParams(window.location.search);
const isCompactPreview = params.get("window") === "compact-preview";
const isAdvancedSettingsWindow = params.get("window") === "advanced-settings";
const isSettingsWindow = params.get("window") === "settings";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isCompactPreview
      ? <CompactPreviewWindow />
      : isAdvancedSettingsWindow
        ? <AdvancedSettingsWindow />
        : isSettingsWindow
          ? <SettingsWindow />
          : <App />}
  </React.StrictMode>,
);
