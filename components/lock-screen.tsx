"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Camera, ScanLine } from "lucide-react";

/* ═══════════════════════════════════════════
   iOS 26-style Lock Screen
   ═══════════════════════════════════════════ */

type LockScreenProps = {
  onUnlock: () => void;
  wallpaperStyle?: CSSProperties;
  lockPassword?: string;
  /** Called when the user taps "找回密码" and the password is reset to 1234 */
  onPasswordReset?: (newPassword: string) => void;
  /** Custom text shown at bottom center (replaces swipe pill) */
  lockCustomText?: string;
  /** "dark" = dark bg → light glass; "light" = light bg → dark glass */
  lockThemeMode?: "dark" | "light";
};

function padZero(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatDate(d: Date): string {
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()]}`;
}

export function LockScreen({
  onUnlock,
  wallpaperStyle,
  lockPassword = "",
  onPasswordReset,
  lockCustomText = "",
  lockThemeMode = "dark",
}: LockScreenProps) {
  const [now, setNow] = useState(() => new Date());
  const [swipeY, setSwipeY] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startYRef = useRef(0);

  const [showPasscode, setShowPasscode] = useState(false);
  const [passcodeEntering, setPasscodeEntering] = useState(false); // fade-in animation
  const [passcode, setPasscode] = useState("");
  const [shake, setShake] = useState(false);
  const [unlockFading, setUnlockFading] = useState(false); // success fade-out
  const [effectivePassword, setEffectivePassword] = useState(lockPassword);
  const [resetNotice, setResetNotice] = useState(false);
  const resetNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setEffectivePassword(lockPassword);
  }, [lockPassword]);

  useEffect(() => () => { if (resetNoticeTimerRef.current) clearTimeout(resetNoticeTimerRef.current); }, []);

  const handleForgotPassword = useCallback(() => {
    setEffectivePassword("1234");
    setPasscode("");
    setShake(false);
    onPasswordReset?.("1234");
    setResetNotice(true);
    if (resetNoticeTimerRef.current) clearTimeout(resetNoticeTimerRef.current);
    resetNoticeTimerRef.current = setTimeout(() => setResetNotice(false), 2000);
  }, [onPasswordReset]);

  // Light mode = dark glass on light bg; Dark mode = light glass on dark bg
  const isDarkBg = lockThemeMode === "dark";
  const glass = isDarkBg
    ? { text: "rgba(255,255,255,0.85)", textStrong: "rgba(255,255,255,0.78)", glass: "rgba(255,255,255,0.42)", glassBorder: "transparent", dotBorder: "rgba(255,255,255,0.65)", dotFill: "rgba(255,255,255,0.92)", shadow: "rgba(0,0,0,0.22)", shadowStrong: "rgba(0,0,0,0.15)", stroke: "rgba(255,255,255,0.35)", cancel: "rgba(255,255,255,0.7)", hi: "rgba(255,255,255,0.55)", glow: "rgba(255,255,255,0.16)", btnShadow: "none", iconColor: "rgba(255,255,255,0.85)", numColor: "rgba(255,255,255,0.85)" }
    : { text: "rgba(60,60,70,0.7)", textStrong: "rgba(60,60,70,0.6)", glass: "rgba(200,200,210,0.40)", glassBorder: "transparent", dotBorder: "rgba(60,60,70,0.4)", dotFill: "rgba(60,60,70,0.65)", shadow: "rgba(0,0,0,0.08)", shadowStrong: "rgba(0,0,0,0.05)", stroke: "rgba(255,255,255,0.45)", cancel: "rgba(60,60,70,0.5)", hi: "rgba(255,255,255,0.7)", glow: "rgba(255,255,255,0.14)", btnShadow: "none", iconColor: "rgba(120,120,130,0.7)", numColor: "rgba(120,120,130,0.75)" };


  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const timeStr = `${padZero(now.getHours())}:${padZero(now.getMinutes())}`;
  const dateStr = formatDate(now);

  // Swipe
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (showPasscode) return;
    startYRef.current = e.clientY;
    setSwiping(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [showPasscode]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!swiping) return;
    setSwipeY(Math.max(0, startYRef.current - e.clientY));
  }, [swiping]);

  const handlePointerUp = useCallback(() => {
    if (!swiping) return;
    setSwiping(false);
    if (swipeY > 100) {
      if (lockPassword) {
        setPasscodeEntering(true);
        setShowPasscode(true);
        setPasscode("");
        setTimeout(() => setPasscodeEntering(false), 20);
      } else {
        onUnlock();
      }
    }
    setSwipeY(0);
  }, [swiping, swipeY, lockPassword, onUnlock]);

  // Passcode – fixed 4 digits
  const handlePasscodeDigit = useCallback((digit: string) => {
    if (passcode.length >= 4) return;
    const next = passcode + digit;
    setPasscode(next);
    if (next.length === 4) {
      if (next === effectivePassword) {
        setUnlockFading(true);
        setTimeout(() => onUnlock(), 350);
      } else {
        setShake(true);
        setTimeout(() => { setShake(false); setPasscode(""); }, 500);
      }
    }
  }, [passcode, effectivePassword, onUnlock]);



  const swipeProgress = Math.min(swipeY / 150, 1);
  const contentOpacity = 1 - swipeProgress * 0.5;

  const bgStyle = useMemo<CSSProperties>(() => {
    if (wallpaperStyle && wallpaperStyle.backgroundImage) {
      return { ...wallpaperStyle, position: "absolute", inset: 0, zIndex: 0 };
    }
    return { position: "absolute", inset: 0, zIndex: 0, backgroundColor: "#e8e8e8" };
  }, [wallpaperStyle]);

  const cssVars = {
    "--lk-text": glass.text,
    "--lk-text-strong": glass.textStrong,
    "--lk-glass": glass.glass,
    "--lk-glass-border": glass.glassBorder,
    "--lk-dot-border": glass.dotBorder,
    "--lk-dot-fill": glass.dotFill,
    "--lk-shadow": glass.shadow,
    "--lk-shadow-strong": glass.shadowStrong,
    "--lk-stroke": glass.stroke,
    "--lk-cancel": glass.cancel,
    "--lk-hi": glass.hi,
    "--lk-glow": glass.glow,
    "--lk-btn-shadow": glass.btnShadow,
    "--lk-icon-color": glass.iconColor,
    "--lk-num-color": glass.numColor,
  } as CSSProperties;

  // ── Passcode screen ──
  if (showPasscode) {
    return (
      <div className="lk-root" style={{ touchAction: "none", ...cssVars }}>
        <div style={bgStyle} />
        <div className={`lk-passcode-page${passcodeEntering ? "" : " lk-passcode-enter"}${unlockFading ? " lk-unlock-fade" : ""}`}>
          <div className="lk-passcode-center">
            <p className="lk-passcode-title">输入密码</p>
            <div className={`lk-dots${shake ? " lk-shake" : ""}`}>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={`lk-dot${i < passcode.length ? " lk-dot-on" : ""}`} />
              ))}
            </div>
            <div className="lk-numpad">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, null, 0, null].map((k, i) => (
                <button
                  key={i}
                  type="button"
                  className={`lk-numpad-btn${k === null ? " lk-numpad-empty" : ""}`}
                  disabled={k === null}
                  onClick={() => {
                    if (k !== null) handlePasscodeDigit(String(k));
                  }}
                >
                  {k === null ? "" : k}
                </button>
              ))}
            </div>
          </div>
          {/* Find password — bottom left, parallel with cancel/delete on bottom right */}
          <button
            type="button"
            className="lk-forgot-btn"
            onClick={handleForgotPassword}
          >
            找回密码
          </button>
          {resetNotice && <div className="lk-reset-toast">密码已重置为 1234</div>}
          {/* Cancel / delete: bottom right */}
          <button
            type="button"
            className="lk-cancel-btn"
            onClick={() => {
              if (passcode.length > 0) {
                setPasscode((p) => p.slice(0, -1));
              } else {
                setShowPasscode(false);
              }
            }}
          >
            {passcode.length > 0 ? "删除" : "取消"}
          </button>
        </div>
        <style>{LOCK_CSS}</style>
      </div>
    );
  }

  // ── Main lock screen ──
  return (
    <div
      className="lk-root"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ touchAction: "none", ...cssVars }}
    >
      <div style={bgStyle} />
      <div className="lk-main" style={{ opacity: contentOpacity, transform: `translateY(${-swipeY * 0.3}px)` }}>
        <div className="lk-datetime">
          <p className="lk-date">{dateStr}</p>
          <p className="lk-time">{timeStr}</p>
        </div>
      </div>

      {/* Bottom row */}
      <div className="lk-bottom-row" style={{ opacity: contentOpacity, transform: `translateY(${-swipeY * 0.15}px)` }}>
        <button type="button" className="lk-circle" aria-label="扫一扫">
          <ScanLine size={22} strokeWidth={1.6} />
        </button>
        <span className="lk-custom-text">{lockCustomText || ""}</span>
        <button type="button" className="lk-circle" aria-label="相机">
          <Camera size={22} strokeWidth={1.6} />
        </button>
      </div>

      <style>{LOCK_CSS}</style>
    </div>
  );
}

const LOCK_CSS = `
/* ── Root ── */
.lk-root {
  position: absolute; inset: 0; z-index: 9999;
  overflow: hidden; display: flex; flex-direction: column;
  user-select: none; -webkit-user-select: none;
  font-family: var(--app-font-family, -apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "SF Pro Display", "Inter", sans-serif);
}

/* ── SVG filter for Liquid Glass refraction + chromatic aberration ── */
.lk-root svg.lk-filters { position: absolute; width: 0; height: 0; pointer-events: none; }

/* ── Main lock screen ── */
.lk-main {
  position: relative; z-index: 1; flex: 1;
  display: flex; flex-direction: column; align-items: center;
  padding-top: calc(102px * var(--app-text-scale, 1));
}

.lk-datetime { display: flex; flex-direction: column; align-items: center; text-align: center; }

/* ── Date / time ── 
   Liquid Glass style: text is semi-transparent, letting the real wallpaper
   color bleed through. No fake gradient — just the wallpaper's own hue. */
.lk-date {
  display: block;
  font-size: calc(22px * var(--app-text-scale, 1));
  font-weight: 600;
  font-family: var(--app-font-family, inherit);
  margin: 0 0 calc(3px * var(--app-text-scale, 1)) 0;
  padding: calc(2px * var(--app-text-scale, 1)) calc(8px * var(--app-text-scale, 1));
  letter-spacing: 0.8px;
  color: var(--lk-text);
  -webkit-text-fill-color: var(--lk-text);
  background: transparent;
  text-shadow: none;
}

.lk-time {
  display: block;
  font-size: calc(94px * var(--app-text-scale, 1));
  font-weight: 800;
  font-family: var(--app-font-family, inherit);
  margin: 0; padding: 0; line-height: 0.95;
  letter-spacing: 0.06em;
  color: var(--lk-text);
  -webkit-text-fill-color: var(--lk-text);
  background: transparent;
  text-shadow: none;
}

/* ── Bottom row: circle — text — circle ── */
.lk-bottom-row {
  position: relative; z-index: 1;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 calc(28px * var(--app-text-scale, 1));
  padding-bottom: calc(20px * var(--app-text-scale, 1));
}

.lk-custom-text {
  font-size: calc(13px * var(--app-text-scale, 1));
  font-weight: 500;
  color: var(--lk-text);
  letter-spacing: 0.3px;
  text-align: center;
  flex: 1;
  min-height: calc(48px * var(--app-text-scale, 1));
  display: flex; align-items: center; justify-content: center;
}

/* ═══════════════════════════════════════════
   Liquid Glass — 7 layers applied via CSS
   ═══════════════════════════════════════════
   1. Background blur     → backdrop-filter: blur()
   2. Shape (SDF)         → border-radius (CSS approx)
   3. Tint                → semi-transparent background
   4. Refraction          → backdrop-filter: blur() bends bg
   5. Specular highlight  → inset top highlight gradient
   6. Chromatic aberration→ subtle colored edge shadows
   7. Shadow              → soft outer shadow for float
   ═══════════════════════════════════════════ */

/* ── Bottom circle buttons (flashlight / camera) ── */
.lk-circle {
  position: relative;
  width: calc(48px * var(--app-text-scale, 1));
  height: calc(48px * var(--app-text-scale, 1));
  border-radius: 50%;
  border: none;
  /* Layer 3: Tint */
  background: var(--lk-glass);
  /* Layer 1+4: Background blur + refraction distortion */
  backdrop-filter: blur(80px) saturate(1.6) brightness(1.05);
  -webkit-backdrop-filter: blur(80px) saturate(1.6) brightness(1.05);
  color: var(--lk-icon-color);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
  /* Layer 5: Specular highlight (top bright edge) 
     Layer 6: Chromatic aberration (subtle colored rim)
     Layer 7: Shadow (soft outer glow for depth) */
  box-shadow: none;
  flex-shrink: 0;
}
.lk-circle::before { display: none; }
.lk-circle svg {
  position: relative; z-index: 1;
  filter: drop-shadow(0 0.5px 1px var(--lk-shadow));
}
.lk-circle:active { background: rgba(255,255,255,0.25); transform: scale(0.94); }

/* ── Passcode page ── */
.lk-passcode-page {
  position: relative; z-index: 1; flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}

.lk-passcode-center {
  display: flex; flex-direction: column; align-items: center;
  gap: calc(18px * var(--app-text-scale, 1));
}

.lk-passcode-title {
  font-size: calc(18px * var(--app-text-scale, 1));
  font-weight: 600;
  font-family: var(--app-font-family, inherit);
  color: var(--lk-text);
  margin: 0;
  text-shadow: none;
}

.lk-dots {
  display: flex;
  gap: calc(16px * var(--app-text-scale, 1));
}

.lk-dot {
  width: calc(13px * var(--app-text-scale, 1));
  height: calc(13px * var(--app-text-scale, 1));
  border-radius: 50%;
  border: calc(1.5px * var(--app-text-scale, 1)) solid var(--lk-dot-border);
  background: transparent;
  transition: background 0.12s, border-color 0.12s;
}
.lk-dot-on {
  background: var(--lk-dot-fill);
  border-color: var(--lk-dot-fill);
}

.lk-shake { animation: lk-shake-kf 0.4s ease; }
@keyframes lk-shake-kf {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-10px); }
  40% { transform: translateX(10px); }
  60% { transform: translateX(-6px); }
  80% { transform: translateX(6px); }
}

.lk-numpad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: calc(10px * var(--app-text-scale, 1));
  width: calc(240px * var(--app-text-scale, 1));
}

/* ── Numpad buttons — full Liquid Glass treatment ── */
.lk-numpad-btn {
  position: relative;
  width: calc(68px * var(--app-text-scale, 1));
  height: calc(68px * var(--app-text-scale, 1));
  border-radius: 50%;
  border: none;
  /* Layer 3: Tint */
  background: var(--lk-glass);
  /* Layer 1+4: Background blur + refraction */
  backdrop-filter: blur(80px) saturate(1.6) brightness(1.05);
  -webkit-backdrop-filter: blur(80px) saturate(1.6) brightness(1.05);
  color: var(--lk-num-color);
  font-size: calc(28px * var(--app-text-scale, 1));
  font-weight: 500;
  font-family: var(--app-font-family, inherit);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.12s, transform 0.08s;
  margin: 0 auto;
  /* Layer 5+6+7: Specular + chromatic + shadow */
  box-shadow: none;
  text-shadow: none;
}
.lk-numpad-btn::before { display: none; }
.lk-numpad-btn:active { background: rgba(255,255,255,0.25); transform: scale(0.95); }
.lk-numpad-empty {
  background: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  pointer-events: none;
  box-shadow: none !important;
}
.lk-numpad-empty::before { display: none; }

/* Cancel — bottom right */
.lk-cancel-btn {
  position: absolute;
  bottom: calc(20px * var(--app-text-scale, 1));
  right: calc(28px * var(--app-text-scale, 1));
  background: none; border: none;
  color: var(--lk-cancel);
  font-size: calc(15px * var(--app-text-scale, 1));
  font-weight: 500;
  cursor: pointer;
  padding: calc(8px * var(--app-text-scale, 1)) calc(12px * var(--app-text-scale, 1));
  font-family: var(--app-font-family, inherit);
}

/* Find password — bottom left, parallel with cancel */
.lk-forgot-btn {
  position: absolute;
  bottom: calc(20px * var(--app-text-scale, 1));
  left: calc(28px * var(--app-text-scale, 1));
  background: none; border: none;
  color: var(--lk-cancel);
  font-size: calc(15px * var(--app-text-scale, 1));
  font-weight: 500;
  cursor: pointer;
  padding: calc(8px * var(--app-text-scale, 1)) calc(12px * var(--app-text-scale, 1));
  font-family: var(--app-font-family, inherit);
}

.lk-reset-toast {
  position: absolute;
  bottom: calc(56px * var(--app-text-scale, 1));
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.72);
  color: #fff;
  font-size: calc(13px * var(--app-text-scale, 1));
  font-weight: 500;
  padding: calc(8px * var(--app-text-scale, 1)) calc(16px * var(--app-text-scale, 1));
  border-radius: 999px;
  white-space: nowrap;
  animation: lk-toast-fade 2s ease both;
  pointer-events: none;
}
@keyframes lk-toast-fade {
  0% { opacity: 0; transform: translateX(-50%) translateY(4px); }
  10% { opacity: 1; transform: translateX(-50%) translateY(0); }
  85% { opacity: 1; }
  100% { opacity: 0; }
}

/* ── Smooth transitions (opacity-only to avoid layout thrash) ── */
.lk-passcode-enter {
  animation: lk-passcode-fadein 0.3s ease both;
}
@keyframes lk-passcode-fadein {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.lk-unlock-fade {
  animation: lk-unlock-fadeout 0.32s ease both !important;
  pointer-events: none;
}
@keyframes lk-unlock-fadeout {
  from { opacity: 1; }
  to   { opacity: 0; }
}
`;
