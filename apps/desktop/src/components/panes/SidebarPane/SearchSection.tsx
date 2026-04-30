import { helpTargetProps } from "../../workspace/workspaceHelp";

export function SearchSection({
  sidebarQuery,
  onSidebarQueryChange,
}: {
  sidebarQuery: string;
  onSidebarQueryChange: (query: string) => void;
}) {
  return (
    <div className="sidebar-section">
      <div className="section-header">
        <h3>Search</h3>
        <span>Cmd/Ctrl + K</span>
      </div>
      <input
        {...helpTargetProps("explorer.search")}
        className="sidebar-search"
        value={sidebarQuery}
        onChange={(event) => onSidebarQueryChange(event.target.value)}
        placeholder="Jump to file or symbol"
      />
    </div>
  );
}
