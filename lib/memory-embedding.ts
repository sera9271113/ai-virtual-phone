// lib/memory-embedding.ts
// Embedding generation + vector/keyword search for memory retrieval.

import type { ApiConfig } from "./settings-types";
import type { MemoryEntry, MemorySearchResult, MemoryStatus } from "./memory-types";
import { determineBaseUrl, buildRequestHeaders, simpleLLMCall } from "./api-helpers";

// ── Provider → Embedding Model Mapping ──

export function getEmbeddingModelForProvider(provider: string): string | null {
    switch (provider) {
        case "OpenAI": return "text-embedding-3-small";
        case "SiliconFlow": return "BAAI/bge-large-zh-v1.5";
        case "TogetherAI": return "BAAI/bge-large-en-v1.5";
        case "Zhipu": return "embedding-2";
        default: return null;
    }
}

/** 常见向量模型命名特征（embedding-3 / text-embedding-* / bge-* / m3e / gte 等） */
const EMBEDDING_MODEL_NAME_RE = /embed|bge-|m3e|text2vec|\be5\b|\bgte\b/i;

export function isEmbeddingModelName(model: string | undefined): boolean {
    return Boolean(model && EMBEDDING_MODEL_NAME_RE.test(model));
}

/** 解析该配置应使用的向量模型：默认模型名看起来像向量模型就直接用
 *  （自定义服务商、以及智谱 embedding-3 等新模型因此可配），否则回退
 *  按服务商的内置映射（老用户绑普通对话配置的行为不变）。 */
export function resolveEmbeddingModel(apiConfig: Pick<ApiConfig, "provider" | "defaultModel">): string | null {
    const model = apiConfig.defaultModel?.trim();
    if (model && isEmbeddingModelName(model)) return model;
    return getEmbeddingModelForProvider(apiConfig.provider);
}

// ── Embedding API ──

export async function generateEmbedding(
    text: string,
    apiConfig: ApiConfig,
    options: { throwOnError?: boolean } = {}
): Promise<number[] | null> {
    const fail = (message: string): null => {
        if (options.throwOnError) throw new Error(message);
        console.warn("[MemoryEmbedding]", message);
        return null;
    };

    const embeddingModel = resolveEmbeddingModel(apiConfig);
    if (!embeddingModel) return fail("该配置无可用向量模型（默认模型名不像向量模型，服务商也无内置映射）");
    if (!apiConfig.apiKey) return fail("缺少 API Key");

    const baseUrl = determineBaseUrl(apiConfig);
    if (!baseUrl) return fail("缺少 Base URL");

    const url = baseUrl.endsWith("/embeddings")
        ? baseUrl
        : `${baseUrl.replace(/\/$/, "")}/embeddings`;

    const headers = buildRequestHeaders(apiConfig, baseUrl);

    try {
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: embeddingModel,
                input: text,
            }),
        });
        if (!res.ok) {
            return fail(`API 错误 ${res.status}: ${await res.text()}`);
        }
        const data = await res.json();
        const embedding = data?.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || embedding.length === 0) {
            return fail("接口未返回向量数据");
        }
        return embedding;
    } catch (err) {
        if (options.throwOnError) throw err;
        console.warn("[MemoryEmbedding] fetch error:", err);
        return null;
    }
}


// ── Vector math ──

export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

function normalizeImportance(importance: number | undefined): number {
    const normalizedImportance = typeof importance === "number" && Number.isFinite(importance) ? importance : 0;
    if (normalizedImportance <= 1) {
        return Math.max(0, Math.min(1, normalizedImportance));
    }
    return Math.max(1, Math.min(10, normalizedImportance)) / 10;
}

export function getMemoryStatus(entry: MemoryEntry): MemoryStatus {
    const status = entry.metadata?.status;
    if (status === "active" || status === "sleeping" || status === "archived") {
        return status;
    }
    return "active";
}

function getStatusWeight(entry: MemoryEntry): number {
    const status = getMemoryStatus(entry);
    return status === "sleeping" ? 0.5 : 1.0;
}

function getReadCount(entry: MemoryEntry): number {
    const count = Number(entry.metadata?.readCount ?? 0);
    return Number.isFinite(count) ? Math.max(0, count) : 0;
}

function getLastReadAt(entry: MemoryEntry): string | null {
    const value = entry.metadata?.lastReadAt;
    return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Emotional salience: how emotionally charged a memory is, independent of whether
 * that emotion was positive or negative. Driven by magnitude (|valence| + arousal),
 * not direction — a strongly negative memory (an argument, a loss) is just as
 * psychologically "sticky" as a strongly positive one (a confession, a win).
 * A direction-based bonus would only make happy memories more retrievable, which
 * doesn't match how emotionally-charged memory formation actually works.
 * Returns 0-1. Missing/invalid valence or arousal fall back to 0 (no salience
 * boost), so entries without emotion data behave exactly as before this change.
 */
function getEmotionalSalience(entry: MemoryEntry): number {
    const rawValence = Number(entry.metadata?.valence);
    const rawArousal = Number(entry.metadata?.arousal);
    const valence = Number.isFinite(rawValence) ? Math.max(-1, Math.min(1, rawValence)) : 0;
    const arousal = Number.isFinite(rawArousal) ? Math.max(0, Math.min(1, rawArousal)) : 0;
    return Math.max(0, Math.min(1, (Math.abs(valence) + arousal) / 2));
}

export function computeMemoryRecencyScore(
    entry: MemoryEntry,
    now: number = Date.now()
): number {
    const lastReadAt = getLastReadAt(entry) ?? entry.updatedAt ?? entry.createdAt;
    const lastReadMs = new Date(lastReadAt).getTime();
    if (!Number.isFinite(lastReadMs)) {
        return 0;
    }
    const ageHours = Math.max(0, (now - lastReadMs) / 3600000);
    // Emotionally-charged memories decay slower, same mechanism as repeated reads
    // (readCount) slowing decay — just driven by emotional intensity instead of
    // retrieval frequency. Mirrors real "flashbulb memory" persistence.
    const salience = getEmotionalSalience(entry);
    return Math.max(0, Math.min(1, Math.exp(-0.02 * ageHours / (1 + 0.15 * getReadCount(entry) + 0.3 * salience))));
}

export function scoreMemoryEntry(
    entry: MemoryEntry,
    semanticScore: number,
    now: number = Date.now()
): number {
    const normalizedSemantic = Math.max(0, Math.min(1, semanticScore));
    const normalizedImportance = normalizeImportance(entry.importance);
    const recencyScore = computeMemoryRecencyScore(entry, now);
    const statusWeight = getStatusWeight(entry);
    const emotionalSalience = getEmotionalSalience(entry);

    return (
        normalizedSemantic * 0.50
        + normalizedImportance * 0.34
        + recencyScore * 0.05
        + emotionalSalience * 0.11
    ) * statusWeight;
}

// ── Search ──

export async function searchMemories(
    query: string,
    memories: MemoryEntry[],
    apiConfig: ApiConfig | null,
    topK: number
): Promise<MemorySearchResult[]> {
    if (memories.length === 0) return [];

    const activeMemories = memories.filter(entry => getMemoryStatus(entry) !== "archived");
    if (activeMemories.length === 0) return [];

    const now = Date.now();
    const semanticMap = new Map<string, number>();

    if (apiConfig && resolveEmbeddingModel(apiConfig)) {
        const queryEmbedding = await generateEmbedding(query, apiConfig);
        if (queryEmbedding) {
            for (const entry of activeMemories) {
                if (entry.embedding && entry.embedding.length > 0) {
                    semanticMap.set(entry.id, cosineSimilarity(queryEmbedding, entry.embedding));
                }
            }
        }
    }

    if (semanticMap.size === 0) {
        const keywordResults = keywordSearch(query, activeMemories, topK);
        return keywordResults.map(result => ({
            entry: result.entry,
            score: scoreMemoryEntry(result.entry, result.score, now),
        }));
    }

    const scored = activeMemories.map(entry => ({
        entry,
        score: scoreMemoryEntry(entry, semanticMap.get(entry.id) ?? 0, now),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
}

// ── Keyword fallback ──

export function keywordSearch(
    query: string,
    memories: MemoryEntry[],
    topK: number
): MemorySearchResult[] {
    const queryTokens = extractTokens(query);
    if (queryTokens.length === 0) {
        // Return most recent
        return memories.slice(-topK).reverse().map(entry => ({ entry, score: 0.5 }));
    }

    const scored: MemorySearchResult[] = memories.map(entry => {
        const entryTokens = extractTokens(entry.content);
        if (entryTokens.length === 0) return { entry, score: 0 };
        let matched = 0;
        for (const qt of queryTokens) {
            if (entryTokens.some(et => et.includes(qt) || qt.includes(et))) {
                matched++;
            }
        }
        return { entry, score: matched / queryTokens.length };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(r => r.score > 0);
}

/** Extract tokens: split on punctuation/whitespace, plus CJK bigrams */
function extractTokens(text: string): string[] {
    const lower = text.toLowerCase();
    // Latin words
    const words = lower.match(/[a-zA-Z0-9]+/g) || [];
    // CJK bigrams
    const cjk = lower.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]+/g) || [];
    const bigrams: string[] = [];
    for (const seg of cjk) {
        for (let i = 0; i < seg.length - 1; i++) {
            bigrams.push(seg.slice(i, i + 2));
        }
        if (seg.length === 1) bigrams.push(seg);
    }
    return [...words, ...bigrams];
}

// ── Signal scoring (importance / valence / arousal) ──

export type MemorySignalEstimate = {
    importance: number; // 1-10，1=无关紧要的日常琐事，10=改变关系走向的关键里程碑
    valence: number;    // -1.0 (极度负面) 到 +1.0 (极度正面)
    arousal: number;    // 0.0 (平静) 到 1.0 (极其强烈)
};

const MEMORY_SIGNAL_PROMPT = `请阅读下面这段记忆内容，从三个维度给出判断。

记忆内容：
{{content}}

只返回一个 JSON 对象，不要包含任何其他文字、解释或代码块标记，格式如下：
{"importance": <1到10的整数，参考以下锚点逐档判断，不要只往两端打分：
1-2 = 转瞬即逝的寒暄客套、重复性口头语、无实质信息的过场对话，过后即可遗忘；
3-4 = 一般性闲聊话题（如随口吐槽、简单陈述），信息量低或重复度高，不涉及用户个人稳定信息；
5 = 有一定信息量但尚不确定/不稳定的内容（如临时安排、模糊表态、还需观察的苗头）；
6-7 = 用户较为稳定的个人信息（生日、职业、习惯、家庭、雷点等）、角色自己做出的决定或态度转变、双方共同做过的具体事或养成的习惯、明确说过的未来约定、尚未解决的疑问或矛盾——这类内容本身不是重大事件，但对持续理解用户、保持角色人设一致、维系关系连贯有实际价值，不要因为"不是里程碑"就打到3-4档；
8-10 = 改变关系走向的关键里程碑（表白/分手/复合/订婚/结婚/离婚、关系纪念日、同居/见家长等共同生活的重大节点）
>, "valence": <-1.0到1.0的浮点数。以下锚点仅供参考校准强度刻度，不要机械匹配括号内的具体事件——先判断内容整体的情绪基调和强弱，再对照锚点选择大致落点，遇到锚点未覆盖的情况按情绪强弱插值判断：
-1.0～-0.6 = 强烈负面（争吵、伤害、背叛、崩溃、痛失所爱）；
-0.5～-0.2 = 轻微负面（不满、尴尬、遗憾、失落、小摩擦）；
-0.1～0.1 = 中性（日常陈述、事实性信息、无明显情绪倾向的对话）；
0.2～0.5 = 轻微正面（愉快、满意、温馨、被逗笑）；
0.6～1.0 = 强烈正面（表白、狂喜、深刻感动、重大好消息）
>, "arousal": <0.0到1.0的浮点数。以下锚点同样仅供参考，不要机械匹配括号内的具体场景，判断依据是情绪的激烈/唤醒程度本身，与valence正负无关（强烈负面和强烈正面都应给高分）：
0.0～0.2 = 平静（闲聊、陈述事实，情绪波动极小）；
0.3～0.4 = 轻度波动（略有情绪但不明显，语气平和）；
0.5～0.6 = 中等强度（能感受到明确情绪起伏，但未失控）；
0.7～0.8 = 强烈（激动、崩溃、狂喜、愤怒等明显情绪外露）；
0.9～1.0 = 极端强烈（情绪失控、剧烈冲突、狂喜到语无伦次等罕见极端时刻）
>}`;

/**
 * Estimate importance/valence/arousal for a piece of memory content via a single
 * lightweight LLM call. Fails safe on any error (missing config, bad response,
 * parse failure) so callers never need extra try/catch and memory creation never
 * blocks on this.
 *
 * @param options.minImportance floor applied to the LLM's importance output (e.g. 7
 *   for core memories, which are already pre-filtered to be significant).
 * @param options.fallbackImportance importance to use when the LLM call fails
 *   entirely (no API config, parse failure, etc). Defaults to 4 — a deliberately
 *   neutral-to-low value so that a failed judgment is never mistaken for "probably
 *   important" and doesn't leak into downstream high-importance candidate pools
 *   (e.g. core-memory's minImportance: 7 filter).
 */
export async function estimateMemoryEmotion(
    content: string,
    apiConfig: ApiConfig | null,
    options: { minImportance?: number; fallbackImportance?: number } = {},
): Promise<MemorySignalEstimate> {
    const fallback: MemorySignalEstimate = {
        importance: options.fallbackImportance ?? 4,
        valence: 0,
        arousal: 0,
    };
    if (!apiConfig || !content.trim()) return fallback;

    try {
        const prompt = MEMORY_SIGNAL_PROMPT.replace("{{content}}", content.slice(0, 1500));
        const result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: prompt }],
            { temperature: 0.1 },
        );
        if (!result.content) return fallback;

        const match = result.content.match(/\{[^{}]*\}/);
        if (!match) return fallback;

        const parsed = JSON.parse(match[0]) as { importance?: unknown; valence?: unknown; arousal?: unknown };
        const importanceRaw = Number(parsed.importance);
        const valence = Number(parsed.valence);
        const arousal = Number(parsed.arousal);
        const minImportance = options.minImportance ?? 1;

        return {
            importance: Number.isFinite(importanceRaw)
                ? Math.max(minImportance, Math.min(10, Math.round(importanceRaw)))
                : fallback.importance,
            valence: Number.isFinite(valence) ? Math.max(-1, Math.min(1, valence)) : 0,
            arousal: Number.isFinite(arousal) ? Math.max(0, Math.min(1, arousal)) : 0,
        };
    } catch (err) {
        console.warn("[MemoryEmbedding] estimateMemoryEmotion failed:", err);
        return fallback;
    }
}

/** Check keyword overlap ratio between two texts */
export function keywordOverlapRatio(textA: string, textB: string): number {
    const tokensA = new Set(extractTokens(textA));
    const tokensB = new Set(extractTokens(textB));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokensA) {
        if (tokensB.has(t)) overlap++;
    }
    return overlap / Math.min(tokensA.size, tokensB.size);
}
