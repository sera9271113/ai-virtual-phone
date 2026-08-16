import type { DwellingFurniture, DwellingFurnitureItem, DwellingLayout, DwellingMarker, DwellingPosition, DwellingRoom } from "./dwelling-storage";
import { loadDwellingLayout } from "./dwelling-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { loadCharacters } from "./character-storage";
import {
    loadBindingConfig,
    loadApiConfigs,
    loadPresets,
    loadRegexes,
    loadWorldBooks,
    resolveBinding,
    resolveAuxiliaryApiConfig,
    resolveUserIdentity,
} from "./settings-storage";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { jsonrepair } from "jsonrepair";

// ── Truncation detection ──────────────────────

function isTruncatedFinishReason(reason?: string): boolean {
    if (!reason) return false;
    const r = reason.trim().toLowerCase();
    return r === "length" || r === "max_tokens" || r === "max_output_tokens" || r === "max_completion_tokens";
}

// ── Resolve configs (same pattern as story-engine) ──

function resolveDwellingConfigs(characterId: string) {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "dwelling");

    const apiConfigs = loadApiConfigs();
    const apiConfig = apiConfigs.find(c => c.id === slot.apiConfigId) ?? apiConfigs[0];

    const presets = loadPresets();
    let preset = slot.presetId ? presets.find(p => p.id === slot.presetId) ?? null : null;
    if (!preset) preset = presets.find(p => p.builtIn) ?? null;

    const allWbs = loadWorldBooks();
    const worldBooks = (slot.worldBookIds || []).map(id => allWbs.find(w => w.id === id)).filter(Boolean) as WorldBookConfig[];

    const allRegexes = loadRegexes();
    const regexes = (slot.regexIds || []).map(id => allRegexes.find(r => r.id === id)).filter(Boolean) as RegexConfig[];

    return { apiConfig, preset, worldBooks, regexes };
}

// ── Build prompt messages via preset assembler ──

async function buildDwellingMessages(
    characterId: string,
    preset: PresetConfig | null,
    worldBooks: WorldBookConfig[],
    regexes: RegexConfig[],
    appTags: string[],
    dwellingContext?: string,
    macros?: { dwellingRoom?: string; dwellingFurniture?: string; dwellingItem?: string; dwellingItemPreview?: string },
): Promise<LLMMessage[]> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");

    const userIdentity = resolveUserIdentity(characterId, "dwelling");
    const memConfig = loadMemoryConfig();
    const { recentBlocks, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(characterId, "dwelling", {
        userName: userIdentity?.name ?? "用户",
        history: [],
    });

    const [memories, coreMemories] = await Promise.all([
        retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
        retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
    ]);

    return assemblePromptPayload({
        character,
        history: [],
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: "dwelling",
        appTags,
        scheduleSummary: buildCalendarScheduleMarker("character", characterId, getWeekStartIso(new Date())),
        coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
        longTermMemories: memories ? formatLongTermMemories(memories) : "",
        worldBookActivationContext: wbActivationContext,
        recentBlocks,
        unifiedRecentItems,
        dwellingContext,
        dwellingRoom: macros?.dwellingRoom,
        dwellingFurniture: macros?.dwellingFurniture,
        dwellingItem: macros?.dwellingItem,
        dwellingItemPreview: macros?.dwellingItemPreview,
    });
}

// ── Valid positions for dedup ─────────────────

const ALL_POSITIONS: DwellingPosition[] = [
    "top-left", "top-center", "top-right",
    "center-left", "center", "center-right",
    "bottom-left", "bottom-center", "bottom-right",
];

function deduplicatePositions(rooms: DwellingLayout["rooms"]): void {
    for (const room of rooms) {
        const used = new Set<string>();
        for (const f of room.furniture) {
            if (!ALL_POSITIONS.includes(f.position)) f.position = "center";
            if (used.has(f.position)) {
                const free = ALL_POSITIONS.find(p => !used.has(p));
                if (free) f.position = free;
            }
            used.add(f.position);
        }
    }
}

// ── Marker sanitize + position fallback ───────

/** 标注点安全范围：避开顶部玻璃栏区和底部引言区 */
const MARKER_X_MIN = 0.08, MARKER_X_MAX = 0.92;
const MARKER_Y_MIN = 0.24, MARKER_Y_MAX = 0.82;

const POSITION_MARKERS: Record<DwellingPosition, DwellingMarker> = {
    "top-left": { x: 0.26, y: 0.3 }, "top-center": { x: 0.5, y: 0.26 }, "top-right": { x: 0.74, y: 0.3 },
    "center-left": { x: 0.24, y: 0.5 }, "center": { x: 0.5, y: 0.48 }, "center-right": { x: 0.76, y: 0.5 },
    "bottom-left": { x: 0.27, y: 0.7 }, "bottom-center": { x: 0.5, y: 0.72 }, "bottom-right": { x: 0.73, y: 0.7 },
};

function clampMarker(m: DwellingMarker): DwellingMarker {
    return {
        x: Math.min(MARKER_X_MAX, Math.max(MARKER_X_MIN, m.x)),
        y: Math.min(MARKER_Y_MAX, Math.max(MARKER_Y_MIN, m.y)),
    };
}

/** 取家具标注点：优先 LLM 输出的 marker，旧数据/缺失时按九宫格 position 兜底 */
export function resolveFurnitureMarker(f: DwellingFurniture): DwellingMarker {
    const m = f.marker;
    if (m && Number.isFinite(m.x) && Number.isFinite(m.y)) return clampMarker(m);
    return POSITION_MARKERS[f.position] ?? POSITION_MARKERS.center;
}

function sanitizeLayoutExtras(rooms: DwellingLayout["rooms"]): void {
    for (const room of rooms) {
        if (typeof room.en === "string") room.en = room.en.trim().toUpperCase().slice(0, 24) || undefined;
        else room.en = undefined;
        if (typeof room.imagePrompt === "string") room.imagePrompt = room.imagePrompt.trim() || undefined;
        else room.imagePrompt = undefined;
        for (const f of room.furniture) {
            if (typeof f.en === "string") f.en = f.en.trim().toUpperCase().slice(0, 24) || undefined;
            else f.en = undefined;
            const m = f.marker as unknown;
            if (m && typeof m === "object"
                && Number.isFinite((m as DwellingMarker).x) && Number.isFinite((m as DwellingMarker).y)) {
                f.marker = clampMarker(m as DwellingMarker);
            } else {
                f.marker = undefined;
            }
        }
    }
}

// ── Strip markdown fences + parse JSON ────────

type ExtractedJSON = { value: unknown; repaired: boolean } | null;

function normalizeItemPreviews(layout: DwellingLayout): void {
    for (const room of layout.rooms) {
        for (const furniture of room.furniture) {
            for (const item of furniture.items) {
                const rawItem = item as DwellingFurnitureItem & { description?: unknown };
                if (!rawItem.preview && typeof rawItem.description === "string") {
                    rawItem.preview = rawItem.description;
                }
            }
        }
    }
}

function extractJSON(text: string): ExtractedJSON {
    let s = text.trim();
    // Strip thinking / reasoning tags
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
    s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "").trim();

    const tryParse = (candidate: string): { value: unknown; repaired: boolean } | null => {
        try { return { value: JSON.parse(candidate), repaired: false }; } catch { /* try repair below */ }
        try { return { value: JSON.parse(jsonrepair(candidate)), repaired: true }; } catch { return null; }
    };

    // Try markdown fence first
    const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        const parsed = tryParse(fenceMatch[1].trim());
        if (parsed !== null) return parsed;
    }

    // Try parsing as-is
    const direct = tryParse(s);
    if (direct !== null) return direct;

    // Try to find the outermost { ... } or [ ... ]
    const braceStart = s.indexOf("{");
    const bracketStart = s.indexOf("[");
    const start = braceStart >= 0 && (bracketStart < 0 || braceStart < bracketStart) ? braceStart : bracketStart;
    if (start >= 0) {
        const openChar = s[start];
        const closeChar = openChar === "{" ? "}" : "]";
        // Find matching close from the end
        const end = s.lastIndexOf(closeChar);
        if (end > start) {
            const extracted = tryParse(s.slice(start, end + 1));
            if (extracted !== null) return extracted;
        }
    }

    console.warn("[Dwelling] Failed to extract JSON from LLM output:", s.slice(0, 500));
    return null;
}

type LocatedFurnitureMarker = { furnitureId: string; marker: DwellingMarker };

export async function locateDwellingFurnitureMarkers(
    characterId: string,
    room: DwellingRoom,
    imageDataUrl: string,
): Promise<LocatedFurnitureMarker[]> {
    const apiConfig = resolveAuxiliaryApiConfig("dwellingFurnitureLocationApiConfigId");
    if (!apiConfig || !imageDataUrl.startsWith("data:image/")) return [];

    // Force vision on: furniture location is inherently a vision task,
    // so we send the image regardless of the config's enableImageRecognition flag.
    const visionConfig: ApiConfig = apiConfig.enableImageRecognition ? apiConfig : { ...apiConfig, enableImageRecognition: true };

    const furnitureList = room.furniture.map((furniture, index) => `${index}: ${furniture.label}`).join("\n");
    const prompt = [
        "识别这张室内图片中下列家具主体的实际位置。只定位确实可见且能明确对应的家具，不要猜测。",
        furnitureList,
        "坐标以完整原图左上角为(0,0)、右下角为(1,1)，取家具可见主体的中心点。",
        "只输出JSON：{\"furniture\":[{\"index\":0,\"x\":0.5,\"y\":0.5,\"visible\":true}]}。不要输出说明或Markdown。",
    ].join("\n");
    const rawOutput = await sendLLMRequest(visionConfig, null, [{
        role: "user",
        content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
        ],
    }], [], undefined, {
        skipOutputRegex: true,
        appId: "dwelling",
        appTags: ["dwelling", "image-location"],
    });
    const extracted = extractJSON(rawOutput);
    const parsed = extracted?.value;
    const entries = parsed && typeof parsed === "object" && Array.isArray((parsed as { furniture?: unknown }).furniture)
        ? (parsed as { furniture: unknown[] }).furniture
        : [];
    const seen = new Set<number>();
    const located: LocatedFurnitureMarker[] = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as { index?: unknown; x?: unknown; y?: unknown; visible?: unknown };
        if (item.visible !== true || !Number.isInteger(item.index) || typeof item.x !== "number" || typeof item.y !== "number") continue;
        const index = item.index as number;
        if (index < 0 || index >= room.furniture.length || seen.has(index)) continue;
        if (!Number.isFinite(item.x) || !Number.isFinite(item.y) || item.x < 0 || item.x > 1 || item.y < 0 || item.y > 1) continue;
        seen.add(index);
        located.push({ furnitureId: room.furniture[index].id, marker: { x: item.x, y: item.y } });
    }
    return located;
}

// ── Format existing layout as compact context text ──

export function formatDwellingContext(layout: DwellingLayout, updatedAt: string): string {
    const ts = updatedAt.slice(0, 16).replace("T", " ");
    const lines = [`[房屋布局 ${ts} 更新]`];
    for (const room of layout.rooms) {
        const parts: string[] = [];
        for (const f of room.furniture) {
            const items = f.items.map(i => {
                const detail = i.preview ? `${i.name}[id=${i.id}](${i.preview})` : `${i.name}[id=${i.id}]`;
                return detail;
            }).join("、");
            parts.push(`${f.icon} ${f.label}[id=${f.id}]：${items}`);
        }
        lines.push(`◆ ${room.name}[id=${room.id}]\n  ${parts.join("\n  ")}`);
    }
    return lines.join("\n");
}

// ── Generate room layout ──────────────────────

export type DwellingRefreshMode = "full" | "items";

const pendingLayoutGenerations = new Map<string, Promise<{ layout: DwellingLayout | null; error?: string }>>();

/**
 * 栖所布局/物品是长 JSON 输出，和剧情/聊天一样需要充足的补全空间。
 *
 * 关键：不要强制写死一个 max_tokens 值。很多 provider 对 max_tokens 有自己的硬上限，
 * 显式发送一个偏大的值反而会被 provider 夹回它的默认最大值（如 4096），导致截断。
 * 正确做法与 story-engine 一致：
 * - openai_max_tokens=0 表示不发送 max_tokens 参数，让模型用自身默认上限（通常足够大，不截断）
 * - 若用户显式配置了正数上限，则尊重用户配置，原样透传
 * 只有当上限被设成一个明显过小、可能沿用聊天场景默认的值时，才清零解除限制。
 */
const DWELLING_MIN_SAFE_MAX_TOKENS = 8_192;

function dwellingTextApiConfig(apiConfig: ApiConfig): ApiConfig {
    const params = apiConfig.generationParams;
    const configured = params?.openai_max_tokens ?? 0;
    // 0（未设/不限）或已足够大：原样透传，不做任何干预
    if (!params || configured === 0 || configured >= DWELLING_MIN_SAFE_MAX_TOKENS) return apiConfig;
    // 用户设了一个偏小的上限：清零，改为让模型用默认上限，避免长布局被人为截断
    return {
        ...apiConfig,
        generationParams: {
            ...params,
            openai_max_tokens: 0,
        },
    };
}

export async function generateDwellingLayout(
    characterId: string,
    mode: DwellingRefreshMode = "full",
    signal?: AbortSignal,
): Promise<{ layout: DwellingLayout | null; error?: string }> {
    const requestKey = characterId;
    const pending = pendingLayoutGenerations.get(requestKey);
    if (pending) return pending;

    const generation = generateDwellingLayoutOnce(characterId, mode, signal);
    pendingLayoutGenerations.set(requestKey, generation);
    try {
        return await generation;
    } finally {
        if (pendingLayoutGenerations.get(requestKey) === generation) {
            pendingLayoutGenerations.delete(requestKey);
        }
    }
}

async function generateDwellingLayoutOnce(
    characterId: string,
    mode: DwellingRefreshMode,
    signal?: AbortSignal,
): Promise<{ layout: DwellingLayout | null; error?: string }> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) return { layout: null, error: "未找到可用的 API 配置" };
    const textApiConfig = dwellingTextApiConfig(apiConfig);

    // Load existing layout for context injection
    const oldCached = await loadDwellingLayout(characterId);
    const dwellingContext = oldCached ? formatDwellingContext(oldCached.layout, oldCached.updatedAt) : undefined;

    // items mode requires existing layout
    if (mode === "items" && !oldCached) mode = "full";

    const appTags = ["dwelling", mode === "items" ? "items" : "full"];

    try {
        const llmMessages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, appTags, dwellingContext);

        let finishReason: string | undefined;
        const rawOutput = await sendLLMRequest(textApiConfig, preset, llmMessages, regexes, {
            characterName: loadCharacters().find(c => c.id === characterId)?.name,
        }, {
            appId: "dwelling",
            appTags,
            skipOutputRegex: true,
            onResponseMeta: meta => { finishReason = meta.finishReason; },
        });

        if (!rawOutput) return { layout: null, error: "LLM 返回为空" };
        if (isTruncatedFinishReason(finishReason)) {
            return { layout: null, error: `房间布局输出被截断（finish_reason: ${finishReason}），未保存不完整结果；请提高输出上限后重试` };
        }

        const extracted = extractJSON(rawOutput);
        if (!extracted || typeof extracted.value !== "object") {
            return { layout: null, error: "无法解析 LLM 返回的 JSON" };
        }

        const obj = extracted.value as Record<string, unknown>;

        let layout: DwellingLayout;

        // Items mode returns only furniture identifiers and their refreshed items.
        if (mode === "items" && oldCached) {
            if (!Array.isArray(obj.furnitureItems) || obj.furnitureItems.length === 0) {
                return { layout: null, error: "物品刷新返回格式不正确（缺少 furnitureItems）" };
            }

            const oldLayout = structuredClone(oldCached.layout);
            let updatedFurnitureCount = 0;
            for (const entry of obj.furnitureItems as unknown[]) {
                if (!entry || typeof entry !== "object") continue;
                const value = entry as Record<string, unknown>;
                if (typeof value.roomId !== "string" || typeof value.furnitureId !== "string" || !Array.isArray(value.items)) continue;
                const room = oldLayout.rooms.find(candidate => candidate.id === value.roomId);
                const furniture = room?.furniture.find(candidate => candidate.id === value.furnitureId);
                if (furniture) {
                    furniture.items = value.items as DwellingFurnitureItem[];
                    updatedFurnitureCount += 1;
                }
            }
            if (updatedFurnitureCount === 0) return { layout: null, error: "物品刷新结果没有匹配到已有家具" };
            layout = oldLayout;
        } else {
            if (!Array.isArray(obj.rooms) || obj.rooms.length === 0) {
                return { layout: null, error: "LLM 返回格式不正确（缺少 rooms）" };
            }
            // Full layout mode still requires the complete persisted layout shape.
            if (extracted.repaired) {
                const lastRoom = obj.rooms[obj.rooms.length - 1];
                const lastRoomIncomplete = !lastRoom || typeof lastRoom !== "object"
                    || typeof (lastRoom as Record<string, unknown>).id !== "string"
                    || typeof (lastRoom as Record<string, unknown>).name !== "string"
                    || typeof (lastRoom as Record<string, unknown>).description !== "string"
                    || !Array.isArray((lastRoom as Record<string, unknown>).furniture);
                if (lastRoomIncomplete) {
                    return { layout: null, error: "LLM 返回的 JSON 不完整（疑似输出被截断后由 jsonrepair 修复），未保存不完整结果；请提高输出上限后重试" };
                }
            }

            const invalidRoom = obj.rooms.find((room: unknown) => {
                if (!room || typeof room !== "object") return true;
                const value = room as Record<string, unknown>;
                return typeof value.id !== "string"
                    || typeof value.name !== "string"
                    || typeof value.description !== "string"
                    || !Array.isArray(value.furniture);
            });
            if (invalidRoom) {
                return { layout: null, error: "LLM 返回格式不完整：每个房间必须包含 id、name、description 和 furniture" };
            }

            layout = obj as DwellingLayout;
            for (const room of layout.rooms) {
                if (!Array.isArray(room.furniture)) room.furniture = [];
                for (const f of room.furniture) {
                    if (!Array.isArray(f.items)) f.items = [];
                }
            }
        }

        if (mode !== "items") {
            deduplicatePositions(layout.rooms);
            sanitizeLayoutExtras(layout.rooms);
        }
        normalizeItemPreviews(layout);

        return { layout };
    } catch (e) {
        const msg = e instanceof Error ? e.message : "生成失败";
        return { layout: null, error: msg };
    }
}

// ── Generate HTML for a single item ──

export async function generateItemHtml(
    characterId: string,
    roomName: string,
    furnitureLabel: string,
    itemName: string,
    itemPreview: string,
): Promise<{ html: string | null; error?: string }> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) return { html: null, error: "未找到可用的 API 配置" };
    const textApiConfig = dwellingTextApiConfig(apiConfig);
    const appTags = ["dwelling", "explore"];

    try {
        const llmMessages = await buildDwellingMessages(
            characterId, preset, worldBooks, regexes,
            appTags,
            undefined,
            { dwellingRoom: roomName, dwellingFurniture: furnitureLabel, dwellingItem: itemName, dwellingItemPreview: itemPreview },
        );
        const rawOutput = await sendLLMRequest(textApiConfig, preset, llmMessages, regexes, {
            characterName: loadCharacters().find(c => c.id === characterId)?.name,
        }, {
            appId: "dwelling",
            appTags,
            skipOutputRegex: true,
        });

        return { html: rawOutput || null };
    } catch (e) {
        const msg = e instanceof Error ? e.message : "生成失败";
        return { html: null, error: msg };
    }
}

export async function previewDwellingPromptPayload(
    characterId: string,
    mode: DwellingRefreshMode | "explore" = "full",
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未找到可用的 API 配置");
    const character = loadCharacters().find(c => c.id === characterId);
    const cached = await loadDwellingLayout(characterId);
    const dwellingContext = cached ? formatDwellingContext(cached.layout, cached.updatedAt) : undefined;
    const appTags = mode === "explore"
        ? ["dwelling", "explore"]
        : ["dwelling", mode === "items" ? "items" : "full"];
    const llmMessages = mode === "explore"
        ? await buildDwellingMessages(
            characterId,
            preset,
            worldBooks,
            regexes,
            appTags,
            undefined,
            {
                dwellingRoom: cached?.layout.rooms[0]?.name ?? "房间",
                dwellingFurniture: cached?.layout.rooms[0]?.furniture[0]?.label ?? "家具",
                dwellingItem: cached?.layout.rooms[0]?.furniture[0]?.items[0]?.name ?? "物品",
                dwellingItemPreview: cached?.layout.rooms[0]?.furniture[0]?.items[0]?.preview ?? "物品外观与细节",
            },
        )
        : await buildDwellingMessages(characterId, preset, worldBooks, regexes, appTags, dwellingContext);

    return {
        messages: previewMessagesForApi(apiConfig, preset, llmMessages),
        characterName: `栖所:${character?.name ?? characterId}`,
        model: apiConfig.defaultModel,
        presetName: preset?.name ?? "默认预设",
    };
}