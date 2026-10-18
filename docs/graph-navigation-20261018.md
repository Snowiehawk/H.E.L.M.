# Graph navigation candidate — #74 / #76–79

Unmerged implementation base: PR #75 at
`5faed57a5a73147cb6861b3d1a1772a6d0197deb`, verified open with all three CI jobs
green. This branch starts from fetched `origin/dev` (`49b8e51`) and fast-forwards
through that committed prerequisite. Issue colors and its pending native QA are
separate work and are not included.

## Input decisions

Noah's overnight authorization selects Command on macOS / Ctrl on Windows and
pointer-anchored zoom. This supersedes the planning issues' unresolved proposals.
The following tuning and fallback are implementation choices pending review.

| Input | Result on both canvases |
| --- | --- |
| Mouse wheel without modifier | Pointer-anchored zoom, no independent pan |
| Trackpad two-finger scroll | Two-axis pan, unchanged scale |
| Pinch | Pointer-anchored zoom through Ctrl-wheel or WebKit gesture events |
| Command (Mac) / Ctrl (Windows) + vertical scroll | Pointer-anchored zoom |
| Ambiguous event stream | Auto hints; explicit Mouse wheel / Trackpad selector |

WheelEvent cannot reliably identify hardware. Auto uses line/page deltas and
integer vertical pixel deltas of at least 40 as wheel hints; other pixel streams
start as pan. The first unmodified event fixes the route until a gap exceeding
160 ms. Fast vertical trackpad starts can resemble wheels; small continuous
wheels can resemble trackpads. Use the explicit input selector for these cases.
These are known Auto limitations, not hardware-recognition passes. The selector
is session-only, independent per canvas, and defaults to Auto.

Pinch/modifier takes precedence over the burst route. Unmodified release tails
are consumed without movement until a 160 ms quiet gap. There are no motion
timers. Blur, pointer leave, tab hide, graph supersession and unmount reset state.
New momentum delivered after reset starts a new burst.

Normalization: pixel unit 1, line 16 pixels, page canvas height capped at 1000.
Pan is capped at 240 pixels per axis/event. Wheel/modifier rate is
`exp(-0.002 * vertical pixels)`. Mac synthesized Ctrl pinch uses rate 0.01;
Windows Ctrl-wheel uses 0.002 because physical/synthesized Ctrl is ambiguous.
WebKit gesture scale ratios become logarithmic increments. Each zoom increment
is capped at ±0.25 log units (about 0.779–1.284 scale), then bounded by the existing
IDE 0.12–1.8 / Issues 0.001–1.5 limits. Direction reversal is immediate; horizontal
modifier input alone does not zoom. Translation preserves the graph coordinate
beneath the pointer. Non-finite/malformed samples are ignored.

All React Flow wheel/pinch/activation paths are disabled. One surface capture
listener owns accepted wheel events; WebKit gesture delivery suppresses companion
wheel delivery until 160 ms after gestureend. A wheel delivered *before*
gesturestart cannot be identified in advance as a duplicate; native event ordering
remains an acceptance case. Controls, editable targets, `.nowheel`, adjacent panes
and hidden tabs are excluded. Existing Fit/Center, Space pan, selection and node
drag stay with existing code. There is no global wheel listener or domain edit.

## Evidence limits and acceptance matrix

The controller suite uses explicit timestamps for routing, ambiguity, normalization,
release tails, bounds, anchor invariance, reversal and disposal. The integration
suite renders both production canvases using the actual locked React Flow,
dispatches synthetic DOM events and checks resulting viewport transforms. It
checks pointer anchoring, hidden state, editable controls, modifier release,
WebKit companion suppression and listener cleanup. Dimensions are JSDOM fixtures;
this is deterministic integration evidence, not physical-device validation.

| Native OS / graph | Wheel | Trackpad pan | Pinch | Modifier scroll |
| --- | --- | --- | --- | --- |
| macOS WebKit / IDE | Untested | Untested | Untested | Untested |
| macOS WebKit / Issues | Untested | Untested | Untested | Untested |
| Windows WebView2 / IDE | Untested | Untested | Untested | Untested |
| Windows WebView2 / Issues | Untested | Untested | Untested | Untested |

#79 and independent review remain pending. No screen controls or native permission
were used. Native receipts must name exact source/build, OS/webview, device/driver,
direction/acceleration and display scale. Include detented/continuous wheels,
diagonal pan/momentum, slow/fast/reverse movement, modifier boundaries, small/dense
graphs, zoom bounds, adjacent editor/details controls and tab switches. Development
Chromium/WebKit browser and CRD/VM transport observations stay separate. Keep
#74/#76–79 open until their distinct review and acceptance contracts are met.

Automated result on the implementation delta above base: 362 frontend tests across
45 files passed (121.44 s), including 12 new router/real-consumer tests; TypeScript,
ESLint and Prettier passed. The locked React Flow version is 12.10.2; the local
runner is Node 25.9.0 on macOS arm64. This adds no dependency, credential scope,
security exception or network permission. Production build result is recorded in
the draft PR after completion.

## Independent-review correction: marquee selection

Actual React Flow integration replay reproduced a hidden d3 viewport change on
both canvases: marquee drag -> wheel 100 -> release -> Controls + yielded zoom
0.98248 instead of 1.2. During selection React Flow detaches its transform-to-store
callback, so a custom setViewport must not update d3 then. The shared router now
reads the live per-canvas `userSelectionActive` state before wheel or WebKit-gesture
viewport writes, consumes the event and resets the burst instead. Regression tests
exercise real selection pointer events and the built-in Controls after release on
both production consumers, without React Flow mocks. Native hardware proof remains
pending and is not inferred from this synthetic reproduction.
