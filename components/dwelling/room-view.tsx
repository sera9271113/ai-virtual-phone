"use client";

import { useState } from "react";
import { Wand2 } from "lucide-react";
import type { DwellingRoom, DwellingFurniture, DwellingFurnitureItem } from "@/lib/dwelling-storage";

type RoomViewProps = {
    room: DwellingRoom;
    itemHtmlCache: Record<string, string>;
    loadingItemKeys: Set<string>;
    lastItemError: string | null;
    onExploreItem: (furniture: DwellingFurniture, item: DwellingFurnitureItem) => void;
    onOpenItem: (furniture: DwellingFurniture, item: DwellingFurnitureItem, html: string) => void;
};

function ikey(roomId: string, itemId: string) { return `${roomId}_${itemId}`; }

export function RoomView({ room, itemHtmlCache, loadingItemKeys, lastItemError, onExploreItem, onOpenItem }: RoomViewProps) {
    const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
    const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

    function toggleFurniture(id: string) {
        setCollapsedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }

    function toggleItem(itemId: string) {
        setExpandedItemId(prev => prev === itemId ? null : itemId);
    }

    function handleItemRowClick(furniture: DwellingFurniture, item: DwellingFurnitureItem, html?: string) {
        if (html) {
            onOpenItem(furniture, item, html);
            return;
        }
        toggleItem(item.id);
    }

    return (
        <div className="dw-room">
            <div className="dw-room-atmosphere">
                <p>{room.description}</p>
            </div>

            <div className="dw-furniture-grid">
                {(room.furniture || []).map(f => {
                    const isExpanded = !collapsedIds.has(f.id);
                    return (
                        <div key={f.id} className="dw-fur-card" data-expanded={isExpanded ? "true" : undefined}>
                            <button className="dw-fur-header" onClick={() => toggleFurniture(f.id)}>
                                <span className="dw-fur-label">{f.label}</span>
                                <span className="dw-fur-count">{f.items.length}</span>
                                <span className="dw-fur-chevron">{isExpanded ? "▾" : "▸"}</span>
                            </button>

                            {isExpanded && (
                                <div className="dw-fur-items">
                                    {f.items.map(item => {
                                        const key = ikey(room.id, item.id);
                                        const html = itemHtmlCache[key];
                                        const isLoading = loadingItemKeys.has(key);
                                        const isOpen = expandedItemId === item.id;

                                        return (
                                            <div key={item.id}>
                                                <button className="dw-item-row" onClick={() => handleItemRowClick(f, item, html)}>
                                                    <span className="dw-item-dot" />
                                                    <div className="dw-item-text">
                                                        <span className="dw-item-name">{item.name}</span>
                                                        <span className="dw-item-preview">{item.preview}</span>
                                                    </div>
                                                    <span className="dw-item-go">{html ? "›" : isOpen ? "▾" : "›"}</span>
                                                </button>

                                                {isOpen && (
                                                    <div className="dw-item-expand">
                                                        {isLoading ? (
                                                            <div className="dw-explore-loading">
                                                                <span className="dwelling-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                                                                <span>正在探索…</span>
                                                            </div>
                                                        ) : html ? (
                                                            <button className="dw-explore-btn" onClick={() => onOpenItem(f, item, html)}>
                                                                查看探索
                                                            </button>
                                                        ) : (
                                                            <>
                                                                {lastItemError && !isLoading && (
                                                                    <div className="dwelling-error" style={{ margin: "4px 0 8px" }}>{lastItemError}</div>
                                                                )}
                                                                <button className="dw-explore-btn" onClick={() => onExploreItem(f, item)}>
                                                                    <Wand2 size={14} />
                                                                    开始探索
                                                                </button>
                                                            </>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
