"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Character } from "@/lib/character-types";
import {
  createCharacter,
  exportCharacterAsJson,
  exportCharacterAsPng,
  loadCharacters,
  parseCharacterFromJson,
  parseCharacterFromPng,
  saveCharacters,
  type CharacterImportData,

  CHAR_BLOCKED_FIELDS,
} from "@/lib/character-storage";
import { generateBriefPersonaText, isBriefPersonaStale } from "@/lib/brief-persona";
import { generateSupportingCharacters, materializeSupportingCharacter, type GeneratedSupportingCharacter } from "@/lib/npc-generator";
import {
  addCharacterWorldRelation,
  createCharacterWorldGroup,
  deleteCharacterWorldGroup,
  deleteCharacterWorldRelation,
  getCharacterWorldGroupId,
  loadCharacterWorldGroups,
  moveCharacterToWorld,
  renameCharacterWorldGroup,
  updateCharacterWorldDescription,
  updateCharacterWorldColor,
  CHARACTER_WORLDS_UPDATED_EVENT,
  DEFAULT_CHARACTER_WORLD_ID,
  type CharacterWorldGroup,
} from "@/lib/character-world-storage";
import { WorldFolderStrip, WorldCaseSheet, NewWorldSheet } from "@/components/character/world-tabs";
import { CharacterCarousel } from "@/components/character/character-carousel";
import { ColorWheelPicker } from "@/components/character/color-wheel-picker";
import { RelationLinkDialog, RelationPairSheet } from "@/components/character/relation-dialogs";
import { loadMomentsConfig, saveMomentsConfig } from "@/lib/moments-storage";
import { PageShell } from "@/components/ui/page-shell";
import { ConfirmDialog } from "@/components/ui/modal";
import { AlertCircle } from "lucide-react";
import { notifyMascotPageContext } from "@/lib/mascot-events";
import { kvGet, kvSet } from "@/lib/kv-db";
import { normalizeTimeZone } from "@/lib/character-time";

type ViewType = "list" | "detail";

// 角色卡片色轮的兜底色：与 character-card.tsx 的 FALLBACK_CARD_COLOR 保持一致，
// 各自维护一份互不依赖。不再提供快捷预设色板——颜色完全交给色轮自定义。
const FALLBACK_CARD_COLOR = "#ffffff";



// 关系连线：与世界观关系同步——同一对角色间的多条关系合并为一条线，标签并列显示
type RelationLine = { key: string; aId: string; bId: string; labels: string[] };

const WORLD_TAB_KEY = 'ai_phone_character_app_world_v1';

type TransitionState = {
  char: Character;
  sourceRect: DOMRect;
  phase: "start" | "fly" | "flip";
  onComplete?: () => void;
  reverse?: boolean;
};

type PhoneCharacterAppProps = {
  onClose: () => void;
  onNotice: (text: string) => void;
};

type IntlWithTimeZoneList = typeof Intl & {
  supportedValuesOf?: (key: "timeZone") => string[];
};

const COMMON_CHARACTER_TIME_ZONES = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Asia/Bangkok",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const SUPPORTED_CHARACTER_TIME_ZONES = (() => {
  try {
    const intl = Intl as IntlWithTimeZoneList;
    const values = typeof intl.supportedValuesOf === "function"
      ? intl.supportedValuesOf("timeZone")
      : [];
    return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
})();

function getCharacterTimeZoneOptions(currentTimeZone = ""): string[] {
  const options: string[] = [];
  const seen = new Set<string>();
  const add = (timeZone: string) => {
    if (!timeZone || seen.has(timeZone)) return;
    seen.add(timeZone);
    options.push(timeZone);
  };

  COMMON_CHARACTER_TIME_ZONES.forEach(add);
  SUPPORTED_CHARACTER_TIME_ZONES.forEach(add);
  const normalizedCurrentTimeZone = normalizeTimeZone(currentTimeZone);
  if (normalizedCurrentTimeZone) add(normalizedCurrentTimeZone);
  return options;
}

export function PhoneCharacterApp({ onClose, onNotice }: PhoneCharacterAppProps) {
  const [view, setView] = useState<{ type: ViewType; id: string | null; isEditing?: boolean }>({ type: "list", id: null, isEditing: false });
  const [characters, setCharacters] = useState<Character[]>(() => loadCharacters());
  const [transition, setTransition] = useState<TransitionState | null>(null);

  // ── 世界文件夹：分组数据 + 当前打开的文件夹（持久记忆） ──
  // 记住用户最近打开/编辑的角色 id：从详情/编辑页返回列表时，轮播据此定位回同一张卡，
  // 而不是跳去「全局最近更新」的那张（旧行为会导致每次返回都定在同一张，感觉像"居中到中位数"）
  const lastFocusedCharIdRef = useRef<string | null>(null);

  const [worldGroups, setWorldGroups] = useState<CharacterWorldGroup[]>(() => loadCharacterWorldGroups());
  const [currentWorldId, setCurrentWorldId] = useState<string>(() => {
    const saved = typeof window !== "undefined" ? kvGet(WORLD_TAB_KEY) : null;
    return saved || DEFAULT_CHARACTER_WORLD_ID;
  });
  useEffect(() => {
    const reload = () => setWorldGroups(loadCharacterWorldGroups());
    window.addEventListener(CHARACTER_WORLDS_UPDATED_EVENT, reload);
    return () => window.removeEventListener(CHARACTER_WORLDS_UPDATED_EVENT, reload);
  }, []);
  // 新建/改名/删除文件夹等操作后立即同步一次，不完全依赖 CHARACTER_WORLDS_UPDATED_EVENT
  // 的异步回读——如果底层 kvSet 是防抖/延迟持久化的，事件触发时 loadCharacterWorldGroups()
  // 可能还读到旧值，导致新文件夹「看起来没加上」。这里直接用调用方已经拿到手的最新数据合并，
  // 不必等存储层回读确认。
  function syncWorldGroups(next: CharacterWorldGroup[] | ((prev: CharacterWorldGroup[]) => CharacterWorldGroup[])) {
    setWorldGroups(next);
  }
  // 记忆的世界可能已被删除 → 回落默认文件夹
  const safeWorldId = worldGroups.some(g => g.id === currentWorldId) ? currentWorldId : DEFAULT_CHARACTER_WORLD_ID;
  function selectWorldId(worldId: string) {
    setCurrentWorldId(worldId);
    try { kvSet(WORLD_TAB_KEY, worldId); } catch { }
  }

  function updateChars(next: Character[]) {
    setCharacters(next);
    saveCharacters(next);
    // 角色增删会影响世界成员归属（normalize），同步刷新分组
    setWorldGroups(loadCharacterWorldGroups());
  }

  // Handle clicking a polaroid
  function handleSelectChar(char: Character, e: React.MouseEvent<HTMLDivElement>) {
    lastFocusedCharIdRef.current = char.id;
    const rect = e.currentTarget.getBoundingClientRect();

    setTransition({
      char,
      sourceRect: rect,
      phase: "start",
    });

    // Animate
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTransition((p) => p ? { ...p, phase: "fly" } : null);
        setTimeout(() => {
          setTransition((p) => p ? { ...p, phase: "flip" } : null);
          setTimeout(() => {
            setView({ type: "detail", id: char.id });
            setTransition(null);
          }, 400); // Wait for flip 0.4s
        }, 400); // Wait for fly 0.4s
      });
    });
  }

  // Handle back from detail
  function handleBackFromDetail() {
    setView({ type: "list", id: null, isEditing: false });
  }

  return (
    <>
      <div className="char-app">
        {view.type === "list" && (
          <CharListView
            characters={characters}
            worldGroups={worldGroups}
            currentWorldId={safeWorldId}
            onSelectWorld={selectWorldId}
            onUpdateChars={updateChars}
            onWorldGroupsChange={syncWorldGroups}
            onClose={onClose}
            onSelect={handleSelectChar}
            onCreate={() => setView({ type: "detail", id: null, isEditing: true })}
            onNotice={onNotice}
            focusCharacterId={lastFocusedCharIdRef.current}
          />
        )}

        {view.type === "detail" && (
          <CharArchiveView
            char={view.id ? (characters.find((c) => c.id === view.id) ?? createCharacter({ name: "", persona: "", avatar: null })) : createCharacter({ name: "", persona: "", avatar: null })}
            isEditing={view.isEditing}
            onBack={handleBackFromDetail}
            onEdit={() => setView({ type: "detail", id: view.id, isEditing: true })}
            onCancelEdit={() => {
              if (view.id) {
                setView({ type: "detail", id: view.id, isEditing: false });
              } else {
                setView({ type: "list", id: null, isEditing: false });
              }
            }}
            onSave={(data) => {
              const existing = view.id ? characters.find((c) => c.id === view.id) : null;
              if (existing) {
                const updated: Character = {
                  ...existing,
                  ...data,
                  updatedAt: new Date().toISOString(),
                };
                updateChars(characters.map((c) => (c.id === existing.id ? updated : c)));
                setView({ type: "detail", id: existing.id, isEditing: false });
                onNotice("档案已更新");
              } else {
                const newChar = createCharacter(data);
                lastFocusedCharIdRef.current = newChar.id;
                updateChars([...characters, newChar]);
                // 直接追加进当前打开的文件夹（normalize 默认丢进默认世界）
                if (safeWorldId !== DEFAULT_CHARACTER_WORLD_ID) {
                  moveCharacterToWorld(newChar.id, safeWorldId);
                } else {
                  setWorldGroups(loadCharacterWorldGroups());
                }
                setView({ type: "list", id: null, isEditing: false });
                onNotice("已创建角色");
              }
            }}
            onDelete={() => {
              if (view.id) {
                updateChars(characters.filter((c) => c.id !== view.id));
              }
              setView({ type: "list", id: null, isEditing: false });
              onNotice("已删除档案");
            }}
            onExportJson={() => {
              const c = view.id ? characters.find(x => x.id === view.id) : null;
              if (c) exportCharacterAsJson(c);
            }}
            onExportPng={async () => {
              const c = view.id ? characters.find(x => x.id === view.id) : null;
              if (c) {
                await exportCharacterAsPng(c);
                onNotice("导出成功");
              }
            }}
          />
        )}
      </div>

      {/* Fly & Flip Transition Overlay */}
      {transition && (
        <FlipTransitionOverlay transit={transition} />
      )}
    </>
  );
}

// ── 过渡动效层 ───────────────────────────────────────

function FlipTransitionOverlay({ transit }: { transit: TransitionState }) {
  const { char, sourceRect, phase } = transit;

  // Calculate relative bounds based on parent .phone-shell
  const [shellRect, setShellRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const shell = document.querySelector(".char-app");
    if (shell) setShellRect(shell.getBoundingClientRect());
  }, []);

  if (!shellRect) return null;

  // The final target rect inside the phone shell
  // We'll occupy the full width and height of the phone shell
  const targetWidth = shellRect.width;
  const targetHeight = shellRect.height;
  const targetTop = shellRect.top;
  const targetLeft = shellRect.left;

  // Render variables
  const isStart = phase === "start";

  const currentTop = isStart ? sourceRect.top : targetTop;
  const currentLeft = isStart ? sourceRect.left : targetLeft;
  const currentWidth = isStart ? sourceRect.width : targetWidth;
  const currentHeight = isStart ? sourceRect.height : targetHeight;

  // 3D Rotation
  const isFlipped = phase === "flip";

  const duration = isStart ? "0s" : "0.4s";

  return (
    <div
      className="char-flipper-container fixed"
      style={{
        top: currentTop,
        left: currentLeft,
        width: currentWidth,
        height: currentHeight,
        transition: `all ${duration} cubic-bezier(0.25, 1, 0.5, 1)`,
      }}
    >
      <div
        className="char-flipper-inner"
        style={{
          transition: `transform ${duration} ease-in-out`,
          transform: isFlipped ? "rotateY(180deg)" : "rotateY(0deg)",
        }}
      >
        <div className="char-flipper-front" style={{ padding: isStart ? 0 : "12px" }}>
          {/* Polaroid Front */}
          <div className="char-polaroid w-full h-full border-none shadow-none" style={{
            transition: `padding ${duration} ease`
          }}>
            {isStart && <div className="char-polaroid-tape" />}
            <div className="char-polaroid-img-wrapper" style={{
              height: isStart ? "auto" : "100%",
              aspectRatio: isStart ? "1/1" : "auto",
              transition: `all ${duration} ease`
            }}>
              {char.avatar ? (
                <img src={char.avatar} className="char-polaroid-img" alt="" />
              ) : (
                <div className="w-full h-full bg-[#9b8aaa]" />
              )}
            </div>
            {isStart && <div className="char-polaroid-text">{char.name || "UNNAMED"}</div>}
          </div>
        </div>

        <div className="char-flipper-back">
          {/* Scaled down or full archive rendering so it doesn't look weird */}
          <div className="absolute top-0 left-0" style={{
            width: targetWidth, height: targetHeight,
            opacity: isFlipped ? 1 : 0.5,
            transition: `opacity ${duration} ease`
          }}>
            <CharArchiveView dummy char={char} onBack={() => { }} onEdit={() => { }} onDelete={() => { }} onExportJson={() => { }} onExportPng={async () => { }} />
          </div>
        </div>
      </div>
    </div>
  );
}


// ── 列表视图（照片墙） ─────────────────────────────────────────

function CharListView({
  characters,
  worldGroups,
  currentWorldId,
  onSelectWorld,
  onUpdateChars,
  onWorldGroupsChange,
  onClose,
  onSelect,
  onCreate,
  onNotice,
  focusCharacterId,
}: {
  characters: Character[];
  worldGroups: CharacterWorldGroup[];
  currentWorldId: string;
  onSelectWorld: (worldId: string) => void;
  onUpdateChars: (next: Character[]) => void;
  /** 世界分组数据在本组件内直接改动后，立即同步回父级 state，不等 CHARACTER_WORLDS_UPDATED_EVENT
      的异步回读——避免底层存储写入有延迟时，新建/改名/删除文件夹「看起来没生效」 */
  onWorldGroupsChange: (next: CharacterWorldGroup[] | ((prev: CharacterWorldGroup[]) => CharacterWorldGroup[])) => void;
  onClose: () => void;
  onSelect: (char: Character, e: React.MouseEvent<HTMLDivElement>) => void;
  onCreate: () => void;
  onNotice: (text: string) => void;
  /** 用户上次打开/编辑的角色 id，重新挂载时轮播优先定位到它 */
  focusCharacterId?: string | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [showNpcGen, setShowNpcGen] = useState(false);
  const [activeMoveChar, setActiveMoveChar] = useState<Character | null>(null);

  // ── 新建按钮展开/收起 ──
  const orbitTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [orbitOpen, setOrbitOpen] = useState(false);
  function openOrbit() { setOrbitOpen(true); }
  function closeOrbit() { setOrbitOpen(false); }
  function toggleOrbit() { orbitOpen ? closeOrbit() : openOrbit(); }

  // 点击 actions 区域外自动收起（延迟注册，避免打开那次 click 被自己捕获）
  useEffect(() => {
    if (!orbitOpen) return;
    let id: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      id = null;
      function handleClick(e: MouseEvent) {
        if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
          closeOrbit();
        }
      }
      document.addEventListener("click", handleClick, { capture: true });
      cleanupRef.current = () => document.removeEventListener("click", handleClick, { capture: true });
    }, 50);
    return () => { if (id !== null) clearTimeout(id); cleanupRef.current?.(); cleanupRef.current = null; };
  }, [orbitOpen]);
  const cleanupRef = useRef<(() => void) | null>(null);

  // ── 世界文件夹：当前世界派生数据 ──
  const currentGroup = worldGroups.find(g => g.id === currentWorldId)
    ?? worldGroups.find(g => g.id === DEFAULT_CHARACTER_WORLD_ID)
    ?? worldGroups[0];
  const memberSet = new Set(currentGroup?.memberIds ?? []);
  const worldCharacters = characters.filter(c => memberSet.has(c.id));
  const memberCounts = new Map(worldGroups.map(g => [g.id, g.memberIds.length]));
  const nameById = new Map(characters.map(c => [c.id, c.name || "未命名"]));
  // 连线与世界观关系同步：同一对角色的多条关系合并为一条线
  const relationLines: RelationLine[] = (() => {
    const pairs = new Map<string, RelationLine>();
    for (const relation of currentGroup?.relations ?? []) {
      const [aId, bId] = [relation.fromCharacterId, relation.toCharacterId].sort();
      const key = `${aId}__${bId}`;
      const existing = pairs.get(key);
      if (existing) {
        if (!existing.labels.includes(relation.label)) existing.labels.push(relation.label);
      } else {
        pairs.set(key, { key, aId, bId, labels: [relation.label] });
      }
    }
    return [...pairs.values()];
  })();

  // ── 世界文件夹：弹层与交互状态 ──
  const [showWorldEditor, setShowWorldEditor] = useState(false);
  const [showNewWorld, setShowNewWorld] = useState(false);
  // 拖拽拍立得归档进世界 tab 曾是旧版画布的交互，随画布一起下线；
  // 转移世界改由卡片菜单触发的 Modal 完成，这里不再需要监听拖拽悬停
  const dropTargetWorldId: string | null = null;
  // 关系查看：独立视图列出当前世界内所有角色两两关系（替代画布拉线）
  const [showRelationsOverview, setShowRelationsOverview] = useState(false);
  const [linkTo, setLinkTo] = useState<{ fromId: string; toId: string } | null>(null);
  const [pairSheet, setPairSheet] = useState<{ aId: string; bId: string } | null>(null);

  // 切世界时收起关系相关弹层与轨道菜单
  useEffect(() => { setLinkTo(null); setPairSheet(null); setShowRelationsOverview(false); closeOrbit(); }, [currentWorldId]);

  /** 「生成配角」确认落库（支持一批）：落库逻辑与聊天名片建档共用 lib/npc-generator 的 materialize */
  function handleNpcGenerated(results: GeneratedSupportingCharacter[], targetId: string, allowAutoPost: boolean) {
    const newChars = results.map(result =>
      materializeSupportingCharacter(result, targetId, { allowAutoPost })
    );
    // materialize 直接写存储；这里回读刷新 React 态（onUpdateChars 会再存一次同数据，无害）
    onUpdateChars(loadCharacters());
    setShowNpcGen(false);
    onNotice(`已生成配角：${newChars.map(c => `「${c.name}」`).join("")}`);
  }

  function selectWorld(worldId: string) {
    if (worldId === currentWorldId) return;
    onSelectWorld(worldId);
  }

  const [importError, setImportError] = useState<string | null>(null);

  /** 导入解析成功后直接落库进当前文件夹（不再需要点击画布放置） */
  async function handleImportFile(file: File) {
    try {
      let data: CharacterImportData | null = null;
      let avatarOverride = "";
      if (file.type === "application/json" || file.name.endsWith(".json")) {
        const text = await file.text();
        data = parseCharacterFromJson(text);
        if (!data) return onNotice("解析失败，请检查文件格式");
      } else if (file.type === "image/png" || file.name.endsWith(".png")) {
        const buffer = await file.arrayBuffer();
        data = parseCharacterFromPng(buffer);
        if (!data) return onNotice("未在 PNG 中找到角色数据");
        try {
          avatarOverride = await fileToDataUrl(file);
        } catch (e) {
          console.error("Failed to read image file data", e);
        }
        if (!avatarOverride && typeof data.avatar === "string" && data.avatar.trim() !== "") {
          avatarOverride = data.avatar;
        }
      } else {
        return onNotice("请选择 .json 或 .png 文件");
      }
      const c = createCharacter(avatarOverride ? { ...data, avatar: avatarOverride } : data);
      onUpdateChars([...characters, c]);
      if (currentWorldId !== DEFAULT_CHARACTER_WORLD_ID) {
        moveCharacterToWorld(c.id, currentWorldId);
      }
      onNotice(`已导入角色「${c.name || "未命名"}」`);
    } catch (e) {
      if (e instanceof Error && e.message === CHAR_BLOCKED_FIELDS) {
        setImportError("不支持包含开场白、场景或示例对话的角色卡");
      } else {
        onNotice("解析失败，请检查文件格式");
      }
    }
  }

  return (
    <>
      <PageShell
        title=""
        leftAction={
          <button
            className="flex items-center justify-center w-[34px] h-[34px] text-[#666] hover:text-[#333] transition-colors"
            onClick={onClose}
            aria-label="返回桌面"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>
        }
        className="[&_.page-body]:pb-0 [&_.page-header]:bg-white"
        footer={
          <input
            ref={fileRef} type="file" accept=".json,.png,image/png,application/json" className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) await handleImportFile(file);
              e.target.value = "";
            }}
          />
        }
      >
      {/* 灰色底板：卡片轮播 + 世界文件夹条共用同一块背景，文件夹条在下方；
          「＋」按钮现在也在这块底板内（右上角），页面顶栏只剩标题/返回，维持白色 */}
      <div className="ccf-panel">
        {/* 标题行：左「Character Card」 右「新建+关系」图标按钮 */}
        <div className="ccf-section-header">
          <span className="ccf-section-title">Character Card</span>
          <div className="ccf-section-actions" ref={actionsRef}>
            {orbitOpen ? (
              /* 展开态：导入/创建/NPC 三个图标横排 */
              <>
                <button type="button" className="ccf-header-icon-btn" aria-label="导入" onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); closeOrbit(); }}><IconImport /></button>
                <button type="button" className="ccf-header-icon-btn" aria-label="创建" onClick={(e) => { e.stopPropagation(); onCreate(); closeOrbit(); }}><IconPlus /></button>
                <button type="button" className="ccf-header-icon-btn" aria-label="NPC" onClick={(e) => { e.stopPropagation(); setShowNpcGen(true); closeOrbit(); }}><IconSparkles /></button>
              </>
            ) : (
              <button ref={orbitTriggerRef} type="button" className="ccf-header-icon-btn" aria-label="新建" onClick={toggleOrbit}><IconPlus /></button>
            )}
            <button type="button" className="ccf-header-icon-btn" aria-label="查看角色关系" onClick={() => setShowRelationsOverview(true)}><IconLink /></button>
          </div>
        </div>
        <div className="w-full min-h-0 overflow-hidden relative ccf-carousel-wrap" style={{ flex: '5 1 0%' }}>
          <CharacterCarousel
            characters={worldCharacters}
            worldId={currentWorldId}
            focusCharacterId={focusCharacterId}
            onEditCharacter={(id, e) => {
              const char = worldCharacters.find(c => c.id === id) ?? characters.find(c => c.id === id);
              if (char) onSelect(char, e as unknown as React.MouseEvent<HTMLDivElement>);
            }}
            onMenuCharacter={(id) => {
              const char = worldCharacters.find(c => c.id === id) ?? characters.find(c => c.id === id);
              if (char) setActiveMoveChar(char);
            }}
          />
        </div>
        {/* 世界文件夹条：每个世界一份案卷，放在底板下部 */}
        <WorldFolderStrip
          groups={worldGroups}
          currentWorldId={currentWorldId}
          memberCounts={memberCounts}
          dropTargetWorldId={dropTargetWorldId}
          onSelect={selectWorld}
          onOpenEditor={() => setShowWorldEditor(true)}
          onOpenCreate={() => setShowNewWorld(true)}
        />
        {/* 纯装饰底栏：文件夹条 + 数字下方，毛玻璃质感，贴屏幕左右两边 */}
        <DecorativeDockBar />
      </div>
      </PageShell>



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

      {/* NPC generator sheet — 目标角色限当前世界，生成的配角落进当前文件夹 */}
      {showNpcGen && (
        <NpcGeneratorSheet
          characters={worldCharacters}
          onClose={() => setShowNpcGen(false)}
          onConfirm={handleNpcGenerated}
        />
      )}

      {/* 世界文件夹编辑 */}
      {showWorldEditor && currentGroup && (
        <WorldCaseSheet
          group={currentGroup}
          onRename={name => {
            renameCharacterWorldGroup(currentGroup.id, name);
            onWorldGroupsChange(loadCharacterWorldGroups());
          }}
          onUpdateDescription={description => {
            updateCharacterWorldDescription(currentGroup.id, description);
            onWorldGroupsChange(loadCharacterWorldGroups());
          }}
          onUpdateColor={color => {
            updateCharacterWorldColor(currentGroup.id, color);
            onWorldGroupsChange(loadCharacterWorldGroups());
          }}
          onDelete={() => {
            deleteCharacterWorldGroup(currentGroup.id);
            onWorldGroupsChange(loadCharacterWorldGroups());
            setShowWorldEditor(false);
            selectWorld(DEFAULT_CHARACTER_WORLD_ID);
            onNotice("文件夹已删除，角色并回默认世界");
          }}
          onClose={() => setShowWorldEditor(false)}
        />
      )}

      {/* 新建文件夹 */}
      {showNewWorld && (
        <NewWorldSheet
          onCreate={(name, color) => {
            const group = createCharacterWorldGroup(name, color);
            onWorldGroupsChange(prev => (prev.some(g => g.id === group.id) ? prev : [...prev, group]));
            setShowNewWorld(false);
            selectWorld(group.id);
            onNotice(`已建立文件夹「${group.name}」`);
          }}
          onClose={() => setShowNewWorld(false)}
        />
      )}

      {/* 关系查看：独立视图列出当前世界内所有角色两两关系（替代画布拉线） */}
      {showRelationsOverview && currentGroup && (
        <RelationsOverviewSheet
          worldName={currentGroup.name}
          worldCharacters={worldCharacters}
          relationLines={relationLines}
          nameById={nameById}
          onOpenPair={(aId, bId) => setPairSheet({ aId, bId })}
          onStartLink={(fromId, toId) => setLinkTo({ fromId, toId })}
          onClose={() => setShowRelationsOverview(false)}
        />
      )}

      {/* 新增关系：选定两个角色后填关系标签 */}
      {linkTo && currentGroup && (
        <RelationLinkDialog
          fromName={nameById.get(linkTo.fromId) ?? "?"}
          toName={nameById.get(linkTo.toId) ?? "?"}
          onConfirm={label => {
            addCharacterWorldRelation(currentGroup.id, linkTo.fromId, linkTo.toId, label);
            onWorldGroupsChange(loadCharacterWorldGroups());
            setLinkTo(null);
          }}
          onCancel={() => setLinkTo(null)}
        />
      )}

      {/* 关系细目：逐条剪断 */}
      {pairSheet && currentGroup && (
        <RelationPairSheet
          relations={(currentGroup.relations ?? []).filter(r =>
            (r.fromCharacterId === pairSheet.aId && r.toCharacterId === pairSheet.bId)
            || (r.fromCharacterId === pairSheet.bId && r.toCharacterId === pairSheet.aId)
          )}
          nameById={nameById}
          onDelete={relationId => {
            deleteCharacterWorldRelation(currentGroup.id, relationId);
            onWorldGroupsChange(loadCharacterWorldGroups());
          }}
          onClose={() => setPairSheet(null)}
        />
      )}

      {/* 转移世界 Modal */}
      {activeMoveChar && (
        <div className="modal-overlay" data-ui="modal" onPointerDown={() => setActiveMoveChar(null)}>
          <div className="modal-dialog" data-ui="modal-dialog" onPointerDown={(e) => e.stopPropagation()} style={{ padding: 0, overflow: 'hidden' }}>
            <div className="modal-header" data-ui="modal-header" style={{ padding: '20px 20px 10px' }}>
              <h3 className="modal-title" style={{ margin: 0, fontSize: '16px' }}>转移到其他文件夹</h3>
            </div>
            <div role="listbox" style={{ maxHeight: '40dvh', padding: '10px 16px', overflowY: 'auto' }}>
              {worldGroups.filter(g => g.id !== currentWorldId).map(group => (
                <button
                  key={group.id}
                  type="button"
                  style={{ width: '100%', padding: '12px 16px', textAlign: 'left', borderRadius: '8px', background: 'rgba(0,0,0,0.03)', marginBottom: '8px', border: '1px solid rgba(0,0,0,0.05)', fontWeight: '500', fontSize: '14px', color: '#333' }}
                  onClick={() => {
                    moveCharacterToWorld(activeMoveChar.id, group.id);
                    setActiveMoveChar(null);
                    onNotice(`已将「${activeMoveChar.name || "未命名"}」转移到「${group.name}」`);
                  }}
                  role="option"
                >
                  {group.name}
                </button>
              ))}
              {worldGroups.filter(g => g.id !== currentWorldId).length === 0 && (
                <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>没有其他文件夹可供转移</div>
              )}
            </div>
            <div className="modal-footer" data-ui="modal-footer" style={{ padding: '10px 20px 20px' }}>
              <button className="ui-btn ui-btn-outline" style={{ width: '100%' }} onClick={() => setActiveMoveChar(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── 关系查看：独立视图列出当前世界内所有角色两两关系（替代画布拉线） ──────
function RelationsOverviewSheet({
  worldName,
  worldCharacters,
  relationLines,
  nameById,
  onOpenPair,
  onStartLink,
  onClose,
}: {
  worldName: string;
  worldCharacters: Character[];
  relationLines: RelationLine[];
  nameById: Map<string, string>;
  onOpenPair: (aId: string, bId: string) => void;
  onStartLink: (fromId: string, toId: string) => void;
  onClose: () => void;
}) {
  const [addingFromId, setAddingFromId] = useState<string | null>(null);
  const [addingToId, setAddingToId] = useState<string | null>(null);

  function handleConfirmAdd() {
    if (!addingFromId || !addingToId || addingFromId === addingToId) return;
    onStartLink(addingFromId, addingToId);
    setAddingFromId(null);
    setAddingToId(null);
  }

  return (
    <div className="wt-modal" onClick={onClose}>
      <div className="wt-paper" onClick={e => e.stopPropagation()}>
        <div className="wt-paper-kicker">RELATIONS</div>
        <p className="wt-relation-overview-title">「{worldName}」的角色关系</p>

        {relationLines.length === 0 ? (
          <p className="wt-paper-hint">这份文件夹里还没有角色关系。</p>
        ) : (
          <ul className="wt-relation-list">
            {relationLines.map(line => (
              <li key={line.key} className="wt-relation-item">
                <button
                  type="button"
                  className="wt-relation-text wt-relation-text-btn"
                  onClick={() => onOpenPair(line.aId, line.bId)}
                >
                  {nameById.get(line.aId) ?? "?"} ↔ {nameById.get(line.bId) ?? "?"}
                  <span className="wt-relation-item-labels">{line.labels.join(" / ")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* 新增关系：从当前世界角色里选两个，再进入标签输入（复用 RelationLinkDialog） */}
        <label className="wt-paper-label mt-3">添加新关系</label>
        <div className="wt-relation-add-row">
          <select
            className="wt-paper-input"
            value={addingFromId ?? ''}
            onChange={e => setAddingFromId(e.target.value || null)}
          >
            <option value="">选角色 A</option>
            {worldCharacters.map(c => (
              <option key={c.id} value={c.id} disabled={c.id === addingToId}>{c.name || "未命名"}</option>
            ))}
          </select>
          <span className="wt-relation-add-link" aria-hidden>
            <IconLink />
          </span>
          <select
            className="wt-paper-input"
            value={addingToId ?? ''}
            onChange={e => setAddingToId(e.target.value || null)}
          >
            <option value="">选角色 B</option>
            {worldCharacters.map(c => (
              <option key={c.id} value={c.id} disabled={c.id === addingFromId}>{c.name || "未命名"}</option>
            ))}
          </select>
        </div>

        <div className="wt-paper-actions mt-3">
          <button type="button" className="wt-btn flex-1" onClick={onClose}>关闭</button>
          <button
            type="button"
            className="wt-btn wt-btn-done flex-1"
            disabled={!addingFromId || !addingToId || addingFromId === addingToId}
            onClick={handleConfirmAdd}
          >
            牵上关系
          </button>
        </div>
      </div>
    </div>
  );
}


// ── 绝密档案视图（详情页面） ─────────────────────────────────────────

function CharArchiveView({
  char,
  isEditing = false,
  onBack,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onExportJson,
  onExportPng,
  dummy,
}: {
  char: Character;
  isEditing?: boolean;
  onBack: () => void;
  onEdit: () => void;
  onCancelEdit?: () => void;
  onSave?: (data: CharacterImportData) => void;
  onDelete: () => void;
  onExportJson: () => void;
  onExportPng: () => Promise<void>;
  dummy?: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState<"back" | "cancel" | null>(null);
  const [name, setName] = useState(char.name || "");
  const [persona, setPersona] = useState(char.persona || "");
  const [personality, setPersonality] = useState(char.personality || "");
  const [briefPersona, setBriefPersona] = useState(char.briefPersona || "");
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState("");
  const [timeZone, setTimeZone] = useState(char.timeZone || "");
  const [tags, setTags] = useState<string[]>(char.tags || []);
  const [tagInput, setTagInput] = useState("");
  const [showTimeZonePicker, setShowTimeZonePicker] = useState(false);
  const [timeZoneSearch, setTimeZoneSearch] = useState(char.timeZone || "");
  const [avatar, setAvatar] = useState<string | null>(char.avatar || null);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [cardColor, setCardColor] = useState(char.cardColor || FALLBACK_CARD_COLOR);
  const fileRef = useRef<HTMLInputElement>(null);

  // Send mascot page context (on mount + field changes)
  useEffect(() => {
    notifyMascotPageContext({
      page: "character",
      mode: isEditing ? "editing" : "viewing",
      label: `角色编辑 · ${name || "新角色"}`,
      fields: {
        _characterId: char.id || "",
        name,
        persona,
        personality,
        timeZone,
      },
    });
  }, [isEditing, name, persona, personality, timeZone, char.id]);

  // Listen for mascot fill events (unified)
  useEffect(() => {
    const onFill = (e: Event) => {
      const { field, value } = (e as CustomEvent).detail;
      if (field === "name") setName(value);
      else if (field === "persona") setPersona(value);
      else if (field === "personality") setPersonality(value);
      else if (field === "timeZone") {
        setTimeZone(value);
        setTimeZoneSearch(value);
      }
    };
    window.addEventListener("mascot-fill-field", onFill);
    return () => window.removeEventListener("mascot-fill-field", onFill);
  }, []);

  // Reset mascot context on unmount
  useEffect(() => {
    return () => {
      notifyMascotPageContext({ page: "desktop", mode: "idle", label: "桌面", fields: {} });
    };
  }, []);

  // Dirty check — compare current edit state vs original char
  function isDirty(): boolean {
    if (!isEditing) return false;
    if (name !== (char.name || "")) return true;
    if (persona !== (char.persona || "")) return true;
    if (personality !== (char.personality || "")) return true;
    if (briefPersona !== (char.briefPersona || "")) return true;
    if (timeZone !== (char.timeZone || "")) return true;
    if (avatar !== (char.avatar || null)) return true;
    if (cardColor !== (char.cardColor || FALLBACK_CARD_COLOR)) return true;
    const origTags = char.tags || [];
    if (tags.length !== origTags.length || tags.some((t, i) => t !== origTags[i])) return true;
    return false;
  }

  function handleBack() {
    if (isDirty()) {
      setShowUnsavedConfirm("back");
    } else {
      onBack();
    }
  }

  useEffect(() => {
    if (!isEditing) {
      setName(char.name || "");
      setPersona(char.persona || "");
      setPersonality(char.personality || "");
      setBriefPersona(char.briefPersona || "");
      setBriefError("");
      setTimeZone(char.timeZone || "");
      setTimeZoneSearch(char.timeZone || "");
      setShowTimeZonePicker(false);
      setTags(char.tags || []);
      setAvatar(char.avatar || null);
      setCardColor(char.cardColor || FALLBACK_CARD_COLOR);
    }
  }, [isEditing, char]);

  async function handleAvatarFile(file: File) {
    const url = await fileToDataUrl(file);
    setAvatar(url);
  }

  function handleAvatarUrl() {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setAvatar(trimmed);
    setShowUrlInput(false);
    setUrlInput("");
  }

  function handleAddTag() {
    const t = tagInput.trim();
    if (!t) return;
    const split = t.split(/[,，]/).map(x => x.trim()).filter(Boolean);
    const newTags = Array.from(new Set([...tags, ...split]));
    setTags(newTags);
    setTagInput("");
  }

  function handleSave() {
    const trimmedTimeZone = timeZone.trim();
    const normalizedTimeZone = trimmedTimeZone ? normalizeTimeZone(trimmedTimeZone) : undefined;
    if (onSave) {
      const trimmedBrief = briefPersona.trim();
      onSave({
        name: name.trim() || char.name || "UNNAMED",
        persona,
        personality: personality.trim() || undefined,
        briefPersona: trimmedBrief || undefined,
        // 简介变动才刷新时间戳；未动则保留原值（供「设定已更新」过期提示判断）
        briefPersonaUpdatedAt: trimmedBrief
          ? (trimmedBrief !== (char.briefPersona || "").trim() ? new Date().toISOString() : char.briefPersonaUpdatedAt)
          : undefined,
        timeZone: normalizedTimeZone,
        tags,
        avatar: avatar ?? null,
        cardColor,
      });
    }
  }

  async function handleGenerateBrief() {
    if (briefBusy) return;
    setBriefBusy(true);
    setBriefError("");
    try {
      const text = await generateBriefPersonaText({
        ...char,
        name: name.trim() || char.name || "未命名角色",
        persona,
        personality: personality.trim() || undefined,
      });
      setBriefPersona(text);
    } catch (error) {
      setBriefError(error instanceof Error ? error.message : String(error));
    } finally {
      setBriefBusy(false);
    }
  }

  // Helper limits
  const personaText = persona || "NO DATA AVAILABLE.";
  const timeZoneOptions = getCharacterTimeZoneOptions(timeZone || timeZoneSearch);
  const timeZoneQuery = timeZoneSearch.trim().toLowerCase();
  const matchedTimeZoneOptions = timeZoneQuery
    ? timeZoneOptions.filter(option => option.toLowerCase().includes(timeZoneQuery))
    : timeZoneOptions;
  const filteredTimeZoneOptions = matchedTimeZoneOptions.slice(0, 80);
  const hasMoreTimeZoneOptions = matchedTimeZoneOptions.length > filteredTimeZoneOptions.length;

  function openTimeZonePicker() {
    setTimeZoneSearch(timeZone);
    setShowTimeZonePicker(true);
  }

  function closeTimeZonePicker() {
    setShowTimeZonePicker(false);
  }

  function selectTimeZoneOption(option: string) {
    setTimeZone(option);
    setTimeZoneSearch(option);
    setShowTimeZonePicker(false);
  }

  function applyTimeZoneSearch() {
    setTimeZone(timeZoneSearch.trim());
    setShowTimeZonePicker(false);
  }

  function clearTimeZone() {
    setTimeZone("");
    setTimeZoneSearch("");
    setShowTimeZonePicker(false);
  }

  const archiveFrame = (
      <div className="char-archive-frame">
        <div className="char-archive-header">
          <div>
            <div className="char-archive-title">{isEditing ? "EDITING ARCHIVE" : "ARCHIVAL\nINFORMATION"}</div>
            <div className="char-archive-subtitle">THE INTELLIGENCE DATABASE</div>
          </div>
        </div>

        <div className="char-archive-body">
          <div className="char-archive-left">
            <div
              className="char-archive-photo relative"
              style={{ cursor: isEditing ? "pointer" : "default" }}
              onClick={() => {
                if (isEditing) {
                  fileRef.current?.click();
                }
              }}
            >
              {avatar ? (
                <img src={avatar} alt="Avatar" />
              ) : (
                <CharAvatarFallback name={name || char.name} size="100%" />
              )}
              {isEditing && (
                <div className="absolute inset-0 bg-black/30 flex flex-col items-center justify-center pointer-events-none text-white">
                  <IconCamera size={24} />
                  <span className="ts-10 mt-1">Change Photo</span>
                </div>
              )}
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) await handleAvatarFile(file);
                e.target.value = "";
              }}
            />
            {isEditing && (
              <div className="mt-2 flex flex-col gap-1 w-full justify-center">
                <button
                  className="ts-10 px-3 py-1 bg-[#111111] text-white border-none rounded-full cursor-pointer hover:bg-[#222222] transition-colors"
                  onClick={() => setShowUrlInput((v) => !v)}
                >
                  Use IMG URL
                </button>
                {showUrlInput && (
                  <div className="flex gap-1 mt-1">
                    <input
                      className="flex-1 ts-10 p-1 border border-[var(--c-input-border)] rounded w-full min-w-0"
                      placeholder="Image URL..."
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAvatarUrl();
                      }}
                    />
                    <button
                      className="ts-10 px-2 py-1 bg-[#444] text-white border-none rounded cursor-pointer"
                      onClick={handleAvatarUrl}
                    >OK</button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="char-archive-right flex-1 flex flex-col">

            {/* Name Box moved to the top of Right Column */}
            <div className="char-archive-name-box flex-1 flex flex-col justify-center text-left border-b border-[var(--c-panel-border)]" style={{ padding: "4px 6px 8px 6px" }}>
              <span className="ts-8 text-[var(--c-text)] font-mono block mb-0.5">TARGET NAME / CODENAME</span>
              {isEditing ? (
                <input
                  className="char-archive-input ts-20 font-black w-full text-left bg-[var(--c-input)]/50 border border-dashed border-[#666] font-inherit tracking-[1px]"
                  placeholder="Name or Codename"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{
                    padding: "2px 4px",
                  }}
                />
              ) : (
                <h2 className="whitespace-pre-wrap break-words ts-20 font-black m-0 tracking-[1px]">
                  {name || "UNNAMED"}
                </h2>
              )}
            </div>

            <div className="char-archive-row">
              <div className="char-archive-cell" style={{ flex: 0.8 }}>
                <span className="char-archive-label">Status</span>
                <span className="char-archive-val">{isEditing ? "EDITING" : "ACTIVE"}</span>
              </div>
              <div className="char-archive-cell" style={{ flex: 1.5 }}>
                <span className="char-archive-label">WeChat</span>
                <span className="char-archive-val select-text cursor-text tracking-[-0.5px]">
                  {char.wechatID || "N/A"}
                </span>
              </div>
              <div className="char-archive-cell" style={{ flex: 1.1 }}>
                <span className="char-archive-label">Update</span>
                <span className="char-archive-val">{char.updatedAt ? char.updatedAt.slice(0, 10).replace(/-/g, "/") : "N/A"}</span>
              </div>
            </div>

          </div>
        </div>

        <div className="char-archive-row">
          <div className="char-archive-cell" style={{ flex: 1 }}>
            <span className="char-archive-label">Card Color</span>
            {isEditing ? (
              <div className="flex flex-col gap-2 mt-1">
                <div className="flex items-center gap-2">
                  <span
                    className="rounded-full shrink-0"
                    style={{ width: 20, height: 20, background: cardColor, border: "1px solid rgba(0,0,0,0.2)" }}
                  />
                  <span className="char-archive-val tracking-[0.5px]">{cardColor.toUpperCase()}</span>
                </div>
                <ColorWheelPicker value={cardColor} onChange={setCardColor} />
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1">
                <span
                  className="rounded-full shrink-0"
                  style={{ width: 16, height: 16, background: char.cardColor || FALLBACK_CARD_COLOR, border: "1px solid rgba(0,0,0,0.2)" }}
                />
                <span className="char-archive-val tracking-[0.5px]">{(char.cardColor || FALLBACK_CARD_COLOR).toUpperCase()}</span>
              </div>
            )}
          </div>
        </div>

        <div className="char-archive-row">
          <div className="char-archive-cell" style={{ flex: 1.8 }}>
            <span className="char-archive-label">Tags</span>
            <div className="flex flex-wrap gap-2">
              {tags.map((t, i) => (
                <div key={i} className="char-archive-tag">
                  {t}
                  {isEditing && (
                    <button
                      onClick={() => setTags(tags.filter((_, idx) => idx !== i))}
                      className="bg-none border-none ml-1 cursor-pointer opacity-60 ts-12 p-0"
                    >×</button>
                  )}
                </div>
              ))}
              {tags.length === 0 && !isEditing && (
                <span className="char-archive-val opacity-50">N/A</span>
              )}
              {isEditing && (
                <div className="flex gap-1 w-full mt-1">
                  <input
                    className="char-archive-tag-input flex-1 min-w-0"
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddTag(); } }}
                    placeholder="Add tag..."
                  />
                  <button onClick={handleAddTag} className="bg-[#4a3f2f] text-white border-none rounded-[2px] px-2 ts-10 cursor-pointer">ADD</button>
                </div>
              )}
            </div>
          </div>
          <div className="char-archive-cell" style={{ flex: 1.2 }}>
            <span className="char-archive-label">Timezone</span>
            {isEditing ? (
              <div className="char-timezone-picker">
                <button
                  type="button"
                  className="char-timezone-trigger"
                  onClick={openTimeZonePicker}
                >
                  {timeZone || "SYSTEM"}
                </button>
              </div>
            ) : (
              <span className="char-archive-val">{timeZone || "SYSTEM"}</span>
            )}
          </div>
        </div>

        {/* Persona Section (Full Width) */}
        <div className="char-archive-text-section border-b-0">
          <div className="char-log-entry mb-4">
            <div className="char-log-entry-header">
              <span>PERSONA / TRAITS</span>
            </div>
            {isEditing ? (
              <AutoResizingTextarea
                value={persona}
                onChange={setPersona}
                placeholder="Describe background, personality..."
                minHeight={120}
                style={{
                  width: "100%", background: "color-mix(in srgb, var(--c-input) 50%, transparent)",
                  border: "1px dashed #666", padding: 8, fontSize: "calc(12px*var(--app-text-scale,1))", lineHeight: 1.5,
                  fontFamily: "inherit", marginTop: 8
                }}
              />
            ) : (
              <p className="char-archive-p whitespace-pre-wrap break-words">{personaText}</p>
            )}
          </div>

          {/* Personality — shown when editing or when has content */}
          {(isEditing || personality.trim()) && (
            <div className="char-log-entry mb-4 border-t border-dashed border-[#999] pt-3">
              <div className="char-log-entry-header">
                <span>PERSONALITY</span>
              </div>
              {isEditing ? (
                <AutoResizingTextarea
                  value={personality}
                  onChange={setPersonality}
                  placeholder="Character personality traits..."
                  minHeight={60}
                  style={{
                    width: "100%", background: "color-mix(in srgb, var(--c-input) 50%, transparent)",
                    border: "1px dashed #666", padding: 8, fontSize: "calc(12px*var(--app-text-scale,1))", lineHeight: 1.5,
                    fontFamily: "inherit", marginTop: 8
                  }}
                />
              ) : (
                <p className="char-archive-p whitespace-pre-wrap break-words">{personality}</p>
              )}
            </div>
          )}

          {/* 简量人设 — 注入到同世界有关系角色的上下文，防对方 OOC */}
          {(isEditing || briefPersona.trim()) && (
            <div className="char-log-entry mb-4 border-t border-dashed border-[#999] pt-3">
              <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                <span className="char-log-entry-header !mb-0">BRIEF PERSONA / 简量人设</span>
                {isEditing && (
                  <button
                    className="ts-10 px-3 py-1 bg-[#111111] text-white border-none rounded-full cursor-pointer disabled:opacity-50 hover:bg-[#222222] transition-colors"
                    disabled={briefBusy}
                    onClick={handleGenerateBrief}
                  >
                    {briefBusy ? "生成中…" : briefPersona.trim() ? "重新生成" : "AI 生成"}
                  </button>
                )}
              </div>
              <p className="ts-10 opacity-60 mt-1">
                会注入给同世界与 TA 有关系的角色，帮助对方提到 TA 时不 OOC。
                {!isEditing && isBriefPersonaStale(char) ? " ⚠ 设定已更新，建议重新生成简介。" : ""}
              </p>
              {briefError && <p className="ts-10 mt-1" style={{ color: "#b4233b" }}>{briefError}</p>}
              {isEditing ? (
                <AutoResizingTextarea
                  value={briefPersona}
                  onChange={setBriefPersona}
                  placeholder="点「AI 生成」自动压缩人设，或手写 100~200 字简介…"
                  minHeight={60}
                  style={{
                    width: "100%", background: "color-mix(in srgb, var(--c-input) 50%, transparent)",
                    border: "1px dashed #666", padding: 8, fontSize: "calc(12px*var(--app-text-scale,1))", lineHeight: 1.5,
                    fontFamily: "inherit", marginTop: 8
                  }}
                />
              ) : (
                <p className="char-archive-p whitespace-pre-wrap break-words">{briefPersona}</p>
              )}
            </div>
          )}

        </div>

        <div className="char-archive-actions">
          {!dummy && confirmDelete ? (
            <div className="char-confirm-row">
              <span className="char-confirm-text">CONFIRM DELETE?</span>
              <button className="char-confirm-yes" onClick={onDelete}>YES</button>
              <button className="char-confirm-no" onClick={() => setConfirmDelete(false)}>NO</button>
            </div>
          ) : (
            !dummy && isEditing ? (
              <>
                <button className="char-archive-btn char-archive-btn-danger" onClick={() => { if (isDirty()) { setShowUnsavedConfirm("cancel"); } else { onCancelEdit?.(); } }}>CANCEL</button>
                <button className="char-archive-btn bg-[var(--c-text)] text-[var(--c-page-body-bg)] border-[var(--c-input-border)]" onClick={handleSave}>SAVE</button>
              </>
            ) : !dummy && !isEditing ? (
              <>
                <button className="char-archive-btn" onClick={onExportPng}>EXPORT IMG</button>
                <button className="char-archive-btn" onClick={onExportJson}>EXPORT JSON</button>
                <button className="char-archive-btn char-archive-btn-danger" onClick={() => setConfirmDelete(true)}>DELETE</button>
              </>
            ) : null
          )}
        </div>
      </div>
  );

  if (dummy) {
    return (
      <div className="char-archive-view" style={{ pointerEvents: "none" }}>
        {archiveFrame}
      </div>
    );
  }

  return (
    <PageShell
      title=""
      onBack={handleBack}
      className="bg-[var(--c-page-body-bg)]"
      rightAction={!isEditing ? (
        <button className="char-action-btn" onClick={onEdit}>
          <IconEdit />
        </button>
      ) : undefined}
    >
      {archiveFrame}

      {isEditing && showTimeZonePicker && (
        <div
          className="char-timezone-sheet-backdrop"
          onPointerDown={e => {
            if (e.target === e.currentTarget) closeTimeZonePicker();
          }}
        >
          <div className="char-timezone-sheet" role="dialog" aria-modal="true" aria-label="Timezone">
            <div className="char-timezone-sheet-header">
              <span>TIMEZONE</span>
              <button type="button" onClick={closeTimeZonePicker}>CLOSE</button>
            </div>
            <input
              className="char-timezone-search"
              value={timeZoneSearch}
              onChange={e => setTimeZoneSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") {
                  closeTimeZonePicker();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (filteredTimeZoneOptions[0]) selectTimeZoneOption(filteredTimeZoneOptions[0]);
                  else applyTimeZoneSearch();
                }
              }}
              placeholder="Asia/Shanghai"
              spellCheck={false}
              autoFocus
            />
            <div className="char-timezone-sheet-actions">
              <button type="button" onClick={clearTimeZone}>SYSTEM</button>
              <button type="button" onClick={applyTimeZoneSearch}>DONE</button>
            </div>
            <div className="char-timezone-options" role="listbox">
              {filteredTimeZoneOptions.length > 0 ? (
                <>
                  {filteredTimeZoneOptions.map(option => (
                    <button
                      key={option}
                      type="button"
                      className="char-timezone-option"
                      onClick={() => selectTimeZoneOption(option)}
                      role="option"
                      aria-selected={option === timeZone}
                    >
                      {option}
                    </button>
                  ))}
                  {hasMoreTimeZoneOptions && (
                    <div className="char-timezone-more">MORE RESULTS</div>
                  )}
                </>
              ) : (
                <div className="char-timezone-empty">NO MATCHES</div>
              )}
            </div>
          </div>
        </div>
      )}



      {/* Unsaved changes confirmation dialog */}
      {showUnsavedConfirm && (
        <ConfirmDialog
          title="确定要放弃编辑吗？"
          message="当前编辑内容尚未保存，离开后所有更改将丢失。"
          icon={AlertCircle}
          variant="danger"
          confirmLabel="放弃更改"
          cancelLabel="继续编辑"
          onConfirm={() => {
            const action = showUnsavedConfirm;
            setShowUnsavedConfirm(null);
            if (action === "back") onBack();
            else onCancelEdit?.();
          }}
          onCancel={() => setShowUnsavedConfirm(null)}
        />
      )}
    </PageShell>
  );
}

// The CharEditView component has been removed as editing is now inline within CharArchiveView.

// ── 共享子组件 ───────────────────────────────────────

function CharAvatarFallback({
  name,
  size,
}: {
  name: string;
  size: number | string;
}) {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    fontSize: typeof size === "number" ? Math.round(size * 0.42) : "2rem",
  };
  return (
    <div className="flex items-center justify-center shrink-0 text-white font-bold" style={{ ...style, background: "linear-gradient(135deg, #7a8088, #5a6068)", fontFamily: "var(--app-font-family)" }}>
      {(name ?? "U").charAt(0).toUpperCase() || "?"}
    </div>
  );
}

function AutoResizingTextarea({
  value,
  onChange,
  placeholder,
  style,
  minHeight = 60,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  minHeight?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // useLayoutEffect（绘制前同步执行）：把"塌成一行→撑回真实高度"放在同一帧、绘制之前完成，
  // 避免某些内核（如小米浏览器）把中间那帧的高度骤减画出来、并因文档变矮把视口往上夹/拉。
  // 同时记录并还原最近可滚动祖先的 scrollTop，作为对 reflow 滚动锚定的额外保护。
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    let scroller: HTMLElement | null = ta.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if ((oy === "auto" || oy === "scroll") && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    const prevTop = scroller ? scroller.scrollTop : window.scrollY;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(minHeight, ta.scrollHeight)}px`;
    if (scroller) {
      if (scroller.scrollTop !== prevTop) scroller.scrollTop = prevTop;
    } else if (window.scrollY !== prevTop) {
      window.scrollTo(0, prevTop);
    }
  }, [value, minHeight]);

  return (
    <textarea
      ref={textareaRef}
      className="resize-none overflow-hidden"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        ...style,
        minHeight,
      }}
    />
  );
}

// ── 工具函数 ─────────────────────────────────────────

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX_SIZE = 400;
        let w = img.width;
        let h = img.height;
        if (w > MAX_SIZE || h > MAX_SIZE) {
          if (w > h) {
            h = Math.round(h * MAX_SIZE / w);
            w = MAX_SIZE;
          } else {
            w = Math.round(w * MAX_SIZE / h);
            h = MAX_SIZE;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(reader.result as string);
        ctx.drawImage(img, 0, 0, w, h);

        // Use webp or jpeg to heavily compress large png files before saving to localstorage
        resolve(canvas.toDataURL("image/webp", 0.8));
      };
      img.onerror = () => resolve(reader.result as string); // fallback to raw
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── 图标 ─────────────────────────────────────────────

function IconBack() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function IconImport() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function IconLink() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function IconSparkles() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  );
}

/* 底部装饰栏用的三个图标：纯点缀，不绑定任何交互 */
function IconArchiveBoxDecor() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4.913 2.658c2.075-.27 4.19-.408 6.337-.408 2.147 0 4.262.139 6.337.408 1.922.25 3.291 1.861 3.405 3.727a4.403 4.403 0 0 0-1.032-.211 50.89 50.89 0 0 0-8.42 0c-2.358.196-4.04 2.19-4.04 4.434v4.286a4.47 4.47 0 0 0 2.433 3.984L7.28 21.53A.75.75 0 0 1 6 21v-4.03a48.527 48.527 0 0 1-1.087-.128C2.905 16.58 1.5 14.833 1.5 12.862V6.638c0-1.97 1.405-3.718 3.413-3.979Z" />
      <path d="M15.75 7.5c-1.376 0-2.739.057-4.086.169C10.124 7.797 9 9.103 9 10.609v4.285c0 1.507 1.128 2.814 2.67 2.94 1.243.102 2.5.157 3.768.165l2.782 2.781a.75.75 0 0 0 1.28-.53v-2.39l.33-.026c1.542-.125 2.67-1.433 2.67-2.94v-4.286c0-1.505-1.125-2.811-2.664-2.94A49.392 49.392 0 0 0 15.75 7.5Z" />
    </svg>
  );
}

function IconHomeDecor() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.47 3.841a.75.75 0 0 1 1.06 0l8.69 8.69a.75.75 0 1 0 1.06-1.061l-8.689-8.69a2.25 2.25 0 0 0-3.182 0l-8.69 8.69a.75.75 0 1 0 1.061 1.06l8.69-8.689Z" />
      <path d="m12 5.432 8.159 8.159c.03.03.06.058.091.086v6.198c0 1.035-.84 1.875-1.875 1.875H15a.75.75 0 0 1-.75-.75v-4.5a.75.75 0 0 0-.75-.75h-3a.75.75 0 0 0-.75.75V21a.75.75 0 0 1-.75.75H5.625a1.875 1.875 0 0 1-1.875-1.875v-6.198a2.29 2.29 0 0 0 .091-.086L12 5.432Z" />
    </svg>
  );
}

function IconInboxTrayDecor() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M1.5 8.67v8.58a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3V8.67l-8.928 5.493a3 3 0 0 1-3.144 0L1.5 8.67Z" />
      <path d="M22.5 6.908V6.75a3 3 0 0 0-3-3h-15a3 3 0 0 0-3 3v.158l9.714 5.978a1.5 1.5 0 0 0 1.572 0L22.5 6.908Z" />
    </svg>
  );
}

/** 底部装饰栏：世界文件夹条下方一条延伸到屏幕两侧的毛玻璃条，
 *  三个图标等距排布，纯视觉点缀，不承载任何交互 */
function DecorativeDockBar() {
  return (
    <div className="ccf-dock-bar" aria-hidden="true">
      <span className="ccf-dock-icon"><IconArchiveBoxDecor /></span>
      <span className="ccf-dock-icon"><IconHomeDecor /></span>
      <span className="ccf-dock-icon"><IconInboxTrayDecor /></span>
    </div>
  );
}

function IconCamera({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"></path>
      <circle cx="12" cy="14" r="3"></circle>
    </svg>
  );
}

// ── 组件实现 ─────────────────────────────────────────────

// ── NPC 生成器 ─────────────────────────────────────────────
// 「生成配角」弹层：选目标角色 + 可选要求 → LLM 生成完整角色卡 → 预览可编辑 → 确认落库。
// 生成逻辑见 lib/npc-generator.ts；落库动作在父组件 handleNpcGenerated。
function NpcGeneratorSheet({ characters, onClose, onConfirm }: {
  characters: Character[];
  onClose: () => void;
  onConfirm: (results: GeneratedSupportingCharacter[], targetId: string, allowAutoPost: boolean) => void;
}) {
  const [targetId, setTargetId] = useState(characters[0]?.id ?? "");
  const [hint, setHint] = useState("");
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<GeneratedSupportingCharacter[] | null>(null);
  const [allowAutoPost, setAllowAutoPost] = useState(false);

  const targetName = characters.find(c => c.id === targetId)?.name ?? "";

  async function handleGenerate() {
    if (!targetId || busy) return;
    setBusy(true);
    setError("");
    try {
      const generated = await generateSupportingCharacters(targetId, hint, count);
      setResults(generated);
      if (generated.length < count) {
        setError(`本次只成功解析出 ${generated.length} 位配角，可直接使用或重新生成。`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const patchAt = (index: number, partial: Partial<GeneratedSupportingCharacter>) => {
    setResults(prev => (prev ? prev.map((item, i) => (i === index ? { ...item, ...partial } : item)) : prev));
  };
  const removeAt = (index: number) => {
    setResults(prev => {
      const next = prev ? prev.filter((_, i) => i !== index) : prev;
      return next && next.length > 0 ? next : null; // 全删了就回到生成表单
    });
  };
  const confirmDisabled = busy
    || !results
    || results.length === 0
    || results.some(r => !r.name.trim() || !r.persona.trim());

  return (
    <div
      className="wt-modal"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="wt-paper"
        onClick={e => e.stopPropagation()}
      >
        <div className="wt-paper-kicker text-center">
          {results ? "REVIEW NPC" : "GENERATE NPC"}
        </div>

        {!results ? (
          <div className="flex flex-col">
            <label className="wt-paper-label">为哪位角色生成配角</label>
            <select className="wt-paper-input" value={targetId} onChange={e => setTargetId(e.target.value)}>
              {characters.map(c => (
                <option key={c.id} value={c.id}>{c.name || "未命名角色"}</option>
              ))}
            </select>
            <label className="wt-paper-label mt-2">生成数量</label>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map(n => (
                <button
                  key={n}
                  type="button"
                  className={`wt-btn flex-1 ${count === n ? "wt-btn-primary" : ""}`}
                  onClick={() => setCount(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <label className="wt-paper-label mt-2">补充要求（可选）</label>
            <textarea
              className="wt-paper-textarea"
              style={{ minHeight: 64 }}
              value={hint}
              onChange={e => setHint(e.target.value)}
            />
            {error && <p className="wt-paper-confirm mt-2">{error}</p>}

            <div className="wt-paper-actions mt-4">
              <button className="wt-btn flex-1" onClick={onClose} disabled={busy}>取消</button>
              <button
                className="wt-btn wt-btn-primary flex-1"
                onClick={handleGenerate}
                disabled={busy || !targetId}
              >
                {busy ? "生成中…" : "生成"}
              </button>
            </div>
            {characters.length === 0 && <p className="wt-paper-hint mt-2">还没有角色，先创建一位主角。</p>}
          </div>
        ) : (
          <div className="flex flex-col">
            {results.map((result, index) => (
              <div key={index} className={index > 0 ? "mt-4 pt-3" : ""} style={index > 0 ? { borderTop: "1px dashed #c9b98a" } : undefined}>
                <div className="flex items-center">
                  <span className="wt-paper-kicker" style={{ marginBottom: 0 }}>NPC {index + 1} / {results.length}</span>
                  <span className="wt-paper-spacer" />
                  {results.length > 1 && (
                    <button type="button" className="wt-btn wt-btn-danger wt-btn-small" onClick={() => removeAt(index)}>
                      移除
                    </button>
                  )}
                </div>

                <label className="wt-paper-label mt-2">名字</label>
                <input className="wt-paper-input" value={result.name} onChange={e => patchAt(index, { name: e.target.value })} />

                <label className="wt-paper-label mt-2">人设（完整角色卡）</label>
                <textarea
                  className="wt-paper-textarea"
                  style={{ minHeight: 120 }}
                  value={result.persona}
                  onChange={e => patchAt(index, { persona: e.target.value })}
                />

                <label className="wt-paper-label mt-2">性格</label>
                <input className="wt-paper-input" value={result.personality} onChange={e => patchAt(index, { personality: e.target.value })} />

                <label className="wt-paper-label mt-2">简量人设（注入给同世界角色）</label>
                <textarea
                  className="wt-paper-textarea"
                  style={{ minHeight: 64 }}
                  value={result.briefPersona}
                  onChange={e => patchAt(index, { briefPersona: e.target.value })}
                />

                <div className="flex gap-2 mt-2">
                  <div className="flex-1 flex flex-col">
                    <label className="wt-paper-label">TA 是{targetName}的</label>
                    <input className="wt-paper-input" value={result.relationLabel} onChange={e => patchAt(index, { relationLabel: e.target.value })} />
                  </div>
                  <div className="flex-1 flex flex-col">
                    <label className="wt-paper-label">{targetName}是 TA 的</label>
                    <input className="wt-paper-input" value={result.reverseRelationLabel} onChange={e => patchAt(index, { reverseRelationLabel: e.target.value })} />
                  </div>
                </div>
              </div>
            ))}

            <label className="flex items-center gap-2 mt-3 wt-paper-label" style={{ fontWeight: 'normal' }}>
              <input type="checkbox" checked={allowAutoPost} onChange={e => setAllowAutoPost(e.target.checked)} />
              加好友后允许自动发朋友圈（本批全部生效）
            </label>

            {error && <p className="wt-paper-confirm mt-2">{error}</p>}

            <div className="wt-paper-actions mt-4">
              <button className="wt-btn flex-1" onClick={handleGenerate} disabled={busy}>
                {busy ? "生成中…" : "重新生成"}
              </button>
              <button
                className="wt-btn wt-btn-primary flex-1"
                disabled={confirmDisabled}
                onClick={() => results && onConfirm(results, targetId, allowAutoPost)}
              >
                {results.length > 1 ? `确认创建 ${results.length} 位` : "确认创建"}
              </button>
            </div>

            <div className="flex mt-2">
              <button className="wt-btn flex-1" onClick={onClose} disabled={busy}>取消</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
