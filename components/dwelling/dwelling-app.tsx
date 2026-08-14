"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeft, Hammer, Home, RefreshCw, Sparkles, Trash2, Wand2, X } from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import type { DwellingLayout, DwellingRoom, DwellingFurniture, DwellingFurnitureItem } from "@/lib/dwelling-storage";
import {
    loadDwellingLayout,
    saveDwellingLayout,
    clearDwellingData,
    saveItemHtml,
    loadAllItemHtmlForChar,
} from "@/lib/dwelling-storage";
import { generateDwellingLayout, generateItemHtml, type DwellingRefreshMode } from "@/lib/dwelling-engine";
import { RoomView } from "./room-view";
import { StoryHtmlRenderer } from "@/components/ui/story-html-renderer";

type DwellingAppProps = {
    onClose: () => void;
    visible?: boolean;
    onIdle?: () => void;
};

type CharState = {
    layout: DwellingLayout | null;
    isGenerating: boolean;
    error: string | null;
    loaded: boolean;
    itemHtmlCache: Record<string, string>;
    loadingItemKeys: Set<string>;
    lastItemError: string | null;
};

type ItemDetail = {
    roomId: string;
    roomName: string;
    furnitureId: string;
    furnitureLabel: string;
    furnitureIcon: string;
    itemId: string;
    itemName: string;
    itemPreview: string;
    html: string;
};

const charStates = new Map<string, CharState>();

function getCharState(charId: string): CharState {
    let s = charStates.get(charId);
    if (!s) { s = { layout: null, isGenerating: false, error: null, loaded: false, itemHtmlCache: {}, loadingItemKeys: new Set(), lastItemError: null }; charStates.set(charId, s); }
    return s;
}

function itemKey(roomId: string, itemId: string) { return `${roomId}_${itemId}`; }

export function DwellingApp({ onClose, visible, onIdle }: DwellingAppProps) {
    const [characters, setCharacters] = useState<Character[]>([]);
    const [activeCharId, setActiveCharId] = useState<string | null>(null);
    const [activeRoomIdx, setActiveRoomIdx] = useState(0);
    const [, forceUpdate] = useState(0);
    const rerender = () => forceUpdate(n => n + 1);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
    const [itemDetail, setItemDetail] = useState<ItemDetail | null>(null);
    const activeCharIdRef = useRef<string | null>(null);
    const activeRoomIdxRef = useRef(0);

    useEffect(() => {
        activeCharIdRef.current = activeCharId;
    }, [activeCharId]);

    useEffect(() => {
        activeRoomIdxRef.current = activeRoomIdx;
    }, [activeRoomIdx]);

    useEffect(() => {
        if (visible) {
            if (activeCharId) getCharState(activeCharId).error = null;
            rerender();
        }
    }, [visible, activeCharId]);

    useEffect(() => {
        const chars = loadCharacters();
        setCharacters(chars);
        if (chars.length === 1) setActiveCharId(chars[0].id);
        // Pre-load all characters' cached layouts + item HTML so ✓ shows immediately
        (async () => {
            for (const c of chars) {
                const cs = getCharState(c.id);
                if (cs.loaded) continue;
                const cached = await loadDwellingLayout(c.id);
                cs.loaded = true;
                if (cached) {
                    cs.layout = cached.layout;
                    cs.itemHtmlCache = loadAllItemHtmlForChar(c.id);
                }
            }
            rerender();
        })();
    }, []);

    useEffect(() => {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        cs.error = null;
        if (cs.loaded) { rerender(); return; }
        let cancelled = false;
        (async () => {
            const cached = await loadDwellingLayout(activeCharId);
            if (cancelled) return;
            cs.loaded = true;
            if (cached) {
                cs.layout = cached.layout;
                cs.itemHtmlCache = loadAllItemHtmlForChar(activeCharId);
            }
            rerender();
        })();
        return () => { cancelled = true; };
    }, [activeCharId]);

    const doGenerate = useCallback(async (charId: string, mode: DwellingRefreshMode = "full") => {
        const cs = getCharState(charId);
        cs.isGenerating = true;
        cs.error = null;
        if (mode === "full") {
            cs.layout = null;
            cs.itemHtmlCache = {};
        }
        rerender();

        const { layout: newLayout, error: genError } = await generateDwellingLayout(charId, mode);
        cs.isGenerating = false;
        if (!newLayout) {
            cs.error = genError || "生成失败";
            rerender();
            if (!visible && onIdle) onIdle();
            return;
        }
        cs.layout = newLayout;
        cs.loaded = true;
        // Items mode: clear HTML cache for items with new IDs (changed items)
        if (mode === "items") {
            const newKeys = new Set<string>();
            for (const room of newLayout.rooms) {
                for (const f of room.furniture) {
                    for (const item of f.items) {
                        newKeys.add(itemKey(room.id, item.id));
                    }
                }
            }
            // Remove HTML cache entries that no longer exist (removed/changed items)
            for (const key of Object.keys(cs.itemHtmlCache)) {
                if (!newKeys.has(key)) delete cs.itemHtmlCache[key];
            }
        } else {
            cs.itemHtmlCache = {};
        }
        await saveDwellingLayout(charId, newLayout);
        rerender();
        if (!visible && onIdle) onIdle();
    }, [visible, onIdle]);

    async function handleRefresh(mode: DwellingRefreshMode) {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        if (cs.isGenerating) return;
        setItemDetail(null);
        if (mode === "full") await clearDwellingData(activeCharId);
        await doGenerate(activeCharId, mode);
    }

    async function handleDelete() {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        if (cs.isGenerating) return;
        await clearDwellingData(activeCharId);
        cs.layout = null;
        cs.itemHtmlCache = {};
        cs.error = null;
        setActiveRoomIdx(0);
        setItemDetail(null);
        rerender();
    }

    function openItemDetail(room: DwellingRoom, furniture: DwellingFurniture, item: DwellingFurnitureItem, html: string) {
        setItemDetail({
            roomId: room.id,
            roomName: room.name,
            furnitureId: furniture.id,
            furnitureLabel: furniture.label,
            furnitureIcon: furniture.icon,
            itemId: item.id,
            itemName: item.name,
            itemPreview: item.preview,
            html,
        });
    }

    // ── Explore single item (called from RoomView) ──
    async function handleExploreItem(charId: string, roomId: string, furniture: DwellingFurniture, item: DwellingFurnitureItem) {
        const cs = getCharState(charId);
        const room = cs.layout?.rooms.find(r => r.id === roomId);
        if (!room) return;

        const key = itemKey(roomId, item.id);
        if (cs.loadingItemKeys.has(key)) return; // already loading
        cs.loadingItemKeys.add(key);
        cs.lastItemError = null;
        rerender();

        const { html, error } = await generateItemHtml(charId, room.name, furniture.label, item.name, item.preview);

        cs.loadingItemKeys.delete(key);
        if (html) {
            cs.itemHtmlCache[key] = html;
            void saveItemHtml(charId, roomId, item.id, html);
            const currentRoom = activeCharIdRef.current === charId ? cs.layout?.rooms[activeRoomIdxRef.current] : null;
            if (currentRoom?.id === roomId) openItemDetail(room, furniture, item, html);
        }
        cs.lastItemError = error || null;
        rerender();
    }

    const cs = activeCharId ? getCharState(activeCharId) : null;
    const activeRoom = cs?.layout?.rooms[activeRoomIdx] ?? null;

    return (
        <div className="dwelling-app">
            <div className="dwelling-header">
                <button className="dw-back" onClick={onClose}><ChevronLeft size={18} /></button>
                <h1>栖所</h1>
            </div>

            {characters.length > 1 && (
                <div className="dwelling-char-picker">
                    {characters.map(c => {
                        const s = getCharState(c.id);
                        return (
                            <button key={c.id} className="dwelling-char-chip"
                                data-active={activeCharId === c.id ? "true" : undefined}
                                onClick={() => { setActiveCharId(c.id); setActiveRoomIdx(0); setItemDetail(null); }}>
                                {c.name}{s.isGenerating && <span className="dwelling-spinner" style={{ width: 10, height: 10, borderWidth: 2, display: "inline-block", marginLeft: 4, verticalAlign: "middle" }} />}{!s.isGenerating && s.layout && " ✓"}
                            </button>
                        );
                    })}
                </div>
            )}

            {!activeCharId && characters.length > 1 && (
                <div className="dwelling-empty"><Home size={28} strokeWidth={1.5} /><span>选择一位角色，探索 ta 的栖所</span></div>
            )}
            {characters.length === 0 && (
                <div className="dwelling-empty"><Home size={28} strokeWidth={1.5} /><span>还没有角色，去创建一个吧</span></div>
            )}
            {cs?.isGenerating && !cs.layout && (
                <div className="dwelling-loading"><div className="dwelling-spinner" /><span className="dwelling-loading-text">正在窥探房间…</span></div>
            )}
            {cs?.isGenerating && cs.layout && (
                <div className="dwelling-loading-bar"><span className="dwelling-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /><span>刷新中…</span></div>
            )}
            {cs?.error && <div className="dwelling-error">{cs.error}</div>}
            {activeCharId && cs?.loaded && !cs.layout && !cs.isGenerating && (
                <div className="dwelling-empty">
                    <Home size={28} strokeWidth={1.5} /><span>还未生成 ta 的房间</span>
                    <button className="dwelling-generate-btn" onClick={() => doGenerate(activeCharId)}>
                        <Wand2 size={16} />生成房间
                    </button>
                </div>
            )}

            {cs?.layout && (
                <div className="dwelling-room-tabs">
                    {cs.layout.rooms.map((room, idx) => (
                        <button key={room.id} className="dwelling-room-tab"
                            data-active={activeRoomIdx === idx ? "true" : undefined}
                            onClick={() => { setActiveRoomIdx(idx); setItemDetail(null); }}>
                            {room.name}
                        </button>
                    ))}
                    <div className="dw-tabs-actions">
                        <button className="dw-tab-action" onClick={() => setShowRefreshConfirm(true)} disabled={cs.isGenerating} title="重新生成">
                            <RefreshCw size={13} />
                        </button>
                        <button className="dw-tab-action dw-tab-action-danger" onClick={() => setShowDeleteConfirm(true)} disabled={cs.isGenerating} title="删除布局">
                            <Trash2 size={13} />
                        </button>
                    </div>
                </div>
            )}

            {activeRoom && cs && (
                <RoomView
                    room={activeRoom}
                    itemHtmlCache={cs.itemHtmlCache}
                    loadingItemKeys={cs.loadingItemKeys}
                    lastItemError={cs.lastItemError}
                    onExploreItem={(furniture, item) => handleExploreItem(activeCharId!, activeRoom.id, furniture, item)}
                    onOpenItem={(furniture, item, html) => openItemDetail(activeRoom, furniture, item, html)}
                />
            )}
            {itemDetail && (
                <div className="dwelling-detail-overlay" data-show="true">
                    <div className="dwelling-items-shade" onClick={() => setItemDetail(null)} />
                    <div className="dwelling-detail-card" role="dialog" aria-modal="true" aria-label={itemDetail.itemName}>
                        <div className="dwelling-items-header">
                            <div className="dwelling-detail-heading">
                                <div className="dwelling-detail-name">{itemDetail.itemName}</div>
                                <div className="dwelling-detail-location">{itemDetail.roomName} · {itemDetail.furnitureLabel}</div>
                            </div>
                            <button className="dwelling-items-close" onClick={() => setItemDetail(null)} aria-label="关闭">
                                <X size={13} />
                            </button>
                        </div>
                        <div className="dwelling-detail-preview">{itemDetail.itemPreview}</div>
                        <div className="dwelling-detail-html">
                            <StoryHtmlRenderer
                                content={itemDetail.html}
                                messageId={`dw-detail-${itemDetail.roomId}-${itemDetail.furnitureId}-${itemDetail.itemId}`}
                                htmlPageMode="auto"
                            />
                        </div>
                    </div>
                </div>
            )}
            {/* Refresh confirm dialog */}
            {showRefreshConfirm && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setShowRefreshConfirm(false)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-icon"><Sparkles size={24} strokeWidth={1.5} /></div>
                        <div className="dw-confirm-title">刷新房间</div>
                        <div className="dw-confirm-msg">选择刷新方式</div>
                        <div className="dw-confirm-actions-col">
                            <button className="dw-confirm-option" onClick={() => { setShowRefreshConfirm(false); handleRefresh("items"); }}>
                                <span className="dw-confirm-option-icon"><RefreshCw size={18} strokeWidth={1.5} /></span>
                                <span className="dw-confirm-option-text">
                                    <strong>刷新物品</strong>
                                    <small>保留房间和家具，只更新物品</small>
                                </span>
                            </button>
                            <button className="dw-confirm-option" onClick={() => { setShowRefreshConfirm(false); handleRefresh("full"); }}>
                                <span className="dw-confirm-option-icon"><Hammer size={18} strokeWidth={1.5} /></span>
                                <span className="dw-confirm-option-text">
                                    <strong>完全重建</strong>
                                    <small>重新生成所有房间、家具和物品</small>
                                </span>
                            </button>
                            <button className="dw-confirm-btn dw-confirm-btn-cancel" style={{ marginTop: 4 }} onClick={() => setShowRefreshConfirm(false)}>取消</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete confirm dialog */}
            {showDeleteConfirm && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setShowDeleteConfirm(false)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-icon"><Home size={24} strokeWidth={1.5} /></div>
                        <div className="dw-confirm-title">要离开这里吗？</div>
                        <div className="dw-confirm-msg">房间里的一切都会消失不见哦<br />包括已经探索过的物品</div>
                        <div className="dw-confirm-actions">
                            <button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setShowDeleteConfirm(false)}>再想想</button>
                            <button className="dw-confirm-btn dw-confirm-btn-danger" onClick={() => { setShowDeleteConfirm(false); handleDelete(); }}>挥手告别</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
