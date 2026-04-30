import type {
  BackendUndoResult,
  BackendUndoTransaction,
  EditableNodeSource,
  RevealedSource,
  StructuralEditRequest,
  StructuralEditResult,
} from "../contracts";
import type {
  RawApplyEditResponse,
  RawApplyUndoResponse,
  RawBackendUndoTransaction,
  RawEditableNodeSource,
  RawEditResult,
  RawScanPayload,
  RawUndoResult,
  ScanCache,
} from "./rawTypes";
import { relativePathForNode } from "./scanCache";
import { normalizePath, toRecoveryEvents, type InvokeCommand } from "./shared";

export type EditMutationCommandResult = { result: StructuralEditResult; payload: RawScanPayload };
export type UndoMutationCommandResult = { result: BackendUndoResult; payload: RawScanPayload };

export function toRawEditRequest(request: StructuralEditRequest) {
  return {
    kind: request.kind,
    target_id: request.targetId,
    relative_path: request.relativePath,
    new_name: request.newName,
    symbol_kind: request.symbolKind,
    destination_relative_path: request.destinationRelativePath,
    imported_module: request.importedModule,
    imported_name: request.importedName,
    alias: request.alias,
    anchor_edge_id: request.anchorEdgeId,
    body: request.body,
    content: request.content,
    flow_graph: request.flowGraph
      ? {
          symbol_id: request.flowGraph.symbolId,
          relative_path: request.flowGraph.relativePath,
          qualname: request.flowGraph.qualname,
          nodes: request.flowGraph.nodes.map((node) => ({
            id: node.id,
            kind: node.kind,
            payload: node.payload,
            ...(node.indexedNodeId ? { indexed_node_id: node.indexedNodeId } : {}),
          })),
          edges: request.flowGraph.edges.map((edge) => ({
            id: edge.id,
            source_id: edge.sourceId,
            source_handle: edge.sourceHandle,
            target_id: edge.targetId,
            target_handle: edge.targetHandle,
          })),
          value_model_version: request.flowGraph.valueModelVersion ?? 1,
          function_inputs: (request.flowGraph.functionInputs ?? []).map((input) => ({
            id: input.id,
            name: input.name,
            index: input.index,
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.defaultExpression !== undefined
              ? { default_expression: input.defaultExpression }
              : {}),
          })),
          value_sources: (request.flowGraph.valueSources ?? []).map((source) => ({
            id: source.id,
            node_id: source.nodeId,
            name: source.name,
            label: source.label,
            ...(source.emittedName ? { emitted_name: source.emittedName } : {}),
          })),
          input_slots: (request.flowGraph.inputSlots ?? []).map((slot) => ({
            id: slot.id,
            node_id: slot.nodeId,
            slot_key: slot.slotKey,
            label: slot.label,
            required: slot.required,
          })),
          input_bindings: (request.flowGraph.inputBindings ?? []).map((binding) => ({
            id: binding.id,
            source_id: binding.sourceId,
            ...(binding.functionInputId ? { function_input_id: binding.functionInputId } : {}),
            slot_id: binding.slotId,
          })),
          sync_state: request.flowGraph.syncState,
          diagnostics: request.flowGraph.diagnostics,
          source_hash: request.flowGraph.sourceHash ?? null,
          editable: request.flowGraph.editable,
        }
      : undefined,
  };
}

export function toRawUndoTransaction(transaction: BackendUndoTransaction) {
  return {
    summary: transaction.summary,
    request_kind: transaction.requestKind,
    file_snapshots: transaction.fileSnapshots.map((snapshot) => ({
      relative_path: snapshot.relativePath,
      existed: snapshot.existed,
      content: snapshot.content ?? null,
    })),
    changed_node_ids: transaction.changedNodeIds,
    focus_target: transaction.focusTarget
      ? {
          target_id: transaction.focusTarget.targetId,
          level: transaction.focusTarget.level,
        }
      : null,
    snapshot_token: transaction.snapshotToken ?? null,
    touched_relative_paths: transaction.touchedRelativePaths ?? [],
  };
}

export function fromRawUndoTransaction(raw: RawBackendUndoTransaction): BackendUndoTransaction {
  return {
    summary: raw.summary,
    requestKind: raw.request_kind,
    fileSnapshots: raw.file_snapshots.map((snapshot) => ({
      relativePath: snapshot.relative_path,
      existed: snapshot.existed,
      content: snapshot.content ?? undefined,
    })),
    changedNodeIds: raw.changed_node_ids,
    focusTarget: raw.focus_target
      ? {
          targetId: raw.focus_target.target_id,
          level: raw.focus_target.level,
        }
      : undefined,
    snapshotToken: raw.snapshot_token ?? undefined,
    touchedRelativePaths: raw.touched_relative_paths ?? [],
  };
}

export function toStructuralEditResult(raw: RawEditResult): StructuralEditResult {
  return {
    request: raw.request,
    summary: raw.summary,
    touchedRelativePaths: raw.touched_relative_paths,
    reparsedRelativePaths: raw.reparsed_relative_paths,
    changedNodeIds: raw.changed_node_ids,
    warnings: raw.warnings,
    flowSyncState: raw.flow_sync_state ?? null,
    diagnostics: raw.diagnostics ?? [],
    undoTransaction: raw.undo_transaction
      ? fromRawUndoTransaction(raw.undo_transaction)
      : undefined,
    recoveryEvents: toRecoveryEvents(raw.recovery_events),
  };
}

export function toBackendUndoResult(raw: RawUndoResult) {
  return {
    summary: raw.summary,
    restoredRelativePaths: raw.restored_relative_paths,
    warnings: raw.warnings,
    focusTarget: raw.focus_target
      ? {
          targetId: raw.focus_target.target_id,
          level: raw.focus_target.level,
        }
      : undefined,
    redoTransaction: raw.redo_transaction
      ? fromRawUndoTransaction(raw.redo_transaction)
      : undefined,
    recoveryEvents: toRecoveryEvents(raw.recovery_events),
  };
}

export async function applyStructuralEditCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  request: StructuralEditRequest,
): Promise<EditMutationCommandResult> {
  const response = await invokeCommand<RawApplyEditResponse>("apply_structural_edit", {
    repoPath: cache.session.path,
    requestJson: JSON.stringify(toRawEditRequest(request)),
  });
  return { result: toStructuralEditResult(response.edit), payload: response.payload };
}

export async function applyBackendUndoCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  transaction: BackendUndoTransaction,
): Promise<UndoMutationCommandResult> {
  const response = await invokeCommand<RawApplyUndoResponse>("apply_backend_undo", {
    repoPath: cache.session.path,
    transactionJson: JSON.stringify(toRawUndoTransaction(transaction)),
  });
  return { result: toBackendUndoResult(response.undo), payload: response.payload };
}

export async function revealSourceCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  targetId: string,
): Promise<RevealedSource> {
  const raw = await invokeCommand<{
    target_id: string;
    title: string;
    path: string;
    start_line: number;
    end_line: number;
    content: string;
  }>("reveal_source", { repoPath: cache.session.path, targetId });
  return {
    targetId: raw.target_id,
    title: raw.title,
    path: raw.path,
    startLine: raw.start_line,
    endLine: raw.end_line,
    content: raw.content,
  };
}

export async function getEditableNodeSourceCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  targetId: string,
): Promise<EditableNodeSource> {
  const raw = await invokeCommand<RawEditableNodeSource>("editable_node_source", {
    repoPath: cache.session.path,
    targetId,
  });
  return {
    targetId: raw.target_id,
    title: raw.title,
    path: raw.path,
    startLine: raw.start_line,
    endLine: raw.end_line,
    startColumn: raw.start_column ?? undefined,
    endColumn: raw.end_column ?? undefined,
    content: raw.content,
    editable: raw.editable,
    nodeKind: raw.node_kind,
    reason: raw.reason ?? undefined,
  };
}

export async function saveNodeSourceCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  targetId: string,
  content: string,
): Promise<EditMutationCommandResult> {
  const response = await invokeCommand<RawApplyEditResponse>("save_node_source", {
    repoPath: cache.session.path,
    targetId,
    contentJson: JSON.stringify(content),
  });
  return { result: toStructuralEditResult(response.edit), payload: response.payload };
}

export async function openNodeInDefaultEditorCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  targetId: string,
): Promise<void> {
  const node = cache.nodeById.get(targetId);
  if (!node?.file_path) {
    throw new Error("No source file is associated with " + targetId + ".");
  }
  await openPathInDefaultEditorCommand(invokeCommand, cache, relativePathForNode(node, cache));
}

export async function openPathInDefaultEditorCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  relativePath: string,
): Promise<void> {
  await invokeCommand<void>("open_repo_path_in_default_editor", {
    repoPath: cache.session.path,
    relativePath: normalizePath(relativePath),
  });
}

export async function revealNodeInFileExplorerCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  targetId: string,
): Promise<void> {
  const node = cache.nodeById.get(targetId);
  if (!node?.file_path) {
    throw new Error("No source file is associated with " + targetId + ".");
  }
  await revealPathInFileExplorerCommand(invokeCommand, cache, relativePathForNode(node, cache));
}

export async function revealPathInFileExplorerCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  relativePath: string,
): Promise<void> {
  await invokeCommand<void>("reveal_repo_path_in_file_explorer", {
    repoPath: cache.session.path,
    relativePath: normalizePath(relativePath),
  });
}
