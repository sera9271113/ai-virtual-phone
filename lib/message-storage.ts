import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const MESSAGE_STORAGE_KEY = "chat-message-threads-v1";

registerKvMigration(MESSAGE_STORAGE_KEY);

export type MessageEntry = {
    id: string;
    characterId: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
};

type MessageStore = Record<string, MessageEntry[]>;

function loadStore(): MessageStore {
    const raw = kvGet(MESSAGE_STORAGE_KEY);
    if (!raw) return {};
    try {
        const value = JSON.parse(raw);
        return value && typeof value === "object" ? value as MessageStore : {};
    } catch {
        return {};
    }
}

function saveStore(store: MessageStore): void {
    kvSet(MESSAGE_STORAGE_KEY, JSON.stringify(store));
}

export function loadMessageEntries(characterId: string): MessageEntry[] {
    return loadStore()[characterId] || [];
}

export function loadMessageThreads(): MessageStore {
    return loadStore();
}

export function pushMessageEntry(input: Omit<MessageEntry, "id" | "createdAt">): MessageEntry {
    const entry: MessageEntry = {
        ...input,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
    };
    const store = loadStore();
    store[input.characterId] = [...(store[input.characterId] || []), entry];
    saveStore(store);
    return entry;
}

export function updateMessageEntry(characterId: string, entryId: string, content: string): MessageEntry | null {
    const store = loadStore();
    const entries = store[characterId] || [];
    const index = entries.findIndex(entry => entry.id === entryId);
    if (index < 0) return null;
    const updated = { ...entries[index], content };
    store[characterId] = entries.map((entry, entryIndex) => entryIndex === index ? updated : entry);
    saveStore(store);
    return updated;
}

export function deleteMessageEntry(characterId: string, entryId: string): void {
    const store = loadStore();
    const entries = store[characterId] || [];
    store[characterId] = entries.filter(entry => entry.id !== entryId);
    saveStore(store);
}

export function deleteMessageEntriesFrom(characterId: string, entryId: string): void {
    const store = loadStore();
    const entries = store[characterId] || [];
    const index = entries.findIndex(entry => entry.id === entryId);
    if (index < 0) return;
    store[characterId] = entries.slice(0, index);
    saveStore(store);
}

export function clearMessageEntries(characterId: string): void {
    const store = loadStore();
    delete store[characterId];
    saveStore(store);
}