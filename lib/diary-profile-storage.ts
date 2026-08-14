import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

// Nickname + avatar are read directly from the system user identity
// (resolveUserIdentity) and are NOT editable here. Only the signature line
// and the Home page's cover/background image are local to the diary app.

const SIGNATURE_KEY = "ai_phone_diary_home_signature_v1";
const BG_IMAGE_KEY = "ai_phone_diary_home_bg_image_v1";

registerKvMigration(SIGNATURE_KEY);
registerKvMigration(BG_IMAGE_KEY);

export function loadDiarySignature(): string {
  if (typeof window === "undefined") return "";
  return kvGet(SIGNATURE_KEY) || "";
}

export function saveDiarySignature(text: string): void {
  if (typeof window === "undefined") return;
  const trimmed = text.replace(/\s+/g, " ").trim().slice(0, 60);
  if (trimmed) {
    kvSet(SIGNATURE_KEY, trimmed);
  } else {
    kvRemove(SIGNATURE_KEY);
  }
}

export function loadDiaryBackgroundImage(): string {
  if (typeof window === "undefined") return "";
  return kvGet(BG_IMAGE_KEY) || "";
}

export function saveDiaryBackgroundImage(dataUrl: string): void {
  if (typeof window === "undefined") return;
  kvSet(BG_IMAGE_KEY, dataUrl);
}

export function clearDiaryBackgroundImage(): void {
  if (typeof window === "undefined") return;
  kvRemove(BG_IMAGE_KEY);
}
