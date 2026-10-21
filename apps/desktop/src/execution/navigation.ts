import type { ExecutionContext } from "./contracts";
import type { DiagnosticGraphMapping } from "./mapping";
import type { PreparedSource } from "./preparation";

export interface ValidatedDiagnosticLocation {
  relativePath: string;
  line: number;
  column: number;
  currentHash: string;
  sourceMatches: boolean;
  lineText?: string | null;
}

export interface ExecutionNavigationRequest {
  context: ExecutionContext;
  location: ValidatedDiagnosticLocation;
  preparedSource: PreparedSource;
  signal?: AbortSignal;
}

type NavigationHandler = (request: ExecutionNavigationRequest) => Promise<DiagnosticGraphMapping>;
let navigation: NavigationHandler | undefined;

/** The IDE owns its drafts and graph; output views cannot mutate either directly. */
export function registerExecutionNavigation(handler: NavigationHandler) {
  navigation = handler;
  return () => {
    if (navigation === handler) navigation = undefined;
  };
}

export async function navigateRunDiagnostic(request: ExecutionNavigationRequest) {
  const handler = navigation;
  if (!handler) throw new Error("Open the IDE workspace before navigating to a run diagnostic.");
  const result = await handler(request);
  if (navigation !== handler)
    throw new Error("The workspace changed during diagnostic navigation.");
  return result;
}
