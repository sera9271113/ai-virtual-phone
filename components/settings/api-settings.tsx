"use client";

import { useState, useEffect, useCallback, useContext, useRef } from "react";
import { Plus, SquarePlus, RefreshCw, Rss, AlertCircle, FileEdit, Trash2, X, Check, ChevronRight, GripVertical } from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import type { ApiConfig, GenerationParams } from "@/lib/settings-types";
import { DEFAULT_GENERATION_PARAMS } from "@/lib/settings-types";
import { loadApiConfigs, saveApiConfigs } from "@/lib/settings-storage";
import { generateEmbedding, isEmbeddingModelName } from "@/lib/memory-embedding";
import { ConfirmDialog } from "@/components/ui/modal";
import { Toggle, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { determineBaseUrl, simpleLLMCall } from "@/lib/api-helpers";

const DEFAULT_CONFIGS: ApiConfig[] = [
    {
        id: "default-openai",
        name: "OpenAI 官方",
        provider: "OpenAI",
        apiKey: "",
        defaultModel: "gpt-4o",
        enableNativeTools: true,
        enableImageRecognition: true,
        enableImageGeneration: true,
        preventEmptyGenerateRambling: true,
    }
];

function getNativeToolProtocolLabel(config: ApiConfig): string {
    if (config.provider === "Anthropic" && !config.baseUrl) return "Anthropic";
    if (config.provider === "Google") return "Gemini";
    return "OpenAI-compatible";
}

export function ApiSettings() {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const [configs, setConfigs] = useState<ApiConfig[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNewConfig, setIsNewConfig] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);

    // Testing and Fetching states
    const [isFetching, setIsFetching] = useState<Record<string, boolean>>({});
    const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});
    const [isTesting, setIsTesting] = useState<Record<string, boolean>>({});
    const [dragIdx, setDragIdx] = useState<number | null>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [testResult, setTestResult] = useState<Record<string, { success: boolean; message: string }>>({});

    // Load from localStorage on mount
    useEffect(() => {
        const loaded = loadApiConfigs();
        if (loaded.length > 0) {
            setConfigs(loaded);
        } else {
            setConfigs(DEFAULT_CONFIGS);
            saveApiConfigs(DEFAULT_CONFIGS);
        }
        setIsLoaded(true);
    }, []);

    const persist = useCallback((newConfigs: ApiConfig[]) => {
        setConfigs(newConfigs);
        saveApiConfigs(newConfigs);
    }, []);

    const addConfig = useCallback(() => {
        const newConfig: ApiConfig = {
            id: `config-${Date.now()}`,
            name: "新配置",
            provider: "Custom",
            apiKey: "",
            defaultModel: "",
            enableNativeTools: true,
            enableImageRecognition: false,
            enableImageGeneration: false,
            preventEmptyGenerateRambling: true,
        };
        persist([...configs, newConfig]);
        setIsNewConfig(true);
        setEditingId(newConfig.id);
    }, [configs, persist]);

    useEffect(() => {
        setSubpageRightAction("api",
            <button
                onClick={addConfig}
                className="grid place-items-center w-10 h-10 text-[var(--c-text-title)] active:scale-[0.78] active:opacity-50 transition-all"
                style={{ background: "none", border: "none", cursor: "pointer" }}
            >
                <SquarePlus size={18} strokeWidth={2} />
            </button>
        );
        return () => setSubpageRightAction("api", null);
    }, [addConfig, setSubpageRightAction]);

    const updateConfig = (id: string, updates: Partial<ApiConfig>) => {
        persist(configs.map(c => c.id === id ? { ...c, ...updates } : c));
    };

    const removeConfig = (id: string) => {
        persist(configs.filter(c => c.id !== id));
        const newFetchedModels = { ...fetchedModels };
        delete newFetchedModels[id];
        setFetchedModels(newFetchedModels);

        const newTestResults = { ...testResult };
        delete newTestResults[id];
        setTestResult(newTestResults);
    };

    // Use unified determineBaseUrl from api-helpers

    const fetchModels = async (config: ApiConfig) => {
        setIsFetching(prev => ({ ...prev, [config.id]: true }));
        setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "" } }));

        try {
            const baseUrl = determineBaseUrl(config);
            if (!baseUrl) throw new Error("缺少 Base URL");
            if (!config.apiKey) throw new Error("缺少 API Key");

            // Gemini 原生协议（/v1beta）：URL 用 ?key= 鉴权，响应是 { models: [{ name }] }
            // OpenAI 兼容（/v1）：Authorization: Bearer + 响应是 { data: [{ id }] }
            const isGoogleNative = config.provider === "Google";
            // 用户常把完整端点填进 Base URL（如 .../v1/embeddings、.../v1/chat/completions），
            // 拼 /models 前剥掉这类端点后缀；已以 /models 结尾则原样使用。
            const modelsBase = baseUrl
                .replace(/\/$/, "")
                .replace(/\/(chat\/completions|completions|embeddings|messages)$/i, "");
            const modelsUrl = /\/models$/i.test(modelsBase) ? modelsBase : `${modelsBase}/models`;
            const url = isGoogleNative
                ? `${modelsUrl}?key=${encodeURIComponent(config.apiKey)}`
                : modelsUrl;
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (!isGoogleNative) headers["Authorization"] = `Bearer ${config.apiKey}`;

            const response = await fetch(url, { method: "GET", headers });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || `HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            let modelNames: string[] = [];
            if (isGoogleNative && Array.isArray(data?.models)) {
                // Gemini 原生：name 可能是 "models/gemini-2.5-pro" 或纯名字
                modelNames = data.models.map((m: { name: string }) => (m.name || "").replace(/^models\//, ""));
            } else if (Array.isArray(data?.data)) {
                modelNames = data.data.map((m: { id: string }) => m.id);
            } else {
                throw new Error("返回数据格式不符合预期");
            }
            setFetchedModels(prev => ({ ...prev, [config.id]: modelNames }));
            setTestResult(prev => ({ ...prev, [config.id]: { success: true, message: `成功获取 ${modelNames.length} 个模型` } }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: `拉取失败: ${msg}` } }));
            setFetchedModels(prev => ({ ...prev, [config.id]: [] }));
        } finally {
            setIsFetching(prev => ({ ...prev, [config.id]: false }));
        }
    };

    const testConnection = async (config: ApiConfig) => {
        if (!config.defaultModel) {
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "请先输入或选择默认模型" } }));
            return;
        }

        setIsTesting(prev => ({ ...prev, [config.id]: true }));
        setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: "" } }));

        try {
            // 向量模型配置：测 /embeddings 端点。原来一律测 /chat/completions，
            // 导致 embedding 配置永远 404「测试失败」。
            if (isEmbeddingModelName(config.defaultModel)) {
                const embedding = await generateEmbedding("你好", config, { throwOnError: true });
                if (!embedding) throw new Error("接口未返回向量数据");
                setTestResult(prev => ({
                    ...prev,
                    [config.id]: { success: true, message: `测试成功! 向量模型可用，维度 ${embedding.length}` },
                }));
                return;
            }
            const result = await simpleLLMCall(
                config,
                [{ role: "user", content: "你好" }],
                // Cap (not spend): reasoning models (deepseek-reasoner / gemini-pro 等) burn
                // tokens on hidden reasoning first, so a tiny cap leaves the visible
                // content empty and the test falsely fails (finishReason=length).
                // 4096 covers heavy thinkers; a "你好" reply still stops well before it.
                { temperature: 0.2, max_tokens: 4096 },
            );
            if (result.error || !result.content) {
                throw new Error(result.error || "模型返回了空内容");
            }
            const reply = result.content.replace(/\s+/g, " ").trim();
            const preview = reply.length > 80 ? `${reply.slice(0, 80)}...` : reply;
            setTestResult(prev => ({
                ...prev,
                [config.id]: { success: true, message: `测试成功! 模型回复: ${preview}` },
            }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setTestResult(prev => ({ ...prev, [config.id]: { success: false, message: `测试失败: ${msg}` } }));
        } finally {
            setIsTesting(prev => ({ ...prev, [config.id]: false }));
        }
    };

    if (!isLoaded) return null;

    return (
        <div className="flex flex-col gap-4">

            {configs.length === 0 ? (
                <div className="ui-empty">
                    <div className="ui-icon-circle">
                        <AlertCircle size={24} />
                    </div>
                    <span className="menu-label font-semibold">没有 API 配置</span>
                    <span className="menu-desc max-w-[240px]">
                        配置 API 密钥和模型以连接到 AI 服务。
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
                                        <span className="text-[12px] text-[#999] truncate">{config.defaultModel || "未设置模型"}</span>
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
                            <span className="modal-header-title">{isNewConfig ? "添加配置" : "编辑配置"}</span>
                            <button onClick={() => { setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                        </div>

                        <div className="modal-body hide-scrollbar flex flex-col gap-4 pb-10" data-ui="modal-body">
                            {(() => {
                                const config = configs.find(c => c.id === editingId);
                                if (!config) return null;
                                return (
                                    <>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">配置名称 (Name)</label>
                                            <Input
                                                type="text"
                                                value={config.name || ""}
                                                onChange={(e) => updateConfig(config.id, { name: e.target.value })}
                                                placeholder="例如: 我的 OpenAI"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">服务商 (Provider)</label>
                                            <select
                                                value={config.provider}
                                                onChange={(e) => updateConfig(config.id, { provider: e.target.value })}
                                                className="ui-select"
                                            >
                                                <option value="OpenAI">OpenAI</option>
                                                <option value="Anthropic">Anthropic</option>
                                                <option value="Google">Google Gemini</option>
                                                <option value="DeepSeek">DeepSeek</option>
                                                <option value="Groq">Groq</option>
                                                <option value="OpenRouter">OpenRouter</option>
                                                <option value="Moonshot">Kimi (Moonshot)</option>
                                                <option value="Zhipu">Zhipu (GLM)</option>
                                                <option value="SiliconFlow">SiliconFlow</option>
                                                <option value="TogetherAI">Together AI</option>
                                                <option value="Custom">自定义 (Custom)</option>
                                            </select>
                                        </div>

                                        {/* Custom 必填 Base URL；其他 provider 可选填中转站地址 */}
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">
                                                Base URL {config.provider === "Custom" ? "（必填）" : "（可选，留空用官方端点）"}
                                                {config.provider === "Google" && (
                                                    <span style={{ color: "#888", marginLeft: 6, fontSize: "0.85em" }}>
                                                        中转站填 https://xxx/v1beta 走原生协议
                                                    </span>
                                                )}
                                            </label>
                                            <Input
                                                type="url"
                                                value={config.baseUrl || ""}
                                                onChange={(e) => updateConfig(config.id, { baseUrl: e.target.value })}
                                                placeholder={
                                                    config.provider === "Custom"
                                                        ? "https://api.example.com/v1"
                                                        : config.provider === "Google"
                                                            ? "https://your-proxy.example.com/v1beta"
                                                            : "默认用官方端点，留空即可"
                                                }
                                            />
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">API Key</label>
                                            <Input
                                                type="password"
                                                value={config.apiKey}
                                                onChange={(e) => updateConfig(config.id, { apiKey: e.target.value })}
                                                placeholder="sk-..."
                                            />
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">默认模型 (Default Model)</label>
                                            <div className="flex gap-2">
                                                {fetchedModels[config.id] && fetchedModels[config.id].length > 0 ? (
                                                    <select
                                                        value={config.defaultModel}
                                                        onChange={(e) => updateConfig(config.id, { defaultModel: e.target.value })}
                                                        className="ui-select flex-1"
                                                    >
                                                        <option value="">请选择模型...</option>
                                                        {fetchedModels[config.id].map(m => (
                                                            <option key={m} value={m}>{m}</option>
                                                        ))}
                                                    </select>
                                                ) : (
                                                    <input
                                                        type="text"
                                                        value={config.defaultModel}
                                                        onChange={(e) => updateConfig(config.id, { defaultModel: e.target.value })}
                                                        placeholder="gpt-4o, claude-3-opus..."
                                                        className="ui-input flex-1"
                                                    />
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex gap-3 mt-1">
                                            <button
                                                onClick={() => fetchModels(config)}
                                                disabled={isFetching[config.id]}
                                                className="ui-btn ui-btn ui-btn-soft-action flex-1"
                                            >
                                                <RefreshCw size={16} className={isFetching[config.id] ? "animate-spin" : ""} />
                                                {isFetching[config.id] ? "拉取中..." : "拉取模型列表"}
                                            </button>

                                            <button
                                                onClick={() => testConnection(config)}
                                                disabled={isTesting[config.id]}
                                                className="ui-btn ui-btn ui-btn-success flex-1"
                                            >
                                                <Rss size={16} className={isTesting[config.id] ? "animate-spin" : ""} />
                                                {isTesting[config.id] ? "测试中..." : "测试连接"}
                                            </button>
                                        </div>

                                        {testResult[config.id] && testResult[config.id].message && (
                                            <Alert variant={testResult[config.id].success ? "success" : "danger"}>
                                                <AlertCircle size={16} className="mt-[2px] shrink-0" />
                                                <span className="break-all leading-[1.5]">{testResult[config.id].message}</span>
                                            </Alert>
                                        )}

                                        {/* ── Toggles card ── */}
                                        <div className="rounded-[14px] bg-[var(--c-card,#fff)] border border-[var(--c-card-border,#e8e8e8)]">
                                            <div className="flex items-center gap-3 px-4 py-3">
                                                <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                                                    <span className="text-[14px] font-medium text-[#1a1a1a]">原生工具调用</span>
                                                    <span className="text-[11px] text-[#999] leading-snug">当前：{getNativeToolProtocolLabel(config)}</span>
                                                </span>
                                                <Toggle checked={config.enableNativeTools !== false} onChange={(v) => updateConfig(config.id, { enableNativeTools: v })} />
                                            </div>
                                            <div className="h-px bg-[#eee] mx-4" />
                                            <div className="flex items-center gap-3 px-4 py-3">
                                                <span className="flex-1 text-[14px] font-medium text-[#1a1a1a]">图像识别</span>
                                                <Toggle checked={config.enableImageRecognition} onChange={(v) => updateConfig(config.id, { enableImageRecognition: v })} />
                                            </div>
                                            <div className="h-px bg-[#eee] mx-4" />
                                            <div className="flex items-center gap-3 px-4 py-3">
                                                <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                                                    <span className="text-[14px] font-medium text-[#1a1a1a]">防胡言乱语</span>
                                                    <span className="text-[11px] text-[#999]">无用户输入时不主动生成</span>
                                                </span>
                                                <Toggle checked={config.preventEmptyGenerateRambling === true} onChange={(v) => updateConfig(config.id, { preventEmptyGenerateRambling: v })} />
                                            </div>
                                        </div>

                                        {/* ── Generation Parameters card ── */}
                                        <GenerationParamsEditor
                                            params={config.generationParams ?? { ...DEFAULT_GENERATION_PARAMS }}
                                            onChange={(params) => updateConfig(config.id, { generationParams: params })}
                                        />

                                    </>
                                )
                            })()}
                        </div>
                    </div>
                </div>
            )}

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

/* ── Generation Parameters Card (always open) ── */

type ParamDef = {
    key: keyof GenerationParams;
    label: string;
    min: number;
    max: number;
    step: number;
    minLabel: string;
    maxLabel: string;
};

const PARAM_DEFS: ParamDef[] = [
    { key: "temperature",        label: "Temperature",  min: 0,   max: 2,   step: 0.05, minLabel: "稳定保守",     maxLabel: "发散创造" },
    { key: "top_p",              label: "Top P",        min: 0,   max: 1,   step: 0.05, minLabel: "用词精准",     maxLabel: "词汇丰富" },
    { key: "top_k",              label: "Top K",        min: 0,   max: 100, step: 1,    minLabel: "用词精准",     maxLabel: "词汇丰富" },
    { key: "min_p",              label: "Min P",        min: 0,   max: 1,   step: 0.01, minLabel: "发散跳跃",     maxLabel: "逻辑连贯" },
    { key: "top_a",              label: "Top A",        min: 0,   max: 1,   step: 0.01, minLabel: "自由发散",     maxLabel: "限制胡言乱语" },
    { key: "repetition_penalty", label: "重复惩罚",     min: 1,   max: 2,   step: 0.05, minLabel: "允许重复",     maxLabel: "极力惩罚重复" },
    { key: "frequency_penalty",  label: "频率惩罚",     min: 0,   max: 2,   step: 0.05, minLabel: "自然口癖",     maxLabel: "杜绝车轱辘话" },
    { key: "presence_penalty",   label: "存在惩罚",     min: 0,   max: 2,   step: 0.05, minLabel: "聚焦当前话题", maxLabel: "积极拓展新话题" },
];

function GenerationParamsEditor({ params, onChange }: { params: GenerationParams; onChange: (p: GenerationParams) => void }) {
    const update = <K extends keyof GenerationParams>(key: K, value: GenerationParams[K]) => {
        onChange({ ...params, [key]: value });
    };
    return (
        <div className="rounded-[14px] bg-[var(--c-card,#fff)] border border-[var(--c-card-border,#e8e8e8)] flex flex-col p-[14px]">
            <div className="pb-2">
                <span className="text-[14px] font-medium text-[#1a1a1a]">生成参数</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
                {PARAM_DEFS.map(def => {
                    const val = (params[def.key] as number) ?? def.min;
                    return (
                        <div key={def.key} className="flex flex-col gap-1">
                            <div className="flex justify-between">
                                <label className="ui-slider-label">{def.label}</label>
                                <span className="ui-slider-value">{val.toFixed(def.step < 1 ? 2 : 0)}</span>
                            </div>
                            <input
                                className="ui-slider" type="range"
                                min={def.min} max={def.max} step={def.step} value={val}
                                onChange={e => update(def.key, parseFloat(e.target.value))}
                            />
                            <div className="ui-slider-hints">
                                <span className="ui-slider-hint">{def.minLabel}</span>
                                <span className="ui-slider-hint">{def.maxLabel}</span>
                            </div>
                        </div>
                    );
                })}

                <div className="flex flex-col gap-1 col-span-full">
                    <div className="flex justify-between items-center">
                        <label className="ui-slider-label">Max Tokens</label>
                        <input
                            type="number"
                            min="0"
                            step="1"
                            placeholder="自动"
                            value={params.openai_max_tokens || ""}
                            onChange={e => {
                                const raw = e.target.value;
                                const v = raw === "" ? 0 : Math.max(0, parseInt(raw) || 0);
                                update("openai_max_tokens", v);
                            }}
                            className="ui-input ts-13 px-2 py-[4px] rounded-[6px] text-right"
                            style={{ width: 92 }}
                        />
                    </div>
                    <input className="ui-slider" type="range" min="0" max="1000000" step="128" value={params.openai_max_tokens} onChange={e => update("openai_max_tokens", parseInt(e.target.value))} />
                    <div className="ui-slider-hints">
                        <span className="ui-slider-hint">自动 (推荐)</span>
                        <span className="ui-slider-hint">限制回复长度</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
