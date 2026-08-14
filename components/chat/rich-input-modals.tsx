"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { MapPin } from "lucide-react";
import { CallSttWarningDialog, hideCallSttWarningPermanently, isCallSttWarningHidden } from "./call-stt-warning-dialog";
import { isAndroidBrowser } from "./voice-input-platform";

// ── Photo Input Modal ─────────────────────────────

interface PhotoInputModalProps {
    onSend: (description: string, imageDataUrl?: string) => void;
    onClose: () => void;
}

export function PhotoInputModal({ onSend, onClose }: PhotoInputModalProps) {
    const [desc, setDesc] = useState("");
    const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            setImageDataUrl(reader.result as string);
        };
        reader.readAsDataURL(file);
    };

    const canSend = !!imageDataUrl;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                onClick={e => e.stopPropagation()}
                className="modal-dialog chat-compose-modal"
            >
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">发送照片</div>
                <div
                    className="w-full rounded-xl flex items-center justify-center chat-modal-mono-box overflow-hidden cursor-pointer relative"
                    style={{ minHeight: imageDataUrl ? "auto" : "120px" }}
                    onClick={() => fileInputRef.current?.click()}
                >
                    {imageDataUrl ? (
                        <img
                            src={imageDataUrl}
                            alt="preview"
                            className="w-full h-auto rounded-xl"
                            style={{ maxHeight: "240px", objectFit: "contain" }}
                        />
                    ) : (
                        <div className="flex flex-col items-center gap-2 py-6">
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--c-icon)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                            <span className="ts-12 text-[var(--c-icon)]">点击上传图片</span>
                        </div>
                    )}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleFileChange}
                    />
                </div>
                <div className="flex gap-3 w-full">
                    <button
                        onClick={onClose}
                        className="ui-btn ui-btn-media-outline flex-1"
                    >取消</button>
                    <button
                        onClick={() => { if (canSend) onSend(desc.trim(), imageDataUrl!); }}
                        disabled={!canSend}
                        className="ui-btn ui-btn-media-primary flex-1"
                    >发送</button>
                </div>
            </div>
        </div>
    );
}

// ── Red Packet Modal ─────────────────────────────

interface RedPacketModalProps {
    mode: "red_packet" | "transfer";
    isGroup?: boolean;
    onSend: (amount: number, label: string, count?: number) => void;
    onClose: () => void;
}

export function RedPacketModal({ mode, isGroup, onSend, onClose }: RedPacketModalProps) {
    const [amount, setAmount] = useState("");
    const [label, setLabel] = useState("");
    const [count, setCount] = useState("1");

    const isRedPacket = mode === "red_packet";
    const title = isRedPacket ? "发红包" : "转账";
    const defaultLabel = isRedPacket ? "恭喜发财，大吉大利" : "";

    const handleSend = () => {
        const num = parseFloat(amount);
        if (!num || num <= 0) return;
        const cnt = isRedPacket ? (isGroup ? Math.max(1, parseInt(count, 10) || 1) : 1) : undefined;
        onSend(num, label.trim() || defaultLabel, cnt);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog chat-compose-money-modal">
                <div className="chat-compose-money-type-label">{title}</div>
                <div className="chat-compose-money-field">
                    <div className="chat-compose-money-field-label">金额</div>
                    <div className="chat-compose-money-amount-row">
                        <span className="chat-compose-money-currency">¥</span>
                        <input
                            value={amount}
                            onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                            placeholder="0.00"
                            type="text"
                            inputMode="decimal"
                            className="chat-compose-money-amount-input"
                        />
                    </div>
                </div>
                {isRedPacket && isGroup && (
                    <div>
                        <div className="chat-compose-money-field-label">个数</div>
                        <input
                            value={count}
                            onChange={e => setCount(e.target.value.replace(/[^0-9]/g, ""))}
                            placeholder="1"
                            type="text"
                            inputMode="numeric"
                            className="ui-input w-full"
                        />
                    </div>
                )}
                <div className="chat-compose-money-field">
                    <div className="chat-compose-money-field-label">
                        {isRedPacket ? "留言" : "备注"}
                    </div>
                    <input
                        value={label}
                        onChange={e => setLabel(e.target.value)}
                        placeholder={defaultLabel || "添加备注"}
                        className="ui-input w-full"
                    />
                </div>
                <div className="flex gap-3 w-full">
                    <button
                        onClick={onClose}
                        className="ui-btn ui-btn-media-outline flex-1"
                    >取消</button>
                    <button
                        onClick={handleSend}
                        disabled={!parseFloat(amount)}
                        className="ui-btn ui-btn-media-primary flex-1"
                    >{isRedPacket ? "塞入红包" : "确认转账"}</button>
                </div>
            </div>
        </div>
    );
}

// ── Location Input Modal ─────────────────────────────

interface LocationInputModalProps {
    onSend: (locationName: string) => void;
    onClose: () => void;
}

export function LocationInputModal({ onSend, onClose }: LocationInputModalProps) {
    const [loc, setLoc] = useState("");

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                onClick={e => e.stopPropagation()}
                className="modal-dialog chat-compose-modal"
            >
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">分享位置</div>
                <div
                    className="w-full h-[100px] rounded-xl flex items-center justify-center relative chat-modal-mono-box"
                >
                    <MapPin size={36} strokeWidth={1.5} color="var(--c-icon)" />
                </div>
                <input
                    value={loc}
                    onChange={e => setLoc(e.target.value)}
                    placeholder="输入地点名称..."
                    className="ui-input w-full"
                    onKeyDown={e => { if (e.key === "Enter" && loc.trim()) onSend(loc.trim()); }}
                />
                <div className="flex gap-3 w-full">
                    <button
                        onClick={onClose}
                        className="ui-btn ui-btn-media-outline flex-1"
                    >取消</button>
                    <button
                        onClick={() => { if (loc.trim()) onSend(loc.trim()); }}
                        disabled={!loc.trim()}
                        className="ui-btn ui-btn-media-primary flex-1"
                    >发送</button>
                </div>
            </div>
        </div>
    );
}

// ── Text Photo Modal ─────────────────────────────

interface TextPhotoModalProps {
    onSend: (text: string) => void;
    onClose: () => void;
}

export function TextPhotoModal({ onSend, onClose }: TextPhotoModalProps) {
    const [text, setText] = useState("");

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog chat-compose-modal">
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">文字图片</div>
                <div className="w-full h-[100px] rounded-xl flex items-center justify-center chat-modal-mono-box">
                    <span className="ts-13 text-[var(--c-text)] opacity-60 px-4 text-center leading-relaxed">
                        {text.trim() || "输入文字，生成图片"}
                    </span>
                </div>
                <textarea
                    value={text}
                    onChange={e => setText(e.target.value)}
                    placeholder="描述图片内容..."
                    className="ui-input w-full"
                    rows={3}
                    style={{ resize: "none" }}
                />
                <div className="flex gap-3 w-full">
                    <button onClick={onClose} className="ui-btn ui-btn-media-outline flex-1">取消</button>
                    <button
                        onClick={() => { if (text.trim()) onSend(text.trim()); }}
                        disabled={!text.trim()}
                        className="ui-btn ui-btn-media-primary flex-1"
                    >发送</button>
                </div>
            </div>
        </div>
    );
}

// ── System Instruction Modal ─────────────────────────────

interface SystemInstructionModalProps {
    onSend: (text: string) => void;
    onClose: () => void;
}

export function SystemInstructionModal({ onSend, onClose }: SystemInstructionModalProps) {
    const [text, setText] = useState("");
    const trimmed = text.trim();

    const submit = () => {
        if (!trimmed) return;
        onSend(trimmed);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog chat-compose-modal">
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">系统指令注入</div>
                <label className="w-full flex flex-col gap-2">
                    <span className="menu-label">指令内容</span>
                    <textarea
                        value={text}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => {
                            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                                e.preventDefault();
                                submit();
                            }
                        }}
                        aria-label="系统指令内容"
                        className="ui-input w-full min-h-[160px]"
                        rows={6}
                        style={{ resize: "vertical" }}
                    />
                </label>
                <div className="flex gap-3 w-full">
                    <button onClick={onClose} className="ui-btn ui-btn-media-outline flex-1">取消</button>
                    <button
                        onClick={submit}
                        disabled={!trimmed}
                        className="ui-btn ui-btn-media-primary flex-1"
                    >注入</button>
                </div>
            </div>
        </div>
    );
}

// ── Voice Record Modal ─────────────────────────────

interface VoiceRecordModalProps {
    characterId: string;
    onSend: (text: string, audioDataUrl?: string) => void;
    onClose: () => void;
}

export function VoiceRecordModal({ characterId, onSend, onClose }: VoiceRecordModalProps) {
    const androidTextInputOnlyRef = useRef(isAndroidBrowser());
    const androidTextInputOnly = androidTextInputOnlyRef.current;
    const [state, setState] = useState<"idle" | "recording" | "processing" | "done">("idle");
    const [inputMode, setInputMode] = useState<"voice" | "text">(() => androidTextInputOnly ? "text" : "voice");
    const [interim, setInterim] = useState("");
    const [finalText, setFinalText] = useState("");
    const [manualText, setManualText] = useState("");
    const [audioDataUrl, setAudioDataUrl] = useState<string | null>(null);
    const [showSttWarning, setShowSttWarning] = useState(false);
    const sttRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);
    const gotFinalRef = useRef(false);

    const showSttCompatibilityWarning = useCallback(() => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (isCallSttWarningHidden()) {
            setInputMode("text");
            return;
        }
        setShowSttWarning(true);
    }, [androidTextInputOnly]);

    const handleNeverShowSttWarning = useCallback(() => {
        hideCallSttWarningPermanently();
        setShowSttWarning(false);
        setInputMode("text");
    }, []);

    const startRecording = useCallback(async () => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        setState("idle");
        setInterim("");
        setFinalText("");
        setAudioDataUrl(null);
        chunksRef.current = [];
        gotFinalRef.current = false;

        // Start STT (browser Web Speech API) before opening the mic. Unsupported
        // Android browsers should show the fallback prompt without flashing recording UI.
        const { createSTTSession } = await import("@/lib/stt-service");
        const stt = createSTTSession({
            onInterim: (t) => setInterim(t),
            onFinal: (t) => { gotFinalRef.current = true; setFinalText(t); setState("done"); recorderRef.current?.stop(); },
            onError: (e) => { setInterim(e); setState("idle"); recorderRef.current?.stop(); showSttCompatibilityWarning(); },
            onEnd: () => { if (!gotFinalRef.current) { setState("idle"); recorderRef.current?.stop(); } },
            onNoSpeech: () => { setInterim("未检测到语音"); setState("idle"); recorderRef.current?.stop(); showSttCompatibilityWarning(); },
        }, "zh-CN");

        if (!stt.isSupported) {
            showSttCompatibilityWarning();
            return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            setInterim("无法访问麦克风");
            showSttCompatibilityWarning();
            return;
        }

        let stream: MediaStream | null = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            setInterim("无法访问麦克风");
            showSttCompatibilityWarning();
            return;
        }
        streamRef.current = stream;

        // Start recorder
        const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm" });
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
        recorder.onstop = () => {
            stream!.getTracks().forEach(t => t.stop());
            if (chunksRef.current.length > 0) {
                const blob = new Blob(chunksRef.current, { type: "audio/webm" });
                const reader = new FileReader();
                reader.onload = () => setAudioDataUrl(reader.result as string);
                reader.readAsDataURL(blob);
            }
        };
        recorder.start();

        sttRef.current = stt;
        setState("recording");
        setInterim("正在听...");
        stt.start();
    }, [androidTextInputOnly, characterId, showSttCompatibilityWarning]);

    const stopRecording = () => {
        sttRef.current?.stop();
        recorderRef.current?.stop();
        setState("processing");
        setInterim("识别中...");
    };

    useEffect(() => () => { sttRef.current?.abort(); recorderRef.current?.stop(); streamRef.current?.getTracks().forEach(t => t.stop()); }, []);

    const switchInputMode = () => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (inputMode === "voice") {
            sttRef.current?.abort();
            if (recorderRef.current && recorderRef.current.state !== "inactive") {
                recorderRef.current.stop();
            }
            streamRef.current?.getTracks().forEach(t => t.stop());
            setState("idle");
            setInterim("");
            setInputMode("text");
        } else {
            setInputMode("voice");
        }
    };

    const canSend = inputMode === "text" ? !!manualText.trim() : state === "done" && !!finalText.trim();

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog chat-compose-modal relative">
                {!androidTextInputOnly && (
                    <button
                        type="button"
                        className="voice-input-mode-toggle"
                        onClick={switchInputMode}
                        aria-label={inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                        title={inputMode === "voice" ? "文字输入" : "语音输入"}
                    >
                        {inputMode === "voice" ? "Aa" : (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                <line x1="12" y1="19" x2="12" y2="22" />
                            </svg>
                        )}
                    </button>
                )}
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">语音消息</div>
                <div className="w-full min-h-[80px] flex flex-col items-center justify-center gap-3 py-4">
                    {inputMode === "text" ? (
                        <textarea
                            value={manualText}
                            onChange={e => setManualText(e.target.value)}
                            className="voice-text-mode-input"
                            placeholder="输入语音条内容..."
                            rows={3}
                        />
                    ) : state === "idle" && (
                        <button onClick={startRecording} className="w-[64px] h-[64px] rounded-full bg-[var(--c-success)] flex items-center justify-center">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            </svg>
                        </button>
                    )}
                    {state === "recording" && (
                        <button onClick={stopRecording} className="w-[64px] h-[64px] rounded-full bg-[var(--c-danger)] flex items-center justify-center" style={{ animation: "voicecall-pulse 1.5s ease-in-out infinite" }}>
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                        </button>
                    )}
                    {state === "processing" && (
                        <div className="w-[64px] h-[64px] rounded-full bg-[var(--c-input)] flex items-center justify-center">
                            <svg width="24" height="24" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="var(--c-icon)" strokeWidth="2"><path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" /></svg>
                        </div>
                    )}
                    {state === "done" && (
                        <div className="ts-14 text-[var(--c-text)] text-center px-4 leading-relaxed">{finalText}</div>
                    )}
                    {(state === "recording" || state === "processing") && (
                        <span className="ts-13 text-[var(--c-icon)]">{interim || "点击停止录音"}</span>
                    )}
                </div>
                <div className="flex gap-3 w-full">
                    <button onClick={onClose} className="ui-btn ui-btn-media-outline flex-1">取消</button>
                    <button
                        onClick={() => {
                            if (!canSend) return;
                            if (inputMode === "text") onSend(manualText.trim());
                            else onSend(finalText.trim(), audioDataUrl || undefined);
                        }}
                        disabled={!canSend}
                        className="ui-btn ui-btn-media-primary flex-1"
                    >发送</button>
                </div>
                {!androidTextInputOnly && showSttWarning && (
                    <CallSttWarningDialog
                        title="语音消息提示"
                        message="当前浏览器可能不支持语音识别、系统麦克风权限未开启，或麦克风没有输入。你可以点击右上角 Aa，改用文字输入来发送语音条内容。"
                        onClose={() => setShowSttWarning(false)}
                        onNeverShow={handleNeverShowSttWarning}
                    />
                )}
            </div>
        </div>
    );
}
