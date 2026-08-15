"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { Bot, ChevronLeft, NotebookPen, Trash2, WandSparkles, X, Heart, MessageCircle, Share2, Filter, Users, User, BookOpenText, Plus, PenLine, Pencil, Settings, Check, RotateCcw } from "lucide-react";
import { DotsThree } from "@phosphor-icons/react";

import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { generateDiaryEntryForCharacter } from "@/lib/diary-entry-engine";
import { useDiaryGenerating } from "@/lib/diary-generating-tracker";
import {
  DIARY_ENTRIES_UPDATED_EVENT,
  DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT,
} from "@/lib/diary-entry-timer-service";
import {
  createDiaryEntry,
  deleteDiaryEntry,
  loadDiaryEntries,
  loadDiaryEntryFontScale,
  loadDiaryEntryTimerSettings,
  saveDiaryEntryFontScale,
  saveDiaryEntryTimerSettings,
  updateDiaryEntry,
} from "@/lib/diary-entry-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { SELF_ENTRY_CHARACTER_ID, type DiaryEntry, type DiaryEntryBlock, type DiaryEntryTimerSettings, type DiaryEntryTrigger } from "@/lib/diary-entry-types";
import { DiaryDateStrip } from "./diary-date-strip";
import { DiaryHomeView } from "./diary-home-view";
import { CharacterAvatarGrid } from "./diary-character-avatar-grid";
import { DiaryBlockView, blockPlainText, formatEntryDateParts } from "./diary-entry-render-utils";

type DiaryEntriesAppProps = {
  onBack: () => void;
  onNotice?: (message: string) => void;
};

type DiaryEntryDragState = {
  entry: DiaryEntry;
  x: number;
  y: number;
  width: number;
  height: number;
  isOverTrash: boolean;
};

type DiaryEntryDragSession = {
  entry: DiaryEntry;
  pointerId: number;
  target: HTMLButtonElement;
  startX: number;
  startY: number;
  width: number;
  height: number;
  timer: number | null;
  dragging: boolean;
};

type DiaryEntryDragScrollLock = {
  bodyOverflow: string;
  bodyTouchAction: string;
  htmlOverscrollBehavior: string;
  htmlTouchAction: string;
  main: HTMLElement | null;
  mainOverflow: string;
  mainTouchAction: string;
  mainScrollTop: number;
};

function isSameDay(d1: Date, d2: Date): boolean {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

export function DiaryEntriesApp({ onBack, onNotice }: DiaryEntriesAppProps) {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [settings, setSettings] = useState<DiaryEntryTimerSettings>(() => loadDiaryEntryTimerSettings());
  const [view, setView] = useState<"timeline" | "home">("timeline");
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [selectedFilterCharacterIds, setSelectedFilterCharacterIds] = useState<string[]>([]);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [writeMenuOpen, setWriteMenuOpen] = useState(false);
  const [writePanelOpen, setWritePanelOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [selfWritePanelOpen, setSelfWritePanelOpen] = useState(false);
  const [deleteCandidateEntry, setDeleteCandidateEntry] = useState<DiaryEntry | null>(null);
  const [editCandidateEntry, setEditCandidateEntry] = useState<DiaryEntry | null>(null);
  const [localGeneratingIds, setGeneratingCharacterIds] = useState<string[]>([]);
  const [diaryFontScale, setDiaryFontScale] = useState<number>(() => loadDiaryEntryFontScale());
  // Merge in the module-level tracker so background generation (timer, or a
  // batch started before leaving the app) is visible again after re-entry.
  const trackedGeneratingIds = useDiaryGenerating();
  const generatingCharacterIds = useMemo(
    () => Array.from(new Set([...localGeneratingIds, ...trackedGeneratingIds])),
    [localGeneratingIds, trackedGeneratingIds],
  );
  const characterAvatarById = useMemo(() => {
    const map = new Map<string, string>();
    for (const character of characters) {
      if (character.avatar) map.set(character.id, character.avatar);
    }
    return map;
  }, [characters]);

  // Self-written entries (characterId === SELF_ENTRY_CHARACTER_ID) aren't in
  // `characters`, so they need the system user identity's avatar separately
  // — otherwise they always fall back to the generic bot icon.
  const [selfIdentityAvatar, setSelfIdentityAvatar] = useState("");
  useEffect(() => {
    const refreshIdentity = () => {
      setSelfIdentityAvatar(resolveUserIdentity()?.avatarUrl || "");
    };
    refreshIdentity();
    window.addEventListener("user-identities-updated", refreshIdentity);
    window.addEventListener("settings-bindings-updated", refreshIdentity);
    return () => {
      window.removeEventListener("user-identities-updated", refreshIdentity);
      window.removeEventListener("settings-bindings-updated", refreshIdentity);
    };
  }, []);

  const resolveEntryAvatar = useCallback((entry: DiaryEntry): string | undefined => {
    return entry.characterId === SELF_ENTRY_CHARACTER_ID
      ? (selfIdentityAvatar || undefined)
      : characterAvatarById.get(entry.characterId);
  }, [characterAvatarById, selfIdentityAvatar]);

  const [entryDrag, setEntryDrag] = useState<DiaryEntryDragState | null>(null);
  // Card bodies render clamped to 4 lines by default; tapping a card reveals
  // its full content. Tracked by entry id so expand state persists across
  // list re-renders (filtering, refresh) until the card is collapsed again.
  const [expandedEntryIds, setExpandedEntryIds] = useState<Set<string>>(new Set());
  const toggleEntryExpanded = useCallback((entryId: string) => {
    setExpandedEntryIds(previous => {
      const next = new Set(previous);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }, []);
  const entryMainRef = useRef<HTMLElement | null>(null);
  const entryTrashRef = useRef<HTMLDivElement | null>(null);
  const entryDragRef = useRef<DiaryEntryDragSession | null>(null);
  const entryDragClickSuppressedRef = useRef(false);
  const entryDragClickSuppressTimerRef = useRef<number | null>(null);
  const entryDragScrollLockRef = useRef<DiaryEntryDragScrollLock | null>(null);
  const entryDragTouchMoveBlockerRef = useRef<((event: globalThis.TouchEvent) => void) | null>(null);

  const notify = useCallback((message: string) => {
    onNotice?.(message);
  }, [onNotice]);

  const refreshEntries = useCallback(() => {
    setEntries(loadDiaryEntries());
  }, []);

  // Tracks the last-saved value so the slider can preview a change locally
  // without touching storage — only handleDiaryFontConfirm persists it.
  const [savedDiaryFontScale, setSavedDiaryFontScale] = useState<number>(() => loadDiaryEntryFontScale());

  const handleDiaryFontScaleChange = useCallback((scale: number) => {
    const normalized = Math.min(1.25, Math.max(0.85, scale));
    setDiaryFontScale(normalized);
  }, []);

  const handleDiaryFontConfirm = useCallback(() => {
    saveDiaryEntryFontScale(diaryFontScale);
    setSavedDiaryFontScale(diaryFontScale);
    notify("已保存字号");
  }, [diaryFontScale, notify]);

  const handleDiaryFontReset = useCallback(() => {
    saveDiaryEntryFontScale(1);
    setDiaryFontScale(1);
    setSavedDiaryFontScale(1);
    notify("已恢复默认字号");
  }, [notify]);

  const diaryEntryStyle = useMemo(() => {
    return {
      "--diary-entry-font-scale": String(diaryFontScale),
    } as CSSProperties;
  }, [diaryFontScale]);

  const deleteEntry = useCallback((entry: DiaryEntry) => {
    deleteDiaryEntry(entry.id);
    setDeleteCandidateEntry(current => current?.id === entry.id ? null : current);
    refreshEntries();
    notify(`已删除 ${entry.characterName} 的日记。`);
  }, [notify, refreshEntries]);

  useEffect(() => {
    setCharacters(loadCharacters());
    refreshEntries();
  }, [refreshEntries]);

  useEffect(() => {
    saveDiaryEntryTimerSettings(settings);
    window.dispatchEvent(new CustomEvent(DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT));
  }, [settings]);

  useEffect(() => {
    const handleEntriesUpdated = () => {
      refreshEntries();
      setSettings(loadDiaryEntryTimerSettings());
    };
    window.addEventListener(DIARY_ENTRIES_UPDATED_EVENT, handleEntriesUpdated);
    return () => window.removeEventListener(DIARY_ENTRIES_UPDATED_EVENT, handleEntriesUpdated);
  }, [refreshEntries]);

  const resolveTargets = useCallback((characterIds: string[]): Character[] => {
    const stored = loadCharacters();
    const uniqueIds = Array.from(new Set(characterIds.filter(Boolean)));
    return uniqueIds
      .map(characterId => characters.find(item => item.id === characterId) ?? stored.find(item => item.id === characterId))
      .filter(Boolean) as Character[];
  }, [characters]);

  const generateForCharacters = useCallback(async (characterIds: string[], trigger: DiaryEntryTrigger = "manual") => {
    const targets = resolveTargets(characterIds);
    if (targets.length === 0) {
      notify("找不到角色。");
      return;
    }

    const targetIds = targets.map(character => character.id);
    setGeneratingCharacterIds(prev => Array.from(new Set([...prev, ...targetIds])));
    try {
      const baseEntries = loadDiaryEntries();
      const results = await Promise.all(targets.map(async character => {
        try {
          return {
            status: "fulfilled" as const,
            character,
            draft: await generateDiaryEntryForCharacter(character.id, baseEntries, trigger),
          };
        } catch {
          return { status: "rejected" as const, character };
        }
      }));

      const createdEntries: DiaryEntry[] = [];
      const failedNames: string[] = [];
      for (const result of results) {
        if (result.status === "rejected") {
          failedNames.push(result.character.name);
          continue;
        }
        try {
          createdEntries.push(createDiaryEntry({
            characterId: result.character.id,
            characterName: result.character.name,
            title: result.draft.title,
            mood: result.draft.mood,
            weather: result.draft.weather,
            tags: result.draft.tags,
            body: result.draft.body,
            blocks: result.draft.blocks,
            trigger,
          }));
        } catch {
          failedNames.push(result.character.name);
        }
      }

      refreshEntries();
      if (createdEntries.length === 1 && failedNames.length === 0) {
        notify(`${createdEntries[0].characterName} 写了一篇日记。`);
      } else if (createdEntries.length > 0) {
        notify(`已生成 ${createdEntries.length} 篇日记${failedNames.length ? `，${failedNames.length} 个失败` : ""}。`);
      } else {
        notify(failedNames.length ? `日记生成失败：${failedNames.join("、")}` : "日记生成失败。");
      }
    } finally {
      setGeneratingCharacterIds(prev => prev.filter(id => !targetIds.includes(id)));
    }
  }, [notify, refreshEntries, resolveTargets]);

  const clearEntryDragTimer = useCallback(() => {
    const timer = entryDragRef.current?.timer;
    if (timer !== null && timer !== undefined) {
      window.clearTimeout(timer);
      if (entryDragRef.current) entryDragRef.current.timer = null;
    }
  }, []);

  const suppressEntryClick = useCallback((duration = 700) => {
    if (entryDragClickSuppressTimerRef.current !== null) {
      window.clearTimeout(entryDragClickSuppressTimerRef.current);
    }
    entryDragClickSuppressedRef.current = true;
    entryDragClickSuppressTimerRef.current = window.setTimeout(() => {
      entryDragClickSuppressedRef.current = false;
      entryDragClickSuppressTimerRef.current = null;
    }, duration);
  }, []);

  const lockEntryDragScroll = useCallback(() => {
    if (entryDragScrollLockRef.current || typeof document === "undefined") return;
    const main = entryMainRef.current;
    entryDragScrollLockRef.current = {
      bodyOverflow: document.body.style.overflow,
      bodyTouchAction: document.body.style.touchAction,
      htmlOverscrollBehavior: document.documentElement.style.overscrollBehavior,
      htmlTouchAction: document.documentElement.style.touchAction,
      main,
      mainOverflow: main?.style.overflow ?? "",
      mainTouchAction: main?.style.touchAction ?? "",
      mainScrollTop: main?.scrollTop ?? 0,
    };
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    document.documentElement.style.overscrollBehavior = "none";
    document.documentElement.style.touchAction = "none";
    if (!entryDragTouchMoveBlockerRef.current) {
      entryDragTouchMoveBlockerRef.current = (event: globalThis.TouchEvent) => {
        event.preventDefault();
      };
      document.addEventListener("touchmove", entryDragTouchMoveBlockerRef.current, { capture: true, passive: false });
    }
    if (main) {
      main.style.overflow = "hidden";
      main.style.touchAction = "none";
    }
  }, []);

  const unlockEntryDragScroll = useCallback(() => {
    const lock = entryDragScrollLockRef.current;
    if (!lock || typeof document === "undefined") return;
    document.body.style.overflow = lock.bodyOverflow;
    document.body.style.touchAction = lock.bodyTouchAction;
    document.documentElement.style.overscrollBehavior = lock.htmlOverscrollBehavior;
    document.documentElement.style.touchAction = lock.htmlTouchAction;
    if (entryDragTouchMoveBlockerRef.current) {
      document.removeEventListener("touchmove", entryDragTouchMoveBlockerRef.current, { capture: true });
      entryDragTouchMoveBlockerRef.current = null;
    }
    if (lock.main) {
      lock.main.style.overflow = lock.mainOverflow;
      lock.main.style.touchAction = lock.mainTouchAction;
      lock.main.scrollTop = lock.mainScrollTop;
    }
    entryDragScrollLockRef.current = null;
  }, []);

  const isEntryOverTrash = useCallback((clientX: number, clientY: number, width: number, height: number) => {
    const trashRect = entryTrashRef.current?.getBoundingClientRect();
    if (!trashRect) return false;
    const entryRect = {
      left: clientX - width / 2,
      right: clientX + width / 2,
      top: clientY - height / 2,
      bottom: clientY + height / 2,
    };
    return entryRect.left < trashRect.right
      && entryRect.right > trashRect.left
      && entryRect.top < trashRect.bottom
      && entryRect.bottom > trashRect.top;
  }, []);

  const resetEntryDrag = useCallback(() => {
    clearEntryDragTimer();
    const session = entryDragRef.current;
    if (session?.dragging) {
      suppressEntryClick();
    }
    if (session) {
      try {
        session.target.releasePointerCapture(session.pointerId);
      } catch {
        // Pointer capture may already be gone.
      }
    }
    entryDragRef.current = null;
    setEntryDrag(null);
    unlockEntryDragScroll();
  }, [clearEntryDragTimer, suppressEntryClick, unlockEntryDragScroll]);

  const updateEntryDragPosition = useCallback((clientX: number, clientY: number) => {
    const session = entryDragRef.current;
    if (!session?.dragging) return;
    const lock = entryDragScrollLockRef.current;
    if (lock?.main) lock.main.scrollTop = lock.mainScrollTop;
    const isOverTrash = isEntryOverTrash(clientX, clientY, session.width, session.height);
    setEntryDrag({
      entry: session.entry,
      x: clientX,
      y: clientY,
      width: session.width,
      height: session.height,
      isOverTrash,
    });
  }, [isEntryOverTrash]);

  const finishEntryDrag = useCallback((clientX: number, clientY: number) => {
    const session = entryDragRef.current;
    if (!session) return;
    const shouldDelete = session.dragging && isEntryOverTrash(clientX, clientY, session.width, session.height);
    const entry = session.entry;
    resetEntryDrag();
    if (shouldDelete) setDeleteCandidateEntry(entry);
  }, [isEntryOverTrash, resetEntryDrag]);

  useEffect(() => {
    if (!entryDrag) return;
    const handleWindowPointerMove = (event: globalThis.PointerEvent) => {
      const session = entryDragRef.current;
      if (!session?.dragging || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      updateEntryDragPosition(event.clientX, event.clientY);
    };
    const handleWindowPointerUp = (event: globalThis.PointerEvent) => {
      const session = entryDragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      finishEntryDrag(event.clientX, event.clientY);
    };
    const handleWindowPointerCancel = (event: globalThis.PointerEvent) => {
      const session = entryDragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      resetEntryDrag();
    };
    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp, { passive: false });
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
    };
  }, [entryDrag, finishEntryDrag, resetEntryDrag, updateEntryDragPosition]);

  useEffect(() => {
    return () => {
      resetEntryDrag();
      unlockEntryDragScroll();
      if (entryDragClickSuppressTimerRef.current !== null) {
        window.clearTimeout(entryDragClickSuppressTimerRef.current);
        entryDragClickSuppressTimerRef.current = null;
      }
    };
  }, [resetEntryDrag, unlockEntryDragScroll]);

  const handleEntryPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>, entry: DiaryEntry) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearEntryDragTimer();
    const rect = event.currentTarget.getBoundingClientRect();
    const target = event.currentTarget;
    entryDragRef.current = {
      entry,
      pointerId: event.pointerId,
      target,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
      timer: window.setTimeout(() => {
        const session = entryDragRef.current;
        if (!session || session.pointerId !== event.pointerId || session.dragging) return;
        session.dragging = true;
        session.timer = null;
        suppressEntryClick(900);
        lockEntryDragScroll();
        try {
          session.target.setPointerCapture(session.pointerId);
        } catch {
          // Some touch browsers release capture during native gestures.
        }
        setEntryDrag({
          entry: session.entry,
          x: event.clientX,
          y: event.clientY,
          width: session.width,
          height: session.height,
          isOverTrash: isEntryOverTrash(event.clientX, event.clientY, session.width, session.height),
        });
      }, 430),
      dragging: false,
    };
  }, [clearEntryDragTimer, isEntryOverTrash, lockEntryDragScroll, suppressEntryClick]);

  const handleEntryPointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.dragging) {
      if (Math.hypot(dx, dy) > 8) {
        clearEntryDragTimer();
        entryDragRef.current = null;
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    updateEntryDragPosition(event.clientX, event.clientY);
  }, [clearEntryDragTimer, updateEntryDragPosition]);

  const handleEntryPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finishEntryDrag(event.clientX, event.clientY);
  }, [finishEntryDrag]);

  const handleEntryPointerCancel = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    resetEntryDrag();
  }, [resetEntryDrag]);

  const handleEntryPointerLeave = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId || session.dragging) return;
    clearEntryDragTimer();
    entryDragRef.current = null;
  }, [clearEntryDragTimer]);

  const characterFilteredEntries = useMemo(() => {
    const result = selectedFilterCharacterIds.length > 0
      ? entries.filter(e => selectedFilterCharacterIds.includes(e.characterId))
      : entries;
    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [entries, selectedFilterCharacterIds]);

  const filteredEntries = useMemo(() => {
    return characterFilteredEntries.filter(e => isSameDay(new Date(e.createdAt), selectedDate));
  }, [characterFilteredEntries, selectedDate]);

  return (
    <section className={`diary-app diary-entry-app ${entryDrag ? "is-entry-dragging" : ""}`} style={diaryEntryStyle}>
      {generatingCharacterIds.length > 0 && (
        <div className="diary-generating-toast" role="status">
          <span className="diary-generating-toast-spinner" aria-hidden="true" />
          正在生成日记{generatingCharacterIds.length > 1 ? `（${generatingCharacterIds.length} 篇）` : ""}…
        </div>
      )}
      <header className="diary-app-header diary-entry-header">
        <button
          type="button"
          className="diary-icon-btn"
          onClick={onBack}
          aria-label="返回"
        >
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1>{view === "home" ? "Home" : "Diary"}</h1>
        </div>
        <button
          type="button"
          className="diary-icon-btn diary-header-spacer"
          onClick={() => setSettingsModalOpen(true)}
          aria-label="设置"
        >
          <Settings size={20} />
        </button>
      </header>

      {view === "timeline" ? (
        <>
          <DiaryDateStrip
            entries={characterFilteredEntries}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
          />

          <main ref={entryMainRef} className="diary-entry-main">
            {filteredEntries.length === 0 ? (
              <div className="diary-entry-empty">
                <NotebookPen size={34} strokeWidth={1.5} />
                <h2>还没有日记</h2>
                <button type="button" onClick={() => setWriteMenuOpen(true)}>让TA写一篇</button>
              </div>
            ) : (
              <div className="diary-entry-list">
                {filteredEntries.map(entry => (
                  <DiaryEntryCard
                    key={entry.id}
                    entry={entry}
                    avatarUrl={resolveEntryAvatar(entry)}
                    isDragSource={entryDrag?.entry.id === entry.id}
                    isExpanded={expandedEntryIds.has(entry.id)}
                    onPointerDown={(event) => handleEntryPointerDown(event, entry)}
                    onPointerMove={handleEntryPointerMove}
                    onPointerUp={handleEntryPointerUp}
                    onPointerCancel={handleEntryPointerCancel}
                    onPointerLeave={handleEntryPointerLeave}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (entryDragClickSuppressedRef.current) return;
                      toggleEntryExpanded(entry.id);
                    }}
                    onEdit={() => setEditCandidateEntry(entry)}
                  />
                ))}
              </div>
            )}
          </main>
        </>
      ) : (
        <DiaryHomeView
          characters={characters}
          entries={entries}
          onEntriesChanged={refreshEntries}
          onNotice={notify}
        />
      )}

      <nav className="diary-bottom-nav">
        <button type="button" className="diary-nav-btn" onClick={() => setFilterPanelOpen(true)}>
          <Users size={24} />
        </button>
        <div className="diary-nav-tabs">
          <button
            type="button"
            className={`diary-nav-tab ${view === "timeline" ? "is-active" : ""}`}
            onClick={() => setView("timeline")}
          >
            <BookOpenText size={24} />
          </button>
          <button
            type="button"
            className={`diary-nav-tab ${view === "home" ? "is-active" : ""}`}
            onClick={() => setView("home")}
          >
            <User size={24} />
          </button>
        </div>
        <button type="button" className="diary-nav-fab" onClick={() => setWriteMenuOpen(true)}>
          <Plus size={24} />
        </button>
      </nav>

      {writeMenuOpen ? (
        <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={() => setWriteMenuOpen(false)}>
          <div className="diary-write-menu" onClick={e => e.stopPropagation()}>
            <button type="button" onClick={() => { setWriteMenuOpen(false); setSelfWritePanelOpen(true); }}>
              <PenLine size={20} /> 自己写
            </button>
            <button type="button" onClick={() => { setWriteMenuOpen(false); setWritePanelOpen(true); }}>
              <WandSparkles size={20} /> 角色写
            </button>
          </div>
        </div>
      ) : null}

      {filterPanelOpen ? (
        <DiaryFilterPanel
          characters={characters}
          selectedIds={selectedFilterCharacterIds}
          onChange={setSelectedFilterCharacterIds}
          onClose={() => setFilterPanelOpen(false)}
        />
      ) : null}

      {selfWritePanelOpen ? (
        <DiarySelfWritePanel
          onClose={() => setSelfWritePanelOpen(false)}
          onSubmit={(entry) => {
            createDiaryEntry(entry);
            refreshEntries();
            setSelfWritePanelOpen(false);
          }}
        />
      ) : null}

      {writePanelOpen ? (
        <DiaryEntryWritePanel
          characters={characters}
          onGenerateMany={generateForCharacters}
          onClose={() => setWritePanelOpen(false)}
        />
      ) : null}

      {settingsModalOpen ? (
        <DiarySettingsModal
          diaryFontScale={diaryFontScale}
          onScaleChange={handleDiaryFontScaleChange}
          onConfirmFont={handleDiaryFontConfirm}
          hasUnsavedFontScale={Math.abs(diaryFontScale - savedDiaryFontScale) > 0.001}
          onResetFont={handleDiaryFontReset}
          characters={characters}
          settings={settings}
          generatingCharacterIds={generatingCharacterIds}
          onTimerSettingsChange={setSettings}
          onClose={() => setSettingsModalOpen(false)}
        />
      ) : null}

      {editCandidateEntry ? (
        <DiaryEntryEditPanel
          entry={editCandidateEntry}
          onClose={() => setEditCandidateEntry(null)}
          onSubmit={(patch) => {
            updateDiaryEntry(editCandidateEntry.id, patch);
            refreshEntries();
            setEditCandidateEntry(null);
          }}
        />
      ) : null}

      {deleteCandidateEntry ? (
        <div
          className="nw-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="diary-entry-delete-title"
          onClick={() => setDeleteCandidateEntry(null)}
        >
          <section className="nw-delete-confirm" onClick={event => event.stopPropagation()}>
            <div className="nw-delete-confirm-icon">
              <Trash2 size={24} strokeWidth={1.8} />
            </div>
            <h2 id="diary-entry-delete-title">删除日记</h2>
            <p>这篇日记会被删除，对应的短期记忆也会消失</p>
            <div>
              <button type="button" className="nw-secondary-btn" onClick={() => setDeleteCandidateEntry(null)}>取消</button>
              <button type="button" className="nw-danger-btn" onClick={() => deleteEntry(deleteCandidateEntry)}>
                <span className="note-wall-primary-content">
                  <span>删除</span>
                </span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <div
        ref={entryTrashRef}
        className={`diary-entry-trash-bin ${entryDrag ? "is-visible" : ""} ${entryDrag?.isOverTrash ? "is-over" : ""}`}
        aria-hidden={!entryDrag}
      >
        <Trash2 size={30} strokeWidth={1.8} />
      </div>

      {entryDrag ? (
        <div
          className="diary-entry-card diary-entry-drag-ghost"
          style={{
            left: entryDrag.x,
            top: entryDrag.y,
            width: entryDrag.width,
            minHeight: entryDrag.height,
          }}
        >
          <DiaryEntryCardContent entry={entryDrag.entry} avatarUrl={resolveEntryAvatar(entryDrag.entry)} />
        </div>
      ) : null}
    </section>
  );
}

function DiaryEntryCardContent({ entry, avatarUrl, isExpanded, onEdit }: {
  entry: DiaryEntry;
  avatarUrl?: string;
  isExpanded?: boolean;
  onEdit?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const preview = entry.blocks.map(blockPlainText).filter(Boolean).join(" ");
  const { date: entryDate, weekdayTime: entryWeekdayTime } = formatEntryDateParts(entry.createdAt);
  return (
    <>
      <div className="diary-entry-card-header">
        <div className="diary-entry-card-time-group">
          <time className="diary-entry-card-date">{entryDate}</time>
          {entryWeekdayTime && <span className="diary-entry-card-weekday-time">{entryWeekdayTime}</span>}
        </div>
        <span className="diary-entry-card-author">
          {entry.characterName}
          <span className="diary-entry-card-avatar">
            {avatarUrl ? <img src={avatarUrl} alt="" /> : <Bot size={18} />}
          </span>
        </span>
      </div>
      <div className={`diary-entry-card-body ${isExpanded ? "is-expanded" : "is-clamped"}`}>
        {entry.blocks.map((block, index) => (
          <DiaryBlockView key={`${block.type}-${index}`} block={block} />
        ))}
      </div>
      <div className="diary-entry-card-pills">
        {entry.weather && <span className="diary-entry-pill">{entry.weather}</span>}
        {entry.mood && <span className="diary-entry-pill">{entry.mood}</span>}
      </div>
      <div className="diary-entry-card-actions">
        <div className="diary-entry-card-actions-group">
          <button type="button" className="diary-entry-action-btn"><Heart size={18} /></button>
          <button type="button" className="diary-entry-action-btn"><MessageCircle size={18} /></button>
          <button type="button" className="diary-entry-action-btn diary-entry-share-btn"><Share2 size={18} /></button>
        </div>
        <div className="diary-entry-card-actions-group">
          <button type="button" className="diary-entry-action-btn" aria-label="修改" onClick={onEdit}><Pencil size={18} /></button>
        </div>
      </div>
    </>
  );
}

function DiaryEntryCard({
  entry,
  avatarUrl,
  isDragSource,
  isExpanded,
  onClick,
  onEdit,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
}: {
  entry: DiaryEntry;
  avatarUrl?: string;
  isDragSource: boolean;
  isExpanded?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onEdit: (event: MouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`diary-entry-card ${isDragSource ? "is-drag-source" : ""}`}
      draggable={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={event => event.preventDefault()}
      onClick={onClick}
    >
      <DiaryEntryCardContent
        entry={entry}
        avatarUrl={avatarUrl}
        isExpanded={isExpanded}
        onEdit={event => { event.stopPropagation(); onEdit(event); }}
      />
    </button>
  );
}

function DiaryEntryWritePanel({ characters, onGenerateMany, onClose }: {
  characters: Character[];
  onGenerateMany: (characterIds: string[], trigger?: DiaryEntryTrigger) => Promise<void> | void;
  onClose: () => void;
}) {
  const [selectedImmediateIds, setSelectedImmediateIds] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);

  const toggleImmediateCharacter = (characterId: string) => {
    setSelectedImmediateIds(prev => prev.includes(characterId)
      ? prev.filter(id => id !== characterId)
      : [...prev, characterId]);
  };

  const handleConfirm = async () => {
    if (confirming || selectedImmediateIds.length === 0) return;
    setConfirming(true);
    try {
      await onGenerateMany(selectedImmediateIds, "manual");
      setSelectedImmediateIds([]);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings diary-entry-write-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>让TA写一篇</h2>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <CharacterAvatarGrid
          characters={characters}
          selectedIds={selectedImmediateIds}
          busyIds={[]}
          disabled={confirming}
          onToggle={toggleImmediateCharacter}
        />
        {selectedImmediateIds.length > 0 ? (
          <button
            type="button"
            className={`diary-entry-confirm-btn ${confirming ? "is-loading" : ""}`}
            disabled={confirming}
            onClick={handleConfirm}
            aria-busy={confirming}
          >
            <span className="note-wall-primary-content">
              {confirming ? <span className="note-wall-primary-spinner" aria-hidden="true" /> : null}
              {confirming ? null : <span>{`确认让 ${selectedImmediateIds.length} 个角色写日记`}</span>}
            </span>
          </button>
        ) : null}
      </section>
    </div>
  );
}

function DiarySettingsModal({
  diaryFontScale,
  onScaleChange,
  onConfirmFont,
  hasUnsavedFontScale,
  onResetFont,
  characters,
  settings,
  generatingCharacterIds,
  onTimerSettingsChange,
  onClose,
}: {
  diaryFontScale: number;
  onScaleChange: (scale: number) => void;
  onConfirmFont: () => void;
  hasUnsavedFontScale: boolean;
  onResetFont: () => void;
  characters: Character[];
  settings: DiaryEntryTimerSettings;
  generatingCharacterIds: string[];
  onTimerSettingsChange: (settings: DiaryEntryTimerSettings) => void;
  onClose: () => void;
}) {
  return (
    <div className="nw-modal-backdrop is-centered" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings diary-settings-modal" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>设置</h2>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <section className="diary-settings-section diary-home-flat-card">
          <header className="diary-home-flat-header-solo">
            <h2>日记字号</h2>
          </header>
          <div className="diary-home-flat-row">
            <input
              type="range"
              min="0.85"
              max="1.25"
              step="any"
              value={diaryFontScale}
              onChange={event => onScaleChange(Number(event.target.value))}
              className="diary-home-flat-slider"
            />
            <em className="diary-home-flat-value">{Math.round(diaryFontScale * 100)}%</em>
            <button
              type="button"
              className="diary-home-flat-icon-btn"
              onClick={onConfirmFont}
              disabled={!hasUnsavedFontScale}
              aria-label="确认字号"
            >
              <Check size={16} />
            </button>
            <button type="button" className="diary-home-flat-icon-btn" onClick={onResetFont} aria-label="恢复默认字号">
              <RotateCcw size={16} />
            </button>
          </div>
        </section>

        <section className="diary-settings-section diary-home-flat-card">
          <header>
            <h2>定时写日记</h2>
          </header>
          <div className="diary-home-flat-row">
            <label className="diary-home-flat-toggle">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={event => onTimerSettingsChange({ ...settings, enabled: event.target.checked })}
              />
              <span>开启</span>
            </label>
            <label className="diary-home-flat-hours">
              <span>每</span>
              <input
                type="number"
                min={1}
                max={720}
                value={settings.intervalHours}
                onChange={event => onTimerSettingsChange({ ...settings, intervalHours: Math.max(1, Math.min(720, Number(event.target.value) || 24)) })}
              />
              <span>小时</span>
            </label>
          </div>

          <div className="diary-entry-character-section diary-home-flat-character-section">
            <div className="diary-entry-section-title">
              <strong>定时角色</strong>
              <span>{settings.characterIds.length ? `已选 ${settings.characterIds.length} 个` : "默认全部"}</span>
            </div>
            <CharacterAvatarGrid
              characters={characters}
              selectedIds={settings.characterIds}
              busyIds={[]}
              disabled={false}
              onToggle={characterId => onTimerSettingsChange({
                ...settings,
                characterIds: settings.characterIds.includes(characterId)
                  ? settings.characterIds.filter(id => id !== characterId)
                  : [...settings.characterIds, characterId],
              })}
            />
          </div>
        </section>
      </section>
    </div>
  );
}

function DiaryFilterPanel({ characters, selectedIds, onChange, onClose }: {
  characters: Character[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
}) {
  const toggleCharacter = (characterId: string) => {
    onChange(selectedIds.includes(characterId)
      ? selectedIds.filter(id => id !== characterId)
      : [...selectedIds, characterId]);
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings diary-entry-write-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>筛选角色</h2>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <CharacterAvatarGrid
          characters={characters}
          selectedIds={selectedIds}
          busyIds={[]}
          disabled={false}
          onToggle={toggleCharacter}
        />
      </section>
    </div>
  );
}

function DiaryEntryEditPanel({ entry, onClose, onSubmit }: {
  entry: DiaryEntry;
  onClose: () => void;
  onSubmit: (patch: { body: string; mood: string; weather: string; blocks: DiaryEntryBlock[] }) => void;
}) {
  const [body, setBody] = useState(() => entry.blocks.map(blockPlainText).filter(Boolean).join("\n\n") || entry.body);
  const [weather, setWeather] = useState(entry.weather);
  const [mood, setMood] = useState(entry.mood);

  const handleSubmit = () => {
    if (!body.trim()) return;
    onSubmit({
      body,
      mood,
      weather,
      blocks: [{ type: "paragraph", text: body }],
    });
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings diary-entry-write-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>修改日记</h2>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="diary-self-write-form">
          <input type="text" placeholder="天气 (可选)" value={weather} onChange={e => setWeather(e.target.value)} />
          <input type="text" placeholder="心情 (可选)" value={mood} onChange={e => setMood(e.target.value)} />
          <textarea placeholder="写点什么..." value={body} onChange={e => setBody(e.target.value)} rows={10} />
          <button type="button" className="diary-entry-confirm-btn" onClick={handleSubmit} disabled={!body.trim()}>
            <span className="note-wall-primary-content">
              <span>保存</span>
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}

const SELF_ENTRY_AUTHOR_NAME = "我";

function DiarySelfWritePanel({ onClose, onSubmit }: {
  onClose: () => void;
  onSubmit: (entry: Omit<DiaryEntry, "id" | "createdAt" | "updatedAt">) => void;
}) {
  const [body, setBody] = useState("");
  const [weather, setWeather] = useState("");
  const [mood, setMood] = useState("");

  const handleSubmit = () => {
    if (!body.trim()) return;

    onSubmit({
      characterId: SELF_ENTRY_CHARACTER_ID,
      characterName: SELF_ENTRY_AUTHOR_NAME,
      title: "无题",
      dateLabel: "",
      mood,
      weather,
      tags: [],
      body,
      blocks: [{ type: "paragraph", text: body }],
      trigger: "manual",
      sharedCharacterIds: [],
    });
  };

  return (
    <div className="nw-modal-backdrop is-centered" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings diary-self-write-modal" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>自己写</h2>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="diary-self-write-form">
          <input type="text" placeholder="天气 (可选)" value={weather} onChange={e => setWeather(e.target.value)} />
          <input type="text" placeholder="心情 (可选)" value={mood} onChange={e => setMood(e.target.value)} />
          <textarea placeholder="写点什么..." value={body} onChange={e => setBody(e.target.value)} rows={5} />
          <button type="button" className="diary-entry-confirm-btn" onClick={handleSubmit} disabled={!body.trim()}>
            <span className="note-wall-primary-content">
              <span>保存</span>
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}
