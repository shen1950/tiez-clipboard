import { useState, useEffect, useCallback, useRef } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { RotateCcw, Trash2, X, AlertTriangle, ImageOff } from 'lucide-react';
import type { ClipboardEntry } from '../../../shared/types';
import { toTauriLocalImageSrc } from '../../../shared/lib/localImageSrc';
import { getTagColor, getTagTextColor } from '../../../shared/lib/utils';

interface RecycleBinPanelProps {
    t: (key: string) => string;
    retentionDays: number;
    theme: string;
    tagColors: Record<string, string>;
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getRemainingDays(deletedAt: number, retentionDays: number): number {
    const elapsed = Date.now() - deletedAt;
    const remain = retentionDays * 24 * 60 * 60 * 1000 - elapsed;
    return Math.max(0, Math.ceil(remain / (24 * 60 * 60 * 1000)));
}

function RecycleBinImage({ item, alt }: { item: ClipboardEntry; alt: string }) {
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    // Use the same local-file mapping as the main clipboard list. Images in the
    // recycle bin can be embedded data URLs or retained attachment file paths.
    const src = item.content.startsWith('data:')
        ? item.content
        : (toTauriLocalImageSrc(item.content)
            || (item.is_external ? convertFileSrc(item.content) : item.content));
    const unavailable = !src || failedSrc === src || item.file_preview_exists === false;

    return (
        <div className="recycle-bin-image-preview">
            {unavailable ? (
                <div className="recycle-bin-image-unavailable" role="img" aria-label={alt}>
                    <ImageOff size={24} aria-hidden="true" />
                </div>
            ) : (
                <img src={src} alt={alt} loading="lazy" decoding="async"
                    draggable={false} onError={() => setFailedSrc(src)} />
            )}
        </div>
    );
}

export default function RecycleBinPanel({ t, retentionDays, theme, tagColors }: RecycleBinPanelProps) {
    const [items, setItems] = useState<ClipboardEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const requestSequence = useRef(0);
    const [confirmEmpty, setConfirmEmpty] = useState(false);

    const fetchItems = useCallback(async () => {
        const sequence = ++requestSequence.current;
        try {
            const result = await invoke<ClipboardEntry[]>('get_recycle_bin_items', { limit: 200, offset: 0 });
            if (sequence === requestSequence.current) setItems(result);
        } catch (e) {
            console.error('Failed to fetch recycle bin:', e);
        } finally {
            if (sequence === requestSequence.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchItems();
        const unlisten = listen('clipboard-changed', fetchItems);
        const unlistenRemoved = listen('clipboard-removed', fetchItems);
        return () => { unlisten.then(f => f()); unlistenRemoved.then(f => f()); };
    }, [fetchItems]);

    const restore = async (id: number) => {
        try {
            await invoke('restore_from_recycle_bin', { id });
            setItems(prev => prev.filter(it => it.id !== id));
        } catch (e) {
            console.error('Restore failed:', e);
        }
    };

    const permanentDelete = async (id: number) => {
        try {
            await invoke('permanent_delete_entry', { id });
            setItems(prev => prev.filter(it => it.id !== id));
        } catch (e) {
            console.error('Permanent delete failed:', e);
        }
    };

    const emptyAll = async () => {
        try {
            await invoke('empty_recycle_bin', {});
            setItems([]);
            setConfirmEmpty(false);
        } catch (e) {
            console.error('Empty recycle bin failed:', e);
        }
    };

    const getPreview = (item: ClipboardEntry) => {
        if (item.content_type === 'image') return t('image_content') || '[图片]';
        if (item.content_type === 'file') return item.preview || item.content;
        return item.preview || item.content.substring(0, 120);
    };

    return (
        <div className="recycle-bin-panel">
            <div className="recycle-bin-header">
                <span>{t('recycle_bin')}</span>
                <span className="recycle-bin-count">{items.length}</span>
            </div>
            <div className="retention-info">
                {t('retention_info').replace('{days}', String(retentionDays))}
            </div>

            {loading && <div className="recycle-bin-empty">{t('loading')}</div>}

            {!loading && items.length === 0 && (
                <div className="recycle-bin-empty">{t('recycle_bin_empty')}</div>
            )}

            {!loading && items.length > 0 && (
                <>
                    <div className="recycle-bin-actions">
                        <button className="btn-danger" onClick={() => setConfirmEmpty(true)}>
                            <Trash2 size={14} /> {t('empty_recycle_bin')}
                        </button>
                    </div>
                    <div className="recycle-bin-list">
                        {items.map(item => {
                            const remainDays = item.deleted_at
                                ? getRemainingDays(item.deleted_at, retentionDays)
                                : retentionDays;
                            return (
                                <div className="recycle-bin-item" key={item.id}>
                                    <div className="recycle-bin-item-main">
                                        {item.content_type === 'image' && (
                                            <RecycleBinImage item={item} alt={t('image_preview')} />
                                        )}
                                        <div className="recycle-bin-item-preview">{getPreview(item)}</div>
                                        {!!item.tags?.length && (
                                            <div className="recycle-bin-item-tags">
                                                {item.tags.map(tag => {
                                                    const background = tagColors[tag] || getTagColor(tag, theme);
                                                    return (
                                                        <span key={tag} className="recycle-bin-item-tag" title={tag}
                                                            style={{ background, color: getTagTextColor(background) }}>
                                                            {tag}
                                                        </span>
                                                    );
                                                })}
                                            </div>
                                        )}
                                        <div className="recycle-bin-item-meta">
                                            <span>{formatTime(item.deleted_at || item.timestamp)}</span>
                                            <span className="recycle-bin-remain">
                                                {t('remaining_days').replace('{days}', String(remainDays))}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="recycle-bin-item-actions">
                                        <button className="btn-icon" title={t('restore')} onClick={() => restore(item.id)}>
                                            <RotateCcw size={14} />
                                        </button>
                                        <button className="btn-icon btn-danger-icon" title={t('delete_permanently')} onClick={() => permanentDelete(item.id)}>
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}

            {confirmEmpty && (
                <div className="modal-overlay" onClick={() => setConfirmEmpty(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <AlertTriangle size={20} color="#f59e0b" />
                            <h3>{t('confirm_empty_recycle_bin')}</h3>
                        </div>
                        <p>{t('confirm_empty_recycle_bin_desc')}</p>
                        <div className="modal-actions">
                            <button className="btn-secondary" onClick={() => setConfirmEmpty(false)}>
                                {t('cancel')}
                            </button>
                            <button className="btn-danger" onClick={emptyAll}>
                                {t('empty_recycle_bin')}
                            </button>
                        </div>
                        <button className="modal-close" onClick={() => setConfirmEmpty(false)}>
                            <X size={16} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
