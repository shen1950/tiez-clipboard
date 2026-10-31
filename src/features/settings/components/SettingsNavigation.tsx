import { useEffect, useState } from "react";
import type { ReactNode, ComponentType } from "react";

export interface SettingsCategory {
    id: string;
    label: string;
    icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
    content: ReactNode;
}

interface SettingsNavigationProps {
    categories: SettingsCategory[];
    active: string;
    onSelect: (id: string) => void;
    label: string;
    appLogo: string;
    appVersion: string;
    pageTitle: string;
    windowControls: ReactNode;
}

export default function SettingsNavigation({ categories, active, onSelect, label, appLogo, appVersion, pageTitle, windowControls }: SettingsNavigationProps) {
    // Keep visited pages mounted so switching categories preserves drafts and scroll.
    const [visited, setVisited] = useState(() => new Set([active]));
    useEffect(() => {
        setVisited(previous => previous.has(active) ? previous : new Set([...previous, active]));
    }, [active]);
    const current = categories.find(category => category.id === active) ?? categories[0];

    return (
        <div className="settings-layout">
            <nav className="settings-sidebar" aria-label={label}>
                <div className="settings-sidebar-brand" data-tauri-drag-region>
                    {appLogo ? (
                        <img
                            src={appLogo}
                            alt="TieZ-GuLing"
                            className="settings-sidebar-logo"
                            draggable={false}
                            onDragStart={(e) => e.preventDefault()}
                        />
                    ) : (
                        <span className="settings-sidebar-logo settings-sidebar-logo-placeholder" aria-hidden />
                    )}
                    <div className="settings-sidebar-brand-text">
                        <span className="settings-sidebar-brand-name">TieZ-GuLing</span>
                        {appVersion ? (
                            <span className="settings-sidebar-brand-version">v{appVersion}</span>
                        ) : null}
                    </div>
                </div>
                <div className="settings-sidebar-menu">
                    {categories.map(({ id, label: title, icon: Icon }) => (
                        <button
                            key={id}
                            type="button"
                            className="settings-category"
                            aria-current={id === current.id ? "page" : undefined}
                            aria-controls={`settings-section-${id}`}
                            onClick={() => onSelect(id)}
                        >
                            <Icon size={20} aria-hidden />
                            <span>{title}</span>
                        </button>
                    ))}
                </div>
            </nav>
            <div className="settings-detail">
                <div className="settings-detail-header" data-tauri-drag-region>
                    <h2 className="settings-detail-title">{pageTitle}</h2>
                    {windowControls}
                </div>
                {categories.map(({ id, label: title, content }) => (
                    (visited.has(id) || current.id === id) && (
                        <section
                            key={id}
                            id={`settings-section-${id}`}
                            className={`settings-section settings-section-${id}`}
                            aria-label={title}
                            hidden={current.id !== id}
                        >
                            {content}
                        </section>
                    )
                ))}
            </div>
        </div>
    );
}
