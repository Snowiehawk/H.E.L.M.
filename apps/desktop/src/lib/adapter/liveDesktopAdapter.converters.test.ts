import { describe, expect, it } from "vitest";

import { layoutGraphView, toFlowGraphDocument } from "./liveDesktopAdapter/graphFlow";
import { toRawEditRequest, fromRawUndoTransaction } from "./liveDesktopAdapter/sourceEdits";
import { toIndexingJobState, toWorkspaceSyncEvent } from "./liveDesktopAdapter/statusSession";
import { toWorkspaceFileOperationPreview } from "./liveDesktopAdapter/workspaceFiles";

describe("liveDesktopAdapter internal converters", () => {
  it("maps flow document backend fields without changing public shape", () => {
    const document = toFlowGraphDocument({
      symbol_id: "symbol:app.run",
      relative_path: "app.py",
      qualname: "app.run",
      nodes: [{ id: "entry", kind: "entry", payload: {}, indexed_node_id: "source:entry" }],
      edges: [
        {
          id: "controls:entry->exit",
          source_id: "entry",
          source_handle: "start",
          target_id: "exit",
          target_handle: "in",
        },
      ],
      value_model_version: 2,
      function_inputs: [
        {
          id: "input:name",
          name: "name",
          index: 0,
          kind: "positional_or_keyword",
          default_expression: null,
        },
      ],
      value_sources: [
        {
          id: "value:name",
          node_id: "entry",
          name: "name",
          label: "Name",
          emitted_name: "name",
        },
      ],
      input_slots: [
        {
          id: "slot:name",
          node_id: "entry",
          slot_key: "name",
          label: "name",
          required: true,
        },
      ],
      input_bindings: [
        {
          id: "binding:name",
          source_id: "value:name",
          function_input_id: "input:name",
          slot_id: "slot:name",
        },
      ],
      sync_state: "clean",
      diagnostics: [],
      source_hash: "hash",
      editable: true,
    });

    expect(document.nodes[0]).toMatchObject({ id: "entry", indexedNodeId: "source:entry" });
    expect(document.functionInputs?.[0]).toMatchObject({
      id: "input:name",
      defaultExpression: null,
    });
    expect(document.inputBindings?.[0]).toMatchObject({
      sourceId: "value:name",
      functionInputId: "input:name",
      slotId: "slot:name",
    });
  });

  it("maps raw graph views into public graph view DTOs", () => {
    const view = layoutGraphView({
      root_node_id: "repo:demo",
      target_id: "repo:demo",
      level: "repo",
      nodes: [
        {
          node_id: "repo:demo",
          kind: "repo",
          label: "Demo",
          metadata: {},
          available_actions: [
            {
              action_id: "open",
              label: "Open",
              enabled: true,
              payload: { targetId: "repo:demo" },
            },
          ],
        },
      ],
      edges: [],
      breadcrumbs: [],
      focus: null,
      truncated: false,
      flow_state: null,
    });

    expect(view).toMatchObject({
      rootNodeId: "repo:demo",
      nodes: [{ id: "repo:demo", availableActions: [{ actionId: "open" }] }],
    });
  });

  it("maps source edit and undo payloads using backend field names", () => {
    expect(
      toRawEditRequest({
        kind: "rename_symbol",
        targetId: "symbol:app.run",
        newName: "execute",
      }),
    ).toMatchObject({
      kind: "rename_symbol",
      target_id: "symbol:app.run",
      new_name: "execute",
    });

    expect(
      fromRawUndoTransaction({
        summary: "Undo rename",
        request_kind: "rename_symbol",
        file_snapshots: [{ relative_path: "app.py", existed: true, content: "print('x')" }],
        changed_node_ids: ["symbol:app.run"],
        focus_target: { target_id: "symbol:app.run", level: "symbol" },
        snapshot_token: "snap",
        touched_relative_paths: ["app.py"],
      }),
    ).toMatchObject({
      summary: "Undo rename",
      requestKind: "rename_symbol",
      fileSnapshots: [{ relativePath: "app.py", existed: true, content: "print('x')" }],
      focusTarget: { targetId: "symbol:app.run", level: "symbol" },
      snapshotToken: "snap",
    });
  });

  it("maps workspace preview and live event payloads", () => {
    expect(
      toWorkspaceFileOperationPreview({
        operation_kind: "delete",
        source_relative_path: "README.md",
        target_relative_path: null,
        entry_kind: "file",
        counts: {
          entry_count: 1,
          file_count: 1,
          directory_count: 0,
          symlink_count: 0,
          total_size_bytes: 42,
          python_file_count: 0,
        },
        warnings: ["Permanent delete"],
        affected_paths: ["README.md"],
        affected_paths_truncated: false,
        impact_fingerprint: "fingerprint",
      }),
    ).toMatchObject({
      operationKind: "delete",
      counts: { fileCount: 1, totalSizeBytes: 42 },
      impactFingerprint: "fingerprint",
    });

    expect(
      toWorkspaceSyncEvent({
        repo_path: "C:\\repo",
        session_version: 4,
        reason: "file_changed",
        status: "synced",
        changed_relative_paths: ["README.md"],
        needs_manual_resync: false,
        snapshot: null,
        message: null,
      }),
    ).toMatchObject({
      repoPath: "C:/repo",
      status: "synced",
      changedRelativePaths: ["README.md"],
    });

    expect(
      toIndexingJobState({
        job_id: "job",
        repo_path: "C:\\repo",
        status: "running",
        stage: "parse",
        processed_modules: 1,
        total_modules: 2,
        symbol_count: 3,
        message: "Parsing",
        progress_percent: null,
        error: null,
      }),
    ).toMatchObject({
      jobId: "job",
      repoPath: "C:/repo",
      progressPercent: undefined,
      error: undefined,
    });
  });
});
