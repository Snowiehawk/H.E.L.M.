# Floating graph controls after resizing

The native Mac QA build `5f788d6` exposed a floating graph-card defect: in Light,
increasing UI scale from 100% to 120% reduced the title to a narrow strip and
wrapped **Fit view**. Resetting to 100% restored it. Resizing the same app from
1480×940 to its configured 1180×760 minimum also left the card mostly outside
the right edge. The native repro required neither dragging nor a graph change.

The original correction described below started from accepted combined source
`78dce9db625eb3c3b7875f5d85a963701073e65c` on the isolated
`noah/graph-toolbar-scale` branch. It addresses the graph-controls and supported
size/scaling criteria in [#118](https://github.com/Snowiehawk/H.E.L.M./issues/118)
under [#114](https://github.com/Snowiehawk/H.E.L.M./issues/114), with overlapping
minimum-window and scale criteria in
[#113](https://github.com/Snowiehawk/H.E.L.M./issues/113). It does not establish
contrast acceptance, resolve the separate caret issue, or change execution.

## Correction

The card previously retained an absolute `left` position calculated for the old
canvas width. Its automatic width then shrank into the remaining space when the
canvas narrowed, or left it outside the canvas altogether.

The card now has a bounded 320px preferred width, capped at canvas width minus
32px. A `ResizeObserver` watches both its container and the card. Undragged
controls remain anchored 16px from the right/top; dragged controls retain their
position until clamping is necessary to keep them within current bounds.
Toolbar expansion also participates in clamping. A window-resize listener
supports environments without `ResizeObserver`; subscriptions are removed on
unmount. Geometry uses CSS pixels consistently.

## Source evidence

Private receipts are retained outside Git under
`evidence/graph-toolbar-scale/` in the implementation workspace.

- The new component regressions fail on the old implementation: six failures,
  with the two existing interaction tests passing. All eight pass with the fix.
  They cover shrink/restore, dragged positioning, toolbar height growth,
  observer coverage/cleanup and the window-resize fallback.
- A synthetic **Keyboard café** fixture bundles the actual React component and
  the current `index.css`, `light.css` and `helm.css`. The same sequence changes
  canvas width through 1000, 833, 600, 480 and 1000 CSS pixels in Light, Dark and
  HELM. It uses real animation frames and a fresh-profile headless Chrome via
  DevTools pipes, without a listening port or foreground interaction.
- The old source reproduces a 2.3125px title area, two-line Fit text and negative
  right margin at the smaller widths. All 15 corrected rows keep a 320px card,
  16px right margin, approximately 103.45px title area and single-line Fit text.
  Both browser children exited zero and were reaped. Input hashes and browser
  version are recorded in `layout-pipe-before.json` and `layout-pipe-after.json`.
- Earlier virtual-time fixtures did not reliably deliver layout callbacks;
  their inconclusive results remain retained and are superseded by the
  identical real-frame before/after fixture, without weakening assertions.
- A distinct source/evidence review accepted the correction without blocking
  findings. Final commands and source identity belong in the accompanying
  handoff receipt.

## Remaining native gate

These checks establish the source correction and actual browser layout at the
tested canvas widths. They do not establish native WebView zoom, whole-workspace
layout, Windows DPI behavior, numerical contrast, or all #113/#118 criteria.
After this delta is accepted and included in a separately approved QA artifact,
rerun the exact native 100→110→120% and 1480×940→1180×760→restore cases. Check
readable title/actions, Fit behavior, expanded controls and dragged placement.
Record OS/WebView, app/source identity, actual scale and dimensions. Required
unavailable or failing native cells keep the corresponding issue open.

Frozen `78dce9d` and `5f788d6` apps remain historical QA artifacts. This source
follow-up does not rebuild, install, launch, publish or promote either app.

## Focused publication target

The publication branch extracts this four-file correction onto `dev`
`5d39e929ef5a33a58430679085a4621658150f85`, including the independently reviewed
dependency-only security repair in PR #133. It does not import the terminal,
updater or later Light/HELM theme implementation. The Light/Dark/HELM browser
results above and the later `c9c94ef` native checks belong to their historical
combined sources; they are not rendered or native acceptance of this extraction.
Fresh target validation first used `801388c`, then repeated on the PR #133
dependency baseline: six new regressions fail before the correction and all
eight component cases pass after it; all 356 frontend tests, TypeScript, lint
and formatting pass with one worker. These are source checks, with independent
review, rather than new native acceptance or completion of #113/#118.
