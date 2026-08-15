import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";

const SHOPPING_EVENT_PREFIX = "ai_phone_shopping_memory_events_";
const MAX_EVENTS_PER_CHARACTER = 120;

registerDynamicPrefix(SHOPPING_EVENT_PREFIX);

export type ShoppingMemoryEntry = {
    id: string;
    timestamp: string;
    content: string;
};

function storageKey(characterId: string): string {
    return `${SHOPPING_EVENT_PREFIX}${characterId}`;
}

function loadEvents(characterId: string): ShoppingMemoryEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(storageKey(characterId));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((entry): entry is ShoppingMemoryEntry =>
                entry
                && typeof entry.id === "string"
                && typeof entry.timestamp === "string"
                && typeof entry.content === "string"
            )
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } catch {
        return [];
    }
}

export function recordShoppingPaymentEvent(input: {
    characterId: string;
    orderId: string;
    timestamp: string;
    content: string;
}): void {
    if (typeof window === "undefined") return;
    const events = loadEvents(input.characterId).filter(entry => entry.id !== `shopping_payment_${input.orderId}`);
    events.push({
        id: `shopping_payment_${input.orderId}`,
        timestamp: input.timestamp,
        content: input.content,
    });
    kvSet(storageKey(input.characterId), JSON.stringify(
        events.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-MAX_EVENTS_PER_CHARACTER),
    ));
}

export function loadShoppingMemoryEntries(
    characterId: string,
    options?: { afterTimestamp?: string },
): ShoppingMemoryEntry[] {
    return loadEvents(characterId).filter(entry =>
        !options?.afterTimestamp || entry.timestamp > options.afterTimestamp,
    );
}