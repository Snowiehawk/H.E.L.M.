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
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  const dragRegionProps = isTauri ? { "data-tauri-drag-region": true } : {};

  return (
    <div
      className={`app-frame${isTauri ? " app-frame--tauri" : ""}${
        isMac ? " app-frame--macos" : ""
      }`}
    >
      <div className={`window-shell${compact ? " window-shell--compact" : ""}`}>
        <header className={`window-bar${dense ? " window-bar--dense" : ""}`}>
          <div className="window-bar__left" {...dragRegionProps}>
            <div className="window-bar__copy">
              <span className="window-bar__eyebrow">{eyebrow}</span>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
          </div>
          <div className="window-bar__spacer" {...dragRegionProps} />
          <div className="window-bar__actions">{actions}</div>
        </header>
        {children}
      </div>
    </div>
  );
}
