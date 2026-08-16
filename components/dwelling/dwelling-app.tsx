"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Armchair, ChevronLeft, LoaderCircle, RefreshCw, Trash2, Wand2, X } from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import type { DwellingLayout, DwellingRoom, DwellingFurniture, DwellingFurnitureItem } from "@/lib/dwelling-storage";
import {
    loadDwellingLayout,
    saveDwellingLayout,
    clearDwellingData,
    saveItemHtml,
    loadAllItemHtmlForChar,
    loadDwellingImageEnabled,
    saveDwellingImageEnabled,
    collectRoomImageRefs,
} from "@/lib/dwelling-storage";
import { generateDwellingLayout, generateItemHtml, locateDwellingFurnitureMarkers, type DwellingRefreshMode } from "@/lib/dwelling-engine";
import { getDwellingImageAvailability, generateDwellingRoomImage, cancelDwellingRoomImage } from "@/lib/dwelling-image";
import { deleteMediaRef, loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { RoomView, type DwellingRoomImageStatus } from "./room-view";
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
    /** roomId → 生图失败原因（存在时不再自动重试，需手动重试） */
    imageErrors: Record<string, string>;
    /** 正在生图的 roomId 集合 */
    generatingImageRooms: Set<string>;
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
    if (!s) { s = { layout: null, isGenerating: false, error: null, loaded: false, itemHtmlCache: {}, loadingItemKeys: new Set(), lastItemError: null, imageErrors: {}, generatingImageRooms: new Set() }; charStates.set(charId, s); }
    return s;
}

function itemKey(roomId: string, itemId: string) { return `${roomId}_${itemId}`; }

/** mediaRef → object URL（会话级缓存，图不多，不主动 revoke） */
const roomImageUrls = new Map<string, string>();

export function DwellingApp({ onClose, visible, onIdle }: DwellingAppProps) {
    const [characters, setCharacters] = useState<Character[]>([]);
    const [activeCharId, setActiveCharId] = useState<string | null>(null);
    const [activeRoomIdx, setActiveRoomIdx] = useState(0);
    const [, forceUpdate] = useState(0);
    const rerender = () => forceUpdate(n => n + 1);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
    const [roomMenuOpen, setRoomMenuOpen] = useState(false);
    const [itemDetail, setItemDetail] = useState<ItemDetail | null>(null);
    const [imageEnabled, setImageEnabled] = useState(true);
    const [imageConfigured, setImageConfigured] = useState(false);
    const activeCharIdRef = useRef<string | null>(null);
    const activeRoomIdxRef = useRef(0);

    useEffect(() => {
        setImageEnabled(loadDwellingImageEnabled());
        setImageConfigured(getDwellingImageAvailability().configured);
    }, []);

    useEffect(() => {
        // 用户可能中途去设置里配置了生图，回到栖所时重新判定
        if (visible) setImageConfigured(getDwellingImageAvailability().configured);
    }, [visible]);

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
        if (mode === "full") {
            for (const ref of collectRoomImageRefs(cs.layout)) void deleteMediaRef(ref);
            cs.imageErrors = {};
            await clearDwellingData(activeCharId);
        }
        await doGenerate(activeCharId, mode);
    }

    async function handleDelete() {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        if (cs.isGenerating) return;
        for (const ref of collectRoomImageRefs(cs.layout)) void deleteMediaRef(ref);
        await clearDwellingData(activeCharId);
        cs.layout = null;
        cs.itemHtmlCache = {};
        cs.error = null;
        cs.imageErrors = {};
        setActiveRoomIdx(0);
        setItemDetail(null);
        rerender();
    }

    // ── 房间生图 ──
    const handleGenerateRoomImage = useCallback(async (charId: string, roomId: string) => {
        const cs = getCharState(charId);
        const layout = cs.layout;
        if (!layout) return;
        const room = layout.rooms.find(r => r.id === roomId);
        if (!room) return;
        if (cs.generatingImageRooms.has(roomId)) return;

        cs.generatingImageRooms.add(roomId);
        delete cs.imageErrors[roomId];
        rerender();

        const { assetId, dataUrl, error } = await generateDwellingRoomImage(charId, room);
        cs.generatingImageRooms.delete(roomId);

        // 生成期间布局被重建/删除：丢弃这张图
        if (cs.layout !== layout) {
            if (assetId) void deleteMediaRef(assetId);
            rerender();
            return;
        }

        if (assetId) {
            const old = room.imageAssetId;
            room.imageAssetId = assetId;
            if (old && old !== assetId) void deleteMediaRef(old);
            const url = dataUrl || await loadMediaObjectUrl(assetId);
            if (url) roomImageUrls.set(assetId, url);
            await saveDwellingLayout(charId, layout);
            rerender();

            if (dataUrl) {
                try {
                    const located = await locateDwellingFurnitureMarkers(charId, room, dataUrl);
                    if (cs.layout === layout && room.imageAssetId === assetId) {
                        const markersById = new Map(located.map(item => [item.furnitureId, item.marker]));
                        if (markersById.size > 0) {
                            room.furniture = room.furniture.map(furniture => {
                                const marker = markersById.get(furniture.id);
                                return marker ? { ...furniture, marker, markerSpace: "image" as const } : furniture;
                            });
                            await saveDwellingLayout(charId, layout);
                        }
                    }
                } catch (locateError) {
                    console.warn("[Dwelling] Furniture image location failed:", locateError);
                }
            }
        } else {
            cs.imageErrors[roomId] = error || "生成失败";
        }
        rerender();
    }, []);

    // 进入房间时只解析已生成图片，不再隐式触发新的图片请求。
    const csForImage = activeCharId ? getCharState(activeCharId) : null;
    const roomForImage = csForImage?.layout?.rooms[activeRoomIdx] ?? null;
    useEffect(() => {
        if (visible === false) return;
        if (!activeCharId || !csForImage?.layout || !roomForImage) return;
        const cs = csForImage;
        const room = roomForImage;

        if (room.imageAssetId) {
            const ref = room.imageAssetId;
            if (roomImageUrls.has(ref)) return;
            let cancelled = false;
            (async () => {
                const url = await loadMediaObjectUrl(ref);
                if (cancelled) return;
                if (url) {
                    roomImageUrls.set(ref, url);
                    rerender();
                    // If no furniture has image-space markers yet, run location detection
                    const needsLocation = room.furniture.length > 0
                        && !room.furniture.some(f => f.markerSpace === "image");
                    if (needsLocation && cs.layout) {
                        try {
                            const blob = await fetch(url).then(r => r.blob());
                            if (cancelled) return;
                            const reader = new FileReader();
                            const dataUrl = await new Promise<string>((resolve, reject) => {
                                reader.onload = () => resolve(reader.result as string);
                                reader.onerror = reject;
                                reader.readAsDataURL(blob);
                            });
                            if (cancelled) return;
                            const located = await locateDwellingFurnitureMarkers(activeCharId, room, dataUrl);
                            if (cancelled || cs.layout !== csForImage?.layout) return;
                            const markersById = new Map(located.map(item => [item.furnitureId, item.marker]));
                            if (markersById.size > 0) {
                                room.furniture = room.furniture.map(furniture => {
                                    const marker = markersById.get(furniture.id);
                                    return marker ? { ...furniture, marker, markerSpace: "image" as const } : furniture;
                                });
                                await saveDwellingLayout(activeCharId, cs.layout);
                                rerender();
                            }
                        } catch (e) {
                            console.warn("[Dwelling] Auto furniture location on load failed:", e);
                        }
                    }
                } else if (cs.layout && cs.layout.rooms.includes(room)) {
                    // 媒体已丢失：清掉引用，回氛围底并允许重新生成
                    room.imageAssetId = undefined;
                    void saveDwellingLayout(activeCharId, cs.layout);
                    rerender();
                }
            })();
            return () => { cancelled = true; };
        }

    }, [activeCharId, activeRoomIdx, visible, csForImage, roomForImage]);

    function openItemDetail(room: DwellingRoom, furniture: DwellingFurniture, item: DwellingFurnitureItem, html: string) {
        setItemDetail({
            roomId: room.id,
            roomName: room.name,
            furnitureId: furniture.id,
            furnitureLabel: furniture.label,
            furnitureIcon: furniture.icon,
            itemId: item.id,
            itemName: item.name,
            itemPreview: item.preview || item.description || "",
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
        <div className="dwelling-app" data-haspicker={characters.length > 1 ? "true" : undefined}>
            <div className="dwelling-header">
                <button className="dw-back" onClick={onClose}><ChevronLeft size={18} /></button>
                <h1>Dwelling</h1>
                <button
                    className="dw-room-menu-trigger"
                    onClick={() => setRoomMenuOpen(true)}
                    disabled={!cs?.layout}
                    aria-label="打开房间列表"
                    aria-expanded={roomMenuOpen}
                    title="房间列表"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                        <path d="M21 12l-9 -9l-9 9h2v7a2 2 0 0 0 2 2h4.7" />
                        <path d="M9 21v-6a2 2 0 0 1 2 -2h2" />
                        <path d="M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
                        <path d="M20.2 20.2l1.8 1.8" />
                    </svg>
                </button>
            </div>

            {characters.length > 1 && (
                <div className="dwelling-char-picker">
                    {characters.map(c => {
                        const s = getCharState(c.id);
                        return (
                            <button key={c.id} className="dwelling-char-chip"
                                data-active={activeCharId === c.id ? "true" : undefined}
                                onClick={() => { setActiveCharId(c.id); setActiveRoomIdx(0); setItemDetail(null); setRoomMenuOpen(false); }}>
                                {s.layout && <span className="dw-char-status-dot" aria-hidden="true" />}
                                <span className="dw-chip-zh">{c.name}</span>
                                {s.isGenerating && s.layout && <LoaderCircle className="dw-char-loading" size={14} aria-label="正在刷新物品" />}
                            </button>
                        );
                    })}
                </div>
            )}

            {!activeCharId && characters.length > 1 && (
                <div className="dwelling-empty"><span>选择一位角色，探索 ta 的栖所</span></div>
            )}
            {characters.length === 0 && (
                <div className="dwelling-empty"><span>还没有角色，去创建一个吧</span></div>
            )}
            {cs?.isGenerating && !cs.layout && (
                <div className="dwelling-loading"><div className="dwelling-spinner" /><span className="dwelling-loading-text">正在窥探房间…</span></div>
            )}
            {cs && (cs.error || cs.lastItemError) && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => { cs.error = null; cs.lastItemError = null; rerender(); }} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">{cs.error ? "生成失败" : "探索失败"}</div>
                        <div className="dw-confirm-msg dw-error-msg">{cs.error || cs.lastItemError}</div>
                        <div className="dw-confirm-actions">
                            <button className="dw-confirm-btn" onClick={() => { cs.error = null; cs.lastItemError = null; rerender(); }}>知道了</button>
                        </div>
                    </div>
                </div>
            )}
            {activeCharId && cs?.loaded && !cs.layout && !cs.isGenerating && (
                <div className="dwelling-empty">
                    <span>还未生成 ta 的房间</span>
                    <button className="dwelling-generate-btn" onClick={() => doGenerate(activeCharId)}>
                        <Wand2 size={16} />生成房间
                    </button>
                </div>
            )}

            {cs?.layout && roomMenuOpen && (
                <div className="dw-room-drawer-layer">
                    <button className="dw-room-drawer-shade" onClick={() => setRoomMenuOpen(false)} aria-label="关闭房间列表" />
                    <aside className="dw-room-drawer" aria-label="房间列表">
                        <div className="dw-room-drawer-header">
                            <div>
                                <span className="dw-room-drawer-kicker">ROOMS</span>
                                <strong>房间</strong>
                            </div>
                            <button className="dw-room-drawer-close" onClick={() => setRoomMenuOpen(false)} aria-label="关闭房间列表" title="关闭">
                                <X size={16} />
                            </button>
                        </div>
                        <div className="dw-room-drawer-list">
                            {cs.layout.rooms.map((room, idx) => (
                                <button key={room.id} className="dw-room-drawer-item"
                                    data-active={activeRoomIdx === idx ? "true" : undefined}
                                    onClick={() => { setActiveRoomIdx(idx); setItemDetail(null); setRoomMenuOpen(false); }}>
                                    <span className="dw-room-drawer-index">{String(idx + 1).padStart(2, "0")}</span>
                                    <span className="dw-room-drawer-copy">
                                        <span className="dw-room-drawer-name">{room.name}</span>
                                        {room.en && <span className="dw-room-drawer-en">{room.en}</span>}
                                    </span>
                                    <span className="dw-room-drawer-furniture" aria-label={`${room.furniture.length} 件家具`}>
                                        <span>{room.furniture.length}</span>
                                        <Armchair size={17} strokeWidth={1.8} aria-hidden="true" />
                                    </span>
                                </button>
                            ))}
                        </div>
                        <div className="dw-room-drawer-actions">
                            <button className="dw-tab-action" onClick={() => { setRoomMenuOpen(false); setShowRefreshConfirm(true); }} disabled={cs.isGenerating} title="重新生成">
                                <RefreshCw size={13} />
                            </button>
                            <button className="dw-tab-action dw-tab-action-danger" onClick={() => { setRoomMenuOpen(false); setShowDeleteConfirm(true); }} disabled={cs.isGenerating} title="删除布局">
                                <Trash2 size={13} />
                            </button>
                            <button className="dw-tab-action dw-tab-action-image" data-on={imageEnabled && imageConfigured ? "true" : undefined}
                                onClick={() => { const next = !imageEnabled; setImageEnabled(next); saveDwellingImageEnabled(next); }}
                                disabled={!imageConfigured || cs.isGenerating}
                                title={!imageConfigured ? "请先在设置中配置图像生成" : imageEnabled ? "禁止手动生图" : "允许手动生图"}
                                aria-label={imageEnabled ? "禁止手动生图" : "允许手动生图"}
                                aria-pressed={imageEnabled && imageConfigured}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                                    <path d="M15 8h.01" />
                                    <path d="M10 21h-4a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v5" />
                                    <path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l1 1" />
                                    <path d="M14 21v-4a2 2 0 1 1 4 0v4" />
                                    <path d="M14 19h4" />
                                    <path d="M21 15v6" />
                                </svg>
                            </button>
                        </div>
                    </aside>
                </div>
            )}

            {activeRoom && cs && (() => {
                const assetUrl = activeRoom.imageAssetId ? roomImageUrls.get(activeRoom.imageAssetId) ?? null : null;
                let imageStatus: DwellingRoomImageStatus = "ambient";
                if (cs.generatingImageRooms.has(activeRoom.id)) imageStatus = "generating";
                else if (imageEnabled && assetUrl) imageStatus = "ready";
                else if (imageEnabled && imageConfigured && cs.imageErrors[activeRoom.id]) imageStatus = "failed";
                return (
                    <RoomView
                        room={activeRoom}
                        itemHtmlCache={cs.itemHtmlCache}
                        loadingItemKeys={cs.loadingItemKeys}
                        lastItemError={cs.lastItemError}
                        onExploreItem={(furniture, item) => handleExploreItem(activeCharId!, activeRoom.id, furniture, item)}
                        onOpenItem={(furniture, item, html) => openItemDetail(activeRoom, furniture, item, html)}
                        onMoveMarker={(furnitureId, marker) => {
                            if (!activeCharId || !cs.layout) return;
                            const roomIdx = cs.layout.rooms.indexOf(activeRoom);
                            if (roomIdx < 0) return;
                            // 不可变更新：房间对象换新引用，RoomView 才会立即重算标注布局
                            cs.layout.rooms[roomIdx] = {
                                ...activeRoom,
                                furniture: activeRoom.furniture.map(f => f.id === furnitureId ? { ...f, marker } : f),
                            };
                            void saveDwellingLayout(activeCharId, cs.layout);
                            rerender();
                        }}
                        imageUrl={imageEnabled ? assetUrl : null}
                        imageStatus={imageStatus}
                        imageError={cs.imageErrors[activeRoom.id] ?? null}
                        imageEnabled={imageEnabled}
                        imageConfigured={imageConfigured}
                        onRetryImage={() => { if (activeCharId) void handleGenerateRoomImage(activeCharId, activeRoom.id); }}
                        onCancelImage={() => { if (activeCharId) cancelDwellingRoomImage(activeCharId, activeRoom.id); }}
                    />
                );
            })()}
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
                                htmlPageMode="contained"
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
                        <div className="dw-confirm-title">刷新房间</div>
                        <div className="dw-confirm-msg">选择刷新方式</div>
                        <div className="dw-confirm-actions-col">
                            <button className="dw-confirm-option" onClick={() => { setShowRefreshConfirm(false); handleRefresh("items"); }}>
                                <span className="dw-confirm-option-text">
                                    <strong>刷新物品</strong>
                                    <small>保留房间和家具，只更新物品</small>
                                </span>
                            </button>
                            <button className="dw-confirm-option" onClick={() => { setShowRefreshConfirm(false); handleRefresh("full"); }}>
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