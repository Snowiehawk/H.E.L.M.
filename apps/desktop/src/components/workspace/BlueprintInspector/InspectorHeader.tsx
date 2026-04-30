import type { GraphNodeDto } from "../../../lib/adapter";
import { StatusPill } from "../../shared/StatusPill";
import { helpTargetProps } from "../workspaceHelp";

export function InspectorEmptyState({ onClose }: { onClose: () => void }) {
  return (
    <section className="sidebar-card blueprint-inspector__card">
      <div className="sidebar-card__header">
        <div>
          <span className="window-bar__eyebrow">Inspector</span>
          <h2>Nothing selected</h2>
        </div>
        <button
          {...helpTargetProps("inspector.toggle")}
          className="ghost-button"
          type="button"
          onClick={onClose}
        >
          Collapse
        </button>
      </div>
      <p>
        Select a graph node to inspect it, or press <strong>C</strong> in the graph to enter create
        mode.
      </p>
    </section>
  );
}

export function InspectorHeader({
  contextSummary,
  inspectorKind,
  inspectorTitle,
  nodePath,
  selectedNode,
  selectedSummary,
  onClose,
}: {
  contextSummary?: string;
  inspectorKind?: GraphNodeDto["kind"];
  inspectorTitle: string;
  nodePath?: string;
  selectedNode?: GraphNodeDto;
  selectedSummary?: string;
  onClose: () => void;
}) {
  return (
    <section className="sidebar-card blueprint-inspector__card">
      <div className="sidebar-card__header">
        <div>
          <span className="window-bar__eyebrow">Inspector</span>
          <h2>{inspectorTitle}</h2>
        </div>
        <div className="blueprint-inspector__chrome">
          {inspectorKind ? <StatusPill tone="default">{inspectorKind}</StatusPill> : null}
          <button
            {...helpTargetProps("inspector.toggle", { label: inspectorTitle })}
            className="ghost-button"
            data-testid="blueprint-inspector-panel-collapse"
            type="button"
            onClick={onClose}
          >
            Collapse
          </button>
        </div>
      </div>

      <div className="blueprint-inspector__meta">
        <div className="info-card">
          <span className="info-card__label">Path</span>
          <strong>{nodePath ?? "No file path"}</strong>
          {selectedNode && selectedSummary && selectedSummary !== nodePath ? (
            <p>{selectedSummary}</p>
          ) : null}
          {!selectedNode && contextSummary && contextSummary !== nodePath ? (
            <p>{contextSummary}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
