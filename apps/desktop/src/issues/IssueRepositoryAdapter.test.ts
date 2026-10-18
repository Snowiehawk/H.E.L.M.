import { describe, expect, it, vi } from "vitest";
import { IssueRepositoryAdapter } from "./IssueRepositoryAdapter";
import {
  deferred,
  issue,
  page,
  repositoryName,
  response,
  TEST_TOKEN,
} from "./test-fixtures/github";

describe("IssueRepositoryAdapter", () => {
  it("loads and manually refreshes atomically without storing credentials in public state", async () => {
    const pending = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(page([issue(1)])))
      .mockReturnValueOnce(pending.promise);
    const adapter = new IssueRepositoryAdapter(fetcher);
    await adapter.load(repositoryName, TEST_TOKEN);
    const original = adapter.getState().snapshot;
    const refresh = adapter.refresh();
    expect(adapter.getState()).toMatchObject({ status: "loading", snapshot: original });
    pending.resolve(response(page([issue(2)])));
    await refresh;
    expect(adapter.getState().snapshot?.issues.map((node) => node.number)).toEqual([2]);
    expect(JSON.stringify(adapter.getState())).not.toContain(TEST_TOKEN);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous successful snapshot on later-page refresh failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(page([issue(1)])))
      .mockResolvedValueOnce(
        response(page([issue(2)], { total: 2, hasNext: true, cursor: "next" })),
      )
      .mockResolvedValueOnce(response({ errors: [{ message: TEST_TOKEN }] }));
    const adapter = new IssueRepositoryAdapter(fetcher);
    await adapter.load(repositoryName, TEST_TOKEN);
    const previous = adapter.getState().snapshot;
    await adapter.refresh();
    expect(adapter.getState()).toMatchObject({ status: "error", canRefresh: true });
    expect(adapter.getState().snapshot).toBe(previous);
    expect(adapter.getState().error).toBe("GitHub rejected the GraphQL request.");
  });

  it("ignores stale loads even when transport resolves after abort", async () => {
    const older = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(response(page([issue(2)])))
      .mockResolvedValueOnce(response(page([issue(2)])));
    const adapter = new IssueRepositoryAdapter(fetcher);
    const first = adapter.load(repositoryName, "old-synthetic-token");
    await adapter.load(repositoryName, TEST_TOKEN);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    older.resolve(response(page([issue(1)])));
    await first;
    expect(adapter.getState().snapshot?.issues[0].number).toBe(2);
    await adapter.refresh();
    expect(fetcher.mock.lastCall?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${TEST_TOKEN}`,
    });
  });

  it("clears the previous repository snapshot when switching repositories", async () => {
    const next = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(page()))
      .mockReturnValueOnce(next.promise);
    const adapter = new IssueRepositoryAdapter(fetcher);
    await adapter.load(repositoryName, TEST_TOKEN);
    const load = adapter.load("example/another", TEST_TOKEN);
    expect(adapter.getState().snapshot).toBeUndefined();
    next.resolve(response(page([issue(2)], { name: "example/another" })));
    await load;
    expect(adapter.getState().snapshot?.repository.nameWithOwner).toBe("example/another");
  });

  it("cancel and disconnect invalidate pending responses and clear refresh access", async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const adapter = new IssueRepositoryAdapter(fetcher);
    const load = adapter.load(repositoryName, TEST_TOKEN);
    adapter.cancel();
    adapter.clear();
    pending.resolve(response(page()));
    await load;
    expect(adapter.getState()).toEqual({ status: "idle", canRefresh: false });
    await adapter.refresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter.getState().snapshot).toBeUndefined();
  });

  it("clears an established session on disconnect without touching storage or URLs", async () => {
    const localWrite = vi.spyOn(Storage.prototype, "setItem");
    const historyWrite = vi.spyOn(window.history, "replaceState");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page()));
    const adapter = new IssueRepositoryAdapter(fetcher);
    try {
      await adapter.load(repositoryName, TEST_TOKEN);
      adapter.clear();
      await adapter.refresh();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(adapter.getState().canRefresh).toBe(false);
      expect(localWrite).not.toHaveBeenCalled();
      expect(historyWrite).not.toHaveBeenCalled();
    } finally {
      localWrite.mockRestore();
      historyWrite.mockRestore();
    }
  });

  it.each([
    ["bad", TEST_TOKEN],
    [repositoryName, ""],
    ["https://[", TEST_TOKEN],
  ])("rejects invalid input without a request", async (input, token) => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = new IssueRepositoryAdapter(fetcher);
    await adapter.load(input, token);
    expect(adapter.getState().status).toBe("error");
    expect(adapter.getState().error).not.toContain(TEST_TOKEN);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("binary issue state refresh", () => {
  it("publishes Open→Closed→Open atomically with the same native identity", async () => {
    const open = issue(1);
    const closed = { ...open, state: "CLOSED" as const, stateReason: "NOT_PLANNED" };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(page([open])))
      .mockResolvedValueOnce(response(page([closed])))
      .mockResolvedValueOnce(response(page([open])));
    const adapter = new IssueRepositoryAdapter(fetcher);
    await adapter.load(repositoryName, TEST_TOKEN);
    const id = adapter.getState().snapshot!.issues[0].id;
    await adapter.refresh();
    expect(adapter.getState().snapshot!.issues[0]).toMatchObject({ id, state: "CLOSED" });
    await adapter.refresh();
    expect(adapter.getState().snapshot!.issues[0]).toMatchObject({ id, state: "OPEN" });
  });

  it.each([undefined, null, "IN_PROGRESS"])(
    "rejects unsupported initial state %s instead of guessing Open",
    async (state) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response(page([{ ...issue(1), state } as any])));
      const adapter = new IssueRepositoryAdapter(fetcher);
      await adapter.load(repositoryName, TEST_TOKEN);
      expect(adapter.getState().status).toBe("error");
      expect(adapter.getState().snapshot).toBeUndefined();
    },
  );

  it("retains valid state on canceled refresh and ignores its late recolor", async () => {
    const pending = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(page([issue(1)])))
      .mockReturnValueOnce(pending.promise);
    const adapter = new IssueRepositoryAdapter(fetcher);
    await adapter.load(repositoryName, TEST_TOKEN);
    const previous = adapter.getState().snapshot;
    const refresh = adapter.refresh();
    adapter.cancel();
    pending.resolve(response(page([{ ...issue(1), state: "CLOSED" }])));
    await refresh;
    expect(adapter.getState().snapshot).toBe(previous);
    expect(adapter.getState().snapshot!.issues[0].state).toBe("OPEN");
  });
});
