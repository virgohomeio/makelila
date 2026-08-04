import { useSyncExternalStore } from 'react';

/** Which org account hiring mail composes from.
 *
 *  Defaults to the signed-in operator, but a shared machine — or one person
 *  holding two org accounts — needs to send as someone else, so the choice is
 *  overridable and remembered. It lives in localStorage rather than on the
 *  profile row because it tracks the browser's Google session, not the
 *  makeLILA identity: picking an account only decides which Gmail account the
 *  compose tab opens under, and Gmail still requires that account to be signed
 *  in. Nothing here grants access to anyone's mailbox.
 *
 *  An external store rather than component state because two views send from
 *  the same choice — the outreach panel's picker and the per-candidate button
 *  on the board below it — and they must not disagree about who is writing. */

const STORAGE_KEY = 'makelila.hiring.sendingAs';

const listeners = new Set<() => void>();

/** Reads storage on every call. Snapshots are plain strings, so returning a
 *  fresh read is referentially stable as far as useSyncExternalStore cares,
 *  and clearing localStorage resets the store with no extra bookkeeping. */
function getSnapshot(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private-mode / disabled storage: fall back to no override rather than
    // taking the panel down.
    return null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setSendingAccount(email: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, email);
  } catch { /* see getSnapshot — the choice just won't persist */ }
  listeners.forEach(listener => listener());
}

/** The address to compose as: the remembered choice when it's still one of the
 *  offered accounts, otherwise the signed-in operator. A remembered address
 *  that has dropped off the roster (someone left) is ignored rather than
 *  silently addressing mail from an account nobody can open. */
export function useSendingAccount(signedInEmail: string | null, options: string[]): string | null {
  const stored = useSyncExternalStore(subscribe, getSnapshot, () => null);
  if (stored && options.includes(stored)) return stored;
  return signedInEmail;
}
