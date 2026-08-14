"use client";

// 色轮取色器（实施顺序 step 2）：角色卡片色 (cardColor) 与世界文件夹色 (color)
// 两处复用同一个控件，本身不含业务逻辑，纯受控组件。不再提供预设色板，
// 颜色完全交给色轮 + 十六进制输入框。
// 对应 character.css 里的 .cwp-* 样式块：
//   .cwp-root > .cwp-wheel-row(.cwp-wheel + .cwp-knob, .cwp-preview-col(.cwp-preview + .cwp-hex-input))
//             > .cwp-slider-row(.cwp-slider-label + .cwp-slider)

import { useEffect, useRef, useState } from "react";

const WHEEL_SIZE = 104;
const WHEEL_CENTER = WHEEL_SIZE / 2;
const WHEEL_MAX_RADIUS = WHEEL_CENTER - 4; // 留一点边距，指针不会顶到轮缘外

type Hsl = { h: number; s: number; l: number };

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function hslToHex({ h, s, l }: Hsl): string {
  const sN = clamp(s, 0, 100) / 100;
  const lN = clamp(l, 0, 100) / 100;
  const hN = ((h % 360) + 360) % 360;

  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((hN / 60) % 2) - 1));
  const m = lN - c / 2;

  let r = 0, g = 0, b = 0;
  if (hN < 60) [r, g, b] = [c, x, 0];
  else if (hN < 120) [r, g, b] = [x, c, 0];
  else if (hN < 180) [r, g, b] = [0, c, x];
  else if (hN < 240) [r, g, b] = [0, x, c];
  else if (hN < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToHsl(hex: string): Hsl | null {
  const s = hex.trim().replace(/^#/, "");
  const full =
    s.length === 3
      ? s.split("").map((c) => c + c).join("")
      : s.length === 6
      ? s
      : null;
  if (!full || !/^[0-9a-fA-F]{6}$/.test(full)) return null;

  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const d = max - min;
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  switch (max) {
    case r:
      h = ((g - b) / d) % 6;
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
  }
  h *= 60;
  if (h < 0) h += 360;

  return { h, s: sat * 100, l: l * 100 };
}

/** 支持 hsl()/hsla() 字符串输入（parseCharacterFromJson 等处允许存这种格式） */
function parseHslString(input: string): Hsl | null {
  const m = input.match(
    /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/i
  );
  if (!m) return null;
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

function parseColor(input: string): Hsl {
  const trimmed = (input || "").trim();
  const fromHex = trimmed.startsWith("#") ? hexToHsl(trimmed) : null;
  if (fromHex) return fromHex;
  const fromHsl = /^hsla?\(/i.test(trimmed) ? parseHslString(trimmed) : null;
  if (fromHsl) return fromHsl;
  return { h: 0, s: 60, l: 55 }; // 兜底：无法解析时给一个中性色
}

export function ColorWheelPicker({
  value,
  onChange,
}: {
  /** 当前颜色，hex（#rrggbb / #rgb）或 hsl()/hsla() 字符串 */
  value: string;
  /** 颜色变化即时回调，始终输出 hex 字符串 */
  onChange: (color: string) => void;
}) {
  const [hsl, setHsl] = useState<Hsl>(() => parseColor(value));
  const [hexDraft, setHexDraft] = useState(() => hslToHex(parseColor(value)));
  const wheelRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // 外部 value 变化（例如切换到另一个角色/世界）时同步内部状态，
  // 但拖拽/输入过程中自己触发的 onChange 不应该反过来打断自己——
  // 用 hex 比较，值相同就跳过，避免光标/拖拽被重置。
  useEffect(() => {
    const parsed = parseColor(value);
    const hex = hslToHex(parsed);
    if (hex.toLowerCase() === hslToHex(hsl).toLowerCase()) return;
    setHsl(parsed);
    setHexDraft(hex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function commit(next: Hsl) {
    setHsl(next);
    const hex = hslToHex(next);
    setHexDraft(hex);
    onChange(hex);
  }

  function updateFromPointer(clientX: number, clientY: number) {
    const el = wheelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;

    // 角度：从正上方(12点钟)顺时针为 0→360，对应 conic-gradient(from 0deg,...) 的起点
    let angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (angle < 0) angle += 360;

    const dist = Math.min(Math.sqrt(dx * dx + dy * dy), WHEEL_MAX_RADIUS);
    const sat = (dist / WHEEL_MAX_RADIUS) * 100;

    commit({ h: angle, s: sat, l: hsl.l });
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    draggingRef.current = true;
    updateFromPointer(e.clientX, e.clientY);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    updateFromPointer(e.clientX, e.clientY);
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // 已经释放或目标已变化，忽略
    }
  }

  function handleLightnessChange(e: React.ChangeEvent<HTMLInputElement>) {
    commit({ ...hsl, l: Number(e.target.value) });
  }

  function handleHexInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setHexDraft(e.target.value);
  }

  function commitHexDraft() {
    const parsed = hexToHsl(hexDraft);
    if (parsed) {
      commit(parsed);
    } else {
      // 输入非法：还原成当前实际颜色，不静默丢弃用户注意力
      setHexDraft(hslToHex(hsl));
    }
  }

  const angleRad = (hsl.h * Math.PI) / 180;
  const radius = (clamp(hsl.s, 0, 100) / 100) * WHEEL_MAX_RADIUS;
  const knobLeft = WHEEL_CENTER + radius * Math.sin(angleRad);
  const knobTop = WHEEL_CENTER - radius * Math.cos(angleRad);

  const currentHex = hslToHex(hsl);

  return (
    <div className="cwp-root">
      <div className="cwp-wheel-row">
        <div
          ref={wheelRef}
          className="cwp-wheel"
          style={{
            background: `radial-gradient(circle at center, #fff 0%, rgba(255,255,255,0) 70%),
              conic-gradient(from 0deg, red, #ff0, #0f0, #0ff, #00f, #f0f, red)`,
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          role="slider"
          aria-label="色相与饱和度"
          aria-valuetext={currentHex}
        >
          <div
            className="cwp-knob"
            style={{
              left: knobLeft,
              top: knobTop,
              background: currentHex,
            }}
          />
        </div>
        <div className="cwp-preview-col">
          <div className="cwp-preview" style={{ background: currentHex }} aria-hidden />
          <input
            type="text"
            className="cwp-hex-input"
            value={hexDraft}
            onChange={handleHexInputChange}
            onBlur={commitHexDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitHexDraft();
              }
            }}
            spellCheck={false}
            maxLength={7}
            aria-label="十六进制颜色值"
          />
        </div>
      </div>

      <div className="cwp-slider-row">
        <span className="cwp-slider-label">明度</span>
        <input
          type="range"
          className="cwp-slider"
          min={0}
          max={100}
          value={Math.round(hsl.l)}
          onChange={handleLightnessChange}
          style={{
            background: `linear-gradient(to right,
              ${hslToHex({ h: hsl.h, s: hsl.s, l: 0 })},
              ${hslToHex({ h: hsl.h, s: hsl.s, l: 50 })},
              ${hslToHex({ h: hsl.h, s: hsl.s, l: 100 })})`,
          }}
          aria-label="明度"
        />
      </div>
    </div>
  );
}
