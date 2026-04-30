import { useRef } from "react";
import { Background, Controls, PanOnScrollMode, ReactFlow, SelectionMode } from "@xyflow/react";
import { AppContextMenu } from "../shared/AppContextMenu";
import {
  buildExpressionContextMenuItems,
  expressionContextMenuLabel,
} from "./FlowExpressionGraphCanvas/contextMenu";
import { isEditableEventTarget } from "./FlowExpressionGraphCanvas/domTargets";
import { ExpressionGraphToolbar } from "./FlowExpressionGraphCanvas/ExpressionGraphToolbar";
import { FlowExpressionConnectionLine } from "./FlowExpressionGraphCanvas/FlowExpressionConnectionLine";
import { expressionNodeTypes } from "./FlowExpressionGraphCanvas/ExpressionNodeView";
import { ExpressionSelectionPanel } from "./FlowExpressionGraphCanvas/ExpressionSelectionPanel";
import { useExpressionCanvasInteractions } from "./FlowExpressionGraphCanvas/useExpressionCanvasInteractions";
import { useExpressionGraphModel } from "./FlowExpressionGraphCanvas/useExpressionGraphModel";
import { useExpressionPanMode } from "./FlowExpressionGraphCanvas/useExpressionPanMode";
import type {
  ExpressionCanvasEdge,
  ExpressionCanvasNode,
  FlowExpressionGraphCanvasProps,
} from "./FlowExpressionGraphCanvas/types";

export type {
  FlowExpressionGraphCanvasChangeOptions,
  FlowExpressionGraphCanvasProps,
} from "./FlowExpressionGraphCanvas/types";

export function FlowExpressionGraphCanvas({
  diagnostics,
  error,
  expression,
  graph,
  inputSlots,
  isDraftOnly,
  isSaving,
  ownerLabel,
  selectedExpressionNodeId,
  onGraphChange,
  onNavigateOut,
  onSelectExpressionNode,
}: FlowExpressionGraphCanvasProps) {
  const panelRef = useRef<HTMLElement>(null);
  const model = useExpressionGraphModel({
    graph,
    inputSlots,
    onGraphChange,
    onSelectExpressionNode,
    selectedExpressionNodeId,
  });
  const panMode = useExpressionPanMode();
  const interactions = useExpressionCanvasInteractions({
    applyCanvasEdgeChanges: model.applyCanvasEdgeChanges,
    applyCanvasNodeChanges: model.applyCanvasNodeChanges,
    clearExpressionSelection: model.clearExpressionSelection,
    connectExpressionNodes: model.connectExpressionNodes,
    deleteExpressionEdges: model.deleteExpressionEdges,
    deleteExpressionNodes: model.deleteExpressionNodes,
    isValidConnection: model.isValidConnection,
    moveExpressionNode: model.moveExpressionNode,
    reconnectExpressionEdge: model.reconnectExpressionEdge,
    selectExpressionEdge: model.selectExpressionEdge,
    selectExpressionNode: model.selectExpressionNode,
    selectedEdgeId: model.selectedEdgeId,
  });
  const contextMenuItems = interactions.contextMenu
    ? buildExpressionContextMenuItems(interactions.contextMenu, {
        addExpressionNode: model.addExpressionNode,
        deleteExpressionEdges: model.deleteExpressionEdges,
        deleteExpressionNode: model.deleteExpressionNode,
        expression,
        normalizedGraph: model.normalizedGraph,
        onNavigateOut,
        setExpressionRoot: model.setExpressionRoot,
      })
    : [];

  return (
    <section
      ref={panelRef}
      className={`flow-expression-canvas${panMode.panModeActive ? " is-pan-active" : ""}`}
      data-testid="flow-expression-graph-canvas"
      role="region"
      tabIndex={0}
      onPointerOverCapture={panMode.handlePointerOver}
      onPointerOutCapture={panMode.handlePointerOut}
      onPointerDownCapture={(event) => {
        panMode.handlePointerDown(event);
        if (!isEditableEventTarget(event.target)) {
          panelRef.current?.focus();
        }
      }}
    >
      <header className="flow-expression-canvas__header">
        <div>
          <span className="window-bar__eyebrow">Return graph</span>
          <h3>{ownerLabel}</h3>
        </div>
        <div className="flow-expression-canvas__header-actions">
          <span className={`flow-expression-canvas__status${isDraftOnly ? " is-draft" : ""}`}>
            {isSaving ? "Saving" : isDraftOnly ? "Draft only" : "Live draft"}
          </span>
          <button className="ghost-button" type="button" onClick={onNavigateOut}>
            Back to Flow
          </button>
        </div>
      </header>
      <ExpressionGraphToolbar
        inputSlots={inputSlots}
        newInputSlotId={model.newInputSlotId}
        onAddExpressionNode={model.addExpressionNode}
        onChangeNewInputSlotId={model.setNewInputSlotId}
      />
      <div className="flow-expression-canvas__body">
        <div className="flow-expression-canvas__stage">
          <ReactFlow<ExpressionCanvasNode, ExpressionCanvasEdge>
            fitView
            fitViewOptions={{ padding: 0.24 }}
            proOptions={{ hideAttribution: true }}
            nodes={model.nodes}
            edges={model.edges}
            nodeTypes={expressionNodeTypes}
            onNodesChange={interactions.handleNodesChange}
            onEdgesChange={interactions.handleEdgesChange}
            onNodeClick={interactions.handleNodeClick}
            onNodeContextMenu={interactions.handleNodeContextMenu}
            onEdgeClick={interactions.handleEdgeClick}
            onEdgeContextMenu={interactions.handleEdgeContextMenu}
            onPaneClick={interactions.handlePaneClick}
            onPaneContextMenu={interactions.handlePaneContextMenu}
            onNodeDragStop={interactions.handleNodeDragStop}
            onNodesDelete={interactions.handleNodesDelete}
            onEdgesDelete={interactions.handleEdgesDelete}
            onConnect={interactions.handleConnect}
            onReconnect={interactions.handleReconnect}
            nodesDraggable
            nodesConnectable
            edgesReconnectable
            deleteKeyCode={["Backspace", "Delete"]}
            selectionKeyCode={null}
            multiSelectionKeyCode={["Meta", "Control", "Shift"]}
            selectionOnDrag={!panMode.panModeActive}
            selectionMode={SelectionMode.Partial}
            paneClickDistance={4}
            connectionLineComponent={FlowExpressionConnectionLine}
            connectionLineContainerStyle={{ pointerEvents: "none", zIndex: 30 }}
            connectionRadius={28}
            reconnectRadius={20}
            isValidConnection={interactions.isValidConnection}
            minZoom={0.25}
            maxZoom={1.8}
            zoomOnScroll={false}
            panOnScroll
            panOnScrollMode={PanOnScrollMode.Free}
            zoomActivationKeyCode="Alt"
            panOnDrag={panMode.panModeActive}
            onKeyDown={interactions.handleKeyDown}
          >
            <Controls showInteractive={false} />
            <Background gap={24} size={1} color="var(--line-strong)" />
          </ReactFlow>
          {interactions.contextActionError ? (
            <p className="error-copy graph-context-error">{interactions.contextActionError}</p>
          ) : null}
          {interactions.contextMenu ? (
            <AppContextMenu
              label={expressionContextMenuLabel(interactions.contextMenu)}
              items={contextMenuItems}
              position={interactions.contextMenu}
              onActionError={interactions.setContextActionError}
              onClose={interactions.closeContextMenu}
            />
          ) : null}
        </div>
        <ExpressionSelectionPanel
          diagnostics={diagnostics}
          error={error}
          expression={expression}
          inputSlots={inputSlots}
          isDraftOnly={isDraftOnly}
          normalizedGraph={model.normalizedGraph}
          onDeleteExpressionEdges={model.deleteExpressionEdges}
          onDeleteExpressionNode={model.deleteExpressionNode}
          onSetExpressionRoot={model.setExpressionRoot}
          onUpdateExpressionNode={model.updateExpressionNode}
          selectedEdge={model.selectedEdge}
          selectedNode={model.selectedNode}
          selectedTargetHandles={model.selectedTargetHandles}
        />
      </div>
    </section>
  );
}
