import type { EditableNodeSource, GraphNodeDto, SymbolDetails } from "../../../lib/adapter";

export function SelectionSummaryPanel({
  contextSectionVisible,
  contextSummary,
  editableSource,
  inspectorKind,
  inspectorTitle,
  selectedNode,
  selectedSummary,
  symbol,
  topLevel,
}: {
  contextSectionVisible: boolean;
  contextSummary?: string;
  editableSource?: EditableNodeSource;
  inspectorKind?: GraphNodeDto["kind"];
  inspectorTitle: string;
  selectedNode?: GraphNodeDto;
  selectedSummary?: string;
  symbol?: SymbolDetails;
  topLevel?: boolean;
}) {
  if (selectedNode) {
    return (
      <section className="sidebar-section blueprint-inspector__section blueprint-inspector__section--selection">
        <div className="section-header">
          <h3>Selection</h3>
          <span>{selectedNode.kind}</span>
        </div>
        <div className="info-card">
          <strong>{selectedNode.label}</strong>
          {selectedSummary ? <p>{selectedSummary}</p> : null}
          {topLevel === false && editableSource?.editable === false ? (
            <p className="muted-copy">This symbol is nested and not editable inline in v1.</p>
          ) : null}
        </div>
        {symbol ? (
          <div className="info-card">
            <strong>{symbol.signature}</strong>
            <p>{symbol.docSummary}</p>
          </div>
        ) : null}
      </section>
    );
  }

  if (!contextSectionVisible) {
    return null;
  }

  return (
    <section className="sidebar-section blueprint-inspector__section blueprint-inspector__section--selection">
      <div className="section-header">
        <h3>Current Context</h3>
        <span>{inspectorKind ?? "source"}</span>
      </div>
      <div className="info-card">
        <strong>{inspectorTitle}</strong>
        {contextSummary ? <p>{contextSummary}</p> : null}
      </div>
      {symbol ? (
        <div className="info-card">
          <strong>{symbol.signature}</strong>
          <p>{symbol.docSummary}</p>
        </div>
      ) : null}
    </section>
  );
}
