import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));
const eventState = vi.hoisted(() => ({
  callbacks: new Map<string, (event: { payload: unknown }) => void>(),
}));
const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
}));
const { openDialogMock, saveDialogMock } = vi.hoisted(() => ({
  openDialogMock: vi.fn(),
  saveDialogMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openDialogMock,
  save: saveDialogMock,
}));

import { LiveDesktopAdapter } from "./liveDesktopAdapter";
import type { IndexingJobState } from "./contracts";

describe("LiveDesktopAdapter", () => {
  function setRepoPathScanCache(adapter: LiveDesktopAdapter) {
    const repoPath = "/workspace/calculator";
    const node = {
      node_id: "module:calculator.app",
      kind: "module",
      name: "app",
      display_name: "app.py",
      module_name: "calculator.app",
      file_path: `${repoPath}/src/app.py`,
      metadata: {
        relative_path: "src/app.py",
      },
      is_external: false,
    };

    Reflect.set(adapter, "scanCache", {
      session: {
        id: `repo:${repoPath}`,
        name: "Calculator",
        path: repoPath,
        branch: "local",
        primaryLanguage: "Python",
        openedAt: "2026-04-09T00:00:00.000Z",
      },
      nodeById: new Map([[node.node_id, node]]),
      absolutePathByRelative: new Map([["src/app.py", node.file_path]]),
      relativePathByAbsolute: new Map([[node.file_path, "src/app.py"]]),
      searchEntries: [],
    });
  }

  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    openDialogMock.mockReset();
    saveDialogMock.mockReset();
    eventState.callbacks.clear();
    listenMock.mockImplementation(async (eventName, callback) => {
      eventState.callbacks.set(String(eventName), callback);
      return vi.fn();
    });
  });

  it("reads repo files through repo-scoped relative Tauri arguments", async () => {
    const adapter = new LiveDesktopAdapter();
    setRepoPathScanCache(adapter);
    invokeMock.mockResolvedValueOnce("print('hello')\n");

    const file = await adapter.getFile("src\\app.py");

    expect(invokeMock).toHaveBeenCalledWith("read_repo_file", {
      repoPath: "/workspace/calculator",
      relativePath: "src/app.py",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "read_repo_file",
      expect.objectContaining({ filePath: expect.any(String) }),
    );
    expect(file.path).toBe("src/app.py");
  });

  it("opens and reveals repo paths without sending absolute file targets", async () => {
    const adapter = new LiveDesktopAdapter();
    setRepoPathScanCache(adapter);
    invokeMock.mockResolvedValue(undefined);

    await adapter.openNodeInDefaultEditor("module:calculator.app");
    await adapter.revealPathInFileExplorer("src\\app.py");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "open_repo_path_in_default_editor", {
      repoPath: "/workspace/calculator",
      relativePath: "src/app.py",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "reveal_repo_path_in_file_explorer", {
      repoPath: "/workspace/calculator",
      relativePath: "src/app.py",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/open_path_in_default_editor|reveal_path_in_file_explorer/u),
      expect.anything(),
    );
  });

  it("returns null when new project selection is cancelled", async () => {
    const adapter = new LiveDesktopAdapter();
    saveDialogMock.mockResolvedValueOnce(null);

    const session = await adapter.createProject();

    expect(session).toBeNull();
    expect(saveDialogMock).toHaveBeenCalledWith({
      title: "Where would you like this new project?",
      defaultPath: "untitled-helm-project",
      canCreateDirectories: true,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("create_new_project", expect.anything());
  });

  it("creates a new project through the desktop command and returns a repo session", async () => {
    const adapter = new LiveDesktopAdapter();
    saveDialogMock.mockResolvedValueOnce("/workspace/untitled-helm-project");
    invokeMock.mockResolvedValueOnce({
      projectPath: "/workspace/untitled-helm-project",
      packageName: "untitled_helm_project",
    });

    const session = await adapter.createProject();

    expect(invokeMock).toHaveBeenCalledWith("create_new_project", {
      projectPath: "/workspace/untitled-helm-project",
    });
    expect(session).toMatchObject({
      id: "repo:/workspace/untitled-helm-project",
      name: "untitled-helm-project",
      path: "/workspace/untitled-helm-project",
      branch: "local",
      primaryLanguage: "Python",
    });
  });

  it("returns cyclic flow views without hanging the renderer", async () => {
    const adapter = new LiveDesktopAdapter();
    Reflect.set(adapter, "scanCache", {
      session: {
        id: "repo:/workspace/calculator",
        name: "Calculator",
        path: "/workspace/calculator",
        branch: "local",
        primaryLanguage: "Python",
        openedAt: "2026-04-09T00:00:00.000Z",
      },
    });

    invokeMock.mockResolvedValue({
      root_node_id: "flow:symbol:calculator:run:entry",
      target_id: "symbol:calculator:run",
      level: "flow",
      nodes: [
        {
          node_id: "flow:symbol:calculator:run:entry",
          kind: "entry",
          label: "Entry",
          subtitle: "run",
          metadata: { flow_order: 0 },
          available_actions: [],
        },
        {
          node_id: "flow:symbol:calculator:run:statement:0",
          kind: "loop",
          label: "while tokens",
          subtitle: "While",
          metadata: { flow_order: 1 },
          available_actions: [],
        },
        {
          node_id: "flow:symbol:calculator:run:statement:1",
          kind: "call",
          label: "consume()",
          subtitle: "Expr",
          metadata: { flow_order: 2 },
          available_actions: [],
        },
        {
          node_id: "flow:symbol:calculator:run:statement:2",
          kind: "return",
          label: "return output",
          subtitle: "Return",
          metadata: { flow_order: 3 },
          available_actions: [],
        },
      ],
      edges: [
        {
          edge_id: "controls:entry->loop",
          kind: "controls",
          source_id: "flow:symbol:calculator:run:entry",
          target_id: "flow:symbol:calculator:run:statement:0",
          metadata: {},
        },
        {
          edge_id: "controls:loop->body",
          kind: "controls",
          source_id: "flow:symbol:calculator:run:statement:0",
          target_id: "flow:symbol:calculator:run:statement:1",
          label: "body",
          metadata: {
            path_key: "body",
            path_label: "body",
            path_order: 0,
          },
        },
        {
          edge_id: "controls:body->loop",
          kind: "controls",
          source_id: "flow:symbol:calculator:run:statement:1",
          target_id: "flow:symbol:calculator:run:statement:0",
          metadata: {},
        },
        {
          edge_id: "controls:loop->exit",
          kind: "controls",
          source_id: "flow:symbol:calculator:run:statement:0",
          target_id: "flow:symbol:calculator:run:statement:2",
          label: "exit",
          metadata: {
            path_key: "exit",
            path_label: "exit",
            path_order: 1,
          },
        },
      ],
      breadcrumbs: [],
      focus: {
        target_id: "symbol:calculator:run",
        level: "flow",
        label: "run",
        available_levels: ["symbol", "flow"],
      },
      truncated: false,
    });

    const graph = await adapter.getFlowView("symbol:calculator:run");

    expect(invokeMock).toHaveBeenCalledWith("flow_view", {
      repoPath: "/workspace/calculator",
      symbolId: "symbol:calculator:run",
    });
    expect(graph.level).toBe("flow");
    expect(graph.nodes).toHaveLength(4);
    expect(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(
      true,
    );
    expect(
      graph.nodes.find((node) => node.id === "flow:symbol:calculator:run:entry")?.x,
    ).toBeLessThan(
      graph.nodes.find((node) => node.id === "flow:symbol:calculator:run:statement:0")?.x ?? 0,
    );
  });

  it("maps flow_state documents, sync state, diagnostics, and source hash from the backend contract", async () => {
    const adapter = new LiveDesktopAdapter();
    Reflect.set(adapter, "scanCache", {
      session: {
        id: "repo:/workspace/calculator",
        name: "Calculator",
        path: "/workspace/calculator",
        branch: "local",
        primaryLanguage: "Python",
        openedAt: "2026-04-09T00:00:00.000Z",
      },
    });

    invokeMock.mockResolvedValue({
      root_node_id: "flow:symbol:calculator:run:entry",
      target_id: "symbol:calculator:run",
      level: "flow",
      nodes: [
        {
          node_id: "flow:symbol:calculator:run:entry",
          kind: "entry",
          label: "Entry",
          subtitle: "run",
          metadata: { flow_order: 0 },
          available_actions: [],
        },
        {
          node_id: "flow:symbol:calculator:run:statement:0",
          kind: "assign",
          label: "value = prepare()",
          subtitle: "assignment",
          metadata: { flow_order: 1 },
          available_actions: [],
        },
        {
          node_id: "flow:symbol:calculator:run:param:value",
          kind: "param",
          label: "value",
          subtitle: "parameter",
          metadata: { flow_order: 0 },
          available_actions: [],
        },
      ],
      edges: [
        {
          edge_id: "controls:entry->assign",
          kind: "controls",
          source_id: "flow:symbol:calculator:run:entry",
          target_id: "flow:symbol:calculator:run:statement:0",
          metadata: {
            source_handle: "start",
            target_handle: "in",
          },
        },
        {
          edge_id: "data:param->assign",
          kind: "data",
          source_id: "flow:symbol:calculator:run:param:value",
          target_id: "flow:symbol:calculator:run:statement:0",
          metadata: {},
        },
      ],
      breadcrumbs: [],
      focus: {
        target_id: "symbol:calculator:run",
        level: "flow",
        label: "run",
        available_levels: ["symbol", "flow"],
      },
      truncated: false,
      flow_state: {
        editable: true,
        sync_state: "draft",
        diagnostics: ["flow:symbol:calculator:run:statement:0 is disconnected."],
        document: {
          symbol_id: "symbol:calculator:run",
          relative_path: "calculator.py",
          qualname: "calculator.run",
          editable: true,
          sync_state: "draft",
          diagnostics: ["flow:symbol:calculator:run:statement:0 is disconnected."],
          source_hash: "sha256:abc123",
          nodes: [
            {
              id: "flow:symbol:calculator:run:entry",
              kind: "entry",
              payload: {},
              indexed_node_id: "flow:symbol:calculator:run:entry",
            },
            {
              id: "flow:symbol:calculator:run:statement:0",
              kind: "assign",
              payload: { source: "value = prepare()" },
              indexed_node_id: "flow:symbol:calculator:run:statement:0",
            },
          ],
          edges: [
            {
              id: "controls:entry->assign",
              source_id: "flow:symbol:calculator:run:entry",
              source_handle: "start",
              target_id: "flow:symbol:calculator:run:statement:0",
              target_handle: "in",
            },
          ],
          value_model_version: 1,
          function_inputs: [
            {
              id: "flowinput:symbol:calculator:run:value",
              name: "value",
              index: 0,
              kind: "positional_or_keyword",
              default_expression: "1",
            },
          ],
          value_sources: [
            {
              id: "flowsource:flow:symbol:calculator:run:statement:0:value",
              node_id: "flow:symbol:calculator:run:statement:0",
              name: "value",
              label: "value",
              emitted_name: "value__flow_0",
            },
          ],
        },
      },
    });

    const graph = await adapter.getFlowView("symbol:calculator:run");

    expect(graph.flowState).toEqual({
      editable: true,
      syncState: "draft",
      diagnostics: ["flow:symbol:calculator:run:statement:0 is disconnected."],
      document: {
        symbolId: "symbol:calculator:run",
        relativePath: "calculator.py",
        qualname: "calculator.run",
        editable: true,
        syncState: "draft",
        diagnostics: ["flow:symbol:calculator:run:statement:0 is disconnected."],
        sourceHash: "sha256:abc123",
        nodes: [
          {
            id: "flow:symbol:calculator:run:entry",
            kind: "entry",
            payload: {},
            indexedNodeId: "flow:symbol:calculator:run:entry",
          },
          {
            id: "flow:symbol:calculator:run:statement:0",
            kind: "assign",
            payload: { source: "value = prepare()" },
            indexedNodeId: "flow:symbol:calculator:run:statement:0",
          },
        ],
        edges: [
          {
            id: "controls:entry->assign",
            sourceId: "flow:symbol:calculator:run:entry",
            sourceHandle: "start",
            targetId: "flow:symbol:calculator:run:statement:0",
            targetHandle: "in",
          },
        ],
        valueModelVersion: 1,
        functionInputs: [
          {
            id: "flowinput:symbol:calculator:run:value",
            name: "value",
            index: 0,
            kind: "positional_or_keyword",
            defaultExpression: "1",
          },
        ],
        valueSources: [
          {
            id: "flowsource:flow:symbol:calculator:run:statement:0:value",
            nodeId: "flow:symbol:calculator:run:statement:0",
            name: "value",
            label: "value",
            emittedName: "value__flow_0",
          },
        ],
      },
    });

    expect(graph.nodes.some((node) => node.kind === "param")).toBe(true);
    expect(graph.flowState?.document?.nodes.some((node) => String(node.kind) === "param")).toBe(
      false,
    );
  });

  it("maps workspace filesystem list, read, create, save, move, and delete commands", async () => {
    const adapter = new LiveDesktopAdapter();

    invokeMock.mockResolvedValueOnce({
      root_path: "/workspace/calculator",
      entries: [
        {
          relative_path: "README.md",
          name: "README.md",
          kind: "file",
          size_bytes: 7,
          editable: true,
          reason: null,
          modified_at: 10,
        },
      ],
      truncated: false,
    });

    const tree = await adapter.listWorkspaceFiles("/workspace/calculator");
    expect(invokeMock).toHaveBeenCalledWith("list_workspace_files", {
      repoPath: "/workspace/calculator",
    });
    expect(tree.entries[0]).toMatchObject({
      relativePath: "README.md",
      name: "README.md",
      kind: "file",
      editable: true,
    });

    invokeMock.mockResolvedValueOnce({
      relative_path: "README.md",
      name: "README.md",
      kind: "file",
      size_bytes: 7,
      editable: true,
      reason: null,
      content: "# Demo\n",
      version: "sha256:old",
      modified_at: 11,
    });

    const file = await adapter.readWorkspaceFile("/workspace/calculator", "README.md");
    expect(invokeMock).toHaveBeenCalledWith("read_workspace_file", {
      repoPath: "/workspace/calculator",
      relativePath: "README.md",
    });
    expect(file.content).toBe("# Demo\n");
    expect(file.version).toBe("sha256:old");

    invokeMock.mockResolvedValueOnce({
      relative_path: "docs/notes.md",
      kind: "file",
      changed_relative_paths: ["docs/notes.md"],
      file: {
        relative_path: "docs/notes.md",
        name: "notes.md",
        kind: "file",
        size_bytes: 0,
        editable: true,
        reason: null,
        content: "",
        version: "sha256:empty",
        modified_at: 12,
      },
    });

    const created = await adapter.createWorkspaceEntry("/workspace/calculator", {
      kind: "file",
      relativePath: "docs/notes.md",
      content: "",
    });
    expect(invokeMock).toHaveBeenCalledWith("create_workspace_entry", {
      repoPath: "/workspace/calculator",
      kind: "file",
      relativePath: "docs/notes.md",
      content: "",
    });
    expect(created.file?.relativePath).toBe("docs/notes.md");

    invokeMock.mockResolvedValueOnce({
      relative_path: "README.md",
      kind: "file",
      changed_relative_paths: ["README.md"],
      file: {
        relative_path: "README.md",
        name: "README.md",
        kind: "file",
        size_bytes: 10,
        editable: true,
        reason: null,
        content: "# Updated\n",
        version: "sha256:new",
        modified_at: 13,
      },
    });

    const saved = await adapter.saveWorkspaceFile(
      "/workspace/calculator",
      "README.md",
      "# Updated\n",
      "sha256:old",
    );
    expect(invokeMock).toHaveBeenCalledWith("save_workspace_file", {
      repoPath: "/workspace/calculator",
      relativePath: "README.md",
      content: "# Updated\n",
      expectedVersion: "sha256:old",
    });
    expect(saved.file?.content).toBe("# Updated\n");

    invokeMock.mockResolvedValueOnce({
      relative_path: "docs/README.md",
      kind: "file",
      changed_relative_paths: ["README.md", "docs/README.md"],
      file: {
        relative_path: "docs/README.md",
        name: "README.md",
        kind: "file",
        size_bytes: 10,
        editable: true,
        reason: null,
        content: "# Updated\n",
        version: "sha256:new",
        modified_at: 14,
      },
    });

    const moved = await adapter.moveWorkspaceEntry("/workspace/calculator", {
      sourceRelativePath: "README.md",
      targetDirectoryRelativePath: "docs",
    });
    expect(invokeMock).toHaveBeenCalledWith("move_workspace_entry", {
      repoPath: "/workspace/calculator",
      sourceRelativePath: "README.md",
      targetDirectoryRelativePath: "docs",
      expectedImpactFingerprint: null,
    });
    expect(moved.relativePath).toBe("docs/README.md");
    expect(moved.changedRelativePaths).toEqual(["README.md", "docs/README.md"]);

    invokeMock.mockResolvedValueOnce({
      relative_path: "docs/README.md",
      kind: "file",
      changed_relative_paths: ["docs/README.md"],
      file: null,
    });

    const deleted = await adapter.deleteWorkspaceEntry("/workspace/calculator", {
      relativePath: "docs/README.md",
    });
    expect(invokeMock).toHaveBeenCalledWith("delete_workspace_entry", {
      repoPath: "/workspace/calculator",
      relativePath: "docs/README.md",
      expectedImpactFingerprint: null,
    });
    expect(deleted.file).toBeNull();
    expect(deleted.changedRelativePaths).toEqual(["docs/README.md"]);
  });

  it("previews recursive workspace file operations with opaque fingerprints", async () => {
    const adapter = new LiveDesktopAdapter();
    invokeMock.mockResolvedValueOnce({
      operation_kind: "delete",
      source_relative_path: "pkg",
      target_relative_path: null,
      entry_kind: "directory",
      counts: {
        entry_count: 3,
        file_count: 2,
        directory_count: 1,
        symlink_count: 0,
        total_size_bytes: 128,
        python_file_count: 1,
      },
      warnings: ["This touches 3 filesystem entries."],
      affected_paths: ["pkg", "pkg/app.py"],
      affected_paths_truncated: false,
      impact_fingerprint: "sha256:abc",
    });

    const preview = await adapter.previewWorkspaceFileOperation("/workspace/calculator", {
      operation: "delete",
      relativePath: "pkg",
    });

    expect(invokeMock).toHaveBeenCalledWith("preview_workspace_file_operation", {
      repoPath: "/workspace/calculator",
      operation: "delete",
      relativePath: "pkg",
      sourceRelativePath: null,
      targetDirectoryRelativePath: null,
    });
    expect(preview.impactFingerprint).toBe("sha256:abc");
    expect(preview.counts.pythonFileCount).toBe(1);
  });

  it("updates cached workspace state from live sync events", async () => {
    const adapter = new LiveDesktopAdapter();
    const listener = vi.fn();
    adapter.subscribeWorkspaceSync(listener);
    Reflect.set(adapter, "currentSession", {
      id: "repo:/workspace/calculator",
      name: "Calculator",
      path: "/workspace/calculator",
      branch: "local",
      primaryLanguage: "Python",
      openedAt: "2026-04-09T00:00:00.000Z",
    });

    eventState.callbacks.get("helm://workspace-sync")?.({
      payload: {
        repo_path: "/workspace/calculator",
        session_version: 2,
        reason: "external-change",
        status: "synced",
        changed_relative_paths: ["calculator.py"],
        needs_manual_resync: false,
        snapshot: {
          repo_id: "repo:/workspace/calculator",
          default_focus_node_id: "symbol:calculator:new_helper",
          default_level: "symbol",
          node_ids: [
            "repo:/workspace/calculator",
            "module:calculator",
            "symbol:calculator:new_helper",
          ],
        },
        payload: {
          summary: {
            repo_path: "/workspace/calculator",
            module_count: 1,
            symbol_count: 1,
            import_edge_count: 0,
            call_edge_count: 0,
            unresolved_call_count: 0,
            diagnostic_count: 0,
            modules: [
              {
                module_id: "module:calculator",
                module_name: "calculator",
                relative_path: "calculator.py",
                symbol_count: 1,
                import_count: 0,
                outgoing_call_count: 0,
              },
            ],
          },
          graph: {
            root_path: "/workspace/calculator",
            repo_id: "repo:/workspace/calculator",
            nodes: [
              {
                node_id: "repo:/workspace/calculator",
                kind: "repo",
                name: "Calculator",
                display_name: "Calculator",
                file_path: null,
                module_name: null,
                qualname: null,
                is_external: false,
                metadata: {},
              },
              {
                node_id: "module:calculator",
                kind: "module",
                name: "calculator",
                display_name: "calculator.py",
                file_path: "/workspace/calculator/calculator.py",
                module_name: "calculator",
                qualname: null,
                is_external: false,
                metadata: { relative_path: "calculator.py" },
              },
              {
                node_id: "symbol:calculator:new_helper",
                kind: "symbol",
                name: "new_helper",
                display_name: "new_helper",
                file_path: "/workspace/calculator/calculator.py",
                module_name: "calculator",
                qualname: "new_helper",
                is_external: false,
                metadata: { symbol_kind: "function" },
              },
            ],
            edges: [
              {
                edge_id: "defines:module:calculator->symbol:calculator:new_helper",
                kind: "defines",
                source_id: "module:calculator",
                target_id: "symbol:calculator:new_helper",
                metadata: {},
              },
            ],
            diagnostics: [],
            unresolved_calls: [],
            report: {
              module_count: 1,
              symbol_count: 1,
              import_edge_count: 0,
              call_edge_count: 0,
              unresolved_call_count: 0,
              diagnostic_count: 0,
            },
          },
          workspace: {
            language: "python",
            default_level: "symbol",
            default_focus_node_id: "symbol:calculator:new_helper",
            source_hidden_by_default: true,
            supported_edit_kinds: [],
            session_version: 2,
          },
        },
      },
    });

    const results = await adapter.searchRepo("new_helper", {
      includeModules: true,
      includeFiles: true,
      includeSymbols: true,
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/workspace/calculator",
        sessionVersion: 2,
        status: "synced",
        changedRelativePaths: ["calculator.py"],
      }),
    );
    expect(results.some((result) => result.title === "new_helper")).toBe(true);
  });

  it("updates indexing jobs from backend index progress events", async () => {
    const adapter = new LiveDesktopAdapter();
    const states: IndexingJobState[] = [];
    let resolveScan: ((value: unknown) => void) | undefined;
    const payload = {
      summary: {
        repo_path: "/workspace/calculator",
        module_count: 1,
        symbol_count: 1,
        import_edge_count: 0,
        call_edge_count: 0,
        unresolved_call_count: 0,
        diagnostic_count: 0,
        modules: [
          {
            module_id: "module:calculator",
            module_name: "calculator",
            relative_path: "calculator.py",
            symbol_count: 1,
            import_count: 0,
            outgoing_call_count: 0,
          },
        ],
      },
      graph: {
        root_path: "/workspace/calculator",
        repo_id: "repo:/workspace/calculator",
        nodes: [
          {
            node_id: "repo:/workspace/calculator",
            kind: "repo",
            name: "Calculator",
            display_name: "Calculator",
            file_path: null,
            module_name: null,
            qualname: null,
            is_external: false,
            metadata: {},
          },
          {
            node_id: "module:calculator",
            kind: "module",
            name: "calculator",
            display_name: "calculator.py",
            file_path: "/workspace/calculator/calculator.py",
            module_name: "calculator",
            qualname: null,
            is_external: false,
            metadata: { relative_path: "calculator.py" },
          },
          {
            node_id: "symbol:calculator:run",
            kind: "symbol",
            name: "run",
            display_name: "run",
            file_path: "/workspace/calculator/calculator.py",
            module_name: "calculator",
            qualname: "run",
            is_external: false,
            metadata: { symbol_kind: "function" },
          },
        ],
        edges: [
          {
            edge_id: "defines:module:calculator->symbol:calculator:run",
            kind: "defines",
            source_id: "module:calculator",
            target_id: "symbol:calculator:run",
            metadata: {},
          },
        ],
        diagnostics: [],
        unresolved_calls: [],
        report: {
          module_count: 1,
          symbol_count: 1,
          import_edge_count: 0,
          call_edge_count: 0,
          unresolved_call_count: 0,
          diagnostic_count: 0,
        },
      },
      workspace: {
        language: "python",
        default_level: "symbol",
        default_focus_node_id: "symbol:calculator:run",
        source_hidden_by_default: true,
        supported_edit_kinds: [],
        session_version: 1,
      },
    };

    invokeMock.mockImplementation(async (command, _args) => {
      if (command === "scan_repo_payload") {
        return new Promise((resolve) => {
          resolveScan = resolve;
        });
      }
      if (command === "backend_health") {
        return {
          mode: "live",
          available: true,
          python_command: "python3",
          workspace_root: "/workspace",
          note: "Watching the active repo for workspace changes.",
          live_sync_enabled: true,
          sync_state: "synced",
          last_sync_error: null,
        };
      }
      throw new Error(`Unexpected invoke: ${String(command)}`);
    });

    const { jobId } = await adapter.startIndex("/workspace/calculator");
    const unsubscribe = adapter.subscribeIndexProgress(jobId, (state) => {
      states.push(state);
    });

    eventState.callbacks.get("helm://index-progress")?.({
      payload: {
        job_id: jobId,
        repo_path: "/workspace/calculator",
        status: "running",
        stage: "parse",
        processed_modules: 1,
        total_modules: 3,
        symbol_count: 4,
        message: "Parsed calculator.py",
        progress_percent: 42,
      },
    });
    eventState.callbacks.get("helm://index-progress")?.({
      payload: {
        job_id: jobId,
        repo_path: "/workspace/calculator",
        status: "done",
        stage: "watch_ready",
        processed_modules: 3,
        total_modules: 3,
        symbol_count: 4,
        message: "Workspace ready. Watching for workspace changes.",
        progress_percent: 100,
      },
    });
    resolveScan?.(payload);
    await Promise.resolve();
    await Promise.resolve();

    unsubscribe();

    expect(states[0] as unknown as Record<string, unknown>).toMatchObject({
      jobId,
      repoPath: "/workspace/calculator",
      status: "queued",
      stage: "discover",
    });
    expect(states).toContainEqual(
      expect.objectContaining({
        jobId,
        status: "running",
        stage: "parse",
        processedModules: 1,
        totalModules: 3,
        progressPercent: 42,
      }),
    );
    expect(
      (states[states.length - 1] ?? null) as unknown as Record<string, unknown> | null,
    ).toMatchObject({
      jobId,
      status: "done",
      stage: "watch_ready",
      message: "Workspace ready. Watching for workspace changes.",
      progressPercent: 100,
    });
    expect(invokeMock).toHaveBeenCalledWith("scan_repo_payload", {
      repoPath: "/workspace/calculator",
      jobId,
    });
  });
});
