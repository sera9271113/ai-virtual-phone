"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AccountGate } from "@/components/auth/account-gate";
import { CloudBackupScheduler } from "@/components/cloud-backup-scheduler";
import { MediaMaintenanceScheduler } from "@/components/media-maintenance-scheduler";
import { DesktopShell } from "./desktop-shell";
import { LockScreen } from "./lock-screen";
import { MusicProvider } from "@/lib/music-context";
import { DEFAULT_FONT_FAMILY } from "@/lib/theme-types";
import { hydrateKvDb } from "@/lib/kv-db";
import { getThemeAssetMap, readThemeProfile, writeThemeProfile } from "@/lib/theme-storage";
import { resolveActiveIconSkins, normalizeThemeProfile, type ThemeProfile } from "@/lib/theme-types";
import { applyShellZoom, isMobileShell } from "@/lib/mobile-shell";
import { hasPendingMcpOAuthCallback } from "@/lib/tool-executor";

const TEXT = {
  loading: "\u52A0\u8F7D\u4E2D...",
};

const BUILTIN_FONT_URLS = [
  "/fonts/huiwen.woff2",
  "/fonts/huiwen.woff2",
  "/fonts/special-elite.woff2",
  "/fonts/splash/instrument-serif-regular-400.woff2",
  "/fonts/splash/instrument-serif-italic-400.woff2",
  "/fonts/splash/inter-300.woff2",
  "/fonts/splash/inter-400.woff2",
  "/fonts/splash/inter-500.woff2",
  "/fonts/splash/major-mono-display-400.woff2",
  "/fonts/splash/jetbrains-mono-300.woff2",
  "/fonts/splash/jetbrains-mono-400.woff2",
  "/fonts/interview/noto-serif-sc.woff2",
  "/fonts/interview/bodoni-moda.woff2",
  "/fonts/interview/bodoni-moda-italic.woff2",
  "/fonts/interview/eb-garamond.woff2",
  "/fonts/interview/eb-garamond-italic.woff2",
  "/fonts/interview/long-cang.woff2",
  "/fonts/interview/cinzel.woff2",
  "/fonts/interview/press-start-2p.woff2",
  "/fonts/notewall/ximai.woff2",
  "/fonts/notewall/xiaozhitiao.woff2",
  "/fonts/notewall/huiwen-upload.woff2",
  "/fonts/notewall/chen-yuluoyan-thin.woff2",
  "/fonts/game-hall/fredoka-400.woff2",
  "/fonts/game-hall/fredoka-500.woff2",
  "/fonts/game-hall/fredoka-600.woff2",
  "/fonts/game-hall/fredoka-700.woff2",
  "/fonts/game-hall/caveat-500.woff2",
  "/fonts/game-hall/caveat-700.woff2",
  "/fonts/game-hall/zen-maru-gothic-500.woff2",
  "/fonts/game-hall/zen-maru-gothic-700.woff2",
  "/fonts/game-hall/zen-maru-gothic-900.woff2",
  "/fonts/\u5B57\u4F53/MISANS-REGULAR.woff2",
  "/fonts/\u5B57\u4F53/MISANS-MEDIUM.woff2",
  "/fonts/\u5B57\u4F53/MISANS-SEMIBOLD.woff2",
] as const;

const BUILTIN_FONT_LOAD_SPECS = [
  '400 1em "Instrument Serif"',
  'italic 400 1em "Instrument Serif"',
  '300 1em "Inter"',
  '400 1em "Inter"',
  '500 1em "Inter"',
  '400 1em "Major Mono Display"',
  '300 1em "JetBrains Mono"',
  '400 1em "JetBrains Mono"',
  '400 1em "Huiwen"',
  '400 1em "Noto Serif SC"',
  '400 1em "Source Han Serif SC"',
  '400 1em "Bodoni Moda"',
  'italic 400 1em "Bodoni Moda"',
  '400 1em "EB Garamond"',
  'italic 400 1em "EB Garamond"',
  '400 1em "Long Cang"',
  '400 1em "Cinzel"',
  '400 1em "Press Start 2P"',
  '400 1em "Special Elite"',
  '400 1em "NoteWall Ximai"',
  '400 1em "NoteWall Xiaozhitiao"',
  '400 1em "NoteWall Huiwen"',
  '400 1em "Game Hall Fredoka"',
  '500 1em "Game Hall Fredoka"',
  '600 1em "Game Hall Fredoka"',
  '700 1em "Game Hall Fredoka"',
  '500 1em "Game Hall Caveat"',
  '700 1em "Game Hall Caveat"',
  '500 1em "Game Hall Zen Maru Gothic"',
  '700 1em "Game Hall Zen Maru Gothic"',
  '900 1em "Game Hall Zen Maru Gothic"',
  '400 1em "MiSans"',
  '500 1em "MiSans"',
  '600 1em "MiSans"',
] as const;

const FONT_CACHE_BATCH_SIZE = 3;
const FONT_CACHE_BATCH_DELAY_MS = 80;

type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleIdleTask(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => { };
  }

  const idleWindow = window as WindowWithIdleCallback;
  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(() => callback(), { timeout: 2400 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(callback, 600);
  return () => window.clearTimeout(handle);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function cacheFontUrl(url: string): Promise<void> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) return;
  await response.arrayBuffer();
}

async function warmBuiltinFonts(shouldStop: () => boolean): Promise<void> {
  if (typeof window === "undefined") return;

  for (let index = 0; index < BUILTIN_FONT_URLS.length; index += FONT_CACHE_BATCH_SIZE) {
    if (shouldStop()) return;
    const batch = BUILTIN_FONT_URLS.slice(index, index + FONT_CACHE_BATCH_SIZE);
    await Promise.all(batch.map((url) => cacheFontUrl(url).catch(() => undefined)));
    if (shouldStop()) return;
    await wait(FONT_CACHE_BATCH_DELAY_MS);
  }

  if (shouldStop() || !document.fonts) return;
  await Promise.all(BUILTIN_FONT_LOAD_SPECS.map((spec) => document.fonts.load(spec).catch(() => [])));
}

function LockScreenWrap({
  ready = false,
  onEnter,
  onPasswordReset,
  themeProfile,
  themeAssets,
}: {
  ready?: boolean;
  onEnter?: () => void;
  onPasswordReset?: (newPassword: string) => void;
  themeProfile?: ThemeProfile | null;
  themeAssets?: Record<string, string> | null;
}) {
  const lockWallpaperStyle = useMemo<React.CSSProperties>(() => {
    if (!themeProfile?.lockWallpaperAssetId || !themeAssets) {
      return { backgroundColor: "#e8e8e8" };
    }
    const url = themeAssets[themeProfile.lockWallpaperAssetId];
    if (!url) return { backgroundColor: "#e8e8e8" };
    const whiteMaskAlpha = Number((1 - themeProfile.lockWallpaperOpacity).toFixed(3));
    return {
      backgroundColor: "#e8e8e8",
      backgroundImage: `linear-gradient(rgba(255,255,255,${whiteMaskAlpha}),rgba(255,255,255,${whiteMaskAlpha})), url("${url}")`,
      opacity: 1,
      filter: themeProfile.lockWallpaperBlur ? `blur(${themeProfile.lockWallpaperBlur}px)` : undefined,
      inset: themeProfile.lockWallpaperBlur ? `${-2 * themeProfile.lockWallpaperBlur}px` : undefined,
      backgroundSize: themeProfile.lockWallpaperScale !== 100 ? `${themeProfile.lockWallpaperScale}%` : "cover",
      backgroundPosition: `${themeProfile.lockWallpaperX}% ${themeProfile.lockWallpaperY}%`,
    };
  }, [themeProfile, themeAssets]);

  // Resolve custom font for lock screen (before DesktopShell mounts)
  const fontDataUrl = themeProfile?.fontAssetId && themeAssets ? themeAssets[themeProfile.fontAssetId] ?? null : null;
  const lockFontFamily = useMemo(() => {
    const base = themeProfile?.fontFamily || DEFAULT_FONT_FAMILY;
    return fontDataUrl ? `"AIVirtualPhoneUserFont", ${base}` : base;
  }, [themeProfile?.fontFamily, fontDataUrl]);

  // Always render the lock screen — even before hydration, show a static clock
  // so mobile users see something immediately (hydration may take a moment).
  return (
    <main className="app-root">
      {fontDataUrl && (
        <style>{`@font-face{font-family:"AIVirtualPhoneUserFont";src:url("${fontDataUrl}");font-display:swap;}`}</style>
      )}
      <section className="phone-shell-wrap" aria-label="Lock Screen">
        <div className="phone-case">
          <div className="phone-frame">
            <div className="phone-shell" style={{ padding: 0, background: "transparent", "--app-font-family": lockFontFamily } as React.CSSProperties}>
              <LockScreen
                onUnlock={() => onEnter?.()}
                onPasswordReset={onPasswordReset}
                wallpaperStyle={lockWallpaperStyle}
                lockPassword={themeProfile?.lockPassword ?? ""}
                lockCustomText={themeProfile?.lockCustomText ?? "floatphone"}
                lockThemeMode={themeProfile?.lockThemeMode ?? "light"}
              />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

type PreparedDesktopTheme = {
  profile: ThemeProfile;
  assets: Record<string, string>;
};

function collectFirstPaintThemeAssetIds(profile: ThemeProfile): string[] {
  const ids = [
    profile.wallpaperAssetId,
    profile.lockWallpaperAssetId,
    profile.fontAssetId,
    profile.dockSkinAssetId,
    ...Object.values(resolveActiveIconSkins(profile))
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(ids));
}

function preloadImageDataUrl(url: string): Promise<void> {
  if (typeof window === "undefined" || !url.startsWith("data:image/")) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const image = new Image();
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (typeof image.decode === "function") {
        void image.decode().catch(() => undefined).finally(resolve);
        return;
      }
      resolve();
    };
    image.onload = finish;
    image.onerror = finish;
    image.src = url;
    if (image.complete) {
      finish();
    }
  });
}

async function prepareDesktopThemeForFirstPaint(): Promise<PreparedDesktopTheme> {
  const profile = readThemeProfile();
  const assetIds = collectFirstPaintThemeAssetIds(profile);
  const assets = assetIds.length ? await getThemeAssetMap(assetIds) : {};
  await Promise.all(Object.values(assets).map(preloadImageDataUrl));
  return { profile, assets };
}

export function MainApp() {
  const [preparedDesktopTheme, setPreparedDesktopTheme] = useState<PreparedDesktopTheme | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [splashDismissed, setSplashDismissed] = useState(false);
  // Smooth unlock transition: keep lock screen mounted during fade-out
  const [unlockPhase, setUnlockPhase] = useState<"locked" | "fading" | "done">("locked");
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleUnlock = useCallback(() => {
    setSplashDismissed(true);
    setUnlockPhase("fading");
    unlockTimerRef.current = setTimeout(() => setUnlockPhase("done"), 500);
  }, []);

  const handleLockPasswordReset = useCallback((newPassword: string) => {
    setPreparedDesktopTheme((prev) => {
      const baseProfile = prev?.profile ?? readThemeProfile();
      const nextProfile = normalizeThemeProfile({ ...baseProfile, lockPassword: newPassword });
      try {
        const maybePromise = writeThemeProfile(nextProfile) as unknown;
        if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === "function") {
          (maybePromise as Promise<unknown>).catch((error) => {
            console.warn("[MainApp] failed to persist lock password reset:", error);
          });
        }
      } catch (error) {
        console.warn("[MainApp] failed to persist lock password reset:", error);
      }
      return { profile: nextProfile, assets: prev?.assets ?? {} };
    });
  }, []);

  useEffect(() => () => { if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current); }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await hydrateKvDb();
      if (cancelled) return;

      let nextPreparedTheme: PreparedDesktopTheme | null = null;
      try {
        nextPreparedTheme = await prepareDesktopThemeForFirstPaint();
      } catch (error) {
        console.warn("[MainApp] desktop theme preload failed:", error);
      }

      if (cancelled) return;
      setPreparedDesktopTheme(nextPreparedTheme);
      setHydrated(true);
      if (hasPendingMcpOAuthCallback()) {
        setSplashDismissed(true);
      }
    })();

    // 安卓全屏兜底：点击屏幕进入全屏模式（iOS 不支持此 API，会自动忽略）
    const isMobile = isMobileShell();
    // Edge 改用 minimal-ui 保留原生状态栏，不能再被强制全屏顶掉（仅 Edge 跳过，其它浏览器照旧）
    const isEdge = /Edg/i.test(navigator.userAgent);
    if (!isMobile || isEdge) return () => {
      cancelled = true;
    };

    // [TEST 分支验证] 点击强制全屏已完全禁用——验证 Via 强制横屏根因
    return () => {
      cancelled = true;
    };
  }, []);

  // 大屏档整屏缩放：首帧由 layout.tsx 内联脚本算好，这里只负责旋转/分屏后重算。
  // 只在宽度变化时重算——键盘弹出只改高度，打字过程中缩放不能跳。
  useEffect(() => {
    if (typeof window === "undefined") return;
    applyShellZoom();
    let lastWidth = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      applyShellZoom();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <AccountGate>
      {/* Desktop shell — always render once dismissed so it can hydrate underneath */}
      {splashDismissed && (
        <main className="app-root">
          <MusicProvider>
            <DesktopShell
              initialThemeProfile={preparedDesktopTheme?.profile}
              initialThemeAssets={preparedDesktopTheme?.assets}
            />
            <CloudBackupScheduler />
            <MediaMaintenanceScheduler />
          </MusicProvider>
        </main>
      )}
      {/* Lock screen overlay — fades out smoothly on top */}
      {unlockPhase !== "done" && (
        <div style={{
          position: splashDismissed ? "absolute" : "relative",
          inset: 0,
          zIndex: splashDismissed ? 10000 : undefined,
          opacity: unlockPhase === "fading" ? 0 : 1,
          transition: unlockPhase === "fading" ? "opacity 0.45s cubic-bezier(0.4,0,0.2,1)" : undefined,
          willChange: "opacity",
          pointerEvents: unlockPhase === "fading" ? "none" : undefined,
        }}>
          <LockScreenWrap
            ready={hydrated}
            onEnter={handleUnlock}
            onPasswordReset={handleLockPasswordReset}
            themeProfile={preparedDesktopTheme?.profile}
            themeAssets={preparedDesktopTheme?.assets}
          />
        </div>
      )}
    </AccountGate>
  );
}
