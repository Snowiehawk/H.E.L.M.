import type {
  FileContents,
  GraphNeighborhood,
  OverviewData,
  SymbolDetails,
  WorkspaceTab,
} from "../../lib/adapter";
import { StatusPill } from "../shared/StatusPill";

export function InspectorPane({
  activeTab,
  overview,
  file,
  symbol,
  graph,
  selectedNodeId,
  onOpenFile,
  onOpenSymbol,
}: {
  activeTab: WorkspaceTab;
  overview?: OverviewData;
  file?: FileContents;
  symbol?: SymbolDetails;
  graph?: GraphNeighborhood;
  selectedNodeId?: string;
  onOpenFile: (path: string) => void;
  onOpenSymbol: (symbolId: string, nodeId?: string) => void;
}) {
  const selectedGraphNode =
    graph?.nodes.find((node) => node.id === selectedNodeId) ??
    graph?.nodes.find((node) => node.id === graph.rootNodeId);

  return (
    <aside className="pane pane--inspector">
      <section className="sidebar-card">
        <div className="sidebar-card__header">
          <div>
            <span className="window-bar__eyebrow">Inspector</span>
            <h2>Context</h2>
          </div>
          <StatusPill tone="default">{activeTab}</StatusPill>
        </div>
        <p>
          Keep metadata, linked references, and next actions visible while you move through the
          workspace.
        </p>
      </section>

      {activeTab === "overview" && overview ? (
        <section className="sidebar-section">
          <div className="section-header">
            <h3>Repo summary</h3>
            <span>{overview.repo.primaryLanguage}</span>
          </div>
          <div className="metadata-grid">
            {overview.metrics.map((metric) => (
              <div key={metric.label} className="metadata-item">
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </div>
            ))}
          </div>
          <ul className="bullet-list">
            {overview.diagnostics.map((diagnostic) => (
              <li key={diagnostic}>{diagnostic}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {activeTab === "file" && file ? (
        <section className="sidebar-section">
          <div className="section-header">
            <h3>File metadata</h3>
            <span>{file.language}</span>
          </div>
          <div className="metadata-grid">
            <div className="metadata-item">
              <span>Lines</span>
              <strong>{file.lineCount}</strong>
            </div>
            <div className="metadata-item">
              <span>Bytes</span>
              <strong>{file.sizeBytes}</strong>
            </div>
          </div>
          <div className="stack-list">
            {file.linkedSymbols.map((item) => (
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
        </section>
      ) : null}

      {(activeTab === "symbol" || activeTab === "graph") && symbol ? (
        <section className="sidebar-section">
          <div className="section-header">
            <h3>{symbol.name}</h3>
            <span>{symbol.kind}</span>
          </div>
          <p className="muted-copy">{symbol.docSummary}</p>
          <button className="ghost-button" type="button" onClick={() => onOpenFile(symbol.filePath)}>
            Open {symbol.filePath}
          </button>
          <div className="metadata-grid">
            {Object.entries(symbol.metadata).map(([label, value]) => (
              <div key={label} className="metadata-item">
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {activeTab === "graph" && graph ? (
        <section className="sidebar-section">
          <div className="section-header">
            <h3>Graph selection</h3>
            <span>{graph.edges.length} edges</span>
          </div>
          <div className="info-card">
            <strong>{selectedGraphNode?.label ?? "Nothing selected"}</strong>
            <p>{selectedGraphNode?.subtitle ?? "Click a node to focus a path."}</p>
          </div>
          <div className="metadata-grid">
            <div className="metadata-item">
              <span>Root</span>
              <strong>{graph.rootNodeId}</strong>
            </div>
            <div className="metadata-item">
              <span>Nodes</span>
              <strong>{graph.nodes.length}</strong>
            </div>
          </div>
        </section>
      ) : null}
    </aside>
  );
}
