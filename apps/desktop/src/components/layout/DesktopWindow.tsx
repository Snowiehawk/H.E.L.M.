import type { PropsWithChildren, ReactNode } from "react";

export function DesktopWindow({
  eyebrow,
  title,
  subtitle,
  actions,
  children,
  compact = false,
  dense = false,
}: PropsWithChildren<{
  eyebrow: string;
  title: string;
  subtitle: string;
  actions?: ReactNode;
  compact?: boolean;
  dense?: boolean;
}>) {
  return (
    <div className="app-frame">
      <div className={`window-shell${compact ? " window-shell--compact" : ""}`}>
        <header className={`window-bar${dense ? " window-bar--dense" : ""}`}>
          <div className="window-bar__left">
            <div className="window-bar__copy">
              <span className="window-bar__eyebrow">{eyebrow}</span>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
          </div>
          <div className="window-bar__actions">{actions}</div>
        </header>
        {children}
      </div>
    </div>
  );
}
