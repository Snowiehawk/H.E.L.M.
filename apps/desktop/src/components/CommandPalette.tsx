import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDesktopAdapter } from "../lib/adapter";
import { useUiStore } from "../store/uiStore";
import { useExecutionActions } from "../execution/actions";
import { useIdeActive } from "../app/FunctionTabs";

export function CommandPalette() {
  const ideActive = useIdeActive();
  const execution = useExecutionActions();
  const adapter = useDesktopAdapter();
  const paletteOpen = useUiStore((state) => state.paletteOpen);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);
  const selectSearchResult = useUiStore((state) => state.selectSearchResult);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const resultsQuery = useQuery({
    queryKey: ["command-palette", query],
    queryFn: () =>
      adapter.searchRepo(query, {
        includeModules: true,
        includeFiles: true,
        includeSymbols: true,
      }),
    enabled: paletteOpen && ideActive,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!ideActive) return;
      const trigger = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (trigger) {
        event.preventDefault();
        setPaletteOpen(true);
      }

      if (event.key === "Escape") {
        setPaletteOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setPaletteOpen, ideActive]);

  useEffect(() => {
    if (!ideActive) return;
    if (!paletteOpen) {
      setQuery("");
      return;
    }

    inputRef.current?.focus();
  }, [paletteOpen, ideActive]);

  if (!paletteOpen || !ideActive) {
    return null;
  }

  const results = resultsQuery.data ?? [];

  return (
    <div className="palette-backdrop" role="presentation" onClick={() => setPaletteOpen(false)}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="palette__header">
          <span className="window-bar__eyebrow">Command Palette</span>
          <button className="ghost-button" type="button" onClick={() => setPaletteOpen(false)}>
            Esc
          </button>
        </div>
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files, symbols, or graph anchors"
        />
        <div className="palette__results">
          {[
            {
              label: `Save and Run ${execution.configName ?? "selected configuration"}`,
              enabled: execution.canRun,
              action: execution.run,
            },
            { label: "Stop project run", enabled: execution.canStop, action: execution.stop },
            {
              label: `Restart ${execution.configName ?? "selected configuration"}`,
              enabled: execution.canRestart,
              action: execution.restart,
            },
            { label: "Show Terminal and Run Output", enabled: true, action: execution.show },
          ]
            .filter((item) => !query || item.label.toLowerCase().includes(query.toLowerCase()))
            .map((item) => (
              <button
                key={item.label}
                className="palette__result"
                type="button"
                disabled={!item.enabled}
                onClick={() => {
                  setPaletteOpen(false);
                  item.action();
                }}
              >
                {item.label}
              </button>
            ))}
          {!results.length && !resultsQuery.isFetching ? (
            <div className="palette__empty">
              <h3>Jump anywhere</h3>
              <p>Start typing to open a file, inspect a symbol, or seed the graph view.</p>
            </div>
          ) : null}
          {results.map((result) => (
            <button
              key={result.id}
              className="palette__result"
              type="button"
              onClick={() => {
                selectSearchResult(result);
                setPaletteOpen(false);
              }}
            >
              <span className="palette__result-kind">{result.kind}</span>
              <span className="palette__result-body">
                <strong>{result.title}</strong>
                <span>{result.subtitle}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
