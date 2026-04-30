import { useCallback, useEffect, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  DesktopAdapter,
  EditableNodeSource,
  GraphAbstractionLevel,
  GraphNodeDto,
  GraphView,
} from "../../lib/adapter";
import {
  graphNodeRelativePath,
  graphNodeSourceRange,
  inspectorSourceTargetForId,
  inspectorSourceTargetForNode,
  readonlyEditableSourceFromReveal,
} from "./workspaceScreenModel";
import { workspaceQueryKeys } from "./workspaceQueries";
import type { InspectorPanelMode } from "./types";

type EffectiveInspectorDrawerMode = "collapsed" | "expanded" | "hidden";

export function useInspectorSourceState({
  activeLevel,
  adapter,
  currentModuleNode,
  dismissedPeekNodeId,
  effectiveGraph,
  graphTargetId,
  inspectorDraftContentRef,
  repoSessionId,
  selectedGraphNode,
  selectedInspectableNode,
}: {
  activeLevel: GraphAbstractionLevel;
  adapter: DesktopAdapter;
  currentModuleNode?: GraphNodeDto;
  dismissedPeekNodeId?: string;
  effectiveGraph?: GraphView;
  graphTargetId?: string;
  inspectorDraftContentRef: MutableRefObject<string | undefined>;
  repoSessionId?: string;
  selectedGraphNode?: GraphNodeDto;
  selectedInspectableNode?: GraphNodeDto;
}) {
  const [inspectorPanelMode, setInspectorPanelMode] = useState<InspectorPanelMode>("hidden");
  const [inspectorTargetId, setInspectorTargetId] = useState<string | undefined>(undefined);
  const [inspectorSnapshot, setInspectorSnapshot] = useState<GraphView["nodes"][number]>();
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const [inspectorDraftStale, setInspectorDraftStale] = useState(false);
  const [inspectorEditableSourceOverride, setInspectorEditableSourceOverride] = useState<
    EditableNodeSource | undefined
  >(undefined);
  const [inspectorSourceVersion, setInspectorSourceVersion] = useState(0);

  useEffect(() => {
    if (!inspectorTargetId || !effectiveGraph) {
      return;
    }

    const matching = effectiveGraph.nodes.find((node) => node.id === inspectorTargetId);
    if (matching) {
      setInspectorSnapshot(matching);
    }
  }, [effectiveGraph, inspectorTargetId]);

  const inspectorNode = useMemo(() => {
    if (inspectorTargetId) {
      return (
        effectiveGraph?.nodes.find((node) => node.id === inspectorTargetId) ?? inspectorSnapshot
      );
    }
    if (inspectorPanelMode !== "hidden" && selectedGraphNode) {
      return selectedGraphNode;
    }
    return undefined;
  }, [effectiveGraph, inspectorPanelMode, inspectorSnapshot, inspectorTargetId, selectedGraphNode]);
  const inspectorSelectionNode = inspectorPanelMode !== "hidden" ? selectedGraphNode : undefined;
  const previewInspectorNode =
    inspectorPanelMode === "hidden" && selectedInspectableNode?.id !== dismissedPeekNodeId
      ? selectedInspectableNode
      : undefined;
  const inspectorSourceTarget = useMemo(() => {
    const pinnedTarget = inspectorSourceTargetForId(inspectorTargetId, "pinned", inspectorNode);
    if (pinnedTarget) {
      return pinnedTarget;
    }

    if (activeLevel === "module" || activeLevel === "symbol") {
      const selectedTarget = inspectorSourceTargetForNode(selectedGraphNode, "selected");
      if (selectedTarget) {
        return selectedTarget;
      }
    }

    if (activeLevel === "flow") {
      const flowOwnerTarget = inspectorSourceTargetForId(
        graphTargetId,
        "flow-owner",
        inspectorNode?.id === graphTargetId ? inspectorNode : undefined,
      );
      if (flowOwnerTarget) {
        return flowOwnerTarget;
      }
    }

    if (activeLevel === "module") {
      const moduleContextTarget =
        inspectorSourceTargetForNode(currentModuleNode, "module-context") ??
        inspectorSourceTargetForId(graphTargetId, "module-context", currentModuleNode);
      if (moduleContextTarget) {
        return moduleContextTarget;
      }
    }

    return undefined;
  }, [
    activeLevel,
    currentModuleNode,
    graphTargetId,
    inspectorNode,
    inspectorTargetId,
    selectedGraphNode,
  ]);
  const inspectorSymbolTargetId =
    inspectorSourceTarget?.fetchMode === "editable" &&
    inspectorSourceTarget.targetId.startsWith("symbol:")
      ? inspectorSourceTarget.targetId
      : undefined;
  const symbolQuery = useQuery({
    queryKey: workspaceQueryKeys.symbol(inspectorSymbolTargetId),
    queryFn: () => adapter.getSymbol(inspectorSymbolTargetId as string),
    enabled: Boolean(inspectorSymbolTargetId),
  });
  const shouldShowInspectorDrawer = Boolean(repoSessionId && (graphTargetId || effectiveGraph));
  const effectiveInspectorDrawerMode: EffectiveInspectorDrawerMode =
    inspectorPanelMode === "expanded"
      ? "expanded"
      : shouldShowInspectorDrawer
        ? "collapsed"
        : "hidden";
  const effectiveInspectorNode =
    inspectorPanelMode === "hidden" ? previewInspectorNode : inspectorNode;
  const inspectorHighlightRange = useMemo(
    () =>
      inspectorPanelMode !== "hidden" && activeLevel === "flow"
        ? graphNodeSourceRange(selectedGraphNode)
        : undefined,
    [activeLevel, inspectorPanelMode, selectedGraphNode],
  );

  const editableSourceQuery = useQuery({
    queryKey: workspaceQueryKeys.editableNodeSource(
      repoSessionId,
      inspectorSourceTarget?.fetchMode,
      inspectorSourceTarget?.targetId,
    ),
    queryFn: async () => {
      if (!inspectorSourceTarget) {
        throw new Error("Inspector source target is not available.");
      }

      if (inspectorSourceTarget.fetchMode === "editable") {
        return adapter.getEditableNodeSource(inspectorSourceTarget.targetId);
      }

      const source = await adapter.revealSource(inspectorSourceTarget.targetId);
      return readonlyEditableSourceFromReveal(source, inspectorSourceTarget.nodeKind);
    },
    enabled: Boolean(inspectorPanelMode !== "hidden" && inspectorSourceTarget),
  });
  const effectiveEditableSource =
    inspectorEditableSourceOverride?.targetId === inspectorSourceTarget?.targetId
      ? inspectorEditableSourceOverride
      : editableSourceQuery.data;
  const inspectorSourcePath =
    effectiveEditableSource?.path ??
    graphNodeRelativePath(
      inspectorSourceTarget?.node?.metadata,
      inspectorSourceTarget?.node?.subtitle,
    );

  useEffect(() => {
    if (
      inspectorEditableSourceOverride &&
      inspectorEditableSourceOverride.targetId !== inspectorSourceTarget?.targetId
    ) {
      setInspectorEditableSourceOverride(undefined);
    }
  }, [inspectorEditableSourceOverride, inspectorSourceTarget?.targetId]);

  useEffect(() => {
    if (!inspectorDirty || !effectiveEditableSource?.targetId) {
      setInspectorDraftStale(false);
      return;
    }

    const currentDraft = inspectorDraftContentRef.current;
    if (
      effectiveEditableSource?.content !== undefined &&
      currentDraft !== undefined &&
      currentDraft === effectiveEditableSource.content
    ) {
      setInspectorDraftStale(false);
    }
  }, [
    effectiveEditableSource?.content,
    effectiveEditableSource?.targetId,
    inspectorDirty,
    inspectorDraftContentRef,
  ]);

  const handleInspectorEditorStateChange = useCallback(
    (content?: string, dirty?: boolean) => {
      inspectorDraftContentRef.current = content;
      setInspectorDirty((current) => {
        const next = Boolean(dirty);
        return current === next ? current : next;
      });
    },
    [inspectorDraftContentRef],
  );

  const resetInspectorSourceState = useCallback(() => {
    setInspectorPanelMode("hidden");
    setInspectorTargetId(undefined);
    setInspectorSnapshot(undefined);
    inspectorDraftContentRef.current = undefined;
    setInspectorDirty(false);
    setInspectorDraftStale(false);
    setInspectorEditableSourceOverride(undefined);
    setInspectorSourceVersion(0);
  }, [inspectorDraftContentRef]);

  return {
    editableSourceQuery,
    effectiveEditableSource,
    effectiveInspectorDrawerMode,
    effectiveInspectorNode,
    handleInspectorEditorStateChange,
    inspectorDirty,
    inspectorDraftStale,
    inspectorHighlightRange,
    inspectorNode,
    inspectorPanelMode,
    inspectorSelectionNode,
    inspectorSnapshot,
    previewInspectorNode,
    inspectorSourcePath,
    inspectorSourceTarget,
    inspectorSourceVersion,
    inspectorSymbolTargetId,
    inspectorTargetId,
    resetInspectorSourceState,
    setInspectorDirty,
    setInspectorDraftStale,
    setInspectorEditableSourceOverride,
    setInspectorPanelMode,
    setInspectorSnapshot,
    setInspectorSourceVersion,
    setInspectorTargetId,
    symbolQuery,
  };
}
