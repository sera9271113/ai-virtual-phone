import type { DiaryEntry } from "./diary-entry-types";
import { markDiaryEntrySharedWithCharacters } from "./diary-entry-storage";

export type DiaryShareResult = {
  succeeded: string[];
  failed: string[];
};

/**
 * Shares a user-written diary entry (characterId === SELF_ENTRY_CHARACTER_ID)
 * into the given characters' short-term memory. Only meant to be called for
 * entries authored by the user themselves — callers are responsible for that
 * check, since this function has no opinion about who wrote the entry.
 *
 * There is no separate "add to short-term memory" store to write into: the
 * short-term event stream (short-term-assembler.ts's loadNativeTimeline) is
 * assembled on the fly straight from each app's own data. For diary entries
 * specifically, it reads diary-entry-storage.ts's entries and includes a
 * self-written entry for a given character exactly when that character's id
 * is in entry.sharedCharacterIds. So "sharing" IS setting that field — there
 * is nothing else to persist. (An earlier version of this function tried to
 * additionally save a MemoryEntry into the long-term memory store, which was
 * both the wrong store for "short-term" and, on top of that, used an invalid
 * MemoryEntry.type value that no reader ever queried for — so it silently
 * did nothing either way.)
 *
 * Characters that already have this entry (per entry.sharedCharacterIds)
 * should be filtered out by the caller before invoking this — sharing is
 * additive per character, not idempotent-safe here.
 */
export async function shareDiaryEntryWithCharacters(
  entry: DiaryEntry,
  characterIds: string[],
): Promise<DiaryShareResult> {
  const targets = Array.from(new Set(characterIds.filter(Boolean)));
  if (targets.length === 0) return { succeeded: [], failed: [] };

  const updated = markDiaryEntrySharedWithCharacters(entry.id, targets);
  if (!updated) {
    console.warn("[DiaryMemoryShare] failed to mark diary entry as shared:", entry.id, targets);
    return { succeeded: [], failed: targets };
  }

  return { succeeded: targets, failed: [] };
}
