import { useEffect, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  MessageSquare,
  Pin,
  PinOff,
  Search,
  Settings as SettingsIcon,
  Smile,
  Tag,
  Trash2,
  ArchiveRestore,
  X
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getTagColor, getTagTextColor } from "../../../shared/lib/utils";

interface AppHeaderProps {
  t: (key: string) => string;
  showSettings: boolean;
  showTagManager: boolean;
  setShowTagManager: (val: boolean) => void;
  tagManagerEnabled: boolean;
  showEmojiPanel: boolean;
  setShowEmojiPanel: (val: boolean) => void;
  emojiPanelEnabled: boolean;
  showRecycleBin: boolean;
  setShowRecycleBin: (val: boolean) => void;
  isWindowPinned: boolean;
  setIsWindowPinned: (val: boolean) => void;
  clearHistory: (contentType?: string | null, typeLabel?: string | null) => void;
  showSearchBox: boolean;
  search: string;
  setSearch: (val: string) => void;
  setIsComposing: (val: boolean) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  showTagFilter: boolean;
  setShowTagFilter: (val: boolean) => void;
  allTags: string[];
  tagColors: Record<string, string>;
  searchIsFocused: boolean;
  setSearchIsFocused: (val: boolean) => void;
  setEditingTagsId: (val: number | null) => void;
  theme: string;
  colorMode: string;
  typeFilter: string | null;
  setTypeFilter: (val: string | null) => void;
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenChat?: () => void;
}

/** 类型页签与「按类型清空」菜单共用同一份顺序。 */
const CONTENT_TYPES = ["text", "image", "file", "url", "code", "video", "rich_text"];

const AppHeader = ({
  t,
  showSettings,
  showTagManager,
  setShowTagManager,
  tagManagerEnabled,
  showEmojiPanel,
  setShowEmojiPanel,
  emojiPanelEnabled,
  showRecycleBin,
  setShowRecycleBin,
  isWindowPinned,
  setIsWindowPinned,
  clearHistory,
  showSearchBox,
  search,
  setSearch,
  setIsComposing,
  searchInputRef,
  showTagFilter,
  setShowTagFilter,
  allTags,
  tagColors,
  searchIsFocused,
  setSearchIsFocused,
  setEditingTagsId,
  theme,
  colorMode,
  typeFilter,
  setTypeFilter,
  onBack,
  onOpenSettings,
  onOpenChat
}: AppHeaderProps) => {
  const getTypeName = (type: string) => {
    switch (type) {
      case "code": return t('type_code');
      case "link":
      case "url": return t('type_url');
      case "file": return t('type_file');
      case "image": return t('type_image');
      case "video": return t('type_video');
      case "rich_text": return t('type_rich_text');
      default: return t('type_text') || 'Text';
    }
  };

  // 清空菜单：一次点击选范围，避免"想清一类却清了全部"。
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const clearMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!clearMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!clearMenuRef.current?.contains(e.target as Node)) setClearMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 捕获阶段拦下 Esc，只关菜单，别连带把主窗口也隐藏了。
      e.stopPropagation();
      setClearMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [clearMenuOpen]);

  const runClear = (type: string | null) => {
    setClearMenuOpen(false);
    clearHistory(type, type ? getTypeName(type) : null);
  };

  return (
  <header className="window-drag-region">
    <div className="header-top">
      <div className="header-leading">
        {(showSettings || showTagManager || showEmojiPanel || showRecycleBin) && (
          <button className="btn-icon window-no-drag" onClick={onBack}>
            <ChevronLeft size={18} />
          </button>
        )}
        <div className="header-drag-region" data-tauri-drag-region>
          <span className="header-title">
            {showEmojiPanel
              ? (t('emoji_panel') || '表情包')
              : showTagManager && tagManagerEnabled
                ? (t('tag_manager') || '标签管理')
                : showRecycleBin
                  ? (t('recycle_bin') || '回收站')
                  : t('app_name')}
          </span>
        </div>
      </div>
      <div className="header-actions window-no-drag">
        {/* Pin Button - Always visible but single instance */}
        <button
          className={`btn-icon ${isWindowPinned ? 'active' : ''}`}
          title={t('pin')}
          onClick={() => {
            const newVal = !isWindowPinned;
            setIsWindowPinned(newVal);
            invoke("set_window_pinned", { pinned: newVal }).catch(console.error);
          }}
        >
          {isWindowPinned ? <PinOff size={16} /> : <Pin size={16} />}
        </button>

        {!showSettings && !showTagManager && !showEmojiPanel && (
          <>
            <div className="header-menu-anchor window-no-drag" ref={clearMenuRef}>
              <button
                className={`btn-icon ${clearMenuOpen ? 'active' : ''}`}
                title={t('clear_history')}
                onClick={() => setClearMenuOpen(open => !open)}
              >
                <Trash2 size={16} />
              </button>
              {clearMenuOpen && (
                <div className="header-menu">
                  <div className="header-menu-label">{t('clear_scope')}</div>
                  <button className="header-menu-item header-menu-item--primary" onClick={() => runClear(null)}>
                    {t('clear_all')}
                  </button>
                  <div className="header-menu-divider" />
                  {CONTENT_TYPES.map(type => (
                    <button
                      key={type}
                      className={`header-menu-item ${typeFilter === type ? 'active' : ''}`}
                      onClick={() => runClear(type)}
                    >
                      {getTypeName(type)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {tagManagerEnabled && (
              <button className="btn-icon" title={t('tag_manager') || '标签管理'} onClick={() => { setShowRecycleBin(false); setShowTagManager(true); }}>
                <Tag size={16} />
              </button>
            )}
            {emojiPanelEnabled && (
              <button className="btn-icon" title={t('emoji_panel') || '表情包'} onClick={() => { setShowRecycleBin(false); setShowEmojiPanel(true); }}>
                <Smile size={16} />
              </button>
            )}
            <button
              className={`btn-icon ${showRecycleBin ? 'active' : ''}`}
              title={t('recycle_bin')}
              onClick={() => setShowRecycleBin(!showRecycleBin)}
            >
              <ArchiveRestore size={16} />
            </button>
            <button className="btn-icon" title={t('settings')} onClick={() => { setShowRecycleBin(false); onOpenSettings(); }}>
              <SettingsIcon size={16} />
            </button>
          </>
        )}
        {/* 常驻：之前被 fileServerEnabled 门控，服务一自动关闭按钮就跟着消失，
            用户以为功能时有时无。 */}
        <button
          className="btn-icon header-chat-btn"
          title={t('open_chat')}
          onClick={onOpenChat}
        >
          <MessageSquare size={16} />
        </button>
        <button className="btn-icon" title={t('hide')} onClick={async () => {
          invoke("hide_window_cmd").catch(console.error);
        }}>
          <X size={16} />
        </button>
      </div>
    </div>

    {!showSettings && !showTagManager && !showEmojiPanel && !showRecycleBin && (
      <AnimatePresence>
        {(showSearchBox || search.trim().length > 0) && (
          <motion.div
            initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
            animate={{
              height: "auto",
              opacity: 1,
              transitionEnd: { overflow: "visible" }
            }}
            exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
            transition={{ duration: 0.2, ease: "circOut" }}
            style={{ flexShrink: 0 }}
          >
            <div className="search-container window-no-drag">
              <div style={{ position: 'relative' }}>
                <Search size={14} className="search-icon" />
                <input
                  ref={searchInputRef}
                  type="text"
                  className={`search-input ${showTagFilter && allTags.length > 0 ? 'dropdown-open' : ''}`}
                  placeholder={t('search_placeholder')}
                  value={search}
                  onCompositionStart={() => setIsComposing(true)}
                  onCompositionEnd={(e) => {
                    setIsComposing(false);
                    setSearch((e.target as HTMLInputElement).value);
                  }}
                  onChange={(e) => {
                    setSearch(e.target.value);
                  }}
                  onMouseDown={() => {
                    invoke("activate_window_focus").catch(console.error);
                  }}
                  onClick={() => { setShowTagFilter(true); setEditingTagsId(null); }}
                  onFocus={() => {
                    invoke("activate_window_focus").catch(console.error);
                    setShowTagFilter(true);
                    setSearchIsFocused(true);
                    setEditingTagsId(null);
                  }}
                  onBlur={() => {
                    setTimeout(() => {
                      setShowTagFilter(false);
                      setSearchIsFocused(false);
                    }, 200);
                  }}
                  style={{ color: colorMode === 'dark' ? '#ffffff' : undefined }}
                />
                {showTagFilter && searchIsFocused && allTags.length > 0 && (
                  <div className="tags-dropdown">
                    <div className="tags-label">{t('tags') || "Tags"}</div>
                    <div className="tags-list">
                      {allTags.map(tag => {
                        // Prefer the color saved in tag management; fall back to the generated one
                        const tagBackground = tagColors?.[tag] || getTagColor(tag, theme);
                        return (
                          <span
                            className="tag-chip"
                            key={tag}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setSearch("tag:" + tag);
                              setShowTagFilter(false);
                            }}
                            data-tag={tag}
                            style={{ background: tagBackground, color: getTagTextColor(tagBackground) }}
                          >
                            {tag}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              <div
                className="hide-scrollbar"
                style={{
                  display: 'flex',
                  gap: '6px',
                  padding: '8px 0 0 0',
                  overflowX: 'auto',
                  scrollbarWidth: 'none',
                  msOverflowStyle: 'none'
                }}
                onWheel={(e) => {
                  if (e.deltaY !== 0) {
                    e.currentTarget.scrollLeft += e.deltaY;
                  }
                }}
              >
                {CONTENT_TYPES.map(type => (
                  <button
                    key={type}
                    className={`btn-icon ${typeFilter === type ? 'active' : ''}`}
                    onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                    style={{
                      width: 'auto',
                      padding: '4px 8px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                      opacity: typeFilter === type ? 1 : 0.7
                    }}
                    title={getTypeName(type)}
                  >
                    {getTypeName(type)}
                  </button>
                ))}
              </div>

            </div>
          </motion.div>
        )}
      </AnimatePresence>
    )}
  </header>
);
};

export default AppHeader;
