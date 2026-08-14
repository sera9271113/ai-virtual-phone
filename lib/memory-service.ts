// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType, saveMemoryEntry } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { searchMemories, scoreMemoryEntry, getMemoryStatus } from "./memory-embedding";
import { estimateTokens } from "./token-counter";

/**
 * Bump readCount / lastReadAt for memories that actually got selected for prompt
 * injection — this is the real "唤醒" (wake) event, not just viewing them in the
 * memory bank UI. Fire-and-forget: storage writes never block prompt assembly,
 * and a failed write here should not fail the chat turn.
 */
function touchMemories(entries: MemoryEntry[]): void {
    if (entries.length === 0) return;
    const now = new Date().toISOString();
    for (const entry of entries) {
        const prevReadCount = Number(entry.metadata?.readCount ?? 0);
        entry.metadata = {
            ...(entry.metadata ?? {}),
            readCount: Number.isFinite(prevReadCount) ? prevReadCount + 1 : 1,
            lastReadAt: now,
        };
        saveMemoryEntry(entry).catch(err => {
            console.warn("[MemoryService] Failed to update memory read stats:", err);
        });
    }
}

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Archived memories are always excluded.
 *   2. Remaining active/sleeping entries all fit within longTermTokenBudget → return all.
 *   3. Over budget → rank via searchMemories() (semantic score × importance × recency ×
 *      status weight when an embedding API is configured, keyword score otherwise), then
 *      fill by token budget in ranked order.
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 * Selected entries have their readCount/lastReadAt updated as a side effect.
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    const activeEntries = longTermEntries.filter(entry => getMemoryStatus(entry) !== "archived");
    if (activeEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all active entries
    let totalTokens = 0;
    for (const entry of activeEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    let selected: MemoryEntry[];

    if (totalTokens <= budget) {
        // Everything fits — no need to rank, just return in existing (chronological) order.
        selected = activeEntries;
    } else {
        // Over budget: rank by semantic/keyword relevance × importance × recency × status,
        // then fill greedily by token budget. searchMemories() already handles the
        // embedding→keyword fallback and archived filtering internally.
        const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
        const ranked = await searchMemories(currentContext, activeEntries, embeddingApiConfig, activeEntries.length);
        selected = fillByBudget(ranked.map(r => r.entry), budget);
    }

    touchMemories(selected);
    return selected;
}

/**
 * Retrieve core memories for prompt injection.
 * Archived core memories are excluded; remaining entries are ranked by
 * importance × recency × status weight (active > sleeping) via scoreMemoryEntry,
 * then filled by token budget. Selected entries have readCount/lastReadAt updated.
 */
export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    const activeEntries = coreEntries.filter(entry => getMemoryStatus(entry) !== "archived");
    if (activeEntries.length === 0) return [];

    const now = Date.now();
    const scored = activeEntries.map(entry => ({
        entry,
        // No search query for core memories — rank purely on importance/recency/status.
        score: scoreMemoryEntry(entry, 0, now),
    }));
    scored.sort((a, b) => b.score - a.score);

    const selected = fillByBudget(scored.map(s => s.entry), config.coreMemoryTokenBudget);
    touchMemories(selected);
    return selected;
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}
