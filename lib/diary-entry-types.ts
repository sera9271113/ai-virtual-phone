export type DiaryEntryTrigger = "manual" | "timer";

// characterId used for entries the user writes about themselves (as opposed
// to entries a character writes). Shared here so any module that needs to
// distinguish "my own diary" from "a character's diary" (e.g. the memory
// share feature, which only makes sense for the user's own entries) uses the
// same literal instead of redefining it locally.
export const SELF_ENTRY_CHARACTER_ID = "__self__";

export type DiaryEntryTodoItem = {
  text: string;
  done: boolean;
};

export type DiaryEntryBlock =
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "correction"; text: string; replacement?: string }
  | { type: "todo"; title?: string; items: DiaryEntryTodoItem[] }
  | { type: "image"; caption?: string; description: string };

export type DiaryEntry = {
  id: string;
  characterId: string;
  characterName: string;
  title: string;
  dateLabel: string;
  mood: string;
  weather: string;
  tags: string[];
  body: string;
  blocks: DiaryEntryBlock[];
  trigger: DiaryEntryTrigger;
  createdAt: string;
  updatedAt: string;
  // Character ids this entry has already been shared into (as a long-term
  // memory). Only ever populated for entries the user wrote themselves —
  // see SELF_ENTRY_CHARACTER_ID — but kept on the general type since storage
  // normalization is shared across all entries.
  sharedCharacterIds: string[];
};

export type DiaryEntryInput = {
  characterId: string;
  characterName: string;
  title: string;
  dateLabel?: string;
  mood?: string;
  weather?: string;
  tags?: string[];
  body: string;
  blocks: DiaryEntryBlock[];
  trigger?: DiaryEntryTrigger;
};

export type DiaryEntryTimerSettings = {
  enabled: boolean;
  intervalHours: number;
  characterIds: string[];
  lastRunAtByCharacter: Record<string, string>;
};

export const DEFAULT_DIARY_ENTRY_TIMER_SETTINGS: DiaryEntryTimerSettings = {
  enabled: false,
  intervalHours: 24,
  characterIds: [],
  lastRunAtByCharacter: {},
};
