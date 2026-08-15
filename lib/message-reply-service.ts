"use client";

import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { loadChatSessions, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { loadMessageEntries, pushMessageEntry, type MessageEntry } from "@/lib/message-storage";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { dispatchChatMessageNotice } from "@/lib/chat-notification-events";

export const MESSAGE_REPLY_STATE_EVENT = "message-reply-state-updated";

const activeReplies = new Map<string, AbortController>();

function toChatHistory(session: ChatSession, entries: MessageEntry[]): ChatMessage[] {
    return entries.map(entry => ({
        id: entry.id,
        sessionId: session.id,
        role: entry.role,
        content: entry.content,
        status: "sent",
        createdAt: entry.createdAt,
    }));
}

function dispatchReplyState(characterId: string): void {
    window.dispatchEvent(new CustomEvent(MESSAGE_REPLY_STATE_EVENT, { detail: { characterId } }));
}

export function isMessageReplyGenerating(characterId: string | null | undefined): boolean {
    return Boolean(characterId && activeReplies.has(characterId));
}

export function stopMessageReply(characterId: string): void {
    activeReplies.get(characterId)?.abort();
}

export async function requestMessageReply(characterId: string, history = loadMessageEntries(characterId)): Promise<void> {
    if (activeReplies.has(characterId)) return;

    const targetSession = loadChatSessions().find(session => session.contactId === characterId && !session.isGroup);
    const targetCharacter = loadCharacters().find(character => character.id === characterId);
    if (!targetSession || !targetCharacter) return;

    const controller = new AbortController();
    activeReplies.set(characterId, controller);
    dispatchReplyState(characterId);

    try {
        const userName = resolveUserIdentity(characterId, "message")?.name || "用户";
        const blacklistContext: ChatMessage = {
            id: `message-blacklist-context-${targetSession.id}`,
            sessionId: targetSession.id,
            role: "system",
            content: targetSession.isBlacklisted
                ? `系统状态：当前渠道是 Message 短信。${userName}已将你在微信 Chat 中拉黑，因此你不能在微信中回复；你仍可以通过 Message 联系${userName}。你是${targetCharacter.name || "角色"}，对方是${userName}。请记住这个渠道边界，并自然回应自己被拉黑这件事。`
                : `系统状态：当前渠道是 Message 短信，不是微信 Chat。你是${targetCharacter.name || "角色"}，对方是${userName}。微信聊天记录与短信记录属于同一关系的不同渠道，不能把短信误认为微信消息，也不能遗忘刚才在微信中约定转到 Message。`,
            status: "sent",
            createdAt: new Date().toISOString(),
        };
        const result = await generateChatCompletion(
            targetSession,
            [blacklistContext, ...toChatHistory(targetSession, history)],
            { appTags: ["chat", "text", "message"], excludeMessageEntries: true, signal: controller.signal },
        );
        if (activeReplies.get(characterId) !== controller || controller.signal.aborted) return;

        const parsed = parseAIResponse(flattenCompletionResult(result), []);
        const reply = parsed.parts
            .filter(part => !part.mediaType && part.content.trim())
            .map(part => part.content.trim())
            .join("\n\n")
            .trim();
        if (!reply) return;

        pushMessageEntry({ characterId, role: "assistant", content: reply });
        window.dispatchEvent(new CustomEvent("message-thread-updated", { detail: { characterId } }));
        dispatchChatMessageNotice({
            sessionId: targetSession.id,
            characterId,
            channel: "message",
            senderName: targetSession.alias || targetCharacter.name || "新短信",
            avatar: targetCharacter.avatar || null,
            body: reply.slice(0, 80),
        });
    } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
            console.error("[Message] Reply failed:", error);
        }
    } finally {
        if (activeReplies.get(characterId) === controller) {
            activeReplies.delete(characterId);
            dispatchReplyState(characterId);
        }
    }
}

export function ensureMessageReplyListener(): () => void {
    const handleReplyRequest = (event: Event) => {
        const characterId = (event as CustomEvent<{ characterId?: string }>).detail?.characterId;
        if (characterId) void requestMessageReply(characterId);
    };
    window.addEventListener("message-request-reply", handleReplyRequest);
    return () => window.removeEventListener("message-request-reply", handleReplyRequest);
}