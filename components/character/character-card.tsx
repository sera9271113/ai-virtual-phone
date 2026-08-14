"use client";

// 角色卡片：封面图 + 编号 + 菜单 + 名字 + 磨砂底部
// 短按 = 选中/居中，长按 = 进入编辑页

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Character } from "@/lib/character-types";

const FALLBACK_CARD_COLOR = "#ffffff";
const LONG_PRESS_MS = 400;

function IconDotsVertical() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

export function CharacterCard({
  character,
  number,
  selected = false,
  onSelect,
  onEdit,
  onMenu,
}: {
  character: Character;
  number: number;
  selected?: boolean;
  onSelect?: () => void;
  onEdit?: (e: React.MouseEvent<HTMLButtonElement | HTMLDivElement>) => void;
  onMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const color = character.cardColor?.trim() || FALLBACK_CARD_COLOR;
  const no = String(Math.max(1, Math.floor(number))).padStart(2, "0");

  // 长按手势
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  const cardRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback(() => {
    didLongPress.current = false;
    // 视觉反馈：按下后逐渐缩小，暗示长按中
    if (cardRef.current) {
      cardRef.current.style.transition = `transform ${LONG_PRESS_MS}ms ease-out`;
      cardRef.current.style.transform = 'scale(0.93)';
    }
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      // 长按成功：弹回 + 短震动反馈
      if (cardRef.current) {
        cardRef.current.style.transition = 'transform 0.15s ease';
        cardRef.current.style.transform = 'scale(1.02)';
        setTimeout(() => { if (cardRef.current) { cardRef.current.style.transform = ''; cardRef.current.style.transition = ''; } }, 150);
      }
      if (navigator.vibrate) navigator.vibrate(30);
    }, LONG_PRESS_MS);
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    // 取消按压缩小动画
    if (cardRef.current) { cardRef.current.style.transform = ''; cardRef.current.style.transition = ''; }
    if (didLongPress.current) {
      didLongPress.current = false;
      onEdit?.(e as unknown as React.MouseEvent<HTMLDivElement>);
    } else {
      onSelect?.();
    }
  }, [onEdit, onSelect]);

  const handlePointerCancel = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    if (cardRef.current) { cardRef.current.style.transform = ''; cardRef.current.style.transition = ''; }
    didLongPress.current = false;
  }, []);

  return (
    <div
      ref={cardRef}
      className={`ccf-card${selected ? " ccf-card-selected" : ""}`}
      style={{ ["--ccf-color" as string]: color }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      role="button"
      aria-label={`${character.name || "未命名角色"}，卡片（长按编辑）`}
    >
      {/* 封面头像 */}
      <div className="ccf-cover">
        {character.avatar ? (
          <img src={character.avatar} alt="" draggable={false} />
        ) : (
          <span className="ccf-cover-fallback">
            {(character.name ?? "?").charAt(0).toUpperCase() || "?"}
          </span>
        )}
      </div>

      {/* 磨砂底部区域 */}
      <div className="ccf-bottom-frost">
        {/* 编号 + 菜单行 */}
        <div className="ccf-bottom-meta">
          <span className="ccf-no-text">{no}</span>
          {onMenu && (
            <button
              type="button"
              className="ccf-menu-icon"
              aria-label={`「${character.name || "角色"}」卡片菜单`}
              onClick={(e) => { e.stopPropagation(); onMenu(e); }}
            >
              <IconDotsVertical />
            </button>
          )}
        </div>
        {/* 角色名 */}
        <div className="ccf-card-name">
          {character.name || "未命名"}
        </div>
      </div>
    </div>
  );
}

/**
 * 灰底静态测试台：不做轮播/滑动，纯列表铺开，方便单独调 .ccf-card 质感。
 * 按 createdAt 升序现算 NO.，与最终 CharacterCarousel 编号规则保持一致。
 */
export function CharacterCardFrostStage({
  characters,
  onEditCharacter,
}: {
  characters: Character[];
  onEditCharacter?: (id: string) => void;
}) {
  const ordered = [...characters].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  if (ordered.length === 0) {
    return (
      <div className="ccf-stage">
        <div className="ccf-stage-empty">点击 + 创建</div>
      </div>
    );
  }

  return (
    <div className="ccf-stage">
      {ordered.map((char, i) => (
        <CharacterCard
          key={char.id}
          character={char}
          number={i + 1}
          onEdit={() => onEditCharacter?.(char.id)}
        />
      ))}
    </div>
  );
}
