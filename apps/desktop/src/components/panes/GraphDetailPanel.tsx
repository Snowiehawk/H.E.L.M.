import type {
  FileContents,
  GraphNodeDto,
  SymbolDetails,
  WorkspaceTab,
} from "../../lib/adapter";

export function GraphDetailPanel({
  activeTab,
  file,
  symbol,
  selectedNode,
  onOpenFile,
  onOpenSymbol,
  onClose,
}: {
  activeTab: WorkspaceTab;
  file?: FileContents;
  symbol?: SymbolDetails;
  selectedNode?: GraphNodeDto;
  onOpenFile: (path: string, nodeId?: string) => void;
  onOpenSymbol: (symbolId: string, nodeId?: string) => void;
  onClose: () => void;
}) {
  const fileSymbols = file?.linkedSymbols.filter((item) => item.kind === "symbol") ?? [];

  if (activeTab === "file") {
    const previewLines = (file?.content ?? "")
      .split("\n")
      .slice(0, 18)
      .map((line, index) => ({ number: index + 1, content: line || " " }));

    return (
      <aside className="graph-detail graph-detail--compact">
        <div className="graph-detail__header">
          <div>
            <span className="window-bar__eyebrow">File</span>
            <h3>{file?.path ?? "Loading file"}</h3>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            Hide
          </button>
        </div>

        <div className="graph-detail__section">
          <p>
            {file
              ? `${file.language} · ${file.lineCount} lines · ${file.sizeBytes} bytes`
              : "Preparing file preview from the current graph selection."}
          </p>
        </div>

        <div className="code-preview" aria-label="File preview">
          {previewLines.length ? (
            previewLines.map((line) => (
              <div key={line.number} className="code-preview__line">
                <span>{line.number}</span>
                <code>{line.content}</code>
              </div>
            ))
          ) : (
            <p className="muted-copy">No preview available yet.</p>
          )}
        </div>

        {fileSymbols.length ? (
          <div className="graph-detail__section">
            <div className="section-header">
              <h3>Symbols</h3>
              <span>{fileSymbols.length}</span>
            </div>
            <div className="stack-list">
              {fileSymbols.slice(0, 6).map((item) => (
                <button
                  key={item.id}
                  className="list-button"
                  type="button"
                  onClick={() => item.symbolId && onOpenSymbol(item.symbolId, item.nodeId)}
                >
                  <span className="list-button__title">{item.title}</span>
                  <span className="list-button__subtitle">{item.subtitle}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </aside>
    );
  }

  if (activeTab === "symbol") {
    return (
      <aside className="graph-detail graph-detail--compact">
        <div className="graph-detail__header">
          <div>
            <span className="window-bar__eyebrow">Symbol</span>
            <h3>{symbol?.name ?? "Loading symbol"}</h3>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            Hide
          </button>
        </div>

        <div className="graph-detail__section">
          <strong>{symbol?.signature ?? "Resolving signature"}</strong>
          <p>{symbol?.docSummary ?? "Pulling callers, callees, and metadata into view."}</p>
        </div>

        {symbol ? (
          <>
            <div className="detail-actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => onOpenFile(symbol.filePath, symbol.nodeId)}
              >
                Open file
              </button>
            </div>

            <div className="graph-detail__section">
              <div className="section-header">
                <h3>Callers</h3>
                <span>{symbol.callers.length}</span>
              </div>
              <div className="stack-list">
                {symbol.callers.slice(0, 4).map((item) => (
                  <button
                    key={item.id}
                    className="list-button"
                    type="button"
                    onClick={() =>
                      item.symbolId
                        ? onOpenSymbol(item.symbolId, item.nodeId)
                        : onOpenFile(symbol.filePath, item.nodeId)
                    }
                  >
                    <span className="list-button__title">{item.label}</span>
                    <span className="list-button__subtitle">{item.subtitle}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="graph-detail__section">
              <div className="section-header">
                <h3>Callees</h3>
                <span>{symbol.callees.length}</span>
              </div>
              <div className="stack-list">
                {symbol.callees.slice(0, 4).map((item) => (
                  <button
                    key={item.id}
                    className="list-button"
                    type="button"
                    onClick={() =>
                      item.symbolId
                        ? onOpenSymbol(item.symbolId, item.nodeId)
                        : onOpenFile(symbol.filePath, item.nodeId)
                    }
                  >
                    <span className="list-button__title">{item.label}</span>
                    <span className="list-button__subtitle">{item.subtitle}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </aside>
    );
  }

  if (!selectedNode) {
    return null;
  }

  return (
    <aside className="graph-detail">
      <div className="graph-detail__header">
        <div>
          <span className="window-bar__eyebrow">Graph</span>
          <h3>{selectedNode.label}</h3>
        </div>
        <button className="ghost-button" type="button" onClick={onClose}>
          Hide
        </button>
      </div>
      <div className="graph-detail__section">
        <p>{selectedNode.subtitle}</p>
        <div className="detail-actions">
          {selectedNode.kind === "module" ? (
            <button
              className="ghost-button"
              type="button"
              onClick={() => onOpenFile(selectedNode.subtitle, selectedNode.id)}
            >
              Open file
            </button>
          ) : null}
          {selectedNode.kind === "symbol" ? (
            <button
              className="ghost-button"
              type="button"
              onClick={() => onOpenSymbol(selectedNode.id, selectedNode.id)}
            >
              Inspect symbol
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
