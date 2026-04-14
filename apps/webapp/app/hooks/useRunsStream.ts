import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Maintains a persistent SSE connection to the runs stream.
 * When live, triggers revalidation on every event.
 * When paused, counts incoming "runCreated" events so the UI can show how many new runs arrived.
 */
export function useRunsStream(
  url: string | URL,
  options: { isLiveData: boolean; onRevalidate: () => void }
): { runsBehind: number; resetRunsBehind: () => void } {
  const [runsBehind, setRunsBehind] = useState(0);
  const isLiveRef = useRef(options.isLiveData);
  const onRevalidateRef = useRef(options.onRevalidate);

  useEffect(() => {
    isLiveRef.current = options.isLiveData;
  }, [options.isLiveData]);

  useEffect(() => {
    onRevalidateRef.current = options.onRevalidate;
  }, [options.onRevalidate]);

  useEffect(() => {
    const es = new EventSource(url);

    function handler(event: MessageEvent) {
      try {
        const data = JSON.parse(event.data);
        if (isLiveRef.current) {
          onRevalidateRef.current();
        } else if (data.source === "runCreated") {
          setRunsBehind((prev) => prev + 1);
        } else {
          // Status changes on existing runs still revalidate while paused
          onRevalidateRef.current();
        }
      } catch {
        onRevalidateRef.current();
      }
    }

    es.addEventListener("message", handler);

    return () => {
      es.removeEventListener("message", handler);
      es.close();
    };
  }, [url]);

  useEffect(() => {
    if (options.isLiveData) {
      setRunsBehind(0);
    }
  }, [options.isLiveData]);

  const resetRunsBehind = useCallback(() => setRunsBehind(0), []);

  return { runsBehind, resetRunsBehind };
}
