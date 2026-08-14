"use client";

import { memo, useState, useEffect, useRef } from "react";
import { ChatMessageList } from "./chat-message-list";
import { ChatContactsList } from "./chat-contacts-list";
import { MomentsFeed } from "./moments-feed";
import { ChatRoom } from "./chat-room";
import { MascotChatRoom } from "./mascot-chat-room";
import { UserProfilePanel } from "./user-profile-panel";
import { WalletPanel } from "./wallet-panel";
import { MessagePanel } from "./message-panel";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";
import { ChevronLeft, Users, Aperture, Menu, Mail } from "lucide-react";
import { ChatSession, loadChatSessions, pushChatMessage, hydrateChatStorage } from "@/lib/chat-storage";
import { notifyMascotPageContext } from "@/lib/mascot-events";
import { loadCharacters } from "@/lib/character-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import type { UserIdentity } from "@/components/settings/user-identity";
import { scopeSessionCSS } from "@/lib/css-scoper";
import { kvGet } from "@/lib/kv-db";
import { formatXiaohongshuShareForPrompt, type ChatSharePayload } from "@/lib/chat-share";
import { CHAT_OPEN_SESSION_EVENT, CHAT_OPEN_ADD_CONTACT_EVENT } from "@/lib/chat-notification-events";
import { getMascotSettingsSnapshot } from "@/lib/mascot-settings";

type TabKey = "messages" | "contacts" | "message" | "feeds" | "wallet" | "settings";

function WeChatIcon() {
    return (
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path stroke="none" d="M0 0h24v24H0z" fill="none" />
            <path d="M16.5 10c3.038 0 5.5 2.015 5.5 4.5c0 1.397 -.778 2.645 -2 3.47l0 2.03l-1.964 -1.178a6.649 6.649 0 0 1 -1.536 .178c-3.038 0 -5.5 -2.015 -5.5 -4.5s2.462 -4.5 5.5 -4.5" />
            <path d="M11.197 15.698c-.69 .196 -1.43 .302 -2.197 .302a8.008 8.008 0 0 1 -2.612 -.432l-2.388 1.432v-2.801c-1.237 -1.082 -2 -2.564 -2 -4.199c0 -3.314 3.134 -6 7 -6c3.782 0 6.863 2.57 7 5.785l0 .233" />
            <path d="M10 8h.01" />
            <path d="M7 8h.01" />
            <path d="M15 14h.01" />
            <path d="M18 14h.01" />
        </svg>
    );
}

export type PhoneChatAppProps = {
    onClose: () => void;
    initialSessionId?: string | null;
    onSessionChange?: (session: ChatSession | null) => void;
    sharePayload?: ChatSharePayload | null;
    onShareDone?: () => void;
};

export const PhoneChatApp = memo(function PhoneChatApp({ onClose, initialSessionId, onSessionChange, sharePayload, onShareDone }: PhoneChatAppProps) {
    const [activeTab, setActiveTab] = useState<TabKey>("messages");
    const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
    const [activeMascot, setActiveMascot] = useState(false);
    // Chat app-level custom CSS (affects all chat pages, lower priority than per-session CSS)
    const [chatAppCSS, setChatAppCSS] = useState(() =>
        typeof window !== "undefined" ? kvGet("chat-app-custom-css") || "" : ""
    );
    // Cache all visited sessions so their ChatRoom stays mounted (hidden)
    const [visitedSessions, setVisitedSessions] = useState<Map<string, ChatSession>>(new Map());
    const [dbReady, setDbReady] = useState(false);
    const [hideTabBar, setHideTabBar] = useState(false);
    const [messageThreadOpen, setMessageThreadOpen] = useState(false);
    // 左侧导航栏头像
    const [identity, setIdentity] = useState<UserIdentity | null>(null);
    useEffect(() => {
        setIdentity(resolveUserIdentity());
    }, []);

    // Hydrate IndexedDB → in-memory caches on mount
    useEffect(() => {
        hydrateChatStorage().then(() => {
            setDbReady(true);
            // Resolve initial session after hydration
            if (initialSessionId) {
                const s = loadChatSessions().find(s => s.id === initialSessionId);
                if (s) setActiveSession(s);
            }
        });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // React to external session navigation (e.g., incoming call acceptance)
    // Only fires when initialSessionId CHANGES after mount (mount case handled by hydration above)
    const prevInitSessionId = useRef(initialSessionId);
    useEffect(() => {
        if (initialSessionId === prevInitSessionId.current) return;
        prevInitSessionId.current = initialSessionId;
        if (!dbReady) return;
        if (!initialSessionId) {
            setActiveSession(null);
            return;
        }
        const s = loadChatSessions().find(s => s.id === initialSessionId);
        if (s) setActiveSession(s);
    }, [initialSessionId, dbReady]);

    // When sharePayload is set, switch to contacts tab (and close any open chat room)
    useEffect(() => {
        if (sharePayload) {
            setActiveSession(null);
            setActiveMascot(false);
            setActiveTab("contacts");
        }
    }, [sharePayload]);

    useEffect(() => {
        const handler = (e: Event) => {
            const sessionId = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
            if (!sessionId) return;
            const session = loadChatSessions().find(s => s.id === sessionId);
            if (!session) return;
            setActiveMascot(false);
            setActiveSession(session);
            setActiveTab("messages");
        };
        window.addEventListener(CHAT_OPEN_SESSION_EVENT, handler);
        return () => window.removeEventListener(CHAT_OPEN_SESSION_EVENT, handler);
    }, []);

    // 名片点击「加好友」：关会话、切联系人 tab，待添加角色经 prop 交给列表打开添加页
    const [pendingAddContactId, setPendingAddContactId] = useState<string | null>(null);
    // 名片来源的原聊天室：添加页按返回时回到这里
    const addContactReturnSessionRef = useRef<string | null>(null);
    const activeSessionIdRef = useRef<string | null>(null);
    activeSessionIdRef.current = activeSession?.id ?? null;
    useEffect(() => {
        const handler = (e: Event) => {
            const characterId = (e as CustomEvent<{ characterId?: string }>).detail?.characterId;
            if (!characterId) return;
            addContactReturnSessionRef.current = activeSessionIdRef.current;
            setActiveSession(null);
            setActiveMascot(false);
            setActiveTab("contacts");
            setPendingAddContactId(characterId);
        };
        window.addEventListener(CHAT_OPEN_ADD_CONTACT_EVENT, handler);
        return () => window.removeEventListener(CHAT_OPEN_ADD_CONTACT_EVENT, handler);
    }, []);

    // Notify parent of session changes + cache visited session + push mascot context
    useEffect(() => {
        onSessionChange?.(activeSession);
        if (activeSession) {
            setActiveMascot(false);
            setVisitedSessions(prev => {
                if (prev.has(activeSession.id)) return prev;
                const next = new Map(prev);
                next.set(activeSession.id, activeSession);
                return next;
            });
            // Push session info to mascot context so 小卷 can access sessionId
            const chars = loadCharacters();
            const char = chars.find(c => c.id === activeSession.contactId);
            notifyMascotPageContext({
                page: "chat",
                mode: "chatting",
                label: `聊天 · ${(activeSession as Record<string, unknown>).alias as string || char?.name || "对话"}`,
                fields: { sessionId: activeSession.id, contactId: activeSession.contactId },
            });
        }
    }, [activeSession]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!activeMascot) return;
        onSessionChange?.(null);
        notifyMascotPageContext({
            page: "chat",
            mode: "chatting",
            label: `聊天 · ${getMascotSettingsSnapshot().nickname || "AI助手"}`,
            fields: { sessionId: "mascot", contactId: "mascot" },
        });
    }, [activeMascot]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleSelectContact = (sess: ChatSession | null) => {
        if (sharePayload && sess) {
            if (sharePayload.type === "music") {
                pushChatMessage({
                    sessionId: sess.id,
                    role: "user",
                    content: "",
                    mediaType: "music_share",
                    mediaData: {
                        musicTitle: sharePayload.title,
                        musicArtist: sharePayload.artist,
                        label: `${sharePayload.title} - ${sharePayload.artist}`,
                    },
                });
            } else {
                const content = formatXiaohongshuShareForPrompt({
                    author: sharePayload.authorName,
                    title: sharePayload.title,
                    body: sharePayload.body,
                    description: sharePayload.description,
                });
                pushChatMessage({
                    sessionId: sess.id,
                    role: "user",
                    content,
                    mediaType: "xiaohongshu_note_share",
                    mediaData: {
                        xiaohongshuAuthor: sharePayload.authorName,
                        xiaohongshuTitle: sharePayload.title,
                        xiaohongshuBody: sharePayload.body,
                        xiaohongshuDescription: sharePayload.description,
                        xiaohongshuNoteType: sharePayload.noteType,
                        xiaohongshuTags: sharePayload.tags,
                        xiaohongshuImageAssetId: sharePayload.imageAssetId,
                        xiaohongshuCoverIcon: sharePayload.coverIcon,
                        xiaohongshuTone: sharePayload.tone,
                    },
                });
            }
            window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: sess.id } }));
            onShareDone?.();
        }
        setActiveMascot(false);
        setActiveSession(sess);
        setActiveTab("messages");
    };

    const handleSelectMascot = () => {
        setActiveSession(null);
        setActiveMascot(true);
        setActiveTab("messages");
    };

    // Listen for CSS updates from settings panel
    useEffect(() => {
        const onCSSUpdate = () => setChatAppCSS(kvGet("chat-app-custom-css") || "");
        window.addEventListener("chat-app-css-updated", onCSSUpdate);
        return () => window.removeEventListener("chat-app-css-updated", onCSSUpdate);
    }, []);

    // Listen for tab bar hide/show from sub-pages (e.g. CSS editor)
    useEffect(() => {
        const onHide = (e: Event) => setHideTabBar((e as CustomEvent).detail);
        window.addEventListener("chat-hide-tabbar", onHide);
        return () => window.removeEventListener("chat-hide-tabbar", onHide);
    }, []);

    // Wait for IndexedDB hydration before rendering
    if (!dbReady) return null;

    /* 是否处于 chat 首页（未进入任何聊天室、未隐藏 tab 栏） */
    const isHomePage = !activeSession && !activeMascot && !hideTabBar;
    const showHomeTopbar = isHomePage;

    return (
        <div
            className="chat-app absolute inset-0 flex flex-col overflow-hidden z-10"
            {...(activeSession || activeMascot ? { "data-room-active": "" } : {})}
            {...(hideTabBar ? { "data-tabbar-hidden": "" } : {})}
            {...(activeTab === "message" && messageThreadOpen ? { "data-message-thread-open": "" } : {})}
        >
            {/* Chat app-level custom CSS (lower priority than per-session CSS) */}
            {chatAppCSS && <style dangerouslySetInnerHTML={{ __html: scopeSessionCSS(chatAppCSS, ".chat-app") }} />}

            {/* ── 透明顶栏：退出键，仅 chat 首页可见 ── */}
            {showHomeTopbar && (
                <div className="chat-home-topbar">
                    <div className="chat-home-topbar-safe-area" />
                    <div className="chat-home-topbar-content">
                        <button type="button" className="chat-home-topbar-back" onClick={onClose} aria-label="返回">
                            <ChevronLeft size={22} strokeWidth={1.7} />
                        </button>
                        {(activeTab === "messages" || activeTab === "contacts" || (activeTab === "message" && !messageThreadOpen) || activeTab === "wallet" || activeTab === "settings") && (
                            <span className="page-title chat-home-page-title">
                                {activeTab === "messages" ? "Chat" : activeTab === "contacts" ? "Contact" : activeTab === "message" ? "Message" : activeTab === "wallet" ? "Wallet" : "Setting"}
                            </span>
                        )}
                    </div>
                </div>
            )}

            {/* 左侧导航栏 + 右侧内容区 —— 具体聊天室（下面 chat-room-layer）会整个盖在这一层之上 */}
            <div
                className="chat-main-content chat-app-body relative flex-1 flex flex-row overflow-hidden"
                {...(activeSession || activeMascot ? { "data-covered-by-room": "" } : {})}
            >
                {/* 左侧竖排导航 —— hide when inside a chat room */}
                <nav
                    className="chat-side-nav"
                    data-ui="nav"
                    style={{ display: activeSession || activeMascot || hideTabBar ? "none" : undefined }}
                >
                    <div className="chat-side-nav-safe-area" />

                    <div className="chat-side-nav-avatar-row">
                        <div className="chat-side-nav-avatar">
                            {identity?.avatarUrl ? (
                                <img src={identity.avatarUrl} alt="" />
                            ) : (
                                <ChatFallbackAvatar />
                            )}
                        </div>
                    </div>

                    <div className="chat-side-nav-group">
                        <button
                            type="button"
                            className={`chat-side-nav-icon-btn${activeTab === "messages" ? " active" : ""}`}
                            onClick={() => setActiveTab("messages")}
                            aria-label="消息"
                        >
                            <WeChatIcon />
                        </button>
                        <button
                            type="button"
                            className={`chat-side-nav-icon-btn${activeTab === "contacts" ? " active" : ""}`}
                            onClick={() => setActiveTab("contacts")}
                            aria-label="联系人"
                        >
                            <Users size={21} strokeWidth={1.7} />
                        </button>
                        <button
                            type="button"
                            className={`chat-side-nav-icon-btn${activeTab === "message" ? " active" : ""}`}
                            onClick={() => setActiveTab("message")}
                            aria-label="短信"
                        >
                            <Mail size={21} strokeWidth={1.7} />
                        </button>
                        <button
                            type="button"
                            className={`chat-side-nav-icon-btn${activeTab === "feeds" ? " active" : ""}`}
                            onClick={() => setActiveTab("feeds")}
                            aria-label="动态"
                        >
                            <Aperture size={21} strokeWidth={1.7} />
                        </button>
                    </div>

                    <div className="chat-side-nav-spacer" />

                    {/* 钱包 + 设置：和上面几个功能明显隔开一段距离，放在最下面 */}
                    <div className="chat-side-nav-group chat-side-nav-group--bottom">
                        <button
                            type="button"
                            className={`chat-side-nav-icon-btn${activeTab === "wallet" ? " active" : ""}`}
                            onClick={() => setActiveTab("wallet")}
                            aria-label="钱包"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                                <path d="M15 11v.01" />
                                <path d="M5.173 8.378a3 3 0 1 1 4.656 -1.377" />
                                <path d="M16 4v3.803a6.019 6.019 0 0 1 2.658 3.197h1.341a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-1.342c-.336 .95 -.907 1.8 -1.658 2.473v2.027a1.5 1.5 0 0 1 -3 0v-.583a6.04 6.04 0 0 1 -1 .083h-4a6.04 6.04 0 0 1 -1 -.083v.583a1.5 1.5 0 0 1 -3 0v-2l0 -.027a6 6 0 0 1 4 -10.473h2.5l4.5 -3" />
                            </svg>
                        </button>
                        <button
                            type="button"
                            className={`chat-side-nav-icon-btn${activeTab === "settings" ? " active" : ""}`}
                            onClick={() => setActiveTab("settings")}
                            aria-label="设置"
                        >
                            <Menu size={21} strokeWidth={1.7} />
                        </button>
                    </div>
                </nav>

                {/* 右侧内容区 —— 除具体聊天室外，其余板块都渲染在这里 */}
                <div className="chat-content-pane">
                    {activeTab === "messages" && <ChatMessageList activeSession={activeSession} onSelectSession={(session) => { setActiveMascot(false); setActiveSession(session); }} onSelectMascot={handleSelectMascot} />}
                    {activeTab === "contacts" && (
                        <ChatContactsList
                            onSelectSession={handleSelectContact}
                            onSelectMascot={handleSelectMascot}
                            pendingAddContactId={pendingAddContactId}
                            onPendingAddContactConsumed={() => setPendingAddContactId(null)}
                            onPendingAddContactBack={() => {
                                const sessionId = addContactReturnSessionRef.current;
                                addContactReturnSessionRef.current = null;
                                if (!sessionId) return;
                                const session = loadChatSessions().find(s => s.id === sessionId);
                                if (!session) return;
                                setActiveSession(session);
                                setActiveTab("messages");
                            }}
                        />
                    )}
                    {activeTab === "message" && <MessagePanel onThreadChange={setMessageThreadOpen} />}
                    {activeTab === "feeds" && <MomentsFeed />}
                    {activeTab === "wallet" && <WalletPanel />}
                    {activeTab === "settings" && <UserProfilePanel />}
                </div>
            </div>

            {/* Chat Rooms — all visited sessions stay mounted, only active one is visible */}
            {[...visitedSessions.values()].map(sess => (
                <div key={sess.id} style={{ display: activeSession?.id === sess.id ? undefined : 'none' }} className="chat-room-layer absolute inset-0">
                    <ChatRoom session={sess} onBack={() => setActiveSession(null)} />
                </div>
            ))}
            {activeMascot && (
                <div className="chat-room-layer absolute inset-0">
                    <MascotChatRoom
                        onBack={() => setActiveMascot(false)}
                        onDeleted={() => setActiveMascot(false)}
                    />
                </div>
            )}
        </div>
    );
});
