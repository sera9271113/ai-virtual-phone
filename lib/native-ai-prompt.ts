import type { Character } from "./character-types";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { loadMemoryConfig } from "./memory-storage";
import { prepareShortTermContext } from "./short-term-assembler";
import {
  loadBindingConfig,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";

type NativeCharacterContext = {
  character: Character;
  coreMemories: string;
  longTermMemories: string;
  recentBlocks: ReturnType<typeof prepareShortTermContext>["recentBlocks"];
  unifiedRecentItems: ReturnType<typeof prepareShortTermContext>["unifiedRecentItems"];
  worldBookActivationContext: string;
};

function briefPersona(character: Character): string {
  return character.briefPersona?.trim()
    || [character.persona?.trim(), character.personality?.trim()].filter(Boolean).join("\n").slice(0, 600)
    || "（暂无简短人设）";
}

async function loadCharacterContext(character: Character, appId: string, instruction: string): Promise<NativeCharacterContext> {
  const shortTerm = prepareShortTermContext(character.id, appId);
  const memoryConfig = loadMemoryConfig();
  const recallContext = [instruction, shortTerm.wbActivationContext].filter(Boolean).join("\n");
  const [longTerm, core] = await Promise.all([
    retrieveMemoriesForPrompt(character.id, recallContext, memoryConfig).catch(() => []),
    retrieveCoreMemoriesForPrompt(character.id, memoryConfig).catch(() => []),
  ]);
  return {
    character,
    coreMemories: formatCoreMemories(core),
    longTermMemories: formatLongTermMemories(longTerm),
    recentBlocks: shortTerm.recentBlocks,
    unifiedRecentItems: shortTerm.unifiedRecentItems,
    worldBookActivationContext: shortTerm.wbActivationContext,
  };
}

export async function buildNativeAiMessages(
  character: Character,
  appId: string,
  appTags: string[],
  instruction: string,
  relatedCharacters: Character[] = [],
): Promise<{ messages: LLMMessage[]; preset: ReturnType<typeof loadPresets>[number] | null; regexes: ReturnType<typeof loadRegexes> }> {
  const slot = resolveBinding(loadBindingConfig(), character.id, appId);
  const presets = loadPresets();
  const preset = (slot.presetId ? presets.find(item => item.id === slot.presetId) : null)
    ?? presets.find(item => item.builtIn)
    ?? null;
  const allWorldBooks = loadWorldBooks();
  const worldBooks = (slot.worldBookIds || [])
    .map(id => allWorldBooks.find(item => item.id === id))
    .filter((item): item is (typeof allWorldBooks)[number] => Boolean(item));
  const allRegexes = loadRegexes();
  const regexes = (slot.regexIds || [])
    .map(id => allRegexes.find(item => item.id === id))
    .filter((item): item is (typeof allRegexes)[number] => Boolean(item));
  const userIdentity = resolveUserIdentity(character.id, appId);
  const primaryContext = await loadCharacterContext(character, appId, instruction);
  const messages = assemblePromptPayload({
    character,
    history: [],
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId,
    appTags,
    coreMemories: primaryContext.coreMemories,
    longTermMemories: primaryContext.longTermMemories,
    recentBlocks: primaryContext.recentBlocks,
    unifiedRecentItems: primaryContext.unifiedRecentItems,
    worldBookActivationContext: primaryContext.worldBookActivationContext,
  });
  const relatedContext = relatedCharacters.filter(item => item.id !== character.id).map(item => [
    `【参与角色：${item.name}】`,
    `简短人设：${briefPersona(item)}`,
  ].filter(Boolean).join("\n")).join("\n\n");
  return {
    messages: [
      ...messages,
      ...(relatedContext ? [{ role: "system" as const, content: `以下是本次其他参与角色的上下文，请共同保持角色一致性：\n\n${relatedContext}` }] : []),
      { role: "user", content: instruction },
    ],
    preset,
    regexes,
  };
}