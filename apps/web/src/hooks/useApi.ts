// ──────────────────────────────────────────────
// useApi — React hook for data fetching
// ──────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from 'react';

interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface UseApiReturn<T> extends UseApiState<T> {
  refetch: () => Promise<void>;
  mutate: (data: T | null) => void;
}

/**
 * Hook for fetching data from the API.
 *
 * @example
 * const { data, loading, error, refetch } = useApi(() => studentApi.list({ search }), [search]);
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: any[] = [],
  options?: { enabled?: boolean }
): UseApiReturn<T> {
  const [state, setState] = useState<UseApiState<T>>({ data: null, loading: true, error: null });
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    if (options?.enabled === false) {
      setState(prev => ({ ...prev, loading: false }));
      return;
    }

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const result = await fetcher();
      if (mountedRef.current) {
        setState({ data: result, loading: false, error: null });
      }
    } catch (err: any) {
      if (mountedRef.current) {
        setState({ data: null, loading: false, error: err.detail || err.message || 'An error occurred' });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => { mountedRef.current = false; };
  }, [fetchData]);

  const refetch = useCallback(async () => {
    await fetchData();
  }, [fetchData]);

  const mutate = useCallback((data: T | null) => {
    setState(prev => ({ ...prev, data }));
  }, []);

  return { ...state, refetch, mutate };
}

/**
 * Hook for mutations (POST/PUT/DELETE).
 *
 * @example
 * const { execute, loading, error } = useMutation((data) => studentApi.create(data));
 */
export function useMutation<TInput, TResult = any>(
  mutationFn: (input: TInput) => Promise<TResult>,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TResult | null>(null);

  const execute = useCallback(async (input: TInput): Promise<TResult | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await mutationFn(input);
      setData(result);
      return result;
    } catch (err: any) {
      setError(err.detail || err.message || 'An error occurred');
      return null;
    } finally {
      setLoading(false);
    }
  }, [mutationFn]);

  return { execute, loading, error, data };
}
