import { message } from "antd";

// Q14.8 (2026-05-21) — the original constraint hardcoded `id: string`, but
// the canonical sub-brain config types use `workspaceId` / `agentId` rather
// than a bare `id`. Loosen the constraint and let callers specify which
// field holds the primary key via `idKey`. Default is "id" for the existing
// callers (IdentityUser, KgEntity, Memory, ChannelInfo) — no behavior
// change for them.
interface OptimisticDeleteOptions<T extends object> {
  successMsg: string;
  errorMsg: string;
  /** Field name on T that holds the primary key. Defaults to "id". */
  idKey?: keyof T & string;
  extraUpdate?: (id: string, prevList: T[], remaining: T[]) => Partial<Record<string, unknown>>;
  onSuccess?: () => Promise<void> | void;
}

export function createOptimisticDelete<T extends object, S = unknown>(
  get: () => S,
  set: (fn: ((s: any) => any) | Record<string, unknown>) => void,
  stateKey: string,
  apiDelete: (id: string) => Promise<unknown>,
  options: OptimisticDeleteOptions<T>
) {
  const idKey = (options.idKey ?? "id") as keyof T;
  return async (id: string) => {
    const prev = (get() as Record<string, unknown>)[stateKey] as T[];
    set((s: any) => {
      const remaining = s[stateKey].filter((item: T) => (item as Record<string, unknown>)[idKey as string] !== id);
      const extra = options.extraUpdate ? options.extraUpdate(id, prev, remaining) : {};
      return { [stateKey]: remaining, ...extra };
    });
    try {
      await apiDelete(id);
      message.success(options.successMsg);
      if (options.onSuccess) await options.onSuccess();
    } catch (e: any) {
      message.error(e.message || options.errorMsg);
      set({ [stateKey]: prev });
    }
  };
}

interface DeleteThenRefetchOptions {
  successMsg: string;
  errorMsg: string;
}

export function createDeleteThenRefetch(
  apiDelete: (id: string) => Promise<unknown>,
  refetch: () => Promise<unknown>,
  options: DeleteThenRefetchOptions
) {
  return async (id: string) => {
    try {
      await apiDelete(id);
      message.success(options.successMsg);
      await refetch();
    } catch (e: any) {
      message.error(e.message || options.errorMsg);
    }
  };
}
