export interface ClipboardEntry {
  id: number;
  content_type: string;
  content: string;
  html_content?: string;
  source_app: string;
  source_app_path?: string;
  timestamp: number;
  preview: string;
  is_pinned: boolean;
  tags: string[];
  isInputting?: boolean;
  /** 嘴替追问：AI 的补充提问文本，仅在输入状态下展示，不写库。 */
  _aiQuestion?: string;
  questionCount?: number;
  use_count?: number;
  is_external?: boolean;
  pinned_order?: number;
  file_preview_exists?: boolean;
  deleted_at?: number | null; // Soft-delete timestamp; null = active, number = in recycle bin
}
