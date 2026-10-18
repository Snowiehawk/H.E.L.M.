/** Presentation only: GitHub's validated binary state never implies workflow progress. */
export function issueState(state: unknown) {
  if (state === "OPEN") return { kind: "open", label: "Open" } as const;
  if (state === "CLOSED") return { kind: "closed", label: "Closed" } as const;
  return { kind: "unavailable", label: "State unavailable" } as const;
}
