/**
 * Helper hook to safely call the preload API.
 * Catches errors and exposes { data, error, loading }.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AppError } from '@shared/types/index';

export function isError<T>(result: T | { error: AppError }): result is { error: AppError } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof (result as { error: unknown }).error === 'object'
  );
}

export function unwrap<T>(result: T | { error: AppError }): T | null {
  if (isError(result)) return null;
  return result as T;
}

export function useApi<T>(
  fetcher: () => Promise<T | { error: AppError }>,
  deps: unknown[] = [],
): { data: T | null; error: AppError | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadCounter, setReloadCounter] = useState(0);

  const reload = useCallback(() => setReloadCounter((c) => c + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher()
      .then((result) => {
        if (cancelled) return;
        if (isError(result)) {
          setError(result.error);
          setData(null);
        } else {
          setData(result as T);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError({
          code: 'ERR_RUNTIME',
          userMessage: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadCounter]);

  return { data, error, loading, reload };
}
