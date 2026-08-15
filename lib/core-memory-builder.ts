import type { ApiConfig } from "./settings-types";
import type { MemoryEntry, MemoryDomain } from "./memory-types";
import { DEFAULT_CORE_MEMORY_PROMPT, buildDomainCoreMemoryPromptTemplate, MEMORY_DOMAIN_SIGNALS_TEXT, MEMORY_DOMAIN_ORDER } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    getCoreMemoryCounter,
    resetCoreMemoryCounter,
    getLastCoreSummarizedTimestamp,
    setLastCoreSummarizedTimestamp,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { estimateMemoryEmotion, generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";

const coreBuildingSet = new Set<string>();

/** Domain-within-core dedup threshold: cosine similarity above this is treated as a duplicate. */
const CORE_DEDUP_SIMILARITY_THRESHOLD = 0.85;

/** Below this domainConfidence, a tagged domain is not trusted and the entry is
 *  routed into the unclassified/misc reclassification pass instead of being taken
 *  at face value — matches the same threshold used elsewhere in the UI. */
const DOMAIN_CONFIDENCE_THRESHOLD = 0.6;

/** If the misc bucket (after the reclassification pass) still has more entries than
 *  this, split it into multiple token-budgeted summarization batches instead of
 *  stuffing everything into a single prompt. */
const MISC_BATCH_SPLIT_THRESHOLD = 20;

/** Rough char budgets for the reclassification pass and misc-bucket summarization
 *  batches. Char-based (not a real tokenizer) but good enough to keep any single
 *  prompt from growing unbounded. */
const RECLASSIFY_BATCH_CHAR_BUDGET = 4000;
const MISC_SUMMARY_BATCH_CHAR_BUDGET = 6000;

type CoreTimelineItem = {
    id: string;
    timestamp: string;
    content: string;
    sourceApp: MemoryEntry["sourceApp"];
    sourceSessionIds: string[];
    domain?: MemoryDomain;
    domainConfidence?: number;
};

type CoreDomainGroupKey = MemoryDomain | "unclassified";

function formatCoreTimelineForSummarization(
    entries: CoreTimelineItem[],
): { eventsText: string; earliest: string; latest: string; count: number } | null {
    if (entries.length === 0) return null;
    return {
        eventsText: entries.map(entry => `- ${entry.content}`).join("\n"),
        earliest: entries[0].timestamp,
        latest: entries[entries.length - 1].timestamp,
        count: entries.length,
    };
}

/** Split a list into char-budgeted batches (rough token proxy — good enough to
 *  keep any single prompt from growing unbounded). Always returns at least one
 *  batch (even if a single item alone exceeds the budget). */
function batchByCharBudget<T>(items: T[], charBudget: number, getText: (item: T) => string): T[][] {
    const batches: T[][] = [];
    let current: T[] = [];
    let currentChars = 0;
    for (const item of items) {
        const len = getText(item).length;
        if (current.length > 0 && currentChars + len > charBudget) {
            batches.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(item);
        currentChars += len;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

/** Lightweight reclassification prompt for the unclassified/misc reprocessing pass.
 *  Only asks for {entryId, domain, confidence} — no summary text — to keep this
 *  pass cheap. Placeholders: {{entries}} (formatted as `[id] content` per line). */
const RECLASSIFY_PROMPT_TEMPLATE = `请阅读以下记忆条目，判断每条最合适归入的记忆域。

记忆域判定信号：
${MEMORY_DOMAIN_SIGNALS_TEXT}

记忆条目（格式为 [id] 内容）：
{{entries}}

要求：
- 逐一比对判定信号，只有确实找不到合适归属时才用 misc
- confidence 为 0 到 1 之间的小数，表示分类置信度
- 只返回如下 JSON，不要包含任何其他文字、解释或代码块标记：

{"results":[{"entryId":"...","domain":"bond","confidence":0.8}]}`;

type ReclassifyResultItem = { entryId: string; domain: MemoryDomain; confidence?: number };

/** Parse the structured JSON output of RECLASSIFY_PROMPT_TEMPLATE, with the same
 *  fence-stripping tolerance as the summarization parser. Returns null on any
 *  format failure so the caller can safely leave those entries in misc. */
function parseReclassifyResults(raw: string): ReclassifyResultItem[] | null {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch) text = fenceMatch[1].trim();

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { results?: unknown }).results)) {
        return null;
    }

    const items: ReclassifyResultItem[] = [];
    for (const rawItem of (parsed as { results: unknown[] }).results) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as Record<string, unknown>;
        const entryId = typeof item.entryId === "string" ? item.entryId : "";
        const domain = typeof item.domain === "string" && (MEMORY_DOMAIN_ORDER as string[]).includes(item.domain)
            ? (item.domain as MemoryDomain)
            : null;
        if (!entryId || !domain) continue;
        const confidence = typeof item.confidence === "number" ? item.confidence : undefined;
        items.push({ entryId, domain, confidence });
    }
    return items.length > 0 ? items : null;
}

/**
 * Re-run classification on the unclassified/misc pool before final summarization.
 * Returns a Map of entryId → newly-assigned domain for entries that were
 * successfully classified into one of the seven real domains (i.e. NOT misc —
 * a misc result here isn't progress, so it's treated the same as "no result").
 */
async function reclassifyMiscEntries(
    entries: CoreTimelineItem[],
    apiConfig: ApiConfig,
): Promise<Map<string, MemoryDomain>> {
    const resultMap = new Map<string, MemoryDomain>();
    if (entries.length === 0) return resultMap;

    const batches = batchByCharBudget(entries, RECLASSIFY_BATCH_CHAR_BUDGET, e => e.content);
    for (const batch of batches) {
        const entriesText = batch.map(e => `[${e.id}] ${e.content}`).join("\n");
        const prompt = RECLASSIFY_PROMPT_TEMPLATE.replace(/\{\{entries\}\}/gi, entriesText);

        let result;
        try {
            result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.1 });
        } catch (err) {
            console.warn("[CoreMemory] Reclassify batch call failed:", err);
            continue;
        }
        if (!result.content) continue;

        const parsedResults = parseReclassifyResults(result.content);
        if (!parsedResults) continue;

        const batchIds = new Set(batch.map(e => e.id));
        for (const item of parsedResults) {
            if (!batchIds.has(item.entryId)) continue; // guard against hallucinated ids
            if (item.domain === "misc") continue; // not a successful reclassification
            resultMap.set(item.entryId, item.domain);
        }
    }
    return resultMap;
}

export async function runCoreMemoryPipeline(
    characterId: string,
    characterName: string,
    options?: { force?: boolean },
): Promise<{ success: boolean; error?: string; rebuiltCount?: number }> {
    const config = loadMemoryConfig();
    const allLongTermEntries = await loadMemoryEntriesByType(characterId, "long_term");

    if (allLongTermEntries.length === 0) {
        return { success: false, error: "没有可用于总结核心记忆的长期记忆" };
    }

    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    const afterTimestamp = options?.force ? undefined : (getLastCoreSummarizedTimestamp(characterId) ?? undefined);
    const entries = allLongTermEntries
        .filter(entry => !afterTimestamp || entry.createdAt > afterTimestamp)
        .map(entry => ({
            id: entry.id,
            timestamp: entry.createdAt,
            content: entry.content,
            sourceApp: entry.sourceApp,
            sourceSessionIds: Array.isArray(entry.metadata?.sourceSessionIds)
                ? entry.metadata.sourceSessionIds.map(String)
                : [],
            domain: entry.metadata?.domain,
            domainConfidence: entry.metadata?.domainConfidence,
        }))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (entries.length === 0) {
        if (!options?.force) resetCoreMemoryCounter(characterId);
        return { success: false, error: "没有新的长期记忆需要总结" };
    }

    // Existing core memories, needed for per-domain cosine-similarity dedup.
    const allCoreEntries = await loadMemoryEntriesByType(characterId, "core");

    // Group pending long-term entries by domain — this is what makes per-domain
    // extraction possible instead of collapsing everything into one blended summary.
    // A tagged domain is only trusted when its confidence clears the threshold (or
    // confidence is simply absent, e.g. manually-picked domains); low-confidence
    // and untagged entries both fall into "unclassified" so they get a second look
    // in the reclassification pass below, instead of silently piling up in misc.
    const pendingByDomain = new Map<CoreDomainGroupKey, CoreTimelineItem[]>();
    for (const entry of entries) {
        const trustedDomain = entry.domain
            && (typeof entry.domainConfidence !== "number" || entry.domainConfidence >= DOMAIN_CONFIDENCE_THRESHOLD)
            ? entry.domain
            : undefined;
        const key: CoreDomainGroupKey = trustedDomain ?? "unclassified";
        const bucket = pendingByDomain.get(key);
        if (bucket) bucket.push(entry);
        else pendingByDomain.set(key, [entry]);
    }

    // ── Reclassification pre-pass ──
    // Entries that landed in "unclassified" (low/no confidence) or explicitly "misc"
    // get one more lightweight classification attempt before final summarization.
    // Entries successfully reclassified into one of the seven real domains are moved
    // out of their original bucket; only genuinely unclassifiable entries stay behind.
    const reclassifyCandidates: CoreTimelineItem[] = [
        ...(pendingByDomain.get("unclassified") ?? []),
        ...(pendingByDomain.get("misc") ?? []),
    ];
    if (reclassifyCandidates.length > 0) {
        const reclassifyMap = await reclassifyMiscEntries(reclassifyCandidates, apiConfig);
        if (reclassifyMap.size > 0) {
            for (const bucketKey of ["unclassified", "misc"] as CoreDomainGroupKey[]) {
                const bucket = pendingByDomain.get(bucketKey);
                if (!bucket) continue;
                const remaining: CoreTimelineItem[] = [];
                for (const item of bucket) {
                    const newDomain = reclassifyMap.get(item.id);
                    if (newDomain) {
                        const target = pendingByDomain.get(newDomain);
                        if (target) target.push(item);
                        else pendingByDomain.set(newDomain, [item]);
                    } else {
                        remaining.push(item);
                    }
                }
                if (remaining.length > 0) pendingByDomain.set(bucketKey, remaining);
                else pendingByDomain.delete(bucketKey);
            }
        }
    }

    // Merge whatever remains of "unclassified" into "misc" — after the reclassification
    // pass, both buckets mean the same thing ("couldn't be classified"), and misc is the
    // one that carries a stable, user-facing identity/prompt focus.
    const leftoverUnclassified = pendingByDomain.get("unclassified");
    if (leftoverUnclassified && leftoverUnclassified.length > 0) {
        const miscBucket = pendingByDomain.get("misc");
        if (miscBucket) miscBucket.push(...leftoverUnclassified);
        else pendingByDomain.set("misc", leftoverUnclassified);
    }
    pendingByDomain.delete("unclassified");

    let latestOverall = entries[entries.length - 1].timestamp;
    let rebuiltCount = 0;
    const promptTemplate = config.coreMemoryPrompt?.trim() || DEFAULT_CORE_MEMORY_PROMPT;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;

    async function summarizeDomainBatch(
        domain: CoreDomainGroupKey,
        domainEntries: CoreTimelineItem[],
    ): Promise<void> {
        const formatted = formatCoreTimelineForSummarization(domainEntries);
        if (!formatted) return;
        const { eventsText, earliest, latest } = formatted;

        const domainPromptTemplate = buildDomainCoreMemoryPromptTemplate(promptTemplate, domain);
        const prompt = domainPromptTemplate
            .replace(/\{\{char\}\}/gi, characterName)
            .replace(/\{\{earliest\}\}/gi, earliest)
            .replace(/\{\{latest\}\}/gi, latest)
            .replace(/\{\{events\}\}/gi, eventsText)
            .replace(/\{\{longTermMemories\}\}/gi, eventsText);

        const result = await simpleLLMCall(
            apiConfig as ApiConfig,
            [{ role: "user", content: prompt }],
            { temperature: 0.3 },
        );

        if (!result.content || result.wasTruncated) {
            console.warn(`[CoreMemory] Domain "${domain}" summary failed or truncated:`, result.error || result.finishReason);
            return;
        }

        const summary = result.content.trim();
        if (!summary) return;

        // Estimate importance/valence/arousal for the core summary. Core memories are
        // already pre-filtered to be significant, so importance has a floor of 7 (still
        // lets truly pivotal events like marriage/breakup score higher than routine ones).
        const signals = await estimateMemoryEmotion(summary, apiConfig as ApiConfig, { minImportance: 7, fallbackImportance: 9 });

        // Per-domain dedup via cosine similarity against existing core memories in the same domain.
        let domainEmbedding: number[] | undefined;
        if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
            try {
                const emb = await generateEmbedding(summary, embeddingApiConfig);
                if (emb) domainEmbedding = emb;
            } catch { /* ignore */ }
        }

        const existingCoreInDomain = allCoreEntries.filter(
            e => (e.metadata?.domain ?? "unclassified") === domain,
        );
        const isDuplicate = Boolean(domainEmbedding) && existingCoreInDomain.some(
            e => e.embedding && domainEmbedding && cosineSimilarity(e.embedding, domainEmbedding) > CORE_DEDUP_SIMILARITY_THRESHOLD,
        );
        if (isDuplicate) {
            if (latest > latestOverall) latestOverall = latest;
            return;
        }

        const sourceCounts = new Map<string, number>();
        for (const entry of domainEntries) {
            sourceCounts.set(entry.sourceApp, (sourceCounts.get(entry.sourceApp) || 0) + 1);
        }
        let dominantSource: MemoryEntry["sourceApp"] = "chat";
        let maxCount = 0;
        for (const [src, count] of sourceCounts) {
            if (count > maxCount) {
                dominantSource = src as MemoryEntry["sourceApp"];
                maxCount = count;
            }
        }
        const sourceSessionIds = Array.from(new Set(domainEntries.flatMap(entry => entry.sourceSessionIds)));

        const now = new Date().toISOString();
        const coreEntry: MemoryEntry = {
            id: `mem_core_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId,
            sourceApp: dominantSource,
            type: "core",
            content: summary,
            embedding: domainEmbedding,
            importance: signals.importance,
            createdAt: now,
            updatedAt: now,
            metadata: {
                status: "active",
                lastReadAt: now,
                readCount: 0,
                valence: signals.valence,
                arousal: signals.arousal,
                summarizedLongTermEntries: domainEntries.length,
                timeSpan: `${earliest} ~ ${latest}`,
                sourceSessionIds,
                domain: domain === "unclassified" ? undefined : domain,
            },
        };
        await saveMemoryEntry(coreEntry);
        allCoreEntries.push(coreEntry);
        rebuiltCount++;

        if (latest > latestOverall) latestOverall = latest;
    }

    for (const [domain, domainEntries] of pendingByDomain) {
        // The misc bucket can grow large (it's the catch-all for everything that
        // couldn't be classified even after the reclassification pass) — split it
        // into token-budgeted batches instead of stuffing everything into one prompt.
        if (domain === "misc" && domainEntries.length > MISC_BATCH_SPLIT_THRESHOLD) {
            const batches = batchByCharBudget(domainEntries, MISC_SUMMARY_BATCH_CHAR_BUDGET, e => e.content);
            for (const batch of batches) {
                await summarizeDomainBatch(domain, batch);
            }
        } else {
            await summarizeDomainBatch(domain, domainEntries);
        }
    }

    setLastCoreSummarizedTimestamp(characterId, latestOverall);
    if (!options?.force) {
        resetCoreMemoryCounter(characterId);
    }

    if (rebuiltCount === 0) {
        return { success: false, error: "核心记忆总结失败或所有域均已存在近似内容", rebuiltCount: 0 };
    }

    return { success: true, rebuiltCount };
}

export async function maybeRunCoreMemoryPipeline(
    characterId: string,
    characterName: string,
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoBuildCoreEnabled) return;

    const counter = getCoreMemoryCounter(characterId);
    if (counter < config.coreSummarizationInterval) return;

    if (coreBuildingSet.has(characterId)) return;
    coreBuildingSet.add(characterId);
    try {
        const result = await runCoreMemoryPipeline(characterId, characterName);
        if (!result.success) {
            console.warn("[CoreMemory] Auto summary failed:", result.error);
        }
    } finally {
        coreBuildingSet.delete(characterId);
    }
}
