"use client";

// components/chat-plugin-bootstrap.tsx
// 聊天插件运行时启动引导：应用挂载后加载全部启用插件。
// 放在根布局，保证插件的 hook 在用户进入聊天前就已注册。

import { useEffect, useRef, useState } from "react";
import { CHAT_PLUGIN_TOAST_EVENT, getChatPluginRuntime } from "@/lib/chat-plugin-runtime";

export function ChatPluginBootstrap() {
    const [toastText, setToastText] = useState<string | null>(null);
    const toastIdRef = useRef<string | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => {
        void getChatPluginRuntime().ensureStarted();
    }, []);

    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent<{ id?: string; text: string; durationMs?: number; close?: boolean }>).detail || { text: "" };
            if (detail.close) {
                if (toastIdRef.current === detail.id) {
                    clearTimeout(toastTimerRef.current);
                    setToastText(null);
                    toastIdRef.current = null;
                }
                return;
            }
            if (!detail.text) return;
            clearTimeout(toastTimerRef.current);
            toastIdRef.current = detail.id ?? null;
            setToastText(detail.text);
            if (detail.durationMs === undefined || detail.durationMs > 0) {
                toastTimerRef.current = setTimeout(() => {
                    setToastText(null);
                    toastIdRef.current = null;
                }, detail.durationMs ?? 2400);
            }
        };
        window.addEventListener(CHAT_PLUGIN_TOAST_EVENT, handler);
        return () => {
            window.removeEventListener(CHAT_PLUGIN_TOAST_EVENT, handler);
            clearTimeout(toastTimerRef.current);
        };
    }, []);

    if (!toastText) return null;
    return (
        <div className="chat-plugin-toast-host" role="status">
            <div className="wp-toast">{toastText}</div>
        </div>
    );
}
