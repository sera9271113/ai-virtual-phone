// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

export type MemoryStatus = "active" | "sleeping" | "archived";

// ── Memory domains (记忆分域) ──
// Orthogonal classification dimension layered on top of long-term/core memories.
// Does not affect scoreMemoryEntry / cosineSimilarity / short-term or shared-memory logic.
export type MemoryDomain =
    | "bond" | "impression" | "monologue" | "footprint"
    | "anecdote" | "puzzle" | "vow" | "misc";

export const MEMORY_DOMAIN_ORDER: MemoryDomain[] = [
    "bond", "impression", "monologue", "footprint",
    "anecdote", "puzzle", "vow", "misc",
];

export const MEMORY_DOMAIN_LABELS: Record<MemoryDomain, string> = {
    bond: "情缘羁绊",
    impression: "点滴印象",
    monologue: "自我独白",
    footprint: "同行印记",
    anecdote: "见闻拾遗",
    puzzle: "未解之惑",
    vow: "未竟之约",
    misc: "零光片羽", // 排除法兜底域，区别于"未分类"技术兜底
};

/** Per-domain focus text used to build domain-scoped core-memory prompts. */
export const MEMORY_DOMAIN_FOCUS: Record<MemoryDomain, string> = {
    bond: "确认在一起/确认分手/复合、订婚/结婚/离婚、恋爱周年、结婚纪念日、在一起多久、明确的长期关系身份（如恋人、前任、配偶）、共同生活的重要里程碑（如同居、见家长、共同养宠物）",
    impression: "用户的生日、职业、习惯、家庭、雷点等稳定事实（主语是用户）",
    monologue: "角色自己做出的决定、态度转变、坚持的边界（主语是角色本人）",
    footprint: "双方共同做过的具体事件、共同养成的习惯",
    anecdote: "工作学习、爱好、技能等持续性、纯信息性的话题",
    puzzle: "没有回答的问题、没有兑现的承诺、暂时未解决的矛盾",
    vow: "明确说过的以后要做的事、还没到的纪念日",
    misc: "跨类别或边缘内容，确认不属于以上七类后才保留的零散事实",
};

/** Domain判定信号表，供总结/核心记忆 prompt 复用。 */
export const MEMORY_DOMAIN_SIGNALS_TEXT = `- bond（情缘羁绊）：关系身份变化、确认/分手/复合、纪念日、重大承诺
- impression（点滴印象）：用户的生日、职业、习惯、家庭、雷点，主语是用户，信息稳定
- monologue（自我独白）：角色自己的决定、态度转变、坚持的边界，主语是角色本人
- footprint（同行印记）：双方共同做过的事、共同养成的习惯
- anecdote（见闻拾遗）：工作学习、爱好、技能等持续性话题，情绪强度低、纯信息性
- puzzle（未解之惑）：没回答的问题、没兑现的承诺、暂时的矛盾，情绪未闭合
- vow（未竟之约）：明确说过的以后要做的事、还没到的纪念日，时态是将来
- misc（零光片羽）：逐一比对以上七类判定信号都不合适时，才归入此项，不是默认选项`;

export type MemoryMetadata = {
    status?: MemoryStatus;
    lastReadAt?: string;
    readCount?: number;
    valence?: number;            // -1.0（极度负面） 到 +1.0（极度正面）
    arousal?: number;           // 0.0（平静） 到 1.0（极其强烈）
    summarizedEvents?: number;
    summarizedLongTermEntries?: number;
    timeSpan?: string;
    sourceSessionIds?: string[];
    origin?: string;
    appId?: string;
    appName?: string;
    reason?: string;
    sessionId?: string;
    approvedByUser?: boolean;
    editedByUser?: boolean;
    domain?: MemoryDomain;
    domainConfidence?: number;   // 低于阈值（建议0.6）时前端按"未分类"兜底展示
};

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 1-10，旧 0-1 兼容
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    metadata?: MemoryMetadata;
};

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    organizePrompt: string;                 // user-editable prompt template for memory organize (dedup/merge/conflict) suggestions
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 * Output is expected to be structured JSON: { "summaries": [{ content, domain, domainConfidence }] }
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。根据以下事件记录，将其中值得记住的内容拆分成若干条简洁的事实性总结，并为每条标注所属的记忆域。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

记忆域判定信号（每条总结只能属于一个域）：
${MEMORY_DOMAIN_SIGNALS_TEXT}

要求：
- 用第三人称描述{{char}}和用户之间的互动
- 保留关键事实：提到的名字、做出的承诺、情感变化、关系里程碑
- 保留用户分享的具体信息（生日、偏好、习惯）
- 保留朋友圈等非聊天事件中的关键信息
- 同一批事件如果横跨多个域，允许返回多条，每条只属于一个域
- 每条总结按其信息量单独控制在 40-120 字左右，不要为了凑字数塞入不相关内容
- misc 是排除法最后一步，逐一比对前七类都不合适时才选，不是默认选项
- domainConfidence 为 0 到 1 之间的小数，表示分类置信度
- 只返回如下 JSON，不要包含任何其他文字、解释或代码块标记：

{"summaries":[{"content":"……","domain":"bond","domainConfidence":0.92}]}`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}, {{domainFocus}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响判断的事实，侧重点：{{domainFocus}}
- 普通日常聊天、一般情绪波动、暂时性的矛盾或暧昧、普通偏好信息、任何不确定或推测性的内容不要纳入
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

/**
 * Default memory-organize prompt template.
 * Placeholders: {{char}}, {{entries}} (formatted as `[id] content` per line)
 * Output is expected to be structured JSON:
 * { "suggestions": [{ type, entryIds, reason, mergedContent? }] }
 */
export const DEFAULT_ORGANIZE_PROMPT = `你是一个记忆整理助手。以下是{{char}}的一批记忆条目，每行格式为 [id] 内容。请找出其中重复、可合并、或相互矛盾的条目。

记忆条目：
{{entries}}

要求：
- type 为 "重复"：内容基本重复（几乎是同一件事的不同表述），保留一条即可
- type 为 "合并"：仅当内容高度相似（相似度约90%及以上，近乎同一件事只是细节略有出入）时才适用，合并成一条更完整的总结，写入 mergedContent；如果条目之间只是相关或话题接近，但并非高度相似，不要判定为"合并"
- type 为 "矛盾"：内容相互矛盾，无法同时成立
- entryIds 必须是给定条目 id 的子集（通常两条）
- reason 简要说明判断依据
- 如果没有发现任何问题，返回空数组
- 只返回如下 JSON，不要包含任何其他文字、解释或代码块标记：

{"suggestions":[{"type":"重复|合并|矛盾","entryIds":["id1","id2"],"reason":"……","mergedContent":"（仅合并需要）"}]}`;

/** Build a domain-scoped core-memory prompt template by substituting {{domainFocus}}. */
export function buildDomainCoreMemoryPromptTemplate(
    baseTemplate: string,
    domain: MemoryDomain | "unclassified",
): string {
    const focus = domain === "unclassified"
        ? "最关键、最稳定、最影响关系判断的事实"
        : MEMORY_DOMAIN_FOCUS[domain];
    return baseTemplate.replace(/\{\{domainFocus\}\}/gi, focus);
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 100000,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    organizePrompt: DEFAULT_ORGANIZE_PROMPT,
};

// ── Memory organize (整理) suggestion types ──

export type MemoryOrganizeSuggestionType = "重复" | "合并" | "矛盾";

export type MemoryOrganizeSuggestion = {
    id: string;              // 前端本地生成，用于 key/dismiss
    type: MemoryOrganizeSuggestionType;
    entryIds: string[];
    reason: string;
    mergedContent?: string;  // 仅 merge 类型有
};
