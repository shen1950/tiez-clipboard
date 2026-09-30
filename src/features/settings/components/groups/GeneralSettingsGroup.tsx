import type { ComponentType, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight } from "lucide-react";

const isMacPlatform =
    /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform);

interface LabelWithHintProps {
    label: string;
    hint?: string | ReactNode;
    hintKey: string;
}

interface GeneralSettingsGroupProps {
    t: (key: string) => string;
    collapsed: boolean;
    onToggle: () => void;
    LabelWithHint: ComponentType<LabelWithHintProps>;
    autoStart: boolean;
    setAutoStart: (val: boolean) => void;
    silentStart: boolean;
    setSilentStart: (val: boolean) => void;
    hideTrayIcon: boolean;
    setHideTrayIcon: (val: boolean) => void;
    hideDockIcon: boolean;
    setHideDockIcon: (val: boolean) => void;
    edgeDocking: boolean;
    setEdgeDocking: (val: boolean) => void;
    soundEnabled: boolean;
    setSoundEnabled: (val: boolean) => void;
    pasteSoundEnabled: boolean;
    setPasteSoundEnabled: (val: boolean) => void;
    showSearchBox: boolean;
    setShowSearchBox: (val: boolean) => void;
    scrollTopButtonEnabled: boolean;
    setScrollTopButtonEnabled: (val: boolean) => void;
    emojiPanelEnabled: boolean;
    setEmojiPanelEnabled: (val: boolean) => void;
    tagManagerEnabled: boolean;
    setTagManagerEnabled: (val: boolean) => void;
    arrowKeySelection: boolean;
    setArrowKeySelection: (val: boolean) => void;
    soundVolume: number;
    setSoundVolume: (val: number) => void;
    recycleBinRetentionDays: number;
    setRecycleBinRetentionDays: (val: number) => void;
    appSettings: Record<string, string>;
    saveAppSetting: (key: string, val: string) => void;
}

const TRAY_LEFT_ACTIONS = ['show_main', 'toggle_main', 'open_settings', 'none'] as const;
const TRAY_RIGHT_ACTIONS = ['menu', 'show_main', 'toggle_main', 'open_settings', 'none'] as const;

// Same dropdown treatment as the AI assistant settings selects: the inline
// values get overridden per theme (mica/acrylic render them soft and rounded),
// so every select in the settings pages stays visually consistent.
const dropdownStyle = {
    borderRadius: '0',
    padding: '6px',
    width: '160px',
    background: 'var(--bg-input)',
    border: '2px solid var(--border-dark)',
    color: 'var(--text-primary)',
    fontSize: '12px'
} as const;

const GeneralSettingsGroup = ({
    t,
    collapsed,
    onToggle,
    LabelWithHint,
    autoStart,
    setAutoStart,
    silentStart,
    setSilentStart,
    hideTrayIcon,
    setHideTrayIcon,
    hideDockIcon,
    setHideDockIcon,
    edgeDocking,
    setEdgeDocking,
    soundEnabled,
    setSoundEnabled,
    pasteSoundEnabled,
    setPasteSoundEnabled,
    showSearchBox,
    setShowSearchBox,
    scrollTopButtonEnabled,
    setScrollTopButtonEnabled,
    emojiPanelEnabled,
    setEmojiPanelEnabled,
    tagManagerEnabled,
    setTagManagerEnabled,
    arrowKeySelection,
    setArrowKeySelection,
    soundVolume,
    setSoundVolume,
    recycleBinRetentionDays,
    setRecycleBinRetentionDays,
    appSettings,
    saveAppSetting
}: GeneralSettingsGroupProps) => (
    <div className={`settings-group ${collapsed ? 'collapsed' : ''}`}>
        <div className="group-header" onClick={onToggle}>
            <h3 style={{ margin: 0 }}>{t('general_settings')}</h3>
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </div>
        {!collapsed && (
            <div className="group-content">
                <div className="setting-item">
                    <div className="item-label-group">
                        <span className="item-label">{t('autostart')}</span>
                    </div>
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={autoStart}
                            onChange={(e) => {
                                const enabled = e.target.checked;
                                setAutoStart(enabled);
                                invoke("toggle_autostart", { enabled }).catch(console.error);
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>

                <div className="setting-item">
                    <div className="item-label-group">
                        <span className="item-label">{t('hide_tray_icon')}</span>
                    </div>
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={hideTrayIcon}
                            onChange={(e) => {
                                const val = e.target.checked;
                                setHideTrayIcon(val);
                                invoke("set_tray_visible", { visible: !val }).catch(console.error);
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>

                {!hideTrayIcon && (
                    <div className="setting-item column" style={{ borderBottom: 'none' }}>
                        <span className="item-label">{t('tray_behavior')}</span>
                        <div className="setting-item" style={{ marginTop: '8px' }}>
                            <div className="item-label-group">
                                <span className="item-label">{t('tray_left_click')}</span>
                            </div>
                            <select
                                className="search-input"
                                style={dropdownStyle}
                                value={appSettings['app.tray_left_click'] || 'show_main'}
                                onChange={(e) => saveAppSetting('tray_left_click', e.target.value)}
                            >
                                {TRAY_LEFT_ACTIONS.map((action) => (
                                    <option key={action} value={action}>{t(`tray_action_${action}`)}</option>
                                ))}
                            </select>
                        </div>
                        <div className="setting-item" style={{ marginTop: '8px' }}>
                            <div className="item-label-group">
                                <span className="item-label">{t('tray_left_double_click')}</span>
                            </div>
                            <select
                                className="search-input"
                                style={dropdownStyle}
                                value={appSettings['app.tray_left_double_click'] || 'open_settings'}
                                onChange={(e) => saveAppSetting('tray_left_double_click', e.target.value)}
                            >
                                {TRAY_LEFT_ACTIONS.map((action) => (
                                    <option key={action} value={action}>{t(`tray_action_${action}`)}</option>
                                ))}
                            </select>
                        </div>
                        <div className="setting-item" style={{ marginTop: '8px' }}>
                            <LabelWithHint
                                label={t('tray_right_click')}
                                hint={t('tray_right_click_hint')}
                                hintKey="tray_right_click"
                            />
                            <select
                                className="search-input"
                                style={dropdownStyle}
                                value={appSettings['app.tray_right_click'] || 'menu'}
                                onChange={(e) => saveAppSetting('tray_right_click', e.target.value)}
                            >
                                {TRAY_RIGHT_ACTIONS.map((action) => (
                                    <option key={action} value={action}>{t(`tray_action_${action}`)}</option>
                                ))}
                            </select>
                        </div>
                        <div className="setting-item" style={{ marginTop: '8px' }}>
                            <div className="item-label-group">
                                <span className="item-label">{t('tray_right_double_click')}</span>
                            </div>
                            <select
                                className="search-input"
                                style={dropdownStyle}
                                value={appSettings['app.tray_right_double_click'] || 'none'}
                                onChange={(e) => saveAppSetting('tray_right_double_click', e.target.value)}
                            >
                                {TRAY_RIGHT_ACTIONS.map((action) => (
                                    <option key={action} value={action}>{t(`tray_action_${action}`)}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                )}

                {isMacPlatform && (
                    <div className="setting-item">
                        <LabelWithHint
                            label={t('hide_dock_icon')}
                            hint={t('hide_dock_icon_hint')}
                            hintKey="hide_dock_icon"
                        />
                        <label className="switch">
                            <input
                                className="cb"
                                type="checkbox"
                                checked={hideDockIcon}
                                onChange={(e) => {
                                    const val = e.target.checked;
                                    setHideDockIcon(val);
                                    invoke("set_dock_visible", { visible: !val }).catch(console.error);
                                }}
                            />
                            <div className="toggle"><div className="left" /><div className="right" /></div>
                        </label>
                    </div>
                )}

                <div className="setting-item">
                    <LabelWithHint
                        label={t('edge_docking')}
                        hint={t('edge_docking_hint')}
                        hintKey="edge_docking"
                    />
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={edgeDocking}
                            onChange={(e) => {
                                const val = e.target.checked;
                                setEdgeDocking(val);
                                invoke("set_edge_docking", { enabled: val }).catch(console.error);
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>


                <div className="setting-item">
                    <div className="item-label-group">
                        <span className="item-label">{t('sound_effects') || "Sound Effects"}</span>
                    </div>
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={soundEnabled}
                            onChange={(e) => {
                                const enabled = e.target.checked;
                                setSoundEnabled(enabled);
                                invoke("set_sound_enabled", { enabled }).catch(console.error);
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>
                {soundEnabled && (
                    <div className="setting-item" style={{ marginLeft: '18px' }}>
                        <div className="item-label-group">
                            <span className="item-label">{t('paste_sound') || "Paste Sound"}</span>
                        </div>
                        <label className="switch">
                            <input
                                className="cb"
                                type="checkbox"
                                checked={pasteSoundEnabled}
                                onChange={(e) => {
                                    const enabled = e.target.checked;
                                    setPasteSoundEnabled(enabled);
                                    invoke("save_setting", { key: 'app.sound_paste_enabled', value: String(enabled) }).catch(console.error);
                                }}
                            />
                            <div className="toggle"><div className="left" /><div className="right" /></div>
                        </label>
                    </div>
                )}
                {soundEnabled && (
                    <div className="setting-item column" style={{ marginLeft: '18px', borderBottom: 'none' }}>
                        <div className="item-label-group">
                            <span className="item-label">{t('sound_volume') || "Sound Volume"} ({Math.round(soundVolume * 100)}%)</span>
                        </div>
                        <div style={{ padding: '0 4px', width: '100%' }}>
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={soundVolume}
                                onChange={(e) => {
                                    const val = parseFloat(e.target.value);
                                    setSoundVolume(val);
                                }}
                                style={{
                                    ['--range-progress' as any]: `${soundVolume * 100}%`
                                }}
                            />
                        </div>
                    </div>
                )}


                <div className="setting-item">
                    <LabelWithHint
                        label={t('silent_start')}
                        hint={t('silent_start_hint')}
                        hintKey="silent_start"
                    />
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={silentStart}
                            onChange={(e) => {
                                const enabled = e.target.checked;
                                setSilentStart(enabled);
                                invoke("set_silent_start", { enabled }).catch(console.error);
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>
                <div className="setting-item">
                    <LabelWithHint
                        label={t('show_search_box')}
                        hint={t('show_search_box_hint')}
                        hintKey="show_search_box"
                    />
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={showSearchBox}
                            onChange={(e) => {
                                const enabled = e.target.checked;
                                setShowSearchBox(enabled);
                                saveAppSetting('show_search_box', String(enabled));
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>
                <div className="setting-item">
                    <LabelWithHint
                        label={t('scroll_top_button')}
                        hint={t('scroll_top_button_hint')}
                        hintKey="scroll_top_button"
                    />
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={scrollTopButtonEnabled}
                            onChange={(e) => {
                                const enabled = e.target.checked;
                                setScrollTopButtonEnabled(enabled);
                                saveAppSetting('show_scroll_top_button', String(enabled));
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>
                <div className="setting-item">
                    <LabelWithHint
                        label={t('emoji_panel_enabled') || '表情包开关'}
                        hint={t('emoji_panel_enabled_hint') || '关闭后隐藏表情包入口'}
                        hintKey="emoji_panel_enabled"
                    />
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={emojiPanelEnabled}
                            onChange={(e) => {
                                const enabled = e.target.checked;
                                setEmojiPanelEnabled(enabled);
                                saveAppSetting('emoji_panel_enabled', String(enabled));
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>
                <div className="setting-item">
                    <LabelWithHint
                        label={t('tag_manager_enabled') || '标签管理页开关'}
                        hint={t('tag_manager_enabled_hint') || '关闭后隐藏标签管理入口'}
                        hintKey="tag_manager_enabled"
                    />
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={tagManagerEnabled}
                            onChange={(e) => {
                                const enabled = e.target.checked;
                                setTagManagerEnabled(enabled);
                                saveAppSetting('tag_manager_enabled', String(enabled));
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>
                <div className="setting-item">
                    <LabelWithHint
                        label={t('arrow_key_selection')}
                        hint={t('arrow_key_selection_hint')}
                        hintKey="arrow_key_selection"
                    />
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={arrowKeySelection}
                            onChange={(e) => {
                                const enabled = e.target.checked;
                                setArrowKeySelection(enabled);
                                saveAppSetting('arrow_key_selection', String(enabled));
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>

                <div className="setting-item">
                    <LabelWithHint
                        label={t('recycle_bin_retention')}
                        hint={t('recycle_bin_retention_hint')}
                        hintKey="recycle_bin_retention"
                    />
                    <select
                        className="search-input"
                        style={dropdownStyle}
                        value={recycleBinRetentionDays}
                        onChange={(e) => {
                            const days = parseInt(e.target.value);
                            setRecycleBinRetentionDays(days);
                            saveAppSetting('recycle_bin_retention_days', String(days));
                        }}
                    >
                        <option value={3}>3 {t('days') || '天'}</option>
                        <option value={5}>5 {t('days') || '天'}</option>
                        <option value={7}>7 {t('days') || '天'}</option>
                        <option value={14}>14 {t('days') || '天'}</option>
                        <option value={30}>30 {t('days') || '天'}</option>
                    </select>
                </div>

                {/* macOS cleanup: Removed Restart as Admin */}
            </div>
        )}
    </div>
);

export default GeneralSettingsGroup;
