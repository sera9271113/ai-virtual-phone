"use client";

import { useState, useEffect, useRef, useContext, useCallback, useMemo } from "react";
import { Plus, SquarePlus, Upload, Download, Trash2, RotateCcw, ChevronLeft, ChevronRight, GripVertical, MessageSquare, AlertCircle, Maximize2, Copy, FolderOpen, ClipboardList, Import } from "lucide-react";
import {
    loadPresets,
    savePresets,
    createPreset,
    parsePresetFromJson,
    resetBuiltinPreset,
    UNSUPPORTED_IMPORT_FORMAT,
} from "@/lib/settings-storage";
import type { PresetConfig, Prompt, PromptOrderEntry } from "@/lib/settings-types";
import {
    areTagsEqual,
    CONTENT_SCOPE_TAG_GROUPS,
    getPromptTags as getScopedPromptTags,
    getTagsLabel,
    resolveContentTagLabel,
} from "@/lib/content-tag-utils";
import { buildCustomAppTagGroups, findTagGroupForTags, flattenTagGroups } from "@/lib/custom-app-tag-profiles";
import { CUSTOM_APPS_UPDATED_EVENT, loadInstalledCustomApps } from "@/lib/custom-app-storage";
import type { InstalledCustomApp } from "@/lib/custom-app-types";
import { SettingsContext } from "../phone-settings-app";
import { ConfirmDialog, ContentDialog, TextExpandModal } from "@/components/ui/modal";
import { notifyMascotPageContext } from "@/lib/mascot-events";
import { useTouchSort } from "@/lib/use-touch-sort";
import {
    clearPresetTransferPackage,
    loadPresetTransferPackage,
    savePresetTransferPackage,
    type PresetTransferPackage,
} from "@/lib/preset-transfer-storage";

// ── Tag helpers for backward compat (tags[] > featureTag + followUpOnly) ──
function getPromptTags(p: Prompt): string[] {
    return getScopedPromptTags(p);
}

function getPromptTagGroup(p: Prompt, tagGroups = CONTENT_SCOPE_TAG_GROUPS) {
    const tags = getPromptTags(p);
    return findTagGroupForTags(tagGroups, tags) ?? tagGroups[0];
}

function getPromptTagMinor(p: Prompt, group = getPromptTagGroup(p)) {
    const tags = getPromptTags(p);
    return group.minors.find(minor => areTagsEqual(minor.tags, tags)) ?? group.minors[0];
}

function getPromptTagsLabel(p: Prompt, tagProfiles = flattenTagGroups(CONTENT_SCOPE_TAG_GROUPS)): string {
    return getTagsLabel(getPromptTags(p), tagProfiles);
}

function getPromptTagsInlineLabel(p: Prompt): string {
    const tags = getPromptTags(p);
    return tags.length > 0 ? tags.map(resolveContentTagLabel).join(" · ") : "通用";
}

function setPromptTags(tags: string[]): Partial<Prompt> {
    return {
        tags: tags.length > 0 ? tags : undefined,
        featureTag: undefined,
        followUpOnly: undefined,
    };
}

function TransferStationIcon({ size = 16 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M21 6a1 1 0 0 1-1 1H10a1 1 0 1 1 0-2h10a1 1 0 0 1 1 1M21 12a1 1 0 0 1-1 1H10a1 1 0 0 1 0-2h10a1 1 0 0 1 1 1M21 18a1 1 0 0 1-1 1H10a1 1 0 0 1 0-2h10a1 1 0 0 1 1 1M7 5.995v.02c0 1.099-.895 1.99-2 1.99s-2-.891-2-1.99v-.02c0-1.099.895-1.99 2-1.99s2 .891 2 1.99M7 11.995v.02c0 1.099-.895 1.99-2 1.99s-2-.891-2-1.99v-.02c0-1.099.895-1.99 2-1.99s2 .891 2 1.99M7 17.995v.02c0 1.099-.895 1.99-2 1.99s-2-.891-2-1.99v-.02c0-1.099.895-1.99 2-1.99s2 .891 2 1.99" />
        </svg>
    );
}

const MASCOT_PRESET_STORAGE_TOOL_NAMES = new Set([
    "创建剧情预设",
    "克隆内置预设",
    "复制预设",
    "添加预设条目",
    "更新预设条目",
    "更新预设信息",
]);

const AutoResizeTextarea = ({ value, onChange, placeholder, style, rows = 1, className }: { value: string, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void, placeholder?: string, style?: React.CSSProperties, rows?: number, className?: string }) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
        }
    }, [value]);

    return (
        <textarea
            ref={textareaRef}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            rows={rows}
            className={`resize-none overflow-hidden ${className || ""}`}
            style={style}
        />
    );
};

export function PresetManager({ isActive = true }: { isActive?: boolean } = {}) {
    const [presets, setPresets] = useState<PresetConfig[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<"list" | "detail">("list");
    const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
    const [confirmExportId, setConfirmExportId] = useState<string | null>(null);
    const [confirmResetId, setConfirmResetId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [confirmDeleteEntry, setConfirmDeleteEntry] = useState<string | null>(null);
    const [transferMode, setTransferMode] = useState<"save" | "library" | null>(null);
    const [selectedPromptIds, setSelectedPromptIds] = useState<string[]>([]);
    const [transferPackage, setTransferPackage] = useState<PresetTransferPackage | null>(null);
    const [transferTargetId, setTransferTargetId] = useState<string | null>(null);
    const [transferSearch, setTransferSearch] = useState("");
    const [isLoaded, setIsLoaded] = useState(false);

    const [expandTarget, setExpandTarget] = useState<{ identifier: string; field: string } | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [customApps, setCustomApps] = useState<InstalledCustomApp[]>([]);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const { setSubpageTitle, setOverrideBack, setSubpageRightAction } = useContext(SettingsContext);

    // Initial load
    useEffect(() => {
        const loaded = loadPresets();
        if (loaded.length > 0) {
            setPresets(loaded);
        }
        setCustomApps(loadInstalledCustomApps());
        setIsLoaded(true);
        setTransferPackage(loadPresetTransferPackage());
    }, []);

    useEffect(() => {
        const refreshCustomApps = () => setCustomApps(loadInstalledCustomApps());
        const refreshPresets = () => setPresets(loadPresets());
        window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
        window.addEventListener("settings-presets-updated", refreshPresets);
        return () => {
            window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
            window.removeEventListener("settings-presets-updated", refreshPresets);
        };
    }, []);

    const tagGroups = useMemo(() => [
        ...CONTENT_SCOPE_TAG_GROUPS,
        ...buildCustomAppTagGroups(customApps, {
            prompts: presets.flatMap(preset => preset.prompts ?? []),
        }),
    ], [customApps, presets]);

    const tagProfiles = useMemo(() => flattenTagGroups(tagGroups), [tagGroups]);

    const containerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (viewMode === "detail" && editingId) {
            setOverrideBack(() => () => setViewMode("list"));
            const target = presets.find(p => p.id === editingId);
            setSubpageTitle(target?.name || "预设详情");
        } else {
            setOverrideBack(null);
            setSubpageTitle(null);
        }
    }, [viewMode, editingId, presets, setOverrideBack, setSubpageTitle]);

    useEffect(() => {
        // Reset scroll only when changing view/preset, not on every field edit.
        const scrollParent = containerRef.current?.closest(".page-body");
        if (scrollParent) scrollParent.scrollTop = 0;
    }, [viewMode, editingId]);

    // Send mascot context when viewing preset detail (only when this tab is active)
    useEffect(() => {
        if (!isActive) return;
        if (viewMode === "detail" && editingId) {
            const preset = presets.find(p => p.id === editingId);
            if (!preset) return;
            const fields: Record<string, string> = {
                presetId: editingId,
                presetName: preset.name,
                presetDescription: preset.description || "",
                promptCount: String(preset.prompts.length),
            };
            // Include current prompt_order
            if (preset.prompt_order && preset.prompt_order.length > 0) {
                fields.current_prompt_order = preset.prompt_order.map(e => `${e.identifier}(${e.enabled ? "on" : "off"})`).join(" → ");
            }
            // Include full prompt data
            for (let i = 0; i < preset.prompts.length; i++) {
                const p = preset.prompts[i];
                const prefix = `prompt_${i}`;
                fields[`${prefix}_identifier`] = p.identifier;
                fields[`${prefix}_name`] = p.name;
                fields[`${prefix}_role`] = p.role;
                fields[`${prefix}_marker`] = p.marker ? "true" : "false";
                if (!p.marker && p.content) {
                    fields[`${prefix}_content`] = p.content;
                }
                if (p.system_prompt) fields[`${prefix}_system_prompt`] = "true";
            }
            notifyMascotPageContext({
                page: "presets",
                mode: "editing",
                label: `预设 · ${preset.name}`,
                fields,
            });
        } else if (viewMode === "list") {
            notifyMascotPageContext({
                page: "presets",
                mode: "viewing",
                label: "预设列表",
                fields: {},
            });
        }
    }, [viewMode, editingId, presets, isActive]);

    // Reset mascot context on unmount
    useEffect(() => {
        return () => {
            notifyMascotPageContext({ page: "desktop", mode: "idle", label: "桌面", fields: {} });
        };
    }, []);

    // Listen for mascot fill events — assembles preset from prompt_N_xxx actions
    const editingIdRef = useRef(editingId);
    editingIdRef.current = editingId;

    useEffect(() => {
        const onFill = (e: Event) => {
            const { field, value } = (e as CustomEvent).detail;
            const presetId = editingIdRef.current;

            if (MASCOT_PRESET_STORAGE_TOOL_NAMES.has(field)) {
                const loaded = loadPresets();
                setPresets(loaded);
                if (presetId && !loaded.some(p => p.id === presetId)) {
                    setEditingId(null);
                    setViewMode("list");
                }
                return;
            }

            if (!presetId) return;

            setPresets(prev => {
                const idx = prev.findIndex(p => p.id === presetId);
                if (idx < 0) return prev;
                const preset = { ...prev[idx] };
                let handled = false;

                if (field === "preset_name") {
                    preset.name = value;
                    handled = true;
                } else if (field === "preset_description") {
                    preset.description = value;
                    handled = true;
                } else if (field === "prompt_order") {
                    try {
                        const parsed = JSON.parse(value);
                        let newOrder: PromptOrderEntry[];
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            newOrder = (parsed[0].order ? parsed[0].order : parsed) as PromptOrderEntry[];
                        } else {
                            newOrder = [];
                        }
                        if (newOrder.length > 0) {
                            preset.prompt_order = newOrder;
                            // Re-sort prompts array to match new order
                            const orderMap = new Map(newOrder.map((e, i) => [e.identifier, i]));
                            preset.prompts = [...preset.prompts].sort((a, b) => {
                                const ia = orderMap.get(a.identifier) ?? 999;
                                const ib = orderMap.get(b.identifier) ?? 999;
                                return ia - ib;
                            });
                        }
                        handled = true;
                    } catch {
                        // Ignore invalid preset order payloads.
                    }
                } else if (field.startsWith("prompt_")) {
                    const match = field.match(/^prompt_(\d+)_(\w+)$/);
                    if (match) {
                        const promptIdx = parseInt(match[1], 10);
                        const subfield = match[2];
                        // Ensure prompts array is large enough
                        const prompts = [...preset.prompts];
                        while (prompts.length <= promptIdx) {
                            prompts.push({
                                identifier: `prompt_${prompts.length}`,
                                name: "",
                                role: "system",
                                content: "",
                                injection_position: 0,
                                injection_depth: 4,
                                enabled: true,
                                marker: false,
                                system_prompt: false,
                                forbid_overrides: false,
                            });
                        }
                        const prompt = { ...prompts[promptIdx] };
                        if (subfield === "identifier") {
                            prompt.identifier = value;
                            handled = true;
                        }
                        else if (subfield === "name") {
                            prompt.name = value;
                            handled = true;
                        }
                        else if (subfield === "role") {
                            prompt.role = value as "system" | "user" | "assistant";
                            handled = true;
                        }
                        else if (subfield === "content") {
                            prompt.content = value;
                            handled = true;
                        }
                        else if (subfield === "marker") {
                            prompt.marker = value === "true";
                            if (prompt.marker) {
                                prompt.content = "";
                                prompt.injection_depth = 0;
                            }
                            handled = true;
                        }
                        else if (subfield === "system_prompt") {
                            prompt.system_prompt = value === "true";
                            handled = true;
                        }
                        if (!handled) return prev;
                        // Auto-detect marker by matching fixed names
                        const MARKER_NAMES: Record<string, string> = {
                            "◇ 用户人设": "personaDescription", "◇ 世界书（角色前）": "worldInfoBefore",
                            "◇ 角色描述": "charDescription", "◇ 角色性格": "charPersonality",
                            "◇ 角色关系": "characterRelations",
                            "◇ 世界书（角色后）": "worldInfoAfter",
                            "◇ 日程": "calendarSchedule",
                            "◇ 核心记忆": "memoryCore", "◇ 长期记忆": "memoryLongTerm",
                            "◇ [短期记忆]": "shortTermMemory",
                        };
                        if (subfield === "name" && MARKER_NAMES[value]) {
                            prompt.marker = true;
                            prompt.identifier = MARKER_NAMES[value];
                            prompt.content = "";
                            prompt.injection_depth = 0;
                        }
                        // Auto-generate identifier from name if not set or still placeholder
                        if (!prompt.marker && prompt.name && (!prompt.identifier || prompt.identifier.startsWith("_placeholder"))) {
                            prompt.identifier = prompt.name.replace(/[^\w\u4e00-\u9fff]/g, "").slice(0, 30) || `prompt_${promptIdx}`;
                        }
                        prompts[promptIdx] = prompt;
                        preset.prompts = prompts;
                        // Auto-set system_prompt on the first non-marker system prompt
                        const firstSystemIdx = prompts.findIndex(p => !p.marker && p.role === "system" && p.content);
                        for (let pi = 0; pi < prompts.length; pi++) {
                            prompts[pi] = { ...prompts[pi], system_prompt: pi === firstSystemIdx };
                        }
                        // Auto-generate prompt_order from array order
                        preset.prompt_order = prompts.filter(p => p.identifier && !p.identifier.startsWith("_placeholder")).map(p => ({ identifier: p.identifier, enabled: true }));
                    }
                }

                if (!handled) return prev;
                preset.updatedAt = Date.now();
                const next = [...prev];
                next[idx] = preset;
                savePresets(next);
                return next;
            });
        };
        window.addEventListener("mascot-fill-field", onFill);
        return () => window.removeEventListener("mascot-fill-field", onFill);
    }, []);

    const persist = useCallback((newPresets: PresetConfig[]) => {
        setPresets(newPresets);
        savePresets(newPresets);
    }, []);

    const addPreset = useCallback(() => {
        const newPreset = createPreset("新预设");
        persist([newPreset, ...presets]);
        setEditingId(newPreset.id);
        setViewMode("detail");
    }, [persist, presets]);

    const duplicatePreset = useCallback((preset: PresetConfig) => {
        const now = Date.now();
        const source = JSON.parse(JSON.stringify(preset)) as PresetConfig;
        const copy: PresetConfig = {
            ...source,
            id: `preset_${now}_${Math.random().toString(36).slice(2, 9)}`,
            name: `${source.name || "预设"} 副本`,
            createdAt: now,
            updatedAt: now,
            builtIn: undefined,
            builtInVersion: undefined,
        };
        persist([copy, ...presets]);
        setEditingId(copy.id);
        setViewMode("detail");
    }, [persist, presets]);

    const updatePreset = (id: string, updates: Partial<PresetConfig>) => {
        persist(presets.map(p => p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p));
    };

    const updatePrompt = (
        preset: PresetConfig,
        promptId: string,
        updater: (prompt: Prompt) => Prompt,
        updates: Partial<PresetConfig> = {},
    ) => {
        const newPrompts = preset.prompts.map(prompt =>
            prompt.identifier === promptId ? updater(prompt) : prompt,
        );
        updatePreset(preset.id, { ...updates, prompts: newPrompts });
    };

    // ── Prompt reorder (shared by HTML5 drag & touch sort) ──
    const handlePromptReorder = useCallback((fromIndex: number, toIndex: number) => {
        if (!editingId) return;
        const preset = presets.find(p => p.id === editingId);
        if (!preset) return;
        // Build full display list (same logic as render: ordered + orphans)
        const ordered = preset.prompt_order && preset.prompt_order.length > 0
            ? preset.prompt_order.map(e => preset.prompts.find(p => p.identifier === e.identifier)).filter((p): p is Prompt => !!p)
            : [...preset.prompts];
        const orderedIds = new Set(ordered.map(p => p.identifier));
        const orphans = preset.prompts.filter(p => !orderedIds.has(p.identifier));
        const displayed = [...ordered, ...orphans];
        // Reorder
        const [item] = displayed.splice(fromIndex, 1);
        displayed.splice(toIndex, 0, item);
        const newOrder = displayed.map(p => ({
            identifier: p.identifier,
            enabled: preset.prompt_order
                ? (preset.prompt_order.find(o => o.identifier === p.identifier)?.enabled ?? p.enabled)
                : p.enabled,
        }));
        updatePreset(preset.id, { prompts: displayed, prompt_order: newOrder });
    }, [editingId, presets]);

    const { containerRef: promptListRef, onTouchStart: onPromptTouchStart, onTouchMove: onPromptTouchMove, onTouchEnd: onPromptTouchEnd } = useTouchSort(handlePromptReorder);

    const removePreset = (id: string) => {
        const remaining = presets.filter(p => p.id !== id);
        persist(remaining);
        setViewMode("list");
    };

    const openTransferDialog = useCallback(() => {
        const stored = loadPresetTransferPackage();
        setTransferPackage(stored);
        setSelectedPromptIds([]);
        setTransferSearch("");
        setTransferMode("save");
    }, []);

    const getDisplayedPrompts = (preset: PresetConfig): Prompt[] => {
        const ordered = preset.prompt_order && preset.prompt_order.length > 0
            ? preset.prompt_order.map(entry => preset.prompts.find(prompt => prompt.identifier === entry.identifier)).filter((prompt): prompt is Prompt => !!prompt)
            : preset.prompts || [];
        const orderedIds = new Set(ordered.map(prompt => prompt.identifier));
        return [...ordered, ...(preset.prompts || []).filter(prompt => !orderedIds.has(prompt.identifier))];
    };

    const saveSelectedPrompts = () => {
        if (!editingId) return;
        const source = presets.find(preset => preset.id === editingId);
        if (!source || selectedPromptIds.length === 0) return;
        const selected = new Set(selectedPromptIds);
        const displayed = getDisplayedPrompts(source);
        const items = displayed
            .filter(prompt => selected.has(prompt.identifier))
            .map(prompt => ({
                prompt: structuredClone(prompt),
                orderEntry: {
                    identifier: prompt.identifier,
                    enabled: source.prompt_order?.find(entry => entry.identifier === prompt.identifier)?.enabled ?? prompt.enabled,
                },
            }));
        const stored = transferPackage ?? loadPresetTransferPackage();
        const existingItems = stored?.items ?? [];
        const existingIds = new Set(existingItems.map(item => item.prompt.identifier));
        const nextPackage: PresetTransferPackage = {
            sourcePresetId: stored?.sourcePresetId ?? source.id,
            sourcePresetName: stored?.sourcePresetName ?? source.name,
            savedAt: Date.now(),
            items: [...existingItems, ...items.filter(item => !existingIds.has(item.prompt.identifier))],
        };
        savePresetTransferPackage(nextPackage);
        setTransferPackage(nextPackage);
        setSelectedPromptIds(nextPackage.items.map(item => item.prompt.identifier));
        setTransferSearch("");
        setTransferMode("save");
    };

    const removeStoredPrompt = (identifier: string) => {
        if (!transferPackage) return;
        const items = transferPackage.items.filter(item => item.prompt.identifier !== identifier);
        setSelectedPromptIds(current => current.filter(id => id !== identifier));
        if (items.length === 0) {
            clearPresetTransferPackage();
            setTransferPackage(null);
            setTransferMode(null);
            return;
        }
        const nextPackage = { ...transferPackage, items };
        savePresetTransferPackage(nextPackage);
        setTransferPackage(nextPackage);
    };

    const importStoredPrompts = () => {
        if (!editingId || !transferPackage) return;
        const target = presets.find(preset => preset.id === editingId);
        if (!target) return;
        const selected = new Set(selectedPromptIds);
        const selectedItems = transferPackage.items.filter(item => selected.has(item.prompt.identifier));
        if (selectedItems.length === 0) return;
        const existingIds = new Set(target.prompts.map(prompt => prompt.identifier));
        const conflicts = selectedItems.filter(item => existingIds.has(item.prompt.identifier));
        if (conflicts.length > 0) {
            setTransferTargetId("conflict");
            return;
        }
        const importedPrompts = selectedItems.map(item => structuredClone(item.prompt));
        const importedOrder = selectedItems.map(item => ({ ...item.orderEntry }));
        const next = presets.map(preset => preset.id === target.id
            ? {
                ...preset,
                prompts: [...preset.prompts, ...importedPrompts],
                prompt_order: [...(preset.prompt_order || []), ...importedOrder],
                updatedAt: Date.now(),
            }
            : preset);
        persist(next);
        const remainingItems = transferPackage.items.filter(item => !selected.has(item.prompt.identifier));
        if (remainingItems.length > 0) {
            const remainingPackage = { ...transferPackage, items: remainingItems };
            savePresetTransferPackage(remainingPackage);
            setTransferPackage(remainingPackage);
        } else {
            clearPresetTransferPackage();
            setTransferPackage(null);
        }
        setTransferMode(null);
        setTransferTargetId(null);
    };

    const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const text = event.target?.result as string;
                const fallbackName = file.name.replace(/\.json$/i, '');
                const parsed = parsePresetFromJson(text, fallbackName);
                if (parsed) {
                    persist([parsed, ...presets]);
                } else {
                    setImportError("无法解析预设文件，格式不正确。");
                }
            } catch (e) {
                if (e instanceof Error && e.message === UNSUPPORTED_IMPORT_FORMAT) {
                    setImportError("不支持该预设格式");
                } else {
                    setImportError("无法解析预设文件，格式不正确。");
                }
            }
        };
        reader.readAsText(file);
        // Reset file input
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    };

    const handleExport = async (preset: PresetConfig) => {
        const exportData = { ...preset };
        const { downloadFile } = await import("@/lib/download-utils");
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${preset.name || "preset"}.json`);
    };


    // Top-right header icons — only the list view shows import/add.
    // Detail-view actions (copy/export/reset-or-delete) live inline next to the "Preset Info" heading instead.
    useEffect(() => {
        if (viewMode === "list") {
            setSubpageRightAction("presets",
                <div className="flex items-center gap-0">
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="grid place-items-center w-10 h-10 text-[var(--c-text-title)] active:scale-[0.78] active:opacity-50 transition-all"
                        style={{ background: "none", border: "none", cursor: "pointer" }}
                    >
                        <Download size={18} strokeWidth={2} />
                    </button>
                    <button
                        type="button"
                        onClick={addPreset}
                        className="grid place-items-center w-10 h-10 text-[var(--c-text-title)] active:scale-[0.78] active:opacity-50 transition-all"
                        style={{ background: "none", border: "none", cursor: "pointer" }}
                    >
                        <SquarePlus size={18} strokeWidth={2} />
                    </button>
                </div>
            );
        } else {
            setSubpageRightAction("presets", null);
        }
        return () => setSubpageRightAction("presets", null);
    }, [viewMode, addPreset, setSubpageRightAction]);

    if (!isLoaded) return null; // loading state

    return (
        <div ref={containerRef} className="flex flex-col gap-[24px] h-full">
            <input type="file" accept=".json" className="hidden" ref={fileInputRef} onChange={handleImport} />
            {viewMode === "list" ? (
                <>


                    {presets.length === 0 ? (
                        <div className="ui-empty mt-5">
                            <div className="ui-icon-circle">
                                <FolderOpen size={24} />
                            </div>
                            <span className="menu-label font-semibold">没有预设</span>
                            <span className="menu-desc max-w-[240px]">
                                预设用于定义 AI 的回复风格、行为设定和核心参数。
                            </span>
                            <div className="flex gap-3">
                                <button onClick={addPreset} className="ui-btn ui-btn-primary">
                                    <Plus size={16} /> 新建预设
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="preset-transfer-content flex flex-col gap-3">
                            {presets.map(preset => (
                                <div
                                    key={preset.id}
                                    className="ui-config-card min-w-0 cursor-pointer"
                                    style={{ minHeight: "84px", padding: "16px", justifyContent: "space-between" }}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`编辑 ${preset.name || "预设"}`}
                                    onClick={() => { setEditingId(preset.id); setViewMode("detail"); }}
                                    onKeyDown={(event) => {
                                        if (event.target !== event.currentTarget) return;
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            setEditingId(preset.id);
                                            setViewMode("detail");
                                        }
                                    }}
                                >
                                    <div className="min-w-0 flex flex-col gap-1.5">
                                        <div className="min-w-0 flex items-center gap-[6px]">
                                            <span className="truncate text-[calc(14.5px*var(--app-text-scale,1))] font-medium leading-tight text-[var(--c-text-title)]">{preset.name}</span>
                                            {preset.builtIn && (
                                                <span className="ui-badge shrink-0" data-variant="success">内置</span>
                                            )}
                                        </div>
                                        <span className="menu-desc truncate">{preset.description || `包含 ${preset.prompts?.length || 0} 个设定条目`}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="menu-desc ts-12">条目 {preset.prompts?.length || 0}</span>
                                        <ChevronLeft size={16} style={{ transform: "rotate(180deg)", opacity: 0.4 }} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            ) : (
                <>
                    {presets.map(preset => {
                        if (preset.id !== editingId) return null;
                        return (
                            <div key={preset.id} className="flex flex-col gap-6 pb-[24px]">
                                <div className="flex flex-col gap-2">
                                <div className="flex items-center justify-between gap-3 mx-2">
                                    <h2 className="settings-menu-section-title">Preset Info</h2>
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={openTransferDialog}
                                            aria-label={transferPackage ? "导入待移动条目" : "保存条目"}
                                            title={transferPackage ? "导入待移动条目" : "保存条目"}
                                            className="ui-link-btn opacity-40 hover:opacity-100"
                                        >
                                            <ClipboardList size={16} strokeWidth={2} />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => duplicatePreset(preset)}
                                            aria-label="复制预设"
                                            className="ui-link-btn opacity-40 hover:opacity-100"
                                        >
                                            <Copy size={16} strokeWidth={2} />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setConfirmExportId(preset.id)}
                                            aria-label="导出预设"
                                            className="ui-link-btn opacity-40 hover:opacity-100"
                                        >
                                            <Upload size={16} strokeWidth={2} />
                                        </button>
                                        {preset.builtIn ? (
                                            <button
                                                type="button"
                                                onClick={() => setConfirmResetId(preset.id)}
                                                aria-label="重置为默认"
                                                className="ui-link-btn opacity-40 hover:opacity-100"
                                            >
                                                <RotateCcw size={16} strokeWidth={2} />
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => setConfirmDeleteId(preset.id)}
                                                aria-label="删除预设"
                                                className="ui-link-btn opacity-40 hover:opacity-100"
                                            >
                                                <Trash2 size={16} strokeWidth={2} />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div className="ui-entry-card" style={{ cursor: "default" }}>
                                        <div className="flex flex-col gap-2">
                                            <div className="flex justify-between items-center">
                                                <label className="menu-label ts-13 font-medium ml-1">预设名称</label>
                                            </div>
                                            <input
                                                type="text"
                                                value={preset.name}
                                                onChange={(e) => updatePreset(preset.id, { name: e.target.value })}
                                                placeholder="预设名称..."
                                                className="ui-input font-medium"
                                            />
                                        </div>

                                        <div className="flex flex-col gap-2">
                                            <label className="menu-label ts-13 font-medium ml-1">简介描述</label>
                                            <textarea
                                                value={preset.description || ""}
                                                onChange={(e) => updatePreset(preset.id, { description: e.target.value })}
                                                placeholder="在这个预设的描述..."
                                                rows={2}
                                                className="ui-textarea resize-none"
                                            />
                                        </div>

                                        <div className="flex flex-col gap-2">
                                            <label className="menu-label ts-13 font-medium ml-1">剧情/线下模式摘要字段</label>
                                            <input
                                                type="text"
                                                value={preset.story_summary_tag || "summary"}
                                                onChange={(e) => updatePreset(preset.id, { story_summary_tag: e.target.value })}
                                                placeholder="summary"
                                                className="ui-input"
                                            />
                                            <div className="ui-slider-hint">
                                                用于从剧情模式和聊天线下模式的原始 XML 输出中提取事件摘要字段名。默认读取 {"<summary>"}。
                                            </div>
                                        </div>
                                </div>
                                </div>

                                {/* Prompts Section */}
                                <div className="flex flex-col gap-2">
                                    <h2 className="settings-menu-section-title mx-2">Prompt Entries ({preset.prompts?.length || 0})</h2>

                                    <div ref={promptListRef} className="flex flex-col gap-2"
                                        onTouchMove={onPromptTouchMove}
                                        onTouchEnd={onPromptTouchEnd}
                                        onTouchCancel={onPromptTouchEnd}
                                    >
                                        {(() => {
                                            // Display prompts in prompt_order sequence
                                            const orderedPrompts = preset.prompt_order && preset.prompt_order.length > 0
                                                ? preset.prompt_order
                                                    .map(entry => preset.prompts.find(p => p.identifier === entry.identifier))
                                                    .filter((p): p is Prompt => !!p)
                                                : preset.prompts || [];
                                            // Append any prompts not in prompt_order (orphans)
                                            const orderedIds = new Set(orderedPrompts.map(p => p.identifier));
                                            const orphans = (preset.prompts || []).filter(p => !orderedIds.has(p.identifier));
                                            return [...orderedPrompts, ...orphans];
                                        })().map((prompt, index) => {
                                            const isEditing = editingPromptId === prompt.identifier;
                                            // Effective enabled: prompt_order overrides prompt.enabled
                                            const effectiveEnabled = preset.prompt_order
                                                ? (preset.prompt_order.find(e => e.identifier === prompt.identifier)?.enabled ?? prompt.enabled)
                                                : prompt.enabled;
                                            const promptTags = getPromptTags(prompt);
                                            const matchedTagGroup = findTagGroupForTags(tagGroups, promptTags);
                                            const isCustomPromptTags = promptTags.length > 0 && !matchedTagGroup;
                                            const selectedTagGroup = matchedTagGroup ?? tagGroups[0];
                                            const selectedTagMinor = matchedTagGroup ? getPromptTagMinor(prompt, selectedTagGroup) : selectedTagGroup.minors[0];

                                            return (
                                                <div
                                                    key={prompt.identifier}
                                                    onTouchStart={isEditing ? undefined : (e) => onPromptTouchStart(index, e)}
                                                    className="ui-entry-card"
                                                    data-active={isEditing}
                                                    data-disabled={!effectiveEnabled}
                                                    style={{
                                                        gap: isEditing ? "12px" : "0px",
                                                        userSelect: isEditing ? undefined : "none",
                                                        WebkitUserSelect: isEditing ? undefined : "none",
                                                    }}
                                                >
                                                    {/* Summary Row */}
                                                    <div
                                                        onClick={() => setEditingPromptId(isEditing ? null : prompt.identifier)}
                                                        className="flex justify-between items-start gap-2 cursor-pointer"
                                                    >
                                                        <div className="flex gap-3 flex-1 min-w-0 items-start" style={{ cursor: isEditing ? "default" : "grab" }}>
                                                            <div className="ui-entry-icon mt-[2px]">
                                                                <MessageSquare size={20} />
                                                            </div>
                                                            <div className="flex flex-col gap-1 flex-1">
                                                                <div className="flex items-center gap-[6px]">
                                                                    {/* Drag Handle shown subtly */}
                                                                    <GripVertical size={14} className="text-[var(--c-text)]" style={{ opacity: isEditing ? 0 : 0.5 }} />
                                                                    <span className="menu-label ts-15 font-medium break-all">
                                                                        {prompt.name || "未命名提示词"}
                                                                    </span>
                                                                </div>
                                                                {!isEditing && (
                                                                    <div className="ts-12 flex items-center gap-[6px] flex-wrap mt-[2px]">
                                                                        {prompt.marker && (
                                                                            <span className="ui-status-tag" data-variant="warning">
                                                                                Marker
                                                                            </span>
                                                                        )}
                                                                        {!prompt.marker && (
                                                                            <>
                                                                                {/* Feature tag badge */}
                                                                                <span className="ui-status-tag" data-variant={getPromptTags(prompt).length > 0 ? "success" : undefined}>
                                                                                    {getPromptTagsLabel(prompt, tagProfiles)}
                                                                                </span>
                                                                            </>
                                                                        )}
                                                                        {/* System/User badge — shown for all entries */}
                                                                        <span className="ui-status-tag">
                                                                            {prompt.role === "system" ? "系统 (System)" : prompt.role === "assistant" ? "助手 (Assistant)" : "用户 (User)"}
                                                                        </span>
                                                                        {!prompt.marker && (
                                                                            /* Depth badge — only for non-marker entries */
                                                                            <span className="ui-status-tag" data-variant="action">
                                                                                深度: {prompt.injection_depth}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-3 shrink-0 mt-[2px]">
                                                            {/* Custom iOS-style Switch */}
                                                            <label
                                                                className="ui-mini-toggle"
                                                                onClick={(e) => e.stopPropagation()}
                                                            >
                                                                <input
                                                                    type="checkbox"
                                                                    checked={effectiveEnabled}
                                                                    onChange={(e) => {
                                                                        const checked = e.target.checked;
                                                                        let newOrder = preset.prompt_order;
                                                                        if (newOrder) {
                                                                            newOrder = newOrder.map(entry =>
                                                                                entry.identifier === prompt.identifier
                                                                                    ? { ...entry, enabled: checked }
                                                                                    : entry
                                                                            );
                                                                        }
                                                                        updatePrompt(
                                                                            preset,
                                                                            prompt.identifier,
                                                                            current => ({ ...current, enabled: checked }),
                                                                            { prompt_order: newOrder },
                                                                        );
                                                                    }}
                                                                    className="ui-mini-toggle-track"
                                                                />
                                                                <span className="ui-mini-toggle-thumb" />
                                                            </label>
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setConfirmDeleteEntry(prompt.identifier);
                                                                }}
                                                                className="ui-link-btn p-1 opacity-40 hover:opacity-100" data-variant="muted"
                                                            >
                                                                <Trash2 size={16} />
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {/* Detail Expanded Content */}
                                                    {isEditing && (
                                                        <div className="ui-entry-separator flex flex-col gap-3">
                                                            <div className="flex justify-between items-start gap-2">
                                                                <AutoResizeTextarea
                                                                    value={prompt.name}
                                                                    onChange={(e) => {
                                                                        updatePrompt(
                                                                            preset,
                                                                            prompt.identifier,
                                                                            current => ({ ...current, name: e.target.value }),
                                                                        );
                                                                    }}
                                                                    placeholder="提示词名称 (例如: 主力 Prompt)"
                                                                    rows={1}
                                                                    className="border-none bg-transparent ts-16 font-medium outline-none flex-1 min-w-0 font-[inherit] py-1 px-0 text-[var(--c-text)]"
                                                                />
                                                            </div>
                                                            {!prompt.marker && (
                                                            <div className="relative">
                                                                <textarea
                                                                    value={prompt.content}
                                                                    onChange={(e) => {
                                                                        updatePrompt(
                                                                            preset,
                                                                            prompt.identifier,
                                                                            current => ({ ...current, content: e.target.value }),
                                                                        );
                                                                    }}
                                                                    placeholder="在此输入提示词内容..."
                                                                    rows={6}
                                                                    className="ui-textarea resize-y"
                                                                />
                                                                <button onClick={() => setExpandTarget({ identifier: prompt.identifier, field: "content" })} className="absolute top-2 right-2 bg-none border-none cursor-pointer p-0" style={{ color: "var(--c-icon)" }}><Maximize2 size={14} /></button>
                                                            </div>
                                                            )}
                                                            <div className="flex flex-col gap-3 p-[10px] rounded-lg bg-[var(--c-input)]">
                                                                <div className="grid grid-cols-2 gap-3">
                                                                    <div className="flex flex-col gap-1 min-w-0">
                                                                        <label className="menu-desc ts-11">注入方式</label>
                                                                        <select value={(prompt.injection_position ?? 0) === 0 ? "0" : "1"} onChange={e => {
                                                                            updatePrompt(
                                                                                preset,
                                                                                prompt.identifier,
                                                                                current => ({ ...current, injection_position: parseInt(e.target.value) }),
                                                                            );
                                                                        }} className="ui-select ts-13 px-2 py-[6px] rounded-[6px]">
                                                                            <option value="0">跟随排序</option>
                                                                            <option value="1">插入聊天</option>
                                                                        </select>
                                                                    </div>
                                                                    <div className="flex flex-col gap-1 min-w-0">
                                                                        <label className="menu-desc ts-11">Inject Depth</label>
                                                                        <input type="number" value={prompt.injection_depth ?? 0} onChange={e => {
                                                                            updatePrompt(
                                                                                preset,
                                                                                prompt.identifier,
                                                                                current => ({ ...current, injection_depth: parseInt(e.target.value) || 0 }),
                                                                            );
                                                                        }} className="ui-input ts-13 px-2 py-[6px] rounded-[6px]" />
                                                                    </div>
                                                                </div>
                                                                <div className="grid grid-cols-2 gap-3">
                                                                    <div className="flex flex-col gap-[2px] min-w-0">
                                                                        <label className="menu-desc ts-11 ml-[2px]">Role</label>
                                                                        <select
                                                                            value={prompt.role}
                                                                            onChange={(e) => {
                                                                                updatePrompt(
                                                                                    preset,
                                                                                    prompt.identifier,
                                                                                    current => ({ ...current, role: e.target.value }),
                                                                                );
                                                                            }}
                                                                            className="ui-select ts-13 px-2 py-[6px] rounded-[6px]"
                                                                        >
                                                                            <option value="system">System</option>
                                                                            <option value="user">User</option>
                                                                            <option value="assistant">Assistant</option>
                                                                        </select>
                                                                    </div>
                                                                    <div className="flex flex-col gap-[2px] min-w-0">
                                                                        <label className="menu-desc ts-11 ml-[2px]">适用范围</label>
                                                                        <div className="grid grid-cols-2 gap-2">
                                                                            <select
                                                                                value={isCustomPromptTags ? "__custom__" : selectedTagGroup.id}
                                                                                onChange={(e) => {
                                                                                    const group = tagGroups.find(item => item.id === e.target.value);
                                                                                    const firstMinor = group?.minors[0];
                                                                                    if (!firstMinor) return;
                                                                                    updatePrompt(
                                                                                        preset,
                                                                                        prompt.identifier,
                                                                                        current => ({ ...current, ...setPromptTags(firstMinor.tags) }),
                                                                                    );
                                                                                }}
                                                                                className="ui-select ts-13 px-2 py-[6px] rounded-[6px]"
                                                                            >
                                                                                {isCustomPromptTags ? (
                                                                                    <option value="__custom__">自定义</option>
                                                                                ) : null}
                                                                                {tagGroups.map((group) => (
                                                                                    <option key={group.id} value={group.id}>{group.label}</option>
                                                                                ))}
                                                                            </select>
                                                                            <select
                                                                                value={isCustomPromptTags ? "__custom__" : selectedTagMinor.id}
                                                                                onChange={(e) => {
                                                                                    const minor = selectedTagGroup.minors.find(item => item.id === e.target.value);
                                                                                    if (!minor) return;
                                                                                    updatePrompt(
                                                                                        preset,
                                                                                        prompt.identifier,
                                                                                        current => ({ ...current, ...setPromptTags(minor.tags) }),
                                                                                    );
                                                                                }}
                                                                                className="ui-select ts-13 px-2 py-[6px] rounded-[6px]"
                                                                            >
                                                                                {isCustomPromptTags ? (
                                                                                    <option value="__custom__">自定义</option>
                                                                                ) : null}
                                                                                {selectedTagGroup.minors.map((minor) => (
                                                                                    <option key={minor.id} value={minor.id}>{minor.label}</option>
                                                                                ))}
                                                                            </select>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="flex gap-[10px] pt-1 flex-wrap items-center">
                                                                <label className="ui-checkbox-label whitespace-nowrap">
                                                                    <input type="checkbox" checked={Boolean(prompt.marker)} onChange={e => {
                                                                        updatePrompt(
                                                                            preset,
                                                                            prompt.identifier,
                                                                            current => ({ ...current, marker: e.target.checked }),
                                                                        );
                                                                    }} />
                                                                    Marker
                                                                </label>
                                                                <span className="menu-desc ts-11 whitespace-nowrap">
                                                                    实际标签：{getPromptTagsInlineLabel(prompt)}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        {(!preset.prompts || preset.prompts.length === 0) && (
                                            <div className="menu-desc text-center ts-13 p-3">
                                                空预设不会产生背景设定，请添加提示词条目。
                                            </div>
                                        )}
                                    </div>

                                    <button
                                        type="button"
                                        onClick={() => {
                                            const newPrompt = {
                                                identifier: `prompt-${Date.now()}`,
                                                name: "新提示词",
                                                role: "system" as const,
                                                content: "",
                                                injection_depth: 0,
                                                enabled: true
                                            };
                                            const newPrompts = [...(preset.prompts || []), newPrompt];
                                            const newOrder = newPrompts.map(p => ({
                                                identifier: p.identifier,
                                                enabled: preset.prompt_order
                                                    ? (preset.prompt_order.find(o => o.identifier === p.identifier)?.enabled ?? p.enabled)
                                                    : p.enabled,
                                            }));
                                            updatePreset(preset.id, { prompts: newPrompts, prompt_order: newOrder });
                                        }}
                                        className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                                    >
                                        <Plus size={15} strokeWidth={1.8} />
                                        添加条目
                                    </button>
                                </div>
                            </div>
                        )
                    })}
                </>
            )}

            {confirmExportId && (() => {
                const targetPreset = presets.find(preset => preset.id === confirmExportId);
                if (!targetPreset) return null;
                return (
                    <ConfirmDialog
                        title="确认导出预设？"
                        message={`将导出“${targetPreset.name || "当前预设"}”为 JSON 文件。是否继续？`}
                        icon={Upload}
                        variant="action"
                        confirmLabel="确认导出"
                        onConfirm={() => {
                            handleExport(targetPreset);
                            setConfirmExportId(null);
                        }}
                        onCancel={() => setConfirmExportId(null)}
                    />
                );
            })()}

            {confirmResetId && (() => {
                const targetPreset = presets.find(preset => preset.id === confirmResetId);
                if (!targetPreset) return null;
                return (
                    <ConfirmDialog
                        title="确认重置默认？"
                        message={`这会把“${targetPreset.name || "默认预设"}”恢复为出厂内容，当前修改会被覆盖。是否继续？`}
                        icon={RotateCcw}
                        variant="danger"
                        confirmLabel="确认重置"
                        onConfirm={() => {
                            resetBuiltinPreset();
                            setPresets(loadPresets());
                            setConfirmResetId(null);
                        }}
                        onCancel={() => setConfirmResetId(null)}
                    />
                );
            })()}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除预设后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    onConfirm={() => {
                        removePreset(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
            {/* Confirm delete entry dialog */}
            {confirmDeleteEntry !== null && editingId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除条目后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    onConfirm={() => {
                        const p = presets.find(x => x.id === editingId);
                        if (p) {
                            const removedId = confirmDeleteEntry;
                            const newPrompts = p.prompts.filter(prompt => prompt.identifier !== removedId);
                            const newOrder = (p.prompt_order || []).filter(o => o.identifier !== removedId);
                            updatePreset(p.id, { prompts: newPrompts, prompt_order: newOrder });
                            if (editingPromptId === removedId) setEditingPromptId(null);
                        }
                        setConfirmDeleteEntry(null);
                    }}
                    onCancel={() => setConfirmDeleteEntry(null)}
                />
            )}

            {transferMode === "save" && editingId && (() => {
                const source = presets.find(preset => preset.id === editingId);
                if (!source) return null;
                const displayed = getDisplayedPrompts(source);
                const allSelected = displayed.length > 0 && selectedPromptIds.length === displayed.length;
                const query = transferSearch.trim().toLowerCase();
                const filtered = displayed.filter(prompt => `${prompt.name} ${prompt.identifier} ${prompt.role}`.toLowerCase().includes(query));
                return (
                    <ContentDialog
                        title={`${source.name || "当前预设"} (${displayed.length})`}
                        dialogClassName="preset-transfer-dialog"
                        confirmLabel={selectedPromptIds.length > 0 ? `保存 ${selectedPromptIds.length} 项` : "选择要保存的条目"}
                        onConfirm={saveSelectedPrompts}
                        onCancel={() => setTransferMode(null)}
                    >
                        <div className="preset-transfer-content flex flex-col gap-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="menu-desc">从“{source.name}”选择要转移的条目</span>
                                <div className="flex items-center gap-3">
                                    <button
                                        type="button"
                                        className="ui-link-btn whitespace-nowrap"
                                        onClick={() => {
                                            setSelectedPromptIds(transferPackage?.items.map(item => item.prompt.identifier) ?? []);
                                            setTransferSearch("");
                                            setTransferMode("library");
                                        }}
                                    >
                                        <TransferStationIcon size={16} />
                                    </button>
                                    <button
                                        type="button"
                                        className="ui-link-btn whitespace-nowrap"
                                        onClick={() => setSelectedPromptIds(allSelected ? [] : displayed.map(prompt => prompt.identifier))}
                                    >
                                        {allSelected ? "清空选择" : "全选"}
                                    </button>
                                </div>
                            </div>
                            <input
                                type="search"
                                value={transferSearch}
                                onChange={(event) => setTransferSearch(event.target.value)}
                                placeholder="搜索条目..."
                                className="ui-input preset-transfer-search"
                            />
                            <div className="preset-transfer-list flex max-h-[min(50vh,380px)] flex-col overflow-y-auto px-2">
                                {filtered.map(prompt => (
                                    <label key={prompt.identifier} className="preset-transfer-row flex cursor-pointer items-center gap-3">
                                        <input
                                            type="checkbox"
                                            checked={selectedPromptIds.includes(prompt.identifier)}
                                            onChange={(event) => setSelectedPromptIds(current => event.target.checked
                                                ? [...current, prompt.identifier]
                                                : current.filter(id => id !== prompt.identifier))}
                                            className="h-4 w-4 shrink-0"
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="menu-label block truncate">{prompt.name || "未命名提示词"}</span>
                                            <span className="menu-desc block truncate">{prompt.marker ? "Marker" : `${prompt.role} · ${getPromptTagsInlineLabel(prompt)}`}</span>
                                        </span>
                                    </label>
                                ))}
                                {displayed.length === 0 && <span className="menu-desc p-3 text-center">当前预设没有可保存的条目。</span>}
                                {displayed.length > 0 && filtered.length === 0 && <span className="menu-desc p-3 text-center">没有匹配的条目。</span>}
                            </div>
                        </div>
                    </ContentDialog>
                );
            })()}

            {transferMode === "library" && editingId && (() => {
                const target = presets.find(preset => preset.id === editingId);
                if (!target) return null;
                const items = transferPackage?.items ?? [];
                const query = transferSearch.trim().toLowerCase();
                const filtered = items.filter(item => `${item.prompt.name} ${item.prompt.identifier} ${item.prompt.role}`.toLowerCase().includes(query));
                const allSelected = items.length > 0 && selectedPromptIds.length === items.length;
                const selected = new Set(selectedPromptIds);
                const conflicts = items.filter(item => selected.has(item.prompt.identifier) && target.prompts.some(prompt => prompt.identifier === item.prompt.identifier));
                return (
                    <ContentDialog
                        title={`条目中转站 (${items.length})`}
                        dialogClassName="preset-transfer-dialog"
                        backLabel="返回选择条目"
                        onBack={() => {
                            setSelectedPromptIds([]);
                            setTransferSearch("");
                            setTransferMode("save");
                        }}
                        confirmLabel={items.length === 0 ? "" : conflicts.length > 0 ? "存在冲突" : selectedPromptIds.length > 0 ? `导入 ${selectedPromptIds.length} 项` : "选择条目"}
                        onConfirm={importStoredPrompts}
                        onCancel={() => setTransferMode(null)}
                    >
                        <div className="flex flex-col gap-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="menu-desc">来源：{transferPackage?.sourcePresetName ?? "本地中转站"} → {target.name}</span>
                                <button
                                    type="button"
                                    className="ui-link-btn whitespace-nowrap"
                                    onClick={() => setSelectedPromptIds(allSelected ? [] : items.map(item => item.prompt.identifier))}
                                >
                                    {allSelected ? "清空选择" : "全选"}
                                </button>
                            </div>
                            <input
                                type="search"
                                value={transferSearch}
                                onChange={(event) => setTransferSearch(event.target.value)}
                                placeholder="搜索条目..."
                                className="ui-input preset-transfer-search"
                            />
                            <div className="preset-transfer-list flex max-h-[min(50vh,380px)] flex-col overflow-y-auto px-2">
                                {filtered.map(item => (
                                    <div key={item.prompt.identifier} className="preset-transfer-row flex items-center gap-3">
                                        <input
                                            type="checkbox"
                                            checked={selectedPromptIds.includes(item.prompt.identifier)}
                                            onChange={(event) => setSelectedPromptIds(current => event.target.checked
                                                ? [...current, item.prompt.identifier]
                                                : current.filter(id => id !== item.prompt.identifier))}
                                            className="h-4 w-4 shrink-0"
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="menu-label block truncate">{item.prompt.name || "未命名提示词"}</span>
                                            <span className="menu-desc block truncate">{item.prompt.marker ? "Marker" : `${item.prompt.role} · ${getPromptTagsInlineLabel(item.prompt)}`}</span>
                                        </span>
                                        <button
                                            type="button"
                                            className="grid h-8 w-8 shrink-0 place-items-center text-[var(--c-text-muted)] active:opacity-50"
                                            aria-label={`删除 ${item.prompt.name || "条目"}`}
                                            title="从中转站删除"
                                            onClick={() => removeStoredPrompt(item.prompt.identifier)}
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                ))}
                                {filtered.length === 0 && <span className="menu-desc p-3 text-center">没有匹配的条目。</span>}
                            </div>
                            {conflicts.length > 0 && (
                                <div className="preset-transfer-conflict p-3">
                                    <span className="menu-label block">无法导入：存在 identifier 冲突</span>
                                    <span className="menu-desc block">{conflicts.map(item => item.prompt.name || item.prompt.identifier).join("、")}</span>
                                </div>
                            )}
                            <div className="preset-transfer-actions">
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-soft-danger preset-transfer-action"
                                    onClick={() => {
                                        clearPresetTransferPackage();
                                        setTransferPackage(null);
                                        setSelectedPromptIds([]);
                                        setTransferSearch("");
                                    }}
                                >
                                    <Trash2 size={14} /> 清空中转站
                                </button>
                            </div>
                            {items.length === 0 && <span className="menu-desc text-center">中转库暂无已保存条目。</span>}
                        </div>
                    </ContentDialog>
                );
            })()}

            {transferTargetId === "conflict" && (
                <ConfirmDialog
                    title="无法导入"
                    message="目标预设中已有相同 identifier 的条目。请先处理重复条目，待移动内容仍会保留。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="知道了"
                    cancelLabel=""
                    onConfirm={() => setTransferTargetId(null)}
                    onCancel={() => setTransferTargetId(null)}
                />
            )}

            {importError && (
                <ConfirmDialog
                    title="导入失败"
                    message={importError}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="知道了"
                    cancelLabel=""
                    onConfirm={() => setImportError(null)}
                    onCancel={() => setImportError(null)}
                />
            )}

            {expandTarget && editingId && (() => {
                const preset = presets.find(p => p.id === editingId);
                const promptIdx = preset?.prompts.findIndex(p => p.identifier === expandTarget.identifier) ?? -1;
                const prompt = promptIdx >= 0 ? preset?.prompts[promptIdx] : undefined;
                if (!preset || !prompt || promptIdx < 0) return null;
                return (
                    <TextExpandModal
                        title={prompt.name || "编辑提示词"}
                        value={prompt.content}
                        onChange={(v) => {
                            const newPrompts = [...preset.prompts];
                            newPrompts[promptIdx] = { ...prompt, content: v };
                            updatePreset(preset.id, { prompts: newPrompts });
                        }}
                        placeholder="在此输入提示词内容..."
                        onClose={() => setExpandTarget(null)}
                    />
                );
            })()}
        </div>
    );
}
