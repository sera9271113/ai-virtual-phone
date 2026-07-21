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
    if (!Number.isFinite(importance)) return 0;
    if (importance <= 1) {
        return Math.max(0, Math.min(1, importance));
    }
    return Math.max(1, Math.min(10, importance)) / 10;
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
    return Math.max(0, Math.min(1, Math.exp(-0.02 * ageHours / (1 + 0.15 * getReadCount(entry)))));
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

    return (
        normalizedSemantic * 0.4
        + normalizedImportance * 0.4
        + recencyScore * 0.2
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
{"importance": <1到10的整数，1=无关紧要的日常琐事，10=改变关系走向的关键里程碑（表白/分手/结婚/重大承诺等）>, "valence": <-1.0到1.0的浮点数，负面到正面>, "arousal": <0.0到1.0的浮点数，平静到强烈>}`;

/**
 * Estimate importance/valence/arousal for a piece of memory content via a single
 * lightweight LLM call. Fails safe on any error (missing config, bad response,
 * parse failure) so callers never need extra try/catch and memory creation never
 * blocks on this.
 *
 * @param options.minImportance floor applied to the LLM's importance output (e.g. 7
 *   for core memories, which are already pre-filtered to be significant).
 * @param options.fallbackImportance importance to use when the LLM call fails
 *   entirely (no API config, parse failure, etc). Defaults to minImportance ?? 5.
 */
export async function estimateMemorySignals(
    content: string,
    apiConfig: ApiConfig | null,
    options: { minImportance?: number; fallbackImportance?: number } = {},
): Promise<MemorySignalEstimate> {
    const fallback: MemorySignalEstimate = {
        importance: options.fallbackImportance ?? options.minImportance ?? 5,
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
        console.warn("[MemoryEmbedding] estimateMemorySignals failed:", err);
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
