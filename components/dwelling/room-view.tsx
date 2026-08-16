"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Wand2 } from "lucide-react";
import type { DwellingRoom, DwellingFurniture, DwellingFurnitureItem } from "@/lib/dwelling-storage";
import { resolveFurnitureMarker } from "@/lib/dwelling-engine";
import { DWELLING_IMAGE_CANCELED_ERROR } from "@/lib/dwelling-image";

export type DwellingRoomImageStatus = "ambient" | "generating" | "ready" | "failed";

type RoomViewProps = {
    room: DwellingRoom;
    itemHtmlCache: Record<string, string>;
    loadingItemKeys: Set<string>;
    lastItemError: string | null;
    onExploreItem: (furniture: DwellingFurniture, item: DwellingFurnitureItem) => void;
    onOpenItem: (furniture: DwellingFurniture, item: DwellingFurnitureItem, html: string) => void;
    onMoveMarker: (furnitureId: string, marker: { x: number; y: number }) => void;
    imageUrl: string | null;
    imageStatus: DwellingRoomImageStatus;
    imageError: string | null;
    imageEnabled: boolean;
    imageConfigured: boolean;
    onRetryImage: () => void;
    onCancelImage: () => void;
};

/** 与 dwelling-engine 的 clamp 范围保持一致：避开顶部玻璃栏区和底部引言区 */
const MK_X_MIN = 0.08, MK_X_MAX = 0.92, MK_Y_MIN = 0.24, MK_Y_MAX = 0.82;
const LONG_PRESS_MS = 450;
const LONG_PRESS_TOLERANCE = 10;

function ikey(roomId: string, itemId: string) { return `${roomId}_${itemId}`; }

function itemDescription(item: DwellingFurnitureItem): string {
    return item.preview || item.description || "";
}

function formatStageTime(): string {
    const d = new Date();
    let h = d.getHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${String(h).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

export function RoomView({
    room, itemHtmlCache, loadingItemKeys, lastItemError,
    onExploreItem, onOpenItem, onMoveMarker,
    imageUrl, imageStatus, imageError, imageEnabled, imageConfigured,
    onRetryImage, onCancelImage,
}: RoomViewProps) {
    const [viewMode, setViewMode] = useState<"stage" | "list">("stage");
    const [sheetFurnitureId, setSheetFurnitureId] = useState<string | null>(null);
    const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
    const [tip, setTip] = useState<string | null>(null);

    useEffect(() => {
        setSheetFurnitureId(null);
        setExpandedItemId(null);
    }, [room.id]);

    useEffect(() => {
        if (!tip) return;
        const t = setTimeout(() => setTip(null), 2600);
        return () => clearTimeout(t);
    }, [tip]);

    const stageRef = useRef<HTMLDivElement | null>(null);
    const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
    const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);

    useEffect(() => {
        if (viewMode !== "stage") return;
        const el = stageRef.current;
        if (!el) return;
        const update = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, [viewMode]);

    const imageToStagePoint = useCallback((point: { x: number; y: number }) => {
        if (!stageSize || !imageSize) return point;
        const scale = Math.max(stageSize.w / imageSize.w, stageSize.h / imageSize.h);
        const cropX = (imageSize.w * scale - stageSize.w) / 2;
        const cropY = (imageSize.h * scale - stageSize.h) / 2;
        return {
            x: (point.x * imageSize.w * scale - cropX) / stageSize.w,
            y: (point.y * imageSize.h * scale - cropY) / stageSize.h,
        };
    }, [imageSize, stageSize]);

    const stageToImagePoint = useCallback((point: { x: number; y: number }) => {
        if (!stageSize || !imageSize) return point;
        const scale = Math.max(stageSize.w / imageSize.w, stageSize.h / imageSize.h);
        const cropX = (imageSize.w * scale - stageSize.w) / 2;
        const cropY = (imageSize.h * scale - stageSize.h) / 2;
        return {
            x: Math.min(1, Math.max(0, (point.x * stageSize.w + cropX) / (imageSize.w * scale))),
            y: Math.min(1, Math.max(0, (point.y * stageSize.h + cropY) / (imageSize.h * scale))),
        };
    }, [imageSize, stageSize]);

    const markers = useMemo(() => {
        const hasImage = Boolean(imageUrl);
        const base = (room.furniture || []).map(f => {
            const sourceMarker = f.markerSpace === "image" && f.marker
                ? f.marker
                : resolveFurnitureMarker(f);
            const displayedMarker = f.markerSpace === "image" ? imageToStagePoint(sourceMarker) : sourceMarker;
            const m = {
                x: Math.min(MK_X_MAX, Math.max(MK_X_MIN, displayedMarker.x)),
                y: Math.min(MK_Y_MAX, Math.max(MK_Y_MIN, displayedMarker.y)),
            };
            return {
                f, m,
                h: m.x <= 0.55 ? "right" as const : "left" as const,
                len: 38,
            };
        });

        // Without an image, spread markers vertically with organic-looking offsets
        // derived from the furniture label (deterministic pseudo-random per item).
        if (!hasImage && base.length > 1) {
            // Simple hash from label string → 0..1 (deterministic, no Math.random)
            const hash01 = (s: string) => {
                let h = 0;
                for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
                return ((h & 0x7fffffff) % 1000) / 1000;
            };
            const minGapY = 0.09;
            const rangeY = MK_Y_MAX - MK_Y_MIN;
            const totalSpan = (base.length - 1) * minGapY;
            const effectiveGap = totalSpan > rangeY ? rangeY / (base.length - 1) : minGapY;
            // Spread vertically, then jitter each gap slightly
            const sorted = [...base].sort((a, b) => a.m.y - b.m.y);
            const groupHeight = (sorted.length - 1) * effectiveGap;
            const startY = MK_Y_MIN + (rangeY - groupHeight) / 2;
            for (let i = 0; i < sorted.length; i++) {
                const jitterY = (hash01(sorted[i].f.label + "y") - 0.5) * effectiveGap * 0.35;
                sorted[i].m.y = Math.min(MK_Y_MAX, Math.max(MK_Y_MIN, startY + i * effectiveGap + jitterY));
            }
            // Organic x: wander between 0.30–0.65 based on label hash
            for (let i = 0; i < sorted.length; i++) {
                const hx = hash01(sorted[i].f.label + "x");
                sorted[i].m.x = 0.30 + hx * 0.35;
                sorted[i].h = sorted[i].m.x <= 0.50 ? "right" : "left";
            }
        }

        if (!stageSize) return base;
        const placed: Array<{ x1: number; x2: number; y1: number; y2: number }> = [];
        const rectFor = (px: number, py: number, label: string, en: string | undefined, h: "left" | "right", len: number) => {
            const labelW = Math.max(58, Array.from(label).length * 17 + 34, (en?.length ?? 0) * 10);
            const labelH = en ? 36 : 18;
            const x1 = h === "right" ? px + 12 + len : px - 12 - len - labelW;
            return { x1, x2: x1 + labelW, y1: py - 8, y2: py - 8 + labelH };
        };
        const collides = (rect: { x1: number; x2: number; y1: number; y2: number }) =>
            placed.some(p => !(rect.x2 + 4 < p.x1 || rect.x1 > p.x2 + 4 || rect.y2 + 2 < p.y1 || rect.y1 > p.y2 + 2));
        const inBounds = (rect: { x1: number; x2: number; y1: number; y2: number }) =>
            rect.x1 >= 8 && rect.x2 <= stageSize.w - 8 && rect.y1 >= 8 && rect.y2 <= stageSize.h - 92;

        const sorted = [...base].sort((a, b) => a.m.y - b.m.y);
        for (const mk of sorted) {
            const flip = mk.h === "right" ? "left" as const : "right" as const;
            // Phase 1: try different len/direction at current y
            const hOpts: Array<"left" | "right"> = [mk.h, flip];
            const lenOpts = [4, 12, 24, 38, 56];
            let done = false;
            for (const len of lenOpts) {
                for (const h of hOpts) {
                    const rect = rectFor(mk.m.x * stageSize.w, mk.m.y * stageSize.h, mk.f.label, mk.f.en, h, len);
                    if (!inBounds(rect) || collides(rect)) continue;
                    mk.h = h; mk.len = len;
                    placed.push(rect); done = true; break;
                }
                if (done) break;
            }
            // Phase 2: nudge y position to escape vertical overlap
            if (!done) {
                const nudges = [-0.04, 0.04, -0.08, 0.08, -0.12, 0.12, -0.16, 0.16];
                outer: for (const dy of nudges) {
                    const ny = mk.m.y + dy;
                    if (ny < MK_Y_MIN || ny > MK_Y_MAX) continue;
                    for (const len of lenOpts) {
                        for (const h of hOpts) {
                            const rect = rectFor(mk.m.x * stageSize.w, ny * stageSize.h, mk.f.label, mk.f.en, h, len);
                            if (!inBounds(rect) || collides(rect)) continue;
                            mk.m.y = ny; mk.h = h; mk.len = len;
                            placed.push(rect); done = true; break outer;
                        }
                    }
                }
            }
            if (!done) placed.push(rectFor(mk.m.x * stageSize.w, mk.m.y * stageSize.h, mk.f.label, mk.f.en, mk.h, mk.len));
        }
        return base;
    }, [imageToStagePoint, imageUrl, room, room.furniture, stageSize]);

    // ── 长按拖动标注点 ──
    const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
    const dragRef = useRef<{
        id: string; pointerId: number; target: HTMLElement;
        startX: number; startY: number; timer: number;
        active: boolean; committed: { x: number; y: number } | null;
    } | null>(null);
    const suppressClickRef = useRef(false);

    function stagePoint(clientX: number, clientY: number): { x: number; y: number } | null {
        const el = stageRef.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
            x: Math.min(MK_X_MAX, Math.max(MK_X_MIN, (clientX - rect.left) / rect.width)),
            y: Math.min(MK_Y_MAX, Math.max(MK_Y_MIN, (clientY - rect.top) / rect.height)),
        };
    }

    function clearDragTimer() {
        const st = dragRef.current;
        if (st) window.clearTimeout(st.timer);
    }

    function handlePtDown(furnitureId: string, e: React.PointerEvent<HTMLButtonElement>) {
        const target = e.currentTarget;
        const { clientX, clientY, pointerId } = e;
        clearDragTimer();
        const st = {
            id: furnitureId, pointerId, target: target as HTMLElement,
            startX: clientX, startY: clientY, timer: 0,
            active: false, committed: null,
        };
        st.timer = window.setTimeout(() => {
            st.active = true;
            suppressClickRef.current = true;
            try { st.target.setPointerCapture(pointerId); } catch { /* ignore */ }
            const p = stagePoint(clientX, clientY);
            if (p) setDrag({ id: furnitureId, ...p });
        }, LONG_PRESS_MS);
        dragRef.current = st;
    }

    function handlePtMove(e: React.PointerEvent<HTMLButtonElement>) {
        const st = dragRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        if (!st.active) {
            // 还没触发长按：移动超过容差就当作普通滑动，取消长按
            if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) > LONG_PRESS_TOLERANCE) {
                clearDragTimer();
                dragRef.current = null;
            }
            return;
        }
        const p = stagePoint(e.clientX, e.clientY);
        if (p) {
            st.committed = p;
            setDrag({ id: st.id, ...p });
        }
    }

    function handlePtUp(e: React.PointerEvent<HTMLButtonElement>) {
        const st = dragRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        clearDragTimer();
        if (st.active) {
            const p = st.committed ?? stagePoint(e.clientX, e.clientY);
            const furniture = room.furniture.find(item => item.id === st.id);
            if (p) onMoveMarker(st.id, furniture?.markerSpace === "image" ? stageToImagePoint(p) : p);
        }
        dragRef.current = null;
        setDrag(null);
    }

    function handlePtCancel(e: React.PointerEvent<HTMLButtonElement>) {
        const st = dragRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        clearDragTimer();
        dragRef.current = null;
        setDrag(null);
        suppressClickRef.current = false;
    }

    function handleMarkerTap(furnitureId: string) {
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
        }
        setSheetFurnitureId(furnitureId);
    }

    const sheetFurniture = sheetFurnitureId
        ? (room.furniture || []).find(f => f.id === sheetFurnitureId) ?? null
        : null;

    const [confirmAction, setConfirmAction] = useState<"regen" | null>(null);

    function handleGenerateCurrentImage() {
        if (!imageConfigured) {
            setTip("请先在设置中配置并开启图像生成");
            return;
        }
        if (!imageEnabled) {
            setTip("请先开启生图");
            return;
        }
        if (imageStatus === "generating") return;
        setConfirmAction("regen");
    }

    // ── 清单视图 ──
    if (viewMode === "list") {
        return (
            <div className="dw-room">
                <div className="dw2-listbar">
                    <span className="dw2-listbar-title">物品清单<span className="dw2-listbar-en">INVENTORY</span></span>
                    <button className="dw2-listback" onClick={() => setViewMode("stage")}>返回实景</button>
                </div>
                <div className="dw-room-atmosphere"><p>{room.description}</p></div>
                <div className="dw-furniture-grid">
                    {(room.furniture || []).map(f => (
                        <ListFurnitureCard
                            key={f.id}
                            room={room}
                            furniture={f}
                            itemHtmlCache={itemHtmlCache}
                            loadingItemKeys={loadingItemKeys}
                            lastItemError={lastItemError}
                            onExploreItem={onExploreItem}
                            onOpenItem={onOpenItem}
                        />
                    ))}
                </div>
            </div>
        );
    }

    // ── 舞台视图 ──
    return (
        <div className="dw2-stage" ref={stageRef}>
            {/* 氛围底图（生图未就绪时可见） */}
            <div className="dw2-ambient">
                <div className="dw2-l1" /><div className="dw2-l2" /><div className="dw2-l3" />
                <div className="dw2-grain" />
                {!imageUrl && markers.length > 1 && (
                    <svg className="dw2-cst" viewBox="0 0 100 100" preserveAspectRatio="none">
                        {markers.slice(0, -1).map((mk, i) => {
                            const next = markers[i + 1];
                            return (
                                <line key={mk.f.id}
                                    x1={mk.m.x * 100} y1={mk.m.y * 100}
                                    x2={next.m.x * 100} y2={next.m.y * 100}
                                    vectorEffect="non-scaling-stroke" />
                            );
                        })}
                    </svg>
                )}
            </div>

            {/* 生成图 */}
            {imageUrl && (
                <img
                    className="dw2-img"
                    src={imageUrl}
                    alt={room.name}
                    draggable={false}
                    onLoad={event => setImageSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
                />
            )}

            <div className="dw2-scrim-top" />
            <div className="dw2-scrim-bottom" />
            <div className="dw2-wall">Dwelling</div>

            {/* 状态徽标 */}
            {imageStatus === "failed" && (
                <button className="dw2-badge" data-kind="fail" onClick={onRetryImage} title={imageError ?? undefined}>
                    {imageError === DWELLING_IMAGE_CANCELED_ERROR ? "已停止 · 点击生成" : "生成失败 · 重试"}
                </button>
            )}

            {/* 家具标注（长按可拖动微调位置） */}
            {markers.map(({ f, m, h, len }) => {
                const isDragging = drag?.id === f.id;
                const x = isDragging ? drag.x : m.x;
                const y = isDragging ? drag.y : m.y;
                return (
                    <div key={f.id} className="dw2-mk" data-h={h} data-drag={isDragging ? "true" : undefined}
                        style={{ left: `${x * 100}%`, top: `${y * 100}%`, "--mklen": `${len}px` } as React.CSSProperties}>
                        <button className="dw2-pt" aria-label={f.label}
                            onClick={() => handleMarkerTap(f.id)}
                            onPointerDown={e => handlePtDown(f.id, e)}
                            onPointerMove={handlePtMove}
                            onPointerUp={handlePtUp}
                            onPointerCancel={handlePtCancel}
                            onContextMenu={e => e.preventDefault()} />
                        <span className="dw2-hln" />
                        <span className="dw2-lbl" onClick={() => handleMarkerTap(f.id)}>
                            <span className="dw2-zh">{f.label}<i>{String(f.items.length).padStart(2, "0")}</i></span>
                            {f.en && <span className="dw2-en">{f.en}</span>}
                        </span>
                    </div>
                );
            })}

            {/* 底部：氛围引言 + 元信息 */}
            <div className="dw2-bottom">
                <div className="dw2-qline">
                    <span className="dw2-qbar" />
                    <p className="dw2-quote">{room.description}</p>
                </div>
                <div className="dw2-meta">
                    <span className="dw2-time">{formatStageTime()}</span>
                    <span className="dw2-ops">
                        <button className="dw2-op" data-on={imageEnabled && imageConfigured ? "true" : undefined}
                            data-loading={imageStatus === "generating" ? "true" : undefined}
                            onClick={imageStatus === "generating" ? onCancelImage : handleGenerateCurrentImage}
                            title={imageStatus === "generating" ? "停止生成" : "生成当前房间图"}
                            aria-label={imageStatus === "generating" ? "停止生成" : "生成当前房间图"}>
                            {imageStatus === "generating" ? <LoaderCircle aria-hidden="true" /> : <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                                <path d="M10 20h-5a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v2" />
                                <path d="M14.362 11.15a3 3 0 1 0 -4.144 4.263" />
                                <path d="M14 21v-4a2 2 0 1 1 4 0v4" />
                                <path d="M14 19h4" />
                                <path d="M21 15v6" />
                            </svg>}
                        </button>
                    </span>
                </div>
            </div>

            {tip && <div className="dw2-tip">{tip}</div>}

            {/* 生图确认弹窗 */}
            {confirmAction && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setConfirmAction(null)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">
                            生成房间图
                        </div>
                        <div className="dw-confirm-msg">
                            {imageStatus === "ready"
                                ? `将为「${room.name}」重新生成一张房间图\n并替换当前图片`
                                : `将为「${room.name}」生成一张房间图`}
                        </div>
                        <div className="dw-confirm-actions">
                            <button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setConfirmAction(null)}>取消</button>
                            <button className="dw-confirm-btn" onClick={() => {
                                setConfirmAction(null);
                                onRetryImage();
                            }}>确认</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 家具底部弹窗 */}
            {sheetFurniture && (
                <div className="dw2-sheet-overlay">
                    <div className="dw2-dim" onClick={() => { setSheetFurnitureId(null); setExpandedItemId(null); }} />
                    <div className="dw2-sheet" role="dialog" aria-modal="true" aria-label={sheetFurniture.label}>
                        <div className="dw2-grab" />
                        <div className="dw2-sh">
                            <span className="dw2-sh-zh">{sheetFurniture.label}<i>{String(sheetFurniture.items.length).padStart(2, "0")}</i></span>
                            {sheetFurniture.en && <span className="dw2-sh-en">{sheetFurniture.en}</span>}
                            <span className="dw2-sh-cnt">{sheetFurniture.items.length} 件物品</span>
                        </div>
                        <div className="dw2-shline" />
                        {sheetFurniture.items.map((item, idx) => {
                            const key = ikey(room.id, item.id);
                            const html = itemHtmlCache[key];
                            const isLoading = loadingItemKeys.has(key);
                            const isOpen = expandedItemId === item.id;
                            return (
                                <div key={item.id}>
                                    <button className="dw2-srow"
                                        onClick={() => {
                                            if (html) { onOpenItem(sheetFurniture, item, html); return; }
                                            setExpandedItemId(isOpen ? null : item.id);
                                        }}>
                                        <span className="dw2-sno">{String(idx + 1).padStart(2, "0")}</span>
                                        <span className="dw2-stx">
                                            <span className="dw2-sname">{item.name}{html && <em className="dw2-sdone">已探索</em>}</span>
                                            <span className="dw2-sprev">{itemDescription(item)}</span>
                                        </span>
                                        <span className="dw2-sgo">{html ? "›" : isOpen ? "▾" : "›"}</span>
                                    </button>
                                    {isOpen && !html && (
                                        <div className="dw2-sexpand">
                                            {isLoading ? (
                                                <div className="dw2-sload">
                                                    <span className="dwelling-spinner" style={{ width: 13, height: 13, borderWidth: 1.5 }} />
                                                    <span>正在探索…</span>
                                                </div>
                                            ) : (
                                                <>
                                                    <button className="dw2-cta" onClick={() => onExploreItem(sheetFurniture, item)}>
                                                        开 始 探 索
                                                        <span className="dw2-cta-en">EXPLORE</span>
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── 清单视图的家具卡（沿用旧交互） ──

type ListFurnitureCardProps = {
    room: DwellingRoom;
    furniture: DwellingFurniture;
    itemHtmlCache: Record<string, string>;
    loadingItemKeys: Set<string>;
    lastItemError: string | null;
    onExploreItem: (furniture: DwellingFurniture, item: DwellingFurnitureItem) => void;
    onOpenItem: (furniture: DwellingFurniture, item: DwellingFurnitureItem, html: string) => void;
};

function ListFurnitureCard({ room, furniture, itemHtmlCache, loadingItemKeys, lastItemError, onExploreItem, onOpenItem }: ListFurnitureCardProps) {
    const [collapsed, setCollapsed] = useState(false);
    const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
    const isExpanded = !collapsed;

    return (
        <div className="dw-fur-card" data-expanded={isExpanded ? "true" : undefined}>
            <button className="dw-fur-header" onClick={() => setCollapsed(c => !c)}>
                <span className="dw-fur-label">{furniture.label}</span>
                <span className="dw-fur-count">{furniture.items.length}</span>
                <span className="dw-fur-chevron">{isExpanded ? "▾" : "▸"}</span>
            </button>
            {isExpanded && (
                <div className="dw-fur-items">
                    {furniture.items.map(item => {
                        const key = ikey(room.id, item.id);
                        const html = itemHtmlCache[key];
                        const isLoading = loadingItemKeys.has(key);
                        const isOpen = expandedItemId === item.id;
                        return (
                            <div key={item.id}>
                                <button className="dw-item-row" onClick={() => {
                                    if (html) { onOpenItem(furniture, item, html); return; }
                                    setExpandedItemId(isOpen ? null : item.id);
                                }}>
                                    <span className="dw-item-dot" />
                                    <div className="dw-item-text">
                                        <span className="dw-item-name">{item.name}</span>
                                        <span className="dw-item-preview">{itemDescription(item)}</span>
                                    </div>
                                    <span className="dw-item-go">{html ? "›" : isOpen ? "▾" : "›"}</span>
                                </button>
                                {isOpen && !html && (
                                    <div className="dw-item-expand">
                                        {isLoading ? (
                                            <div className="dw-explore-loading">
                                                <span className="dwelling-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                                                <span>正在探索…</span>
                                            </div>
                                        ) : (
                                            <>
                                                {lastItemError && <div className="dwelling-error" style={{ margin: "4px 0 8px" }}>{lastItemError}</div>}
                                                <button className="dw-explore-btn" onClick={() => onExploreItem(furniture, item)}>
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
}