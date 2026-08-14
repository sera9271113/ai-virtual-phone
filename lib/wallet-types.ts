export type WalletCardStyle = "obsidian" | "graphite" | "silver";

export type WalletCard = {
  id: string;
  title: string;
  bankLabel: string;
  maskedNumber: string;
  cardStyle: WalletCardStyle;
  balance: number;
  note: string;
  accentLabel: string;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WalletAccountType = "balance" | "card";

export type WalletTransactionKind = "transfer_in" | "transfer_out" | "payment" | "refund" | "adjustment";

export type WalletTransaction = {
  id: string;
  cardId: string;
  accountType?: WalletAccountType;
  title: string;
  amount: number;
  kind: WalletTransactionKind;
  category: string;
  createdAt: string;
  detail: string;
  balanceAfter: number;
  relatedOrderId?: string;
};

export type FamilyCardDirection = "requested" | "granted";
export type FamilyCardStatus = "pending" | "active" | "paused" | "declined";

export type FamilyCard = {
  id: string;
  characterId: string;
  characterName: string;
  direction: FamilyCardDirection;
  monthlyLimit: number;
  usedAmount: number;
  note: string;
  status: FamilyCardStatus;
  createdAt: string;
  updatedAt: string;
};

export type WalletState = {
  balance: number;
  cards: WalletCard[];
  familyCards: FamilyCard[];
  transactions: WalletTransaction[];
  defaultCardId: string;
  updatedAt: string;
};

export type WalletPaymentInput = {
  accountId?: string;
  cardId?: string;
  familyCardId?: string;
  amount: number;
  title: string;
  detail: string;
  category?: string;
  relatedOrderId?: string;
};

export type WalletPaymentResult = {
  ok: boolean;
  state: WalletState;
  transaction?: WalletTransaction;
  error?: string;
};
