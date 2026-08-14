"use client";

import { useState, useEffect, useRef, useCallback, useContext } from "react";
import { Plus, SquarePlus, Play, Pause, AlertCircle, RefreshCw, FileEdit, Trash2, X, Check, Upload, List, GripVertical } from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import type { VoiceApiConfig } from "@/lib/settings-types";
import { loadVoiceConfigs, saveVoiceConfigs } from "@/lib/settings-storage";
import { synthesizeSpeech } from "@/lib/tts-service";
import { ConfirmDialog } from "@/components/ui/modal";
import { Toggle, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";

const SUPPORTED_VOICE_PROVIDERS = new Set(["Minimax", "OpenAI"]);
const MINIMAX_BASE_URL_OPTIONS = [
    { id: "cn", label: "国内版", baseUrl: "https://api.minimaxi.com/v1" },
    { id: "global", label: "海外版", baseUrl: "https://api.minimax.io/v1" },
];
const DEFAULT_MINIMAX_BASE_URL = MINIMAX_BASE_URL_OPTIONS[0].baseUrl;
const GLOBAL_MINIMAX_BASE_URL = MINIMAX_BASE_URL_OPTIONS[1].baseUrl;
const VOICE_PROVIDER_OPTIONS = [
    { value: "OpenAI", label: "OpenAI TTS" },
    { value: "MinimaxCN", label: "Minimax 语音国内版" },
    { value: "MinimaxGlobal", label: "Minimax 语音海外版" },
];

const DEFAULT_VOICE_CONFIGS: VoiceApiConfig[] = [
    {
        id: "default-minimax-tts",
        name: "Minimax 语音",
        provider: "Minimax",
        apiKey: "",
        baseUrl: DEFAULT_MINIMAX_BASE_URL,
        model: "speech-2.8-turbo",
        defaultVoice: "male-qn-qingse",
        enableSTT: true,
        enableTTS: true,
    }
];

const DEFAULT_MINIMAX_MODELS = [
    { id: "speech-2.8-hd", name: "speech-2.8-hd" },
    { id: "speech-2.8-turbo", name: "speech-2.8-turbo" },
    { id: "speech-2.6-hd", name: "speech-2.6-hd" },
    { id: "speech-2.6-turbo", name: "speech-2.6-turbo" },
    { id: "speech-02-hd", name: "speech-02-hd" },
    { id: "speech-02-turbo", name: "speech-02-turbo" },
    { id: "speech-01-hd", name: "speech-01-hd" },
    { id: "speech-01-turbo", name: "speech-01-turbo (速度快/性价比高)" },
];

const DEFAULT_MINIMAX_VOICES = [
    { id: "male-qn-qingse", name: "青涩青年音 (male-qn-qingse)" },
    { id: "female-shaonv", name: "少女音 (female-shaonv)" },
    { id: "female-yujie", name: "御姐音 (female-yujie)" },
    { id: "male-qn-badao", name: "霸道青年音 (male-qn-badao)" },
    { id: "Wise_Woman", name: "知性女音 (Wise_Woman)" },
    { id: "Friendly_Person", name: "亲切和蔼 (Friendly_Person)" },
    { id: "Calm_Woman", name: "冷静女音 (Calm_Woman)" },
];

const DEFAULT_OPENAI_VOICES = [
    { id: "alloy", name: "Alloy" },
    { id: "echo", name: "Echo" },
    { id: "fable", name: "Fable" },
    { id: "onyx", name: "Onyx" },
    { id: "nova", name: "Nova" },
    { id: "shimmer", name: "Shimmer" },
];

type VoiceOption = { id: string; name: string; createdAt?: number };

function uniqueOptions(options: VoiceOption[]): VoiceOption[] {
    const seen = new Set<string>();
    return options.filter(option => {
        if (!option.id || seen.has(option.id)) return false;
        seen.add(option.id);
        return true;
    });
}

function defaultVoiceOptions(provider: string): VoiceOption[] {
    return provider === "OpenAI" ? DEFAULT_OPENAI_VOICES : DEFAULT_MINIMAX_VOICES;
}

function voiceOptionsForConfig(config: VoiceApiConfig, fetchedVoices: Record<string, VoiceOption[]>): VoiceOption[] {
    return uniqueOptions([
        ...(fetchedVoices[config.id] || []),
        ...(config.customVoices || []),
        ...defaultVoiceOptions(config.provider),
    ]);
}

function normalizeVoiceConfigs(configs: VoiceApiConfig[]): VoiceApiConfig[] {
    return configs
        .filter(config => SUPPORTED_VOICE_PROVIDERS.has(config.provider))
        .map(config => {
            if (config.provider !== "Minimax") return config;
            const baseUrl = MINIMAX_BASE_URL_OPTIONS.some(option => option.baseUrl === config.baseUrl)
                ? config.baseUrl
                : DEFAULT_MINIMAX_BASE_URL;
            return { ...config, baseUrl };
        });
}

function makeCloneVoiceId(config: VoiceApiConfig): string {
    const seed = (config.name || config.defaultVoice || "voice")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 24) || "voice";
    return `${seed}_${Date.now().toString(36)}`.slice(0, 64);
}

function providerSelectValue(config: VoiceApiConfig): string {
    if (config.provider === "OpenAI") return "OpenAI";
    return config.baseUrl === GLOBAL_MINIMAX_BASE_URL ? "MinimaxGlobal" : "MinimaxCN";
}

export function VoiceSettings() {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const [configs, setConfigs] = useState<VoiceApiConfig[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNewConfig, setIsNewConfig] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
    const [cloneTargetId, setCloneTargetId] = useState<string | null>(null);
    const [cloneVoiceId, setCloneVoiceId] = useState("");
    const [cloneFile, setCloneFile] = useState<File | null>(null);
    const [cloneError, setCloneError] = useState("");
    const [isCloning, setIsCloning] = useState(false);
    const [manualModelIds, setManualModelIds] = useState<Record<string, boolean>>({});
    const [manualVoiceIds, setManualVoiceIds] = useState<Record<string, boolean>>({});
    const [isLoaded, setIsLoaded] = useState(false);
    const [dragIdx, setDragIdx] = useState<number | null>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // Fetching states for Voices
    const [isFetching, setIsFetching] = useState<Record<string, boolean>>({});
    const [fetchedVoices, setFetchedVoices] = useState<Record<string, VoiceOption[]>>({});
    const [fetchError, setFetchError] = useState<Record<string, string>>({});

    // Load from localStorage on mount
    useEffect(() => {
        const stored = loadVoiceConfigs();
        const loaded = normalizeVoiceConfigs(stored);
        if (loaded.length > 0) {
            setConfigs(loaded);
            if (loaded.length !== stored.length) saveVoiceConfigs(loaded);
        } else {
            setConfigs(DEFAULT_VOICE_CONFIGS);
            saveVoiceConfigs(DEFAULT_VOICE_CONFIGS);
        }
        setIsLoaded(true);
    }, []);

    const persist = useCallback((newConfigs: VoiceApiConfig[]) => {
        setConfigs(newConfigs);
        saveVoiceConfigs(newConfigs);
    }, []);

    const addConfig = useCallback(() => {
        const newConfig: VoiceApiConfig = {
            id: `voice-${Date.now()}`,
            name: "新语音配置",
            provider: "Minimax",
            apiKey: "",
            baseUrl: DEFAULT_MINIMAX_BASE_URL,
            region: "",
            model: "speech-2.8-turbo",
            defaultVoice: "male-qn-qingse",
            enableSTT: true,
            enableTTS: true,
        };
        persist([...configs, newConfig]);
        setIsNewConfig(true);
        setEditingId(newConfig.id);
    }, [configs, persist]);

    useEffect(() => {
        setSubpageRightAction("voice",
            <button
                onClick={addConfig}
                className="grid place-items-center w-10 h-10 text-[var(--c-text-title)] active:scale-[0.78] active:opacity-50 transition-all"
                style={{ background: "none", border: "none", cursor: "pointer" }}
            >
                <SquarePlus size={18} strokeWidth={2} />
            </button>
        );
        return () => setSubpageRightAction("voice", null);
    }, [addConfig, setSubpageRightAction]);

    const updateConfig = (id: string, updates: Partial<VoiceApiConfig>) => {
        persist(configs.map(c => c.id === id ? { ...c, ...updates } : c));
    };

    const updateProvider = (id: string, providerOption: string) => {
        const current = configs.find(c => c.id === id);
        if (providerOption === "OpenAI") {
            updateConfig(id, {
                provider: "OpenAI",
                baseUrl: "https://api.openai.com/v1",
                model: "tts-1",
                defaultVoice: "alloy",
            });
            setManualModelIds(prev => ({ ...prev, [id]: true }));
            setManualVoiceIds(prev => ({ ...prev, [id]: false }));
            return;
        }
        const wasMinimax = current?.provider === "Minimax";
        updateConfig(id, {
            provider: "Minimax",
            baseUrl: providerOption === "MinimaxGlobal" ? GLOBAL_MINIMAX_BASE_URL : DEFAULT_MINIMAX_BASE_URL,
            model: wasMinimax ? (current?.model || "speech-2.8-turbo") : "speech-2.8-turbo",
            defaultVoice: wasMinimax ? (current?.defaultVoice || "male-qn-qingse") : "male-qn-qingse",
        });
        if (!wasMinimax) {
            setManualModelIds(prev => ({ ...prev, [id]: false }));
            setManualVoiceIds(prev => ({ ...prev, [id]: false }));
        }
    };

    const removeConfig = (id: string) => {
        persist(configs.filter(c => c.id !== id));

        // Cleanup states
        const newFetchedVoices = { ...fetchedVoices };
        delete newFetchedVoices[id];
        setFetchedVoices(newFetchedVoices);

        const newFetchError = { ...fetchError };
        delete newFetchError[id];
        setFetchError(newFetchError);

        setManualModelIds(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
        setManualVoiceIds(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
    };

    const openCloneModal = (config: VoiceApiConfig) => {
        setCloneTargetId(config.id);
        setCloneVoiceId(makeCloneVoiceId(config));
        setCloneFile(null);
        setCloneError("");
        setIsCloning(false);
    };

    const closeCloneModal = () => {
        if (isCloning) return;
        setCloneTargetId(null);
        setCloneVoiceId("");
        setCloneFile(null);
        setCloneError("");
    };

    const submitClone = async () => {
        const config = configs.find(c => c.id === cloneTargetId);
        if (!config) return;
        setCloneError("");
        const voiceId = cloneVoiceId.trim();
        if (!config.apiKey.trim()) {
            setCloneError("请先填写 Minimax API Key");
            return;
        }
        if (!voiceId || !/^[A-Za-z0-9_-]{4,64}$/.test(voiceId)) {
            setCloneError("Voice ID 只能包含英文、数字、下划线和连字符，长度 4-64");
            return;
        }
        if (!cloneFile) {
            setCloneError("请上传一段音频文件");
            return;
        }

        if (cloneFile.size > 20 * 1024 * 1024) {
            setCloneError("音频文件超过 20MB,请压缩后再试(30 秒左右的干净人声即可)");
            return;
        }

        setIsCloning(true);
        try {
            // 浏览器直连 MiniMax(和 TTS 同路),不走服务端中转:
            // 避开 Netlify 函数 ~6MB 请求体和 10s 超时限制,本地 dev 也不依赖出网代理。
            const base = (config.baseUrl || DEFAULT_MINIMAX_BASE_URL).replace(/\/$/, "");
            const auth = { Authorization: `Bearer ${config.apiKey.trim()}` };
            const readBaseRespError = (payload: Record<string, unknown> | null): string | null => {
                const baseResp = (payload?.base_resp ?? {}) as Record<string, unknown>;
                const code = baseResp.status_code ?? payload?.status_code;
                const message = String(baseResp.status_msg || payload?.status_msg || "");
                if (typeof code === "number" && code !== 0) return message || `status_code=${code}`;
                if (typeof code === "string" && code && code !== "0") return message || `status_code=${code}`;
                return null;
            };
            const parseJson = (text: string): Record<string, unknown> | null => {
                try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
            };

            // 1) 上传克隆样本
            const uploadForm = new FormData();
            uploadForm.set("purpose", "voice_clone");
            uploadForm.set("file", cloneFile, cloneFile.name || "voice-sample.mp3");
            const uploadResponse = await fetch(`${base}/files/upload`, { method: "POST", headers: auth, body: uploadForm });
            const uploadText = await uploadResponse.text();
            const uploadData = parseJson(uploadText);
            const uploadError = readBaseRespError(uploadData);
            if (!uploadResponse.ok || uploadError) {
                throw new Error(uploadError || `样本上传失败 (HTTP ${uploadResponse.status}) ${uploadText.slice(0, 200)}`);
            }
            const fileRecord = (uploadData?.file ?? {}) as Record<string, unknown>;
            const fileId = fileRecord.file_id ?? uploadData?.file_id ?? uploadData?.id;
            if (fileId === undefined || fileId === null || fileId === "") {
                throw new Error(`上传结果里没有 file_id: ${uploadText.slice(0, 200)}`);
            }

            // 2) 发起克隆
            const cloneResponse = await fetch(`${base}/voice_clone`, {
                method: "POST",
                headers: { ...auth, "Content-Type": "application/json" },
                body: JSON.stringify({ file_id: fileId, voice_id: voiceId }),
            });
            const cloneText = await cloneResponse.text();
            const cloneData = parseJson(cloneText);
            const cloneRespError = readBaseRespError(cloneData);
            if (!cloneResponse.ok || cloneRespError) {
                throw new Error(cloneRespError || `克隆失败 (HTTP ${cloneResponse.status}) ${cloneText.slice(0, 200)}`);
            }
            const nextVoiceId = voiceId;
            const clonedVoice: VoiceOption = {
                id: nextVoiceId,
                name: `克隆音色 (${nextVoiceId})`,
                createdAt: Date.now(),
            };
            updateConfig(config.id, {
                defaultVoice: nextVoiceId,
                customVoices: uniqueOptions([clonedVoice, ...(config.customVoices || [])]),
            });
            setFetchedVoices(prev => {
                const current = prev[config.id] || [];
                return {
                    ...prev,
                    [config.id]: uniqueOptions([clonedVoice, ...current]),
                };
            });
            setCloneTargetId(null);
            setCloneVoiceId("");
            setCloneFile(null);
            setCloneError("");
            setManualVoiceIds(prev => ({ ...prev, [config.id]: false }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setCloneError(msg);
        } finally {
            setIsCloning(false);
        }
    };

    const fetchVoices = async (config: VoiceApiConfig) => {
        setIsFetching(prev => ({ ...prev, [config.id]: true }));
        setFetchError(prev => ({ ...prev, [config.id]: "" }));

        try {
            if (config.provider === "Minimax") {
                if (!config.apiKey.trim()) {
                    setFetchedVoices(prev => ({ ...prev, [config.id]: config.customVoices || [] }));
                    setFetchError(prev => ({ ...prev, [config.id]: "填写 API Key 后可同步账户已克隆音色" }));
                    return;
                }
                const response = await fetch("/api/voice/minimax-voices", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        apiKey: config.apiKey,
                        baseUrl: config.baseUrl || DEFAULT_MINIMAX_BASE_URL,
                    }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.message || data.error || `同步失败 (${response.status})`);
                }
                const clonedVoices = Array.isArray(data.voices) ? data.voices as VoiceOption[] : [];
                const nextCustomVoices = uniqueOptions([...clonedVoices, ...(config.customVoices || [])]);
                updateConfig(config.id, { customVoices: nextCustomVoices });
                setFetchedVoices(prev => ({ ...prev, [config.id]: nextCustomVoices }));

            } else if (config.provider === "OpenAI") {
                setFetchedVoices(prev => ({ ...prev, [config.id]: DEFAULT_OPENAI_VOICES }));
            } else {
                throw new Error("该服务商暂不支持拉取模型列表");
            }
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setFetchError(prev => ({ ...prev, [config.id]: msg }));
            setFetchedVoices(prev => ({ ...prev, [config.id]: [] }));
        } finally {
            setIsFetching(prev => ({ ...prev, [config.id]: false }));
        }
    };

    const togglePreview = async (config: VoiceApiConfig) => {
        if (playingVoiceId === config.id) {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
            setPlayingVoiceId(null);
            return;
        }

        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }

        setPlayingVoiceId(config.id);

        try {
            const blob = await synthesizeSpeech(
                "你好，我现在是" + (config.defaultVoice || "默认") + "音色。很高兴认识你。",
                config,
            );
            if (!blob) throw new Error("当前语音配置未返回真实音频");
            const url = URL.createObjectURL(blob);

            const audio = new Audio(url);
            audioRef.current = audio;
            audio.onended = () => {
                setPlayingVoiceId(null);
                audioRef.current = null;
                URL.revokeObjectURL(url);
            };
            audio.onerror = () => {
                setPlayingVoiceId(null);
                audioRef.current = null;
                URL.revokeObjectURL(url);
            };
            await audio.play();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`语音测试失败: ${msg}`);
            setPlayingVoiceId(null);
        }
    };

    if (!isLoaded) return null;

    return (
        <div className="flex flex-col gap-4">

            {configs.length === 0 ? (
                <div className="ui-empty">
                    <div className="ui-icon-circle">
                        <Play size={24} />
                    </div>
                    <span className="menu-label font-semibold">没有语音配置</span>
                    <span className="menu-desc max-w-[240px]">
                        配置语音 API 以启用语音通话和回复播报。
                    </span>
                    <button onClick={addConfig} className="ui-btn ui-btn-primary rounded-[20px] mt-2">
                        <Plus size={16} /> 添加配置
                    </button>
                </div>
            ) : (
                <div className="stg-card stg-card--flush">
                    {configs.map((config, i) => (
                        <div
                            key={config.id}
                            draggable
                            onDragStart={() => setDragIdx(i)}
                            onDragOver={e => { e.preventDefault(); }}
                            onDrop={() => {
                                if (dragIdx !== null && dragIdx !== i) {
                                    const next = [...configs];
                                    const [moved] = next.splice(dragIdx, 1);
                                    next.splice(i, 0, moved);
                                    persist(next);
                                }
                                setDragIdx(null);
                            }}
                            onDragEnd={() => setDragIdx(null)}
                            style={{ opacity: dragIdx === i ? 0.4 : 1 }}
                            onTouchStart={() => {
                                longPressTimer.current = setTimeout(() => {
                                    /* visual hint — browser drag API doesn't work on touch,
                                       but we keep drag for desktop; touch reorder can be
                                       added later via a dedicated library */
                                }, 500);
                            }}
                            onTouchEnd={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
                        >
                            <div
                                className="stg-row"
                                role="button"
                                tabIndex={0}
                                onClick={() => setEditingId(config.id)}
                            >
                                <div className="flex items-start gap-[6px] flex-1 min-w-0">
                                    <GripVertical size={14} className="text-[var(--c-text)] cursor-grab shrink-0 mt-[3px]" style={{ opacity: 0.5 }} />
                                    <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                                        <span className="stg-row-label">{config.name || config.provider}</span>
                                        <span className="text-[12px] text-[#999] truncate">{config.defaultVoice || config.model || "未设置音色"}</span>
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    onClick={(event) => { event.stopPropagation(); setConfirmDeleteId(config.id); }}
                                    className="ui-link-btn opacity-40 hover:opacity-100 ml-1"
                                    data-variant="danger"
                                >
                                    <Trash2 size={16} />
                                </button>
                            </div>
                            {i < configs.length - 1 && <div className="stg-row-divider" />}
                        </div>
                    ))}
                </div>
            )}

            {editingId && (
                <div className="modal-overlay modal-overlay-bottom">
                    <div className="modal-sheet" data-ui="modal-sheet">
                        <div className="modal-header" data-ui="modal-header">
                            <button onClick={() => { if (isNewConfig && editingId) removeConfig(editingId); setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                            <span className="modal-header-title">{isNewConfig ? "添加语音配置" : "编辑语音配置"}</span>
                            <button onClick={() => { setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                        </div>

                        <div className="modal-body hide-scrollbar pb-10" data-ui="modal-body">
                            {(() => {
                                const config = configs.find(c => c.id === editingId);
                                if (!config) return null;
                                return (
                                    <div className="flex flex-col gap-4">
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">配置名称 (Name)</label>
                                            <Input
                                                type="text"
                                                value={config.name || ""}
                                                onChange={(e) => updateConfig(config.id, { name: e.target.value })}
                                                placeholder="例如: 我的语音助手"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">服务商 (Provider)</label>
                                            <select
                                                value={providerSelectValue(config)}
                                                onChange={(e) => updateProvider(config.id, e.target.value)}
                                                className="ui-select"
                                            >
                                                {VOICE_PROVIDER_OPTIONS.map(option => (
                                                    <option key={option.value} value={option.value}>{option.label}</option>
                                                ))}
                                            </select>
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">API Key</label>
                                            <Input
                                                type="password"
                                                value={config.apiKey}
                                                onChange={(e) => updateConfig(config.id, { apiKey: e.target.value })}
                                                placeholder="输入密钥..."
                                            />
                                        </div>
                                        {config.provider === "OpenAI" && (
                                            <>
                                                <div className="flex flex-col gap-1">
                                                    <label className="menu-desc ml-1">接口地址 (Base URL)</label>
                                                    <Input
                                                        type="text"
                                                        value={config.baseUrl || ""}
                                                        onChange={(e) => updateConfig(config.id, { baseUrl: e.target.value })}
                                                        placeholder="https://api.openai.com/v1"
                                                    />
                                                </div>
                                                <div className="flex flex-col gap-1">
                                                    <label className="menu-desc ml-1">语音模型 (TTS Model)</label>
                                                    {manualModelIds[config.id] ? (
                                                        <div className="flex gap-2">
                                                            <Input
                                                                type="text"
                                                                value={config.model || ""}
                                                                onChange={(e) => updateConfig(config.id, { model: e.target.value })}
                                                                placeholder="手动输入模型 ID"
                                                                className="flex-1"
                                                            />
                                                            <button
                                                                type="button"
                                                                onClick={() => setManualModelIds(prev => ({ ...prev, [config.id]: false }))}
                                                                className="ui-icon-btn"
                                                                aria-label="返回模型下拉选择"
                                                                title="返回模型下拉选择"
                                                            >
                                                                <List size={20} />
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <select
                                                            value={config.model === "tts-1" || config.model === "tts-1-hd" ? config.model : "__manual__"}
                                                            onChange={(e) => {
                                                                if (e.target.value === "__manual__") {
                                                                    setManualModelIds(prev => ({ ...prev, [config.id]: true }));
                                                                    return;
                                                                }
                                                                updateConfig(config.id, { model: e.target.value });
                                                            }}
                                                            className="ui-select"
                                                        >
                                                            <option value="tts-1">tts-1</option>
                                                            <option value="tts-1-hd">tts-1-hd</option>
                                                            <option value="__manual__">手动输入...</option>
                                                        </select>
                                                    )}
                                                </div>
                                            </>
                                        )}

                                        {config.provider === "Minimax" && (
                                            <>
                                                <div className="flex flex-col gap-1">
                                                    <label className="menu-desc ml-1">语音模型 (TTS Model)</label>
                                                    <div className="flex flex-col gap-2">
                                                        {manualModelIds[config.id] ? (
                                                            <div className="flex gap-2">
                                                                <Input
                                                                    type="text"
                                                                    value={config.model || ""}
                                                                    onChange={(e) => updateConfig(config.id, { model: e.target.value })}
                                                                    placeholder="手动输入模型 ID"
                                                                    className="flex-1"
                                                                />
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setManualModelIds(prev => ({ ...prev, [config.id]: false }))}
                                                                    className="ui-icon-btn"
                                                                    aria-label="返回模型下拉选择"
                                                                    title="返回模型下拉选择"
                                                                >
                                                                    <List size={20} />
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <select
                                                                value={DEFAULT_MINIMAX_MODELS.some(m => m.id === config.model) ? config.model : "__manual__"}
                                                                onChange={(e) => {
                                                                    if (e.target.value === "__manual__") {
                                                                        setManualModelIds(prev => ({ ...prev, [config.id]: true }));
                                                                        return;
                                                                    }
                                                                    updateConfig(config.id, { model: e.target.value });
                                                                }}
                                                                className="ui-select"
                                                            >
                                                                {DEFAULT_MINIMAX_MODELS.map(model => (
                                                                    <option key={model.id} value={model.id}>{model.name}</option>
                                                                ))}
                                                                <option value="__manual__">手动输入...</option>
                                                            </select>
                                                        )}
                                                    </div>
                                                </div>
                                            </>
                                        )}

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">默认音色 (Default Voice) 或 自定义 Voice ID</label>
                                            <div className="flex flex-col gap-2">
                                                <div className="flex gap-2">
                                                    {manualVoiceIds[config.id] ? (
                                                        <>
                                                            <Input
                                                                type="text"
                                                                value={config.defaultVoice}
                                                                onChange={(e) => updateConfig(config.id, { defaultVoice: e.target.value })}
                                                                placeholder={config.provider === "OpenAI" ? "alloy" : "male-qn-qingse 或克隆 Voice ID"}
                                                                className="flex-1"
                                                            />
                                                            <button
                                                                type="button"
                                                                onClick={() => setManualVoiceIds(prev => ({ ...prev, [config.id]: false }))}
                                                                className="ui-icon-btn"
                                                                aria-label="返回音色下拉选择"
                                                                title="返回音色下拉选择"
                                                            >
                                                                <List size={20} />
                                                            </button>
                                                        </>
                                                    ) : (
                                                        (() => {
                                                            const options = voiceOptionsForConfig(config, fetchedVoices);
                                                            return (
                                                                <select
                                                                    value={options.some(v => v.id === config.defaultVoice) ? config.defaultVoice : "__manual__"}
                                                                    onChange={(e) => {
                                                                        if (e.target.value === "__manual__") {
                                                                            setManualVoiceIds(prev => ({ ...prev, [config.id]: true }));
                                                                            return;
                                                                        }
                                                                        updateConfig(config.id, { defaultVoice: e.target.value });
                                                                    }}
                                                                    className="ui-select flex-1"
                                                                >
                                                                    {options.map(v => (
                                                                        <option key={v.id} value={v.id}>{v.name}</option>
                                                                    ))}
                                                                    <option value="__manual__">手动输入...</option>
                                                                </select>
                                                            );
                                                        })()
                                                    )}
                                                    <button
                                                        onClick={() => togglePreview(config)}
                                                        className="ui-icon-btn"
                                                        data-active={playingVoiceId === config.id}
                                                    >
                                                        {playingVoiceId === config.id ? <Pause size={20} /> : <Play size={20} />}
                                                    </button>
                                                </div>

                                                <div className="flex gap-2 mt-0.5">
                                                    <button
                                                        onClick={() => fetchVoices(config)}
                                                        disabled={isFetching[config.id]}
                                                        className="ui-btn ui-btn ui-btn-soft-action w-full"
                                                    >
                                                        <RefreshCw size={16} className={isFetching[config.id] ? "animate-spin" : ""} />
                                                        {isFetching[config.id] ? "同步中..." : config.provider === "Minimax" ? "同步音色列表" : "显示默认音色"}
                                                    </button>
                                                    {config.provider === "Minimax" && (
                                                        <button
                                                            onClick={() => openCloneModal(config)}
                                                            disabled={!config.apiKey.trim()}
                                                            className="ui-btn ui-btn-soft-action w-full"
                                                        >
                                                            <Upload size={16} />
                                                            上传音频克隆音色
                                                        </button>
                                                    )}
                                                </div>

                                                {fetchError[config.id] && (
                                                    <Alert variant="danger">
                                                        <AlertCircle size={14} />
                                                        {fetchError[config.id]}
                                                    </Alert>
                                                )}
                                            </div>
                                        </div>

                                        <div className="ui-toggle-row">
                                            <span className="menu-label font-medium menu-label-lg">启用语音合成 (TTS)</span>
                                            <Toggle checked={config.enableTTS} onChange={(v) => updateConfig(config.id, { enableTTS: v })} />
                                        </div>
                                    </div>
                                )
                            })()}
                        </div>
                    </div>
                </div>
            )}

            {cloneTargetId && (() => {
                const config = configs.find(c => c.id === cloneTargetId);
                if (!config) return null;
                return (
                    <div className="modal-overlay">
                        <div className="modal-expand" data-ui="modal-dialog" style={{ width: "min(420px, calc(100% - 32px))", maxHeight: "82%" }}>
                            <div className="modal-header" data-ui="modal-header">
                                <button onClick={closeCloneModal} disabled={isCloning} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                                <span className="modal-header-title">克隆 Minimax 音色</span>
                                <button onClick={submitClone} disabled={isCloning} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                            </div>

                            <div className="modal-body hide-scrollbar" data-ui="modal-body">
                                <div className="flex flex-col gap-4">
                                    <div className="flex flex-col gap-1">
                                        <label className="menu-desc ml-1">新 Voice ID</label>
                                        <Input
                                            type="text"
                                            value={cloneVoiceId}
                                            onChange={(e) => setCloneVoiceId(e.target.value)}
                                            placeholder="例如 voice_xxx"
                                            disabled={isCloning}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <label className="menu-desc ml-1">音频样本</label>
                                        <input
                                            type="file"
                                            accept="audio/mpeg,audio/mp3,audio/mp4,audio/x-m4a,audio/wav,.mp3,.m4a,.wav"
                                            onChange={(e) => setCloneFile(e.target.files?.[0] || null)}
                                            disabled={isCloning}
                                            className="ui-input"
                                        />
                                        <span className="menu-desc ml-1">建议上传 10-30 秒、声音清晰、背景噪音少的音频。</span>
                                        <span className="ml-1 text-xs font-medium text-red-500">
                                            克隆音色初次使用将会扣除 9.9 元 Minimax token 费用（包含试听）。
                                        </span>
                                    </div>

                                    {cloneError && (
                                        <Alert variant="danger">
                                            <AlertCircle size={14} />
                                            {cloneError}
                                        </Alert>
                                    )}

                                    <button
                                        type="button"
                                        onClick={submitClone}
                                        disabled={isCloning}
                                        className="ui-btn ui-btn-primary w-full"
                                    >
                                        {isCloning ? <RefreshCw size={16} className="animate-spin" /> : <Upload size={16} />}
                                        {isCloning ? "正在克隆..." : "开始克隆并写入 Voice ID"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })()}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除配置后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeConfig(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}

