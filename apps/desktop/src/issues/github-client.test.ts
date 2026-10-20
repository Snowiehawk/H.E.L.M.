import { describe, expect, it, vi } from "vitest";
import { dependencyEdges } from "./dependencies";
import { fetchRepositorySnapshot } from "./github/client";
import { parseRepositoryInput } from "./github/parse-repository";
import {
  deferred,
  issue,
  page,
  reference,
  repositoryName,
  response,
  TEST_TOKEN,
} from "./test-fixtures/github";

const repository = parseRepositoryInput(repositoryName);

describe("GitHub issue loader", () => {
  it("paginates 235 synthetic issues and deduplicates native blockers in the correct direction", async () => {
    const nodes = Array.from({ length: 235 }, (_, index) =>
      issue(index + 1, index ? [index] : [], index < 234 ? [index + 2] : []),
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(page(nodes.slice(0, 100), { total: 235, hasNext: true, cursor: "one" })),
      )
      .mockResolvedValueOnce(
        response(page(nodes.slice(100, 200), { total: 235, hasNext: true, cursor: "two" })),
      )
      .mockResolvedValueOnce(response(page(nodes.slice(200), { total: 235 })));
    const updates = vi.fn();
    const snapshot = await fetchRepositorySnapshot(
      repository,
      TEST_TOKEN,
      updates,
      undefined,
      fetcher,
    );
    expect(snapshot.issues).toHaveLength(235);
    expect(snapshot.repository.id).toBe(`synthetic-repository-${repositoryName}`);
    expect(snapshot.completeness).toEqual({
      issues: "complete",
      dependencies: "complete",
      dependencyConnectionLimit: 100,
      hierarchy: "not-loaded",
    });
    expect(dependencyEdges(snapshot.issues)).toHaveLength(234);
    expect(dependencyEdges(snapshot.issues)).toContainEqual({
      id: "example/a.b.#1->example/a.b.#2",
      source: "example/a.b.#1",
      target: "example/a.b.#2",
    });
    expect(updates.mock.calls.map(([update]) => update.progress.loaded)).toEqual([100, 200, 235]);
    expect(
      updates.mock.calls.every(
        ([update]) => !Object.prototype.hasOwnProperty.call(update, "snapshot"),
      ),
    ).toBe(true);
    expect(
      fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).variables.cursor),
    ).toEqual([null, "one", "two"]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/graphql",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        redirect: "error",
        credentials: "omit",
        headers: expect.objectContaining({ Authorization: `Bearer ${TEST_TOKEN}` }),
      }),
    );
    expect(String(fetcher.mock.calls[0][1]?.body)).not.toContain("mutation");
    expect(JSON.stringify(snapshot)).not.toContain(TEST_TOKEN);
  });

  it("marks capped dependencies partial and preserves cross-repository references", async () => {
    const node = issue(1);
    node.blockedBy = {
      totalCount: 101,
      nodes: Array.from({ length: 100 }, (_, index) => reference(index + 2, "example/other")),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page([node])));
    const snapshot = await fetchRepositorySnapshot(
      repository,
      TEST_TOKEN,
      vi.fn(),
      undefined,
      fetcher,
    );
    expect(snapshot.completeness.dependencies).toBe("partial");
    expect(snapshot.issues[0].dependencyDataTruncated).toBe(true);
    expect(snapshot.issues[0].blockedBy[0]).toMatchObject({
      key: "example/other#2",
      repository: "example/other",
      id: "synthetic-example/other-2",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("handles an empty repository", async () => {
    const result = await fetchRepositorySnapshot(
      repository,
      TEST_TOKEN,
      vi.fn(),
      undefined,
      vi.fn<typeof fetch>().mockResolvedValue(response(page([]))),
    );
    expect(result.issues).toEqual([]);
    expect(result.completeness.issues).toBe("complete");
  });

  it("deduplicates repeated issues and exposes mismatched totals", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(page([issue(1), issue(1)], { total: 2 })));
    const snapshot = await fetchRepositorySnapshot(
      repository,
      TEST_TOKEN,
      vi.fn(),
      undefined,
      fetcher,
    );
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.completeness).toMatchObject({ issues: "partial", dependencies: "partial" });
  });

  it("does not claim a complete snapshot when totals change between pages", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(page([issue(1)], { total: 1, hasNext: true, cursor: "one" })))
      .mockResolvedValueOnce(response(page([issue(2)], { total: 2 })));
    expect(
      (await fetchRepositorySnapshot(repository, TEST_TOKEN, vi.fn(), undefined, fetcher))
        .completeness.issues,
    ).toBe("partial");
  });

  it.each([null, "repeat"])("rejects missing or repeated cursors (%s)", async (cursor) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response(page([issue(1)], { hasNext: true, cursor })));
    await expect(
      fetchRepositorySnapshot(repository, TEST_TOKEN, vi.fn(), undefined, fetcher),
    ).rejects.toThrow("invalid pagination metadata");
    expect(fetcher).toHaveBeenCalledTimes(cursor ? 2 : 1);
  });

  it("rejects longer cursor cycles", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const cursor of ["one", "two", "one"])
      fetcher.mockResolvedValueOnce(response(page([issue(1)], { hasNext: true, cursor })));
    await expect(
      fetchRepositorySnapshot(repository, TEST_TOKEN, vi.fn(), undefined, fetcher),
    ).rejects.toThrow("invalid pagination metadata");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    [() => response({ errors: [{ message: TEST_TOKEN }] }, 401), "HTTP 401"],
    [
      () => response({ errors: [{ message: TEST_TOKEN }], data: {} }),
      "rejected the GraphQL request",
    ],
    [
      () => response({ data: { repository: null, rateLimit: page().data.rateLimit } }),
      "not found or the token cannot access",
    ],
    [() => response({ data: {} }), "unexpected issue dependency response"],
    [() => response(null), "rejected the GraphQL request"],
    [() => new Response(TEST_TOKEN, { status: 502 }), "HTTP 502"],
  ])("bounds HTTP, GraphQL, schema and JSON failures", async (makeResponse, message) => {
    const error = await fetchRepositorySnapshot(
      repository,
      TEST_TOKEN,
      vi.fn(),
      undefined,
      vi.fn<typeof fetch>().mockResolvedValue(makeResponse()),
    ).catch((reason: unknown) => reason);
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain(TEST_TOKEN);
  });

  it("bounds network exceptions instead of displaying arbitrary transport messages", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(TEST_TOKEN));
    await expect(
      fetchRepositorySnapshot(repository, TEST_TOKEN, vi.fn(), undefined, fetcher),
    ).rejects.toThrow("Unable to reach GitHub");
  });

  it("rejects late responses after cancellation even if transport ignores the signal", async () => {
    const pending = deferred<Response>();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const load = fetchRepositorySnapshot(
      repository,
      TEST_TOKEN,
      vi.fn(),
      controller.signal,
      fetcher,
    );
    expect(fetcher.mock.calls[0][1]?.signal).toBe(controller.signal);
    controller.abort();
    pending.resolve(response(page()));
    await expect(load).rejects.toMatchObject({ name: "AbortError" });
  });
});
