import { useEffect, useState } from "react";
import { useDesktopAdapter } from ".";
import type { IndexingJobState } from "./contracts";

export function useIndexingProgress(jobId: string | undefined) {
  const adapter = useDesktopAdapter();
  const [state, setState] = useState<IndexingJobState | null>(null);

  useEffect(() => {
    if (!jobId) {
      setState(null);
      return;
    }

    return adapter.subscribeIndexProgress(jobId, setState);
  }, [adapter, jobId]);

  return state;
}
