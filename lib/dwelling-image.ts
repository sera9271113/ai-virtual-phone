import type { DwellingRoom } from "./dwelling-storage";
import { loadDwellingImageEnabled } from "./dwelling-storage";
import { resolveFurnitureMarker } from "./dwelling-engine";
import { loadImageGenerationSettings } from "./settings-storage";
import { generateImageFromConfiguredApi, generateImagesFromConfiguredApi } from "./image-generation-service";

// ── Availability ──────────────────────────────

export type DwellingImageAvailability = {
    /** 全局生图配置齐全且已开启 */
    configured: boolean;
    /** 栖所独立生图开关 */
    dwellingEnabled: boolean;
    /** 二者同时满足才真正生图 */
    available: boolean;
};

export function getDwellingImageAvailability(): DwellingImageAvailability {
    const s = loadImageGenerationSettings();
    const configured = Boolean(s.enabled && s.apiKey.trim() && s.baseUrl.trim() && s.model.trim());
    const dwellingEnabled = loadDwellingImageEnabled();
    return { configured, dwellingEnabled, available: configured && dwellingEnabled };
}

// ── Room image generation ─────────────────────

/** 统一风格后缀：保证各房间图色调一致、匹配栖所暗色 UI */
const DWELLING_IMAGE_STYLE_SUFFIX =
    "电影感室内空间摄影，广角镜头拍摄整个房间，低照度暗调，光影层次丰富，氛围沉静高级，构图简洁干净，画面中没有任何人物、动物和文字，真实材质细节";

function markerRegion(x: number, y: number): string {
    const horizontal = x < 0.36 ? "左侧" : x > 0.64 ? "右侧" : "中央";
    const vertical = y < 0.4 ? "上部" : y > 0.66 ? "下部" : "中部";
    return `${horizontal}${vertical}`;
}

function buildRoomImagePrompt(room: DwellingRoom): string {
    const labels = (room.furniture || []).map(f => f.label).filter(Boolean);
    const base = `${room.name}的完整室内空间，镜头从房间入口正面拍摄，天花板、墙面和地面边界清晰可见`;
    const mustLine = labels.length
        ? `画面中必须同时出现以下家具，缺一不可：${labels.join("、")}；采用能看到整个房间的广角视角，禁止只拍某件家具的局部特写。`
        : "";
    const composition = (room.furniture || [])
        .map(f => {
            const marker = resolveFurnitureMarker(f);
            return `${f.label}完整可见，其主体中心位于画面宽度${Math.round(marker.x * 100)}%、高度${Math.round(marker.y * 100)}%处（${markerRegion(marker.x, marker.y)}）`;
        })
        .join("；");
    const compositionLine = composition
        ? `严格遵守以下家具清单与空间构图，不得省略、替换或互换：${composition}。每件家具主体应完整可辨认，避免被其他家具遮挡。`
        : "";
    const screenLine = labels.some(label => /投影|电视|幕墙|屏幕/.test(label))
        ? "投影幕墙、电视或屏幕只能作为房间中的一件家具，必须看得到屏幕外框及周围墙面，屏幕内容不得扩展成整幅画面。"
        : "";
    return `${base}。${mustLine}${compositionLine}${screenLine}${DWELLING_IMAGE_STYLE_SUFFIX}`;
}

function dwellingImageSettings() {
    return { ...loadImageGenerationSettings(), size: "1024x1536" };
}

export type DwellingRoomImageResult = { assetId: string | null; dataUrl?: string; error?: string };
export type DwellingRoomBatchImageResult = { roomId: string; assetId: string; dataUrl: string }[];

const inflightByRoom = new Map<string, Promise<DwellingRoomImageResult>>();
const inflightByCharacter = new Map<string, Promise<DwellingRoomBatchImageResult>>();

function roomKey(characterId: string, roomId: string) { return `${characterId}_${roomId}`; }

export function isDwellingRoomImageGenerating(characterId: string, roomId: string): boolean {
    return inflightByRoom.has(roomKey(characterId, roomId));
}

/** 生图请求硬超时兜底：网络切换/切后台可能让请求永远挂起（用户随时可手动停止） */
const ROOM_IMAGE_TIMEOUT_MS = 600_000;

/** 用户主动停止时的错误标记（UI 据此显示"已停止"而非"失败"） */
export const DWELLING_IMAGE_CANCELED_ERROR = "已停止生成";

const inflightControllers = new Map<string, { controller: AbortController; userCanceled: boolean }>();
const batchControllers = new Map<string, { controller: AbortController; userCanceled: boolean }>();

/** 手动停止某个房间的生图请求 */
export function cancelDwellingRoomImage(characterId: string, roomId: string): void {
    const entry = inflightControllers.get(roomKey(characterId, roomId));
    if (entry) {
        entry.userCanceled = true;
        entry.controller.abort();
    }
}

export function isDwellingRoomBatchImageGenerating(characterId: string): boolean {
    return inflightByCharacter.has(characterId);
}

export function cancelDwellingRoomBatchImage(characterId: string): void {
    const entry = batchControllers.get(characterId);
    if (entry) {
        entry.userCanceled = true;
        entry.controller.abort();
    }
}

export async function generateDwellingRoomImages(
    characterId: string,
    rooms: DwellingRoom[],
): Promise<{ results: DwellingRoomBatchImageResult; error?: string }> {
    const existing = inflightByCharacter.get(characterId);
    if (existing) return { results: await existing };
    const run = (async (): Promise<DwellingRoomBatchImageResult> => {
        const controller = new AbortController();
        const entry = { controller, userCanceled: false };
        batchControllers.set(characterId, entry);
        const timer = setTimeout(() => controller.abort(), ROOM_IMAGE_TIMEOUT_MS);
        try {
            const availability = getDwellingImageAvailability();
            if (!availability.available) throw new Error("生图未开启");
            const images = await generateImagesFromConfiguredApi({
                descriptions: rooms.map(buildRoomImagePrompt),
                settings: dwellingImageSettings(),
                signal: controller.signal,
            });
            if (images.length !== rooms.length) {
                throw new Error(`批量生图返回 ${images.length} 张图片，需要 ${rooms.length} 张`);
            }
            return rooms.map((room, index) => ({
                roomId: room.id,
                assetId: images[index].mediaRef,
                dataUrl: images[index].dataUrl,
            }));
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error(entry.userCanceled ? DWELLING_IMAGE_CANCELED_ERROR : "生成超时，请重试");
            }
            throw error;
        } finally {
            clearTimeout(timer);
            batchControllers.delete(characterId);
            inflightByCharacter.delete(characterId);
        }
    })();
    inflightByCharacter.set(characterId, run);
    try {
        return { results: await run };
    } catch (error) {
        return { results: [], error: error instanceof Error ? error.message : "生成失败" };
    }
}

/**
 * 为房间生成主视觉图。图像 blob 由 generateImageFromConfiguredApi 存入媒体库，
 * 返回 mediaRef（assetId）；把它写回布局并保存由调用方负责。
 * 同一房间的并发调用会合并到同一次请求。
 */
export async function generateDwellingRoomImage(
    characterId: string,
    room: DwellingRoom,
): Promise<DwellingRoomImageResult> {
    const key = roomKey(characterId, room.id);
    const existing = inflightByRoom.get(key);
    if (existing) return existing;

    const run = (async (): Promise<DwellingRoomImageResult> => {
        const controller = new AbortController();
        const entry = { controller, userCanceled: false };
        inflightControllers.set(key, entry);
        const timer = setTimeout(() => controller.abort(), ROOM_IMAGE_TIMEOUT_MS);
        try {
            const availability = getDwellingImageAvailability();
            if (!availability.available) return { assetId: null, error: "生图未开启" };
            const result = await generateImageFromConfiguredApi({
                description: buildRoomImagePrompt(room),
                settings: dwellingImageSettings(),
                signal: controller.signal,
            });
            if (!result) return { assetId: null, error: "生图未配置或已关闭" };
            return { assetId: result.mediaRef, dataUrl: result.dataUrl };
        } catch (e) {
            if (controller.signal.aborted) {
                return { assetId: null, error: entry.userCanceled ? DWELLING_IMAGE_CANCELED_ERROR : "生成超时，请重试" };
            }
            const msg = e instanceof Error ? e.message : "生成失败";
            return { assetId: null, error: msg };
        } finally {
            clearTimeout(timer);
            inflightByRoom.delete(key);
            inflightControllers.delete(key);
        }
    })();

    inflightByRoom.set(key, run);
    return run;
}