import { createContext, useContext } from "react";
import type { SessionUser } from "@paperboy/shared";

interface UserCtx {
  user: SessionUser;
  logout: () => void;
}

export const UserContext = createContext<UserCtx | null>(null);

export function useUser(): UserCtx {
  const c = useContext(UserContext);
  if (!c) throw new Error("useUser must be used within UserContext");
  return c;
}

export function can(user: SessionUser, perm: SessionUser["permissions"][number]): boolean {
  return user.permissions.includes(perm);
}
