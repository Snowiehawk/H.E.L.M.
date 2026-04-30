import type { SearchResult } from "../../../lib/adapter";
import { helpTargetProps } from "../../workspace/workspaceHelp";

export function SearchResultsSection({
  isSearching,
  searchResults,
  onSelectResult,
}: {
  isSearching: boolean;
  searchResults: SearchResult[];
  onSelectResult: (result: SearchResult) => void;
}) {
  return (
    <div className="sidebar-section explorer-results">
      {isSearching ? <p className="muted-copy">Searching current repo...</p> : null}
      {!isSearching && !searchResults.length ? (
        <p className="muted-copy">No files or symbols matched that query.</p>
      ) : null}
      {searchResults.map((result) => (
        <button
          key={result.id}
          {...helpTargetProps("explorer.search-result", { label: result.title })}
          className="list-button"
          type="button"
          onClick={() => onSelectResult(result)}
        >
          <span className="list-button__title">{result.title}</span>
          <span className="list-button__subtitle">{result.subtitle}</span>
        </button>
      ))}
    </div>
  );
}
