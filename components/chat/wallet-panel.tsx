"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, CreditCard, Plus, Trash2 } from "lucide-react";

import { ConfirmDialog } from "@/components/ui";
import { PageShell } from "@/components/ui/page-shell";
import {
  adjustWalletCardAccount,
  createFamilyCard,
  createWalletCard,
  deleteFamilyCard,
  deleteWalletCard,
  formatWalletAmount,
  getWalletBalance,
  loadWalletState,
  transferCardToWalletBalance,
  transferWalletBalanceToCard,
  updateFamilyCardDirection,
  WALLET_UPDATED_EVENT,
} from "@/lib/wallet-storage";
import { createOrGetSession, deleteChatMessage, loadChatContacts, loadChatMessages, loadChatSessions, pushChatMessage } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { FamilyCardDirection, WalletCardStyle, WalletState } from "@/lib/wallet-types";

type WalletPanelProps = {
  onBack?: () => void;
};

function MoneybagIcon({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path stroke="none" d="M0 0h24v24H0z" fill="none" />
      <path d="M9.5 3h5a1.5 1.5 0 0 1 1.5 1.5a3.5 3.5 0 0 1 -3.5 3.5h-1a3.5 3.5 0 0 1 -3.5 -3.5a1.5 1.5 0 0 1 1.5 -1.5" />
      <path d="M4 17v-1a8 8 0 1 1 16 0v1a4 4 0 0 1 -4 4h-8a4 4 0 0 1 -4 -4" />
    </svg>
  );
}

function CardsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path stroke="none" d="M0 0h24v24H0z" fill="none" />
      <path d="M3.604 7.197l7.138 -3.109a.96 .96 0 0 1 1.27 .527l4.924 11.902a1 1 0 0 1 -.514 1.304l-7.137 3.109a.96 .96 0 0 1 -1.271 -.527l-4.924 -11.903a1 1 0 0 1 .514 -1.304l0 .001" />
      <path d="M15 4h1a1 1 0 0 1 1 1v3.5" />
      <path d="M20 6c.264 .112 .52 .217 .768 .315a1 1 0 0 1 .53 1.311l-2.298 5.374" />
    </svg>
  );
}

function FolderDollarIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path stroke="none" d="M0 0h24v24H0z" fill="none" />
      <path d="M13.5 19h-8.5a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v1.5" />
      <path d="M21 15h-2.5a1.5 1.5 0 0 0 0 3h1a1.5 1.5 0 0 1 0 3h-2.5" />
      <path d="M19 21v1m0 -8v1" />
    </svg>
  );
}

function BuildingBankIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path stroke="none" d="M0 0h24v24H0z" fill="none" />
      <path d="M3 21l18 0" />
      <path d="M3 10l18 0" />
      <path d="M5 6l7 -3l7 3" />
      <path d="M4 10l0 11" />
      <path d="M20 10l0 11" />
      <path d="M8 14l0 3" />
      <path d="M12 14l0 3" />
      <path d="M16 14l0 3" />
    </svg>
  );
}

function formatWalletTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getDisplayCardNumber(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "**** **** **** 0000";
  const tail = normalized.replace(/\D/g, "").slice(-4);
  if (!tail) return normalized;
  return `**** **** **** ${tail}`;
}

export function WalletPanel({ onBack }: WalletPanelProps = {}) {
  const [wallet, setWallet] = useState<WalletState>(() => loadWalletState());
  const [activeCardId, setActiveCardId] = useState(() => wallet.defaultCardId || wallet.cards[0]?.id || "");
  const [balanceTransferMode, setBalanceTransferMode] = useState<"deposit" | "withdraw" | null>(null);
  const [transferScope, setTransferScope] = useState<"balance" | "card">("balance");
  const [transferCardId, setTransferCardId] = useState(() => wallet.defaultCardId || wallet.cards[0]?.id || "");
  const [transferLockedCardId, setTransferLockedCardId] = useState<string | null>(null);
  const [transferAmount, setTransferAmount] = useState("100");
  const [addOpen, setAddOpen] = useState(false);
  const [newCardTitle, setNewCardTitle] = useState("储蓄卡");
  const [newCardTail, setNewCardTail] = useState("");
  const [newCardBalance, setNewCardBalance] = useState("0");
  const [newCardStyle, setNewCardStyle] = useState<WalletCardStyle>("graphite");
  const [deleteCardId, setDeleteCardId] = useState<string | null>(null);
  const [deleteFamilyCardId, setDeleteFamilyCardId] = useState<string | null>(null);
  const [familyCardOpen, setFamilyCardOpen] = useState(false);
  const [familyDirection, setFamilyDirection] = useState<FamilyCardDirection>("requested");
  const [familyCharacterId, setFamilyCharacterId] = useState("");
  const [familyLimit, setFamilyLimit] = useState("1000");
  const [familyNote, setFamilyNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const overlayOpen = deleteCardId !== null || deleteFamilyCardId !== null;
  const contactCharacters = useMemo(() => {
    const characters = loadCharacters();
    return loadChatContacts().map(contact => ({
      contact,
      character: characters.find(character => character.id === contact.characterId),
    })).filter((item): item is { contact: ReturnType<typeof loadChatContacts>[number]; character: Character } => Boolean(item.character));
  }, []);

  useEffect(() => {
    const reconcileFamilyCardDirections = () => {
      const currentWallet = loadWalletState();
      for (const card of currentWallet.familyCards) {
        const sourceMessage = loadChatSessions()
          .flatMap(session => loadChatMessages(session.id))
          .reverse()
          .find(message => message.mediaType === "family_card" && message.mediaData?.familyCardId === card.id);
        const sourceDirection = sourceMessage?.mediaData?.familyCardDirection;
        if (sourceDirection && sourceDirection !== card.direction) {
          updateFamilyCardDirection(card.id, sourceDirection);
        }
      }
      return loadWalletState();
    };
    const reconciledWallet = reconcileFamilyCardDirections();
    setWallet(reconciledWallet);
    const syncWallet = () => {
      const next = loadWalletState();
      setWallet(next);
      setActiveCardId(current => next.cards.some(card => card.id === current)
        ? current
        : next.defaultCardId || next.cards[0]?.id || "");
      setTransferCardId(current => next.cards.some(card => card.id === current)
        ? current
        : next.defaultCardId || next.cards[0]?.id || "");
      setTransferLockedCardId(current => current && next.cards.some(card => card.id === current) ? current : null);
    };
    window.addEventListener(WALLET_UPDATED_EVENT, syncWallet);
    return () => window.removeEventListener(WALLET_UPDATED_EVENT, syncWallet);
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: overlayOpen }));
    return () => {
      if (overlayOpen) window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: false }));
    };
  }, [overlayOpen]);

  const activeCard = useMemo(
    () => wallet.cards.find(card => card.id === activeCardId) ?? wallet.cards[0],
    [activeCardId, wallet.cards],
  );
  const selectedTransferCard = useMemo(
    () => wallet.cards.find(card => card.id === transferCardId) ?? wallet.cards[0],
    [transferCardId, wallet.cards],
  );
  const walletBalance = useMemo(() => getWalletBalance(wallet), [wallet]);
  const recentTransactions = useMemo(
    () => wallet.transactions.slice(0, 10),
    [wallet.transactions],
  );

  function refresh(next: WalletState) {
    setWallet(next);
    setActiveCardId(current => next.cards.some(card => card.id === current)
      ? current
      : next.defaultCardId || next.cards[0]?.id || "");
    setTransferCardId(current => next.cards.some(card => card.id === current)
      ? current
      : next.defaultCardId || next.cards[0]?.id || "");
    setTransferLockedCardId(current => current && next.cards.some(card => card.id === current) ? current : null);
  }

  function openBalanceTransfer(mode: "deposit" | "withdraw", options?: { scope?: "balance" | "card"; cardId?: string }) {
    const nextScope = options?.scope ?? "balance";
    const nextLockedCardId = nextScope === "card" ? options?.cardId || activeCard?.id || wallet.defaultCardId || wallet.cards[0]?.id || "" : null;
    if (balanceTransferMode === mode && transferScope === nextScope && transferLockedCardId === nextLockedCardId) {
      closeBalanceTransfer();
      return;
    }
    const nextCardId = options?.cardId || activeCard?.id || wallet.defaultCardId || wallet.cards[0]?.id || "";
    setFamilyCardOpen(false);
    setAddOpen(false);
    setTransferCardId(nextCardId);
    setTransferScope(nextScope);
    setTransferLockedCardId(nextLockedCardId);
    setTransferAmount("100");
    setError(null);
    setBalanceTransferMode(mode);
  }

  function closeBalanceTransfer() {
    setBalanceTransferMode(null);
    setTransferScope("balance");
    setTransferLockedCardId(null);
  }

  function handleBalanceTransfer() {
    if (!selectedTransferCard || !balanceTransferMode) return;
    const result = transferScope === "card"
      ? adjustWalletCardAccount(selectedTransferCard.id, Number(transferAmount), balanceTransferMode === "deposit" ? "in" : "out")
      : balanceTransferMode === "deposit"
        ? transferCardToWalletBalance(selectedTransferCard.id, Number(transferAmount))
        : transferWalletBalanceToCard(selectedTransferCard.id, Number(transferAmount));
    if (!result.ok) {
      setError(result.error ?? (
        transferScope === "card"
          ? balanceTransferMode === "deposit" ? "转入账户失败。" : "转出账户失败。"
          : balanceTransferMode === "deposit" ? "转入失败。" : "提现失败。"
      ));
      return;
    }
    setError(null);
    refresh(result.state);
    closeBalanceTransfer();
  }

  function handleAddCard() {
    const tail = newCardTail.replace(/\D/g, "").slice(-4);
    const next = createWalletCard({
      title: newCardTitle,
      maskedNumber: tail ? `**** **** **** ${tail}` : undefined,
      balance: Number(newCardBalance),
      cardStyle: newCardStyle,
      bankLabel: "CHAT WALLET",
      accentLabel: "储蓄",
      note: "用户手动添加的银行卡",
    });
    setError(null);
    setWallet(next);
    setActiveCardId(next.cards[0]?.id ?? next.defaultCardId);
    setTransferCardId(next.cards[0]?.id ?? next.defaultCardId);
    setAddOpen(false);
    setNewCardTitle("储蓄卡");
    setNewCardTail("");
    setNewCardBalance("0");
    setNewCardStyle("graphite");
  }

  function handleDeleteCard() {
    if (!deleteCardId) return;
    const result = deleteWalletCard(deleteCardId);
    if (!result.ok) {
      setError(result.error ?? "删除失败。");
      setDeleteCardId(null);
      return;
    }
    setError(null);
    refresh(result.state);
    setDeleteCardId(null);
  }

  function handleDeleteFamilyCard() {
    if (!deleteFamilyCardId) return;
    for (const session of loadChatSessions()) {
      for (const message of loadChatMessages(session.id)) {
        if (message.mediaType === "family_card" && message.mediaData?.familyCardId === deleteFamilyCardId) {
          deleteChatMessage(message.id);
        }
      }
    }
    refresh(deleteFamilyCard(deleteFamilyCardId));
    setDeleteFamilyCardId(null);
  }

  function handleCreateFamilyCard() {
    const target = contactCharacters.find(item => item.character.id === familyCharacterId);
    if (!target) {
      setError("请选择角色。");
      return;
    }
    const result = createFamilyCard({
      characterId: target.character.id,
      characterName: target.character.name,
      direction: familyDirection,
      monthlyLimit: Number(familyLimit),
      note: familyNote,
    });
    if (!result.ok || !result.familyCard) {
      setError(result.error ?? "创建亲属卡失败。");
      return;
    }
    const session = createOrGetSession(target.character.id);
    const actionText = familyDirection === "requested" ? "向你索要了一张亲属卡" : "给你开通了一张亲属卡";
    const chatMessage = pushChatMessage({
      sessionId: session.id,
      role: "user",
      content: `【亲属卡】${actionText}`,
      mediaType: "family_card",
      mediaData: {
        status: "pending",
        familyCardId: result.familyCard.id,
        familyCardDirection: familyDirection,
        familyCardLimit: result.familyCard.monthlyLimit,
        familyCardNote: result.familyCard.note,
      },
    });
    window.dispatchEvent(new CustomEvent("chat-messages-updated", {
      detail: { sessionId: session.id, message: chatMessage },
    }));
    setError(null);
    refresh(result.state);
    setFamilyCardOpen(false);
    setFamilyCharacterId("");
    setFamilyLimit("1000");
    setFamilyNote("");
  }

  const transferCardLocked = transferScope === "card" || Boolean(transferLockedCardId);
  const transferTitle = transferScope === "card"
    ? balanceTransferMode === "withdraw" ? "转出账户" : "转入账户"
    : balanceTransferMode === "withdraw" ? "提现到银行卡" : "银行卡转入余额";
  const transferInputLabel = transferScope === "card"
    ? "金额"
    : balanceTransferMode === "withdraw" ? "提现金额" : "转入金额";
  const transferConfirmLabel = transferScope === "card"
    ? balanceTransferMode === "withdraw" ? "确认转出" : "确认转入"
    : balanceTransferMode === "withdraw" ? "确认提现" : "确认转入";
  const transferLimit = transferScope === "card"
    ? balanceTransferMode === "withdraw" ? selectedTransferCard?.balance : undefined
    : balanceTransferMode === "withdraw" ? walletBalance : selectedTransferCard?.balance;
  const transferPanel = balanceTransferMode && selectedTransferCard ? (
    <div className="wallet-sheet wallet-inline-panel p-4 flex flex-col gap-4" aria-label={transferTitle}>
      <div className="flex items-center justify-between">
        <strong className="text-[var(--c-text-title)]" style={{ fontSize: "10px", lineHeight: "14px" }}>{transferTitle}</strong>
        <span className="ts-12 text-[var(--c-text)] opacity-60">
          {transferScope === "card" ? `当前卡 ${formatWalletAmount(selectedTransferCard.balance)}` : `余额 ${formatWalletAmount(walletBalance)}`}
        </span>
      </div>
      {transferCardLocked ? (
        <div className="min-h-[58px] rounded-lg px-3 flex items-center gap-3 text-left border border-[var(--c-card-border)] bg-[var(--c-card)]">
          <CreditCard size={18} className="text-[var(--c-icon)]" />
          <span className="flex-1 min-w-0">
            <span className="block ts-12 text-[var(--c-text)] opacity-60">当前银行卡</span>
            <span className="block ts-13 font-semibold text-[var(--c-text-title)] truncate">{selectedTransferCard.title}</span>
            <span className="block ts-11 text-[var(--c-text)] opacity-60 truncate">{getDisplayCardNumber(selectedTransferCard.maskedNumber)} · {formatWalletAmount(selectedTransferCard.balance)}</span>
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="ts-12 font-semibold text-[var(--c-text-title)]">选择银行卡</span>
          <div className="grid gap-2 max-h-[28vh] overflow-y-auto">
            {wallet.cards.map(card => {
              const active = selectedTransferCard.id === card.id;
              return (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => setTransferCardId(card.id)}
                  className="min-h-[54px] rounded-lg px-3 flex items-center gap-3 text-left"
                  style={{ border: active ? "1px solid var(--c-icon-active)" : "1px solid var(--c-card-border)", background: active ? "color-mix(in srgb, var(--c-icon-active) 8%, var(--c-card))" : "var(--c-card)" }}
                >
                  <CreditCard size={18} className="text-[var(--c-icon)]" />
                  <span className="flex-1 min-w-0">
                    <span className="block ts-13 font-semibold text-[var(--c-text-title)] truncate">{card.title}</span>
                    <span className="block ts-11 text-[var(--c-text)] opacity-60 truncate">{getDisplayCardNumber(card.maskedNumber)} · {formatWalletAmount(card.balance)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <label className="flex flex-col gap-2">
        <span className="ts-12 font-semibold text-[var(--c-text-title)]">{transferInputLabel}</span>
        <input className="ui-input" type="number" min={0.01} max={transferLimit} step={0.01} value={transferAmount} onChange={event => setTransferAmount(event.target.value)} />
      </label>
      {error ? <div className="ts-12 text-[var(--c-danger)]">{error}</div> : null}
      <button type="button" onClick={handleBalanceTransfer} className="wallet-confirm-action">{transferConfirmLabel}</button>
    </div>
  ) : null;

  return (
    <PageShell title="Wallet" onBack={onBack} className="wallet-page-root">
      <style>{`
        .wallet-page-root {
          background: #fff !important;
        }
        .wallet-page-root > .page-header {
          display: block !important;
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          z-index: 20;
          background: #fff !important;
        }
        .wallet-page-root > .page-body {
          padding-top: calc(var(--page-header-safe-top, 48px) + var(--page-header-content-height, 54px)) !important;
        }
        .wallet-page-root .page-body {
          overflow-y: auto;
        }
        .wallet-page-root .page-header-content {
          position: relative;
        }
        .wallet-page-root .page-title {
          position: absolute;
          left: 16px;
          text-align: left;
        }
        .wallet-section {
          background: #fff;
          border: 1px solid #e8e8e8;
          border-radius: 8px;
          overflow: hidden;
        }
        .wallet-balance-group > .wallet-section {
          width: 100%;
        }
        .wallet-balance-group.is-expanded > .wallet-section {
          border-bottom-left-radius: 0;
          border-bottom-right-radius: 0;
        }
        .wallet-balance-extension {
          width: 100%;
          border: 1px solid #e8e8e8;
          border-top: 0;
          border-radius: 0 0 8px 8px;
          background: #fff;
        }
        .wallet-inline-panel {
          border: 0 !important;
          border-radius: 0;
        }
        .wallet-inline-panel > .flex.items-center.justify-between > strong {
          font-size: calc(13px * var(--app-text-scale, 1));
          font-weight: 600;
          color: var(--c-text-title);
          opacity: .72;
        }
        .wallet-balance-extension .wallet-inline-panel {
          border-top: 0 !important;
          border-radius: 0 0 8px 8px;
        }
        .wallet-icon-button {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: #f2f2f2;
          color: #171717;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .wallet-row-action {
          min-height: 30px;
          padding: 0 9px;
          border: 1px solid #ececec;
          border-radius: 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          font-size: calc(11px*var(--app-text-scale,1));
          font-weight: 600;
          color: #222;
          background: #f5f5f5;
        }
        .wallet-sheet .ui-input {
          background: #fafafa !important;
          border-color: #eeeeee !important;
        }
        .wallet-family-mode {
          padding: 3px;
          border-radius: 8px;
          background: #f6f6f6;
        }
        .wallet-family-mode button {
          height: 30px;
          border-radius: 6px;
        }
        .wallet-confirm-action {
          height: 48px;
          border-radius: 18px;
          background: #171717;
          color: #fff;
          font-size: calc(14px*var(--app-text-scale,1));
          font-weight: 600;
        }
        .wallet-confirm-action:disabled {
          opacity: .4;
        }
      `}</style>

      <div className="p-3 flex flex-col gap-3 pb-24 text-[#171717]">
        <div className={`wallet-balance-group${transferScope === "balance" && transferPanel ? " is-expanded" : ""}`}>
          <section className="wallet-section p-5 min-h-[164px] flex flex-col justify-between">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="ts-12 text-[#777]">Wallet Balance</div>
                <div className="ts-34 font-semibold mt-2">{formatWalletAmount(walletBalance)}</div>
                <div className="ts-11 text-[#999] mt-1">可用于转账、红包与余额支付</div>
              </div>
              <div className="wallet-icon-button" aria-hidden="true"><MoneybagIcon /></div>
            </div>
            <div className="flex items-end justify-between gap-3">
              <span className="ts-11 text-[#999]">共 {wallet.transactions.length} 条流水</span>
              <div className="flex items-center gap-2">
                <button type="button" className="wallet-row-action" onClick={() => openBalanceTransfer("deposit")}>
                  <ArrowDownToLine size={14} />
                  转入
                </button>
                <button type="button" className="wallet-row-action" onClick={() => openBalanceTransfer("withdraw")}>
                  <ArrowUpFromLine size={14} />
                  提现
                </button>
              </div>
            </div>
          </section>
          {transferScope === "balance" && transferPanel ? (
            <div className="wallet-balance-extension">{transferPanel}</div>
          ) : null}
        </div>

        <section className="wallet-section">
          <div className="px-4 py-3 flex items-center justify-between border-b border-[#ededed]">
            <div className="flex items-center gap-2.5">
              <CardsIcon />
              <h2 className="ts-15 font-semibold">Family Cards</h2>
            </div>
            <button type="button" onClick={() => { setError(null); closeBalanceTransfer(); setAddOpen(false); setFamilyCardOpen(current => !current); }} className="wallet-row-action">
              管理
            </button>
          </div>
          {familyCardOpen ? (
            <div className="wallet-sheet wallet-inline-panel p-4 flex flex-col gap-4 text-[#171717]" aria-label="新增亲属卡">
              <div className="flex items-center justify-between">
                <strong className="text-[var(--c-text-title)] opacity-70" style={{ fontSize: "10px", lineHeight: "14px" }}>新增亲属卡</strong>
              </div>
              <div className="wallet-family-mode grid grid-cols-2 gap-1">
                <button type="button" onClick={() => setFamilyDirection("requested")} className="ts-11 font-semibold" style={{ background: familyDirection === "requested" ? "#fff" : "transparent", boxShadow: familyDirection === "requested" ? "0 1px 3px rgba(0,0,0,.07)" : "none" }}>索要</button>
                <button type="button" onClick={() => setFamilyDirection("granted")} className="ts-11 font-semibold" style={{ background: familyDirection === "granted" ? "#fff" : "transparent", boxShadow: familyDirection === "granted" ? "0 1px 3px rgba(0,0,0,.07)" : "none" }}>赠与</button>
              </div>
              <label className="flex flex-col gap-2">
                <span className="ts-12 font-semibold">角色</span>
                <select className="ui-input" value={familyCharacterId} onChange={event => setFamilyCharacterId(event.target.value)}>
                  <option value="">请选择通讯录好友</option>
                  {contactCharacters.map(({ contact, character }) => <option key={contact.id} value={character.id}>{contact.nickname || character.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-2">
                <span className="ts-12 font-semibold">每月额度</span>
                <input className="ui-input" type="number" min={0.01} step={0.01} value={familyLimit} onChange={event => setFamilyLimit(event.target.value)} placeholder="1000" />
              </label>
              <label className="flex flex-col gap-2">
                <span className="ts-12 font-semibold">备注</span>
                <input className="ui-input" maxLength={240} value={familyNote} onChange={event => setFamilyNote(event.target.value)} placeholder="选填" />
              </label>
              {contactCharacters.length === 0 ? <div className="ts-11 text-[#888]">通讯录暂无角色，请先在 Chat 中添加好友。</div> : null}
              {error ? <div className="ts-12 text-[var(--c-danger)]">{error}</div> : null}
              <button type="button" onClick={handleCreateFamilyCard} disabled={contactCharacters.length === 0} className="wallet-confirm-action">
                {familyDirection === "requested" ? "发送索要" : "确认开通"}
              </button>
            </div>
          ) : null}
          <div className="px-4">
            {wallet.familyCards.filter(card => card.status === "active" || card.status === "paused").length === 0 ? (
              <div className="w-full py-7 flex flex-col items-center gap-2 text-[#777]">
                <CardsIcon size={24} />
                <span className="ts-12">向角色索要，或给角色开通亲属卡</span>
              </div>
            ) : wallet.familyCards.filter(card => card.status === "active" || card.status === "paused").map(card => (
              <div key={card.id} className="py-3.5 flex items-center gap-3 border-b last:border-b-0 border-[#ededed]">
                <div className="wallet-icon-button shrink-0"><CardsIcon size={17} /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="ts-13 font-semibold truncate">{card.characterName}</span>
                    <span className="ts-10 text-[#777] px-1.5 py-0.5 bg-[#f2f2f2] rounded">{card.direction === "requested" ? "向TA索要" : "给TA"}</span>
                  </div>
                  <div className="ts-11 text-[#888] mt-1 truncate">每月 {formatWalletAmount(card.monthlyLimit)}{card.note ? ` · ${card.note}` : ""}</div>
                  {card.status === "pending" ? <div className="ts-10 text-[#a06a00] mt-0.5">待对方处理</div> : null}
                </div>
                <div className="text-right shrink-0">
                  <div className="ts-12 font-semibold">{formatWalletAmount(card.usedAmount)}</div>
                  <div className="ts-10 text-[#999] mt-0.5">已使用</div>
                </div>
                <button type="button" className="w-7 h-7 flex items-center justify-center text-[#777] shrink-0" onClick={() => setDeleteFamilyCardId(card.id)} aria-label={`删除${card.characterName}的亲属卡`}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </section>

        <section className="wallet-section">
          <div className="px-4 py-3 flex items-center justify-between border-b border-[#ededed]">
            <div className="flex items-center gap-2.5">
              <BuildingBankIcon />
              <h2 className="ts-15 font-semibold">Bank Cards</h2>
            </div>
            <button type="button" onClick={() => { setError(null); closeBalanceTransfer(); setFamilyCardOpen(false); setAddOpen(current => !current); }} className="wallet-row-action">新增</button>
          </div>
          {transferScope === "card" ? transferPanel : null}
          {addOpen ? (
            <div className="wallet-sheet wallet-inline-panel p-4 flex flex-col gap-4" aria-label="新增银行卡">
              <div className="flex items-center justify-between">
                <strong className="text-[var(--c-text-title)] opacity-70" style={{ fontSize: "10px", lineHeight: "14px" }}>新增银行卡</strong>
                <span className="ts-12 text-[var(--c-text)] opacity-60">余额不能为负</span>
              </div>
              <label className="flex flex-col gap-2">
                <span className="ts-12 font-semibold text-[var(--c-text-title)]">卡片名称</span>
                <input className="ui-input" value={newCardTitle} onChange={event => setNewCardTitle(event.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-2 min-w-0">
                  <span className="ts-12 font-semibold text-[var(--c-text-title)]">尾号</span>
                  <input className="ui-input" inputMode="numeric" maxLength={4} value={newCardTail} onChange={event => setNewCardTail(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="0000" />
                </label>
                <label className="flex flex-col gap-2 min-w-0">
                  <span className="ts-12 font-semibold text-[var(--c-text-title)]">初始余额</span>
                  <input className="ui-input" type="number" min={0} step={0.01} value={newCardBalance} onChange={event => setNewCardBalance(event.target.value)} />
                </label>
              </div>
              <button type="button" onClick={handleAddCard} className="wallet-confirm-action">添加银行卡</button>
            </div>
          ) : null}
          <div className="px-4">
            {wallet.cards.map(card => (
              <div key={card.id} className="py-3.5 flex items-center gap-3 border-b last:border-b-0 border-[#ededed]">
                <button type="button" className="wallet-icon-button shrink-0" onClick={() => setActiveCardId(card.id)} aria-label={`选择${card.title}`}><CreditCard size={17} /></button>
                <button type="button" className="flex-1 min-w-0 text-left" onClick={() => setActiveCardId(card.id)}>
                  <span className="block ts-13 font-semibold truncate">{card.title}</span>
                  <span className="block ts-11 text-[#888] mt-1 truncate">{getDisplayCardNumber(card.maskedNumber)} · {formatWalletAmount(card.balance)}</span>
                </button>
                <div className="flex items-center">
                  <button type="button" className="w-7 h-7 flex items-center justify-center text-[#555]" onClick={() => { setActiveCardId(card.id); openBalanceTransfer("deposit", { scope: "card", cardId: card.id }); }} aria-label="转入银行卡"><ArrowDownToLine size={14} /></button>
                  <button type="button" className="w-7 h-7 flex items-center justify-center text-[#555]" onClick={() => { setActiveCardId(card.id); openBalanceTransfer("withdraw", { scope: "card", cardId: card.id }); }} aria-label="转出银行卡"><ArrowUpFromLine size={14} /></button>
                  <button type="button" className="w-7 h-7 flex items-center justify-center text-[#777]" onClick={() => setDeleteCardId(card.id)} aria-label="删除银行卡"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="wallet-section px-4 py-2 flex flex-col">
          <div className="py-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5"><FolderDollarIcon /><h2 className="ts-15 font-semibold">Transactions</h2></div>
            <span className="ts-11 text-[#999]">最多显示 10 笔</span>
          </div>
          {recentTransactions.length === 0 ? (
            <div className="py-8 text-center ts-12 text-[#888]">暂无流水</div>
          ) : (
            recentTransactions.map(transaction => {
              const outgoing = transaction.amount < 0;
              const TransactionIcon = transaction.kind === "payment"
                ? CreditCard
                : transaction.kind === "transfer_out"
                  ? ArrowUpFromLine
                  : ArrowDownToLine;
              return (
                <div key={transaction.id} className="py-3 flex items-center gap-3 border-t border-[#ededed]">
                  <div className="wallet-icon-button shrink-0">
                    <TransactionIcon size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="ts-13 font-semibold truncate">{transaction.title}</div>
                    <div className="ts-11 text-[#888] truncate">{formatWalletTimeLabel(transaction.createdAt)} · {transaction.detail}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="ts-13 font-semibold">
                      {outgoing ? "-" : "+"}{formatWalletAmount(Math.abs(transaction.amount))}
                    </div>
                    <div className="ts-10 text-[#999]">余 {formatWalletAmount(transaction.balanceAfter)}</div>
                  </div>
                </div>
              );
            })
          )}
        </section>
        {error ? <div className="ts-12 text-[var(--c-danger)] px-1">{error}</div> : null}
      </div>

      {deleteCardId ? (
        <ConfirmDialog
          title="删除这张银行卡？"
          message="删除后该卡余额和流水都会从余额管理中移除。"
          variant="danger"
          confirmLabel="删除"
          cancelLabel="取消"
          onConfirm={handleDeleteCard}
          onCancel={() => setDeleteCardId(null)}
        />
      ) : null}
      {deleteFamilyCardId ? (
        <ConfirmDialog
          title="删除亲属卡"
          message="删除后，聊天室中的对应亲属卡也会同步删除。"
          confirmLabel="删除"
          cancelLabel="取消"
          variant="danger"
          onConfirm={handleDeleteFamilyCard}
          onCancel={() => setDeleteFamilyCardId(null)}
        />
      ) : null}
    </PageShell>
  );
}
