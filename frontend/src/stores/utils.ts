import { message } from "antd";

interface OptimisticDeleteOptions<T extends { id: string }> {
  successMsg: string;
  errorMsg: string;
  extraUpdate?: (id: string, prevList: T[], remaining: T[]) => Partial<Record<string, unknown>>;
  onSuccess?: () => Promise<void> | void;
}

export function createOptimisticDelete<T extends { id: string }, S = unknown>(
  get: () => S,
  set: (fn: ((s: any) => any) | Record<string, unknown>) => void,
  stateKey: string,
  apiDelete: (id: string) => Promise<unknown>,
  options: OptimisticDeleteOptions<T>
) {
  return async (id: string) => {
    const prev = (get() as Record<string, unknown>)[stateKey] as T[];
    set((s: any) => {
      const remaining = s[stateKey].filter((item: T) => item.id !== id);
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
