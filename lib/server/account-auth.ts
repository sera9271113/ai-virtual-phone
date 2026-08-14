export type AppAccount = {
  id: string;
  username: string;
  displayName: string;
  status: "active" | "disabled";
  createdAt?: string;
  updatedAt?: string;
};

const LOCAL_ACCOUNT: AppAccount = {
  id: "local_user",
  username: "local_user",
  displayName: "本地用户",
  status: "active",
};

export function cleanAccountText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

export async function getCurrentAccount(request: Request): Promise<AppAccount> {
  void request;
  return LOCAL_ACCOUNT;
}
