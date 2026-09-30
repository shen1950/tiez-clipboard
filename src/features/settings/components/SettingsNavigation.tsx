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
}

export default function SettingsNavigation({ categories, active, onSelect, label }: SettingsNavigationProps) {
    // Keep visited pages mounted so switching categories preserves drafts and scroll.
    const [visited, setVisited] = useState(() => new Set([active]));
    useEffect(() => {
        setVisited(previous => previous.has(active) ? previous : new Set([...previous, active]));
    }, [active]);
    const current = categories.find(category => category.id === active) ?? categories[0];

    return (
        <div className="settings-layout">
            <nav className="settings-sidebar" aria-label={label}>
                {categories.map(({ id, label: title, icon: Icon }) => (
                    <button
                        key={id}
                        type="button"
                        className="settings-category"
                        aria-current={id === current.id ? "page" : undefined}
                        aria-controls={`settings-section-${id}`}
                        onClick={() => onSelect(id)}
                    >
                        <Icon size={17} aria-hidden />
                        <span>{title}</span>
                    </button>
                ))}
            </nav>
            <div className="settings-detail">
                <div className="settings-detail-heading">
                    <h2 id="settings-category-title">{current.label}</h2>
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
