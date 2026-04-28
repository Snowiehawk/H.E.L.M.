import { PropsWithChildren } from "react";

type Tone = "default" | "accent" | "warning";

export function StatusPill({ tone = "default", children }: PropsWithChildren<{ tone?: Tone }>) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>;
}
