import type { FileContents } from "../../lib/adapter";
import { EmptyState } from "../shared/EmptyState";

export function FilePanel({
  file,
  onOpenSymbol,
}: {
  file?: FileContents;
  onOpenSymbol: (symbolId: string, nodeId?: string) => void;
}) {
  if (!file) {
    return (
      <section className="content-panel">
        <EmptyState
          title="Select a file"
          body="Choose a module from the sidebar or use the command palette to open code here."
        />
      </section>
    );
  }

  const lines = file.content.split("\n");

  return (
    <section className="content-panel">
      <div className="content-header">
        <div>
          <span className="window-bar__eyebrow">File view</span>
          <h2>{file.path}</h2>
          <p>
            {file.lineCount} lines • {file.sizeBytes} bytes • {file.language}
          </p>
        </div>
        <div className="chip-list">
          {file.linkedSymbols.map((symbol) => (
            <button
              key={symbol.id}
              className="chip-button chip-button--compact"
              type="button"
              onClick={() => onOpenSymbol(symbol.symbolId ?? symbol.id, symbol.nodeId)}
            >
              <strong>{symbol.title}</strong>
              <span>{symbol.subtitle}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="code-panel">
        {lines.map((line, index) => (
          <div key={`${file.path}:${index + 1}`} className="code-line">
            <span className="code-line__number">{index + 1}</span>
            <code className="code-line__content">{line || " "}</code>
          </div>
        ))}
      </div>
    </section>
  );
}
