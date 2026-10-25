import { useEffect } from "react";

export const useContextMenuBlock = () => {
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    // Capture phase: still block WKWebView default menu if a child handler early-returns.
    document.addEventListener("contextmenu", handleContextMenu, true);
    return () => document.removeEventListener("contextmenu", handleContextMenu, true);
  }, []);
};
