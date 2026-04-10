import { memo, useEffect, useState } from "react";

export interface InspectorCodeSurfaceProps {
  value: string;
  language: string;
  readOnly: boolean;
  path?: string;
  startLine?: number;
  height?: number | string;
  ariaLabel: string;
  onChange?: (value: string) => void;
  className?: string;
  dataTestId?: string;
}

type MonacoSurfaceComponent = typeof import("./InspectorCodeSurfaceMonaco").InspectorCodeSurfaceMonaco;

let monacoSurfacePromise: Promise<MonacoSurfaceComponent> | undefined;

function loadMonacoSurface() {
  if (!monacoSurfacePromise) {
    monacoSurfacePromise = import("./InspectorCodeSurfaceMonaco")
      .then((module) => module.InspectorCodeSurfaceMonaco);
  }
  return monacoSurfacePromise;
}

export const InspectorCodeSurface = memo(function InspectorCodeSurface(
  props: InspectorCodeSurfaceProps,
) {
  const [Component, setComponent] = useState<MonacoSurfaceComponent | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;

    void loadMonacoSurface()
      .then((loadedComponent) => {
        if (!disposed) {
          setComponent(() => loadedComponent);
        }
      })
      .catch((error) => {
        console.error("Unable to load Monaco for the blueprint inspector.", error);
        if (!disposed) {
          setFailed(true);
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  if (Component) {
    return <Component {...props} />;
  }

  if (failed) {
    return <InspectorCodeSurfaceFallback {...props} />;
  }

  return (
    <div
      className={surfaceClassName(props.className, props.readOnly)}
      data-testid={props.dataTestId}
      style={surfaceStyle(props.height)}
    >
      <div className="inspector-code-surface__loading" aria-live="polite">
        Loading source editor…
      </div>
    </div>
  );
});

function InspectorCodeSurfaceFallback({
  ariaLabel,
  className,
  dataTestId,
  height,
  onChange,
  readOnly,
  value,
}: InspectorCodeSurfaceProps) {
  return (
    <div
      className={`${surfaceClassName(className, readOnly)} inspector-code-surface--fallback`}
      data-testid={dataTestId}
      style={surfaceStyle(height)}
    >
      {readOnly ? (
        <pre className="inspector-code-surface__fallback-pre" aria-label={ariaLabel}>
          <code>{value}</code>
        </pre>
      ) : (
        <textarea
          aria-label={ariaLabel}
          className="inspector-code-surface__fallback-input"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
      )}
    </div>
  );
}

function surfaceClassName(className: string | undefined, readOnly: boolean) {
  return [
    "inspector-code-surface",
    readOnly ? "inspector-code-surface--readonly" : "inspector-code-surface--editable",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

function surfaceStyle(height?: number | string) {
  return height === undefined ? undefined : { height };
}
