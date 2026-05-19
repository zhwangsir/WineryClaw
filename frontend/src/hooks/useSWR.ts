/**
 * SWR-like cache hook — stale-while-revalidate pattern
 * Eliminates duplicate fetches when navigating between pages
 */

import { useEffect, useRef, useCallback } from "react";

interface SWREntry<T> {
  data: T;
  timestamp: number;
  promise?: Promise<T>;
}

const globalCache = new Map<string, SWREntry<unknown>>();

export interface SWRConfig {
  staleTime?: number;      // ms before data is considered stale (default: 30000)
  dedupInterval?: number;  // ms to deduplicate concurrent requests (default: 2000)
}

export function useSWR<T>(
  key: string,
  fetcher: () => Promise<T>,
  config: SWRConfig = {}
) {
  const { staleTime = 30000 } = config;
  const mounted = useRef(false);

  const execute = useCallback(async (): Promise<T> => {
    const now = Date.now();
    const cached = globalCache.get(key) as SWREntry<T> | undefined;

    // Return fresh cache immediately
    if (cached && now - cached.timestamp < staleTime) {
      return cached.data;
    }

    // Deduplicate: return in-flight promise
    if (cached?.promise) {
      return cached.promise;
    }

    // Execute fetch
    const promise = fetcher().then((data) => {
      globalCache.set(key, { data, timestamp: Date.now() });
      return data;
    }).catch((err) => {
      // Remove failed promise so retry works
      const entry = globalCache.get(key) as SWREntry<T> | undefined;
      if (entry) {
        const { promise: _, ...rest } = entry;
        globalCache.set(key, rest);
      }
      throw err;
    });

    globalCache.set(key, { data: cached?.data as T, timestamp: cached?.timestamp ?? 0, promise });
    return promise;
  }, [key, fetcher, staleTime]);

  const mutate = useCallback(async (): Promise<T> => {
    globalCache.delete(key);
    return execute();
  }, [key, execute]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  return { execute, mutate };
}

/** Invalidate cache entries by prefix */
export function invalidateSWR(prefix: string): void {
  for (const key of globalCache.keys()) {
    if (key.startsWith(prefix)) globalCache.delete(key);
  }
}
