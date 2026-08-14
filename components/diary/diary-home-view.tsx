"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Pencil,
  RotateCcw,
  Share2,
  Trash2,
  User,
  X,
} from "lucide-react";

import type { Character } from "@/lib/character-types";
import { SELF_ENTRY_CHARACTER_ID, type DiaryEntry } from "@/lib/diary-entry-types";
import { deleteDiaryEntry, updateDiaryEntry } from "@/lib/diary-entry-storage";
import { shareDiaryEntryWithCharacters } from "@/lib/diary-memory-share";
import { resolveUserIdentity } from "@/lib/settings-storage";
import {
  loadDiaryBackgroundImage,
  loadDiarySignature,
  saveDiaryBackgroundImage,
  saveDiarySignature,
  clearDiaryBackgroundImage,
} from "@/lib/diary-profile-storage";
import {
  MOOD_OPTIONS,
  formatDateKey,
  loadMoodCalendar,
  setMoodForDate,
  type MoodCalendarMap,
  type MoodId,
} from "@/lib/diary-mood-storage";
import { CharacterAvatarGrid } from "./diary-character-avatar-grid";
import { MoodIcon } from "./diary-mood-icons";
import { DiaryBlockView, blockPlainText, formatEntryDateParts } from "./diary-entry-render-utils";

type DiaryHomeViewProps = {
  // 字号与定时写日记的设置已移到顶栏齿轮弹窗（DiarySettingsModal），
  // Home 页只保留资料卡、心情日历和「我的日记」列表。
  characters: Character[];
  entries: DiaryEntry[];
  onEntriesChanged: () => void;
  onNotice?: (message: string) => void;
};

// English weekday abbreviations, matching the format already used by the
// Diary timeline (formatEntryDateParts) so dates read consistently across
// the whole app.
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function formatBadgeDate(iso: string): { md: string; wd: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { md: "--/--", wd: "" };
  return {
    md: `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`,
    wd: WEEKDAY_LABELS[date.getDay()],
  };
}

// Resize + compress a picked image to a data URL before storing it in kv,
// same approach used for user-identity avatar uploads.
function fileToDataUrl(file: File, maxSize = 900, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("no canvas context"));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/webp", quality));
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function DiaryHomeView({
  characters,
  entries,
  onEntriesChanged,
  onNotice,
}: DiaryHomeViewProps) {
  const [identityName, setIdentityName] = useState("");
  const [identityAvatar, setIdentityAvatar] = useState("");

  useEffect(() => {
    const refreshIdentity = () => {
      const identity = resolveUserIdentity();
      setIdentityName(identity?.name || "我");
      setIdentityAvatar(identity?.avatarUrl || "");
    };
    refreshIdentity();
    window.addEventListener("user-identities-updated", refreshIdentity);
    window.addEventListener("settings-bindings-updated", refreshIdentity);
    return () => {
      window.removeEventListener("user-identities-updated", refreshIdentity);
      window.removeEventListener("settings-bindings-updated", refreshIdentity);
    };
  }, []);

  // Nickname mirrors the system user identity's name (same field chat uses)
  // but is read-only here — it's edited from the identity settings, not
  // from the diary home page.
  const [signature, setSignature] = useState(() => loadDiarySignature());
  const [editingSignature, setEditingSignature] = useState(false);
  const [signatureDraft, setSignatureDraft] = useState("");

  const commitSignature = () => {
    saveDiarySignature(signatureDraft);
    setSignature(loadDiarySignature());
    setEditingSignature(false);
  };

  const [bgImage, setBgImage] = useState(() => loadDiaryBackgroundImage());
  const bgFileInputRef = useRef<HTMLInputElement | null>(null);

  const handlePickBgImage = () => bgFileInputRef.current?.click();

  const handleBgFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      saveDiaryBackgroundImage(dataUrl);
      setBgImage(dataUrl);
    } catch {
      onNotice?.("背景图上传失败，请换一张图片试试。");
    }
  };

  const handleClearBgImage = () => {
    clearDiaryBackgroundImage();
    setBgImage("");
  };

  // ── Mood calendar ──────────────────────────────────────────
  const [moodMap, setMoodMapState] = useState<MoodCalendarMap>(() => loadMoodCalendar());
  const [monthCursor, setMonthCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [moodPickerDateKey, setMoodPickerDateKey] = useState<string | null>(null);

  const monthLabel = `${monthCursor.getFullYear()}年${monthCursor.getMonth() + 1}月`;

  const calendarCells = useMemo(() => {
    const year = monthCursor.getFullYear();
    const month = monthCursor.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const totalCells = firstWeekday + daysInMonth;
    const rows = Math.ceil(totalCells / 7);
    const cells: Array<Date | null> = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));
    while (cells.length < rows * 7) cells.push(null);
    return cells;
  }, [monthCursor]);

  const handlePickMood = (moodId: MoodId) => {
    if (!moodPickerDateKey) return;
    setMoodMapState(setMoodForDate(moodPickerDateKey, moodId));
    setMoodPickerDateKey(null);
  };

  const handleClearMood = () => {
    if (!moodPickerDateKey) return;
    setMoodMapState(setMoodForDate(moodPickerDateKey, null));
    setMoodPickerDateKey(null);
  };

  // ── Diary list + detail ────────────────────────────────────
  // "我的日记" / the profile count are about entries the user wrote about
  // themselves, not the characters' own diaries — filter those out here
  // rather than showing everyone's entries under the user's profile.
  const selfEntries = useMemo(
    () => entries.filter(entry => entry.characterId === SELF_ENTRY_CHARACTER_ID),
    [entries],
  );
  const sortedEntries = useMemo(
    () => [...selfEntries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [selfEntries],
  );

  const [detailEntry, setDetailEntry] = useState<DiaryEntry | null>(null);
  const [detailEditing, setDetailEditing] = useState(false);
  const [detailBody, setDetailBody] = useState("");
  const [detailMood, setDetailMood] = useState("");
  const [detailWeather, setDetailWeather] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [sharePanelOpen, setSharePanelOpen] = useState(false);

  const openDetail = (entry: DiaryEntry) => {
    setDetailEntry(entry);
    setDetailEditing(false);
    setDeleteConfirmOpen(false);
    setSharePanelOpen(false);
  };

  const closeDetail = () => {
    setDetailEntry(null);
    setDetailEditing(false);
    setDeleteConfirmOpen(false);
    setSharePanelOpen(false);
  };

  const startEditDetail = () => {
    if (!detailEntry) return;
    setDetailBody(detailEntry.blocks.map(blockPlainText).filter(Boolean).join("\n\n") || detailEntry.body);
    setDetailMood(detailEntry.mood);
    setDetailWeather(detailEntry.weather);
    setDetailEditing(true);
  };

  const saveDetailEdit = () => {
    if (!detailEntry || !detailBody.trim()) return;
    const updated = updateDiaryEntry(detailEntry.id, {
      body: detailBody,
      mood: detailMood,
      weather: detailWeather,
      blocks: [{ type: "paragraph", text: detailBody }],
    });
    onEntriesChanged();
    if (updated) setDetailEntry(updated);
    setDetailEditing(false);
    onNotice?.("已保存修改。");
  };

  // Sharing injects the entry's content into a character's long-term memory,
  // so it only makes sense for entries the user wrote about themselves —
  // sharing a character's own diary "at" itself (or at other characters)
  // isn't what this button is for.
  const openSharePanel = () => {
    if (!detailEntry) return;
    if (detailEntry.characterId !== SELF_ENTRY_CHARACTER_ID) {
      onNotice?.("只有「自己写」的日记可以分享给角色。");
      return;
    }
    setSharePanelOpen(true);
  };

  const handleShareToCharacters = async (characterIds: string[]) => {
    if (!detailEntry) return;
    const { succeeded, failed } = await shareDiaryEntryWithCharacters(detailEntry, characterIds);
    const nameOf = (id: string) => characters.find(c => c.id === id)?.name ?? id;

    if (succeeded.length > 0) {
      setDetailEntry(current => current
        ? { ...current, sharedCharacterIds: Array.from(new Set([...current.sharedCharacterIds, ...succeeded])) }
        : current);
      onEntriesChanged();
      onNotice?.(`已分享给 ${succeeded.map(nameOf).join("、")}。`);
    }
    if (failed.length > 0) {
      onNotice?.(`分享失败：${failed.map(nameOf).join("、")}`);
    }
    if (succeeded.length > 0 && failed.length === 0) {
      setSharePanelOpen(false);
    }
  };

  const confirmDeleteDetail = () => {
    if (!detailEntry) return;
    deleteDiaryEntry(detailEntry.id);
    onEntriesChanged();
    onNotice?.(`已删除《${detailEntry.title}》。`);
    closeDetail();
  };

  // ── Home main view ─────────────────────────────────────────
  // Home renders inline (no header/back button of its own — the shared
  // Diary header above it stays put) and the diary detail is a paper-style
  // popup on top of it, matching the "自己写" (self-write) modal, rather
  // than a separate full-screen page.
  return (
    <>
      <main className="diary-settings-main diary-home-main">
        <section
          className="diary-home-profile-card"
          style={{ "--diary-home-bg-image": bgImage ? `url(${bgImage})` : "none" } as CSSProperties}
        >
          <div
            className="diary-home-profile-banner"
            role="button"
            tabIndex={0}
            aria-label="点击更换背景图"
            onClick={handlePickBgImage}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handlePickBgImage(); } }}
          >
            <div className="diary-home-profile-banner-fade" />
            {bgImage ? (
              <div className="diary-home-profile-banner-actions">
                <button
                  type="button"
                  className="diary-home-banner-btn"
                  onClick={e => { e.stopPropagation(); handleClearBgImage(); }}
                  aria-label="恢复默认背景"
                >
                  <RotateCcw size={13} />
                </button>
              </div>
            ) : null}
            <input
              ref={bgFileInputRef}
              type="file"
              accept="image/*"
              className="diary-home-hidden-file-input"
              onChange={handleBgFileChange}
            />
          </div>

          <div className="diary-home-profile-body">
            <div className="diary-home-profile-avatar-wrap">
              <div className="diary-home-profile-avatar">
                {identityAvatar ? <img src={identityAvatar} alt="" /> : <User size={30} />}
              </div>
              <span className="diary-home-profile-avatar-badge" aria-hidden="true">
                <Camera size={11} />
              </span>
            </div>
            <div className="diary-home-profile-info">
              <div className="diary-home-profile-name-row">
                <span className="diary-home-name-btn diary-home-name-static">{identityName || "我"}</span>
                <span className="diary-home-profile-count">{selfEntries.length} 篇日记</span>
              </div>
              {editingSignature ? (
                <input
                  type="text"
                  autoFocus
                  className="diary-home-signature-input"
                  value={signatureDraft}
                  maxLength={60}
                  onChange={e => setSignatureDraft(e.target.value)}
                  onBlur={commitSignature}
                  onKeyDown={e => {
                    if (e.key === "Enter") { e.currentTarget.blur(); }
                    if (e.key === "Escape") { setEditingSignature(false); }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="diary-home-signature-btn"
                  onClick={() => { setSignatureDraft(signature); setEditingSignature(true); }}
                >
                  {signature || "点击添加签名"}
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="diary-settings-section diary-home-mood-card">
          <header className="diary-home-mood-header">
            <button type="button" className="diary-home-month-nav-btn" onClick={() => setMonthCursor(c => new Date(c.getFullYear(), c.getMonth() - 1, 1))} aria-label="上个月">
              <ChevronLeft size={16} />
            </button>
            <h2>{monthLabel}</h2>
            <button type="button" className="diary-home-month-nav-btn" onClick={() => setMonthCursor(c => new Date(c.getFullYear(), c.getMonth() + 1, 1))} aria-label="下个月">
              <ChevronRight size={16} />
            </button>
          </header>

          <div className="diary-home-mood-weekdays">
            {WEEKDAY_LABELS.map(label => <span key={label}>{label}</span>)}
          </div>
          <div className="diary-home-mood-grid">
            {calendarCells.map((date, index) => {
              if (!date) return <div key={`empty-${index}`} className="diary-home-mood-cell is-empty" />;
              const dateKey = formatDateKey(date);
              const mood = moodMap[dateKey];
              return (
                <button
                  key={dateKey}
                  type="button"
                  className="diary-home-mood-cell"
                  onClick={() => setMoodPickerDateKey(dateKey)}
                >
                  <span className="diary-home-mood-cell-date">{date.getDate()}</span>
                  <span className="diary-home-mood-cell-icon">
                    {mood ? <MoodIcon id={mood} size={18} /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="diary-settings-section">
          <header>
            <h2>我的日记</h2>
            <p>共 {selfEntries.length} 篇，点击查看详情</p>
          </header>
          {sortedEntries.length === 0 ? (
            <p className="diary-entry-empty-line">还没有日记</p>
          ) : (
            <div className="diary-home-entry-list">
              {sortedEntries.map(entry => {
                const summary = clipText(entry.blocks.map(blockPlainText).filter(Boolean).join(" "), 36);
                const badge = formatBadgeDate(entry.createdAt);
                return (
                  <button key={entry.id} type="button" className="diary-home-entry-row" onClick={() => openDetail(entry)}>
                    <span className="diary-home-entry-row-main">
                      <strong>{entry.title}</strong>
                      <em>{summary || "（空）"}</em>
                    </span>
                    <span className="diary-home-entry-row-date">
                      <b>{badge.md}</b>
                      <small>{badge.wd}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {moodPickerDateKey ? (
        <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={() => setMoodPickerDateKey(null)}>
          <section className="diary-entry-settings diary-mood-picker-panel" onClick={event => event.stopPropagation()}>
            <header>
              <div>
                <h2>{moodPickerDateKey.replace(/-/g, "/")} 的心情</h2>
              </div>
              <button type="button" className="diary-icon-btn" onClick={() => setMoodPickerDateKey(null)} aria-label="关闭">
                <X size={16} />
              </button>
            </header>
            <div className="diary-mood-picker-grid">
              {MOOD_OPTIONS.map(option => (
                <button
                  key={option.id}
                  type="button"
                  className={`diary-mood-picker-item ${moodMap[moodPickerDateKey] === option.id ? "is-selected" : ""}`}
                  onClick={() => handlePickMood(option.id)}
                >
                  <MoodIcon id={option.id} size={26} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
            {moodMap[moodPickerDateKey] ? (
              <button type="button" className="diary-font-reset-btn" onClick={handleClearMood}>
                清除心情
              </button>
            ) : null}
          </section>
        </div>
      ) : null}

      {detailEntry ? (
        <div className="nw-modal-backdrop is-centered" role="dialog" aria-modal="true" onClick={closeDetail}>
          <section className="diary-entry-settings diary-home-detail-modal" onClick={event => event.stopPropagation()}>
            <header>
              <div>
                <h2>{detailEditing ? "编辑日记" : "日记详情"}</h2>
              </div>
              <div className="diary-home-detail-actions">
                {!detailEditing ? (
                  <>
                    <button type="button" className="diary-icon-btn" aria-label="修改" onClick={startEditDetail}>
                      <Pencil size={15} />
                    </button>
                    <button type="button" className="diary-icon-btn" aria-label="分享" onClick={openSharePanel}>
                      <Share2 size={15} />
                    </button>
                    <button type="button" className="diary-icon-btn" aria-label="删除" onClick={() => setDeleteConfirmOpen(true)}>
                      <Trash2 size={15} />
                    </button>
                    <button type="button" className="diary-icon-btn diary-home-detail-close-view" onClick={closeDetail} aria-label="关闭">
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <button type="button" className="diary-icon-btn diary-home-detail-close-edit" onClick={closeDetail} aria-label="关闭">
                    <X size={16} />
                  </button>
                )}
              </div>
            </header>

            {detailEditing ? (
              <div className="diary-self-write-form">
                <input type="text" placeholder="天气 (可选)" value={detailWeather} onChange={e => setDetailWeather(e.target.value)} />
                <input type="text" placeholder="心情 (可选)" value={detailMood} onChange={e => setDetailMood(e.target.value)} />
                <textarea placeholder="写点什么..." value={detailBody} onChange={e => setDetailBody(e.target.value)} rows={10} />
                <button type="button" className="diary-entry-confirm-btn" onClick={saveDetailEdit} disabled={!detailBody.trim()}>
                  <span className="note-wall-primary-content"><span>保存</span></span>
                </button>
              </div>
            ) : (
              <div className="diary-home-detail-main">
                <div className="diary-home-detail-meta">
                  <time>{formatEntryDateParts(detailEntry.createdAt).date}</time>
                  <span>{detailEntry.characterName}</span>
                </div>
                <h2 className="diary-home-detail-title">{detailEntry.title}</h2>
                <div className="diary-entry-card-body is-expanded">
                  {detailEntry.blocks.map((block, index) => (
                    <DiaryBlockView key={`${block.type}-${index}`} block={block} />
                  ))}
                </div>
                <div className="diary-entry-card-pills">
                  {detailEntry.weather && <span className="diary-entry-pill">{detailEntry.weather}</span>}
                  {detailEntry.mood && <span className="diary-entry-pill">{detailEntry.mood}</span>}
                </div>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {detailEntry && deleteConfirmOpen ? (
        <div className="nw-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="diary-home-delete-title" onClick={() => setDeleteConfirmOpen(false)}>
          <section className="nw-delete-confirm" onClick={event => event.stopPropagation()}>
            <div className="nw-delete-confirm-icon">
              <Trash2 size={24} strokeWidth={1.8} />
            </div>
            <h2 id="diary-home-delete-title">删除日记</h2>
            <p>这篇日记会被删除，对应的短期记忆也会消失</p>
            <div>
              <button type="button" className="nw-secondary-btn" onClick={() => setDeleteConfirmOpen(false)}>取消</button>
              <button type="button" className="nw-danger-btn" onClick={confirmDeleteDetail}>
                <span className="note-wall-primary-content"><span>删除</span></span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {detailEntry && sharePanelOpen ? (
        <DiaryShareToMemoryPanel
          entry={detailEntry}
          characters={characters}
          onClose={() => setSharePanelOpen(false)}
          onShare={handleShareToCharacters}
        />
      ) : null}
    </>
  );
}

function DiaryShareToMemoryPanel({ entry, characters, onClose, onShare }: {
  entry: DiaryEntry;
  characters: Character[];
  onClose: () => void;
  onShare: (characterIds: string[]) => Promise<void> | void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sharing, setSharing] = useState(false);

  const alreadyShared = entry.sharedCharacterIds;
  const selectableCharacters = characters.filter(c => !alreadyShared.includes(c.id));
  const alreadySharedNames = characters
    .filter(c => alreadyShared.includes(c.id))
    .map(c => c.name);

  const toggleCharacter = (characterId: string) => {
    setSelectedIds(prev => prev.includes(characterId)
      ? prev.filter(id => id !== characterId)
      : [...prev, characterId]);
  };

  const handleConfirm = async () => {
    if (sharing || selectedIds.length === 0) return;
    setSharing(true);
    try {
      await onShare(selectedIds);
      setSelectedIds([]);
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings diary-entry-write-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>分享给角色</h2>
            <p>选中的角色会把这篇日记注入短期记忆</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        {alreadySharedNames.length > 0 ? (
          <p className="diary-entry-empty-line">已分享给：{alreadySharedNames.join("、")}</p>
        ) : null}

        {selectableCharacters.length === 0 ? (
          alreadySharedNames.length === 0 ? <p className="diary-entry-empty-line">暂无角色。</p> : null
        ) : (
          <CharacterAvatarGrid
            characters={selectableCharacters}
            selectedIds={selectedIds}
            busyIds={[]}
            disabled={sharing}
            onToggle={toggleCharacter}
          />
        )}

        {selectedIds.length > 0 ? (
          <button
            type="button"
            className={`diary-entry-confirm-btn ${sharing ? "is-loading" : ""}`}
            disabled={sharing}
            onClick={handleConfirm}
            aria-busy={sharing}
          >
            <span className="note-wall-primary-content">
              {sharing ? <span className="note-wall-primary-spinner" aria-hidden="true" /> : null}
              <span>{sharing ? "分享中…" : `分享给 ${selectedIds.length} 个角色`}</span>
            </span>
          </button>
        ) : null}
      </section>
    </div>
  );
}
