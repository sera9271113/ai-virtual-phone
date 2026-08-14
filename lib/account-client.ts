export type AccountProfile = {
  id: string;
  username: string;
  displayName: string;
  status: "active" | "disabled";
  createdAt?: string;
  updatedAt?: string;
};

type AccountResponse = {
  ok?: boolean;
  account?: AccountProfile | null;
  error?: string;
};

const LOCAL_ACCOUNT: AccountProfile = {
  id: "local_user",
  username: "local_user",
  displayName: "本地用户",
  status: "active",
};

export async function fetchCurrentAccount(): Promise<AccountResponse> {
  return { ok: true, account: LOCAL_ACCOUNT };
}
