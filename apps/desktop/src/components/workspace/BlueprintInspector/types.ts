import type { MouseEvent as ReactMouseEvent } from "react";
import type {
  EditableNodeSource,
  FlowFunctionInput,
  FlowInputDisplayMode,
  GraphActionDto,
  GraphNodeDto,
  RevealedSource,
  SourceRange,
  StructuralEditRequest,
  SymbolDetails,
} from "../../../lib/adapter";
import type { WorkspaceActivity } from "../../../store/uiStore";
import type { AppContextMenuPosition } from "../../shared/AppContextMenu";

export type FlowFunctionInputPatch = {
  name?: string;
  defaultExpression?: string | null;
};

export type FlowFunctionInputDraftState = {
  name: string;
  defaultExpression: string;
};

export type InspectorContextMenuState = AppContextMenuPosition & {
  targetId?: string;
  focusElement?: HTMLElement | null;
};

export type OpenInspectorContextMenu = (
  event: ReactMouseEvent<HTMLElement>,
  targetId?: string,
) => void;

export type RunStructuralAction = (
  actionId: string,
  request: StructuralEditRequest,
  onSuccess?: () => void,
) => Promise<void>;

export type InspectorStructuralActions = {
  renameAction?: GraphActionDto;
  deleteAction?: GraphActionDto;
  moveAction?: GraphActionDto;
  addImportAction?: GraphActionDto;
  removeImportAction?: GraphActionDto;
};

export type BlueprintInspectorProps = {
  selectedNode?: GraphNodeDto;
  sourceContextNode?: GraphNodeDto;
  moduleActionNode?: GraphNodeDto;
  destinationModulePaths?: string[];
  symbol?: SymbolDetails;
  editableSource?: EditableNodeSource;
  editableSourceLoading: boolean;
  editableSourceError?: string | null;
  draftStale?: boolean;
  revealedSource?: RevealedSource;
  lastActivity?: WorkspaceActivity;
  isSavingSource: boolean;
  highlightRange?: SourceRange;
  flowFunctionInputs?: FlowFunctionInput[];
  flowInputDisplayMode?: FlowInputDisplayMode;
  flowInputsEditable?: boolean;
  onApplyStructuralEdit?: (request: StructuralEditRequest) => Promise<unknown>;
  onAddFlowFunctionInput?: (draft: FlowFunctionInputPatch) => void;
  onUpdateFlowFunctionInput?: (inputId: string, patch: FlowFunctionInputPatch) => void;
  onMoveFlowFunctionInput?: (inputId: string, direction: -1 | 1) => void;
  onRemoveFlowFunctionInput?: (inputId: string) => void;
  onOpenNodeInDefaultEditor?: (targetId: string) => void | Promise<void>;
  onRevealNodeInFileExplorer?: (targetId: string) => void | Promise<void>;
  onSaveSource: (targetId: string, content: string) => Promise<void>;
  onEditorStateChange: (content?: string, dirty?: boolean) => void;
  onDismissSource: () => void;
  onClose: () => void;
};
