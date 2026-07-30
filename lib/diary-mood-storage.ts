import { kvGet, kvSet, registerKvMigration } from "./kv-db";

// Simplified: mood is the *user's* mood for a given day, not per-character.
// Characters read this when writing a diary entry so they're aware of how
// the user felt that day. Stored as a single dateKey -> moodId JSON blob.

export type MoodId =
  | "happy"
  | "calm"
  | "sad"
  | "angry"
  | "tired"
  | "excited"
  | "anxious"
  | "emo"
  | "love"
  | "surprised";

export type MoodOption = {
  id: MoodId;
  label: string;
};

export const MOOD_OPTIONS: MoodOption[] = [
  { id: "happy", label: "开心" },
  { id: "calm", label: "平静" },
  { id: "sad", label: "难过" },
  { id: "angry", label: "生气" },
  { id: "tired", label: "疲惫" },
  { id: "excited", label: "兴奋" },
  { id: "anxious", label: "焦虑" },
  { id: "emo", label: "emo" },
  { id: "love", label: "爱意" },
  { id: "surprised", label: "惊讶" },
];

const MOOD_LABEL_BY_ID: Record<MoodId, string> = MOOD_OPTIONS.reduce((map, option) => {
  map[option.id] = option.label;
  return map;
}, {} as Record<MoodId, string>);

export function getMoodLabel(id: MoodId | string | null | undefined): string {
  if (!id) return "";
  return MOOD_LABEL_BY_ID[id as MoodId] ?? "";
}

export function isMoodId(value: unknown): value is MoodId {
  return typeof value === "string" && value in MOOD_LABEL_BY_ID;
}

const MOOD_CALENDAR_KEY = "ai_phone_diary_user_mood_calendar_v1";
registerKvMigration(MOOD_CALENDAR_KEY);

export type MoodCalendarMap = Record<string, MoodId>;

export function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function loadMoodCalendar(): MoodCalendarMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = kvGet(MOOD_CALENDAR_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const result: MoodCalendarMap = {};
    for (const [dateKey, moodId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof dateKey === "string" && isMoodId(moodId)) result[dateKey] = moodId;
    }
    return result;
  } catch {
    return {};
  }
}

function saveMoodCalendar(map: MoodCalendarMap): void {
  if (typeof window === "undefined") return;
  kvSet(MOOD_CALENDAR_KEY, JSON.stringify(map));
}

export function setMoodForDate(dateKey: string, moodId: MoodId | null): MoodCalendarMap {
  const current = loadMoodCalendar();
  const next = { ...current };
  if (moodId) {
    next[dateKey] = moodId;
  } else {
    delete next[dateKey];
  }
  saveMoodCalendar(next);
  return next;
}

export function getTodayMoodLabel(): string {
  const map = loadMoodCalendar();
  const todayKey = formatDateKey(new Date());
  return getMoodLabel(map[todayKey]);
}
