"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { CheckCheck, Plus } from "lucide-react";
import { loadChatSessions } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import {
    loadMessageEntries,
    loadMessageThreads,
    pushMessageEntry,
    deleteMessageEntry,
    deleteMessageEntriesFrom,
    clearMessageEntries,
    updateMessageEntry,
    type MessageEntry,
} from "@/lib/message-storage";
import {
    isMessageReplyGenerating,
    MESSAGE_REPLY_STATE_EVENT,
    requestMessageReply,
    stopMessageReply,
} from "@/lib/message-reply-service";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";

function formatMessageDate(value: string): string {
    return new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
    }).format(new Date(value));
}

function formatMessageTimestamp(value: string): string {
    return new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).format(new Date(value));
}

function formatMessagePreviewTime(value: string): string {
    return new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(value));
}

function getMessageDateKey(value: string): string {
    const date = new Date(value);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

type MessagePanelProps = {
    initialCharacterId?: string | null;
    onInitialCharacterConsumed?: () => void;
    onThreadChange?: (hasThread: boolean) => void;
};

export function MessagePanel({ initialCharacterId, onInitialCharacterConsumed, onThreadChange }: MessagePanelProps) {
    const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [entries, setEntries] = useState<MessageEntry[]>([]);
    const [draft, setDraft] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
    const [contextMenuAnchor, setContextMenuAnchor] = useState<{ x: number; y: number } | null>(null);
    const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
    const [editingContent, setEditingContent] = useState("");
    const [messageSearchQuery, setMessageSearchQuery] = useState("");
    const [version, setVersion] = useState(0);
    const bottomRef = useRef<HTMLDivElement>(null);
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressTriggeredRef = useRef(false);
    const longPressStartRef = useRef<{ x: number; y: number } | null>(null);

    const sessions = loadChatSessions().filter(session => !session.isGroup);
    const characters = loadCharacters();
    const threads = loadMessageThreads();
    const normalizedSearchQuery = messageSearchQuery.trim().toLowerCase();
    const visibleSessions = sessions.filter(session => {
        if (!normalizedSearchQuery) return true;
        const character = characters.find(item => item.id === session.contactId);
        const thread = threads[session.contactId] || [];
        return [session.alias, character?.name, ...thread.map(entry => entry.content)]
            .some(value => value?.toLowerCase().includes(normalizedSearchQuery));
    });
    const selectedSession = sessions.find(session => session.contactId === selectedCharacterId);
    const selectedCharacter = characters.find(character => character.id === selectedCharacterId);
    const userName = selectedCharacterId ? resolveUserIdentity(selectedCharacterId, "message")?.name || "用户" : "用户";

    useEffect(() => {
        if (!initialCharacterId) return;
        setSelectedCharacterId(initialCharacterId);
        onInitialCharacterConsumed?.();
    }, [initialCharacterId, onInitialCharacterConsumed]);

    useEffect(() => {
        if (!selectedCharacterId) return;
        setEntries(loadMessageEntries(selectedCharacterId));
    }, [selectedCharacterId, version]);

    useEffect(() => {
        if (!draft && composerRef.current) composerRef.current.style.height = "34px";
    }, [draft]);

    useEffect(() => {
        const handleThreadUpdated = () => setVersion(current => current + 1);
        const handleReplyStateUpdated = () => setIsGenerating(isMessageReplyGenerating(selectedCharacterId));
        window.addEventListener("message-thread-updated", handleThreadUpdated);
        window.addEventListener(MESSAGE_REPLY_STATE_EVENT, handleReplyStateUpdated);
        setIsGenerating(isMessageReplyGenerating(selectedCharacterId));
        return () => {
            window.removeEventListener("message-thread-updated", handleThreadUpdated);
            window.removeEventListener(MESSAGE_REPLY_STATE_EVENT, handleReplyStateUpdated);
        };
    }, [selectedCharacterId]);

    useEffect(() => {
        onThreadChange?.(Boolean(selectedCharacterId));
        return () => onThreadChange?.(false);
    }, [onThreadChange, selectedCharacterId]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [entries, isGenerating]);

    useEffect(() => {
        if (!activeEntryId) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") closeContextMenu();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [activeEntryId]);

    const toggleReplyGeneration = () => {
        if (!selectedCharacterId) return;
        if (isMessageReplyGenerating(selectedCharacterId)) {
            stopMessageReply(selectedCharacterId);
            return;
        }
        void requestMessageReply(selectedCharacterId, entries);
    };

    const sendMessage = async () => {
        const content = draft.trim();
        if (!content || !selectedCharacterId || !selectedSession || isGenerating) return;

        const userEntry = pushMessageEntry({ characterId: selectedCharacterId, role: "user", content });
        setEntries(current => [...current, userEntry]);
        setDraft("");
    };

    const closeContextMenu = () => {
        setActiveEntryId(null);
        setContextMenuAnchor(null);
        setEditingEntryId(null);
        setEditingContent("");
    };

    const getContextMenuInitialStyle = () => {
        if (!contextMenuAnchor) return { left: 0, top: 0 };
        return { left: contextMenuAnchor.x, top: Math.max(8, contextMenuAnchor.y - 90) };
    };

    const positionContextMenu = (element: HTMLDivElement | null) => {
        if (!element || !contextMenuAnchor) return;
        const margin = 8;
        const gap = 12;
        const menuWidth = element.offsetWidth;
        const menuHeight = element.offsetHeight;
        let left = contextMenuAnchor.x - menuWidth / 2;
        left = Math.max(margin, Math.min(left, window.innerWidth - menuWidth - margin));
        const placeBelow = contextMenuAnchor.y - menuHeight - gap < margin;
        let top = placeBelow ? contextMenuAnchor.y + gap : contextMenuAnchor.y - menuHeight - gap;
        top = Math.max(margin, Math.min(top, window.innerHeight - menuHeight - margin));
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
        const triangle = element.querySelector("[data-menu-triangle]") as HTMLElement | null;
        if (!triangle) return;
        triangle.style.left = `${Math.max(14, Math.min(contextMenuAnchor.x - left, menuWidth - 14))}px`;
        triangle.style.right = "auto";
        triangle.style.transform = "translateX(-50%)";
        if (placeBelow) {
            triangle.style.top = "-6px";
            triangle.style.bottom = "auto";
            triangle.style.borderTop = "none";
            triangle.style.borderBottom = "6px solid var(--ctx-menu-bg, #FFFFFF)";
        } else {
            triangle.style.top = "auto";
            triangle.style.bottom = "-6px";
            triangle.style.borderBottom = "none";
            triangle.style.borderTop = "6px solid var(--ctx-menu-bg, #FFFFFF)";
        }
    };

    const beginEditing = () => {
        if (!activeEntry) return;
        setEditingEntryId(activeEntry.id);
        setEditingContent(activeEntry.content);
        setContextMenuAnchor(null);
    };

    const saveEditing = () => {
        if (!activeEntry || !editingContent.trim()) return;
        const updated = updateMessageEntry(activeEntry.characterId, activeEntry.id, editingContent.trim());
        if (updated) setEntries(current => current.map(entry => entry.id === updated.id ? updated : entry));
        closeContextMenu();
    };

    const handleEntryPointerDown = (event: React.PointerEvent, entryId: string) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        const anchor = { x: event.clientX, y: event.clientY };
        longPressStartRef.current = anchor;
        longPressTriggeredRef.current = false;
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
            longPressTriggeredRef.current = true;
            setActiveEntryId(entryId);
            setContextMenuAnchor(anchor);
            longPressTimerRef.current = null;
        }, 500);
    };

    const handleEntryPointerUp = (event: React.PointerEvent) => {
        longPressStartRef.current = null;
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
        if (longPressTriggeredRef.current) {
            event.stopPropagation();
            event.preventDefault();
            longPressTriggeredRef.current = false;
        }
    };

    const handleEntryPointerCancel = () => {
        longPressStartRef.current = null;
        longPressTriggeredRef.current = false;
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
    };

    const handleEntryPointerMove = (event: React.PointerEvent) => {
        if (!longPressStartRef.current) return;
        const deltaX = Math.abs(event.clientX - longPressStartRef.current.x);
        const deltaY = Math.abs(event.clientY - longPressStartRef.current.y);
        if (deltaX > 10 || deltaY > 10) handleEntryPointerCancel();
    };

    const activeEntry = entries.find(entry => entry.id === activeEntryId);

    return (
        <div className={`message-panel${selectedCharacterId ? " has-thread" : ""}`}>
            <aside className="message-thread-list">
                <label className="chat-search-bar chat-search-bar--compact message-list-search">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--c-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input
                        className="chat-search-input"
                        type="search"
                        value={messageSearchQuery}
                        onChange={event => setMessageSearchQuery(event.target.value)}
                        placeholder=""
                        aria-label="搜索短信内容"
                    />
                </label>
                {visibleSessions.length === 0 ? (
                    <div className="message-empty">暂无短信联系人</div>
                ) : visibleSessions.map(session => {
                    const character = characters.find(item => item.id === session.contactId);
                    if (!character) return null;
                    const thread = threads[character.id] || [];
                    const latest = thread[thread.length - 1];
                    return (
                        <button
                            type="button"
                            key={character.id}
                            className={`message-thread-row${selectedCharacterId === character.id ? " active" : ""}`}
                            onClick={() => setSelectedCharacterId(character.id)}
                        >
                            <span className="message-avatar">
                                {character.avatar ? <img src={character.avatar} alt="" /> : <ChatFallbackAvatar />}
                            </span>
                            <span className="message-thread-copy">
                                <span className="message-thread-heading">
                                    <strong title={session.alias || character.name}>{session.alias || character.name}</strong>
                                    {latest && <time>{formatMessagePreviewTime(latest.createdAt)}</time>}
                                </span>
                                <span className="message-thread-preview">{latest?.content || "开始短信对话"}</span>
                            </span>
                        </button>
                    );
                })}
            </aside>

            <section className="message-conversation">
                {!selectedSession || !selectedCharacter ? (
                    <div className="message-empty">选择一位联系人</div>
                ) : isSettingsOpen ? (
                    <div className="message-settings">
                        <header className="message-settings-header">
                            <button type="button" onClick={() => setIsSettingsOpen(false)} aria-label="返回短信">
                                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                                    <path d="M9 11l-4 4l4 4m-4 -4h11a4 4 0 0 0 0 -8h-1" />
                                </svg>
                            </button>
                            <strong>短信设置</strong>
                            <span />
                        </header>
                        <div className="message-settings-body">
                            <div className="message-settings-contact">
                                <span className="message-settings-avatar">
                                    {selectedCharacter.avatar ? <img src={selectedCharacter.avatar} alt="" /> : <ChatFallbackAvatar />}
                                </span>
                                <strong>{selectedSession.alias || selectedCharacter.name}</strong>
                            </div>
                            <button
                                className="message-settings-clear"
                                type="button"
                                disabled={entries.length === 0}
                                onClick={() => {
                                    clearMessageEntries(selectedCharacter.id);
                                    setEntries([]);
                                    setVersion(current => current + 1);
                                }}
                            >
                                清空短信记录
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        <header className="message-conversation-header">
                            <button className="message-header-back" type="button" onClick={() => setSelectedCharacterId(null)} aria-label="返回短信列表">
                                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                                    <path d="M9 11l-4 4l4 4m-4 -4h11a4 4 0 0 0 0 -8h-1" />
                                </svg>
                            </button>
                            <button className="message-header-contact" type="button" onClick={() => setIsSettingsOpen(true)} aria-label="短信设置">
                                <span className="message-header-avatar">
                                    {selectedCharacter.avatar ? <img src={selectedCharacter.avatar} alt="" /> : <ChatFallbackAvatar />}
                                </span>
                                <span className="message-header-name">
                                    <strong>{selectedSession.alias || selectedCharacter.name}</strong>
                                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M9 6l6 6l-6 6" />
                                    </svg>
                                </span>
                            </button>
                            <button className="message-header-video" type="button" aria-label="视频通话">
                                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                                    <path d="M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4" />
                                    <path d="M3 8a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -8" />
                                </svg>
                            </button>
                        </header>
                        <div className="message-bubbles">
                            {entries.map((entry, index) => {
                                const isLastInMessageGroup = index === entries.length - 1 || entries[index + 1].role !== entry.role;
                                const isFirstMessageOfDay = index === 0 || getMessageDateKey(entries[index - 1].createdAt) !== getMessageDateKey(entry.createdAt);
                                const bubbleParts = entry.content.split(/\n\s*\n+/).map(part => part.trim()).filter(Boolean);
                                return (
                                    <Fragment key={entry.id}>
                                        {isFirstMessageOfDay && <time className="message-date-divider">{formatMessageDate(entry.createdAt)}</time>}
                                        <div
                                            className={`message-entry-group ${entry.role}${activeEntryId === entry.id ? " active" : ""}`}
                                            onPointerDown={event => handleEntryPointerDown(event, entry.id)}
                                            onPointerUp={handleEntryPointerUp}
                                            onPointerCancel={handleEntryPointerCancel}
                                            onPointerLeave={handleEntryPointerCancel}
                                            onPointerMove={handleEntryPointerMove}
                                            onContextMenu={event => {
                                                event.preventDefault();
                                                setActiveEntryId(entry.id);
                                                setContextMenuAnchor({ x: event.clientX, y: event.clientY });
                                            }}
                                        >
                                            <div className={`message-bubble-row ${entry.role}`}>
                                                {entry.role === "user" && <CheckCheck className="message-sent-icon" size={15} strokeWidth={1.8} aria-label="已发送" />}
                                                <div className="message-bubble-stack">
                                                    {entry.role === "assistant"
                                                        ? bubbleParts.map((part, partIndex) => (
                                                            <div className="message-bubble-item" key={`${entry.id}-${partIndex}`}>
                                                                <div className="message-bubble">{part}</div>
                                                                <CheckCheck className="message-sent-icon" size={15} strokeWidth={1.8} aria-label="已发送" />
                                                            </div>
                                                        ))
                                                        : bubbleParts.map((part, partIndex) => (
                                                            <div className="message-bubble" key={`${entry.id}-${partIndex}`}>{part}</div>
                                                        ))}
                                                </div>
                                            </div>
                                            {isLastInMessageGroup && <time className={`message-bubble-time ${entry.role}`}>{formatMessageTimestamp(entry.createdAt)}</time>}
                                        </div>
                                    </Fragment>
                                );
                            })}
                            {isGenerating && <div className="message-typing">正在输入...</div>}
                            <div ref={bottomRef} />
                        </div>
                        <div className="message-composer">
                            <button
                                className="message-composer-add"
                                type="button"
                                onClick={toggleReplyGeneration}
                                aria-label="触发AI回复"
                            >
                                <Plus size={21} strokeWidth={2} />
                            </button>
                            <div className="message-composer-field">
                                <textarea
                                    ref={composerRef}
                                    value={draft}
                                    onChange={event => {
                                        setDraft(event.target.value);
                                        event.currentTarget.style.height = "34px";
                                        event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 112)}px`;
                                    }}
                                    onKeyDown={event => {
                                        if (event.key === "Enter" && !event.shiftKey) {
                                            event.preventDefault();
                                            void sendMessage();
                                        }
                                    }}
                                    placeholder="iMessage"
                                    rows={1}
                                    disabled={isGenerating}
                                />
                                <button className="message-composer-send" type="button" onClick={() => void sendMessage()} disabled={!draft.trim() || isGenerating} aria-label="发送短信">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                                        <path d="M9 5a3 3 0 0 1 3 -3a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3a3 3 0 0 1 -3 -3l0 -5" />
                                        <path d="M5 10a7 7 0 0 0 14 0" />
                                        <path d="M8 21l8 0" />
                                        <path d="M12 17l0 4" />
                                    </svg>
                                </button>
                            </div>
                        </div>
                        {activeEntry && editingEntryId === activeEntry.id && (
                            <div className="chat-html-overlay" onClick={closeContextMenu}>
                                <div className="g-card w-[min(84vw,420px)] max-h-[78vh] p-4 flex flex-col gap-3" onClick={event => event.stopPropagation()}>
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex flex-col gap-1">
                                            <span className="menu-label">编辑短信</span>
                                            <span className="menu-desc !mt-0">保存后会同步更新短信记录</span>
                                        </div>
                                        <button className="ui-bare-btn text-[var(--c-icon)] ts-18 leading-none" type="button" onClick={closeContextMenu} aria-label="关闭编辑">✕</button>
                                    </div>
                                    <textarea
                                        autoFocus
                                        value={editingContent}
                                        onChange={event => setEditingContent(event.target.value)}
                                        className="w-full min-h-[180px] max-h-[52vh] resize-none rounded-2xl border border-[var(--c-border)] bg-[var(--c-input)] px-4 py-3 ts-14 text-[var(--c-text)] outline-none"
                                    />
                                    <div className="flex justify-end gap-2">
                                        <button className="ui-btn ui-btn-outline" type="button" onClick={closeContextMenu}>取消</button>
                                        <button className="ui-btn ui-btn-primary" type="button" onClick={saveEditing} disabled={!editingContent.trim()}>保存</button>
                                    </div>
                                </div>
                            </div>
                        )}
                        {activeEntry && contextMenuAnchor && (
                            <div className="message-context-backdrop" onPointerDown={closeContextMenu} aria-hidden="true" />
                        )}
                        {activeEntry && contextMenuAnchor && (
                            <div
                                className="ctx-menu chat-floating-ctx-menu message-context-menu flex flex-col items-center gap-[6px] py-[4px] px-0"
                                data-role={activeEntry.role}
                                ref={positionContextMenu}
                                style={getContextMenuInitialStyle()}
                                onPointerDown={event => event.stopPropagation()}
                            >
                                <div className="flex">
                                    <button type="button" className="ctx-menu-btn" onClick={() => { void navigator.clipboard?.writeText(activeEntry.content); closeContextMenu(); }}>复制</button>
                                    <button type="button" className="ctx-menu-btn" onClick={beginEditing}>编辑</button>
                                </div>
                                <div className="flex">
                                    <button type="button" className="ctx-menu-btn ctx-menu-btn-danger" onClick={() => { deleteMessageEntry(activeEntry.characterId, activeEntry.id); setEntries(current => current.filter(entry => entry.id !== activeEntry.id)); closeContextMenu(); }}>删除</button>
                                    <button type="button" className="ctx-menu-btn ctx-menu-btn-danger" onClick={() => { deleteMessageEntriesFrom(activeEntry.characterId, activeEntry.id); setEntries(current => current.slice(0, current.findIndex(entry => entry.id === activeEntry.id))); closeContextMenu(); }}>删除以下</button>
                                    {activeEntry.role === "assistant" && <button type="button" className="ctx-menu-btn ctx-menu-btn-danger" onClick={() => {
                                        const activeIndex = entries.findIndex(entry => entry.id === activeEntry.id);
                                        const retryHistory = entries.slice(0, activeIndex);
                                        deleteMessageEntriesFrom(activeEntry.characterId, activeEntry.id);
                                        setEntries(retryHistory);
                                        closeContextMenu();
                                        void requestMessageReply(activeEntry.characterId, retryHistory);
                                    }}>重试以下</button>}
                                </div>
                                <div data-menu-triangle className="ctx-menu-triangle absolute -top-[6px] w-0 h-0" />
                            </div>
                        )}
                    </>
                )}
            </section>
        </div>
    );
}