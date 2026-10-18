# Issue graph state colors

Implementation for #80/#81 on the reviewed maintenance baseline `5faed57`.
The maintenance Python 3.12 migration has terminal-success Python, frontend and
Rust CI. This feature is a separate unmerged review branch; no issue is closed.

## Presentation contract

GitHub's validated `OPEN` is green **Open**, and `CLOSED` is purple **Closed**.
Closed/Not planned remains Closed; the presentation does not infer Todo, progress
or Completed from labels, projects, assignees or closure reason. A legend and
accessible node names communicate the state without relying on color. Ordinary,
external and partial cards share the mapping, preserving dashed borders and
partial-blocker text. A defensive unavailable state is neutral; API schema
validation continues rejecting missing/unsupported states.

Color tokens are scoped to `.issue-graph-panel`, with explicit light/dark surfaces.
The state stripe and label remain visible inside the selected card's border and
keyboard-focus outline. IDE rendering and all graph navigation settings are
unchanged. Existing native IDs, positions, selection and repository/session
ownership remain authoritative across refreshes.

## Automated evidence

- Full frontend suite: 359/359 tests pass (44 files).
- TypeScript/production build, icon check and changed-file ESLint/Prettier pass.
- Actual stylesheet colors pass WCAG contrast calculations in both themes:
  normal card/legend text >=4.5:1; state indicator, selection and focus >=3:1.
- Component coverage renders the card body, legend and accessible labels with a
  mocked ReactFlow wrapper. It does not claim native rendering from that mock.
- Open→Closed→Open keeps native ID, moved position and selection. Adapter tests
  verify atomic refresh, unsupported/missing initial state and canceled late
  recolor. Existing tests verify later-page failure retaining the prior snapshot,
  repository-switch fencing, obsolete responses and disconnect clearing.

## Native acceptance (#82)

Pending separate Mac and Windows native WebView checks. The synthetic QA overlay
is external to publication source, accepts only its documented fake session and
blocks external fetch. Its production code/stylesheet files are bound by a
400-file source manifest; unique candidate identifiers preserve every installed
accepted/prior candidate. No real GitHub authentication/network result is claimed.

Required acceptance: both themes; ordinary/external/partial Open and Closed;
legend and noncolor text; selected/focused state; measured rendered contrast;
Open→Closed→Open with stable selection/layout; failure, invalid data, cancel/late
response and repository switch; and an unchanged IDE graph smoke check.
Independent review remains separate from implementation/test execution.
