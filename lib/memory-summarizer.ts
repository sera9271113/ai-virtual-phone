// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry, MemoryDomain } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT, MEMORY_DOMAIN_ORDER } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel, estimateMemoryEmotion } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

type ParsedSummaryItem = {
    content: string;
    domain?: MemoryDomain;
    domainConfidence?: number;
};

/**
 * Parse the structured JSON output expected from DEFAULT_SUMMARIZATION_PROMPT:
 * { "summaries": [{ content, domain, domainConfidence }] }
 * Returns null if the content isn't valid structured JSON (caller should fall back
 * to treating the raw text as a single undomained summary).
 */
function parseStructuredSummaries(raw: string): ParsedSummaryItem[] | null {
    let text = raw.trim();
    // Strip common code-block fences the LLM might still wrap the JSON in.
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch) text = fenceMatch[1].trim();

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { summaries?: unknown }).summaries)) {
        return null;
    }

    const items: ParsedSummaryItem[] = [];
    for (const rawItem of (parsed as { summaries: unknown[] }).summaries) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as Record<string, unknown>;
        const content = typeof item.content === "string" ? item.content.trim() : "";
        if (!content) continue;
        const domain = typeof item.domain === "string" && (MEMORY_DOMAIN_ORDER as string[]).includes(item.domain)
            ? (item.domain as MemoryDomain)
            : undefined;
        const domainConfidence = typeof item.domainConfidence === "number" ? item.domainConfidence : undefined;
        items.push({ content, domain, domainConfidence });
    }
    return items.length > 0 ? items : null;
}

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const counter = getEventCounter(characterId);
    if (counter < config.summarizationEventInterval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName);
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: { force?: boolean }
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force ? undefined : (getLastSummarizedTimestamp(characterId) ?? undefined);
    const allEntries = loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined);

    if (allEntries.length < 4) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) return { success: false, error: "格式化事件数据失败" };

    const { eventsText, earliest, latest } = formatted;

    // Use user-editable prompt template from config, with placeholder substitution
    const promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;
    const summaryPrompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText);

    // Call LLM for summarization — compatible with all providers
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: summaryPrompt }],
        { temperature: 0.3 },
    );

    if (!result.content) {
        return { success: false, error: result.error || "LLM 返回了空内容" };
    }

    if (result.wasTruncated) {
        console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
        return { success: false, error: "记忆总结结果疑似被截断，已取消入库，请稍后重试或提高模型输出上限" };
    }

    // Parse structured multi-domain output. If the LLM didn't comply with the JSON
    // format (older models, format drift), fall back to treating the whole response
    // as a single undomained summary — this preserves the old behavior and guarantees
    // this batch of events is never silently dropped.
    const parsedItems = parseStructuredSummaries(result.content)
        ?? [{ content: result.content.trim() } as ParsedSummaryItem];

    // Determine sourceApp: use the most common source among summarized entries
    const sourceCounts = new Map<string, number>();
    for (const e of allEntries) {
        sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
    }
    let dominantSource = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src; maxCount = count; }
    }
    const sourceSessionIds = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));

    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    const canEmbed = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig));

    let savedCount = 0;
    for (const item of parsedItems) {
        if (!item.content) continue;

        // Generate embedding for this summary (only if vector recall is enabled)
        let embedding: number[] | undefined;
        if (canEmbed && embeddingApiConfig) {
            try {
                const emb = await generateEmbedding(item.content, embeddingApiConfig);
                if (emb) embedding = emb;
            } catch { /* ignore */ }
        }

        // Estimate importance/valence/arousal for this summary via a lightweight LLM call.
        // Reuses the same summarization API config; fails safe to {importance: 4, valence: 0,
        // arousal: 0} on error — a neutral-to-low fallback so a failed judgment is never
        // mistaken for "probably important" and doesn't leak into the core-memory
        // candidate pool (minImportance: 7).
        const signals = await estimateMemoryEmotion(item.content, apiConfig, { fallbackImportance: 4 });

        const now = new Date().toISOString();
        const longTermEntry: MemoryEntry = {
            id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId,
            sourceApp: dominantSource as MemoryEntry["sourceApp"],
            type: "long_term",
            content: item.content,
            embedding,
            importance: signals.importance,
            createdAt: now,
            updatedAt: now,
            metadata: {
                status: "active",
                lastReadAt: now,
                readCount: 0,
                valence: signals.valence,
                arousal: signals.arousal,
                summarizedEvents: allEntries.length,
                timeSpan: `${earliest} ~ ${latest}`,
                sourceSessionIds,
                domain: item.domain,
                domainConfidence: item.domainConfidence,
            },
        };
        await saveMemoryEntry(longTermEntry);
        savedCount++;
    }

    // Update last summarized timestamp + reset counter
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    // Enforce long-term limit
    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    for (let index = 0; index < savedCount; index++) {
        incrementCoreMemoryCounter(characterId);
    }
    await maybeRunCoreMemoryPipeline(characterId, characterName);

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → ${savedCount} long-term memories across domains`);
    return { success: true };
}
