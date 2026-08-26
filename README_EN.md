# Alpha Smart Cropper for Adobe After Effects

[English](README_EN.md) · [Русский](README_RU.md)

**Current version: 0.5.0**

Alpha Smart Cropper is a JSX script that automatically crops After Effects precompositions to their **actually rendered alpha channel**, rather than to the geometric dimensions of their layers.

Its primary use case is Photoshop imports: visible artwork may occupy only a small region while the imported layer still has the dimensions of the entire composition. In that situation, `sourceRectAtTime()` may return nearly the full canvas even though most of it is completely transparent.

The script is especially well suited to adapting layers imported from Photoshop (`PSD`) files. It reduces their effective dimensions to the visible-content area, which can reduce the number of pixels After Effects must process and consequently shorten render times.

The script finds the first and last pixels with non-zero alpha, resizes the source precomposition, and compensates its coordinates so the image remains in the same place in every parent composition.

---

## Features

- Crops precompositions using their **real rendered alpha**.
- Treats `alpha = 0` pixels as empty regardless of the original PSD, PNG, or footage-layer dimensions.
- Can analyze every frame of an animation.
- Can analyze only source times actually requested by precomp instances.
- Accounts for In Point, Out Point, Start Time, positive or negative Stretch, Time Remap, and Frame Blending neighbor samples.
- Automatically reduces the scan to one frame when a composition can be conservatively proven static.
- Analyzes unique visibility states instead of every frame when only static-layer In/Out visibility changes.
- Recognizes still footage, solids, recursively static precomps, plain static Text Layers, and safe static Shape Layers.
- Can recursively crop nested precomps from the deepest level upward.
- Accepts one or more compositions selected directly in the Project panel; recursive nested-precomp processing is enabled by default for this workflow.
- Propagates the selected branch's actually used time range in `Recursive + Selected Layers` mode.
- Preserves every project usage of a modified precomposition.
- Supports arbitrary 2D parent-chain depth and 2D Collapse Transformations.
- Preserves direct children of every usage and remaps masks on usage layers.
- Supports normal and Separated Dimensions Position.
- Supports static and keyframed Position/Anchor Point wherever a constant offset is mathematically safe.
- Centers the resulting precomp Anchor Point by default while preserving the image through Position compensation; the option can be disabled.
- Includes Padding and Dry Run modes.
- Includes `Current Frame / Safe Animation / Selected Branch` presets.
- Persists the last-used settings between runs through `app.settings`.
- Long scans can be interrupted with `Stop analysis`.
- Project-wide mode previews every composition and requires a separate confirmation before applying changes.
- Keeps a small launcher palette open so the selection can be changed and Crop can be run again without rerunning the JSX.
- Builds the project-wide usage index once per run.
- Caches repeated rectangular `sampleImage()` queries inside the alpha analyzer.

---

## Why ordinary cropping may fail with PSD layers

After importing a Photoshop document, a layer can look like this:

```text
1920 × 1920 layer
┌──────────────────────────────────────┐
│                                      │
│                                      │
│                █████                 │
│                █photo                │
│                █████                 │
│                                      │
│                                      │
└──────────────────────────────────────┘
```

Geometrically, the layer is still `1920×1920`, so a crop based on layer bounds does not see the empty space. Alpha Smart Cropper analyzes the final render instead:

```text
alpha = 0    → empty
alpha > 0    → content
```

For example:

```text
alpha bounds: [938, 980] .. [1353, 1444]
result:       416 × 465
```

---

## Installation

### Quick run

In After Effects, choose:

```text
File → Scripts → Run Script File...
```

and select:

```text
AlphaSmartCropper_v0.5.0.jsx
```

### Permanent installation

Copy the JSX into the installed After Effects `Scripts` directory without a version suffix, for example:

```text
C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Scripts\AlphaSmartCropper.jsx
```

then restart After Effects. A ScriptUI Panel installation is not required: version 0.5.0 opens a persistent modeless launcher palette.

---

## Basic usage

1. Run `AlphaSmartCropper_v0.5.0.jsx` or the installed `AlphaSmartCropper.jsx`.
2. Select one or more **precomp layers**, or compositions in the Project panel.
3. Click `Crop...` in the launcher.
4. Choose the analysis settings and perform the crop.
5. After reviewing the report, change the selection and click `Crop...` again.
6. Close the launcher with its title-bar X or the `Close` button.

All actual modifications are placed in one Undo Group.

### Selecting compositions in the Project panel

Instead of selecting a precomp layer, select one or more compositions directly in the Project panel and run the script. `Recursively crop nested precomps first` is enabled by default in this workflow, so the deepest nested compositions are processed before each selected root composition. With the default `Current frame only` mode, each selected root's current time is mapped through nested In/Out, Start Time, Stretch, and Time Remap into the recursive branch.

If precomp layers are also selected in an active composition, the layer selection takes priority. Deselect those precomp layers to process the Project-panel selection instead.

`Used source frames — selected layers in active comp` is unavailable for a Project-panel selection because that workflow has no selected usage layers.

---

# Presets and persistent settings

The dialog provides three presets:

- `Current Frame` — one current frame, `Frame step = 1`, static optimization enabled.
- `Safe Animation` — the entire source timeline frame-by-frame with conservative static optimization.
- `Selected Branch` — source frames used by the selected precomp layers, with Recursive Crop enabled.

`Selected Branch` is available only when precomp layers are selected in an active composition. Presets change time-analysis controls but do not toggle project-wide scope. Individual controls may still be adjusted after choosing a preset.

Accepted settings are stored through `app.settings` and restored on the next run. On a fresh installation, `Current frame only` and centered Anchor Point are enabled by default.

---

# Time-analysis modes

`Current frame only` is the default. This keeps the common run fast and predictable; explicitly choose a full-range or used-source-frame mode for animated content.

## 1. Entire source composition — every frame

Scans the complete source-comp timeline. With `Frame step = 1`, this is the most conservative choice for a standalone animated composition. Static and visibility-only optimization may still reduce the number of rendered-alpha samples.

## 2. Used source frames — all project usages

**Recommended default.** The script finds every usage of the source comp throughout the project and scans only the source times those parents actually request.

```text
source comp: 60 sec

MAIN / LIAM        uses source 12–18 sec
SECOND / LIAM      uses source 30–34 sec
```

Only the required source times are scanned instead of all 60 seconds. This balances speed and safety because a source comp is modified globally and every usage must remain valid. If an effect such as Echo, Timewarp, or a third-party plug-in may change temporal sampling, the mode conservatively falls back to the full source timeline.

## 3. Used source frames — selected layers in active comp

The most aggressive mode. It analyzes only source time used by the selected precomp instances in the active composition.

The source comp is still modified globally. If another instance uses a different part of its animation, this mode may crop pixels needed there. The report warns when the selected usages do not cover every project usage of that source comp.

## 4. Work area — every frame

Scans the Work Area of the source composition. This is useful for manually limiting the range without tying it to usages.

## 5. Current frame only

Scans only the current source frame. Use this only for a known static frame or an intentional one-frame crop. Animated pixels appearing later may be cut off.

---

# Frame step

```text
1 = every requested frame
2 = every second requested frame
3 = every third requested frame
```

`Frame step = 1` is recommended. Higher values accelerate dynamic analysis but can miss an extreme between sampled frames. The script always includes the last frame of a requested interval, but coarse sampling is still not mathematically exact.

---

# Automatic temporal optimization

```text
[x] Auto: optimize static / visibility-only timelines
```

When the script can conservatively prove that a composition is time-invariant, hundreds or thousands of candidate frames are reduced to a single rendered-alpha frame. It checks the whole visual property tree, not only Position; a keyframe or enabled expression on a visually relevant property makes the composition dynamic.

If content is static and only layer In/Out visibility changes, the script samples one representative frame for each unique active-layer state. Plain static Text and Shape layers are supported, while Text Animators and Wiggle-like Shape operators fall back to dynamic analysis.

---

# Recursive Crop

```text
[ ] Recursively crop nested precomps first
```

Nested precomps are collected once and processed deepest-first:

```text
MASTER
└── CHARACTER
    └── HEAD
        └── EYES

crop order: EYES → HEAD → CHARACTER → MASTER
```

Shared source comps are processed only once but are still changed globally; all project usages are compensated.

## Recursive + Selected Layers

In version 0.4, selected-usage source times are propagated down the chosen nested branch. A selected interval in `CHARACTER` is mapped through each nested layer's In/Out, Start Time, Stretch, Time Remap, and Frame Blending requirements.

`Selected Layers + Recursive` intentionally optimizes the selected branch, not the whole project. If a shared nested comp is used elsewhere with a different animation range, choose `Used source frames — all project usages` for maximum safety.

---

# How position is preserved

For a detected crop origin:

```text
cropLeft = X
cropTop  = Y
```

root layers inside the source comp receive:

```text
Position += [-X, -Y]
```

By default, every usage receives the same local-space Anchor Point compensation:

```text
Anchor Point += [-X, -Y]
```

The old source pixel therefore remains at the same visible position through 2D parent chains containing Position, Scale, and Rotation. This method also supports safe 2D Collapse Transformations.

---

# Direct children

```text
[x] Preserve direct children of every precomp usage
```

Changing a parent precomp's Anchor Point also affects its direct children. The script offsets each direct child's Position so its world transform remains unchanged. If a required child Position is expression-driven, the crop is skipped rather than rewriting the expression.

---

# Centering Anchor Point through Position

```text
[x] Center resulting precomp Anchor Point (via Position)
```

Version 0.5.0 enables this option by default because a centered Anchor Point is more convenient for later animation. Disable it when you need the most general compensation path, including animated 2D transforms and 2D Collapse Transformations.

When enabled, each resulting usage receives:

```text
Anchor Point = [newWidth / 2, newHeight / 2]
Position    += transformed compensation
```

This can make later manual animation and alignment more convenient. To prevent silent visual shifts, the source comp is skipped if any usage is 3D, has Collapse Transformations enabled, has animated Anchor Point/Scale/Rotation, uses non-zero Skew, or has an expression-driven transform needed for compensation. Static Scale and Rotation are included in the Position-offset calculation. Animated Position remains supported because a constant safe offset can be added to its values.

---

# Collapse Transformations

Supported with the corresponding safety option enabled:

```text
2D Precomp Layer
Collapse Transformations = ON
```

Not supported:

```text
3D Precomp Layer + Collapse Transformations
```

The optional centered-anchor mode also excludes Collapse Transformations usages because its Position-based compensation deliberately targets straightforward 2D transform cases.

---

# Padding

`Padding = 0` crops directly to the detected alpha bounds. `Padding = 20` preserves 20 pixels around the union bounds. Padding is useful for effects that may be added after cropping.

---

# Alpha epsilon

`Alpha epsilon = 0` means any non-zero alpha counts as content. A positive value can ignore extremely small accumulated alpha values, but it should be used carefully: faint antialiasing, glow, shadow, or semi-transparent pixels may be meaningful.

---

# Dry Run

```text
[x] Analyze only (Dry Run) — do not modify the project
```

Dry Run performs the full scan and safety analysis but does not resize compositions or change properties. Its report includes old/new dimensions, saved area, alpha bounds, frames scanned, scan mode, `sampleImage()` calls, cache hits, warnings, and skip reasons.

---

# Project-wide preview and stopping analysis

```text
[ ] Project-wide preview, then apply all safe crops
```

collects every composition in the project, orders them deepest-first, and performs a complete Dry Run. A combined summary is then shown. `Apply Crops` starts a second analysis and applies safe operations; `Cancel` leaves the project without crop changes.

The apply pass deliberately scans again so changes to nested comps and dimension-dependent expressions are reflected. This makes project-wide mode slower but safer than reusing stale bounds.

The progress window includes `Stop analysis`. Cancellation takes effect after the current frame scan. If the apply pass is stopped, already processed compositions remain changed, but the whole pass is contained in one Undo Group.

Project-wide preview can be started without preselecting layers or compositions.

---

# Safety behavior

The script skips a source comp when exact compensation cannot be guaranteed, including cases such as:

- 3D source layers, cameras, or lights;
- collapsed 3D usages;
- expression-driven source root Position;
- expression-driven usage Anchor Point;
- expression-driven direct-child Position when child preservation is enabled;
- Essential Properties when the recommended safety option is enabled;
- active Solo layers when the corresponding safety option is enabled;
- expression-driven masks on a usage;
- centered-anchor cases outside its explicitly supported 2D transform subset.

## Essential Properties

Essential Properties may cause instances of the same source comp to render differently. Because one source-only alpha scan cannot describe every overridden instance, the recommended default is:

```text
[x] Skip usages with Essential Properties (recommended)
```

## Effects

Effects on a usage may contain layer-space controls. The normal mode reports a warning. Enable `Skip usages with effects (strict safety)` when those controls must never be left unremapped. Effects that may change temporal sampling trigger a conservative full-timeline fallback in used-frame modes.

## Dimension-dependent expressions

Expressions referencing `thisComp.width`, `thisComp.height`, layer/source dimensions, or `sourceRectAtTime()` may change after resizing. The script reports these expressions but does not attempt to rewrite arbitrary user logic.

---

# Performance

Version 0.4 combines several optimizations:

1. one project-wide usage index per run;
2. memoized temporal classification;
3. one-frame scans for provably static comps;
4. unique visibility-state scans for static content with changing In/Out;
5. used-source-time planning;
6. recursive selected-time propagation;
7. cached repeated alpha-rectangle samples.

The largest practical speedups occur with oversized PSD-derived layers and long timelines containing mostly static artwork.

---

# Report

Typical result:

```text
OK   Character / Face: 1920x1920 -> 416x465,
     area saved 94.7%, crop origin [938, 980],
     alpha bounds [938, 980]..[1353, 1444],
     1 frame(s) from 1770 candidate frame(s),
     scan=project usages, sampleImage=..., cacheHits=...
```

Prefixes:

- `OK` — crop completed or the comp was already tight.
- `DRY` — projected result; no changes were made.
- `INFO` — optimization or preservation detail.
- `WARN` — review is recommended.
- `SKIP` — the composition was intentionally not changed.
- `ERROR` — an unexpected failure occurred.

---

# Recommended settings

## Normal safe workflow

```text
Scan: Current frame only for a static frame;
      Used source frames — all project usages for animation
Frame step: 1
Auto static optimization: ON
Preserve direct children: ON
Center resulting Anchor Point: ON
Allow 2D Collapse Transformations: ON
Skip Solo: ON
Skip Essential Properties: ON
Strict usage effects: OFF
Recursive Crop: as needed
Dry Run: ON for the first pass
```

## Fast optimization of one master-comp branch

```text
Scan: Used source frames — selected layers in active comp
Frame step: 1
Auto static optimization: ON
Recursive Crop: ON
Dry Run: ON first
```

Use the second preset only when ignoring source-time ranges used by unrelated instances is intentional.

---

# What to verify after cropping

- beginning, middle, and end of animated ranges;
- Time Remap extremes and Frame Blending;
- shared precomps in other compositions;
- usages with masks or effects;
- direct children of cropped precomp layers;
- 2D Collapse Transformations usages;
- dimension-dependent expressions;
- the selected recursive branch when using selected-usage mode;
- centered anchors and Position values if the optional mode was enabled.

Keep a saved `.aep` version before the first large batch. Undo is useful, but a backup is safer.

---

# Known limitations in 0.5.0

1. 3D source comps are not supported.
2. Collapsed 3D usages are not supported.
3. Per-instance Essential Properties bounds are not analyzed.
4. Temporal effects cannot be classified universally, so a conservative fallback is used.
5. Plain static Text/Shape layers are recognized, but Text Animators and Wiggle-like Shape operators are dynamic.
6. Coordinate-dependent expressions may change when comp dimensions change.
7. `Frame step > 1` cannot guarantee intermediate animation extremes.
8. Selected-usage mode can intentionally ignore data used by other instances.
9. Unusual `displayStartTime` and complex subframe temporal effects require further AE testing.
10. Position-based centered-anchor compensation is intentionally limited to safe 2D usages with static Scale/Rotation and no Collapse Transformations.

---

# Roadmap

### 0.6 — Safety and instance-aware analysis

- per-instance Essential Properties analysis;
- finer temporal/non-temporal effect classification;
- strict handling of coordinate-dependent expressions;
- dedicated diagnostics for `toComp/fromComp/toWorld/fromWorld` expressions.

### 0.7 — Partial-static renderer

Separate provably safe static base bounds from dynamic-layer bounds, reducing repeated analysis of large static PSD content.

### 0.8 — Precomp Optimizer

Project/branch batch analysis with a summary such as:

```text
47 comps checked
31 cropped
10 already tight
4 unsafe
2 empty
```

### UI and workflow

- Safe / Balanced / Aggressive presets;
- persistent user settings;
- optional ScriptUI Panel;
- report export;
- per-side padding;
- minimum size/area saving filters.

---

# Version history

## 0.5.0

- Enabled Anchor Point centering by default.
- Added last-used setting persistence through `app.settings`.
- Added `Current Frame / Safe Animation / Selected Branch` presets.
- Added a Stop button for long analyses.
- Added a two-pass project-wide preview with a combined summary and explicit apply confirmation.
- Allowed project-wide mode to run without preselected crop roots.
- Renamed the script to `AlphaSmartCropper_v0.5.0.jsx`.
- Added a persistent launcher palette for repeated runs with a new selection; it closes through the title-bar X or `Close` button.

## 0.4.0

- Made `Current frame only` the default analysis mode.
- Added direct Project-panel composition selection with recursive processing enabled by default.
- Moved `Crop` and `Cancel` to opposite sides of the dialog.
- Added optional safe Anchor Point centering through Position compensation.
- Added recursive propagation of selected-usage source times.
- Added one project-wide usage index.
- Added memoized temporal classification.
- Added visibility-only timeline optimization.
- Added safe static Text and Shape recognition.
- Added repeated alpha-rectangle query caching.
- Added actual `sampleImage()` evaluation counts to the report.
- Embedded the complete alpha analyzer in the standalone JSX.

## 0.3.0

- Used-source-frame modes.
- Conservative one-frame static optimization.
- Recursive crop.
- Frame Blending neighbor samples.
- Essential Properties safety check.
- Track Matte awareness in static proof.

## 0.2.0

- Added support for 2D Collapse Transformations.
- Kept collapsed 3D usages blocked.

## 0.1.x

- Rendered-alpha crop using `sampleImage()`.
- Usage, child, and mask compensation.
- Padding and Dry Run.

---

# Testing status

The JSX passes JavaScript syntax validation, but full integration testing requires Adobe After Effects because `CompItem`, `AVLayer`, `sampleImage()`, ScriptUI, and expression evaluation are provided by AE itself.

For a reproducible issue, include the After Effects version, the relevant `INFO/WARN/SKIP/ERROR` report line, the parent/precomp structure, 2D/3D state, Collapse Transformations state, and whether Position/Anchor Point/Time Remap are animated or expression-driven.
