import { fetchRepositorySnapshot, GitHubGraphQlError } from "./github/client";
import { parseRepositoryInput, RepositoryInputError } from "./github/parse-repository";
import type { LoadProgress, RepositoryRef, RepositorySnapshot } from "./types";

export interface IssueRepositoryState {
  status: "idle" | "loading" | "ready" | "error";
  snapshot?: RepositorySnapshot;
  progress?: LoadProgress;
  error?: string;
  canRefresh: boolean;
}

/** Per-desktop-instance state. Never shares the code workspace's disk/session adapters. */
export class IssueRepositoryAdapter {
  private state: IssueRepositoryState = { status: "idle", canRefresh: false };
  private listeners = new Set<() => void>();
  private credentials?: { repository: RepositoryRef; token: string };
  private controller?: AbortController;
  private generation = 0;

  constructor(private readonly fetcher: typeof fetch = globalThis.fetch) {}

  getState = (): IssueRepositoryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(state: IssueRepositoryState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  async load(input: string, token: string): Promise<void> {
    const generation = ++this.generation;
    this.controller?.abort();
    this.controller = undefined;
    this.credentials = undefined;
    try {
      const repository = parseRepositoryInput(input);
      const normalizedToken = token.trim();
      if (!normalizedToken) throw new RepositoryInputError("Enter a GitHub personal access token.");
      await this.run(repository, normalizedToken, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.publish({
        status: "error",
        snapshot: this.state.snapshot,
        canRefresh: false,
        error:
          error instanceof RepositoryInputError
            ? error.message
            : "Enter a repository as owner/name or a GitHub URL.",
      });
    }
  }

  async refresh(): Promise<void> {
    if (!this.credentials) {
      this.publish({ ...this.state, error: "Load a repository with a token before refreshing." });
      return;
    }
    const { repository, token } = this.credentials;
    const generation = ++this.generation;
    this.controller?.abort();
    await this.run(repository, token, generation);
  }

  private async run(repository: RepositoryRef, token: string, generation: number) {
    const controller = new AbortController();
    this.controller = controller;
    const previous = this.state.snapshot;
    const snapshot =
      previous?.repository.nameWithOwner.toLowerCase() === repository.nameWithOwner.toLowerCase()
        ? previous
        : undefined;
    this.publish({
      status: "loading",
      snapshot,
      canRefresh: false,
      progress: { loaded: 0, total: 0 },
    });
    try {
      const loaded = await fetchRepositorySnapshot(
        repository,
        token,
        ({ progress }) => {
          if (generation === this.generation && !controller.signal.aborted) {
            this.publish({ ...this.state, progress });
          }
        },
        controller.signal,
        this.fetcher,
      );
      if (generation !== this.generation || controller.signal.aborted) return;
      this.credentials = { repository: loaded.repository, token };
      this.publish({ status: "ready", snapshot: loaded, canRefresh: true });
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.publish({
        status: "error",
        snapshot,
        canRefresh: Boolean(this.credentials),
        error:
          error instanceof GitHubGraphQlError ? error.message : "Unable to load GitHub issues.",
      });
    } finally {
      if (generation === this.generation) this.controller = undefined;
    }
  }

  cancel = () => {
    ++this.generation;
    this.controller?.abort();
    this.controller = undefined;
    this.publish({
      status: this.state.snapshot ? "ready" : "idle",
      snapshot: this.state.snapshot,
      canRefresh: Boolean(this.credentials),
    });
  };

  clear = () => {
    ++this.generation;
    this.controller?.abort();
    this.controller = undefined;
    this.credentials = undefined;
    this.publish({ status: "idle", canRefresh: false });
  };
}
