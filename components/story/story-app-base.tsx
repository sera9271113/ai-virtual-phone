
"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { pinyin } from "pinyin-pro";
import { ChevronLeft, Menu, ArrowUp, Feather, Square, UserRound, ImagePlus, PaintbrushVertical, X, Archive } from "lucide-react";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { StoryHtmlRenderer } from "@/components/ui/story-html-renderer";
import { loadCharacters } from "@/lib/character-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";
import { incrementEventCounter } from "@/lib/memory-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import {
  generateStoryCompletion,
  getStoryRenderSignature,
  rebuildStorySessionRenderCache,
} from "@/lib/story-engine";
import {
  createOrGetStorySession,
  createStorySession,
  hydrateStoryStorage,
  loadStoryMessages,
  loadStorySessions,
  pushStoryMessage,
  deleteStoryMessage,
  deleteStoryMessagesFrom,
  deleteStorySession,
  editStoryMessage,
  type StoryMessage,
  type StorySession,
  updateStorySession,
} from "@/lib/story-storage";
import { scopeSessionCSS } from "@/lib/css-scoper";
import { kvGet, kvSet } from "@/lib/kv-db";
import { STORY_CSS_EXAMPLE } from "@/lib/css-examples";
import { applyEditOutputRegex } from "@/lib/llm-prompt-assembler";
import { MacroEngine } from "@/lib/macro-engine";

type StoryAppProps = {
  characterId: string;
  onClose: () => void;
  onBack: () => void;
};

type StoryGenerationRun = {
  runId: string;
  controller: AbortController;
};

const activeStoryGenerationRuns = new Map<string, StoryGenerationRun>();

function createStoryGenerationRun(sessionId: string): StoryGenerationRun {
  activeStoryGenerationRuns.get(sessionId)?.controller.abort();
  const run = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    controller: new AbortController(),
  };
  activeStoryGenerationRuns.set(sessionId, run);
  return run;
}

function isStoryGenerationRunActive(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  return Boolean(run && run.runId === runId && !run.controller.signal.aborted);
}

function finishStoryGenerationRun(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run || run.runId !== runId) return false;
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function cancelStoryGenerationRun(sessionId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) return error.name === "AbortError" || /aborted|abort/i.test(error.message);
  return false;
}

function formatStoryTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把中文名字自动转成拼音落款，如"小红" -> "Xiao Hong"。
 * 没有中文字符（本来就是英文/其它文字）时原样返回，不做转换。 */
function toPinyinName(name: string): string {
  if (!name) return "";
  if (!/[\u4e00-\u9fa5]/.test(name)) return name;
  return pinyin(name, { toneType: "none", type: "array" })
    .map((syllable) => syllable.charAt(0).toUpperCase() + syllable.slice(1))
    .join(" ");
}

const CSS_EXAMPLE = STORY_CSS_EXAMPLE;

/** 剧情界面的自定义 CSS 是全局设置：对所有角色、所有信封（存档）统一生效，
 * 与每个 session 无关，也与选角界面（story-character-select 的
 * story_char_select_custom_css_v1）互不影响，各用各的 key。 */
const STORY_GLOBAL_CSS_KEY = "story_global_custom_css_v1";
/** 剧情输出是否使用流式传输（边生成边显示），全局设置，与角色/信封无关。 */
const STORY_STREAM_ENABLED_KEY = "story_stream_enabled_v1";
/** 剧情侧栏顶部的自定义本地背景图（base64 dataURL），全局设置，与角色/信封无关。 */
const STORY_DRAWER_BG_KEY = "story_drawer_bg_image_v1";
/** 折叠标签是全局设置：对所有角色、所有信封（存档）统一生效，与每个 session 无关。 */
const STORY_FOLD_TAGS_KEY = "story_fold_tags_v1";
/** 不进上下文标签是全局设置：对所有角色、所有信封（存档）统一生效，与每个 session 无关。 */
const STORY_CONTEXT_EXCLUDED_TAGS_KEY = "story_context_excluded_tags_v1";
/** 用来把全局 CSS 限定在剧情界面容器内，避免影响选角界面等其他页面。
 * .story-app-shell 在任意角色/任意信封下都存在，因此天然是"全局"的。 */
const STORY_GLOBAL_CSS_SCOPE = ".story-app-shell";

/**
 * 用会话 id 做稳定哈希，在整个色相环上取一组淡雅莫兰迪色——不再局限于固定几组，
 * 但饱和度低、明度高，色调始终落在灰粉/灰绿/灰蓝这类莫兰迪灰调范围内。
 * 同一份档案的信封颜色不随重渲染跳变。
 */
function archiveEnvelopeColors(seed: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  const saturation = 12 + ((hash >> 8) % 10); // 12%–21%，低饱和的灰调
  const lightness = 82 + ((hash >> 16) % 7); // 82%–88%，偏浅
  const paper = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  const shade = `hsl(${hue}, ${saturation}%, ${lightness - 13}%)`;
  return [paper, shade];
}

function getStoryPreview(messages: StoryMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "从这里开始新的剧情。";
  const source = last.renderedContent || last.rawContent;
  // Strip HTML tags and collapse whitespace for preview text
  const text = source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 60) || "继续上次的场景。";
}

function resizeStoryComposerTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  const cap = typeof window !== "undefined" ? window.innerHeight * 0.4 : 260;
  el.style.height = Math.min(el.scrollHeight, cap) + "px";
}

type StoryComposerAppendRequest = {
  id: number;
  text: string;
};

const STORY_GENERATION_STATUS = ["整理场景", "续写剧情", "打磨对白", "写入故事"];
const STORY_INITIAL_LOAD = 10;
const STORY_LOAD_MORE_COUNT = 10;

/* 信纸顶部一排功能小图标：复制 / 编辑 / 重试 / 删除 / 删除以下。 */
function StoryLetterActionIcons({
  onCopy,
  onEdit,
  onRetry,
  onDelete,
  onDeleteFrom,
}: {
  onCopy: () => void;
  onEdit: () => void;
  onRetry: () => void;
  onDelete: () => void;
  onDeleteFrom: () => void;
}) {
  return (
    <div className="story-letter-icons">
      <button type="button" className="story-letter-icon-btn" onClick={onCopy} aria-label="复制">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10l6-6V5a2 2 0 0 0-2-2Z" />
          <path d="M15 3v4a2 2 0 0 0 2 2h4" />
        </svg>
      </button>
      <button type="button" className="story-letter-icon-btn" onClick={onEdit} aria-label="编辑">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M10.4 12.6a2 2 0 1 1 3 3L8 21l-4 1 1-4Z" />
        </svg>
      </button>
      <button type="button" className="story-letter-icon-btn" onClick={onRetry} aria-label="重试">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M8 16H3v5" />
        </svg>
      </button>
      <button type="button" className="story-letter-icon-btn story-letter-icon-btn-danger" onClick={onDelete} aria-label="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
          <path d="M22 21H7" />
          <path d="m5 11 9 9" />
        </svg>
      </button>
      <button type="button" className="story-letter-icon-btn story-letter-icon-btn-danger" onClick={onDeleteFrom} aria-label="删除以下">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          <line x1="10" x2="10" y1="11" y2="17" />
          <line x1="14" x2="14" y1="11" y2="17" />
        </svg>
      </button>
    </div>
  );
}

function StoryGeneratingIndicator({
  characterName,
  avatar,
  quote,
  hideAvatar,
  hideTimestamp,
  hideBubble,
  streamingText,
}: {
  characterName: string;
  avatar?: string;
  quote?: string | null;
  hideAvatar: boolean;
  hideTimestamp: boolean;
  hideBubble: boolean;
  streamingText?: string;
}) {
  const [statusIndex, setStatusIndex] = useState(0);
  const status = STORY_GENERATION_STATUS[statusIndex % STORY_GENERATION_STATUS.length];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStatusIndex((index) => (index + 1) % STORY_GENERATION_STATUS.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article
      className="story-row story-row-letter"
      data-role="assistant"
      data-hide-avatar={hideAvatar ? "true" : undefined}
      data-hide-timestamp={hideTimestamp ? "true" : undefined}
      data-hide-bubble={hideBubble ? "true" : undefined}
    >
      <div className="story-letter" data-role="assistant">
        <div className="story-letter-top">
          <div className="story-letter-top-content">
            <div className="story-letter-stamp-wrap">
              <div className="story-letter-stamp">
                {avatar ? (
                  <img className="story-letter-avatar" src={avatar} alt={characterName} />
                ) : (
                  <span className="story-letter-avatar-fallback">{characterName.slice(0, 1)}</span>
                )}
              </div>
            </div>
            <p className="story-letter-greeting">{characterName}</p>
            {quote ? <p className="story-letter-quote">{quote}</p> : null}
          </div>
        </div>
        <div className="story-letter-bottom">
          <div className="story-letter-polaroid" aria-hidden="true">
            <img src="https://aly3.tuchuangyun.top/autoupload/qb3jf/20260805/cLi1/1440X1440/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260805173021.jpg" alt="" referrerPolicy="no-referrer" />
            <span className="story-letter-polaroid-caption">You & Me</span>
          </div>
          <div className="story-letter-body" aria-label="正在生成剧情">
            {streamingText ? (
              <span className="story-generating-stream-text">{streamingText}</span>
            ) : (
              <span className="story-generating-copy">{status}</span>
            )}
            <span className="story-generating-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

const StoryComposer = memo(function StoryComposer({
  characterName,
  isGenerating,
  appendRequest,
  onSend,
  onStop,
}: {
  characterName: string;
  isGenerating: boolean;
  appendRequest: StoryComposerAppendRequest | null;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAppendIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!appendRequest || appendRequest.id === lastAppendIdRef.current) return;
    lastAppendIdRef.current = appendRequest.id;
    setDraft(prev => prev + appendRequest.text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus();
    });
  }, [appendRequest]);

  const submit = () => {
    if (isGenerating) {
      onStop();
      return;
    }
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) resizeStoryComposerTextarea(textarea);
    });
    onSend(text);
  };

  return (
    <div className="story-composer">
      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        onFocus={(event) => resizeStoryComposerTextarea(event.currentTarget)}
        onChange={(event) => {
          setDraft(event.target.value);
          resizeStoryComposerTextarea(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="Everything pales beside love..."
      />
      <button
        className={`story-send-btn${isGenerating ? " is-generating" : ""}`}
        onClick={submit}
        aria-label={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        title={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        disabled={!isGenerating && !draft.trim()}
      >
        {isGenerating ? (
          <Square className="story-send-icon" size={16} />
        ) : (
          <Feather className="story-send-icon" size={19} />
        )}
      </button>
    </div>
  );
});

export function StoryAppBase({ characterId, onClose, onBack }: StoryAppProps) {
  const [ready, setReady] = useState(false);
  const [, setStorageVersion] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeCharacterId, setActiveCharacterId] = useState<string>("");
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<StoryMessage[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(STORY_INITIAL_LOAD);
  const [composerAppendRequest, setComposerAppendRequest] = useState<StoryComposerAppendRequest | null>(null);
  const [activeCustomCss, setActiveCustomCss] = useState("");
  const [streamEnabled, setStreamEnabled] = useState(true);
  const [drawerBgImage, setDrawerBgImage] = useState("");
  const [customCssDraft, setCustomCssDraft] = useState("");
  const [foldTagsDraft, setFoldTagsDraft] = useState("think,thinking");
  const [contextExcludedTagsDraft, setContextExcludedTagsDraft] = useState("think,thinking");
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [dragStartX, setDragStartX] = useState<number | null>(null);
  const [dragDeltaX, setDragDeltaX] = useState(0);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [cssModalOpen, setCssModalOpen] = useState(false);
  const [archiveBarOpen, setArchiveBarOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shellInnerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const activeSessionIdRef = useRef("");
  const cacheRefreshKeyRef = useRef<string | null>(null);
  const composerAppendIdRef = useRef(0);
  const loadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const envelopeLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const envelopeLongPressTriggeredRef = useRef(false);
  const envelopeStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const drawerBgInputRef = useRef<HTMLInputElement | null>(null);

  const characters = useMemo(() => loadCharacters(), []);
  const userIdentity = useMemo(
    () => resolveUserIdentity(activeCharacterId, "story") ?? resolveUserIdentity(activeCharacterId) ?? resolveUserIdentity(),
    [activeCharacterId]
  );
  const currentCharacter = useMemo(
    () => characters.find((character) => character.id === activeCharacterId) || null,
    [characters, activeCharacterId]
  );
  const sessions = loadStorySessions();
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const uiPrefs = currentSession?.uiPrefs || {};
  // 当前信封（会话）的总字数：汇总每条消息渲染后（或原始）文本去标签后的长度。
  const totalWordCount = useMemo(() => {
    return messages.reduce((sum, message) => {
      const text = (message.renderedContent || message.rawContent || "").replace(/<[^>]+>/g, "");
      return sum + text.length;
    }, 0);
  }, [messages]);
  const characterSessions = useMemo(
    () => sessions
      .filter((session) => session.characterId === activeCharacterId)
      // 按最近更新时间倒序：最左边是最近有更新的信封，而不是最早创建的。
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions, activeCharacterId]
  );
  const [editingArchiveId, setEditingArchiveId] = useState<string | null>(null);
  const [archiveNameDraft, setArchiveNameDraft] = useState("");
  const [pressingArchiveId, setPressingArchiveId] = useState<string | null>(null);
  const [confirmDeleteArchiveId, setConfirmDeleteArchiveId] = useState<string | null>(null);
  const [deletingArchiveId, setDeletingArchiveId] = useState<string | null>(null);
  const [confirmMsgAction, setConfirmMsgAction] = useState<{ type: "retry" | "delete" | "deleteFrom"; msgId: string } | null>(null);

  const switchToSession = useCallback((session: StorySession) => {
    setActiveSessionId((current) => {
      if (current === session.id) return current;
      return session.id;
    });
    setVisibleMessageCount(STORY_INITIAL_LOAD);
    setMessages(loadStoryMessages(session.id));
    setStorageVersion((value) => value + 1);
  }, []);

  const handleCreateArchive = useCallback(() => {
    if (!activeCharacterId) return;
    const session = createStorySession(activeCharacterId);
    setStorageVersion((value) => value + 1);
    switchToSession(session);
    setEditingArchiveId(session.id);
    setArchiveNameDraft("");
  }, [activeCharacterId, switchToSession]);

  const commitArchiveName = useCallback((sessionId: string) => {
    const name = archiveNameDraft.trim();
    updateStorySession(sessionId, { title: name || undefined });
    setStorageVersion((value) => value + 1);
    setEditingArchiveId(null);
  }, [archiveNameDraft]);

  // 长按信封 900ms（比消息长按更久，且不展示进度条）触发删除确认弹窗
  const ARCHIVE_LONG_PRESS_MS = 900;
  const handleArchivePointerDown = useCallback((e: React.PointerEvent, sessionId: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    envelopeStartPosRef.current = { x: e.clientX, y: e.clientY };
    envelopeLongPressTriggeredRef.current = false;
    if (envelopeLongPressTimerRef.current) clearTimeout(envelopeLongPressTimerRef.current);
    setPressingArchiveId(sessionId);
    envelopeLongPressTimerRef.current = setTimeout(() => {
      envelopeLongPressTriggeredRef.current = true;
      setPressingArchiveId(null);
      setConfirmDeleteArchiveId(sessionId);
      envelopeLongPressTimerRef.current = null;
    }, ARCHIVE_LONG_PRESS_MS);
  }, []);
  const handleArchivePointerMove = useCallback((e: React.PointerEvent) => {
    if (!envelopeStartPosRef.current) return;
    if (Math.abs(e.clientX - envelopeStartPosRef.current.x) > 10 || Math.abs(e.clientY - envelopeStartPosRef.current.y) > 10) {
      if (envelopeLongPressTimerRef.current) { clearTimeout(envelopeLongPressTimerRef.current); envelopeLongPressTimerRef.current = null; }
      setPressingArchiveId(null);
    }
  }, []);
  const handleArchivePointerUp = useCallback(() => {
    envelopeStartPosRef.current = null;
    if (envelopeLongPressTimerRef.current) { clearTimeout(envelopeLongPressTimerRef.current); envelopeLongPressTimerRef.current = null; }
    setPressingArchiveId(null);
  }, []);
  const handleArchivePointerCancel = useCallback(() => {
    envelopeStartPosRef.current = null;
    if (envelopeLongPressTimerRef.current) { clearTimeout(envelopeLongPressTimerRef.current); envelopeLongPressTimerRef.current = null; }
    setPressingArchiveId(null);
  }, []);

  const handleConfirmDeleteArchive = useCallback(() => {
    const sessionId = confirmDeleteArchiveId;
    if (!sessionId) return;
    setConfirmDeleteArchiveId(null);
    setDeletingArchiveId(sessionId);
    // 退场动画播放完再真正从存储中移除，同时短期记忆（该档案下的消息/摘要）一并清除
    setTimeout(() => {
      const wasActive = sessionId === activeSessionId;
      deleteStorySession(sessionId);
      setDeletingArchiveId(null);
      setStorageVersion((value) => value + 1);
      if (wasActive) {
        // loadStorySessions() 已按 updatedAt 倒序返回，remaining[0] 即最近更新的信封。
        const remaining = loadStorySessions()
          .filter((session) => session.characterId === activeCharacterId);
        const next = remaining[0] || createOrGetStorySession(activeCharacterId);
        switchToSession(next);
      }
    }, 180);
  }, [confirmDeleteArchiveId, activeSessionId, activeCharacterId, switchToSession]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeSessionIdRef.current) {
        cancelStoryGenerationRun(activeSessionIdRef.current);
      }
    };
  }, []);

  // 部分图床（如 catbox.moe）会依据请求的 Referer 头做防盗链拦截，
  // 与地区/网络无关，VPN 无法绕过——必须让浏览器不发送 Referer。
  // 这里在挂载时确保文档里存在 `<meta name="referrer" content="no-referrer">`，
  // 覆盖 <img> 与 CSS background-image（信纸装饰图、邮票、拍立得）的请求。
  // 若项目的根 layout/<head> 里能直接加这行 meta，效果更稳定，优先那样做。
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.querySelector('meta[name="referrer"]')) return;
    const meta = document.createElement("meta");
    meta.setAttribute("name", "referrer");
    meta.setAttribute("content", "no-referrer");
    document.head.appendChild(meta);
  }, []);

  useEffect(() => {
    hydrateStoryStorage().then(() => {
      const initialChar = characterId || "";
      if (initialChar) {
        const session = createOrGetStorySession(initialChar);
        setActiveCharacterId(initialChar);
        setActiveSessionId(session.id);
        setVisibleMessageCount(STORY_INITIAL_LOAD);
        setMessages(loadStoryMessages(session.id));
        setStorageVersion((value) => value + 1);
      }
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!activeCharacterId) return;
    const session = createOrGetStorySession(activeCharacterId);
    setActiveSessionId(session.id);
    setVisibleMessageCount(STORY_INITIAL_LOAD);
    setMessages(loadStoryMessages(session.id));
    setStorageVersion((value) => value + 1);
  }, [activeCharacterId]);

  // 剧情界面的自定义 CSS 是全局的：跟角色、信封（存档）都无关，只读一次即可。
  useEffect(() => {
    let loaded = "";
    try {
      const raw = kvGet(STORY_GLOBAL_CSS_KEY);
      if (typeof raw === "string" && raw) loaded = raw;
    } catch {
      // 忽略读取失败，使用默认样式
    }
    if (loaded) {
      setActiveCustomCss(loaded);
      return;
    }
    // 兼容旧版本遗留的「每个 session 一份」CSS：全局值为空时，
    // 从已有存档里取第一份非空的旧 CSS 迁移为全局设置。
    hydrateStoryStorage().then(() => {
      const legacyCss = loadStorySessions().find((session) => session.customCSS)?.customCSS;
      if (!legacyCss) return;
      setActiveCustomCss(legacyCss);
      try {
        kvSet(STORY_GLOBAL_CSS_KEY, legacyCss);
      } catch {
        // 忽略保存失败，不影响当前已生效的样式
      }
    });
  }, []);

  // 流式传输开关是全局的：跟角色、信封（存档）都无关，只读一次即可。
  useEffect(() => {
    try {
      const raw = kvGet(STORY_STREAM_ENABLED_KEY);
      if (raw === "0") setStreamEnabled(false);
      else if (raw === "1") setStreamEnabled(true);
      // 未设置过时保留默认值 true
    } catch {
      // 忽略读取失败，使用默认值（开启）
    }
  }, []);

  function handleSetStreaming(next: boolean) {
    setStreamEnabled(next);
    try {
      kvSet(STORY_STREAM_ENABLED_KEY, next ? "1" : "0");
    } catch {
      // 忽略保存失败，不影响当前会话内的开关状态
    }
  }

  // 侧栏背景图是全局的：跟角色、信封（存档）都无关，只读一次即可。
  useEffect(() => {
    try {
      const raw = kvGet(STORY_DRAWER_BG_KEY);
      if (raw) setDrawerBgImage(raw);
    } catch {
      // 忽略读取失败，保持无背景图的默认状态
    }
  }, []);

  // 折叠标签 / 不进上下文标签是全局设置：跟角色、信封（存档）都无关，只读一次即可。
  useEffect(() => {
    try {
      const raw = kvGet(STORY_FOLD_TAGS_KEY);
      if (typeof raw === "string" && raw) setFoldTagsDraft(raw);
    } catch {
      // 忽略读取失败，使用默认值 think,thinking
    }
    try {
      const raw = kvGet(STORY_CONTEXT_EXCLUDED_TAGS_KEY);
      if (typeof raw === "string" && raw) setContextExcludedTagsDraft(raw);
    } catch {
      // 忽略读取失败，使用默认值 think,thinking
    }
  }, []);

  function handleSetFoldTags(next: string) {
    setFoldTagsDraft(next);
    try {
      kvSet(STORY_FOLD_TAGS_KEY, next.trim());
    } catch {
      // 忽略保存失败，不影响当前已生效的折叠标签
    }
  }

  function handleSetContextExcludedTags(next: string) {
    setContextExcludedTagsDraft(next);
    try {
      kvSet(STORY_CONTEXT_EXCLUDED_TAGS_KEY, next.trim());
    } catch {
      // 忽略保存失败，不影响当前已生效的不进上下文标签
    }
  }

  function handleDrawerBgFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) return;
      setDrawerBgImage(dataUrl);
      try {
        kvSet(STORY_DRAWER_BG_KEY, dataUrl);
      } catch {
        // 忽略保存失败，不影响当前已生效的背景图
      }
    };
    reader.readAsDataURL(file);
  }

  // Listen for live CSS updates from 小卷 (全局生效，与当前角色/信封无关)
  useEffect(() => {
    const onCSSUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail?.css === "string") {
        setCustomCssDraft(detail.css);
      }
    };
    window.addEventListener("story-session-css-updated", onCSSUpdate);
    return () => window.removeEventListener("story-session-css-updated", onCSSUpdate);
  }, []);

  const autoBottomLockRef = useRef(true);
  const foldToggleSuppressUntilRef = useRef(0);
  // 段落编辑期间：贴底锁必须关掉，否则编辑框自适应高度每次变化都会被
  // ResizeObserver 拽到底部（表现为"一打字就滚到底"）
  const editingMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    editingMessageIdRef.current = editingMessageId;
    if (editingMessageId) autoBottomLockRef.current = false;
  }, [editingMessageId]);
  // 编辑草稿放 ref、textarea 非受控：逐键 setState 会让 React 回写 value，
  // 中文输入法下 iOS 会光标错位；逐键改 style.height 又会触发 iOS 自动滚动。
  // 高度自适应改由纯 CSS 镜像（.story-grow-wrap::after）完成，打字零 JS 干预。
  const editingDraftRef = useRef("");
  const scrollStoryToBottom = useCallback(() => {
    if (editingMessageIdRef.current) return; // 段落编辑期间任何路径都不允许自动贴底
    const node = scrollRef.current;
    if (!node) return;
    const prevBehavior = node.style.scrollBehavior;
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      requestAnimationFrame(() => {
        node.style.scrollBehavior = prevBehavior;
      });
    });
  }, []);

  // Keep the reader at the latest story entry on entry/session switch/message append.
  const prevMsgCountRef = useRef(0);
  const prevScrollSessionRef = useRef("");
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const sessionChanged = prevScrollSessionRef.current !== activeSessionId;
    const shouldStickToBottom = sessionChanged || messages.length > prevMsgCountRef.current || prevMsgCountRef.current === 0;
    prevScrollSessionRef.current = activeSessionId;
    prevMsgCountRef.current = messages.length;
    if (!shouldStickToBottom) return;

    autoBottomLockRef.current = true;
    scrollStoryToBottom();
    const timers = [80, 300, 800, 1600].map((delay) => (
      setTimeout(() => {
        if (autoBottomLockRef.current) scrollStoryToBottom();
      }, delay)
    ));
    return () => timers.forEach(clearTimeout);
  }, [messages.length, activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    const inner = node?.querySelector(".story-stage-inner");
    if (!node || !inner || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (performance.now() < foldToggleSuppressUntilRef.current) return;
      if (editingMessageIdRef.current) return; // 编辑中不自动贴底
      if (!autoBottomLockRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scrollStoryToBottom);
    });
    observer.observe(inner);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const handleToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      if (!node.contains(target)) return;
      if (!target.matches(".story-fold-block, .story-summary-fold")) return;
      foldToggleSuppressUntilRef.current = performance.now() + 500;
      autoBottomLockRef.current = false;
    };
    node.addEventListener("toggle", handleToggle, true);
    return () => node.removeEventListener("toggle", handleToggle, true);
  }, [activeSessionId]);

  const currentPreview = useMemo(() => getStoryPreview(messages), [messages]);
  const visibleMessages = useMemo(() => {
    return messages.slice(-visibleMessageCount);
  }, [messages, visibleMessageCount]);
  const hasMoreMessages = visibleMessages.length < messages.length;

  const loadMoreMessages = useCallback(() => {
    if (!hasMoreMessages) return;
    const node = scrollRef.current;
    if (node) {
      loadMoreRestoreRef.current = {
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    }
    setVisibleMessageCount((count) => Math.min(count + STORY_LOAD_MORE_COUNT, messages.length));
  }, [hasMoreMessages, messages.length]);

  useLayoutEffect(() => {
    const restore = loadMoreRestoreRef.current;
    const node = scrollRef.current;
    if (!restore || !node) return;
    node.scrollTop = restore.scrollTop + (node.scrollHeight - restore.scrollHeight);
    loadMoreRestoreRef.current = null;
  }, [visibleMessages.length]);

  const handleOptionSelect = useCallback((text: string) => {
    composerAppendIdRef.current += 1;
    setComposerAppendRequest({ id: composerAppendIdRef.current, text });
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!ready || !activeCharacterId || !currentSession || isGenerating) return;

    const activeAssistantMessages = messages.filter((message) => message.role === "assistant");
    if (activeAssistantMessages.length === 0) return;

    const { regexSignature, parserVersion } = getStoryRenderSignature(activeCharacterId);
    const hasStaleMessage = activeAssistantMessages.some((message) => (
      !message.renderedContent
      || message.regexSignature !== regexSignature
      || message.parserVersion !== parserVersion
    ));
    if (!hasStaleMessage) return;

    const refreshKey = `${activeCharacterId}:${currentSession.id}`;
    if (cacheRefreshKeyRef.current === refreshKey) return;
    cacheRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;

    const runRefresh = () => {
      if (cancelled) return;
      const rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: foldTagsDraft });
      if (cancelled) return;
      if (activeSessionIdRef.current === currentSession.id) {
        setMessages(rebuilt);
      }
      setStorageVersion((value) => value + 1);
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };

    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(runRefresh, { timeout: 700 });
    } else {
      timeoutId = globalThis.setTimeout(runRefresh, 80) as unknown as number;
    }

    return () => {
      cancelled = true;
      if (timeoutId != null) {
        globalThis.clearTimeout(timeoutId);
      }
      if (idleId != null && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };
  }, [ready, activeCharacterId, currentSession, messages, isGenerating]);

  async function handleSend(userTextInput: string) {
    const userText = userTextInput.trim();
    if (!activeSessionId || !userText || isGenerating) return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;

    const userMessage = pushStoryMessage({
      sessionId,
      role: "user",
      rawContent: userText,
      renderedContent: userText,
    });
    setMessages((prev) => [...prev, userMessage]);
    setStorageVersion((value) => value + 1);
    setIsGenerating(true);
    setStreamingText("");
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);

    try {
      const historyForGeneration = loadStoryMessages(sessionId);
      const result = await generateStoryCompletion(characterId, historyForGeneration, {
        sessionFoldTags: foldTagsDraft,
        sessionContextExcludedTags: contextExcludedTagsDraft,
        signal: generationRun.controller.signal,
        stream: streamEnabled,
        onDelta: (_delta, full) => {
          if (isCurrentGeneration()) setStreamingText(full);
        },
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId,
        role: "assistant",
        rawContent: result.rawText,
        renderedContent: result.renderedText,
        storySummary: result.storySummary,
        regexSignature: result.regexSignature,
        parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages((prev) => [...prev, assistantMessage]);
      }
      setStorageVersion((value) => value + 1);

      const storyCharacter = characters.find((character) => character.id === characterId);
      if (storyCharacter) {
        void (async () => {
          try {
            incrementEventCounter(characterId);
            incrementEventCounter(characterId);
            await maybeRunSummarization(characterId, storyCharacter.name);
          } catch (err) {
            console.warn("[StoryApp] Memory counter/summarization failed:", err);
          }
        })();
      }
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "剧情生成失败，请稍后再试。";
      const systemMessage = pushStoryMessage({
        sessionId,
        role: "system",
        rawContent: errText,
        renderedContent: errText,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages((prev) => [...prev, systemMessage]);
      }
      setStorageVersion((value) => value + 1);
    } finally {
      if (!finishStoryGenerationRun(sessionId, generationRunId)) return;
      setIsGenerating(false);
      setStreamingText("");
    }
  }

  function handleStopGeneration() {
    if (!activeSessionId) return;
    const cancelled = cancelStoryGenerationRun(activeSessionId);
    if (!cancelled && !isGenerating) return;
    setIsGenerating(false);
  }

  function handleTouchStart(clientX: number) {
    setDragStartX(clientX);
    setDragDeltaX(0);
  }

  function handleTouchMove(clientX: number) {
    if (dragStartX == null) return;
    setDragDeltaX(clientX - dragStartX);
  }

  function handleTouchEnd() {
    if (dragStartX == null) return;
    // 从右边缘向左滑打开
    const screenW = typeof window !== "undefined" ? window.innerWidth : 400;
    if (!drawerOpen && dragStartX > screenW - 32 && dragDeltaX < -54) {
      setDrawerOpen(true);
    }
    // 向右滑关闭
    if (drawerOpen && dragDeltaX > 54) {
      setDrawerOpen(false);
    }
    setDragStartX(null);
    setDragDeltaX(0);
  }

  const MSG_CONFIRM_COPY: Record<"retry" | "delete" | "deleteFrom", { title: string; body: string; confirmLabel: string }> = {
    retry: { title: "重新生成这条回复？", body: "重试会丢弃这条消息之后的所有内容，且无法恢复。", confirmLabel: "重试" },
    delete: { title: "删除这条消息？", body: "删除后无法恢复。", confirmLabel: "删除" },
    deleteFrom: { title: "删除这条及之后的所有消息？", body: "此操作会清除这条消息及其之后的全部内容，且无法恢复。", confirmLabel: "删除" },
  };

  function handleConfirmMsgAction() {
    const action = confirmMsgAction;
    if (!action) return;
    setConfirmMsgAction(null);
    if (action.type === "retry") { void handleStoryRetry(action.msgId); }
    else if (action.type === "delete") { handleStoryDelete(action.msgId); }
    else { handleStoryDeleteFrom(action.msgId); }
  }

  function handleStoryDelete(msgId: string) {
    deleteStoryMessage(msgId);
    setMessages(prev => prev.filter(m => m.id !== msgId));
    setStorageVersion(v => v + 1);
  }
  function handleStoryDeleteFrom(msgId: string) {
    deleteStoryMessagesFrom(activeSessionId, msgId);
    setMessages(prev => { const idx = prev.findIndex(m => m.id === msgId); return idx >= 0 ? prev.slice(0, idx) : prev; });
    setStorageVersion(v => v + 1);
  }
  function handleStoryEditStart(msg: StoryMessage) {
    setEditingMessageId(msg.id);
    setEditingContent(msg.rawContent); // 仅作为非受控 textarea 的初始值
    editingDraftRef.current = msg.rawContent;
  }
  function handleStoryEditSave() {
    const draft = editingDraftRef.current;
    if (!editingMessageId || !draft.trim()) { setEditingMessageId(null); setEditingContent(""); return; }
    let newRawContent = draft.trim();
    // Apply runOnEdit regex rules (placement=2, isEdit=true) to the edited content.
    try {
      const { regexes } = getStoryRenderSignature(activeCharacterId);
      if (regexes.length > 0) {
        const macroEngine = new MacroEngine(currentCharacter?.name ?? "", userIdentity?.name ?? "用户");
        newRawContent = applyEditOutputRegex(newRawContent, regexes, { macroEngine, activeTags: ["story"] });
      }
    } catch {
      // If regex resolution fails, proceed with unmodified content
    }
    editStoryMessage(editingMessageId, newRawContent);
    setMessages(prev => prev.map(m => m.id === editingMessageId
      ? { ...m, rawContent: newRawContent, renderedContent: undefined, regexSignature: undefined, parserVersion: undefined }
      : m
    ));
    setEditingMessageId(null);
    setEditingContent("");
    setStorageVersion(v => v + 1);
  }
  function handleStoryCopy(text: string) {
    const fallbackCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).catch(fallbackCopy); }
    else { fallbackCopy(); }
  }
  async function handleStoryRetry(msgId: string) {
    const msgIndex = messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return;
    const retryMessage = messages[msgIndex];
    if (retryMessage.role !== "assistant" && retryMessage.role !== "user") return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;
    const contextMessages = retryMessage.role === "user"
      ? messages.slice(0, msgIndex + 1)
      : messages.slice(0, msgIndex);
    const firstDiscardedMessage = messages[contextMessages.length];
    if (firstDiscardedMessage) {
      deleteStoryMessagesFrom(activeSessionId, firstDiscardedMessage.id);
    }
    setMessages(contextMessages);
    setStorageVersion(v => v + 1);
    setIsGenerating(true);
    setStreamingText("");
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);
    try {
      const result = await generateStoryCompletion(characterId, contextMessages, {
        sessionFoldTags: foldTagsDraft,
        sessionContextExcludedTags: contextExcludedTagsDraft,
        signal: generationRun.controller.signal,
        stream: streamEnabled,
        onDelta: (_delta, full) => {
          if (isCurrentGeneration()) setStreamingText(full);
        },
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId, role: "assistant",
        rawContent: result.rawText, renderedContent: result.renderedText,
        storySummary: result.storySummary, regexSignature: result.regexSignature, parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) setMessages(prev => [...prev, assistantMessage]);
      setStorageVersion(v => v + 1);
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "重试失败，请稍后再试。";
      const systemMessage = pushStoryMessage({ sessionId, role: "system", rawContent: errText, renderedContent: errText });
      if (activeSessionIdRef.current === sessionId) setMessages(prev => [...prev, systemMessage]);
      setStorageVersion(v => v + 1);
    } finally {
      if (!finishStoryGenerationRun(sessionId, generationRunId)) return;
      setIsGenerating(false);
      setStreamingText("");
    }
  }

  if (!ready) return null;

  if (characters.length === 0) {
    return (
      <div className="story-app-shell" data-story-theme="paper">
        <div className="story-shell-inner">
          <div className="story-header">
            <div className="story-header-safe-area" />
            <div className="story-header-content">
              <div className="story-header-left">
                <button className="story-bare-btn" onClick={onClose} aria-label="关闭剧情模式">
                  <ChevronLeft size={18} />
                </button>
              </div>
              <div className="story-header-center">Story</div>
              <div className="story-header-right" />
            </div>
          </div>

          <div className="story-stage story-stage-empty">
            <div className="story-stage-inner">
              <div className="story-empty story-empty-panel">
                <div>
                  <div className="story-empty-title">还没有角色卡</div>
                  <div className="story-empty-desc">请先创建或导入角色卡，再进入剧情 APP 开始故事。</div>
                </div>
                <button className="story-empty-action" onClick={onClose}>
                  返回
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!currentCharacter || !currentSession) return null;

  /* 信纸问候语下方的引文：根据角色和用户的不同显示不同的内容 */
  const getLetterQuote = (role: string) => {
    return role === "user" 
      ? "Permitam os deuses que eu, livre do amor, No alto do vazio tenha a fria liberdade."
      : "Let my love, like sunlight, surround you and yet give you illumined freedom.";
  };

  return (
    <div
      className={`story-app-shell story-session-${currentSession.id}`}
      data-story-theme={uiPrefs.theme || "paper"}
      onTouchStart={(event) => handleTouchStart(event.touches[0]?.clientX || 0)}
      onTouchMove={(event) => handleTouchMove(event.touches[0]?.clientX || 0)}
      onTouchEnd={handleTouchEnd}
      onMouseDown={(event) => handleTouchStart(event.clientX)}
      onMouseMove={(event) => {
        if (dragStartX != null) handleTouchMove(event.clientX);
      }}
      onMouseUp={handleTouchEnd}
      onMouseLeave={handleTouchEnd}
    >
      {/* Styles moved to styles/story.css */}
      {/* 自定义 CSS 是剧情界面全局的：对所有角色、所有信封（存档）统一生效，
          用 .story-app-shell 限定范围，避免影响选角界面。 */}
      {activeCustomCss ? (
        <style dangerouslySetInnerHTML={{ __html: scopeSessionCSS(activeCustomCss, STORY_GLOBAL_CSS_SCOPE) }} />
      ) : null}

      {drawerOpen ? <div className="story-drawer-overlay" onClick={() => setDrawerOpen(false)} /> : null}
      <aside className="story-drawer" style={{ transform: drawerOpen ? "translateX(0)" : "translateX(106%)", transition: "transform 220ms ease" }}>
        {/* 上方 1/3：自定义本地背景图，右侧叠一个长方形用户头像；点击背景区可更换本地图片 */}
        <div
          className="story-drawer-profile"
          style={drawerBgImage ? { backgroundImage: `url(${drawerBgImage})` } : undefined}
          onClick={() => drawerBgInputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-label="点击设置侧栏背景图"
        >
          {!drawerBgImage ? (
            <div className="story-drawer-profile-hint">
              <ImagePlus size={20} opacity={0.5} />
              <span>点击设置背景图</span>
            </div>
          ) : null}
          <div className="story-drawer-avatar-box">
            {userIdentity?.avatarUrl ? (
              <img src={userIdentity.avatarUrl} alt={userIdentity?.name?.trim() || "用户"} />
            ) : (
              <UserRound size={22} opacity={0.5} />
            )}
          </div>
          <input
            ref={drawerBgInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleDrawerBgFileChange}
          />
        </div>

        {/* 背景图下方：左侧总字数，右侧（头像正下方）用户名字，两边等距 */}
        <div className="story-drawer-profile-meta">
          <div className="story-drawer-meta-item">
            <span className="story-drawer-meta-label">字数</span>
            <span className="story-drawer-meta-value">{totalWordCount}</span>
          </div>
          <div className="story-drawer-meta-item align-right">
            <span className="story-drawer-meta-label">用户</span>
            <span className="story-drawer-meta-value">{userIdentity?.name?.trim() || "用户"}</span>
          </div>
        </div>

        <div className="story-drawer-body">
          <div className="story-drawer-section">
            <div className="story-drawer-eyebrow">显示选项</div>
            <div style={{ padding: "10px 0", borderBottom: "1px solid var(--c-story-drawer-border, rgba(0, 0, 0, 0.06))" }}>
              <label className="story-drawer-subhead" style={{ display: "block", marginBottom: 6 }}>
                折叠标签
              </label>
              <input
                type="text"
                value={foldTagsDraft}
                onChange={(e) => setFoldTagsDraft(e.target.value)}
                onBlur={() => handleSetFoldTags(foldTagsDraft)}
                placeholder="think,thinking"
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "8px 12px", borderRadius: 12,
                  border: "1px solid var(--c-story-panel-border, rgba(166, 166, 166, 0.16))",
                  background: "var(--c-story-css-box-bg, rgba(248, 250, 252, 0.6))",
                  color: "var(--c-story-text, #3B3B3B)",
                  font: "calc(13px*var(--app-text-scale,1))/1.6 inherit",
                }}
              />
              <div className="story-drawer-subhead" style={{ marginTop: 4 }}>
                逗号分隔标签名，如 think,thinking,reasoning
              </div>
            </div>
            <div style={{ padding: "10px 0" }}>
              <label className="story-drawer-subhead" style={{ display: "block", marginBottom: 6 }}>
                不进上下文标签
              </label>
              <input
                type="text"
                value={contextExcludedTagsDraft}
                onChange={(e) => setContextExcludedTagsDraft(e.target.value)}
                onBlur={() => handleSetContextExcludedTags(contextExcludedTagsDraft)}
                placeholder="think,thinking"
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "8px 12px", borderRadius: 12,
                  border: "1px solid var(--c-story-panel-border, rgba(166, 166, 166, 0.16))",
                  background: "var(--c-story-css-box-bg, rgba(248, 250, 252, 0.6))",
                  color: "var(--c-story-text, #3B3B3B)",
                  font: "calc(13px*var(--app-text-scale,1))/1.6 inherit",
                }}
              />
              <div className="story-drawer-subhead" style={{ marginTop: 4 }}>
                默认 think,thinking；影响后续生成上下文，不影响显示与保存
              </div>
            </div>
          </div>

          <div className="story-drawer-section">
            <div className="story-drawer-eyebrow">工具</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="story-character-chip justify-center"
                data-active={streamEnabled ? "true" : undefined}
                aria-pressed={streamEnabled}
                onClick={() => handleSetStreaming(!streamEnabled)}
                style={{ flex: 1, fontSize: "calc(12px*var(--app-text-scale,1))" }}
              >
                {streamEnabled ? "关闭流式传输" : "开启流式传输"}
              </button>
              <button
                className="story-character-chip justify-center"
                style={{ flex: 1, fontSize: "calc(12px*var(--app-text-scale,1))" }}
                onClick={() => {
                  const rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: foldTagsDraft });
                  setMessages(rebuilt);
                  setStorageVersion((value) => value + 1);
                  alert(`缓存重建完成，${rebuilt.length} 条消息已更新`);
                }}
              >
                重建渲染缓存
              </button>
            </div>
          </div>
        </div>
      </aside>

      <div className="story-shell-inner" ref={shellInnerRef}>

        {/* ====== 固定顶部标题栏 ====== */}
        <div className="story-header">
          <div className="story-header-safe-area" />
          <div className="story-header-content">
            <div className="story-header-left">
              <button className="story-bare-btn" onClick={onBack} aria-label="返回角色选择">
                <ChevronLeft size={18} />
              </button>
            </div>
            <div className="story-header-center">Story</div>
            <div className="story-header-right">
              <button
                className="story-bare-btn"
                onClick={() => { setCustomCssDraft(activeCustomCss); setCssModalOpen(true); }}
                aria-label="页面样式"
              >
                <PaintbrushVertical size={16} />
              </button>
              <button
                className={`story-bare-btn${archiveBarOpen ? " is-active" : ""}`}
                onClick={() => setArchiveBarOpen((value) => !value)}
                aria-label={archiveBarOpen ? "收起归档信封" : "展开归档信封"}
                aria-pressed={archiveBarOpen}
              >
                <Archive size={16} />
              </button>
              <button className="story-bare-btn" onClick={() => setDrawerOpen(true)} aria-label="打开剧情侧栏">
                <Menu size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* ====== 归档信封条：横向滑动，固定在顶栏下方，不随内容上下滚动 ======
             默认收起，点击顶栏 archive 图标后向下展开；再点一次收回 */}
        <div className={`story-archive-bar${archiveBarOpen ? " is-open" : ""}`}>
          <div className="story-archive-scroll">
            <button
              type="button"
              className="story-archive-item story-archive-new"
              onClick={handleCreateArchive}
              aria-label="新建剧情档案"
            >
              <span className="story-archive-envelope-frame">
                <span className="story-archive-envelope story-archive-envelope-dashed" aria-hidden="true">
                  <span className="story-archive-envelope-flap" />
                </span>
              </span>
              <span className="story-archive-label story-archive-label-new">新建</span>
            </button>

            {characterSessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const isEditing = editingArchiveId === session.id;
              const label = session.title?.trim() || "档案";
              const [envelopePaper, envelopeShade] = archiveEnvelopeColors(session.id);
              const isPressing = pressingArchiveId === session.id;
              const isDeleting = deletingArchiveId === session.id;
              return (
                <div
                  key={session.id}
                  className={`story-archive-item${isActive ? " is-active" : ""}${isPressing ? " is-pressing" : ""}${isDeleting ? " is-deleting" : ""}`}
                >
                  <button
                    type="button"
                    className="story-archive-envelope-btn"
                    onClick={() => {
                      if (envelopeLongPressTriggeredRef.current) { envelopeLongPressTriggeredRef.current = false; return; }
                      switchToSession(session);
                    }}
                    onPointerDown={(e) => handleArchivePointerDown(e, session.id)}
                    onPointerMove={handleArchivePointerMove}
                    onPointerUp={handleArchivePointerUp}
                    onPointerCancel={handleArchivePointerCancel}
                    onContextMenu={(e) => e.preventDefault()}
                    aria-label={`切换到 ${label}`}
                  >
                    <span className="story-archive-envelope-frame">
                      <span
                        className="story-archive-envelope"
                        style={{ "--envelope-paper": envelopePaper, "--envelope-shade": envelopeShade } as React.CSSProperties}
                      >
                        <span className="story-archive-envelope-left" />
                        <span className="story-archive-envelope-right" />
                        <span className="story-archive-envelope-pocket" />
                        <span className="story-archive-envelope-flap" />
                      </span>
                    </span>
                  </button>
                  {isEditing ? (
                    <input
                      className="story-archive-label-input"
                      autoFocus
                      value={archiveNameDraft}
                      maxLength={12}
                      onChange={(event) => setArchiveNameDraft(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={() => commitArchiveName(session.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setEditingArchiveId(null);
                      }}
                    />
                  ) : (
                    <span
                      className="story-archive-label"
                      onClick={() => {
                        if (!isActive) { switchToSession(session); return; }
                        setEditingArchiveId(session.id);
                        setArchiveNameDraft(session.title || "");
                      }}
                    >
                      {label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {confirmDeleteArchiveId && (
          <div
            className="story-archive-confirm-overlay"
            onClick={() => setConfirmDeleteArchiveId(null)}
          >
            <div className="story-archive-confirm-card" onClick={(e) => e.stopPropagation()}>
              <div className="story-archive-confirm-title">删除该信封？</div>
              <div className="story-archive-confirm-body">
                删除后该信封内的信件与短期记忆一并清除，且无法恢复。
              </div>
              <div className="story-archive-confirm-actions">
                <button type="button" onClick={() => setConfirmDeleteArchiveId(null)}>取消</button>
                <button type="button" className="danger" onClick={handleConfirmDeleteArchive}>删除</button>
              </div>
            </div>
          </div>
        )}

        {confirmMsgAction && (
          <div
            className="story-archive-confirm-overlay"
            onClick={() => setConfirmMsgAction(null)}
          >
            <div className="story-archive-confirm-card" onClick={(e) => e.stopPropagation()}>
              <div className="story-archive-confirm-title">{MSG_CONFIRM_COPY[confirmMsgAction.type].title}</div>
              <div className="story-archive-confirm-body">{MSG_CONFIRM_COPY[confirmMsgAction.type].body}</div>
              <div className="story-archive-confirm-actions">
                <button type="button" onClick={() => setConfirmMsgAction(null)}>取消</button>
                <button type="button" className="danger" onClick={handleConfirmMsgAction}>
                  {MSG_CONFIRM_COPY[confirmMsgAction.type].confirmLabel}
                </button>
              </div>
            </div>
          </div>
        )}

        <div
          className="story-stage"
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            if (performance.now() < foldToggleSuppressUntilRef.current) return;
            const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
            autoBottomLockRef.current = distanceFromBottom <= 12;
          }}
        >
          <div className="story-stage-inner">

            {messages.length === 0 ? (
              <div className="story-empty">
                <div>
                  <div className="text-[calc(14px*var(--app-text-scale,1))] font-medium text-[var(--c-story-heading, #2D2D2D)] mb-1">故事从这里开始</div>
                  <div className="text-[calc(12px*var(--app-text-scale,1))] opacity-70">从底部输入一段引导，剧情会继续展开。</div>
                </div>
              </div>
            ) : (
              <>
                {hasMoreMessages ? (
                  <button
                    type="button"
                    className="story-load-more-btn"
                    onClick={loadMoreMessages}
                  >
                    <span>查看更多消息</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                ) : null}
                {visibleMessages.map((message, visIdx) => {
                  const globalIndex = messages.length - visibleMessages.length + visIdx;
                  const messageNumber = globalIndex + 1;
                  const speakerName = message.role === "user"
                    ? (userIdentity?.name?.trim() || "我")
                    : message.role === "assistant"
                      ? currentCharacter.name
                      : "系统";
                  const avatarUrl = message.role === "user"
                    ? (userIdentity?.avatarUrl || undefined)
                    : message.role === "assistant"
                      ? (currentCharacter.avatar || undefined)
                      : undefined;
                  const isSystem = message.role === "system";

                  const bodyContent = editingMessageId === message.id ? (
                    <div className="story-inline-edit">
                      <div className="story-grow-wrap" data-value={editingContent}>
                        <textarea
                          autoFocus
                          defaultValue={editingContent}
                          onInput={(e) => {
                            const el = e.currentTarget;
                            editingDraftRef.current = el.value;
                            const wrap = el.parentElement;
                            if (wrap) wrap.dataset.value = el.value;
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleStoryEditSave(); }
                            if (e.key === "Escape") { setEditingMessageId(null); setEditingContent(""); }
                          }}
                        />
                      </div>
                      <div className="story-inline-edit-actions">
                        <button onClick={() => { setEditingMessageId(null); setEditingContent(""); }} className="story-inline-edit-btn">取消</button>
                        <button onClick={handleStoryEditSave} className="story-inline-edit-btn story-inline-edit-btn-save">保存</button>
                      </div>
                    </div>
                  ) : (
                    <StoryHtmlRenderer
                      content={message.renderedContent || message.rawContent}
                      messageId={message.id}
                      onOptionSelect={handleOptionSelect}
                    />
                  );

                  return (
                    <article
                      key={message.id}
                      className="story-row story-row-letter"
                      data-role={message.role}
                      data-hide-avatar={uiPrefs.hideAvatar ? "true" : undefined}
                      data-hide-timestamp={uiPrefs.hideTimestamp ? "true" : undefined}
                      data-hide-bubble={uiPrefs.hideBubble ? "true" : undefined}
                    >
                      {isSystem ? (
                        <div className="story-letter-system" style={{ position: "relative" }}>
                          {bodyContent}
                        </div>
                      ) : (
                        <div className="story-letter" data-role={message.role} style={{ position: "relative" }}>
                          <div className={`story-letter-msg-tag ${message.role === "user" ? "story-letter-msg-tag-user" : "story-letter-msg-tag-assistant"}`}>
                            NO.{messageNumber}
                          </div>
                          <div className="story-letter-top">
                            <div className="story-letter-corner-dots" aria-hidden="true">
                              <span /><span /><span /><span /><span /><span />
                            </div>
                            <div className="story-letter-top-content">
                              <div className="story-letter-stamp-wrap">
                                <div className="story-letter-stamp">
                                  {avatarUrl ? (
                                    <img className="story-letter-avatar" src={avatarUrl} alt={speakerName} />
                                  ) : (
                                    <span className="story-letter-avatar-fallback">{speakerName.slice(0, 1)}</span>
                                  )}
                                </div>
                              </div>
                              <p className="story-letter-greeting">{speakerName}</p>
                              {getLetterQuote(message.role) ? (
                                <p className="story-letter-quote">{getLetterQuote(message.role)}</p>
                              ) : null}
                            </div>
                            <div className="story-letter-toolbar">
                              <span className="story-letter-time">{formatStoryTime(message.createdAt)}</span>
                              <StoryLetterActionIcons
                                onCopy={() => handleStoryCopy(message.rawContent)}
                                onEdit={() => handleStoryEditStart(message)}
                                onRetry={() => setConfirmMsgAction({ type: "retry", msgId: message.id })}
                                onDelete={() => setConfirmMsgAction({ type: "delete", msgId: message.id })}
                                onDeleteFrom={() => setConfirmMsgAction({ type: "deleteFrom", msgId: message.id })}
                              />
                            </div>
                          </div>
                          <div className="story-letter-bottom">
                            <div className="story-letter-polaroid" aria-hidden="true">
                              <img
                                src={
                                  message.role === "user"
                                    ? "https://aly3.tuchuangyun.top/autoupload/qb3jf/20260805/xFtT/1080X1068/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260805173015.jpg"
                                    : "https://aly3.tuchuangyun.top/autoupload/qb3jf/20260805/TTtA/490X490/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260805193831.jpg"
                                }
                                alt=""
                                referrerPolicy="no-referrer"
                              />
                              <span className="story-letter-polaroid-caption">
                                {message.role === "user" ? "You & Me" : "I Love You"}
                              </span>
                            </div>
                            <div className="story-letter-body">
                              {bodyContent}
                            </div>
                            <div className="story-letter-signature">
                              <span className="story-letter-pinyin">{toPinyinName(speakerName)}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </>
            )}
            {isGenerating ? (
              <StoryGeneratingIndicator
                characterName={currentCharacter.name}
                avatar={currentCharacter.avatar || undefined}
                quote={getLetterQuote("assistant")}
                hideAvatar={Boolean(uiPrefs.hideAvatar)}
                hideTimestamp={Boolean(uiPrefs.hideTimestamp)}
                hideBubble={Boolean(uiPrefs.hideBubble)}
                streamingText={streamingText}
              />
            ) : null}
          </div>
        </div>

        {/* StoryComposer 移到 .story-shell-inner 内部（.story-stage 的兄弟节点），
            而不是与 .story-shell-inner 平级。原因：.story-shell-inner 自身
            position:absolute + z-index:1 + overflow:hidden 会建立独立的层叠上下文/
            合成层；.story-composer 若作为它的兄弟节点、单独 position:absolute 悬浮，
            在部分浏览器/WebView 的合成实现里，backdrop-filter 只在"同一层叠上下文
            子树"内采样背后像素，跨越到兄弟合成层时会直接采不到内容、退化成纯色——
            这正是"毛玻璃没生效，还是纯色不透明"的根因。放进同一个 .story-shell-inner
            子树后，.story-composer 与它要模糊的 .story-stage 内容处于同一合成层级，
            backdrop-filter 才能正常采样到背后滚动的信纸内容。 */}
        <StoryComposer
          characterName={currentCharacter.name}
          isGenerating={isGenerating}
          appendRequest={composerAppendRequest}
          onSend={(text) => { void handleSend(text); }}
          onStop={handleStopGeneration}
        />
      </div>

      {/* CSS Style Modal */}
      {cssModalOpen && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 300,
          background: "var(--c-story-bg-top, #FFFFFF)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "52px 20px 14px",
            borderBottom: "1px solid rgba(0,0,0,0.04)",
          }}>
            <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.08em", textTransform: "uppercase" as const, fontWeight: 500, color: "var(--c-story-sub, #A6A6A6)" }}>
              页面样式
            </span>
            <button
              onClick={() => setCssModalOpen(false)}
              aria-label="关闭"
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28, borderRadius: 999,
                border: "none",
                background: "rgba(0, 0, 0, 0.05)",
                color: "var(--c-story-text, #3B3B3B)",
                cursor: "pointer",
              }}
            >
              <X size={16} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <textarea
              className="story-css-box"
              value={customCssDraft}
              onChange={(event) => setCustomCssDraft(event.target.value)}
              placeholder={`/* 这里写剧情界面的全局 CSS，对所有角色、所有信封都生效 */\n.story-bubble { border-radius: 30px; }\n.story-composer { backdrop-filter: blur(24px); }`}
              style={{ flex: 1, minHeight: 280 }}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <CSSSchemeBar target="story" currentCSS={customCssDraft} onLoad={setCustomCssDraft} btnStyle={{
                border: "none",
                background: "transparent",
                color: "var(--c-story-text, #3B3B3B)",
              }} modalVars={{
                panel: "var(--c-story-drawer-top, rgba(255, 255, 255, 0.98))",
                border: "var(--c-story-drawer-border, rgba(0, 0, 0, 0.06))",
                text: "var(--c-story-text, #3B3B3B)",
                textDim: "var(--c-story-sub, #A6A6A6)",
                input: "var(--c-story-css-box-bg, rgba(248, 250, 252, 0.6))",
                inputBorder: "var(--c-story-panel-border, rgba(166, 166, 166, 0.16))",
                accent: "var(--c-story-send-bg-active, #2D2D2D)",
              }} />
              <button
                onClick={() => setCustomCssDraft(CSS_EXAMPLE)}
                style={{
                  flex: 1, height: 36, borderRadius: 12,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: "none", background: "transparent", color: "var(--c-story-text, #3B3B3B)",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                加载示例
              </button>
              <button
                onClick={() => setCustomCssDraft("")}
                style={{
                  flex: 1, height: 36, borderRadius: 12,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: "none", background: "transparent", color: "var(--c-story-text, #3B3B3B)",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                清除
              </button>
              <button
                onClick={() => {
                  setActiveCustomCss(customCssDraft);
                  try {
                    kvSet(STORY_GLOBAL_CSS_KEY, customCssDraft);
                  } catch {
                    // 忽略保存失败，不影响当前已生效的样式
                  }
                  setCssModalOpen(false);
                }}
                style={{
                  flex: 1, height: 36, borderRadius: 12, border: "none",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "#222222", color: "#ffffff",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
