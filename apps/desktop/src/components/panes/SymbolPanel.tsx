import type { RelationshipItem, SymbolDetails } from "../../lib/adapter";
import { EmptyState } from "../shared/EmptyState";

function RelationshipSection({
  title,
  items,
  onSelect,
}: {
  title: string;
  items: RelationshipItem[];
  onSelect: (item: RelationshipItem) => void;
}) {
  return (
    <div className="card">
      <div className="section-header">
        <h3>{title}</h3>
        <span>{items.length}</span>
      </div>
      <div className="stack-list">
        {items.length ? (
          items.map((item) => (
            <button
              key={item.id}
              className="list-button"
              type="button"
              onClick={() => onSelect(item)}
            >
              <span className="list-button__title">{item.label}</span>
              <span className="list-button__subtitle">{item.subtitle}</span>
            </button>
          ))
        ) : (
          <p className="muted-copy">Nothing linked in this direction yet.</p>
        )}
      </div>
    </div>
  );
}

export function SymbolPanel({
  symbol,
  onOpenFile,
  onOpenGraph,
  onOpenSymbol,
}: {
  symbol?: SymbolDetails;
  onOpenFile: (path: string) => void;
  onOpenGraph: (nodeId?: string) => void;
  onOpenSymbol: (symbolId: string, nodeId?: string) => void;
}) {
  if (!symbol) {
    return (
      <section className="content-panel">
        <EmptyState
          title="Select a symbol"
          body="Open a function, dataclass, or module-level definition to inspect its role in the repo."
        />
      </section>
    );
  }

  return (
    <section className="content-panel">
      <div className="hero-card hero-card--dense">
        <div>
          <span className="window-bar__eyebrow">{symbol.kind}</span>
          <h2>{symbol.name}</h2>
          <p>{symbol.qualname}</p>
          <code className="signature-block">{symbol.signature}</code>
        </div>
        <div className="hero-card__actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => onOpenGraph(symbol.nodeId)}
          >
            Explore Graph
          </button>
          <button
            className="ghost-button"
            type="button"
            onClick={() => onOpenFile(symbol.filePath)}
          >
            Open File
          </button>
        </div>
      </div>

      <article className="card">
        <div className="section-header">
          <h3>Role in the codebase</h3>
          <span>
            Lines {symbol.startLine}-{symbol.endLine}
          </span>
        </div>
        <p>{symbol.docSummary}</p>
        <div className="metadata-grid">
          {Object.entries(symbol.metadata).map(([label, value]) => (
            <div key={label} className="metadata-item">
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </article>

      <div className="overview-grid">
        <RelationshipSection
          title="Callers"
          items={symbol.callers}
          onSelect={(item) => item.symbolId && onOpenSymbol(item.symbolId, item.nodeId)}
        />
        <RelationshipSection
          title="Callees"
          items={symbol.callees}
          onSelect={(item) => item.symbolId && onOpenSymbol(item.symbolId, item.nodeId)}
        />
      </div>

      <RelationshipSection
        title="References"
        items={symbol.references}
        onSelect={(item) => {
          if (item.symbolId) {
            onOpenSymbol(item.symbolId, item.nodeId);
          } else {
            onOpenGraph(item.nodeId);
          }
        }}
      />
    </section>
  );
}
