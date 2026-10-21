import { Component, type PropsWithChildren } from "react";

/** Keep owned-session controls usable if the optional terminal renderer fails. */
export class ExecutionRendererBoundary extends Component<PropsWithChildren, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <p role="alert">
          Terminal display is unavailable. Use Close session to stop its shell. Other run controls
          remain available.
        </p>
      );
    }
    return this.props.children;
  }
}
