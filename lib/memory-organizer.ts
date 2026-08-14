// lib/memory-organizer.ts
// Memory "整理" (organize) pipeline: retrieves long-term/core memories, clusters
// near-duplicate candidates via embedding similarity, and asks an LLM to judge
// 重复/合并/矛盾 relationships. Read-only — callers apply suggestions
// via applyOrganizeMerge / applyOrganizeDuplicate / applyOrganizeConflictResolve.

import type { MemoryEntry, MemoryDomain, MemoryOrganizeSuggestion, MemoryOrganizeSuggestionType } from "./memory-types";
import { DEFAULT_ORGANIZE_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntryAndDelete,
    deleteMemoryEntries,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { cosineSimilarity, generateEmbedding, estimateMemoryEmotion } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";

/** Single-run cap: only the most recent N entries (by createdAt) are considered. */
export const MAX_ORGANIZE_ENTRIES = 500;

/** Coarse pre-filter threshold for candidate clustering — deliberately looser than
 *  core-memory's 0.85 dedup threshold, since fine-grained judgment (重复 vs.
 *  合并 vs. 矛盾 vs. unrelated) is delegated to the LLM, not decided here.
 *  Note this only controls which entries are even considered as candidates;
 *  "合并" itself is additionally gated by MERGE_SIMILARITY_THRESHOLD below.
 *  Lowered from 0.78 → 0.68: this value only decides who gets sent to the LLM
 *  for a look, not who actually gets merged/flagged — false positives here just
 *  cost an extra LLM comparison, they don't reach the user. Short paraphrased
 *  restatements (e.g. the same stated preference reworded/extended later) were
 *  falling below 0.78 and never even becoming candidates. */
export const ORGANIZE_CANDIDATE_SIMILARITY_THRESHOLD = 0.68;

/** Hard requirement for a "合并" (merge) suggestion: the entries involved must have
 *  pairwise cosine similarity at or above this threshold. Content that is merely
 *  related/similar-topic but not this close is never eligible for merging — the
 *  LLM may still propose "合并", but any suggestion that doesn't actually meet this
 *  bar is dropped before it reaches the user.
 *  Lowered from 0.90 → 0.82: 0.90 was tuned for near-identical restatements and
 *  was silently dropping legitimate merges of "same fact, reworded / extended"
 *  entries (e.g. a preference stated again later with one more detail added),
 *  which commonly land in the 0.82–0.90 range. Go lower than this only after
 *  confirming it isn't starting to approve merges of merely-related-but-distinct
 *  content — that's exactly what this floor exists to prevent. */
export const MERGE_SIMILARITY_THRESHOLD = 0.82;

/** Rough char budget per LLM batch (proxy for a token budget — good enough to keep
 *  any single organize prompt from growing unbounded). */
const ORGANIZE_BATCH_CHAR_BUDGET = 6000;

export type MemoryOrganizeResult = {
    success: boolean;
    suggestions: MemoryOrganizeSuggestion[];
    skippedCount: number;
    error?: string;
};

// ── Union-Find (disjoint set) for clustering candidate entries ──

class UnionFind {
    private parent = new Map<string, string>();

    find(x: string): string {
        if (!this.parent.has(x)) this.parent.set(x, x);
        let root = this.parent.get(x)!;
        if (root !== x) {
            root = this.find(root);
            this.parent.set(x, root);
        }
        return root;
    }

    union(a: string, b: string): void {
        const rootA = this.find(a);
        const rootB = this.find(b);
        if (rootA !== rootB) this.parent.set(rootA, rootB);
    }
}

function clusterBySimilarity(entries: MemoryEntry[], threshold: number): MemoryEntry[][] {
    const withEmbedding = entries.filter(e => Array.isArray(e.embedding) && e.embedding.length > 0);
    const uf = new UnionFind();
    for (const e of withEmbedding) uf.find(e.id); // ensure every entry has its own singleton root

    for (let i = 0; i < withEmbedding.length; i++) {
        for (let j = i + 1; j < withEmbedding.length; j++) {
            const a = withEmbedding[i];
            const b = withEmbedding[j];
            if (cosineSimilarity(a.embedding!, b.embedding!) >= threshold) {
                uf.union(a.id, b.id);
            }
        }
    }

    const groups = new Map<string, MemoryEntry[]>();
    for (const e of withEmbedding) {
        const root = uf.find(e.id);
        const bucket = groups.get(root);
        if (bucket) bucket.push(e);
        else groups.set(root, [e]);
    }

    // Only groups with 2+ entries are actual candidates for dedup/merge/conflict.
    return Array.from(groups.values()).filter(group => group.length >= 2);
}

function batchGroupsByCharBudget(groups: MemoryEntry[][], charBudget: number): MemoryEntry[][][] {
    const batches: MemoryEntry[][][] = [];
    let current: MemoryEntry[][] = [];
    let currentChars = 0;
    for (const group of groups) {
        const groupChars = group.reduce((sum, e) => sum + e.content.length, 0);
        if (current.length > 0 && currentChars + groupChars > charBudget) {
            batches.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(group);
        currentChars += groupChars;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

/**
 * Parse the structured JSON output expected from the organize prompt:
 * { "suggestions": [{ type, entryIds, reason, mergedContent? }] }
 * Same fence-stripping tolerance as parseStructuredSummaries in memory-summarizer.ts.
 * Returns null if the content isn't valid structured JSON.
 */
function parseOrganizeSuggestions(raw: string, validIds: Set<string>): Omit<MemoryOrganizeSuggestion, "id">[] | null {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch) text = fenceMatch[1].trim();

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { suggestions?: unknown }).suggestions)) {
        return null;
    }

    const validTypes: MemoryOrganizeSuggestionType[] = ["重复", "合并", "矛盾"];
    const items: Omit<MemoryOrganizeSuggestion, "id">[] = [];
    for (const rawItem of (parsed as { suggestions: unknown[] }).suggestions) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as Record<string, unknown>;
        const type = typeof item.type === "string" && (validTypes as string[]).includes(item.type)
            ? (item.type as MemoryOrganizeSuggestionType)
            : null;
        if (!type) continue;

        const rawEntryIds = Array.isArray(item.entryIds) ? item.entryIds : [];
        const entryIds = rawEntryIds.filter((id): id is string => typeof id === "string" && validIds.has(id));
        // Every id must actually be in the candidate pool we sent — guards against
        // hallucinated ids that would otherwise fail downstream lookups.
        if (entryIds.length < 2 || entryIds.length !== rawEntryIds.length) continue;

        const reason = typeof item.reason === "string" ? item.reason.trim() : "";
        const mergedContent = type === "合并" && typeof item.mergedContent === "string"
            ? item.mergedContent.trim()
            : undefined;
        if (type === "合并" && !mergedContent) continue;

        items.push({ type, entryIds, reason, mergedContent });
    }
    return items;
}

/** Minimum pairwise cosine similarity among a set of entries (using their
 *  embeddings). Entries without an embedding are treated as not similar enough
 *  (returns 0), since a "合并" claim can't be verified without one. */
function minPairwiseSimilarity(entryIds: string[], pool: Map<string, MemoryEntry>): number {
    const entries = entryIds.map(id => pool.get(id)).filter((e): e is MemoryEntry => Boolean(e));
    if (entries.length < 2) return 0;
    let min = 1;
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const a = entries[i].embedding;
            const b = entries[j].embedding;
            if (!a || !b || a.length === 0 || b.length === 0) return 0;
            min = Math.min(min, cosineSimilarity(a, b));
        }
    }
    return min;
}

/**
 * Run the full organize pipeline for a given memory type. Read-only: loads
 * entries, clusters near-duplicate candidates via embedding similarity, asks
 * the LLM to judge each cluster, and returns suggestions for the UI to present.
 * Nothing is written or deleted here — see applyOrganize* below for that.
 */
export async function runMemoryOrganizePipeline(
    characterId: string,
    characterName: string,
    type: "long_term" | "core",
): Promise<MemoryOrganizeResult> {
    const config = loadMemoryConfig();
    const allEntries = await loadMemoryEntriesByType(characterId, type);

    if (allEntries.length === 0) {
        return { success: false, suggestions: [], skippedCount: 0, error: "没有可整理的记忆" };
    }

    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, suggestions: [], skippedCount: 0, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // Truncate to the most recent MAX_ORGANIZE_ENTRIES by createdAt.
    const sorted = [...allEntries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const recent = sorted.length > MAX_ORGANIZE_ENTRIES
        ? sorted.slice(sorted.length - MAX_ORGANIZE_ENTRIES)
        : sorted;

    const skippedCount = recent.filter(e => !Array.isArray(e.embedding) || e.embedding.length === 0).length;

    const groups = clusterBySimilarity(recent, ORGANIZE_CANDIDATE_SIMILARITY_THRESHOLD);
    if (groups.length === 0) {
        return { success: true, suggestions: [], skippedCount };
    }

    const validIds = new Set(groups.flat().map(e => e.id));
    const promptTemplate = config.organizePrompt?.trim() || DEFAULT_ORGANIZE_PROMPT;
    const batches = batchGroupsByCharBudget(groups, ORGANIZE_BATCH_CHAR_BUDGET);

    const suggestions: MemoryOrganizeSuggestion[] = [];
    for (const batch of batches) {
        const candidatePool = batch.flat();
        const entriesText = candidatePool.map(e => `[${e.id}] ${e.content}`).join("\n");
        const prompt = promptTemplate
            .replace(/\{\{char\}\}/gi, characterName)
            .replace(/\{\{entries\}\}/gi, entriesText);

        let result;
        try {
            result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.2 });
        } catch (err) {
            console.warn("[MemoryOrganizer] Batch call failed:", err);
            continue;
        }
        if (!result.content || result.wasTruncated) {
            console.warn("[MemoryOrganizer] Batch failed or truncated:", result.error || result.finishReason);
            continue;
        }

        const parsed = parseOrganizeSuggestions(result.content, validIds);
        if (!parsed) continue;

        const poolById = new Map(candidatePool.map(e => [e.id, e]));
        for (const item of parsed) {
            // "合并" is only valid when the entries are actually near-duplicates
            // (>= MERGE_SIMILARITY_THRESHOLD). The LLM may still propose it for
            // content that's merely related, so this is enforced here rather than
            // trusted from the model's judgment alone.
            if (item.type === "合并" && minPairwiseSimilarity(item.entryIds, poolById) < MERGE_SIMILARITY_THRESHOLD) {
                continue;
            }
            suggestions.push({
                id: `organize_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                ...item,
            });
        }
    }

    return { success: true, suggestions, skippedCount };
}

/**
 * Apply a "合并" suggestion: save mergedContent as a new MemoryEntry, then delete
 * the source entries. Since the merged text is a fresh synthesis and no longer
 * matches any single source entry, every scored dimension is regenerated for it
 * rather than carried over: a fresh embedding is generated (falls back to
 * undefined if no embedding model is configured — same as before this entry
 * existed), and importance/valence/arousal are re-estimated via the same
 * lightweight LLM judgment used elsewhere (estimateMemoryEmotion), falling back
 * to the max importance among the source entries only if that call fails.
 *
 * Throws if the suggestion's entryIds don't fully resolve to existing entries
 * (e.g. they were already deleted/modified since the suggestion was generated),
 * rather than silently returning — a silent no-op here would leave the caller
 * believing the merge succeeded while the entry count never actually changed.
 */
export async function applyOrganizeMerge(
    characterId: string,
    suggestion: MemoryOrganizeSuggestion,
): Promise<void> {
    if (suggestion.type !== "合并" || !suggestion.mergedContent) return;

    const entries: MemoryEntry[] = [];
    for (const type of ["long_term", "core"] as const) {
        const typeEntries = await loadMemoryEntriesByType(characterId, type);
        entries.push(...typeEntries.filter(e => suggestion.entryIds.includes(e.id)));
    }
    if (entries.length === 0) {
        throw new Error("待合并的记忆条目未找到，可能已被删除或修改，请重新整理后再试");
    }
    if (entries.length < suggestion.entryIds.length) {
        throw new Error("部分待合并的记忆条目未找到，可能已被处理，请重新整理后再试");
    }

    const maxImportance = Math.max(...entries.map(e => Number.isFinite(e.importance) ? e.importance : 0));

    // Re-score the merged content from scratch (importance/valence/arousal) instead
    // of carrying over stale values from the source entries. Reuses the same
    // summarization API binding as the rest of the organize pipeline; falls back to
    // the source entries' max importance (and neutral valence/arousal) on failure.
    const scoringApiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    const signals = await estimateMemoryEmotion(suggestion.mergedContent, scoringApiConfig, {
        fallbackImportance: maxImportance,
    });

    const domainCounts = new Map<MemoryDomain, number>();
    for (const e of entries) {
        const domain = e.metadata?.domain;
        if (!domain) continue;
        domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    }
    let majorityDomain: MemoryDomain | undefined;
    let maxCount = 0;
    for (const [domain, count] of domainCounts) {
        if (count > maxCount) {
            majorityDomain = domain;
            maxCount = count;
        }
    }

    const sourceType = entries[0].type;
    const now = new Date().toISOString();

    // Merged text no longer matches any single source embedding, so regenerate
    // one for the new content. Falls back to undefined if no embedding model is
    // configured or generation fails — same as the entry having no embedding at all.
    const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
    let mergedEmbedding: number[] | undefined;
    if (embeddingApiConfig) {
        try {
            const emb = await generateEmbedding(suggestion.mergedContent, embeddingApiConfig);
            if (emb) mergedEmbedding = emb;
        } catch { /* ignore, keep undefined */ }
    }

    const mergedEntry: MemoryEntry = {
        id: `mem_${sourceType === "core" ? "core" : "lt"}_merged_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: entries[0].sourceApp,
        type: sourceType,
        content: suggestion.mergedContent,
        embedding: mergedEmbedding,
        importance: signals.importance,
        createdAt: now,
        updatedAt: now,
        metadata: {
            status: "active",
            lastReadAt: now,
            readCount: 0,
            valence: signals.valence,
            arousal: signals.arousal,
            origin: "user_manual",
            domain: majorityDomain,
        },
    };

    await saveMemoryEntryAndDelete(mergedEntry, entries.map(e => e.id));
}

/** Apply a "重复" suggestion: delete every entry the user marked for deletion
 *  (a suggestion may involve 2+ entries; whichever the user keeps is simply
 *  left untouched). */
export async function applyOrganizeDuplicate(deleteIds: string[]): Promise<void> {
    if (deleteIds.length === 0) return;
    await deleteMemoryEntries(deleteIds);
}

/** Apply a "矛盾" resolution: delete every entry the user marked for deletion.
 *  "忽略" (ignore, keep all) is handled entirely on the frontend (local
 *  dismiss) and never calls this. */
export async function applyOrganizeConflictResolve(deleteIds: string[]): Promise<void> {
    if (deleteIds.length === 0) return;
    await deleteMemoryEntries(deleteIds);
}
