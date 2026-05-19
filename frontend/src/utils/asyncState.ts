/**
 * Async State Machine — unified loading/error/data/lastUpdated pattern
 * Used by all stores to eliminate inconsistent loading state bugs
 */

export interface AsyncState<T> {
  data: T;
  loading: boolean;
  error: Error | null;
  lastUpdated: number;
}

export function createAsyncState<T>(initialData: T): AsyncState<T> {
  return {
    data: initialData,
    loading: false,
    error: null,
    lastUpdated: 0,
  };
}

export function setLoading<T>(state: AsyncState<T>): AsyncState<T> {
  return { ...state, loading: true, error: null };
}

export function setSuccess<T>(state: AsyncState<T>, data: T): AsyncState<T> {
  return { ...state, data, loading: false, error: null, lastUpdated: Date.now() };
}

export function setError<T>(state: AsyncState<T>, error: Error): AsyncState<T> {
  return { ...state, loading: false, error };
}

export function isStale(state: AsyncState<unknown>, staleMs: number): boolean {
  return Date.now() - state.lastUpdated > staleMs;
}
