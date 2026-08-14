"use client";

import type { ReactNode } from "react";

import { AccountProvider } from "@/lib/account-context";
import type { AccountProfile } from "@/lib/account-client";

type AccountGateProps = {
  children: ReactNode;
};

const LOCAL_ACCOUNT: AccountProfile = {
  id: "local_user",
  username: "local_user",
  displayName: "本地用户",
  status: "active",
};

export function AccountGate({ children }: AccountGateProps) {
  return (
    <AccountProvider account={LOCAL_ACCOUNT} refreshAccount={async () => undefined} logout={async () => undefined}>
      {children}
    </AccountProvider>
  );
}
