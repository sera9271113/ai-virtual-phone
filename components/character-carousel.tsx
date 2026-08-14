"use client";

// 角色轮播：横向 scroll-snap 平铺滑动，类似书店 Library 风格。
// 卡片一张挨一张，不做缩放/旋转/层叠。

import { useLayoutEffect, useRef } from "react";
import type { Character } from "@/lib/character-types";
import { CharacterCard } from "./character-card";

export function CharacterCarousel({
  characters,
  worldId,
  /** 用户上次打开/编辑的角色 id（由父组件记忆并传入）。组件因页面切换而
   *  重新挂载时，优先滚回这张卡，而不是全局「最近更新」的那张。 */
  focusCharacterId,
  onEditCharacter,
  onMenuCharacter,
}: {
  characters: Character[];
  worldId: string;
  focusCharacterId?: string | null;
  onEditCharacter?: (id: string, e: React.MouseEvent<HTMLButtonElement | HTMLDivElement>) => void;
  onMenuCharacter?: (id: string, e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const ordered = [...characters].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  const numberById = new Map(ordered.map((c, i) => [c.id, i + 1]));
  const scrollRef = useRef<HTMLDivElement>(null);

  // 首次挂载（含从编辑/详情页返回后的重新挂载）→ 优先回到用户刚看过的那张卡；
  // 世界切换或新增卡片 → 退回旧逻辑，滚动到最近更新的角色
  const hasMounted = useRef(false);
  const lastWorldId = useRef<string | null>(null);
  const lastCount = useRef<number>(ordered.length);
  // 用 useLayoutEffect 而不是 useEffect：firstRun/worldChanged 这两种「应该
  // 无动画直接定位」的场景，要在浏览器绘制前同步跳转，否则会先画出滚动位置 0
  // 的那一帧，再跳到目标卡片，看起来就像「又滑了一次」。
  useLayoutEffect(() => {
    const firstRun = !hasMounted.current;
    const worldChanged = lastWorldId.current !== worldId;
    const grew = !worldChanged && ordered.length > lastCount.current;
    hasMounted.current = true;
    lastWorldId.current = worldId;
    lastCount.current = ordered.length;
    if (ordered.length === 0) return;
    if (!firstRun && !worldChanged && !grew) return;

    const focusIdx = focusCharacterId ? ordered.findIndex(c => c.id === focusCharacterId) : -1;

    let targetIdx: number;
    // 冷启动（首次挂载且没有可恢复的焦点卡）：直接停在第一张卡、靠左对齐，
    // 不再兜底去定位「全局最近更新」的那张——那张可能排在中间，
    // 视觉上就像界面一打开就默认居中在某张卡上。
    const isColdStart = firstRun && focusIdx === -1;
    if (isColdStart) {
      targetIdx = 0;
    } else if (firstRun && focusIdx !== -1) {
      targetIdx = focusIdx;
    } else {
      // 找到最近编辑的角色 index
      let latestIdx = 0;
      let latestTime = -Infinity;
      ordered.forEach((c, i) => {
        const t = new Date(c.updatedAt).getTime();
        if (t > latestTime) { latestTime = t; latestIdx = i; }
      });
      targetIdx = latestIdx;
    }

    // 滚动到对应卡片
    const container = scrollRef.current;
    if (!container) return;
    const card = container.children[targetIdx] as HTMLElement | undefined;
    if (card) {
      // 注意：这里不能用 "auto" —— 按规范它表示「交给 CSS 的
      // scroll-behavior 决定」，而 .ccf-carousel-scroll 设了
      // scroll-behavior: smooth，"auto" 会被解析成平滑滚动，
      // 导致 firstRun/worldChanged 这两种本该瞬间就位的场景
      // 也带上了一段可见的滑动动画。必须显式传 "instant" 才能
      // 绕开 CSS 设置，真正做到无动画直接跳转。
      card.scrollIntoView({
        behavior: worldChanged || firstRun ? "instant" : "smooth",
        block: "nearest",
        inline: isColdStart ? "start" : "center",
      });
    }
  }, [worldId, characters.length, ordered, focusCharacterId]);

  if (ordered.length === 0) {
    return (
      <div className="ccf-carousel">
        <div className="ccf-carousel-empty">点击标题栏 ＋ 创建</div>
      </div>
    );
  }

  return (
    <div className="ccf-carousel">
      <div className="ccf-carousel-scroll" ref={scrollRef}>
        {ordered.map((char, i) => (
          <div key={char.id} className="ccf-carousel-item">
            <CharacterCard
              character={char}
              number={numberById.get(char.id) ?? i + 1}
              onSelect={() => {
                const card = scrollRef.current?.children[i] as HTMLElement | undefined;
                card?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
              }}
              onEdit={(e) => onEditCharacter?.(char.id, e)}
              onMenu={(e) => onMenuCharacter?.(char.id, e)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
