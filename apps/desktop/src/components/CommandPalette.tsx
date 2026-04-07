import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDesktopAdapter } from "../lib/adapter";
import { useUiStore } from "../store/uiStore";

export function CommandPalette() {
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
        includeFiles: true,
        includeSymbols: true,
      }),
    enabled: paletteOpen,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
  }, [setPaletteOpen]);

  useEffect(() => {
    if (!paletteOpen) {
      setQuery("");
      return;
    }

    inputRef.current?.focus();
  }, [paletteOpen]);

  if (!paletteOpen) {
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
