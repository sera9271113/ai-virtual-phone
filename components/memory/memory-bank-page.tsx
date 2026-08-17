"use client";

import { useState, useEffect, useCallback, useRef, type CSSProperties } from "react";
import {
    Trash2, Zap, Clock, Users, Archive, AlertCircle, Search, Brain, FileText, MoreHorizontal, Plus, Edit3, X, Check,
    Heart, Eye, User, Navigation, Compass, HelpCircle, CalendarDays, Feather, ListFilter, LayoutGrid, Circle, PenLine,
    ListChecks, Gauge,
    type LucideIcon,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/modal";
import { MemoryTimeline } from "./memory-timeline";
import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MemoryEntry, MemoryConfig, MemoryDomain, MemoryOrganizeSuggestion } from "@/lib/memory-types";
import { DEFAULT_CORE_MEMORY_PROMPT, DEFAULT_SUMMARIZATION_PROMPT, DEFAULT_ORGANIZE_PROMPT, MEMORY_DOMAIN_ORDER, MEMORY_DOMAIN_LABELS } from "@/lib/memory-types";
import {
    loadMemoryConfig,
    saveMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntry,
    deleteCharacterMemoriesByType,
    getAllCharacterIdsWithMemories,
    getMemoryCountByType,
    getLastSummarizedTimestamp,
    getLastCoreSummarizedTimestamp,
} from "@/lib/memory-storage";
import { hydrateChatStorage } from "@/lib/chat-storage";
import { loadNativeTimeline, type NativeTimelineEntry } from "@/lib/short-term-assembler";
import { runSummarizationPipeline } from "@/lib/memory-summarizer";
import { runCoreMemoryPipeline } from "@/lib/core-memory-builder";
import {
    runMemoryOrganizePipeline,
    applyOrganizeMerge,
    applyOrganizeDuplicate,
    applyOrganizeConflictResolve,
} from "@/lib/memory-organizer";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "@/lib/settings-storage";
import { generateEmbedding, resolveEmbeddingModel, estimateMemoryEmotion } from "@/lib/memory-embedding";
import { BINDING_ACCENTS } from "@/lib/ui-accent-colors";

type MemoryView = "list" | "detail" | "settings";
type MemoryTab = "short" | "shared" | "core" | "long";
type MemoryBudgetKey = "shortTermTokenBudget" | "coreMemoryTokenBudget" | "longTermTokenBudget";

const MEMORY_TOKEN_BUDGET_MAX = 100000;
const MEMORY_TOKEN_BUDGET_MIN: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 1000,
    coreMemoryTokenBudget: 100,
    longTermTokenBudget: 200,
};
const MEMORY_TOKEN_BUDGET_STEP: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 5000,
    coreMemoryTokenBudget: 1000,
    longTermTokenBudget: 1000,
};
const MANUAL_MEMORY_CONTENT_LIMIT = 3000;

type MemoryEditorState = {
    type: MemoryEntry["type"];
    entry?: MemoryEntry;
    content: string;
    domain: MemoryDomain | "unclassified";
};

type SignalEditorState = {
    entry: MemoryEntry;
    importance: number;  // 1-10
    valence: number;     // -1.0 ~ 1.0
    arousal: number;     // 0.0 ~ 1.0
};

// ── Memory domains (记忆分域) ──
// MemoryDomain / MEMORY_DOMAIN_ORDER / MEMORY_DOMAIN_LABELS are shared with
// lib/memory-types.ts (single source of truth for the taxonomy). Icons/colors
// are UI-only and stay local — copied verbatim from the html design reference
// and must not be altered.
type DomainFilterKey = MemoryDomain | "unclassified" | "all";

const MEMORY_DOMAIN_ICONS: Record<MemoryDomain, LucideIcon> = {
    bond: Heart,
    impression: Eye,
    monologue: User,
    footprint: Navigation,
    anecdote: Compass,
    puzzle: HelpCircle,
    vow: CalendarDays,
    misc: Feather,
};

const MEMORY_DOMAIN_COLORS: Record<MemoryDomain, string> = {
    bond: "#F0C2CD",
    impression: "#b1c2d6",
    monologue: "#c8bfd0",
    footprint: "#B6D3DD",
    anecdote: "#b2c3b3",
    puzzle: "#d8caaf",
    vow: "#DDA7A7",
    misc: "#B9B8BC",
};

const MEMORY_DOMAIN_META: Record<MemoryDomain, { label: string; icon: LucideIcon; color: string }> = MEMORY_DOMAIN_ORDER.reduce(
    (acc, key) => {
        acc[key] = { label: MEMORY_DOMAIN_LABELS[key], icon: MEMORY_DOMAIN_ICONS[key], color: MEMORY_DOMAIN_COLORS[key] };
        return acc;
    },
    {} as Record<MemoryDomain, { label: string; icon: LucideIcon; color: string }>,
);

const UNCLASSIFIED_COLOR = "#B0B0B0";
const ALL_DOMAIN_COLOR = "#000000";

// "未分类" is a technical fallback that only triggers when metadata.domain is
// missing entirely, or when a present domainConfidence dips below the 0.6
// threshold. When domainConfidence is absent (e.g. character-authored or
// manually-picked domains, which aren't probabilistic classifications), a
// present domain is trusted as-is and shown as classified — see 6.5.2 in the
// domain-refactor plan.
function getEntryDomain(entry: MemoryEntry): DomainFilterKey {
    const meta = entry.metadata;
    const rawDomain = meta?.domain;
    const rawConfidence = meta?.domainConfidence;
    if (typeof rawDomain !== "string" || !(MEMORY_DOMAIN_ORDER as string[]).includes(rawDomain)) {
        return "unclassified";
    }
    if (typeof rawConfidence === "number" && rawConfidence < 0.6) {
        return "unclassified";
    }
    return rawDomain as MemoryDomain;
}

function domainMeta(key: DomainFilterKey): { label: string; icon: LucideIcon; color: string } {
    if (key === "all") return { label: "全部", icon: ListFilter, color: ALL_DOMAIN_COLOR };
    if (key === "unclassified") return { label: "未分类", icon: Circle, color: UNCLASSIFIED_COLOR };
    return MEMORY_DOMAIN_META[key];
}

// Ported from the html design reference. Class names are prefixed with `mb-`
// to avoid colliding with the app's existing stylesheet; colors are copied
// as-is from the reference and must not be changed.
const MEMORY_DOMAIN_STYLES = `
.mb-sticky-header {
    position: sticky;
    top: 0;
    z-index: 20;
    margin: 0 -16px;
    padding: 10px 16px 0;
    background: #ffffff;
}

.mb-search {
    background: #FBFBFB;
    border-radius: 12px;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    margin-bottom: 18px;
}
.mb-search input {
    border: none;
    background: transparent;
    outline: none;
    width: 100%;
    margin-left: 10px;
    font-size: 14px;
    color: #334155;
}
.mb-search input::placeholder { color: #B0B0B0; font-weight: 500; }

.mb-chips-wrapper {
    display: flex;
    gap: 14px;
    margin: 0 0 4px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    padding: 0 0 14px 0;
    -ms-overflow-style: none;
    scrollbar-width: none;
}
.mb-chips-wrapper::-webkit-scrollbar { display: none; }
.mb-chip {
    flex-shrink: 0;
    width: 96px;
    height: 78px;
    background: rgba(255,255,255,0.35);
    backdrop-filter: blur(14px) saturate(160%);
    -webkit-backdrop-filter: blur(14px) saturate(160%);
    border: 1px solid rgba(255,255,255,0.5);
    box-shadow: none;
    border-radius: 16px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: flex-start;
    scroll-snap-align: start;
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    color: #64748b;
    text-align: left;
}
.mb-chip:active { transform: scale(0.94); }
.mb-chip-title { font-size: 11px; font-weight: 700; margin-bottom: 2px; }
.mb-chip-count { font-size: 9px; opacity: 0.6; font-weight: 500; }
.mb-chip-bottom { display: flex; flex-direction: column; align-items: flex-start; }

.mb-section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
}
.mb-section-title { font-size: 19px; font-weight: 800; color: #0f172a; letter-spacing: -0.5px; }
.mb-section-actions { display: flex; align-items: center; gap: 10px; }
.mb-section-action {
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #64748b;
    cursor: pointer;
    background: transparent;
    border: none;
    padding: 0;
    flex-shrink: 0;
}
.mb-section-action svg { width: 18px; height: 18px; }
.mb-section-action.is-danger { color: #cbd5e1; }
.mb-section-action.is-danger:active { color: #dc2626; }
.mb-section-action:active { color: #334155; opacity: 0.7; }

.mb-feed-list { display: flex; flex-direction: column; gap: 28px; width: 100%; min-width: 0; max-width: 100%; touch-action: pan-y; }
.mb-feed-item { display: flex; align-items: flex-start; gap: 12px; width: 100%; min-width: 0; max-width: 100%; }
.mb-feed-icon-wrap { flex-shrink: 0; width: 20px; display: flex; justify-content: flex-start; padding-top: 3px; }
.mb-feed-content-wrap { flex-grow: 1; display: flex; flex-direction: column; gap: 10px; min-width: 0; max-width: 100%; overflow-x: hidden; cursor: pointer; }
.mb-feed-text { font-size: 13px; color: #1e293b; line-height: 1.6; font-weight: 500; white-space: normal; word-wrap: break-word; }
.mb-feed-meta-rows { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.mb-feed-meta-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    overflow-x: hidden;
}
.mb-meta-tag { background: #FBFBFB; color: #64748b; font-size: 9px; font-weight: 600; padding: 4px 6px; border-radius: 4px; letter-spacing: 0.2px; white-space: nowrap; flex-shrink: 0; }
.mb-meta-tag.status-active { background: rgba(34, 197, 94, 0.15); color: #15803d; }
.mb-meta-tag.status-sleeping { background: #4b5563; color: #ffffff; }
.mb-meta-tag.status-archived { background: #cbd5e1; color: #ffffff; }
.mb-meta-tag.mb-origin-tag.is-manual { background: rgba(59, 130, 246, 0.15); color: #1d4ed8; }

.mb-feed-menu-wrap { flex-shrink: 0; position: relative; }
.mb-feed-menu-btn { color: #cbd5e1; cursor: pointer; padding-top: 2px; background: transparent; border: none; display: flex; }

.mb-organize-progress-toast {
    position: fixed;
    left: 50%;
    top: 18px;
    transform: translateX(-50%);
    z-index: 200;
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(30, 41, 59, 0.92);
    color: #ffffff;
    font-size: 11px;
    font-weight: 600;
    padding: 9px 16px;
    border-radius: 999px;
    box-shadow: 0 6px 20px rgba(15, 23, 42, 0.25);
    pointer-events: none;
    white-space: nowrap;
}
.mb-organize-progress-spinner {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #ffffff;
    animation: mb-organize-spin 0.7s linear infinite;
    flex-shrink: 0;
}
@keyframes mb-organize-spin {
    to { transform: rotate(360deg); }
}

.mb-sheet-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(15, 23, 42, 0.2);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 100;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
}
.mb-sheet-overlay.show { opacity: 1; pointer-events: auto; }
.mb-sheet-content {
    background: #ffffff;
    width: 100%;
    border-radius: 28px 28px 0 0;
    padding: 24px 20px 36px 20px;
    transform: translateY(100%);
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    box-shadow: 0 -10px 40px rgba(0,0,0,0.1);
}
.mb-sheet-overlay.show .mb-sheet-content { transform: translateY(0); }
.mb-sheet-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.mb-sheet-title { font-size: 17px; font-weight: 700; color: #0f172a; }
.mb-sheet-close {
    background: #FBFBFB;
    border-radius: 50%;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #64748b;
    cursor: pointer;
    border: none;
}
.mb-sheet-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.mb-sheet-item {
    background: transparent;
    border-radius: 12px;
    padding: 14px 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
    color: #64748b;
    font-weight: 600;
    font-size: 11px;
    cursor: pointer;
    border: none;
}

.mb-domain-picker {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
}
.mb-domain-pill {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 12px 6px;
    border-radius: 999px;
    background: #FBFBFB;
    color: #64748b;
    font-size: 11px;
    font-weight: 600;
    border: none;
    cursor: pointer;
    text-align: center;
    white-space: nowrap;
}

.mb-bottombar-glass {
    background: rgba(255,255,255,0.35) !important;
    backdrop-filter: blur(18px) saturate(180%);
    -webkit-backdrop-filter: blur(18px) saturate(180%);
    border: 1px solid rgba(255,255,255,0.5);
    box-shadow: 0 10px 30px rgba(15,23,42,0.12);
}
.mb-bottombar-glass .chat-tab { color: #64748b; background: transparent !important; }
.mb-bottombar-glass .chat-tab-active { background: transparent !important; color: #0f172a; }

.mem-edit-sheet .modal-header-btn-action {
    background: #FBFBFB;
    color: #64748b;
}
.mem-edit-sheet .modal-header-btn-action:disabled { opacity: 0.4; }

.mb-organize-sheet { max-height: 80vh; overflow-y: auto; }
.mb-organize-skip-hint {
    background: #fef3c7;
    color: #92400e;
    font-size: 11px;
    font-weight: 600;
    padding: 8px 12px;
    border-radius: 10px;
    margin: 0 0 14px;
}
.mb-organize-empty { color: #B0B0B0; font-size: 13px; text-align: center; padding: 20px 0; }
.mb-organize-list { display: flex; flex-direction: column; gap: 14px; }
.mb-organize-card {
    background: #FBFBFB;
    border-radius: 16px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.mb-organize-card-reason { font-size: 11px; color: #64748b; font-weight: 600; }
.mb-organize-entry { font-size: 13px; color: #1e293b; line-height: 1.5; }
.mb-organize-entry-row { display: flex; align-items: flex-start; gap: 10px; }
.mb-organize-entry-row .mb-organize-entry { flex: 1 1 auto; min-width: 0; }
.mb-organize-entry-toggle { display: flex; gap: 6px; flex-shrink: 0; }
.mb-organize-toggle-btn {
    width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
    flex: none !important; padding: 0 !important; color: #B0B0B0;
}
.mb-organize-toggle-btn.is-active.is-keep { background: rgba(34,197,94,0.15); border-color: rgba(34,197,94,0.4); color: #15803d; }
.mb-organize-toggle-btn.is-active.is-delete { background: rgba(239,68,68,0.15); border-color: rgba(239,68,68,0.4); color: #b91c1c; }
.mb-organize-warn-hint { color: #b91c1c; font-size: 11px; font-weight: 600; margin: 0; }
.mb-organize-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.mb-organize-actions .ui-btn { flex: 1 1 auto; font-size: 11px; padding: 8px 10px; }
.mb-organize-merge-textarea { width: 100%; min-height: 90px; font-size: 13px; resize: vertical; }

.mb-signal-edit-sheet {
    min-height: min(52vh, 52dvh);
    max-height: min(86vh, 86dvh);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
}
.mb-signal-edit-body {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding-top: 4px;
    padding-bottom: max(20px, env(safe-area-inset-bottom, 0px));
    flex: 1 0 auto;
}

.mb-signal-row { display: flex; flex-direction: column; gap: 4px; }
.mb-signal-row-head { display: flex; align-items: center; justify-content: space-between; }
.mb-signal-row-title { font-size: 12px; font-weight: 700; color: #0f172a; }
.mb-signal-row-desc { font-size: 10px; color: #94a3b8; margin: 0 0 4px; }
.mb-signal-row-value {
    font-size: 11px; font-weight: 600; color: #64748b;
    background: #FBFBFB; padding: 2px 9px; border-radius: 999px;
    min-width: 30px; text-align: center;
}

.mb-signal-bar {
    -webkit-appearance: none; -moz-appearance: none; appearance: none;
    width: 100%; height: 4px; border-radius: 999px; outline: none; margin: 2px 0;
    background: transparent;
}
.mb-signal-bar::-webkit-slider-runnable-track {
    height: 4px; border-radius: 999px;
    background: linear-gradient(to right, #0f172a 0%, #0f172a var(--fill, 0%), #e5e7eb var(--fill, 0%), #e5e7eb 100%);
}
.mb-signal-bar::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 16px; height: 16px; border-radius: 999px;
    background: #0f172a; border: 3px solid #0f172a;
    box-shadow: 0 1px 4px rgba(15, 23, 42, 0.35);
    margin-top: -6px; cursor: pointer;
}
.mb-signal-bar::-moz-range-track { height: 4px; border-radius: 999px; background: #e5e7eb; }
.mb-signal-bar::-moz-range-progress { height: 4px; border-radius: 999px; background: #0f172a; }
.mb-signal-bar::-moz-range-thumb {
    width: 16px; height: 16px; border-radius: 999px;
    background: #0f172a; border: 3px solid #0f172a;
    box-shadow: 0 1px 4px rgba(15, 23, 42, 0.35);
    cursor: pointer;
}
.mb-signal-bar:disabled { opacity: 0.5; }
`;

function DomainStyleTag() {
    return <style>{MEMORY_DOMAIN_STYLES}</style>;
}

const memorySettingsIconStyle = (color: string): CSSProperties => ({
    "--icon-color": color,
} as CSSProperties);

function MemorySettingsIcon({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <span className="card-icon" style={memorySettingsIconStyle(color)}>
            <Icon size={22} strokeWidth={1.75} />
        </span>
    );
}

const memoryBadgeRowStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    margin: "10px 0",
};

// Sub-row: status/importance/valence/arousal on the first line, wake stats on the
// second — keeps the wake-related badges visually grouped and separate.
const memoryBadgeSubRowStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "8px",
};

// All memory badges share the same gray look as the old "重要度" (action) tag.
// No radius override here — falls back to the shared .ui-status-tag base radius,
// same as the other small tags (群聊、线下 etc).
const memoryBadgeCapsuleStyle: CSSProperties = {};

// Active memories get a green capsule with darker green text; sleeping memories
// get a darker gray capsule (darker than the default badge gray) with white text.
function memoryStatusBadgeStyle(status: "active" | "sleeping" | "archived"): CSSProperties {
    if (status === "active") {
        return {
            ...memoryBadgeCapsuleStyle,
            background: "color-mix(in srgb, #22c55e 22%, transparent)",
            color: "#15803d",
            fontWeight: 600,
        };
    }
    if (status === "sleeping") {
        return {
            ...memoryBadgeCapsuleStyle,
            background: "#4b5563",
            color: "#ffffff",
        };
    }
    return memoryBadgeCapsuleStyle;
}

function MemorySettingsSliderItem({
    icon,
    color,
    label,
    desc,
    value,
    min,
    max,
    step,
    onChange,
}: {
    icon: LucideIcon;
    color: string;
    label: string;
    desc: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
}) {
    return (
        <div className="menu-item memory-slider-item">
            <div className="memory-slider-header">
                <MemorySettingsIcon icon={icon} color={color} />
                <div className="menu-label-group">
                    <span className="menu-label">{label}</span>
                    <span className="menu-desc">{desc}</span>
                </div>
                <span className="ui-slider-value memory-slider-current">{value}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                className="ui-slider memory-settings-slider"
                aria-label={label}
            />
        </div>
    );
}

function relativeTime(isoStr: string): string {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}天前`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}周前`;
    return `${Math.floor(days / 30)}个月前`;
}

type CharacterMemoryInfo = {
    character: Character;
    longTermCount: number;
    coreCount: number;
    shortTermCount: number;
};

type Props = {
    view: MemoryView;
    selectedCharId?: string;
    onSelectChar: (charId: string) => void;
    onNotice?: (msg: string) => void;
};

export function MemoryBankPage({ view, selectedCharId, onSelectChar, onNotice }: Props) {
    const [config, setConfig] = useState<MemoryConfig>(loadMemoryConfig);
    const [characters, setCharacters] = useState<CharacterMemoryInfo[]>([]);
    const [activeTab, setActiveTab] = useState<MemoryTab>("short");
    const [coreEntries, setCoreEntries] = useState<MemoryEntry[]>([]);
    const [longTermEntries, setLongTermEntries] = useState<MemoryEntry[]>([]);
    const [shortTermEvents, setShortTermEvents] = useState<NativeTimelineEntry[]>([]);
    const [sharedEvents, setSharedEvents] = useState<NativeTimelineEntry[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [summarizing, setSummarizing] = useState(false);
    const [rebuildingCore, setRebuildingCore] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
    const [editingCorePrompt, setEditingCorePrompt] = useState<string | null>(null);
    const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState<string | null>(null);
    const [confirmClearAll, setConfirmClearAll] = useState(false);
    const [confirmOrganizeType, setConfirmOrganizeType] = useState<"long_term" | "core" | null>(null);
    const [pickedCharId, setPickedCharId] = useState<string | null>(null);
    const [entryMenuId, setEntryMenuId] = useState<string | null>(null);
    const [memoryEditor, setMemoryEditor] = useState<MemoryEditorState | null>(null);
    const [savingMemory, setSavingMemory] = useState(false);
    const [signalEditor, setSignalEditor] = useState<SignalEditorState | null>(null);
    const [savingSignals, setSavingSignals] = useState(false);
    const [activeDomain, setActiveDomain] = useState<DomainFilterKey>("all");
    const [domainSheetOpen, setDomainSheetOpen] = useState(false);
    const [memorySearchQuery, setMemorySearchQuery] = useState("");
    const [organizeSheetOpen, setOrganizeSheetOpen] = useState(false);
    const [organizing, setOrganizing] = useState(false);
    // Persistent "整理中" indicator, separate from the transient onNotice toast
    // (which auto-dismisses after a few seconds regardless of whether the LLM
    // call has actually finished). This one is driven entirely by `organizing`
    // and stays visible for the whole duration of the pipeline run.
    const [organizeProgressVisible, setOrganizeProgressVisible] = useState(false);
    const [organizeSuggestions, setOrganizeSuggestions] = useState<MemoryOrganizeSuggestion[]>([]);
    const [organizeSkippedCount, setOrganizeSkippedCount] = useState(0);
    const [editingOrganizePrompt, setEditingOrganizePrompt] = useState<string | null>(null);
    const [organizeMergeEdits, setOrganizeMergeEdits] = useState<Record<string, string>>({});
    const [organizingApplyId, setOrganizingApplyId] = useState<string | null>(null);
    // Per-suggestion, per-entry keep/delete decision — used by the 重复/矛盾 cards,
    // which can involve 2+ entries. Confirmed all at once via the card's 确认 button.
    const [organizeEntryDecisions, setOrganizeEntryDecisions] = useState<Record<string, Record<string, "keep" | "delete">>>({});

    // Resolve selected character object from ID
    const selectedChar = selectedCharId
        ? loadCharacters().find(c => c.id === selectedCharId) ?? null
        : null;

    const loadCharacterList = useCallback(async () => {
        const allChars = loadCharacters();

        let charIdsWithMem: string[] = [];
        try { charIdsWithMem = await getAllCharacterIdsWithMemories(); } catch { /* DB may fail */ }

        const infos: CharacterMemoryInfo[] = [];
        const seen = new Set<string>();

        // Characters with memories first
        for (const id of charIdsWithMem) {
            const char = allChars.find(c => c.id === id);
            if (!char) continue;
            seen.add(id);
            let ltCount = 0;
            let coreCount = 0;
            try {
                [ltCount, coreCount] = await Promise.all([
                    getMemoryCountByType(id, "long_term"),
                    getMemoryCountByType(id, "core"),
                ]);
            } catch { /* ignore */ }
            const stCount = loadNativeTimeline(id).length;
            infos.push({ character: char, longTermCount: ltCount, coreCount, shortTermCount: stCount });
        }

        // Remaining characters
        for (const char of allChars) {
            if (seen.has(char.id)) continue;
            const stCount = loadNativeTimeline(char.id).length;
            infos.push({ character: char, longTermCount: 0, coreCount: 0, shortTermCount: stCount });
        }

        setCharacters(infos);
    }, []);

    useEffect(() => {
        loadCharacterList();
    }, [loadCharacterList]);

    // Load detail data when entering detail view
    const loadDetailData = useCallback(async (charId: string) => {
        setLoading(true);
        try {
            await hydrateChatStorage();
            const [core, lt] = await Promise.all([
                loadMemoryEntriesByType(charId, "core"),
                loadMemoryEntriesByType(charId, "long_term"),
            ]);
            setCoreEntries(core);
            setLongTermEntries(lt);
        } catch {
            setCoreEntries([]);
            setLongTermEntries([]);
        }
        // Native timeline is sync (localStorage) — no await needed
        const timeline = loadNativeTimeline(charId);
        setShortTermEvents(timeline.filter(e =>
            !(e.sourceApp === "moments" && e.postAuthorType === "user")
            && !(e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setSharedEvents(timeline.filter(e =>
            (e.sourceApp === "moments" && e.postAuthorType === "user") ||
            (e.sourceApp === "chat" && e.sourceDetail === "group") ||
            (e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setLoading(false);
    }, []);

    // Tracks the last character whose detail view we reset state for — used so
    // that returning to "detail" from "settings" (same character) doesn't force
    // the tab back to "short" and doesn't cause a flash of stale state.
    const lastResetCharIdRef = useRef<string | null>(null);

    // Reload detail data when view changes to detail
    useEffect(() => {
        if (view === "detail" && selectedCharId) {
            if (lastResetCharIdRef.current !== selectedCharId) {
                lastResetCharIdRef.current = selectedCharId;
                setActiveTab("short");
                setExpandedId(null);
                setActiveDomain("all");
                setMemorySearchQuery("");
                setDomainSheetOpen(false);
                loadDetailData(selectedCharId);
            }
            // If the character hasn't changed (e.g. returning from the settings
            // view), reuse the already-loaded data instead of re-fetching —
            // this avoids the loading flash caused by setLoading(true/false).
        }
    }, [view, selectedCharId, loadDetailData]);

    // Domain filter / search only apply to the core/long tabs — reset when switching tabs
    useEffect(() => {
        setActiveDomain("all");
        setMemorySearchQuery("");
        setDomainSheetOpen(false);
    }, [activeTab]);

    // Reset editing prompt when leaving settings
    useEffect(() => {
        if (view !== "settings") {
            setEditingPrompt(null);
            setEditingCorePrompt(null);
            setEditingOrganizePrompt(null);
        }
    }, [view]);

    const handleSelectChar = (char: Character) => {
        onSelectChar(char.id);
    };

    const handleDeleteEntry = async (id: string) => {
        await deleteMemoryEntry(id);
        setCoreEntries(prev => prev.filter(e => e.id !== id));
        setLongTermEntries(prev => prev.filter(e => e.id !== id));
        setEntryMenuId(null);
        loadCharacterList();
    };

    const handleClearEntries = async (type: "core" | "long_term") => {
        if (!selectedCharId) return;
        await deleteCharacterMemoriesByType(selectedCharId, type);
        if (type === "core") setCoreEntries([]);
        else setLongTermEntries([]);
        loadCharacterList();
    };

    const showNotice = (msg: string) => {
        onNotice?.(msg);
    };

    const handleManualSummarize = async () => {
        if (!selectedCharId || summarizing) return;
        setSummarizing(true);
        try {
            const lastSummarizedAt = getLastSummarizedTimestamp(selectedCharId);
            const timelineCount = loadNativeTimeline(
                selectedCharId,
                lastSummarizedAt ? { afterTimestamp: lastSummarizedAt } : undefined,
            ).length;
            if (timelineCount < 4) {
                showNotice(lastSummarizedAt ? "新事件太少，至少需要 4 条记录" : "数据太少，至少需要 4 条记录");
                return;
            }

            const result = await runSummarizationPipeline(selectedCharId, selectedChar?.name ?? "");
            if (result.success) {
                showNotice("总结完成");
                loadDetailData(selectedCharId);
                loadCharacterList();
            } else {
                showNotice(result.error || "总结失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Manual summarize failed:", err);
            showNotice("总结失败: " + String(err));
        } finally {
            setSummarizing(false);
        }
    };

    const handleManualRebuildCore = async () => {
        if (!selectedCharId || rebuildingCore) return;
        setRebuildingCore(true);
        try {
            const lastCoreSummarizedAt = getLastCoreSummarizedTimestamp(selectedCharId);
            const longTermEntries = await loadMemoryEntriesByType(selectedCharId, "long_term");
            const pendingLongTermCount = longTermEntries.filter(entry =>
                !lastCoreSummarizedAt || entry.createdAt > lastCoreSummarizedAt
            ).length;
            if (pendingLongTermCount === 0) {
                showNotice(lastCoreSummarizedAt ? "没有新的长期记忆需要总结" : "没有可用于总结核心记忆的长期记忆");
                return;
            }

            const result = await runCoreMemoryPipeline(selectedCharId, selectedChar?.name ?? "");
            if (result.success) {
                showNotice(result.rebuiltCount ? `核心记忆已重建（${result.rebuiltCount}条）` : "核心记忆已重建");
                loadDetailData(selectedCharId);
                loadCharacterList();
            } else {
                showNotice(result.error || "核心记忆重建失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Manual core rebuild failed:", err);
            showNotice("核心记忆重建失败: " + String(err));
        } finally {
            setRebuildingCore(false);
        }
    };

    const requestRunOrganize = (type: "long_term" | "core") => {
        if (!selectedCharId || organizing) return;
        setConfirmOrganizeType(type);
    };

    const handleRunOrganize = async (type: "long_term" | "core") => {
        if (!selectedCharId || organizing) return;
        setOrganizing(true);
        setOrganizeProgressVisible(true);
        try {
            const result = await runMemoryOrganizePipeline(selectedCharId, selectedChar?.name ?? "", type);
            if (result.success) {
                setOrganizeSuggestions(result.suggestions);
                setOrganizeSkippedCount(result.skippedCount);
                setOrganizeMergeEdits(
                    result.suggestions.reduce<Record<string, string>>((acc, s) => {
                        if (s.type === "合并" && s.mergedContent) acc[s.id] = s.mergedContent;
                        return acc;
                    }, {}),
                );
                // Default every entry in a 重复/矛盾 suggestion to "keep" until the
                // user explicitly marks it for deletion.
                setOrganizeEntryDecisions(
                    result.suggestions.reduce<Record<string, Record<string, "keep" | "delete">>>((acc, s) => {
                        if (s.type === "重复" || s.type === "矛盾") {
                            acc[s.id] = s.entryIds.reduce<Record<string, "keep" | "delete">>((entryAcc, id) => {
                                entryAcc[id] = "keep";
                                return entryAcc;
                            }, {});
                        }
                        return acc;
                    }, {}),
                );
                setOrganizeSheetOpen(true);
                if (result.suggestions.length === 0) {
                    showNotice("未发现需要整理的记忆");
                } else {
                    showNotice("整理完毕");
                }
            } else {
                showNotice(result.error || "整理失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Organize pipeline failed:", err);
            showNotice("整理失败: " + String(err));
        } finally {
            setOrganizing(false);
            setOrganizeProgressVisible(false);
        }
    };

    const dismissOrganizeSuggestion = (id: string) => {
        setOrganizeSuggestions(prev => prev.filter(s => s.id !== id));
        setOrganizeEntryDecisions(prev => {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
        });
    };

    const setOrganizeEntryDecision = (suggestionId: string, entryId: string, decision: "keep" | "delete") => {
        setOrganizeEntryDecisions(prev => ({
            ...prev,
            [suggestionId]: { ...prev[suggestionId], [entryId]: decision },
        }));
    };

    /** Handles both "重复" and "矛盾": delete every entry marked "delete" for this
     *  suggestion, then dismiss the card. If nothing is marked for deletion, this
     *  behaves as "忽略" (keep everything, just dismiss). */
    const handleOrganizeResolve = async (suggestion: MemoryOrganizeSuggestion) => {
        if (organizingApplyId) return;
        const decisions = organizeEntryDecisions[suggestion.id] ?? {};
        const deleteIds = suggestion.entryIds.filter(id => decisions[id] === "delete");
        if (deleteIds.length === 0) {
            dismissOrganizeSuggestion(suggestion.id);
            return;
        }
        if (deleteIds.length >= suggestion.entryIds.length) {
            showNotice("至少需要保留一条");
            return;
        }
        setOrganizingApplyId(suggestion.id);
        try {
            if (suggestion.type === "矛盾") {
                await applyOrganizeConflictResolve(deleteIds);
            } else {
                await applyOrganizeDuplicate(deleteIds);
            }
            setCoreEntries(prev => prev.filter(e => !deleteIds.includes(e.id)));
            setLongTermEntries(prev => prev.filter(e => !deleteIds.includes(e.id)));
            dismissOrganizeSuggestion(suggestion.id);
            if (selectedCharId) loadCharacterList();
            showNotice(suggestion.type === "矛盾" ? "已处理矛盾条目" : "已删除重复条目");
        } catch (err) {
            console.error("[MemoryBank] Apply organize resolution failed:", err);
            showNotice("操作失败: " + String(err));
        } finally {
            setOrganizingApplyId(null);
        }
    };

    const handleOrganizeMerge = async (suggestion: MemoryOrganizeSuggestion) => {
        if (!selectedCharId || organizingApplyId) return;
        const mergedContent = (organizeMergeEdits[suggestion.id] ?? suggestion.mergedContent ?? "").trim();
        if (!mergedContent) {
            showNotice("合并内容不能为空");
            return;
        }
        setOrganizingApplyId(suggestion.id);
        try {
            await applyOrganizeMerge(selectedCharId, { ...suggestion, mergedContent });
            setCoreEntries(prev => prev.filter(e => !suggestion.entryIds.includes(e.id)));
            setLongTermEntries(prev => prev.filter(e => !suggestion.entryIds.includes(e.id)));
            dismissOrganizeSuggestion(suggestion.id);
            // Awaited (not fire-and-forget) so the authoritative post-merge state
            // from IndexedDB always lands after the optimistic filter above, never
            // racing with it and getting overwritten by a slower, earlier-in-flight
            // load of the pre-merge data.
            await loadDetailData(selectedCharId);
            loadCharacterList();
            showNotice("已采纳合并");
        } catch (err) {
            console.error("[MemoryBank] Apply merge suggestion failed:", err);
            showNotice("操作失败: " + String(err));
        } finally {
            setOrganizingApplyId(null);
        }
    };

    const saveBudget = (key: MemoryBudgetKey, value: number) => {
        if (!Number.isFinite(value)) return;
        const min = MEMORY_TOKEN_BUDGET_MIN[key];
        const nextValue = Math.min(MEMORY_TOKEN_BUDGET_MAX, Math.max(min, Math.round(value)));
        const next = { ...config, [key]: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveInterval = (value: number) => {
        if (!Number.isFinite(value)) return;
        const nextValue = Math.min(200, Math.max(10, Math.round(value)));
        const next = { ...config, summarizationEventInterval: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveCoreInterval = (value: number) => {
        if (!Number.isFinite(value)) return;
        const nextValue = Math.min(20, Math.max(1, Math.round(value)));
        const next = { ...config, coreSummarizationInterval: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    // ── Prompt editing ──
    const handleSavePrompt = () => {
        if (editingPrompt === null) return;
        const next = { ...config, summarizationPrompt: editingPrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("提示词已保存");
    };

    const handleResetPrompt = () => {
        setEditingPrompt(DEFAULT_SUMMARIZATION_PROMPT);
        const next = { ...config, summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("已恢复默认提示词");
    };

    const handleSaveCorePrompt = () => {
        if (editingCorePrompt === null) return;
        const next = { ...config, coreMemoryPrompt: editingCorePrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("核心记忆提示词已保存");
    };

    const handleResetCorePrompt = () => {
        setEditingCorePrompt(DEFAULT_CORE_MEMORY_PROMPT);
        const next = { ...config, coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("核心记忆提示词已恢复默认");
    };

    const handleSaveOrganizePrompt = () => {
        if (editingOrganizePrompt === null) return;
        const next = { ...config, organizePrompt: editingOrganizePrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("记忆整理提示词已保存");
    };

    const handleResetOrganizePrompt = () => {
        setEditingOrganizePrompt(DEFAULT_ORGANIZE_PROMPT);
        const next = { ...config, organizePrompt: DEFAULT_ORGANIZE_PROMPT };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("记忆整理提示词已恢复默认");
    };

    const createManualMemoryId = (type: MemoryEntry["type"]) => (
        `mem_${type === "core" ? "core" : "lt"}_manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );

    const isManualMemoryEntry = (entry: MemoryEntry) => {
        const origin = String(entry.metadata?.origin ?? "");
        return origin === "user_manual" || origin === "user_edited" || entry.id.includes("_manual_");
    };

    const normalizeMemoryStatus = (entry: MemoryEntry) => {
        const status = entry.metadata?.status;
        return status === "sleeping" || status === "archived" ? status : "active";
    };

    const formatMemoryBadge = (entry: MemoryEntry) => {
        const status = normalizeMemoryStatus(entry);
        const importance = Number.isFinite(entry.importance) ? entry.importance : 0;
        const valence = Number.isFinite(entry.metadata?.valence ?? NaN) ? entry.metadata!.valence!.toFixed(1) : "N/A";
        const arousal = Number.isFinite(entry.metadata?.arousal ?? NaN) ? entry.metadata!.arousal!.toFixed(1) : "N/A";
        const readCount = Number(entry.metadata?.readCount ?? 0);
        const lastReadAt = entry.metadata?.lastReadAt ? relativeTime(entry.metadata.lastReadAt) : "未唤醒";

        return {
            status,
            importance,
            valence,
            arousal,
            readCount,
            lastReadAt,
        };
    };

    const openSignalEditor = (entry: MemoryEntry) => {
        setEntryMenuId(null);
        setSignalEditor({
            entry,
            importance: Number.isFinite(entry.importance) ? entry.importance : 5,
            valence: Number.isFinite(entry.metadata?.valence ?? NaN) ? entry.metadata!.valence! : 0,
            arousal: Number.isFinite(entry.metadata?.arousal ?? NaN) ? entry.metadata!.arousal! : 0,
        });
    };

    // Black-filled / grey-track look for the signal sliders. Uses a CSS custom
    // property (--fill) rather than an inline background, since some mobile
    // WebViews ignore a plain `background` set directly on <input type="range">
    // but do respect it inside ::-webkit-slider-runnable-track, which can read
    // an inherited custom property.
    const signalBarStyle = (value: number, min: number, max: number): CSSProperties => {
        const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
        return { "--fill": `${pct}%` } as CSSProperties;
    };

    const handleSaveSignalEditor = async () => {
        if (!signalEditor || savingSignals) return;
        setSavingSignals(true);
        try {
            const source = signalEditor.entry;
            const now = new Date().toISOString();
            const importance = Math.max(1, Math.min(10, Math.round(signalEditor.importance)));
            const valence = Math.max(-1, Math.min(1, signalEditor.valence));
            const arousal = Math.max(0, Math.min(1, signalEditor.arousal));
            const entry: MemoryEntry = {
                ...source,
                importance,
                updatedAt: now,
                metadata: {
                    ...(source.metadata ?? {}),
                    valence,
                    arousal,
                    editedByUser: true,
                },
            };
            await saveMemoryEntry(entry);
            if (entry.type === "core") {
                setCoreEntries(prev => prev.map(item => item.id === entry.id ? entry : item));
            } else {
                setLongTermEntries(prev => prev.map(item => item.id === entry.id ? entry : item));
            }
            setSignalEditor(null);
            showNotice("数值已更新");
        } catch (error) {
            console.error("[MemoryBank] Save signal edit failed:", error);
            showNotice("保存失败: " + String(error));
        } finally {
            setSavingSignals(false);
        }
    };

    const maybeBuildManualMemoryEmbedding = async (type: MemoryEntry["type"], content: string): Promise<number[] | undefined> => {
        if (type !== "long_term" || !config.vectorRecallEnabled) return undefined;
        const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
        if (!embeddingApiConfig || !resolveEmbeddingModel(embeddingApiConfig)) return undefined;
        try {
            return await generateEmbedding(content, embeddingApiConfig) ?? undefined;
        } catch {
            return undefined;
        }
    };

    const openCreateMemoryEditor = (type: MemoryEntry["type"]) => {
        setEntryMenuId(null);
        const defaultDomain: MemoryDomain | "unclassified" =
            activeDomain === "all" ? "unclassified" : activeDomain;
        setMemoryEditor({ type, content: "", domain: defaultDomain });
    };

    const openEditMemoryEditor = (entry: MemoryEntry) => {
        setEntryMenuId(null);
        const entryDomain = getEntryDomain(entry);
        setMemoryEditor({
            type: entry.type,
            entry,
            content: entry.content,
            domain: entryDomain === "all" ? "unclassified" : entryDomain,
        });
    };

    const handleSaveManualMemory = async () => {
        if (!selectedCharId || !memoryEditor || savingMemory) return;
        const content = memoryEditor.content.trim();
        if (!content) {
            showNotice("记忆内容不能为空");
            return;
        }
        if (content.length > MANUAL_MEMORY_CONTENT_LIMIT) {
            showNotice(`记忆内容过长，请控制在 ${MANUAL_MEMORY_CONTENT_LIMIT} 字以内`);
            return;
        }

        setSavingMemory(true);
        try {
            const now = new Date().toISOString();
            const type = memoryEditor.type;
            const source = memoryEditor.entry;
            const contentChanged = !source || source.content.trim() !== content;
            const embedding = type === "long_term"
                ? (contentChanged ? await maybeBuildManualMemoryEmbedding(type, content) : source?.embedding)
                : undefined;
            const signals = !source
                ? await estimateMemoryEmotion(
                    content,
                    resolveAuxiliaryApiConfig("memorySummaryApiConfigId"),
                    type === "core" ? { minImportance: 7, fallbackImportance: 9 } : { fallbackImportance: 8 },
                )
                : null;
            const domainToSave = memoryEditor.domain === "unclassified" ? undefined : memoryEditor.domain;
            const entry: MemoryEntry = source
                ? {
                    ...source,
                    content,
                    embedding,
                    updatedAt: now,
                    metadata: {
                        ...(source.metadata ?? {}),
                        origin: isManualMemoryEntry(source) ? "user_manual" : "user_edited",
                        editedByUser: true,
                        domain: domainToSave,
                        domainConfidence: undefined,
                    },
                }
                : {
                    id: createManualMemoryId(type),
                    characterId: selectedCharId,
                    sourceApp: "chat",
                    type,
                    content,
                    embedding,
                    importance: signals?.importance ?? (type === "core" ? 9 : 8),
                    createdAt: now,
                    updatedAt: now,
                    metadata: {
                        origin: "user_manual",
                        status: "active",
                        lastReadAt: now,
                        readCount: 0,
                        valence: signals?.valence ?? 0,
                        arousal: signals?.arousal ?? 0,
                        domain: domainToSave,
                    },
                };

            await saveMemoryEntry(entry);
            if (type === "core") {
                setCoreEntries(prev => source ? prev.map(item => item.id === entry.id ? entry : item) : [...prev, entry]);
            } else {
                setLongTermEntries(prev => source ? prev.map(item => item.id === entry.id ? entry : item) : [...prev, entry]);
            }
            setMemoryEditor(null);
            setExpandedId(entry.id);
            loadCharacterList();
            showNotice(type === "core" ? "核心记忆已保存" : "长期记忆已保存");
        } catch (error) {
            console.error("[MemoryBank] Save manual memory failed:", error);
            showNotice("记忆保存失败: " + String(error));
        } finally {
            setSavingMemory(false);
        }
    };

    const renderMemoryEntries = (type: MemoryEntry["type"], allEntries: MemoryEntry[], emptyText: string) => {
        const label = type === "core" ? "核心记忆" : "长期记忆";

        // Domain counts are computed over the full, unfiltered list for this tab
        const domainCounts = new Map<DomainFilterKey, number>();
        for (const entry of allEntries) {
            const d = getEntryDomain(entry);
            domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
        }
        const chipKeys: DomainFilterKey[] = ["all", ...MEMORY_DOMAIN_ORDER, "unclassified"];

        const query = memorySearchQuery.trim().toLowerCase();
        const entries = allEntries.filter(entry => {
            if (activeDomain !== "all" && getEntryDomain(entry) !== activeDomain) return false;
            if (query && !entry.content.toLowerCase().includes(query)) return false;
            return true;
        });

        const currentTitle = domainMeta(activeDomain).label;

        return (
            <>
                {allEntries.length > 0 && (
                    <>
                        <div className="mb-sticky-header">
                            <div className="mb-search">
                                <Search size={20} color="#B0B0B0" />
                                <input
                                    type="text"
                                    placeholder="搜索记忆..."
                                    value={memorySearchQuery}
                                    onChange={e => setMemorySearchQuery(e.target.value)}
                                />
                            </div>

                            <div className="mb-chips-wrapper">
                                {chipKeys.map(key => {
                                    const meta = domainMeta(key);
                                    const Icon = meta.icon;
                                    const isActive = activeDomain === key;
                                    const count = key === "all" ? allEntries.length : (domainCounts.get(key) ?? 0);
                                    return (
                                        <button
                                            key={key}
                                            className="mb-chip"
                                            style={isActive ? { background: meta.color, color: "#ffffff" } : undefined}
                                            onClick={() => setActiveDomain(key)}
                                        >
                                            <Icon width={20} height={20} strokeWidth={2.5} color={isActive ? "#ffffff" : meta.color} />
                                            <div className="mb-chip-bottom">
                                                <span className="mb-chip-title">{meta.label}</span>
                                                <span className="mb-chip-count">{count} 条</span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="mb-section-header">
                                <div className="mb-section-title">{currentTitle}</div>
                                <div className="mb-section-actions">
                                    <button
                                        className="mb-section-action"
                                        onClick={() => openCreateMemoryEditor(type)}
                                        title={`新增${label}`}
                                    >
                                        <Plus width={18} height={18} strokeWidth={2} />
                                    </button>
                                    {(activeTab === "long" || activeTab === "core") && (
                                        <button
                                            className="mb-section-action"
                                            onClick={() => requestRunOrganize(type)}
                                            disabled={organizing}
                                            title={`整理${label}`}
                                        >
                                            <ListChecks width={18} height={18} strokeWidth={2} />
                                        </button>
                                    )}
                                    <button
                                        className="mb-section-action is-danger"
                                        onClick={() => setConfirmClearAll(true)}
                                        title={`清除${label}`}
                                    >
                                        <Trash2 width={18} height={18} strokeWidth={2} />
                                    </button>
                                    <button className="mb-section-action" onClick={() => setDomainSheetOpen(true)} title="切换记忆维度">
                                        <LayoutGrid width={18} height={18} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    </>
                )}

                {entryMenuId && (
                    <button
                        className="mem-entry-menu-backdrop"
                        aria-label="关闭菜单"
                        onClick={() => setEntryMenuId(null)}
                    />
                )}

                {allEntries.length === 0 ? (
                    <div className="mem-empty-card">
                        <p>{emptyText}</p>
                        <button className="mem-empty-add-btn" onClick={() => openCreateMemoryEditor(type)}>
                            <Plus size={14} />
                            <span>新增{label}</span>
                        </button>
                    </div>
                ) : entries.length === 0 ? (
                    <div className="mem-empty-card">
                        <p>{query ? "没有匹配的记忆内容" : `此分类下暂无${label}`}</p>
                    </div>
                ) : (
                    <div className="mb-feed-list">
                        {entries.map(entry => {
                            const domainKey = getEntryDomain(entry);
                            const meta = domainMeta(domainKey);
                            const Icon = meta.icon;
                            const badge = formatMemoryBadge(entry);
                            return (
                                <div key={entry.id} className="mb-feed-item">
                                    <div className="mb-feed-icon-wrap">
                                        <Icon width={20} height={20} strokeWidth={2.5} color={meta.color} />
                                    </div>
                                    <div
                                        className="mb-feed-content-wrap"
                                        onClick={() => {
                                            if (entryMenuId) {
                                                setEntryMenuId(null);
                                                return;
                                            }
                                            setExpandedId(expandedId === entry.id ? null : entry.id);
                                        }}
                                    >
                                        <div className="mb-feed-text">
                                            {expandedId === entry.id
                                                ? entry.content
                                                : entry.content.length > 100
                                                    ? entry.content.slice(0, 100) + "..."
                                                    : entry.content
                                            }
                                        </div>
                                        <div className="mb-feed-meta-rows">
                                            <div className="mb-feed-meta-row">
                                                <span className={`mb-meta-tag status-${badge.status}`}>
                                                    {badge.status === "active" ? "活跃" : badge.status === "sleeping" ? "沉睡" : "归档"}
                                                </span>
                                                <span className={`mb-meta-tag mb-origin-tag${isManualMemoryEntry(entry) ? " is-manual" : ""}`}>
                                                    {isManualMemoryEntry(entry) ? "MANUAL" : "AUTO"}
                                                </span>
                                                <span className="mb-meta-tag">重要度: {badge.importance}</span>
                                                <span className="mb-meta-tag">情绪正负: {badge.valence}</span>
                                                <span className="mb-meta-tag">情绪强度: {badge.arousal}</span>
                                            </div>
                                            <div className="mb-feed-meta-row">
                                                <span className="mb-meta-tag">唤醒次数: {badge.readCount}次</span>
                                                <span className="mb-meta-tag">上次唤醒: {badge.lastReadAt}</span>
                                                <span className="mb-meta-tag">[ {relativeTime(entry.createdAt)} ]</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="mb-feed-menu-wrap mem-entry-menu-wrap">
                                        <button
                                            className="mb-feed-menu-btn mem-entry-menu-btn"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                setEntryMenuId(prev => prev === entry.id ? null : entry.id);
                                            }}
                                            title="更多"
                                        >
                                            <MoreHorizontal size={18} />
                                        </button>
                                        {entryMenuId === entry.id && (
                                            <div className="mem-entry-menu" onClick={event => event.stopPropagation()}>
                                                <button onClick={() => openEditMemoryEditor(entry)}>
                                                    <Edit3 size={13} />
                                                    <span>编辑</span>
                                                </button>
                                                <button onClick={() => openSignalEditor(entry)}>
                                                    <Gauge size={13} />
                                                    <span>重判</span>
                                                </button>
                                                <button
                                                    className="is-danger"
                                                    onClick={() => {
                                                        setEntryMenuId(null);
                                                        setConfirmDeleteEntryId(entry.id);
                                                    }}
                                                >
                                                    <Trash2 size={13} />
                                                    <span>删除</span>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Bottom sheet — quick domain switch, mirrors the html reference */}
                {allEntries.length > 0 && (
                    <div className={`mb-sheet-overlay${domainSheetOpen ? " show" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) setDomainSheetOpen(false); }}>
                        <div className="mb-sheet-content">
                            <div className="mb-sheet-header">
                                <span className="mb-sheet-title">切换记忆维度</span>
                                <button className="mb-sheet-close" onClick={() => setDomainSheetOpen(false)}>
                                    <X width={16} height={16} />
                                </button>
                            </div>
                            <div className="mb-sheet-grid">
                                {chipKeys.map(key => {
                                    const meta = domainMeta(key);
                                    const Icon = meta.icon;
                                    const isActive = activeDomain === key;
                                    return (
                                        <button
                                            key={key}
                                            className="mb-sheet-item"
                                            style={isActive ? { background: meta.color, color: "#ffffff" } : undefined}
                                            onClick={() => {
                                                setActiveDomain(key);
                                                setDomainSheetOpen(false);
                                            }}
                                        >
                                            <Icon width={20} height={20} strokeWidth={2.5} color={isActive ? "#ffffff" : meta.color} />
                                            {meta.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </>
        );
    };

    // Organize (整理) suggestions sheet — shared between the Detail view (bottom
    // sheet triggered from the section header) and the Settings view (triggered
    // from the manual-operations list), so the popup actually shows regardless
    // of which screen kicked off handleRunOrganize.
    const renderOrganizeSheet = () => (
        <div className={`mb-sheet-overlay${organizeSheetOpen ? " show" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) setOrganizeSheetOpen(false); }}>
            <div className="mb-sheet-content mb-organize-sheet">
                <div className="mb-sheet-header">
                    <span className="mb-sheet-title">记忆整理建议</span>
                    <button className="mb-sheet-close" onClick={() => setOrganizeSheetOpen(false)}>
                        <X width={16} height={16} />
                    </button>
                </div>
                {organizeSkippedCount > 0 && (
                    <p className="mb-organize-skip-hint">
                        {organizeSkippedCount} 条因缺少向量未参与本次整理
                    </p>
                )}
                {organizeSuggestions.length === 0 ? (
                    <p className="mb-organize-empty">暂无整理建议</p>
                ) : (
                    <div className="mb-organize-list">
                        {organizeSuggestions.map(suggestion => {
                            const allKnownEntries = [...coreEntries, ...longTermEntries];
                            const applying = organizingApplyId === suggestion.id;
                            const decisions = organizeEntryDecisions[suggestion.id] ?? {};
                            const deleteCount = suggestion.entryIds.filter(id => decisions[id] === "delete").length;
                            const allMarkedForDeletion = deleteCount > 0 && deleteCount >= suggestion.entryIds.length;
                            return (
                                <div key={suggestion.id} className="mb-organize-card">
                                    <div className="mb-organize-card-reason">{suggestion.reason}</div>

                                    {(suggestion.type === "重复" || suggestion.type === "矛盾") && (
                                        <>
                                            {suggestion.entryIds.map((entryId, idx) => {
                                                const entry = allKnownEntries.find(e => e.id === entryId);
                                                const decision = decisions[entryId] ?? "keep";
                                                return (
                                                    <div key={entryId} className="mb-organize-entry-row">
                                                        <div className="mb-organize-entry">
                                                            {String.fromCharCode(65 + idx)}：{entry?.content ?? "（条目已不存在）"}
                                                        </div>
                                                        <div className="mb-organize-entry-toggle">
                                                            <button
                                                                type="button"
                                                                className={`ui-btn ui-btn-outline mb-organize-toggle-btn${decision === "keep" ? " is-active is-keep" : ""}`}
                                                                disabled={applying || !entry}
                                                                title="保留"
                                                                onClick={() => setOrganizeEntryDecision(suggestion.id, entryId, "keep")}
                                                            >
                                                                <Check width={14} height={14} strokeWidth={2.5} />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className={`ui-btn ui-btn-outline mb-organize-toggle-btn${decision === "delete" ? " is-active is-delete" : ""}`}
                                                                disabled={applying || !entry}
                                                                title="删除"
                                                                onClick={() => setOrganizeEntryDecision(suggestion.id, entryId, "delete")}
                                                            >
                                                                <Trash2 width={14} height={14} strokeWidth={2.5} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                            {allMarkedForDeletion && (
                                                <p className="mb-organize-warn-hint">至少需要保留一条，请重新选择</p>
                                            )}
                                            <div className="mb-organize-actions">
                                                <button
                                                    className="ui-btn ui-btn-outline"
                                                    disabled={applying}
                                                    onClick={() => dismissOrganizeSuggestion(suggestion.id)}
                                                >
                                                    忽略
                                                </button>
                                                <button
                                                    className="ui-btn ui-btn-primary"
                                                    disabled={applying || allMarkedForDeletion}
                                                    onClick={() => handleOrganizeResolve(suggestion)}
                                                >
                                                    确认
                                                </button>
                                            </div>
                                        </>
                                    )}

                                    {suggestion.type === "合并" && (
                                        <>
                                            <textarea
                                                className="ui-textarea mb-organize-merge-textarea"
                                                value={organizeMergeEdits[suggestion.id] ?? suggestion.mergedContent ?? ""}
                                                disabled={applying}
                                                onChange={e => setOrganizeMergeEdits(prev => ({ ...prev, [suggestion.id]: e.target.value }))}
                                            />
                                            <div className="mb-organize-actions">
                                                <button
                                                    className="ui-btn ui-btn-primary"
                                                    disabled={applying}
                                                    onClick={() => handleOrganizeMerge(suggestion)}
                                                >
                                                    采纳合并
                                                </button>
                                                <button
                                                    className="ui-btn ui-btn-outline"
                                                    disabled={applying}
                                                    onClick={() => dismissOrganizeSuggestion(suggestion.id)}
                                                >
                                                    都保留
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );


    // ── Detail View ──
    if (view === "detail" && selectedChar) {
        return (
            <div className="flex flex-col relative h-full" style={{ padding: "0 16px", background: "#ffffff" }}>
                <DomainStyleTag />
                {organizeProgressVisible && (
                    <div className="mb-organize-progress-toast">
                        <span className="mb-organize-progress-spinner" />
                        <span>正在整理...</span>
                    </div>
                )}
                {/* Content lives in its own scrollable box, bounded by the h-full
                    parent above — this is what makes the feed scrollable at all,
                    since the app shell around this page does not scroll itself.
                    .mb-sticky-header uses position:sticky so it stays pinned while
                    this box scrolls, and there's no max-height/height cap here so
                    the feed can grow to any length within that scrollbox. The
                    bottom tab bar is position:fixed so it stays visible and never
                    gets covered by page content. */}
                <div
                    className="memory-detail-scroll flex flex-col gap-2"
                    style={{
                        paddingBottom: 110,
                        background: "#ffffff",
                        flex: 1,
                        minHeight: 0,
                        overflowY: "auto",
                        overflowX: "hidden",
                        touchAction: "pan-y",
                        width: "100%",
                        maxWidth: "100%",
                        WebkitOverflowScrolling: "touch",
                    }}
                >
                    {loading ? (
                        <p className="text-center ts-14 mt-10 text-secondary">
                            加载中...
                        </p>
                    ) : activeTab === "short" ? (
                        /* ── Short-term: card view ── */
                        <>
                            <MemoryTimeline
                                events={shortTermEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                            />
                        </>
                    ) : activeTab === "shared" ? (
                        /* ── Shared events: card view ── */
                        sharedEvents.length === 0 ? (
                            <p className="text-center ts-14 mt-10 text-secondary">
                                暂无共享事件。用户发朋友圈或参与群聊后会自动显示。
                            </p>
                        ) : (
                            <MemoryTimeline
                                events={sharedEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                            />
                        )
                    ) : activeTab === "core" ? (
                        renderMemoryEntries("core", coreEntries, "暂无核心记忆。长期记忆累计到设定条数后会自动提炼，也可以手动新增。")
                    ) : (
                        /* ── Long-term: Summarized Memories ── */
                        renderMemoryEntries("long_term", longTermEntries, "暂无长期记忆。点击设置页的手动总结，或直接新增一条记忆。")
                    )}
                </div>

                {/* Bottom tab bar — floating above bottom, colorless frosted glass.
                    position:fixed (not absolute) so it stays pinned to the viewport
                    and is never covered/scrolled away as the memory feed above grows
                    and the page scrolls naturally. */}
                <div className="mb-bottombar-glass" style={{ display: "flex", justifyContent: "space-around", alignItems: "center", position: "fixed", bottom: 40, left: 40, right: 40, zIndex: 10, borderRadius: 28, borderTop: "none", padding: "10px 0" }}>
                    {([
                        { key: "short" as const, icon: Clock, label: "短期" },
                        { key: "shared" as const, icon: Users, label: "共享事件" },
                        { key: "long" as const, icon: Archive, label: "长期" },
                        { key: "core" as const, icon: Archive, label: "核心" },
                    ]).map(tab => (
                        <button
                            key={tab.key}
                            className={`chat-tab${activeTab === tab.key ? " chat-tab-active" : ""}`}
                            onClick={() => {
                                setActiveTab(tab.key);
                                setEntryMenuId(null);
                            }}
                        >
                            <tab.icon size={18} />
                            <span>{tab.label}</span>
                        </button>
                    ))}
                </div>

                {/* Manual memory editor */}
                {memoryEditor && (() => {
                    const isCore = memoryEditor.type === "core";
                    const isEdit = Boolean(memoryEditor.entry);
                    const title = `${isEdit ? "编辑" : "新增"}${isCore ? "核心记忆" : "长期记忆"}`;
                    const contentLength = memoryEditor.content.trim().length;
                    const overLimit = contentLength > MANUAL_MEMORY_CONTENT_LIMIT;
                    return (
                        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => savingMemory ? undefined : setMemoryEditor(null)}>
                            <div className="modal-sheet mem-edit-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                <div className="modal-header" data-ui="modal-header">
                                    <button
                                        className="modal-header-btn modal-header-btn-muted"
                                        onClick={() => setMemoryEditor(null)}
                                        disabled={savingMemory}
                                    >
                                        <X size={18} />
                                    </button>
                                    <h3 className="modal-title">{title}</h3>
                                    <button
                                        className="modal-header-btn modal-header-btn-action"
                                        onClick={handleSaveManualMemory}
                                        disabled={savingMemory || !contentLength || overLimit}
                                    >
                                        <Check size={18} />
                                    </button>
                                </div>
                                <div className="modal-body mem-edit-body" data-ui="modal-body">
                                    <textarea
                                        className="ui-textarea mem-edit-textarea"
                                        value={memoryEditor.content}
                                        disabled={savingMemory}
                                        onChange={event => setMemoryEditor(prev => prev ? { ...prev, content: event.target.value } : prev)}
                                    />
                                    <div className={`mem-edit-footer ${overLimit ? "is-over-limit" : ""}`}>
                                        <span>{isCore ? "CORE" : "LONG TERM"}</span>
                                        <span>{contentLength}/{MANUAL_MEMORY_CONTENT_LIMIT}</span>
                                    </div>
                                    <p className="menu-group-desc" style={{ margin: "2px 0 0" }}>归属记忆域</p>
                                    <div className="mb-domain-picker">
                                        {(["unclassified", ...MEMORY_DOMAIN_ORDER] as (MemoryDomain | "unclassified")[]).map(key => {
                                            const meta = domainMeta(key);
                                            const Icon = meta.icon;
                                            const isActive = memoryEditor.domain === key;
                                            return (
                                                <button
                                                    key={key}
                                                    type="button"
                                                    className="mb-domain-pill"
                                                    style={isActive ? { background: meta.color, color: "#ffffff" } : undefined}
                                                    disabled={savingMemory}
                                                    onClick={() => setMemoryEditor(prev => prev ? { ...prev, domain: key } : prev)}
                                                >
                                                    <Icon width={14} height={14} strokeWidth={2.5} color={isActive ? "#ffffff" : meta.color} />
                                                    <span>{meta.label}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* Manual signal editor — opened via the entry menu's "重判" action.
                    Same bottom-sheet chrome (modal-overlay-bottom / modal-sheet /
                    modal-header) as the manual memory editor above, so it matches
                    the rest of the app's popups instead of floating centered. */}
                {signalEditor && (
                    <div
                        className="modal-overlay modal-overlay-bottom"
                        data-ui="modal"
                        onClick={() => (savingSignals ? undefined : setSignalEditor(null))}
                    >
                        <div
                            className="modal-sheet mb-signal-edit-sheet"
                            data-ui="modal-sheet"
                            onClick={event => event.stopPropagation()}
                        >
                            <div className="modal-header" data-ui="modal-header">
                                <button
                                    className="modal-header-btn modal-header-btn-muted"
                                    onClick={() => setSignalEditor(null)}
                                    disabled={savingSignals}
                                >
                                    <X size={18} />
                                </button>
                                <h3 className="modal-title">重判数值</h3>
                                <button
                                    className="modal-header-btn modal-header-btn-action"
                                    onClick={handleSaveSignalEditor}
                                    disabled={savingSignals}
                                >
                                    <Check size={18} />
                                </button>
                            </div>
                            <div className="modal-body mb-signal-edit-body" data-ui="modal-body">
                                <div className="mb-signal-row">
                                    <div className="mb-signal-row-head">
                                        <span className="mb-signal-row-title">重要度</span>
                                        <span className="mb-signal-row-value">{Math.round(signalEditor.importance)}</span>
                                    </div>
                                    <p className="mb-signal-row-desc">1（不重要）- 10（重要）</p>
                                    <input
                                        type="range"
                                        className="mb-signal-bar"
                                        min={1}
                                        max={10}
                                        step={1}
                                        value={signalEditor.importance}
                                        disabled={savingSignals}
                                        style={signalBarStyle(signalEditor.importance, 1, 10)}
                                        onChange={event => setSignalEditor(prev => prev ? { ...prev, importance: Number(event.target.value) } : prev)}
                                    />
                                </div>

                                <div className="mb-signal-row">
                                    <div className="mb-signal-row-head">
                                        <span className="mb-signal-row-title">情绪正负</span>
                                        <span className="mb-signal-row-value">{signalEditor.valence.toFixed(1)}</span>
                                    </div>
                                    <p className="mb-signal-row-desc">-1.0（负面）- 1.0（正面）</p>
                                    <input
                                        type="range"
                                        className="mb-signal-bar"
                                        min={-1}
                                        max={1}
                                        step={0.1}
                                        value={signalEditor.valence}
                                        disabled={savingSignals}
                                        style={signalBarStyle(signalEditor.valence, -1, 1)}
                                        onChange={event => setSignalEditor(prev => prev ? { ...prev, valence: Number(event.target.value) } : prev)}
                                    />
                                </div>

                                <div className="mb-signal-row">
                                    <div className="mb-signal-row-head">
                                        <span className="mb-signal-row-title">情绪强度</span>
                                        <span className="mb-signal-row-value">{signalEditor.arousal.toFixed(1)}</span>
                                    </div>
                                    <p className="mb-signal-row-desc">0.0（平静）- 1.0（强烈）</p>
                                    <input
                                        type="range"
                                        className="mb-signal-bar"
                                        min={0}
                                        max={1}
                                        step={0.1}
                                        value={signalEditor.arousal}
                                        disabled={savingSignals}
                                        style={signalBarStyle(signalEditor.arousal, 0, 1)}
                                        onChange={event => setSignalEditor(prev => prev ? { ...prev, arousal: Number(event.target.value) } : prev)}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Confirm delete single entry */}
                {confirmDeleteEntryId && (
                    <ConfirmDialog
                        title="确认删除？"
                        message="删除记忆条目后无法恢复。是否继续？"
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认删除"
                        onConfirm={() => {
                            handleDeleteEntry(confirmDeleteEntryId);
                            setConfirmDeleteEntryId(null);
                        }}
                        onCancel={() => setConfirmDeleteEntryId(null)}
                    />
                )}

                {/* Confirm clear all long-term entries */}
                {confirmClearAll && (
                    <ConfirmDialog
                        title="确认清除？"
                        message={activeTab === "core" ? "将清除该角色所有核心记忆，此操作无法恢复。" : "将清除该角色所有长期记忆，此操作无法恢复。"}
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认清除"
                        onConfirm={() => {
                            handleClearEntries(activeTab === "core" ? "core" : "long_term");
                            setConfirmClearAll(false);
                        }}
                        onCancel={() => setConfirmClearAll(false)}
                    />
                )}

                {confirmOrganizeType && (
                    <ConfirmDialog
                        title="确认整理？"
                        message={confirmOrganizeType === "core" ? "将检索核心记忆中的重复/相似/矛盾内容并生成整理建议，是否继续？" : "将检索长期记忆中的重复/相似/矛盾内容并生成整理建议，是否继续？"}
                        icon={AlertCircle}
                        confirmLabel="确认整理"
                        onConfirm={() => {
                            const type = confirmOrganizeType;
                            setConfirmOrganizeType(null);
                            handleRunOrganize(type);
                        }}
                        onCancel={() => setConfirmOrganizeType(null)}
                    />
                )}

                {renderOrganizeSheet()}
            </div>
        );
    }

    // ── Settings View ──
    if (view === "settings") {
        const currentPrompt = editingPrompt ?? config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT;
        const currentCorePrompt = editingCorePrompt ?? config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT;
        const isModified = currentPrompt !== (config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT);
        const isDefault = (config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT) === DEFAULT_SUMMARIZATION_PROMPT;
        const isCoreModified = currentCorePrompt !== (config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT);
        const isCoreDefault = (config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT) === DEFAULT_CORE_MEMORY_PROMPT;
        const currentOrganizePrompt = editingOrganizePrompt ?? config.organizePrompt ?? DEFAULT_ORGANIZE_PROMPT;
        const isOrganizeModified = currentOrganizePrompt !== (config.organizePrompt ?? DEFAULT_ORGANIZE_PROMPT);
        const isOrganizeDefault = (config.organizePrompt ?? DEFAULT_ORGANIZE_PROMPT) === DEFAULT_ORGANIZE_PROMPT;

        return (
            <div className="page-menu memory-settings-menu">
                <DomainStyleTag />
                {organizeProgressVisible && (
                    <div className="mb-organize-progress-toast">
                        <span className="mb-organize-progress-spinner" />
                        <span>正在整理...</span>
                    </div>
                )}
                {/* Manual summarize */}
                {selectedCharId && (
                    <>
                        <p className="menu-group-desc mx-2">手动操作</p>
                        <div className="menu-group">
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Zap} color={BINDING_ACCENTS.memory} />
                                <div className="menu-label-group">
                                    <span className="menu-label">长期记忆手动总结</span>
                                    <span className="menu-desc">将短期记忆整理为长期记忆</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={handleManualSummarize}
                                        disabled={summarizing}
                                    >
                                        {summarizing ? "处理中..." : "总结"}
                                    </button>
                                </div>
                            </div>
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                                <div className="menu-label-group">
                                    <span className="menu-label">核心记忆手动总结</span>
                                    <span className="menu-desc">将长期记忆整理为核心记忆</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={handleManualRebuildCore}
                                        disabled={rebuildingCore}
                                    >
                                        {rebuildingCore ? "处理中..." : "重建"}
                                    </button>
                                </div>
                            </div>
                            <div className="menu-item">
                                <MemorySettingsIcon icon={ListChecks} color={BINDING_ACCENTS.memory} />
                                <div className="menu-label-group">
                                    <span className="menu-label">长期记忆智能整理</span>
                                    <span className="menu-desc">检索长期记忆中的重复/相似/矛盾内容，逐条确认后处理</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={() => requestRunOrganize("long_term")}
                                        disabled={organizing}
                                    >
                                        {organizing ? "处理中..." : "整理"}
                                    </button>
                                </div>
                            </div>
                            <div className="menu-item">
                                <MemorySettingsIcon icon={ListChecks} color={BINDING_ACCENTS.embedding} />
                                <div className="menu-label-group">
                                    <span className="menu-label">核心记忆智能整理</span>
                                    <span className="menu-desc">检索核心记忆中的重复/相似/矛盾内容，逐条确认后处理</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={() => requestRunOrganize("core")}
                                        disabled={organizing}
                                    >
                                        {organizing ? "处理中..." : "整理"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </>
                )}

                {/* Feature toggles */}
                <p className="menu-group-desc mx-2">自动化</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Clock} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆自动总结</span>
                            <span className="menu-desc">每隔一定条数自动整理短期记忆为长期记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoSummarizeEnabled ?? true} onChange={(v) => {
                                const next = { ...config, autoSummarizeEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">核心记忆自动总结</span>
                            <span className="menu-desc">每隔一定条数长期记忆，自动整理为核心记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoBuildCoreEnabled ?? true} onChange={(v) => {
                                const next = { ...config, autoBuildCoreEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Search} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">向量召回</span>
                            <span className="menu-desc">长期记忆超出预算时，通过 embedding 按相关性检索</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.vectorRecallEnabled ?? true} onChange={(v) => {
                                const next = { ...config, vectorRecallEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                </div>

                {/* Token budget sliders */}
                <p className="menu-group-desc mx-2">控制截断量</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Users}
                        color={BINDING_ACCENTS.voice}
                        label="短期记忆+最近上下文"
                        desc="聊天历史、朋友圈、群聊与跨应用近期事件截断量"
                        value={config.shortTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.shortTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.shortTermTokenBudget}
                        onChange={value => saveBudget("shortTermTokenBudget", value)}
                    />
                    <MemorySettingsSliderItem
                        icon={Archive}
                        color={BINDING_ACCENTS.memory}
                        label="长期记忆"
                        desc="总结记忆注入量"
                        value={config.longTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.longTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.longTermTokenBudget}
                        onChange={value => saveBudget("longTermTokenBudget", value)}
                    />
                    <MemorySettingsSliderItem
                        icon={Brain}
                        color={BINDING_ACCENTS.embedding}
                        label="核心记忆"
                        desc="高优先级里程碑注入量"
                        value={config.coreMemoryTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.coreMemoryTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.coreMemoryTokenBudget}
                        onChange={value => saveBudget("coreMemoryTokenBudget", value)}
                    />
                </div>

                {/* Summarization interval */}
                <p className="menu-group-desc mx-2">自动总结间隔</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Clock}
                        color={BINDING_ACCENTS.api}
                        label="总结间隔"
                        desc="每 N 条事件自动触发总结"
                        value={config.summarizationEventInterval ?? 50}
                        min={10}
                        max={200}
                        step={10}
                        onChange={saveInterval}
                    />
                    <MemorySettingsSliderItem
                        icon={Brain}
                        color={BINDING_ACCENTS.embedding}
                        label="核心记忆总结间隔"
                        desc="每 N 条长期记忆自动触发核心记忆总结"
                        value={config.coreSummarizationInterval ?? 5}
                        min={1}
                        max={20}
                        step={1}
                        onChange={saveCoreInterval}
                    />
                </div>

                {/* Summarization Prompt Editor */}
                <p className="menu-group-desc mx-2">长期记忆提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.preset} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆总结提示词</span>
                            <span className="menu-desc">
                                变量：{"{{char}}"} 角色、{"{{earliest}}"} 起始时间、{"{{latest}}"} 结束时间、{"{{events}}"} 记录集合
                            </span>
                        </div>
                        {!isDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetPrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentPrompt}
                            onChange={e => setEditingPrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {isModified && (
                            <button
                                onClick={handleSavePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Zap size={14} className="mr-1.5" /> 保存提词配置
                            </button>
                        )}
                    </div>
                </div>

                <p className="menu-group-desc mx-2">核心记忆提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">核心记忆总结提示词</span>
                            <span className="menu-desc">
                                变量：{"{{char}}"} 角色、{"{{earliest}}"} 起始时间、{"{{latest}}"} 结束时间、{"{{events}}"} 长期记忆集合
                            </span>
                        </div>
                        {!isCoreDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetCorePrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentCorePrompt}
                            onChange={e => setEditingCorePrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {isCoreModified && (
                            <button
                                onClick={handleSaveCorePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Archive size={14} className="mr-1.5" /> 保存核心记忆提词配置
                            </button>
                        )}
                    </div>
                </div>

                <p className="menu-group-desc mx-2">记忆整理提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">记忆整理提示词</span>
                            <span className="menu-desc">
                                变量：{"{{char}}"} 角色、{"{{entries}}"} 候选条目集合（格式为 [id] 内容）
                            </span>
                        </div>
                        {!isOrganizeDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetOrganizePrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentOrganizePrompt}
                            onChange={e => setEditingOrganizePrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {isOrganizeModified && (
                            <button
                                onClick={handleSaveOrganizePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <PenLine size={14} className="mr-1.5" /> 保存记忆整理提词配置
                            </button>
                        )}
                    </div>
                </div>

                {confirmOrganizeType && (
                    <ConfirmDialog
                        title="确认整理？"
                        message={confirmOrganizeType === "core" ? "将检索核心记忆中的重复/相似/矛盾内容并生成整理建议，是否继续？" : "将检索长期记忆中的重复/相似/矛盾内容并生成整理建议，是否继续？"}
                        icon={AlertCircle}
                        confirmLabel="确认整理"
                        onConfirm={() => {
                            const type = confirmOrganizeType;
                            setConfirmOrganizeType(null);
                            handleRunOrganize(type);
                        }}
                        onCancel={() => setConfirmOrganizeType(null)}
                    />
                )}

                {renderOrganizeSheet()}
            </div>
        );
    }

    // ── Character List View ──
    return (
        <div className="mem-picker">
            <div className="mem-picker-card">
                <p className="mem-picker-cover-title">Every moment we shared becomes a timeless memory</p>
                <div className="mem-picker-divider"><span>✦</span></div>
                <div className="mem-picker-cover-wrap">
                    <div className="mem-picker-cover-clip">
                        {(() => {
                            const coverSrc = pickedCharId
                                ? (characters.find(c => c.character.id === pickedCharId)?.character.avatar || "")
                                : (resolveUserIdentity()?.avatarUrl || "");
                            return coverSrc ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={coverSrc}
                                    alt=""
                                    className="mem-picker-cover"
                                    draggable={false}
                                />
                            ) : null;
                        })()}
                    </div>
                </div>

                <div className="mem-picker-body">
                    <p className="mem-picker-prompt">
                        你想查看谁的记忆呢？<br />
                        <span className="mem-picker-hint">点击TA的卡片查看吧</span>
                    </p>

                    <div className="mem-picker-chips">
                        {characters.map(({ character }) => (
                            <button
                                key={character.id}
                                className="ui-chip"
                                {...(pickedCharId === character.id ? { "data-selected": "" } : {})}
                                onClick={() => setPickedCharId(pickedCharId === character.id ? null : character.id)}
                            >
                                {character.name}
                            </button>
                        ))}
                    </div>

                    <div className="mem-picker-tear">
                        <div className="mem-picker-tear-line"><span>✦</span></div>
                    </div>

                    <div className="mem-picker-action">
                        <button
                            className="ui-chip ui-chip-lg"
                            {...(pickedCharId ? { "data-selected": "" } : {})}
                            onClick={() => pickedCharId && handleSelectChar(loadCharacters().find(c => c.id === pickedCharId)!)}
                        >
                            查看TA的记忆
                        </button>
                    </div>

                    <div className="mem-picker-footer">
                        <span>OBSERVER · 记忆观察员</span>
                        <span>{characters.length} PROFILES · {characters.reduce((s, c) => s + c.shortTermCount + c.coreCount + c.longTermCount, 0)} RECORDS</span>
                        <span>{new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
