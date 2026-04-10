import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type PropsWithChildren,
} from "react";
import type {
  GraphEdgeKind,
  GraphNodeKind,
  OverviewOutlineKind,
} from "../../lib/adapter";

export interface HelpDescriptor {
  title: string;
  description: string;
  example?: string;
  shortcut?: string;
}

export type HelpDescriptorId =
  | "workspace.idle"
  | "explorer.open-repo"
  | "explorer.reindex"
  | "explorer.repo-graph"
  | "explorer.search"
  | "explorer.directory"
  | "explorer.file"
  | "explorer.disclosure"
  | "explorer.search-result"
  | "explorer.outline.function"
  | "explorer.outline.async_function"
  | "explorer.outline.class"
  | "explorer.outline.enum"
  | "explorer.outline.variable"
  | "graph.path.repo"
  | "graph.path.file"
  | "graph.path.symbol"
  | "graph.path.flow"
  | "graph.canvas"
  | "graph.toolbar.drag"
  | "graph.toolbar.focus"
  | "graph.toolbar.inspector"
  | "graph.toolbar.controls"
  | "graph.toolbar.settings"
  | "graph.toolbar.breadcrumb"
  | "graph.level.repo"
  | "graph.level.module"
  | "graph.level.symbol"
  | "graph.level.flow"
  | "graph.filter.calls"
  | "graph.filter.imports"
  | "graph.filter.defines"
  | "graph.filter.path"
  | "graph.filter.labels"
  | "graph.declutter"
  | "graph.undo-declutter"
  | "graph.settings.external-dependencies"
  | "graph.node.action.enter"
  | "graph.node.action.inspect"
  | "graph.node.action.pin"
  | "graph.node.action.unpin"
  | "graph.group.box"
  | "graph.node.repo"
  | "graph.node.module"
  | "graph.node.symbol"
  | "graph.node.function"
  | "graph.node.class"
  | "graph.node.enum"
  | "graph.node.variable"
  | "graph.node.reroute"
  | "graph.node.entry"
  | "graph.node.param"
  | "graph.node.assign"
  | "graph.node.call"
  | "graph.node.branch"
  | "graph.node.loop"
  | "graph.node.return"
  | "graph.port.contains"
  | "graph.port.imports"
  | "graph.port.calls"
  | "graph.port.defines"
  | "graph.port.controls"
  | "graph.port.data"
  | "graph.edge.contains"
  | "graph.edge.imports"
  | "graph.edge.calls"
  | "graph.edge.defines"
  | "graph.edge.controls"
  | "graph.edge.data"
  | "inspector.close"
  | "inspector.open-default-editor"
  | "inspector.reveal-source"
  | "inspector.open-flow"
  | "inspector.open-blueprint"
  | "inspector.editor"
  | "inspector.save"
  | "inspector.cancel";

export interface HelpRuntimeArgs {
  label?: string;
  kind?: string;
}

export interface ResolvedHelpState extends HelpDescriptor {
  id: HelpDescriptorId;
}

interface HelpTarget {
  id: HelpDescriptorId;
  args?: HelpRuntimeArgs;
}

interface WorkspaceHelpContextValue {
  currentHelp: ResolvedHelpState;
  setDomHelpTarget: (target: HelpTarget | null) => void;
  setTransientHelpTarget: (target: HelpTarget | null) => void;
}

function fallbackLabel(label: string | undefined, fallback: string) {
  return label?.trim() || fallback;
}

type HelpResolver = (args: HelpRuntimeArgs) => HelpDescriptor;

const HELP_REGISTRY: Record<HelpDescriptorId, HelpResolver> = {
  "workspace.idle": () => ({
    title: "Hover help",
    description: "Hover something in HELM to learn what it does.",
    example: "Try the graph, explorer, or inspector controls.",
  }),
  "explorer.open-repo": () => ({
    title: "Open repo",
    description: "Open a different local repository and rebuild the HELM workspace around it.",
  }),
  "explorer.reindex": () => ({
    title: "Reindex repo",
    description: "Rescan the current repository so the graph, search, and explorer outline stay up to date.",
  }),
  "explorer.repo-graph": () => ({
    title: "Repo graph",
    description: "Jump back to the repo-level graph view from wherever you are in the blueprint.",
  }),
  "explorer.search": () => ({
    title: "Search",
    description: "Jump to files and symbols in the current repo without digging through the tree manually.",
    shortcut: "Cmd/Ctrl + K",
  }),
  "explorer.directory": ({ label }) => ({
    title: `${fallbackLabel(label, "Folder")} folder`,
    description: "Directory in the repo explorer. Click to expand or collapse that branch of the tree.",
    shortcut: "Arrow Right / Arrow Left",
  }),
  "explorer.file": ({ label }) => ({
    title: `${fallbackLabel(label, "File")} file`,
    description: "Code file in the repo explorer. Click to focus its module graph, or expand it to see top-level code items.",
    shortcut: "Arrow Right / Arrow Left",
  }),
  "explorer.disclosure": ({ label }) => ({
    title: `Toggle ${fallbackLabel(label, "tree item")}`,
    description: "Expand or collapse this item without changing the current graph focus.",
    shortcut: "Arrow Right / Arrow Left",
  }),
  "explorer.search-result": ({ label }) => ({
    title: fallbackLabel(label, "Search result"),
    description: "Jump directly to the matching file or symbol from search results.",
  }),
  "explorer.outline.function": ({ label }) => ({
    title: `${fallbackLabel(label, "Function")} function`,
    description: "Top-level function listed in file order. Selecting it focuses the function node in the graph.",
  }),
  "explorer.outline.async_function": ({ label }) => ({
    title: `${fallbackLabel(label, "Async function")} async function`,
    description: "Top-level async function listed in file order. Selecting it focuses the function node in the graph.",
  }),
  "explorer.outline.class": ({ label }) => ({
    title: `${fallbackLabel(label, "Class")} class`,
    description: "Top-level class listed in file order. Selecting it opens that class as a graph node target.",
  }),
  "explorer.outline.enum": ({ label }) => ({
    title: `${fallbackLabel(label, "Enum")} enum`,
    description: "Top-level enum listed in file order. Selecting it focuses the enum node in the graph.",
  }),
  "explorer.outline.variable": ({ label }) => ({
    title: `${fallbackLabel(label, "Variable")} variable`,
    description: "Top-level module variable listed in file order. Selecting it focuses the variable node in the graph.",
  }),
  "graph.path.repo": () => ({
    title: "Graph path: repo",
    description: "The repo boundary for the graph you are currently viewing.",
  }),
  "graph.path.file": ({ label }) => ({
    title: `${fallbackLabel(label, "File")} in Finder/Explorer`,
    description: "Reveal the current file in the system file explorer and open its containing folder.",
  }),
  "graph.path.symbol": ({ label }) => ({
    title: `${fallbackLabel(label, "Symbol")} graph path`,
    description: "Shows the current code symbol you are centered on inside the graph.",
  }),
  "graph.path.flow": () => ({
    title: "Flow path",
    description: "Shows that you are viewing the internal flow blueprint for the current function or class.",
    shortcut: "Backspace",
  }),
  "graph.canvas": () => ({
    title: "Graph canvas",
    description: "Main blueprint workspace. Click empty space to clear selection, drag to marquee-select, move nodes directly on the canvas, and group selected nodes together.",
    shortcut: "Cmd/Ctrl + G groups · Cmd/Ctrl + Shift + G ungroups · Hold Space to pan · Alt/Option + scroll to zoom · Backspace to go out",
  }),
  "graph.toolbar.drag": () => ({
    title: "Move graph controls",
    description: "Drag the floating graph controls anywhere on the canvas.",
  }),
  "graph.toolbar.focus": ({ label, kind }) => ({
    title: fallbackLabel(label, "Current graph focus"),
    description: `Current graph focus${kind ? ` at the ${kind} level` : ""}. Click to expand or collapse the floating controls.`,
  }),
  "graph.toolbar.inspector": () => ({
    title: "Inspector toggle",
    description: "Show or hide the docked inspector for the currently selected graph node.",
  }),
  "graph.toolbar.controls": () => ({
    title: "Graph controls",
    description: "Expand or collapse the floating graph control palette.",
  }),
  "graph.toolbar.settings": () => ({
    title: "Graph settings",
    description: "Open advanced graph visibility settings that stay out of the main control row.",
  }),
  "graph.toolbar.breadcrumb": ({ label }) => ({
    title: fallbackLabel(label, "Graph breadcrumb"),
    description: "Jump directly to another level in the current graph trail.",
  }),
  "graph.level.repo": () => ({
    title: "Repo level",
    description: "Shows the repo boundary and broad first-party structure.",
  }),
  "graph.level.module": () => ({
    title: "Module level",
    description: "Shows file-to-file relationships inside the repo.",
  }),
  "graph.level.symbol": () => ({
    title: "Symbol level",
    description: "Shows top-level code symbols and how they relate inside the current file or context.",
  }),
  "graph.level.flow": () => ({
    title: "Flow level",
    description: "Shows the inside of a function or class as a node-based internal graph.",
  }),
  "graph.filter.calls": () => ({
    title: "Calls filter",
    description: "Show or hide call relationships in the current graph view.",
  }),
  "graph.filter.imports": () => ({
    title: "Imports filter",
    description: "Show or hide import relationships in the current graph view.",
  }),
  "graph.filter.defines": () => ({
    title: "Defines filter",
    description: "Show or hide ownership and definition relationships in the current graph view.",
  }),
  "graph.filter.path": () => ({
    title: "Path highlight",
    description: "Highlight the currently selected graph path more strongly across the canvas.",
  }),
  "graph.filter.labels": () => ({
    title: "Edge labels",
    description: "Show or hide text labels on graph edges.",
  }),
  "graph.declutter": () => ({
    title: "Declutter",
    description: "Re-run layout for the current graph view. Flow views use a structured left-to-right pass, while the camera stays where it is.",
  }),
  "graph.undo-declutter": () => ({
    title: "Undo declutter",
    description: "Restore the last saved node positions and pin state from before the current view was decluttered.",
  }),
  "graph.settings.external-dependencies": () => ({
    title: "Show external dependencies",
    description: "Include outside-library modules and edges in the current graph. Off keeps the default authored-only view.",
  }),
  "graph.node.action.enter": () => ({
    title: "Enter node",
    description: "Open a deeper graph view for this node. Double-clicking the node does the same thing.",
  }),
  "graph.node.action.inspect": () => ({
    title: "Inspect node",
    description: "Open the docked inspector for this code node. Double-clicking the node does the same thing.",
  }),
  "graph.node.action.pin": () => ({
    title: "Pin node",
    description: "Keep this node fixed as an anchor the next time flow declutter runs.",
    shortcut: "P",
  }),
  "graph.node.action.unpin": () => ({
    title: "Unpin node",
    description: "Let flow declutter reposition this node again during the next structured layout pass.",
    shortcut: "P",
  }),
  "graph.group.box": ({ label }) => ({
    title: `${fallbackLabel(label, "Node group")} group`,
    description: "Canvas boundary that keeps grouped nodes moving together. Click the title to rename it or use the Ungroup chip to break the group apart.",
    shortcut: "Cmd/Ctrl + G groups selected nodes · Cmd/Ctrl + Shift + G ungroups",
  }),
  "graph.node.repo": ({ label }) => ({
    title: `${fallbackLabel(label, "Repo")} repo node`,
    description: "Represents the repo boundary at the top of the architecture graph.",
  }),
  "graph.node.module": ({ label }) => ({
    title: `${fallbackLabel(label, "Module")} module node`,
    description: "Represents a code file. Modules connect through imports, calls, and definitions.",
  }),
  "graph.node.symbol": ({ label }) => ({
    title: `${fallbackLabel(label, "Symbol")} symbol node`,
    description: "Represents a top-level code symbol in the graph.",
  }),
  "graph.node.function": ({ label }) => ({
    title: `${fallbackLabel(label, "Function")} function node`,
    description: "Represents a top-level function. Inspect it to edit source or open its internal flow.",
  }),
  "graph.node.class": ({ label }) => ({
    title: `${fallbackLabel(label, "Class")} class node`,
    description: "Represents a top-level class. Enter it to graph class internals, inspect it to review code details, or open its internal flow.",
  }),
  "graph.node.enum": ({ label }) => ({
    title: `${fallbackLabel(label, "Enum")} enum node`,
    description: "Represents a top-level enum. Inspect it to review details and source location.",
  }),
  "graph.node.variable": ({ label }) => ({
    title: `${fallbackLabel(label, "Variable")} variable node`,
    description: "Represents a top-level module variable. Inspect it to edit or review its declaration.",
  }),
  "graph.node.reroute": () => ({
    title: "Reroute node",
    description: "Visual-only waypoint for reshaping an edge. Drag it to redirect the wire without changing code semantics.",
    shortcut: "Delete / Backspace removes selected reroutes",
  }),
  "graph.node.entry": ({ label }) => ({
    title: `${fallbackLabel(label, "Entry")} entry node`,
    description: "Starting execution point for the current function flow.",
  }),
  "graph.node.param": ({ label }) => ({
    title: `${fallbackLabel(label, "Parameter")} parameter node`,
    description: "Represents one input coming from the function signature into the flow graph.",
  }),
  "graph.node.assign": ({ label }) => ({
    title: `${fallbackLabel(label, "Assignment")} assign node`,
    description: "Represents a value assignment or value-producing operation in the flow graph.",
  }),
  "graph.node.call": ({ label }) => ({
    title: `${fallbackLabel(label, "Call")} call node`,
    description: "Represents a function or method invocation inside the current flow.",
  }),
  "graph.node.branch": ({ label }) => ({
    title: `${fallbackLabel(label, "Branch")} branch node`,
    description: "Represents a conditional split in the function flow.",
  }),
  "graph.node.loop": ({ label }) => ({
    title: `${fallbackLabel(label, "Loop")} loop node`,
    description: "Represents iteration or repeated control flow in the current function.",
  }),
  "graph.node.return": ({ label }) => ({
    title: `${fallbackLabel(label, "Return")} return node`,
    description: "Represents a return path that exits the current function flow.",
  }),
  "graph.port.contains": () => ({
    title: "Contains port",
    description: "Grouped ownership connections for this node.",
  }),
  "graph.port.imports": () => ({
    title: "Imports port",
    description: "Grouped import relationships. Hover it to trace every import connected to this handle.",
  }),
  "graph.port.calls": () => ({
    title: "Calls port",
    description: "Grouped call relationships. Hover it to trace every call connected to this handle.",
  }),
  "graph.port.defines": () => ({
    title: "Defines port",
    description: "Grouped definition or ownership relationships for this node.",
  }),
  "graph.port.controls": () => ({
    title: "Execution port",
    description: "Control-flow handle. It shows what runs next in a function flow.",
  }),
  "graph.port.data": () => ({
    title: "Data port",
    description: "Data-flow handle. It shows values moving between nodes in a function flow.",
  }),
  "graph.edge.contains": () => ({
    title: "Contains edge",
    description: "Ownership link between graph nodes.",
  }),
  "graph.edge.imports": () => ({
    title: "Imports edge",
    description: "Shows that one module imports another module or symbol.",
  }),
  "graph.edge.calls": () => ({
    title: "Calls edge",
    description: "Shows a call relationship between two graph nodes.",
  }),
  "graph.edge.defines": () => ({
    title: "Defines edge",
    description: "Shows that one node defines or owns another node.",
  }),
  "graph.edge.controls": () => ({
    title: "Execution edge",
    description: "Control-flow path showing what executes next inside a function flow.",
  }),
  "graph.edge.data": () => ({
    title: "Data edge",
    description: "Value-flow path showing data moving between nodes inside a function flow.",
  }),
  "inspector.close": () => ({
    title: "Close inspector",
    description: "Hide the docked inspector. If you have unsaved changes, HELM asks whether to save first.",
  }),
  "inspector.open-default-editor": () => ({
    title: "Open file in default editor",
    description: "Open the selected node’s file in your system default code editor.",
  }),
  "inspector.reveal-source": () => ({
    title: "Reveal source",
    description: "Show the raw source range for this node on demand without making source the default view.",
  }),
  "inspector.open-flow": () => ({
    title: "Open flow",
    description: "Open the selected function or class as an internal flow graph.",
  }),
  "inspector.open-blueprint": () => ({
    title: "Open blueprint",
    description: "Open the symbol-level blueprint centered on this function.",
  }),
  "inspector.editor": () => ({
    title: "Declaration editor",
    description: "Edit the selected declaration inline. Save writes back to the repo and refreshes the graph.",
  }),
  "inspector.save": () => ({
    title: "Save source",
    description: "Write the current declaration changes back into the repo.",
  }),
  "inspector.cancel": () => ({
    title: "Cancel edits",
    description: "Discard unsaved declaration changes and restore the last synced source.",
  }),
};

function resolveHelpTarget(target: HelpTarget | null): ResolvedHelpState | null {
  if (!target) {
    return null;
  }

  const resolver = HELP_REGISTRY[target.id];
  if (!resolver) {
    return null;
  }

  return {
    id: target.id,
    ...resolver(target.args ?? {}),
  };
}

export function resolveHelpDescriptor(
  id: HelpDescriptorId,
  args: HelpRuntimeArgs = {},
): ResolvedHelpState {
  return resolveHelpTarget({ id, args }) ?? {
    id,
    title: "Hover help",
    description: "Hover something in HELM to learn what it does.",
  };
}

const DEFAULT_WORKSPACE_HELP_CONTEXT: WorkspaceHelpContextValue = {
  currentHelp: resolveHelpDescriptor("workspace.idle"),
  setDomHelpTarget: () => {},
  setTransientHelpTarget: () => {},
};

const WorkspaceHelpContext = createContext<WorkspaceHelpContextValue>(
  DEFAULT_WORKSPACE_HELP_CONTEXT,
);

function readDatasetValue(
  dataset: DOMStringMap,
  key: "helpLabel" | "helpKind",
): string | undefined {
  const value = dataset[key];
  return value?.trim() ? value : undefined;
}

function readHelpTargetFromElement(element: HTMLElement | null): HelpTarget | null {
  const annotated = element?.closest<HTMLElement>("[data-help-id]");
  if (!annotated) {
    return null;
  }

  const id = annotated.dataset.helpId as HelpDescriptorId | undefined;
  if (!id) {
    return null;
  }

  return {
    id,
    args: {
      label: readDatasetValue(annotated.dataset, "helpLabel"),
      kind: readDatasetValue(annotated.dataset, "helpKind"),
    },
  };
}

export function helpTargetProps(
  id: HelpDescriptorId,
  args: HelpRuntimeArgs = {},
): Record<string, string> {
  const props: Record<string, string> = {
    "data-help-id": id,
  };

  if (args.label) {
    props["data-help-label"] = args.label;
  }
  if (args.kind) {
    props["data-help-kind"] = args.kind;
  }

  return props;
}

export function helpIdForGraphNodeKind(kind: GraphNodeKind): HelpDescriptorId {
  switch (kind) {
    case "repo":
      return "graph.node.repo";
    case "module":
      return "graph.node.module";
    case "function":
      return "graph.node.function";
    case "class":
      return "graph.node.class";
    case "enum":
      return "graph.node.enum";
    case "variable":
      return "graph.node.variable";
    case "entry":
      return "graph.node.entry";
    case "param":
      return "graph.node.param";
    case "assign":
      return "graph.node.assign";
    case "call":
      return "graph.node.call";
    case "branch":
      return "graph.node.branch";
    case "loop":
      return "graph.node.loop";
    case "return":
      return "graph.node.return";
    default:
      return "graph.node.symbol";
  }
}

export function helpIdForOutlineKind(kind: OverviewOutlineKind): HelpDescriptorId {
  switch (kind) {
    case "class":
      return "explorer.outline.class";
    case "enum":
      return "explorer.outline.enum";
    case "variable":
      return "explorer.outline.variable";
    case "async_function":
      return "explorer.outline.async_function";
    default:
      return "explorer.outline.function";
  }
}

export function helpIdForGraphEdgeKind(kind: GraphEdgeKind): HelpDescriptorId {
  switch (kind) {
    case "contains":
      return "graph.edge.contains";
    case "imports":
      return "graph.edge.imports";
    case "defines":
      return "graph.edge.defines";
    case "calls":
      return "graph.edge.calls";
    case "controls":
      return "graph.edge.controls";
    default:
      return "graph.edge.data";
  }
}

export function helpIdForPort(kind: "graph" | "control" | "data", label: string): HelpDescriptorId {
  if (kind === "control") {
    return "graph.port.controls";
  }
  if (kind === "data") {
    return "graph.port.data";
  }

  switch (label.toLowerCase()) {
    case "imports":
      return "graph.port.imports";
    case "calls":
      return "graph.port.calls";
    case "defines":
      return "graph.port.defines";
    case "contains":
      return "graph.port.contains";
    default:
      return "graph.port.data";
  }
}

export function useWorkspaceHelp() {
  return useContext(WorkspaceHelpContext);
}

export function WorkspaceHelpProvider({ children }: PropsWithChildren) {
  const [domHelpTarget, setDomHelpTarget] = useState<HelpTarget | null>(null);
  const [transientHelpTarget, setTransientHelpTarget] = useState<HelpTarget | null>(null);

  const currentHelp = useMemo(
    () =>
      resolveHelpTarget(transientHelpTarget)
      ?? resolveHelpTarget(domHelpTarget)
      ?? resolveHelpDescriptor("workspace.idle"),
    [domHelpTarget, transientHelpTarget],
  );

  const value = useMemo<WorkspaceHelpContextValue>(
    () => ({
      currentHelp,
      setDomHelpTarget,
      setTransientHelpTarget,
    }),
    [currentHelp],
  );

  return (
    <WorkspaceHelpContext.Provider value={value}>
      {children}
    </WorkspaceHelpContext.Provider>
  );
}

export function WorkspaceHelpScope({
  children,
  onPointerLeave,
  onPointerOverCapture,
  ...props
}: ComponentPropsWithoutRef<"main">) {
  const { setDomHelpTarget } = useWorkspaceHelp();

  return (
    <main
      {...props}
      onPointerOverCapture={(event) => {
        setDomHelpTarget(readHelpTargetFromElement(event.target as HTMLElement | null));
        onPointerOverCapture?.(event);
      }}
      onPointerLeave={(event) => {
        setDomHelpTarget(null);
        onPointerLeave?.(event);
      }}
    >
      {children}
    </main>
  );
}

export function WorkspaceHelpBox() {
  const { currentHelp } = useWorkspaceHelp();

  return (
    <section aria-live="polite" className="workspace-help-box">
      <div className="workspace-help-box__title-row">
        <strong className="workspace-help-box__title">{currentHelp.title}</strong>
      </div>
      <p className="workspace-help-box__description">{currentHelp.description}</p>
      {currentHelp.example || currentHelp.shortcut ? (
        <div className="workspace-help-box__meta">
          {currentHelp.example ? (
            <span className="workspace-help-box__meta-item">
              <strong>Example</strong>
              <span>{currentHelp.example}</span>
            </span>
          ) : null}
          {currentHelp.shortcut ? (
            <span className="workspace-help-box__meta-item">
              <strong>Shortcut</strong>
              <span>{currentHelp.shortcut}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
