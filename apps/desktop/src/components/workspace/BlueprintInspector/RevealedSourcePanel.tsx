import type { RevealedSource } from "../../../lib/adapter";
import { InspectorCodeSurface } from "../../editor/InspectorCodeSurface";
import { helpTargetProps } from "../workspaceHelp";
import type { OpenInspectorContextMenu } from "./types";

export function RevealedSourcePanel({
  revealedSource,
  sourceLanguage,
  onDismissSource,
  onOpenContextMenu,
}: {
  revealedSource?: RevealedSource;
  sourceLanguage: string;
  onDismissSource: () => void;
  onOpenContextMenu: OpenInspectorContextMenu;
}) {
  if (!revealedSource) {
    return null;
  }

  return (
    <section
      className="sidebar-section blueprint-inspector__section blueprint-inspector__section--revealed"
      onContextMenu={(event) => onOpenContextMenu(event, revealedSource.targetId)}
    >
      <div className="section-header">
        <h3>Revealed Source</h3>
        <button
          {...helpTargetProps("inspector.reveal-source")}
          className="ghost-button"
          type="button"
          onClick={onDismissSource}
        >
          Hide
        </button>
      </div>
      <div className="info-card">
        <strong>{revealedSource.path}</strong>
        <p>
          Lines {revealedSource.startLine}-{revealedSource.endLine}
        </p>
      </div>
      <InspectorCodeSurface
        ariaLabel="Revealed source"
        className="blueprint-source-panel"
        dataTestId="inspector-revealed-source"
        height="clamp(220px, 28vh, 320px)"
        language={sourceLanguage}
        path={revealedSource.path}
        readOnly
        startLine={revealedSource.startLine}
        value={revealedSource.content}
      />
    </section>
  );
}
