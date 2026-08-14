// lib/chat-hero-storage.ts
// 聊天设置 Hero 卡片的独立本地存储：按 session id 存背景图引用 ID / 个性签名 / 4 个装饰图标数量。
// 背景图实际文件走 chat-asset-storage.ts 的 IndexedDB，这里只存引用 ID。
// 该模块与 chat-storage.ts 完全解耦，不修改会话数据结构。

const STORAGE_KEY = "chat_hero_data_v1";

/** 4 个固定装饰图标的键，顺序即展示顺序：皇冠 / 太阳 / 月亮 / 星星 */
export type HeroDecorationKey = "crown" | "sun" | "moon" | "star";

export const HERO_DECORATION_KEYS: HeroDecorationKey[] = ["crown", "sun", "moon", "star"];

export type HeroDecorationCounts = Record<HeroDecorationKey, number>;

export type ChatHeroData = {
    /** 背景图在 IndexedDB 中的引用 ID（chat-asset-storage）；空串表示未设置 */
    backgroundImageId: string;
    /** 个性签名 */
    signature: string;
    /** 4 个装饰图标数量 */
    decorations: HeroDecorationCounts;
};

const MAX_DECORATION_COUNT = 99;

export function createDefaultHeroData(): ChatHeroData {
    return {
        backgroundImageId: "",
        signature: "",
        decorations: { crown: 0, sun: 0, moon: 0, star: 0 },
    };
}

function normalizeDecorations(raw: unknown): HeroDecorationCounts {
    const out: HeroDecorationCounts = { crown: 0, sun: 0, moon: 0, star: 0 };
    if (raw && typeof raw === "object") {
        for (const key of HERO_DECORATION_KEYS) {
            const value = Number((raw as Record<string, unknown>)[key]);
            if (Number.isFinite(value)) {
                out[key] = Math.min(MAX_DECORATION_COUNT, Math.max(0, Math.floor(value)));
            }
        }
    }
    return out;
}

function normalizeHeroData(raw: unknown): ChatHeroData {
    const base = createDefaultHeroData();
    if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        if (typeof obj.backgroundImageId === "string") base.backgroundImageId = obj.backgroundImageId;
        if (typeof obj.signature === "string") base.signature = obj.signature;
        base.decorations = normalizeDecorations(obj.decorations);
    }
    return base;
}

function readAll(): Record<string, ChatHeroData> {
    if (typeof window === "undefined") return {};
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};
        const out: Record<string, ChatHeroData> = {};
        for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
            out[sessionId] = normalizeHeroData(value);
        }
        return out;
    } catch {
        return {};
    }
}

function writeAll(map: Record<string, ChatHeroData>): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (err) {
        console.error("[chat-hero-storage] failed to persist", err);
    }
}

/** 读取某会话的 Hero 数据，缺省返回默认值 */
export function loadChatHeroData(sessionId: string): ChatHeroData {
    if (!sessionId) return createDefaultHeroData();
    const map = readAll();
    return map[sessionId] ? normalizeHeroData(map[sessionId]) : createDefaultHeroData();
}

/** 覆盖保存某会话的 Hero 数据 */
export function saveChatHeroData(sessionId: string, data: ChatHeroData): void {
    if (!sessionId) return;
    const map = readAll();
    map[sessionId] = normalizeHeroData(data);
    writeAll(map);
}

/** 局部更新某会话的 Hero 数据并返回更新后的完整对象 */
export function updateChatHeroData(sessionId: string, patch: Partial<ChatHeroData>): ChatHeroData {
    const current = loadChatHeroData(sessionId);
    const next: ChatHeroData = {
        ...current,
        ...patch,
        decorations: patch.decorations ? normalizeDecorations(patch.decorations) : current.decorations,
    };
    saveChatHeroData(sessionId, next);
    return next;
}
