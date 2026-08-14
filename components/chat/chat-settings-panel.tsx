"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
    CHAT_INITIAL_VISIBLE_MESSAGE_COUNT,
    CHAT_LOAD_MORE_MESSAGE_COUNT,
    ChatSession,
    clearChatSessionMessages,
    clearChatSessionToolHistory,
    saveChatSessions,
    loadChatSessions,
    loadChatMessages,
    loadChatContacts,
    getChatMessagePreview,
    pushChatMessage,
    removeChatContact,
    deleteChatSession,
    normalizeVisionImagePromptLimit,
    MAX_VISION_IMAGE_PROMPT_LIMIT,
    loadGroupTitleColorPalette,
    saveGroupTitleColorToPalette,
    removeGroupTitleColorFromPalette,
    type ChatMessage,
} from "@/lib/chat-storage";
import {
    GROUP_SELF_KEY,
    applyGroupAdminAction,
    buildGroupAdminNoticeText,
    canGroupAdminAct,
    formatMuteDurationLabel,
    formatMuteRemainingLabel,
    getGroupMemberDisplayName,
    getGroupMuteRemainingMs,
    getGroupOwnerKey,
    getGroupRole,
    getGroupTitle,
    getGroupTitleColor,
    setGroupTitleColor,
    getGroupBadgeText,
    canSetGroupTitle,
    setGroupTitle,
    pruneExpiredGroupMutes,
    type GroupAdminAction,
} from "@/lib/group-admin";
import { clearChatOfflineTurns } from "@/lib/chat-offline-storage";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { triggerDeleteFriendReaction } from "@/lib/friend-request-engine";
import { loadCharacters } from "@/lib/character-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import {
    ChevronRight,
    ChevronLeft,
    Image as ImageIcon,
    Video,
    Mic,
    UserMinus,
    UserPlus,
    Users,
    Pin,
    MessageSquare,
    Search,
    AlertCircle,
    Code,
    Trash2,
    SquareUserRound,
    Settings2,
    WandSparkles,
    Settings,
    Crown,
    Sun,
    Moon,
    Star,
    SquareArrowOutUpRight,
    Minus,
    Plus,
    QrCode,
    CalendarDays,
    WalletCards,
    type LucideIcon,
} from "lucide-react";
import {
    HERO_DECORATION_KEYS,
    loadChatHeroData,
    updateChatHeroData,
    type ChatHeroData,
    type HeroDecorationCounts,
    type HeroDecorationKey,
} from "@/lib/chat-hero-storage";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { ConfirmDialog } from "@/components/ui/modal";
import { CHAT_SESSION_CSS_EXAMPLE } from "@/lib/css-examples";
import { Toggle, Input, AvatarUpload } from "@/components/ui/form";
import { PageShell } from "@/components/ui/page-shell";
import {
    DEFAULT_CHAT_BILINGUAL_PROMPT,
    DEFAULT_GROUP_CHAT_BILINGUAL_PROMPT,
    DEFAULT_GROUP_OFFLINE_CHAT_BILINGUAL_PROMPT,
    DEFAULT_OFFLINE_CHAT_BILINGUAL_PROMPT,
} from "@/lib/bilingual-prompt-defaults";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";
import { MessageBubble, isStandaloneHtmlPreviewContent } from "./message-bubble";

type ChatSettingsPanelProps = {
    session: ChatSession;
    onClose: () => void;
    onJumpToMessage?: (messageId: string) => void;
    onDeleteFriend?: () => void;
    onToolHistoryCleared?: () => void;
    onOfflineHistoryCleared?: () => void;
    offlineHistoryBusy?: boolean;
};

function fileToDataUrl(file: File, maxSize = 400, quality = 0.8): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement("canvas");
                const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
                canvas.width = img.width * scale;
                canvas.height = img.height * scale;
                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/webp", quality));
            };
            img.onerror = reject;
            img.src = reader.result as string;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

const chatInfoIconStyle = (color: string): CSSProperties => ({
    "--icon-color": color,
} as CSSProperties);

type SearchResultRole = "user" | "assistant" | "system";
type SearchResultMediaType = NonNullable<ChatMessage["mediaType"]>;
const SEARCH_RESULT_LIMIT = 80;
const SEARCH_TEXT_SCAN_LIMIT = 20_000;
const SEARCH_SCAN_CHUNK_SIZE = 120;

const SEARCH_MEDIA_BUBBLE_TYPES = new Set<SearchResultMediaType>([
    "sticker",
    "red_packet",
    "transfer",
    "payment_request",
    "gift",
    "image",
    "location",
    "music_share",
    "xiaohongshu_note_share",
    "media_file",
]);

const SEARCH_VISUAL_MEDIA_TYPES = new Set<SearchResultMediaType>([
    ...SEARCH_MEDIA_BUBBLE_TYPES,
    "audio",
    "video",
    "quote",
]);

const SEARCH_ACTION_MEDIA_TYPES = new Set<SearchResultMediaType>([
    "poke",
    "accept_red_packet",
    "decline_red_packet",
    "accept_transfer",
    "decline_transfer",
    "accept_payment_request",
    "decline_payment_request",
    "group_admin_notice",
]);

function getSearchResultRole(msg: ChatMessage): SearchResultRole {
    if (msg.role === "system" || (msg.mediaType && SEARCH_ACTION_MEDIA_TYPES.has(msg.mediaType))) return "system";
    return msg.role === "user" ? "user" : "assistant";
}

function isSearchHiddenMessage(msg: ChatMessage): boolean {
    return msg.role === "tool"
        || msg.mediaType === "tool_result"
        || msg.mediaType === "tool_notice"
        || msg.mediaType === "memory_write_request"
        || Boolean(msg.nativeToolCalls?.length && !msg.content.trim());
}

function isSearchVisibleMessage(msg: ChatMessage): boolean {
    if (isSearchHiddenMessage(msg)) return false;
    if (msg.mediaType && SEARCH_VISUAL_MEDIA_TYPES.has(msg.mediaType)) return true;
    if (msg.statusPanel || msg.innerMonologue) return true;
    return Boolean(getSearchResultText(msg));
}

function getSearchResultText(msg: ChatMessage): string {
    return (msg.content.trim() || getChatMessagePreview(msg)).trim();
}

function clipSearchText(value: unknown): string {
    return String(value ?? "").slice(0, SEARCH_TEXT_SCAN_LIMIT);
}

function getSearchHaystack(msg: ChatMessage): string {
    return [
        clipSearchText(msg.content),
        clipSearchText(getChatMessagePreview(msg)),
        clipSearchText(msg.mediaData?.label),
        clipSearchText(msg.mediaData?.musicTitle),
        clipSearchText(msg.mediaData?.xiaohongshuTitle),
        clipSearchText(msg.mediaData?.giftName),
        clipSearchText(msg.senderName),
    ].filter(Boolean).join("\n");
}

function ChatInfoIcon({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <span className="chat-info-icon" style={chatInfoIconStyle(color)}>
            <Icon size={22} strokeWidth={1.75} />
        </span>
    );
}

// ── Hero 装饰图标（皇冠 / 太阳 / 月亮 / 星星）──
const HERO_DECORATION_META: { key: HeroDecorationKey; icon: LucideIcon; label: string }[] = [
    { key: "crown", icon: Crown, label: "皇冠" },
    { key: "sun", icon: Sun, label: "太阳" },
    { key: "moon", icon: Moon, label: "月亮" },
    { key: "star", icon: Star, label: "星星" },
];

// ── 概览分类 ──
type SettingsCategory = "basic" | "manage" | "function" | "appearance" | "other";

const SETTINGS_CATEGORY_META: { key: SettingsCategory; icon: LucideIcon; label: string; groupOnly?: boolean }[] = [
    { key: "basic", icon: SquareUserRound, label: "Basic info" },
    { key: "manage", icon: Users, label: "Group", groupOnly: true },
    { key: "function", icon: Settings2, label: "Plug-ins" },
    { key: "appearance", icon: WandSparkles, label: "Appearance" },
    { key: "other", icon: Settings, label: "Others" },
];

// ── 头衔颜色色轮：HSV 色轮（色相+饱和度）+ 明暗滑条 + 十六进制输入 ──
type HsvColor = { h: number; s: number; v: number };

function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
}

function isValidHexColor(value: string): boolean {
    return /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(value.trim());
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
    let clean = hex.trim().replace(/^#/, "");
    if (clean.length === 3) clean = clean.split("").map(c => c + c).join("");
    const num = parseInt(clean, 16);
    if (clean.length !== 6 || Number.isNaN(num)) return { r: 0, g: 0, b: 0 };
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHex(r: number, g: number, b: number): string {
    const toHex = (n: number) => Math.round(clamp01(n / 255) * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function rgbToHsv(r: number, g: number, b: number): HsvColor {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === rn) h = 60 * (((gn - bn) / d) % 6);
        else if (max === gn) h = 60 * ((bn - rn) / d + 2);
        else h = 60 * ((rn - gn) / d + 4);
    }
    if (h < 0) h += 360;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    return { h, s, v };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
    const c = v * s;
    const hh = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hh % 2) - 1));
    let rp = 0, gp = 0, bp = 0;
    if (hh < 1) { rp = c; gp = x; bp = 0; }
    else if (hh < 2) { rp = x; gp = c; bp = 0; }
    else if (hh < 3) { rp = 0; gp = c; bp = x; }
    else if (hh < 4) { rp = 0; gp = x; bp = c; }
    else if (hh < 5) { rp = x; gp = 0; bp = c; }
    else { rp = c; gp = 0; bp = x; }
    const m = v - c;
    return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 };
}

function hexToHsv(hex: string): HsvColor {
    const { r, g, b } = hexToRgb(hex);
    return rgbToHsv(r, g, b);
}

function hsvToHex(h: number, s: number, v: number): string {
    const { r, g, b } = hsvToRgb(h, s, v);
    return rgbToHex(r, g, b);
}

function GroupTitleColorWheel({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
    const wheelRef = useRef<HTMLDivElement | null>(null);
    const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(isValidHexColor(value) ? value : "#84E1A8"));
    const [hexInput, setHexInput] = useState(value.toUpperCase());
    const draggingRef = useRef<"wheel" | "value" | null>(null);

    // 外部 value 变化（例如点击调色板色块）时同步内部状态；拖拽过程中避免被浮点误差反复覆盖
    useEffect(() => {
        if (!isValidHexColor(value)) return;
        setHexInput(value.toUpperCase());
        if (draggingRef.current) return;
        setHsv(prev => {
            const next = hexToHsv(value);
            if (Math.abs(next.h - prev.h) < 0.5 && Math.abs(next.s - prev.s) < 0.004 && Math.abs(next.v - prev.v) < 0.004) {
                return prev;
            }
            return next;
        });
    }, [value]);

    const updateFromWheelPoint = useCallback((clientX: number, clientY: number) => {
        const el = wheelRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const radius = rect.width / 2;
        const x = clientX - rect.left - radius;
        const y = clientY - rect.top - radius;
        const dist = Math.min(radius, Math.sqrt(x * x + y * y));
        let angle = Math.atan2(y, x) * 180 / Math.PI;
        if (angle < 0) angle += 360;
        const s = radius === 0 ? 0 : dist / radius;
        setHsv(prev => {
            const next = { h: angle, s, v: prev.v };
            onChange(hsvToHex(next.h, next.s, next.v));
            return next;
        });
    }, [onChange]);

    const updateFromValuePoint = useCallback((clientX: number, trackEl: HTMLDivElement) => {
        const rect = trackEl.getBoundingClientRect();
        const ratio = rect.width === 0 ? 0 : clamp01((clientX - rect.left) / rect.width);
        setHsv(prev => {
            const next = { ...prev, v: ratio };
            onChange(hsvToHex(next.h, next.s, next.v));
            return next;
        });
    }, [onChange]);

    const handleWheelPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        draggingRef.current = "wheel";
        updateFromWheelPoint(e.clientX, e.clientY);
    };
    const handleWheelPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (draggingRef.current !== "wheel") return;
        updateFromWheelPoint(e.clientX, e.clientY);
    };
    const handleValuePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        draggingRef.current = "value";
        updateFromValuePoint(e.clientX, e.currentTarget);
    };
    const handleValuePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (draggingRef.current !== "value") return;
        updateFromValuePoint(e.clientX, e.currentTarget);
    };
    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        draggingRef.current = null;
    };

    const commitHexInput = (raw: string) => {
        const trimmed = raw.trim();
        const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
        if (isValidHexColor(normalized)) {
            const next = hexToHsv(normalized);
            setHsv(next);
            onChange(hsvToHex(next.h, next.s, next.v));
        } else {
            setHexInput(hsvToHex(hsv.h, hsv.s, hsv.v));
        }
    };

    const dotLeft = 50 + Math.cos(hsv.h * Math.PI / 180) * hsv.s * 50;
    const dotTop = 50 + Math.sin(hsv.h * Math.PI / 180) * hsv.s * 50;
    const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v);

    return (
        <div className="chat-title-color-wheel-block">
            <div
                ref={wheelRef}
                className="chat-title-color-wheel-dial"
                onPointerDown={handleWheelPointerDown}
                onPointerMove={handleWheelPointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
            >
                <span
                    className="chat-title-color-wheel-dot"
                    style={{ left: `${dotLeft}%`, top: `${dotTop}%`, background: currentHex }}
                />
            </div>
            <div className="chat-title-color-value-row">
                <span className="chat-title-color-value-label">明暗</span>
                <div
                    className="chat-title-color-value-track"
                    onPointerDown={handleValuePointerDown}
                    onPointerMove={handleValuePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                >
                    <span className="chat-title-color-value-fill" style={{ width: `${hsv.v * 100}%` }} />
                    <span className="chat-title-color-value-thumb" style={{ left: `${hsv.v * 100}%` }} />
                </div>
            </div>
            <div className="chat-title-color-hex-row">
                <span className="chat-title-color-hex-swatch" style={{ background: currentHex }} />
                <input
                    type="text"
                    className="chat-title-color-hex-input"
                    value={hexInput}
                    onChange={e => setHexInput(e.target.value)}
                    onBlur={e => commitHexInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") commitHexInput((e.target as HTMLInputElement).value); }}
                    maxLength={7}
                    aria-label="十六进制颜色值"
                />
            </div>
        </div>
    );
}

export function ChatSettingsPanel({
    session,
    onClose,
    onJumpToMessage,
    onDeleteFriend,
    onToolHistoryCleared,
    onOfflineHistoryCleared,
    offlineHistoryBusy = false,
}: ChatSettingsPanelProps) {
    const [backgroundImage, setBackgroundImage] = useState<string>(session.backgroundImage || "");
    const [alias, setAlias] = useState<string>(session.alias || "");
    const [videoBackground, setVideoBackground] = useState<string>(session.videoBackground || "");
    const [voiceBackground, setVoiceBackground] = useState<string>(session.voiceBackground || "");
    const [isPinned, setIsPinned] = useState(session.isPinned || false);
    const [isBlacklisted, setIsBlacklisted] = useState(session.isBlacklisted === true);
    const [visionImagePromptLimit, setVisionImagePromptLimit] = useState(() => normalizeVisionImagePromptLimit(session.visionImagePromptLimit));
    const [bilingualTranslationEnabled, setBilingualTranslationEnabled] = useState(session.bilingualTranslationEnabled !== false);
    const [collapseBilingualTranslation, setCollapseBilingualTranslation] = useState(session.collapseBilingualTranslation !== false);
    const defaultBilingualPrompt = session.isGroup ? DEFAULT_GROUP_CHAT_BILINGUAL_PROMPT : DEFAULT_CHAT_BILINGUAL_PROMPT;
    const defaultOfflineBilingualPrompt = session.isGroup ? DEFAULT_GROUP_OFFLINE_CHAT_BILINGUAL_PROMPT : DEFAULT_OFFLINE_CHAT_BILINGUAL_PROMPT;
    const [bilingualTranslationPrompt, setBilingualTranslationPrompt] = useState(session.bilingualTranslationPrompt || defaultBilingualPrompt);
    const [bilingualPromptDraft, setBilingualPromptDraft] = useState(session.bilingualTranslationPrompt || defaultBilingualPrompt);
    const [offlineBilingualTranslationPrompt, setOfflineBilingualTranslationPrompt] = useState(session.offlineBilingualTranslationPrompt || defaultOfflineBilingualPrompt);
    const [offlineBilingualPromptDraft, setOfflineBilingualPromptDraft] = useState(session.offlineBilingualTranslationPrompt || defaultOfflineBilingualPrompt);
    const [htmlGenerationEnabled, setHtmlGenerationEnabled] = useState(session.htmlGenerationEnabled === true);
    const [timestampShowSeconds, setTimestampShowSeconds] = useState(session.timestampShowSeconds === true);
    const [timeZone, setTimeZone] = useState(session.timeZone || "");
    const [customCSS, setCustomCSS] = useState(() => {
        // Read latest CSS from storage (in case 小卷 updated it)
        const sessions = loadChatSessions();
        const latest = sessions.find(s => s.id === session.id);
        return (latest as Record<string, unknown>)?.customCSS as string || session.customCSS || "";
    });

    // ── Hero 卡片 + 两级导航状态 ──
    const [activeCategory, setActiveCategory] = useState<SettingsCategory | null>(null);
    const [heroData, setHeroData] = useState<ChatHeroData>(() => loadChatHeroData(session.id));
    const [heroBgResolved, setHeroBgResolved] = useState<string>("");
    const [editingSignature, setEditingSignature] = useState(false);
    const [signatureDraft, setSignatureDraft] = useState("");
    const [showDecorationEditor, setShowDecorationEditor] = useState(false);
    const heroBgInputRef = useRef<HTMLInputElement | null>(null);

    // ── 聊天统计卡片：累计天数 / 消息条数（真实读取会话消息计算）──
    const chatStats = useMemo(() => {
        const allMessages = loadChatMessages(session.id);
        const visibleMessages = allMessages.filter(m => m.role !== "system" && !m.isRetracted);
        const firstMessage = allMessages[0];
        let daysTogether = 1;
        if (firstMessage) {
            const startOfDay = (iso: string) => {
                const d = new Date(iso);
                d.setHours(0, 0, 0, 0);
                return d.getTime();
            };
            const dayMs = 24 * 60 * 60 * 1000;
            const diff = Math.floor((startOfDay(new Date().toISOString()) - startOfDay(firstMessage.createdAt)) / dayMs);
            daysTogether = Math.max(1, diff + 1);
        }
        return { daysTogether, messageCount: visibleMessages.length };
    }, [session.id]);

    // 解析背景图引用 ID -> dataUrl（走 chat-asset-storage 的 IndexedDB）
    useEffect(() => {
        let cancelled = false;
        const id = heroData.backgroundImageId;
        if (!id) {
            setHeroBgResolved("");
            return;
        }
        if (id.startsWith("data:") || id.startsWith("http")) {
            setHeroBgResolved(id);
            return;
        }
        import("@/lib/chat-asset-storage").then(({ getChatImageFromIndexedDB }) => {
            getChatImageFromIndexedDB(id).then(dataUrl => {
                if (!cancelled) setHeroBgResolved(dataUrl || "");
            });
        });
        return () => { cancelled = true; };
    }, [heroData.backgroundImageId]);

    const patchHeroData = (patch: Partial<ChatHeroData>) => {
        setHeroData(updateChatHeroData(session.id, patch));
    };

    const handleHeroBackgroundFile = async (file: File | null) => {
        if (!file) return;
        try {
            const { saveChatImageToIndexedDB } = await import("@/lib/chat-asset-storage");
            const id = await saveChatImageToIndexedDB(file);
            patchHeroData({ backgroundImageId: id });
        } catch (err) {
            console.error("[ChatSettingsPanel] hero background save failed", err);
            alert("图片保存失败，请重试");
        }
    };

    const openSignatureEditor = () => {
        setSignatureDraft(heroData.signature);
        setEditingSignature(true);
    };
    const commitSignature = () => {
        patchHeroData({ signature: signatureDraft.trim() });
        setEditingSignature(false);
    };

    const adjustDecoration = (key: HeroDecorationKey, delta: number) => {
        const next: HeroDecorationCounts = { ...heroData.decorations };
        next[key] = Math.min(99, Math.max(0, next[key] + delta));
        patchHeroData({ decorations: next });
    };

    const [showConfirmClear, setShowConfirmClear] = useState(false);
    const [showConfirmClearOffline, setShowConfirmClearOffline] = useState(false);
    const [showConfirmClearTools, setShowConfirmClearTools] = useState(false);
    const [showConfirmDelete, setShowConfirmDelete] = useState(false);
    const [editingAlias, setEditingAlias] = useState(false);
    const [editingBilingualPrompt, setEditingBilingualPrompt] = useState(false);
    const [editingCSS, setEditingCSS] = useState(false);
    const [showSearch, setShowSearch] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [submittedSearchQuery, setSubmittedSearchQuery] = useState("");
    const [searchHistoryMessages, setSearchHistoryMessages] = useState<ChatMessage[]>([]);
    const [searchHasMore, setSearchHasMore] = useState(false);
    const [searchResults, setSearchResults] = useState<ChatMessage[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const searchRunRef = useRef(0);

    const loadSearchHistoryWindow = (count = CHAT_INITIAL_VISIBLE_MESSAGE_COUNT) => {
        const visibleMessages = loadChatMessages(session.id).filter(isSearchVisibleMessage);
        const nextCount = Math.min(Math.max(count, CHAT_INITIAL_VISIBLE_MESSAGE_COUNT), visibleMessages.length);
        setSearchHistoryMessages(visibleMessages.slice(-nextCount).reverse());
        setSearchHasMore(nextCount < visibleMessages.length);
    };

    const openSearchPanel = () => {
        searchRunRef.current += 1;
        setSearchQuery("");
        setSubmittedSearchQuery("");
        setSearchResults([]);
        setIsSearching(false);
        loadSearchHistoryWindow();
        setShowSearch(true);
    };

    const closeSearchPanel = () => {
        searchRunRef.current += 1;
        setShowSearch(false);
        setSearchQuery("");
        setSubmittedSearchQuery("");
        setSearchResults([]);
        setSearchHistoryMessages([]);
        setSearchHasMore(false);
        setIsSearching(false);
    };

    const loadMoreSearchHistory = () => {
        const visibleMessages = loadChatMessages(session.id).filter(isSearchVisibleMessage);
        const nextCount = Math.min(searchHistoryMessages.length + CHAT_LOAD_MORE_MESSAGE_COUNT, visibleMessages.length);
        setSearchHistoryMessages(visibleMessages.slice(-nextCount).reverse());
        setSearchHasMore(nextCount < visibleMessages.length);
    };

    const runSearch = () => {
        const rawQuery = searchQuery.trim();
        const runId = searchRunRef.current + 1;
        searchRunRef.current = runId;
        setSubmittedSearchQuery(rawQuery);

        if (!rawQuery) {
            setSearchResults([]);
            setIsSearching(false);
            loadSearchHistoryWindow();
            return;
        }

        const needle = rawQuery.toLowerCase();
        const results: ChatMessage[] = [];
        setSearchResults([]);
        setIsSearching(true);

        window.setTimeout(() => {
            if (searchRunRef.current !== runId) return;
            const msgs = loadChatMessages(session.id);
            let index = msgs.length - 1;

            const scanChunk = () => {
                if (searchRunRef.current !== runId) return;

                const stop = Math.max(-1, index - SEARCH_SCAN_CHUNK_SIZE);
                for (; index > stop && results.length < SEARCH_RESULT_LIMIT; index -= 1) {
                    const msg = msgs[index];
                    if (!isSearchVisibleMessage(msg)) continue;
                    const haystack = getSearchHaystack(msg);
                    if (haystack && haystack.toLowerCase().includes(needle)) results.push(msg);
                }

                if (results.length >= SEARCH_RESULT_LIMIT || index < 0) {
                    setSearchResults([...results]);
                    setIsSearching(false);
                    return;
                }

                window.setTimeout(scanChunk, 0);
            };

            scanChunk();
        }, 0);
    };

    const [groupName, setGroupName] = useState(session.groupName || "");
    const [groupAvatar, setGroupAvatar] = useState(session.groupAvatar || "");
    const groupAvatarInputRef = useRef<HTMLInputElement | null>(null);
    const [showDissolveGroupConfirm, setShowDissolveGroupConfirm] = useState(false);

    const handleGroupAvatarFile = async (file: File | null) => {
        if (!file) return;
        try {
            const dataUrl = await fileToDataUrl(file);
            setGroupAvatar(dataUrl);
            updateSession({ groupAvatar: dataUrl });
        } catch (err) {
            console.error("[ChatSettingsPanel] group avatar processing failed", err);
        }
    };

    const characters = loadCharacters();
    const character = characters.find(c => c.id === session.contactId);

    const characterName = session.isGroup
        ? (groupName || session.groupName || "群聊")
        : (alias || character?.name || `User_${session.contactId.slice(-4)}`);

    // Group members
    const groupChars = session.isGroup
        ? (session.participantIds || []).map(id => characters.find(c => c.id === id)).filter(Boolean)
        : [];
    const userIdentity = resolveUserIdentity(undefined, session.isGroup ? "group_chat" : "chat");

    // ── Group member management ──
    const [, setRosterVersion] = useState(0); // bump to re-render after admin actions
    const [memberActionKey, setMemberActionKey] = useState<string | null>(null);
    const [mutePickerKey, setMutePickerKey] = useState<string | null>(null);
    const [titleEditKey, setTitleEditKey] = useState<string | null>(null);
    const [titleDraft, setTitleDraft] = useState("");
    const [titleColorDraft, setTitleColorDraft] = useState("");
    const [titleColorPalette, setTitleColorPalette] = useState<string[]>([]);
    const [showInvitePicker, setShowInvitePicker] = useState(false);
    const [allowAdminOnUser, setAllowAdminOnUser] = useState(session.allowAdminActionsOnUser === true);
    if (session.isGroup) pruneExpiredGroupMutes(session);
    const userName = userIdentity?.name || "用户";
    const ownerKey = session.isGroup ? getGroupOwnerKey(session) : "";
    const roleLabel = (key: string): string => getGroupBadgeText(session, key);
    type MemberEntry = { key: string; name: string; avatar?: string; muteMs: number };
    const memberEntries: MemberEntry[] = session.isGroup
        ? [
            ...(session.isSpectator ? [] : [{
                key: GROUP_SELF_KEY,
                name: `${userName}（我）`,
                avatar: userIdentity?.avatarUrl || undefined,
                muteMs: getGroupMuteRemainingMs(session, GROUP_SELF_KEY),
            }]),
            ...groupChars.map(c => ({
                key: c!.id,
                name: c!.name,
                avatar: c!.avatar || undefined,
                muteMs: getGroupMuteRemainingMs(session, c!.id),
            })),
        ]
        : [];
    const memberActionsFor = (key: string): { action: GroupAdminAction; label: string; danger?: boolean }[] => {
        if (!session.isGroup || session.isSpectator) return [];
        const items: { action: GroupAdminAction; label: string; danger?: boolean }[] = [];
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "set_admin", key)) items.push({ action: "set_admin", label: "设为管理员" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "unset_admin", key)) items.push({ action: "unset_admin", label: "取消管理员" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "transfer_owner", key)) items.push({ action: "transfer_owner", label: "转让群主" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "mute", key)) items.push({ action: "mute", label: "禁言" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "unmute", key)) items.push({ action: "unmute", label: "解除禁言" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "kick", key)) items.push({ action: "kick", label: "移出群聊", danger: true });
        return items;
    };
    const pushAdminNotice = (action: GroupAdminAction, actorName: string, targetKey: string, muteMinutes?: number) => {
        const targetName = getGroupMemberDisplayName(targetKey, userName);
        // role 用 user（操作人是用户本人）：与 AI 侧 assistant 动作消息对称，
        // UI 仍按系统通知渲染，进历史时还原为 [A将B移出了群聊] 协议格式
        pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: buildGroupAdminNoticeText(action, actorName, targetName, muteMinutes),
            mediaType: "group_admin_notice",
            mediaData: {
                adminAction: action,
                adminActorName: actorName,
                adminTargetName: targetName,
                ...(action === "mute" ? { adminMuteMinutes: muteMinutes || 10 } : {}),
            },
        });
    };
    const performAdminAction = (action: GroupAdminAction, targetKey: string, muteMinutes?: number) => {
        if (!canGroupAdminAct(session, GROUP_SELF_KEY, action, targetKey)) return;
        applyGroupAdminAction(session, action, GROUP_SELF_KEY, targetKey, muteMinutes);
        pushAdminNotice(action, userName, targetKey, muteMinutes);
        setMemberActionKey(null);
        setMutePickerKey(null);
        setShowInvitePicker(false);
        setRosterVersion(v => v + 1);
    };
    const openTitleEditor = (key: string) => {
        setTitleDraft(getGroupTitle(session, key));
        setTitleColorDraft(getGroupTitleColor(session, key));
        setTitleColorPalette(loadGroupTitleColorPalette());
        setTitleEditKey(key);
        setMemberActionKey(null);
    };
    const saveTitleEditor = () => {
        if (!titleEditKey) return;
        setGroupTitle(session, titleEditKey, titleDraft);
        setGroupTitleColor(session, titleEditKey, titleColorDraft);
        setTitleEditKey(null);
        setRosterVersion(v => v + 1);
    };
    // 上帝按钮：不走权限矩阵，防止用户把自己锁死
    const reclaimOwnership = () => {
        const updates: Partial<ChatSession> = { groupOwnerId: GROUP_SELF_KEY };
        const sessions = loadChatSessions();
        const idx = sessions.findIndex(s => s.id === session.id);
        if (idx !== -1) {
            sessions[idx] = { ...sessions[idx], ...updates };
            saveChatSessions(sessions);
        }
        Object.assign(session, updates);
        pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: `${userName}收回了群主身份`,
            mediaType: "group_admin_notice",
            mediaData: { adminAction: "transfer_owner", adminActorName: userName, adminTargetName: userName },
        });
        setRosterVersion(v => v + 1);
    };
    const inviteCandidates = session.isGroup
        ? loadChatContacts()
            .map(c => characters.find(ch => ch.id === c.characterId))
            .filter((c): c is NonNullable<typeof c> => Boolean(c && !(session.participantIds || []).includes(c.id)))
        : [];
    const canInvite = session.isGroup && !session.isSpectator
        && getGroupRole(session, GROUP_SELF_KEY) !== "member";
    const MUTE_DURATION_OPTIONS = [10, 60, 720, 1440, 4320];

    const updateSession = (updates: Partial<ChatSession>) => {
        const sessions = loadChatSessions();
        const sessIdx = sessions.findIndex(s => s.id === session.id);
        if (sessIdx !== -1) {
            sessions[sessIdx] = { ...sessions[sessIdx], ...updates };
            saveChatSessions(sessions);
        } else {
            // Session not found in the persisted store yet — this can happen if
            // chat-storage hasn't finished hydrating from IndexedDB (or this is a
            // brand-new session). Silently no-op-ing here used to drop the update
            // entirely: the UI (local React state) would still show the change as
            // applied, but it never actually persisted, so it reverted to default
            // the next time the session was loaded fresh (e.g. after leaving the
            // chat room). Upsert instead so the change always survives.
            console.warn("[ChatSettingsPanel] updateSession: session not found in store, appending", session.id, updates);
            saveChatSessions([...sessions, { ...session, ...updates }]);
        }
        Object.assign(session, updates);
    };

    const handleClearHistory = () => {
        clearChatSessionMessages(session.id);
        setShowConfirmClear(false);
    };

    const handleClearOfflineHistory = () => {
        if (offlineHistoryBusy) return;
        clearChatOfflineTurns(session.id);
        onOfflineHistoryCleared?.();
        setShowConfirmClearOffline(false);
    };

    const handleClearToolHistory = () => {
        clearChatSessionToolHistory(session.id);
        onToolHistoryCleared?.();
        setShowConfirmClearTools(false);
    };

    const updateVisionImagePromptLimit = (value: unknown) => {
        const next = normalizeVisionImagePromptLimit(value);
        setVisionImagePromptLimit(next);
        updateSession({ visionImagePromptLimit: next });
    };

    const openBilingualPromptEditor = () => {
        setBilingualPromptDraft(bilingualTranslationPrompt || defaultBilingualPrompt);
        setOfflineBilingualPromptDraft(offlineBilingualTranslationPrompt || defaultOfflineBilingualPrompt);
        setEditingBilingualPrompt(true);
    };

    const saveBilingualPromptDraft = () => {
        setBilingualTranslationPrompt(bilingualPromptDraft);
        setOfflineBilingualTranslationPrompt(offlineBilingualPromptDraft);
        updateSession({
            bilingualTranslationPrompt: bilingualPromptDraft,
            offlineBilingualTranslationPrompt: offlineBilingualPromptDraft,
        });
        setEditingBilingualPrompt(false);
    };

    const handleImageUpload = async (
        e: React.ChangeEvent<HTMLInputElement>,
        setter: React.Dispatch<React.SetStateAction<string>>,
        key: keyof ChatSession
    ) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const { saveChatImageToIndexedDB } = await import("@/lib/chat-asset-storage");
            const id = await saveChatImageToIndexedDB(file);
            setter(id);
            updateSession({ [key]: id });
        } catch (error) {
            console.error("Failed to save image", error);
            alert("图片保存失败，请重试");
        }
    };

    // Group video: per-participant background upload
    const [groupVideoBgs, setGroupVideoBgs] = useState<Record<string, string>>(session.groupVideoBackgrounds || {});
    const handleGroupVideoBgUpload = async (e: React.ChangeEvent<HTMLInputElement>, participantKey: string) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const { saveChatImageToIndexedDB } = await import("@/lib/chat-asset-storage");
            const id = await saveChatImageToIndexedDB(file);
            const updated = { ...groupVideoBgs, [participantKey]: id };
            setGroupVideoBgs(updated);
            updateSession({ groupVideoBackgrounds: updated });
        } catch {
            alert("图片保存失败，请重试");
        }
    };

    const jumpToSearchMessage = (messageId: string) => {
        if (onJumpToMessage) {
            onJumpToMessage(messageId);
        }
        closeSearchPanel();
        onClose();
    };

    const renderSearchMessage = (msg: ChatMessage) => {
        const resultRole = getSearchResultRole(msg);
        const senderChar = session.isGroup && msg.senderCharacterId
            ? characters.find(c => c.id === msg.senderCharacterId) || character
            : character;
        const senderName = msg.role === "user"
            ? "我"
            : (session.isGroup ? (msg.senderName || senderChar?.name || characterName) : characterName);
        const isSystemMessage = resultRole === "system";
        const isStandaloneHtmlPreview = !msg.mediaType && isStandaloneHtmlPreviewContent(msg.content);
        const isMediaBubble = (msg.mediaType && SEARCH_MEDIA_BUBBLE_TYPES.has(msg.mediaType)) || isStandaloneHtmlPreview;
        const bubbleRole = msg.role === "user" ? "user" : "assistant";

        return (
            <div key={msg.id} className="flex flex-col gap-2">
                <div className="flex justify-center">
                    <span className="chat-sys-msg py-[2px] px-2 rounded select-none">
                        {new Date(msg.createdAt).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                </div>
                {isSystemMessage ? (
                    <div className="chat-msg-wrapper" data-role="system">
                        <div
                            role="button"
                            tabIndex={0}
                            className="chat-sys-msg relative cursor-pointer"
                            onClick={() => jumpToSearchMessage(msg.id)}
                            onKeyDown={e => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    jumpToSearchMessage(msg.id);
                                }
                            }}
                        >
                            {msg.mediaType === "poke"
                                ? <MessageBubble msg={msg} charName={senderChar?.name} userName={userIdentity?.name || "你"} characterId={msg.senderCharacterId || session.contactId} />
                                : getSearchResultText(msg)}
                        </div>
                    </div>
                ) : (
                    <div className="chat-msg-wrapper" data-role={resultRole}>
                        {resultRole === "assistant" && (
                            <div className="chat-msg-avatar w-[40px] h-[40px] rounded-[20px] bg-[var(--c-page-body-bg)] shrink-0 flex items-center justify-center overflow-hidden">
                                {senderChar?.avatar ? (
                                    <img src={senderChar.avatar} className="w-full h-full object-cover" alt="" />
                                ) : (
                                    <ChatFallbackAvatar />
                                )}
                            </div>
                        )}
                        <div className={`chat-msg-content-wrap flex flex-col min-w-0 max-w-[70%] ${isStandaloneHtmlPreview ? "chat-msg-content-wrap-html" : ""}`}>
                            {session.isGroup && msg.role !== "user" && (
                                <span className="chat-group-sender-name">
                                    {senderName}
                                    {msg.senderCharacterId && (session.participantIds || []).includes(msg.senderCharacterId) && (
                                        <span className="chat-role-badge" style={{ background: getGroupTitleColor(session, msg.senderCharacterId) }}>
                                            {getGroupBadgeText(session, msg.senderCharacterId)}
                                        </span>
                                    )}
                                </span>
                            )}
                            <div
                                role="button"
                                tabIndex={0}
                                onClick={() => jumpToSearchMessage(msg.id)}
                                onKeyDown={e => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        jumpToSearchMessage(msg.id);
                                    }
                                }}
                                className={`chat-bubble-role-${bubbleRole} ${isMediaBubble ? "chat-bubble-media" : ""} ${isStandaloneHtmlPreview ? "chat-bubble-html-preview" : ""} ${msg.mediaType === "music_share" ? "chat-bubble-music-share" : ""} ${msg.mediaType === "gift" || msg.mediaType === "image" || isStandaloneHtmlPreview ? "rounded-none" : "rounded-md"} break-words relative cursor-pointer select-none`}
                                data-ui={bubbleRole === "user" ? "bubble-user" : "bubble-bot"}
                                data-msg-id={msg.id}
                            >
                                <MessageBubble
                                    msg={msg}
                                    charName={senderChar?.name}
                                    userName={userIdentity?.name || "你"}
                                    groupSize={session.isGroup ? (session.participantIds?.length || 0) + (session.isSpectator ? 0 : 1) : undefined}
                                    characterId={msg.senderCharacterId || session.contactId}
                                    defaultTranslationExpanded={session.collapseBilingualTranslation !== false ? false : true}
                                />
                            </div>
                        </div>
                        {resultRole === "user" && (
                            <div className="chat-msg-avatar w-[40px] h-[40px] rounded-[20px] bg-[var(--c-page-body-bg)] shrink-0 flex items-center justify-center overflow-hidden">
                                {userIdentity?.avatarUrl ? (
                                    <img src={userIdentity.avatarUrl} alt="Me" className="w-full h-full object-cover rounded-[20px]" />
                                ) : (
                                    <ChatFallbackAvatar />
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const searchMode = submittedSearchQuery.trim().length > 0;
    const displayedSearchMessages = searchMode ? searchResults : searchHistoryMessages;

    // Hero 展示名：角色名（备注在括号内）
    const heroBaseName = session.isGroup
        ? (groupName || session.groupName || "群聊")
        : (character?.name || `User_${session.contactId.slice(-4)}`);
    const heroNote = session.isGroup ? "" : (alias || "");
    const heroDisplayName = heroNote ? `${heroBaseName}（${heroNote}）` : heroBaseName;
    const heroAvatarSrc = session.isGroup ? (groupAvatar || undefined) : (character?.avatar || undefined);
    const activeDecorations = HERO_DECORATION_META.filter(m => heroData.decorations[m.key] > 0);
    const activeCategoryMeta = SETTINGS_CATEGORY_META.find(c => c.key === activeCategory) || null;
    const visibleCategories = SETTINGS_CATEGORY_META.filter(c => !c.groupOnly || session.isGroup);

    return (
        <PageShell title="聊天设置" onBack={onClose} className="chat-settings-page absolute inset-0 z-[100]">
            <div className="chat-hero-page">
                {/* ── Hero 卡片（固定不动）── */}
                <div className="chat-hero-card">
                    <button
                        type="button"
                        className={`chat-hero-bg${heroBgResolved ? " chat-hero-bg--set" : ""}`}
                        style={heroBgResolved ? { backgroundImage: `url(${heroBgResolved})` } : undefined}
                        onClick={() => heroBgInputRef.current?.click()}
                        aria-label="设置聊天背景图"
                    >
                        <input
                            ref={heroBgInputRef}
                            type="file"
                            accept="image/*"
                            style={{ display: "none" }}
                            onChange={e => {
                                const file = e.currentTarget.files?.[0] ?? null;
                                e.currentTarget.value = "";
                                void handleHeroBackgroundFile(file);
                            }}
                        />
                    </button>
                    <div className="chat-hero-body">
                        <div className="chat-hero-avatar">
                            {heroAvatarSrc ? <img src={heroAvatarSrc} alt="" /> : <ChatFallbackAvatar />}
                        </div>
                        <div className="chat-hero-info">
                            <div className="chat-hero-name-row">
                                <div className="chat-hero-name">{heroDisplayName}</div>
                                <button
                                    type="button"
                                    className="chat-hero-bg-reset-inline"
                                    aria-label="恢复默认背景"
                                    disabled={!heroBgResolved}
                                    onClick={() => patchHeroData({ backgroundImageId: "" })}
                                >
                                    <SquareArrowOutUpRight size={20} strokeWidth={1.75} />
                                </button>
                                <span className="chat-hero-qr" aria-hidden="true">
                                    <QrCode size={20} strokeWidth={1.75} />
                                </span>
                            </div>
                            {editingSignature ? (
                                <input
                                    autoFocus
                                    type="text"
                                    className="chat-hero-signature-input"
                                    value={signatureDraft}
                                    maxLength={60}
                                    onChange={e => setSignatureDraft(e.target.value)}
                                    onBlur={commitSignature}
                                    onKeyDown={e => {
                                        if (e.key === "Enter") { e.preventDefault(); commitSignature(); }
                                        if (e.key === "Escape") setEditingSignature(false);
                                    }}
                                />
                            ) : (
                                <button
                                    type="button"
                                    className={`chat-hero-signature${heroData.signature ? "" : " chat-hero-signature--empty"}`}
                                    onClick={openSignatureEditor}
                                >
                                    {heroData.signature || "点击填写个性签名"}
                                </button>
                            )}
                            {activeDecorations.length > 0 && (
                                <button
                                    type="button"
                                    className="chat-hero-decorations"
                                    aria-label="编辑装饰图标"
                                >
                                    {activeDecorations.map(meta => (
                                        <span key={meta.key} className="chat-hero-decoration">
                                            {Array.from({ length: heroData.decorations[meta.key] }).map((_, i) => (
                                                <meta.icon key={i} size={15} strokeWidth={1.75} />
                                            ))}
                                        </span>
                                    ))}
                                </button>
                            )}
                            {activeDecorations.length === 0 && (
                                <button
                                    type="button"
                                    className="chat-hero-decorations chat-hero-decorations--empty"
                                    aria-label="编辑装饰图标"
                                />
                            )}
                        </div>
                    </div>
                </div>

                {/* ── 统计卡片：累计聊天天数 / 消息条数 ── */}
                <div className="chat-stats-card">
                    <div className="chat-stats-row">
                        <CalendarDays className="chat-stats-icon" size={22} strokeWidth={1.75} />
                        <span className="chat-stats-label">与TA已累计聊</span>
                        <span className="chat-stats-value"><span className="chat-stats-number">{chatStats.daysTogether}</span> 天</span>
                    </div>
                    <div className="chat-stats-divider" />
                    <div className="chat-stats-row">
                        <WalletCards className="chat-stats-icon" size={22} strokeWidth={1.75} />
                        <span className="chat-stats-label">与TA已聊</span>
                        <span className="chat-stats-value"><span className="chat-stats-number">{chatStats.messageCount}</span> 条消息</span>
                    </div>
                </div>

                {/* ── 下方内容区：概览 ⇄ 详情 ── */}
                {activeCategory === null ? (
                    <div className="chat-settings-overview">
                        {visibleCategories.map(cat => (
                            <button
                                key={cat.key}
                                type="button"
                                className="chat-overview-item"
                                onClick={() => setActiveCategory(cat.key)}
                            >
                                <cat.icon className="chat-overview-icon" size={22} strokeWidth={1.75} />
                                <span className="chat-overview-label">{cat.label}</span>
                                <ChevronRight className="chat-overview-chevron" size={18} />
                            </button>
                        ))}
                    </div>
                ) : (
                    <div className="chat-settings-detail">
                        <div className="chat-detail-card">
                        <div className="chat-detail-header">
                            <button
                                type="button"
                                className="chat-detail-back"
                                onClick={() => setActiveCategory(null)}
                                aria-label="返回概览"
                            >
                                <ChevronLeft size={20} strokeWidth={2} />
                            </button>
                            <span className="chat-detail-title">{activeCategoryMeta?.label}</span>
                        </div>
                        <div className="page-menu chat-info-menu chat-detail-body">
                {/* ===== 基础信息 ===== */}
                {activeCategory === "basic" && (<>
                <div className="menu-group">
                    {session.isGroup && (
                        <div className="menu-item" style={{ cursor: "default" }}>
                            <ChatInfoIcon icon={Users} color={CONTENT_APP_ACCENTS.chat} />
                            <div className="menu-label-group"><span className="menu-label">群头像</span></div>
                            <div className="menu-right">
                                <input
                                    ref={groupAvatarInputRef}
                                    type="file"
                                    accept="image/png,image/jpeg,image/webp"
                                    style={{ display: "none" }}
                                    onChange={e => {
                                        const file = e.currentTarget.files?.[0] ?? null;
                                        e.currentTarget.value = "";
                                        void handleGroupAvatarFile(file);
                                    }}
                                />
                                <AvatarUpload
                                    src={groupAvatar || undefined}
                                    onClick={() => groupAvatarInputRef.current?.click()}
                                    className="w-[18px] h-[18px] rounded-full"
                                />
                            </div>
                        </div>
                    )}
                    <button className="menu-item" onClick={() => setEditingAlias(true)}>
                        <ChatInfoIcon icon={MessageSquare} color={CONTENT_APP_ACCENTS.chat} />
                        <div className="menu-label-group"><span className="menu-label">{session.isGroup ? "群聊名称" : "设置备注"}</span></div>
                        <div className="menu-right">
                            <span className="menu-desc mr-1">{session.isGroup ? (groupName || "未设置") : (alias || "无备注")}</span>
                            <ChevronRight size={16} />
                        </div>
                    </button>
                    <div className="menu-item">
                        <ChatInfoIcon icon={Pin} color={BINDING_ACCENTS.preset} />
                        <div className="menu-label-group"><span className="menu-label">置顶聊天</span></div>
                        <div className="menu-right">
                            <Toggle checked={isPinned} onChange={c => { setIsPinned(c); updateSession({ isPinned: c }); }} />
                        </div>
                    </div>
                    <button className="menu-item" onClick={openSearchPanel}>
                        <ChatInfoIcon icon={Search} color={BINDING_ACCENTS.api} />
                        <div className="menu-label-group"><span className="menu-label">查找聊天记录</span></div>
                        <div className="menu-right"><ChevronRight size={16} /></div>
                    </button>
                </div>
                </>)}

                {/* ===== 管理（仅群聊）===== */}
                {activeCategory === "manage" && session.isGroup && (
                    <div className="menu-group">
                        <div className="menu-item" style={{ cursor: "default" }}>
                            <ChatInfoIcon icon={Users} color={BINDING_ACCENTS.preset} />
                            <div className="menu-label-group">
                                <span className="menu-label">群成员管理</span>
                                <span className="menu-desc">
                                    {session.isSpectator
                                        ? "围观群：你不在群内，身份只读"
                                        : (getGroupRole(session, GROUP_SELF_KEY) === "member"
                                            ? "你是普通成员，没有管理权限"
                                            : "点击成员执行管理操作")}
                                </span>
                            </div>
                        </div>
                        {memberEntries.map(entry => {
                            const badge = roleLabel(entry.key);
                            const badgeColor = getGroupTitleColor(session, entry.key);
                            const actionable = memberActionsFor(entry.key).length > 0
                                || canSetGroupTitle(session, GROUP_SELF_KEY, entry.key);
                            return (
                                <button
                                    key={entry.key}
                                    className="menu-item"
                                    style={{ paddingLeft: 16, ...(actionable ? {} : { cursor: "default" }) }}
                                    onClick={() => { if (actionable) setMemberActionKey(entry.key); }}
                                >
                                    <div className="w-[32px] h-[32px] rounded-full overflow-hidden bg-[var(--c-input)] shrink-0 flex items-center justify-center">
                                        {entry.avatar ? <img src={entry.avatar} className="w-full h-full object-cover" alt="" /> : <ChatFallbackAvatar />}
                                    </div>
                                    <div className="menu-label-group">
                                        <span className="menu-label">{entry.name}</span>
                                        {entry.muteMs > 0 && (
                                            <span className="menu-desc">禁言中 · 剩余{formatMuteRemainingLabel(entry.muteMs)}</span>
                                        )}
                                    </div>
                                    <div className="menu-right">
                                        {badge && <span className="chat-role-badge mr-1" style={{ background: badgeColor }}>{badge}</span>}
                                        {actionable && <ChevronRight size={14} />}
                                    </div>
                                </button>
                            );
                        })}
                        {canInvite && (
                            <button className="menu-item" onClick={() => setShowInvitePicker(true)}>
                                <ChatInfoIcon icon={UserPlus} color={BINDING_ACCENTS.voice} />
                                <div className="menu-label-group"><span className="menu-label">拉人进群</span></div>
                                <div className="menu-right"><ChevronRight size={16} /></div>
                            </button>
                        )}
                        {!session.isSpectator && (
                            <div className="menu-item">
                                <ChatInfoIcon icon={AlertCircle} color={BINDING_ACCENTS.memory} />
                                <div className="menu-label-group">
                                    <span className="menu-label">允许角色对我使用管理操作</span>
                                    <span className="menu-desc">开启后群主/管理员角色可以禁言你（不能踢你）</span>
                                </div>
                                <div className="menu-right">
                                    <Toggle
                                        checked={allowAdminOnUser}
                                        onChange={c => { setAllowAdminOnUser(c); updateSession({ allowAdminActionsOnUser: c }); }}
                                    />
                                </div>
                            </div>
                        )}
                        {!session.isSpectator && ownerKey !== GROUP_SELF_KEY && (
                            <button className="menu-item" onClick={reclaimOwnership}>
                                <ChatInfoIcon icon={Users} color="var(--c-danger)" />
                                <div className="menu-label-group">
                                    <span className="menu-label menu-label-danger">收回群主身份</span>
                                    <span className="menu-desc">上帝操作：无视群规则直接拿回群主</span>
                                </div>
                            </button>
                        )}
                    </div>
                )}

                {/* ===== 功能 ===== */}
                {activeCategory === "function" && (
                <div className="menu-group">
                    <div className="menu-item menu-item-vision-limit">
                        <ChatInfoIcon icon={ImageIcon} color={BINDING_ACCENTS.api} />
                        <div className="menu-label-group">
                            <span className="menu-label">传入最近图片数</span>
                            <span className="menu-desc">进入模型视觉上下文的最近图片数量，0 表示不传图片内容</span>
                        </div>
                        <div className="menu-right gap-2 menu-right-vision-limit">
                            <button
                                type="button"
                                className="ui-btn ui-btn-ghost h-8 w-8 p-0"
                                onClick={() => updateVisionImagePromptLimit(visionImagePromptLimit - 1)}
                                disabled={visionImagePromptLimit <= 0}
                            >
                                -
                            </button>
                            <input
                                type="number"
                                min={0}
                                max={MAX_VISION_IMAGE_PROMPT_LIMIT}
                                value={visionImagePromptLimit}
                                onChange={e => updateVisionImagePromptLimit(e.target.value)}
                                className="ui-input h-8 w-14 text-center"
                            />
                            <button
                                type="button"
                                className="ui-btn ui-btn-ghost h-8 w-8 p-0"
                                onClick={() => updateVisionImagePromptLimit(visionImagePromptLimit + 1)}
                                disabled={visionImagePromptLimit >= MAX_VISION_IMAGE_PROMPT_LIMIT}
                            >
                                +
                            </button>
                        </div>
                    </div>
                    <div className="menu-item">
                        <div className="menu-label-group">
                            <span className="menu-label">时区/地区</span>
                            <span className="menu-desc">影响角色对当前时间的感知，留空默认北京时间</span>
                        </div>
                        <div className="menu-right">
                            <input
                                type="text"
                                value={timeZone}
                                onChange={e => setTimeZone(e.target.value)}
                                onBlur={() => updateSession({ timeZone: timeZone.trim() || undefined })}
                                placeholder="Asia/Shanghai"
                                className="ui-input h-8 text-right"
                                style={{ width: 140, flexShrink: 0 }}
                            />
                        </div>
                    </div>
                    <>
                        <div className="menu-item">
                            <ChatInfoIcon icon={MessageSquare} color={CONTENT_APP_ACCENTS.chat} />
                            <div className="menu-label-group">
                                <span className="menu-label">双语翻译</span>
                                <span className="menu-desc">{session.isGroup ? "外语发言自动附中文译文" : "外语回复自动附中文译文"}</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={bilingualTranslationEnabled}
                                    onChange={c => {
                                        setBilingualTranslationEnabled(c);
                                        updateSession({ bilingualTranslationEnabled: c });
                                    }}
                                />
                            </div>
                        </div>
                        {bilingualTranslationEnabled && (
                            <>
                                <div className="menu-item">
                                    <ChatInfoIcon icon={MessageSquare} color={BINDING_ACCENTS.voice} />
                                    <div className="menu-label-group">
                                        <span className="menu-label">折叠中文译文</span>
                                        <span className="menu-desc">关闭后默认直接展开中文</span>
                                    </div>
                                    <div className="menu-right">
                                        <Toggle
                                            checked={collapseBilingualTranslation}
                                            onChange={c => {
                                                setCollapseBilingualTranslation(c);
                                                updateSession({ collapseBilingualTranslation: c });
                                            }}
                                        />
                                    </div>
                                </div>
                                <button className="menu-item" onClick={openBilingualPromptEditor}>
                                    <ChatInfoIcon icon={MessageSquare} color={BINDING_ACCENTS.memory} />
                                    <div className="menu-label-group">
                                        <span className="menu-label">双语提示词</span>
                                    </div>
                                    <div className="menu-right">
                                        <span className="menu-desc mr-1">
                                            {bilingualTranslationPrompt === defaultBilingualPrompt && offlineBilingualTranslationPrompt === defaultOfflineBilingualPrompt ? "默认" : "已自定义"}
                                        </span>
                                        <ChevronRight size={16} />
                                    </div>
                                </button>
                            </>
                        )}
                        {!session.isGroup && (
                            <div className="menu-item">
                                <ChatInfoIcon icon={Code} color={BINDING_ACCENTS.api} />
                                <div className="menu-label-group">
                                    <span className="menu-label">HTML开关</span>
                                    <span className="menu-desc">开启后允许使用HTML渲染</span>
                                </div>
                                <div className="menu-right">
                                    <Toggle
                                        checked={htmlGenerationEnabled}
                                        onChange={c => {
                                            setHtmlGenerationEnabled(c);
                                            updateSession({ htmlGenerationEnabled: c });
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </>
                </div>
                )}

                {/* ===== 外观 ===== */}
                {activeCategory === "appearance" && (
                <div className="menu-group">
                    <div className="menu-item">
                        <div className="menu-label-group">
                            <span className="menu-label">时间戳显示秒</span>
                            <span className="menu-desc">消息气泡时间精确到秒</span>
                        </div>
                        <div className="menu-right">
                            <Toggle
                                checked={timestampShowSeconds}
                                onChange={c => {
                                    setTimestampShowSeconds(c);
                                    updateSession({ timestampShowSeconds: c });
                                }}
                            />
                        </div>
                    </div>
                    <label className="menu-item">
                        <ChatInfoIcon icon={ImageIcon} color={BINDING_ACCENTS.api} />
                        <div className="menu-label-group"><span className="menu-label">聊天背景</span></div>
                        <div className="menu-right">
                            {backgroundImage && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); setBackgroundImage(""); updateSession({ backgroundImage: "" }); }}>清除</button></>}
                            <ChevronRight size={16} />
                        </div>
                        <input type="file" accept="image/*" onChange={e => handleImageUpload(e, setBackgroundImage, "backgroundImage")} className="hidden" />
                    </label>
                    {session.isGroup ? (
                        <>
                            <div className="menu-item" style={{ cursor: "default" }}>
                                <ChatInfoIcon icon={Video} color={BINDING_ACCENTS.voice} />
                                <div className="menu-label-group"><span className="menu-label">视频通话背景</span></div>
                            </div>
                            {groupChars.map(c => c && (
                                <label key={c.id} className="menu-item" style={{ paddingLeft: 72 }}>
                                    <div className="w-[24px] h-[24px] rounded-full overflow-hidden bg-[var(--c-input)] shrink-0">
                                        {c.avatar ? <img src={c.avatar} className="w-full h-full object-cover" alt="" /> : <ChatFallbackAvatar />}
                                    </div>
                                    <div className="menu-label-group"><span className="menu-label">{c.name}</span></div>
                                    <div className="menu-right">
                                        {groupVideoBgs[c.id] && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); const updated = { ...groupVideoBgs }; delete updated[c.id]; setGroupVideoBgs(updated); updateSession({ groupVideoBackgrounds: updated }); }}>清除</button></>}
                                        <ChevronRight size={14} />
                                    </div>
                                    <input type="file" accept="image/*" onChange={e => handleGroupVideoBgUpload(e, c.id)} className="hidden" />
                                </label>
                            ))}
                            <label className="menu-item" style={{ paddingLeft: 72 }}>
                                <div className="w-[24px] h-[24px] rounded-full overflow-hidden bg-[var(--c-input)] shrink-0 flex items-center justify-center">
                                    {userIdentity?.avatarUrl ? (
                                        <img src={userIdentity.avatarUrl} className="w-full h-full object-cover" alt="" />
                                    ) : (
                                        <span className="ts-11">{(userIdentity?.name || "我")[0]}</span>
                                    )}
                                </div>
                                <div className="menu-label-group"><span className="menu-label">{userIdentity?.name || "我"}</span></div>
                                <div className="menu-right">
                                    {groupVideoBgs["self"] && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); const updated = { ...groupVideoBgs }; delete updated["self"]; setGroupVideoBgs(updated); updateSession({ groupVideoBackgrounds: updated }); }}>清除</button></>}
                                    <ChevronRight size={14} />
                                </div>
                                <input type="file" accept="image/*" onChange={e => handleGroupVideoBgUpload(e, "self")} className="hidden" />
                            </label>
                        </>
                    ) : (
                        <label className="menu-item">
                            <ChatInfoIcon icon={Video} color={BINDING_ACCENTS.voice} />
                            <div className="menu-label-group"><span className="menu-label">视频通话背景</span></div>
                            <div className="menu-right">
                                {videoBackground && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); setVideoBackground(""); updateSession({ videoBackground: "" }); }}>清除</button></>}
                                <ChevronRight size={16} />
                            </div>
                            <input type="file" accept="image/*" onChange={e => handleImageUpload(e, setVideoBackground, "videoBackground")} className="hidden" />
                        </label>
                    )}
                    <label className="menu-item">
                        <ChatInfoIcon icon={Mic} color={BINDING_ACCENTS.voice} />
                        <div className="menu-label-group"><span className="menu-label">语音通话背景</span></div>
                        <div className="menu-right">
                            {voiceBackground && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); setVoiceBackground(""); updateSession({ voiceBackground: "" }); }}>清除</button></>}
                            <ChevronRight size={16} />
                        </div>
                        <input type="file" accept="image/*" onChange={e => handleImageUpload(e, setVoiceBackground, "voiceBackground")} className="hidden" />
                    </label>
                    <button className="menu-item" onClick={() => setEditingCSS(true)}>
                        <ChatInfoIcon icon={Code} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group"><span className="menu-label">自定义 CSS 样式</span></div>
                        <div className="menu-right">
                            {customCSS && <span className="menu-desc mr-1">已设置</span>}
                            <ChevronRight size={16} />
                        </div>
                    </button>
                </div>
                )}

                {/* ===== 其他 ===== */}
                {activeCategory === "other" && (
                <div className="menu-group">
                    {!session.isGroup && (
                        <div className="menu-item">
                            <ChatInfoIcon icon={UserMinus} color="var(--c-icon)" />
                            <div className="menu-label-group">
                                <span className="menu-label">拉黑</span>
                                <span className="menu-desc">开启后角色只能通过 Message 联系你</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={isBlacklisted}
                                    onChange={checked => {
                                        setIsBlacklisted(checked);
                                        updateSession({ isBlacklisted: checked });
                                        window.dispatchEvent(new CustomEvent("chat-session-blacklist-updated", { detail: { sessionId: session.id, isBlacklisted: checked } }));
                                        if (checked) cancelFollowUp(session.id);
                                    }}
                                />
                            </div>
                        </div>
                    )}
                    <button className="menu-item" onClick={() => setShowConfirmClearTools(true)}>
                        <ChatInfoIcon icon={Code} color="var(--c-danger)" />
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">清理原生tool调用历史——防报错</span>
                            <span className="menu-desc">切换到文本协议 API 前使用</span>
                        </div>
                    </button>
                    <button className="menu-item" onClick={() => setShowConfirmClear(true)}>
                        <ChatInfoIcon icon={Trash2} color="var(--c-danger)" />
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">清空线上聊天记录</span>
                            <span className="menu-desc">不影响线下模式记录</span>
                        </div>
                    </button>
                    <button
                        className="menu-item"
                        disabled={offlineHistoryBusy}
                        onClick={() => {
                            if (!offlineHistoryBusy) setShowConfirmClearOffline(true);
                        }}
                        style={offlineHistoryBusy ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                    >
                        <ChatInfoIcon icon={Trash2} color="var(--c-danger)" />
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">清空线下聊天记录</span>
                            <span className="menu-desc">
                                {offlineHistoryBusy ? "线下回复生成中，完成后再清空" : "同步移除该会话的线下短期记忆事件"}
                            </span>
                        </div>
                    </button>
                    {session.isGroup && (
                        <button className="menu-item" onClick={() => setShowDissolveGroupConfirm(true)}>
                            <ChatInfoIcon icon={Trash2} color="var(--c-danger)" />
                            <div className="menu-label-group">
                                <span className="menu-label menu-label-danger menu-label-dissolve-group">
                                    {!session.isSpectator && ownerKey === GROUP_SELF_KEY ? "解散群聊" : "退出群聊"}
                                </span>
                                <span className="menu-desc">
                                    {!session.isSpectator && ownerKey === GROUP_SELF_KEY
                                        ? "解散后聊天记录将被永久删除，无法恢复"
                                        : "退出后本地聊天记录将被永久删除，无法恢复"}
                                </span>
                            </div>
                        </button>
                    )}
                    {!session.isGroup && (
                    <button className="menu-item" onClick={() => setShowConfirmDelete(true)}>
                        <ChatInfoIcon icon={UserMinus} color="var(--c-danger)" />
                        <div className="menu-label-group"><span className="menu-label menu-label-danger menu-label-delete-friend">删除好友</span></div>
                    </button>
                    )}
                </div>
                )}
                        </div>
                        </div>{/* close chat-detail-card */}
                    </div>
                )}
            </div>

            {/* Modal: Hero 装饰图标编辑 */}
            {showDecorationEditor && (
                <div className="modal-overlay" onClick={() => setShowDecorationEditor(false)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">装饰图标</span>
                        <div className="chat-hero-decoration-editor">
                            {HERO_DECORATION_META.map(meta => (
                                <div key={meta.key} className="chat-hero-decoration-row">
                                    <span className="chat-hero-decoration-row-icon">
                                        <meta.icon size={20} strokeWidth={1.75} />
                                    </span>
                                    <span className="chat-hero-decoration-row-label">{meta.label}</span>
                                    <div className="chat-hero-decoration-stepper">
                                        <button
                                            type="button"
                                            className="ui-btn ui-btn-ghost h-8 w-8 p-0"
                                            onClick={() => adjustDecoration(meta.key, -1)}
                                            disabled={heroData.decorations[meta.key] <= 0}
                                        >
                                            <Minus size={16} />
                                        </button>
                                        <span className="chat-hero-decoration-count">{heroData.decorations[meta.key]}</span>
                                        <button
                                            type="button"
                                            className="ui-btn ui-btn-ghost h-8 w-8 p-0"
                                            onClick={() => adjustDecoration(meta.key, 1)}
                                            disabled={heroData.decorations[meta.key] >= 99}
                                        >
                                            <Plus size={16} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <button className="ui-btn ui-btn-ghost w-full" onClick={() => setShowDecorationEditor(false)}>完成</button>
                    </div>
                </div>
            )}

            {/* Modal: Group member actions */}
            {memberActionKey && (
                <div className="modal-overlay" onClick={() => setMemberActionKey(null)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">
                            {getGroupMemberDisplayName(memberActionKey, userName)}
                            {roleLabel(memberActionKey) ? `（${roleLabel(memberActionKey)}）` : ""}
                        </span>
                        <div className="flex flex-col gap-2 w-full">
                            {canSetGroupTitle(session, GROUP_SELF_KEY, memberActionKey) && (
                                <button
                                    className="ui-btn flex-1 ui-btn-ghost"
                                    onClick={() => openTitleEditor(memberActionKey)}
                                >
                                    设置头衔
                                </button>
                            )}
                            {memberActionsFor(memberActionKey).map(item => (
                                <button
                                    key={item.action}
                                    className={`ui-btn flex-1 ${item.danger ? "ui-btn-danger" : "ui-btn-ghost"}`}
                                    onClick={() => {
                                        if (item.action === "mute") {
                                            setMutePickerKey(memberActionKey);
                                            setMemberActionKey(null);
                                        } else {
                                            performAdminAction(item.action, memberActionKey);
                                        }
                                    }}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                        <button className="ui-btn ui-btn-ghost w-full" onClick={() => setMemberActionKey(null)}>取消</button>
                    </div>
                </div>
            )}

            {/* Modal: Custom group title editor */}
            {titleEditKey && (
                <div className="modal-overlay" onClick={() => setTitleEditKey(null)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">设置头衔 · {getGroupMemberDisplayName(titleEditKey, userName)}</span>
                        <input
                            type="text"
                            className="ui-input w-full"
                            placeholder="最多 8 个字，留空则清除头衔"
                            maxLength={8}
                            value={titleDraft}
                            onChange={e => setTitleDraft(e.target.value)}
                            autoFocus
                        />
                        <div className="chat-title-color-picker w-full">
                            <GroupTitleColorWheel value={titleColorDraft} onChange={setTitleColorDraft} />
                            <div className="chat-title-color-picker-row">
                                <span className="chat-title-color-preview-text" style={{ background: titleColorDraft }}>
                                    {titleDraft || roleLabel(titleEditKey)}
                                </span>
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-ghost chat-title-color-save-btn"
                                    onClick={() => setTitleColorPalette(saveGroupTitleColorToPalette(titleColorDraft))}
                                >
                                    存入调色板
                                </button>
                            </div>
                            {titleColorPalette.length > 0 && (
                                <div className="chat-title-color-swatches">
                                    {titleColorPalette.map(color => (
                                        <button
                                            key={color}
                                            type="button"
                                            className="chat-title-color-swatch"
                                            style={{ background: color }}
                                            aria-label={`使用颜色 ${color}`}
                                            onClick={() => setTitleColorDraft(color)}
                                            {...(titleColorDraft.toLowerCase() === color.toLowerCase() ? { "data-active": "" } : {})}
                                        >
                                            <span
                                                role="button"
                                                aria-label={`删除颜色 ${color}`}
                                                className="chat-title-color-swatch-remove"
                                                onClick={e => {
                                                    e.stopPropagation();
                                                    setTitleColorPalette(removeGroupTitleColorFromPalette(color));
                                                }}
                                            >
                                                ✕
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="flex flex-col gap-2 w-full">
                            <button className="ui-btn ui-btn-primary w-full" onClick={saveTitleEditor}>保存</button>
                            <button className="ui-btn ui-btn-ghost w-full" onClick={() => setTitleEditKey(null)}>取消</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal: Mute duration picker */}
            {mutePickerKey && (
                <div className="modal-overlay" onClick={() => setMutePickerKey(null)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">禁言 {getGroupMemberDisplayName(mutePickerKey, userName)}</span>
                        <div className="flex flex-col gap-2 w-full">
                            {MUTE_DURATION_OPTIONS.map(minutes => (
                                <button
                                    key={minutes}
                                    className="ui-btn ui-btn-ghost flex-1"
                                    onClick={() => performAdminAction("mute", mutePickerKey, minutes)}
                                >
                                    {formatMuteDurationLabel(minutes)}
                                </button>
                            ))}
                        </div>
                        <button className="ui-btn ui-btn-ghost w-full" onClick={() => setMutePickerKey(null)}>取消</button>
                    </div>
                </div>
            )}

            {/* Modal: Invite picker */}
            {showInvitePicker && (
                <div className="modal-overlay" onClick={() => setShowInvitePicker(false)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">拉人进群</span>
                        {inviteCandidates.length === 0 ? (
                            <span className="menu-desc">没有可以拉进群的联系人</span>
                        ) : (
                            <div className="chat-contact-list">
                                {inviteCandidates.map(c => (
                                    <div
                                        key={c.id}
                                        className="chat-contact-item"
                                        onClick={() => performAdminAction("invite", c.id)}
                                    >
                                        <div className="chat-contact-avatar">
                                            {c.avatar ? <img src={c.avatar} alt="" /> : <ChatFallbackAvatar />}
                                        </div>
                                        <span className="chat-contact-name">{c.name}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                        <button className="ui-btn ui-btn-ghost w-full" onClick={() => setShowInvitePicker(false)}>取消</button>
                    </div>
                </div>
            )}

            {/* Modal: Alias / Group Name */}
            {editingAlias && (
                <div className="modal-overlay">
                    <div className="modal-dialog">
                        <div className="ts-17 font-semibold text-center text-[var(--c-text)]">{session.isGroup ? "修改群名" : "修改备注"}</div>
                        <Input
                            type="text"
                            value={session.isGroup ? groupName : alias}
                            onChange={e => session.isGroup ? setGroupName(e.target.value) : setAlias(e.target.value)}
                            placeholder={session.isGroup ? "输入群名" : (character?.name || "输入备注名")}
                        />
                        <div className="flex gap-3 w-full">
                            <button onClick={() => setEditingAlias(false)} className="ui-btn ui-btn-ghost flex-1">取消</button>
                            <button onClick={() => {
                                if (session.isGroup) {
                                    updateSession({ groupName });
                                } else {
                                    updateSession({ alias });
                                }
                                setEditingAlias(false);
                            }} className="ui-btn ui-btn-success flex-1">保存</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal: Bilingual Prompt */}
            {editingBilingualPrompt && (
                <div className="modal-overlay">
                    <div className="modal-dialog chat-bilingual-prompt-dialog">
                        <div className="ts-17 font-semibold text-center text-[var(--c-text)]">双语提示词</div>
                        <div className="chat-bilingual-prompt-stack">
                            <div className="chat-bilingual-prompt-section">
                                <div className="chat-bilingual-prompt-head">
                                    <div>
                                        <div className="chat-bilingual-prompt-title">线上聊天提示词</div>
                                        <div className="chat-bilingual-prompt-desc">即时通讯、富媒体和聊天气泡输出使用。</div>
                                    </div>
                                    <button
                                        type="button"
                                        className="chat-bilingual-prompt-reset"
                                        onClick={() => setBilingualPromptDraft(defaultBilingualPrompt)}
                                    >
                                        默认
                                    </button>
                                </div>
                                <textarea
                                    className="ui-input chat-bilingual-prompt-textarea chat-bilingual-prompt-textarea--split"
                                    value={bilingualPromptDraft}
                                    onChange={e => setBilingualPromptDraft(e.target.value)}
                                />
                            </div>
                            <div className="chat-bilingual-prompt-section">
                                <div className="chat-bilingual-prompt-head">
                                    <div>
                                        <div className="chat-bilingual-prompt-title">线下模式提示词</div>
                                        <div className="chat-bilingual-prompt-desc">只约束线下连续叙事中的角色对白。</div>
                                    </div>
                                    <button
                                        type="button"
                                        className="chat-bilingual-prompt-reset"
                                        onClick={() => setOfflineBilingualPromptDraft(defaultOfflineBilingualPrompt)}
                                    >
                                        默认
                                    </button>
                                </div>
                                <textarea
                                    className="ui-input chat-bilingual-prompt-textarea chat-bilingual-prompt-textarea--split"
                                    value={offlineBilingualPromptDraft}
                                    onChange={e => setOfflineBilingualPromptDraft(e.target.value)}
                                />
                            </div>
                        </div>
                        <div className="flex gap-3 w-full">
                            <button
                                onClick={() => {
                                    setBilingualPromptDraft(defaultBilingualPrompt);
                                    setOfflineBilingualPromptDraft(defaultOfflineBilingualPrompt);
                                }}
                                className="ui-btn ui-btn-outline flex-1"
                            >
                                全部默认
                            </button>
                            <button onClick={() => setEditingBilingualPrompt(false)} className="ui-btn ui-btn-ghost flex-1">
                                取消
                            </button>
                            <button onClick={saveBilingualPromptDraft} className="ui-btn ui-btn-success flex-1">
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal: Confirm Clear History */}
            {showConfirmClear && (
                <ConfirmDialog
                    title="确定要清空线上聊天记录吗？"
                    message="只清空普通聊天记录，不影响线下模式记录。清空后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="清空"
                    cancelLabel="取消"
                    onConfirm={handleClearHistory}
                    onCancel={() => setShowConfirmClear(false)}
                />
            )}

            {/* Modal: Confirm Clear Offline History */}
            {showConfirmClearOffline && (
                <ConfirmDialog
                    title="确定要清空线下聊天记录吗？"
                    message="会同步移除该会话的线下短期记忆事件，不影响线上聊天与已保存的长期记忆。清空后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="清空"
                    cancelLabel="取消"
                    onConfirm={handleClearOfflineHistory}
                    onCancel={() => setShowConfirmClearOffline(false)}
                />
            )}

            {/* Modal: Confirm Clear Tool History */}
            {showConfirmClearTools && (
                <ConfirmDialog
                    title="清理工具调用历史？"
                    message="将移除本会话中的工具调用记录、工具结果记录，并清除助手消息里的原生工具调用元数据。普通聊天内容不会删除。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="清理"
                    cancelLabel="取消"
                    onConfirm={handleClearToolHistory}
                    onCancel={() => setShowConfirmClearTools(false)}
                />
            )}

            {/* Modal: Confirm Delete Friend */}
            {showConfirmDelete && (
                <ConfirmDialog
                    title="确定要删除该好友吗？"
                    message="删除后对方将从联系人列表消失，聊天和朋友圈将被隐藏。重新添加好友后可恢复。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeChatContact(session.contactId);
                        // Fire-and-forget: AI reacts to being deleted
                        triggerDeleteFriendReaction(session.contactId).catch(() => {});
                        setShowConfirmDelete(false);
                        onDeleteFriend?.();
                    }}
                    onCancel={() => setShowConfirmDelete(false)}
                />
            )}

            {/* Modal: Confirm Dissolve/Exit Group */}
            {showDissolveGroupConfirm && (
                <ConfirmDialog
                    title={!session.isSpectator && ownerKey === GROUP_SELF_KEY ? "确定要解散该群聊吗？" : "确定要退出该群聊吗？"}
                    message="操作后本地的聊天记录将被永久删除，无法恢复。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel={!session.isSpectator && ownerKey === GROUP_SELF_KEY ? "解散" : "退出"}
                    cancelLabel="取消"
                    onConfirm={() => {
                        deleteChatSession(session.id);
                        setShowDissolveGroupConfirm(false);
                        onDeleteFriend?.();
                    }}
                    onCancel={() => setShowDissolveGroupConfirm(false)}
                />
            )}

            {/* Sub-page: Custom CSS */}
            {editingCSS && (
                <div style={{ position: "absolute", inset: 0, zIndex: 9999, background: "#ffffff" }}>
                <div style={{ position: "absolute", inset: 0, background: "var(--c-page-body-bg)" }}>
                    <PageShell title="自定义 CSS" onBack={() => setEditingCSS(false)}>
                        <div className="theme-section-page">
                            <p className="ts-13 text-[var(--c-text)] mb-3 leading-relaxed">
                                支持 :root 变量和选择器，仅作用于本会话。
                            </p>
                            <textarea
                                className="ui-textarea font-mono ts-13 leading-relaxed flex-1"
                                style={{ minHeight: 280, resize: "none", scrollbarWidth: "none" }}
                                placeholder={`:root {\n  --c-bubble-self: #95ec69;\n}\n\n.chat-bubble-role-user {\n  border-radius: 6px;\n}\n\n.chat-html-inline-frame {\n  max-height: min(36vh, 340px);\n}`}
                                value={customCSS}
                                onChange={e => setCustomCSS(e.target.value)}
                                spellCheck={false}
                            />
                            <div className="flex gap-2 mt-3 items-center">
                                <CSSSchemeBar target="chat_session" currentCSS={customCSS} onLoad={setCustomCSS} />
                                <button type="button" className="flex-1" style={{ height: 36, borderRadius: 12, border: "none", background: "transparent", color: "var(--c-text-title, #1a1a1a)", fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer" }} onClick={() => setCustomCSS(CHAT_SESSION_CSS_EXAMPLE)}>示例</button>
                                <button type="button" className="flex-1" style={{ height: 36, borderRadius: 12, border: "none", background: "transparent", color: "var(--c-text-title, #1a1a1a)", fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer" }} onClick={() => setCustomCSS("")}>清除</button>
                                <button type="button" className="flex-1" style={{ height: 36, borderRadius: 12, border: "none", background: "#222", color: "#fff", fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer" }} onClick={() => { updateSession({ customCSS }); window.dispatchEvent(new CustomEvent("chat-session-css-updated", { detail: { sessionId: session.id, css: customCSS } })); setEditingCSS(false); }}>应用</button>
                            </div>
                        </div>
                    </PageShell>
                </div>
                </div>
            )}

            {/* Sub-page: Search History */}
            {showSearch && (
                <div style={{ position: "absolute", inset: 0, zIndex: 9999, background: "#ffffff" }}>
                <div style={{ position: "absolute", inset: 0, background: "var(--c-page-body-bg)" }}>
                    <PageShell title="查找聊天记录" onBack={closeSearchPanel}>
                        <div className="px-4 pt-2 pb-3 flex items-center gap-2">
                            <input
                                autoFocus
                                type="text"
                                placeholder="搜索聊天记录..."
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        runSearch();
                                    }
                                }}
                                className="ui-input flex-1 min-w-0"
                            />
                            <button
                                type="button"
                                aria-label="搜索聊天记录"
                                title="搜索"
                                onClick={runSearch}
                                disabled={isSearching}
                                className="h-10 w-10 shrink-0 grid place-items-center border-0 bg-transparent text-[var(--c-icon)] disabled:opacity-40"
                            >
                                <Search size={20} strokeWidth={2.1} />
                            </button>
                        </div>
                        <div className="flex flex-col gap-4 px-4 pb-4">
                            {!searchMode && searchHistoryMessages.length === 0 && (
                                <div className="ui-empty">
                                    <span className="menu-desc">暂无聊天记录</span>
                                </div>
                            )}
                            {searchMode && isSearching && (
                                <div className="ui-empty">
                                    <span className="menu-desc">正在搜索...</span>
                                </div>
                            )}
                            {searchMode && !isSearching && searchResults.length === 0 && (
                                <div className="ui-empty">
                                    <span className="menu-desc">无相关聊天记录</span>
                                </div>
                            )}
                            {displayedSearchMessages.map(renderSearchMessage)}
                            {!searchMode && searchHasMore && (
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-ghost ui-btn-bordered-ghost w-full"
                                    onClick={loadMoreSearchHistory}
                                >
                                    查看更多消息
                                </button>
                            )}
                            {searchMode && !isSearching && searchResults.length >= SEARCH_RESULT_LIMIT && (
                                <div className="ui-empty py-2">
                                    <span className="menu-desc">仅显示最近 {SEARCH_RESULT_LIMIT} 条结果</span>
                                </div>
                            )}
                        </div>
                    </PageShell>
                </div>
                </div>
            )}
        </PageShell>
    );
}
