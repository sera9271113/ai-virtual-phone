import type { Prompt, PromptOrderEntry } from "./settings-types";

const PRESET_TRANSFER_KEY = "ai_phone_preset_transfer_v1";

export type PresetTransferItem = {
    prompt: Prompt;
    orderEntry: PromptOrderEntry;
};

export type PresetTransferPackage = {
    sourcePresetId: string;
    sourcePresetName: string;
    savedAt: number;
    items: PresetTransferItem[];
};

export function loadPresetTransferPackage(): PresetTransferPackage | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(PRESET_TRANSFER_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PresetTransferPackage;
        if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function savePresetTransferPackage(pkg: PresetTransferPackage): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PRESET_TRANSFER_KEY, JSON.stringify(pkg));
}

export function clearPresetTransferPackage(): void {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(PRESET_TRANSFER_KEY);
}
