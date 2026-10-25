import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, SetStateAction } from "react";
import type { ClipboardEntry } from "../types";
import type { AiProfile } from "../../features/settings/types";

interface UseAiActionsOptions {
  aiProfiles: AiProfile[];
  language: string;
  pushToast: (msg: string, duration?: number, action?: { label: string; onClick: () => void }) => number;
  onOpenSettings: () => void;
  setProcessingAiId: Dispatch<SetStateAction<number | null>>;
  setHistory: Dispatch<SetStateAction<ClipboardEntry[]>>;
  /** AI 结果落库后刷新历史（新条目出现在列表顶部）。 */
  refreshHistory: () => void;
}

export const useAiActions = ({
  aiProfiles,
  language,
  pushToast,
  onOpenSettings,
  setProcessingAiId,
  setHistory,
  refreshHistory
}: UseAiActionsOptions) => {
  const handleAIAction = useCallback(
    async (id: number, content: string, actionType: string) => {
      if (aiProfiles.length === 0) {
        pushToast(
          language === "zh"
            ? "请先在设置中添加 AI 模型"
            : "Please add an AI model in settings first",
          3000
        );
        onOpenSettings();
        return;
      }

      setProcessingAiId(id);
      try {
        const aiResponse = await invoke<string>("call_ai", { id, content, actionType });
        const trimmedResponse = aiResponse.trim();
        const questionMatch = trimmedResponse.match(/^\[\[QUESTION:(.+?)\]\]$/);

        // 嘴替追问：原条目只进入“补充信息”输入状态，内容保持原样不被改写；
        // 追问文本存在 _aiQuestion 里，输入框上方展示。
        if (questionMatch) {
          const questionText = questionMatch[1].trim();
          setHistory((prev) =>
            prev.map((item) =>
              item.id == id
                ? { ...item, isInputting: true, _aiQuestion: questionText }
                : item
            )
          );
          return;
        }

        // 普通结果：Rust 侧已把 AI 回答保存为新条目（source_app: "TieZ AI"），
        // 原条目保持不变；这里刷新历史并复位原条目的输入状态。
        setHistory((prev) =>
          prev.map((item) =>
            item.id == id
              ? { ...item, isInputting: false, _aiQuestion: undefined }
              : item
          )
        );
        refreshHistory();
        pushToast(
          language === "zh"
            ? "AI 结果已保存为新条目"
            : "AI result saved as a new entry",
          2200
        );
      } finally {
        setProcessingAiId(null);
      }
    },
    [aiProfiles, language, pushToast, setHistory, refreshHistory, setProcessingAiId, onOpenSettings]
  );

  return { handleAIAction };
};


