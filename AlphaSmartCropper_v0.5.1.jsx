#target aftereffects
#targetengine "AlphaSmartCropperEngine"

/**
 * AlphaSmartCropper_v0.5.1.jsx
 * by Stray Token / Luckyanov D.S.
 * Version 0.5.1
 *
 * Alpha-aware precomp cropper for Adobe After Effects.
 *
 * Main differences from geometry/sourceRectAtTime croppers:
 *   - analyzes the FINAL rendered alpha of the source precomp;
 *   - transparent pixels do not count, so full-canvas Photoshop layers are handled;
 *   - treats Layer Opacity as 100% for bounds without modifying its keyframes;
 *   - auto-expands Current Frame to the full timeline when animation can change
 *     visible bounds, then unions every sampled frame;
 *   - can scan every frame of the whole comp or work area;
 *   - preserves every usage of the cropped precomp across the project;
 *   - preserves direct children of those usages by compensating their Position;
 *   - can optionally place every resulting precomp usage Anchor Point at the
 *     center and preserve its image through a Position offset (safe 2D cases);
 *   - supports static, keyframed and separated Position values where a constant
 *     offset can be applied safely;
 *   - preserves masks on precomp usage layers;
 *   - supports 2D precomp usages with Collapse Transformations enabled;
 *   - supports padding and dry-run analysis;
 *   - automatically collapses alpha analysis to one frame when the source comp
 *     can be conservatively proven time-invariant;
 *   - can scan only source times actually referenced by precomp usages;
 *   - can recursively crop nested precomps deepest-first;
 *   - accepts either selected precomp layers in an active composition or
 *     compositions selected directly in the Project panel;
 *   - persists settings and provides Current Frame, Safe Animation and Selected
 *     Branch presets;
 *   - supports cancellable project-wide preview followed by explicit apply;
 *   - keeps the full settings window open for repeated runs with different
 *     layer or Project-panel selections; only Exit closes the script UI;
 *   - can propagate the selected parent usage time range down a recursive
 *     precomp branch instead of scanning unrelated nested-comp time;
 *   - builds a project-wide usage index once per run instead of rescanning the
 *     whole project for every source comp;
 *   - recognizes conservative static Text and Shape layers;
 *   - memoizes static-analysis decisions and alpha-rectangle samples.
 *
 * Important limitations:
 *   - source precomps containing 3D layers/cameras/lights are skipped;
 *   - source root-layer Position expressions are skipped (cannot be safely offset);
 *   - precomp usage Anchor Point expressions are skipped;
 *   - collapsed 3D precomp usages are skipped; collapsed 2D usages are supported;
 *   - direct child Position expressions are skipped when child preservation is on;
 *   - expressions/effects that explicitly depend on comp/layer width/height can
 *     still change after a crop; warnings are included in the report;
 *   - Essential Properties can make different usages render differently; by
 *     default nested/non-selected sources are skipped because a source-only
 *     alpha scan cannot represent per-instance overrides. An explicitly selected
 *     Project-panel root proceeds with a prominent warning.
 *
 * Alpha detection uses an expression helper with sampleImage(). The helper comp is
 * temporary and is removed immediately after analysis.
 */

(function AlphaSmartCropper(thisObj) {
    var VERSION = "0.5.1";
    var SCRIPT_NAME = "Alpha Smart Cropper";
    var SETTINGS_SECTION = "AlphaSmartCropper_0_5";
    var MAIN_WINDOW_GLOBAL_KEY = "__AlphaSmartCropperMainWindow__";

    function runCropWorkflow(settings) {
        if (!app.project) {
            alert(SCRIPT_NAME + ": no project is open.");
            return;
        }

        var selection = getCurrentSelection();
        var selectedLayers = selection.layers;
        var selectedPrecomps = selection.precomps;
        var selectionMode = selection.mode;

        if (settings.projectWide) {
            selectedPrecomps = collectAllProjectComps();
            selectionMode = "project-wide";
            settings.recursiveCrop = true;
        }
        if (selectedPrecomps.length === 0) {
            alert(SCRIPT_NAME + ": select precomp layers or Project-panel compositions, or enable Project-wide preview.");
            return;
        }
        if (settings.scanMode === 2 && selectionMode !== "layers") {
            alert(SCRIPT_NAME + ": Selected Branch requires precomp layers selected in an active composition.");
            return;
        }
        settings.selectionMode = selectionMode;
        settings.selectedRootMap = {};
        for (var selectedRootIndex = 0; selectedRootIndex < selectedPrecomps.length; selectedRootIndex++) {
            settings.selectedRootMap[String(selectedPrecomps[selectedRootIndex].id)] = true;
        }

        // Keep actual layer references. This is more reliable than names and also
        // lets the "selected usages" scan mode distinguish multiple instances
        // of the same source composition.
        settings.selectedUsageMap = buildSelectedUsageMap(selectedLayers);

        // Build expensive project-wide metadata once. Recursive projects can contain
        // hundreds of precomps; rescanning every project layer for every source comp
        // quickly becomes slower than the alpha analysis itself.
        settings.runtime = {
            usageIndex: buildProjectUsageIndex(),
            staticMemo: {},
            recursiveSelectedTimes: null,
            recursiveSelectedNotes: {},
            recursiveTimeLabel: null,
            cancelled: false
        };

        var cropQueue = settings.recursiveCrop
            ? collectRecursivePrecomps(selectedPrecomps)
            : selectedPrecomps;

        var report = [];
        var selectionLabel = selectionMode === "project-wide"
            ? "every composition in the project"
            : (selectionMode === "project" ? "Project panel composition(s)" : "precomp layer(s) in active composition");
        report.push("INFO selection: " + selectionLabel + "; roots=" + selectedPrecomps.length + ".");

        var propagateSelectedBranch = settings.recursiveCrop && settings.scanMode === 2;
        var propagateProjectCurrent = settings.recursiveCrop && settings.scanMode === 4 && selectionMode === "project";
        if (propagateSelectedBranch || propagateProjectCurrent) {
            var branchPlan = buildRecursiveSelectedTimeMap(selectedPrecomps, settings, propagateProjectCurrent);
            settings.runtime.recursiveSelectedTimes = branchPlan.timeMap;
            settings.runtime.recursiveSelectedNotes = branchPlan.noteMap;
            settings.runtime.recursiveTimeLabel = propagateProjectCurrent ? "recursive Project-panel current frame" : "recursive selected branch";
            report.push("INFO recursive time propagation: " + branchPlan.compCount + " comp(s) received constrained source-time samples.");
            if (branchPlan.fallbackCount > 0) {
                report.push("WARN recursive time propagation used full-timeline safety fallback for " + branchPlan.fallbackCount + " nested comp(s) because a nested usage had effects that may alter temporal sampling.");
            }
        }
        if (settings.recursiveCrop && cropQueue.length > selectedPrecomps.length) {
            report.push("INFO recursive crop: " + cropQueue.length + " unique precomp(s), deepest first (" + selectedPrecomps.length + " selected root(s)).");
        }

        if (settings.projectWide && !settings.dryRun) {
            settings.dryRun = true;
            runCropQueue(cropQueue, settings, report, "project-wide preview");

            if (settings.runtime.cancelled) {
                showReport(report);
                return;
            }

            if (!showProjectPreviewReport(report)) return;

            settings.runtime.cancelled = false;
            settings.dryRun = false;
            report = ["INFO project-wide preview approved; re-analyzing and applying safe crops deepest-first."];
            runCropQueue(cropQueue, settings, report, "project-wide apply");
            showReport(report);
            return;
        }

        runCropQueue(cropQueue, settings, report, settings.dryRun ? "dry run" : "crop");
        showReport(report);
    }

    function getCurrentSelection() {
        var activeComp = app.project ? app.project.activeItem : null;
        var selectedLayers = [];
        var selectedPrecomps = [];
        var selectionMode = "none";

        if (activeComp && (activeComp instanceof CompItem)) {
            try { selectedLayers = activeComp.selectedLayers || []; } catch (selectedLayersErr) {}
            selectedPrecomps = collectSelectedPrecomps(selectedLayers);
            if (selectedPrecomps.length > 0) selectionMode = "layers";
        }

        if (selectedPrecomps.length === 0) {
            selectedLayers = [];
            selectedPrecomps = collectSelectedProjectComps();
            selectionMode = selectedPrecomps.length > 0 ? "project" : "none";
        }

        return {layers: selectedLayers, precomps: selectedPrecomps, mode: selectionMode};
    }

    function runCropQueue(cropQueue, settings, report, phaseLabel) {
        var totalFrames = estimateTotalFrames(cropQueue, settings);
        var progress = createProgressController(totalFrames, phaseLabel, settings.progressHost);

        app.beginUndoGroup(SCRIPT_NAME + " — " + phaseLabel);
        try {
            for (var i = 0; i < cropQueue.length; i++) {
                if (settings.runtime.cancelled || (progress && progress.isCancelled())) {
                    settings.runtime.cancelled = true;
                    report.push("STOP analysis cancelled by user after " + i + " / " + cropQueue.length + " composition(s).");
                    break;
                }
                cropPrecomp(cropQueue[i], settings, report, progress);
            }
        } catch (err) {
            report.push("ERROR: " + errorToString(err));
        } finally {
            try {
                app.endUndoGroup();
            } finally {
                if (progress) progress.close();
            }
        }
    }

    // -------------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------------

    function showMainWindow() {
        // Close the obsolete two-stage launcher when this build is run in the
        // same persistent target engine after an in-place script update.
        try {
            var obsoleteLauncher = $.global.__AlphaSmartCropperLauncher__;
            if (obsoleteLauncher) obsoleteLauncher.close();
            $.global.__AlphaSmartCropperLauncher__ = null;
        } catch (obsoleteLauncherErr) {}

        // Migration cleanup for the last progress palette created by builds that
        // used a separate modeless window. New runs use inline progress only.
        try {
            var obsoleteProgress = $.global.__AlphaSmartCropperProgressWindow__;
            if (obsoleteProgress) {
                try { obsoleteProgress.onClose = null; } catch (obsoleteProgressOnCloseErr) {}
                try { obsoleteProgress.visible = false; } catch (obsoleteProgressVisibleErr) {}
                try { obsoleteProgress.hide(); } catch (obsoleteProgressHideErr) {}
                try { obsoleteProgress.close(); } catch (obsoleteProgressCloseErr) {}
            }
            $.global.__AlphaSmartCropperProgressWindow__ = null;
        } catch (obsoleteProgressErr) {}

        try {
            var existing = $.global[MAIN_WINDOW_GLOBAL_KEY];
            if (existing && existing.__ascUiBuild === "0.5.1-inline-progress") {
                existing.show();
                try { existing.active = true; } catch (activateErr) {}
                return;
            }
            if (existing) {
                try { existing.onClose = null; } catch (obsoleteMainOnCloseErr) {}
                try { existing.close(); } catch (obsoleteMainCloseErr) {}
                $.global[MAIN_WINDOW_GLOBAL_KEY] = null;
            }
        } catch (existingErr) {}

        var saved = loadSavedSettings();
        var initialSelection = getCurrentSelection();
        var selectionMode = initialSelection.mode;
        var precomps = initialSelection.precomps;
        var dlg = new Window("palette", SCRIPT_NAME + " " + VERSION);
        dlg.__ascUiBuild = "0.5.1-inline-progress";
        dlg.orientation = "column";
        dlg.alignChildren = ["fill", "top"];
        dlg.spacing = 10;
        dlg.margins = 14;

        var introText = "Select precomp layers or Project-panel compositions, then run Crop. This window stays open for another selection.";
        var intro = dlg.add("statictext", undefined,
            introText,
            {multiline: true});
        intro.alignment = ["fill", "top"];

        var presetRow = dlg.add("group");
        presetRow.alignment = ["fill", "top"];
        presetRow.add("statictext", undefined, "Preset:");
        var presetDrop = presetRow.add("dropdownlist", undefined, [
            "Last used / Custom",
            "Current Frame",
            "Safe Animation",
            "Selected Branch"
        ]);
        presetDrop.selection = 0;
        presetDrop.preferredSize.width = 220;

        var scanPanel = dlg.add("panel", undefined, "Time analysis");
        scanPanel.orientation = "column";
        scanPanel.alignChildren = ["fill", "top"];
        scanPanel.margins = 10;

        var scanRow = scanPanel.add("group");
        scanRow.add("statictext", undefined, "Scan:");
        var scanDrop = scanRow.add("dropdownlist", undefined, [
            "Entire source composition — every frame",
            "Used source frames — all project usages",
            "Used source frames — selected layers in active comp",
            "Work area — every frame",
            "Current frame — auto-expand animated bounds"
        ]);
        var initialScanMode = saved.scanMode !== null ? saved.scanMode : 4;
        scanDrop.selection = initialScanMode;
        scanDrop.preferredSize.width = 365;

        var stepRow = scanPanel.add("group");
        stepRow.add("statictext", undefined, "Frame step:");
        var frameStepEdit = stepRow.add("edittext", undefined, saved.frameStep !== null ? String(saved.frameStep) : "1");
        frameStepEdit.characters = 6;
        var stepHelp = stepRow.add("statictext", undefined, "1 = exact; >1 can miss animation extremes");

        var staticOptimizeCheck = scanPanel.add("checkbox", undefined, "Auto: optimize static / visibility-only timelines");
        staticOptimizeCheck.value = saved.autoStatic !== null ? saved.autoStatic : true;
        staticOptimizeCheck.helpTip = "Conservative optimization. Fully static comps are scanned once. If all rendered content is static and only layer In/Out visibility changes, one representative frame per distinct visibility state is scanned. Plain static Text/Shape layers are supported; uncertain temporal cases fall back to normal frame scanning.";

        var usageHelp = scanPanel.add("statictext", undefined,
            "Used-frame modes map parent-comp frame times through In/Out, Start Time, Stretch and Time Remap. With Recursive Crop + Selected Layers, the selected time range is propagated down the nested precomp branch.",
            {multiline: true});
        usageHelp.alignment = ["fill", "top"];

        var cropPanel = dlg.add("panel", undefined, "Crop");
        cropPanel.orientation = "column";
        cropPanel.alignChildren = ["fill", "top"];
        cropPanel.margins = 10;

        var paddingRow = cropPanel.add("group");
        paddingRow.add("statictext", undefined, "Padding (px):");
        var paddingEdit = paddingRow.add("edittext", undefined, saved.padding !== null ? String(saved.padding) : "0");
        paddingEdit.characters = 8;

        var alphaRow = cropPanel.add("group");
        alphaRow.add("statictext", undefined, "Alpha epsilon:");
        var alphaEdit = alphaRow.add("edittext", undefined, saved.alphaEpsilon !== null ? String(saved.alphaEpsilon) : "0");
        alphaEdit.characters = 10;
        var alphaHelp = alphaRow.add("statictext", undefined, "0 = any non-zero alpha");
        alphaEdit.helpTip = "Alpha samples with total alpha <= epsilon are treated as empty. Use 0 for strict non-zero alpha.";

        var safePanel = dlg.add("panel", undefined, "Safety / preservation");
        safePanel.orientation = "column";
        safePanel.alignChildren = ["left", "top"];
        safePanel.margins = 10;

        var preserveChildrenCheck = safePanel.add("checkbox", undefined, "Preserve direct children of every precomp usage");
        preserveChildrenCheck.value = saved.preserveChildren !== null ? saved.preserveChildren : true;

        var centerAnchorCheck = safePanel.add("checkbox", undefined, "Center resulting precomp Anchor Point (via Position)");
        centerAnchorCheck.value = saved.centerAnchor !== null ? saved.centerAnchor : true;
        centerAnchorCheck.helpTip = "Optional workflow convenience. Centers each safe usage Anchor Point after cropping and compensates Position. If a usage cannot be centered safely, Crop still proceeds for the source comp and that usage receives standard anchor compensation instead.";

        var allowCollapse2DCheck = safePanel.add("checkbox", undefined, "Allow 2D Collapse Transformations usages");
        allowCollapse2DCheck.value = saved.allowCollapse2D !== null ? saved.allowCollapse2D : true;
        allowCollapse2DCheck.helpTip = "Safe for 2D precomp usages: the crop offset and usage Anchor Point offset cancel in the collapsed transform chain. Collapsed 3D usages remain blocked.";

        var skipSoloCheck = safePanel.add("checkbox", undefined, "Skip source comps that currently have Solo layers");
        skipSoloCheck.value = saved.skipSolo !== null ? saved.skipSolo : true;

        var strictEffectsCheck = safePanel.add("checkbox", undefined, "Skip usages with effects (strict safety)");
        strictEffectsCheck.value = saved.strictUsageEffects !== null ? saved.strictUsageEffects : false;
        strictEffectsCheck.helpTip = "Some effects use layer-space coordinates. Leave unchecked for normal use; the report will warn about such usages.";

        var skipEssentialCheck = safePanel.add("checkbox", undefined, "Skip usages with Essential Properties (recommended)");
        skipEssentialCheck.value = saved.skipEssentialProperties !== null ? saved.skipEssentialProperties : true;
        skipEssentialCheck.helpTip = "Essential Properties can override source values per precomp instance, so one source-only alpha scan may not describe every usage. Nested and non-selected sources are skipped. A composition explicitly selected as a Project-panel root proceeds with a warning.";

        var recursiveCheck = safePanel.add("checkbox", undefined, "Recursively crop nested precomps first");
        recursiveCheck.value = saved.recursiveCrop !== null ? saved.recursiveCrop : (selectionMode === "project");
        recursiveCheck.helpTip = "Processes unique nested precomps deepest-first. Shared nested comps are modified globally and every project usage is compensated. In Selected Layers scan mode, only source times reachable from the selected branch are analyzed; this can intentionally ignore animation used only by unrelated usages.";

        var projectWideCheck = safePanel.add("checkbox", undefined, "Project-wide preview, then apply all safe crops");
        projectWideCheck.value = saved.projectWide !== null ? saved.projectWide : false;
        projectWideCheck.helpTip = "Analyzes every composition in the project deepest-first, shows a complete summary, and only applies changes after explicit confirmation. The apply pass re-analyzes comps so recursive changes are reflected. Use Stop to cancel a long scan.";

        var dryRunCheck = safePanel.add("checkbox", undefined, "Analyze only (Dry Run) — do not modify the project");
        dryRunCheck.value = saved.dryRun !== null ? saved.dryRun : false;

        function updateTimeControls() {
            var enableStep = scanDrop.selection && scanDrop.selection.index !== 4;
            frameStepEdit.enabled = enableStep;
            stepHelp.enabled = enableStep;
        }

        function applyPreset(index) {
            if (index === 1) {
                scanDrop.selection = 4;
                frameStepEdit.text = "1";
                staticOptimizeCheck.value = true;
            } else if (index === 2) {
                scanDrop.selection = 0;
                frameStepEdit.text = "1";
                staticOptimizeCheck.value = true;
            } else if (index === 3) {
                scanDrop.selection = 2;
                frameStepEdit.text = "1";
                staticOptimizeCheck.value = true;
                recursiveCheck.value = true;
            }
            updateTimeControls();
        }

        presetDrop.onChange = function () {
            if (presetDrop.selection) applyPreset(presetDrop.selection.index);
        };

        scanDrop.onChange = updateTimeControls;
        updateTimeControls();

        var estimate = dlg.add("statictext", undefined, "Selection: " + selectionMode + "; source precomps: " + precomps.length);
        estimate.alignment = ["fill", "top"];

        function refreshSelectionLabel() {
            var current = getCurrentSelection();
            estimate.text = "Selection: " + current.mode + "; source precomps: " + current.precomps.length;
            try { dlg.layout.layout(true); } catch (layoutErr) {}
        }

        var progressPanel = dlg.add("panel", undefined, "Analysis progress");
        progressPanel.orientation = "column";
        progressPanel.alignChildren = ["fill", "top"];
        progressPanel.margins = 10;
        var progressText = progressPanel.add("statictext", undefined, "Preparing…");
        var progressBar = progressPanel.add("progressbar", undefined, 0, 1);
        progressBar.preferredSize.width = 365;
        var progressStopButton = progressPanel.add("button", undefined, "Stop analysis");
        progressPanel.visible = false;

        var progressState = {active: false, cancelled: false, count: 0, maximum: 1};

        function setProgressVisible(visible) {
            try { progressPanel.visible = visible; } catch (visibilityErr) {}
            try { dlg.layout.layout(true); } catch (progressLayoutErr) {}
            try { dlg.size = dlg.preferredSize; } catch (progressResizeErr) {}
            try { dlg.update(); } catch (progressWindowUpdateErr) {}
        }

        progressStopButton.onClick = function () {
            if (!progressState.active) return;
            progressState.cancelled = true;
            progressStopButton.enabled = false;
            progressText.text = "Stopping…";
            try { dlg.update(); } catch (stopUpdateErr) {}
        };

        var progressHost = {
            begin: function (maximum, phaseLabel) {
                progressState.active = true;
                progressState.cancelled = false;
                progressState.count = 0;
                progressState.maximum = Math.max(1, maximum);
                progressBar.minvalue = 0;
                progressBar.maxvalue = progressState.maximum;
                progressBar.value = 0;
                progressText.text = "Preparing " + (phaseLabel || "analysis") + "…";
                progressStopButton.enabled = true;
                setProgressVisible(true);
            },
            setText: function (s) {
                if (!progressState.active) return;
                progressText.text = s;
                try { dlg.update(); } catch (progressTextUpdateErr) {}
            },
            tick: function (s) {
                if (!progressState.active) return;
                progressState.count++;
                progressBar.value = Math.min(progressState.maximum, progressState.count);
                if (s) progressText.text = s;
                try { dlg.update(); } catch (progressTickUpdateErr) {}
                try { $.sleep(1); } catch (progressTickSleepErr) {}
            },
            isCancelled: function () {
                try { dlg.update(); } catch (progressCancelUpdateErr) {}
                try { $.sleep(1); } catch (progressCancelSleepErr) {}
                return progressState.cancelled;
            },
            finish: function () {
                if (!progressState.active) return;
                if (!progressState.cancelled) progressBar.value = progressState.maximum;
                progressStopButton.enabled = false;
                progressState.active = false;
                setProgressVisible(false);
            }
        };

        var buttons = dlg.add("group");
        buttons.alignment = ["fill", "top"];
        buttons.alignChildren = ["fill", "center"];
        var cropGroup = buttons.add("group");
        cropGroup.alignment = ["left", "center"];
        var okButton = cropGroup.add("button", undefined, "Crop");
        okButton.preferredSize.width = 120;
        var buttonSpacer = buttons.add("group");
        buttonSpacer.alignment = ["fill", "fill"];
        var cancelGroup = buttons.add("group");
        cancelGroup.alignment = ["right", "center"];
        var exitButton = cancelGroup.add("button", undefined, "Exit");
        exitButton.preferredSize.width = 120;

        function collectSettingsFromWindow() {
            var padding = parseFloat(paddingEdit.text);
            if (isNaN(padding) || padding < 0) {
                alert(SCRIPT_NAME + ": Padding must be a number >= 0.");
                return null;
            }

            var alphaEpsilon = parseFloat(alphaEdit.text);
            if (isNaN(alphaEpsilon) || alphaEpsilon < 0) {
                alert(SCRIPT_NAME + ": Alpha epsilon must be a number >= 0.");
                return null;
            }

            var frameStep = parseInt(frameStepEdit.text, 10);
            if (isNaN(frameStep) || frameStep < 1) {
                alert(SCRIPT_NAME + ": Frame step must be an integer >= 1.");
                return null;
            }

            if (projectWideCheck.value && scanDrop.selection.index === 2) {
                alert(SCRIPT_NAME + ": Selected Branch cannot be combined with Project-wide preview. Choose Current Frame or Safe Animation.");
                return null;
            }

            var result = {
                // 0 entire, 1 all usages, 2 selected usages, 3 work area, 4 current
                scanMode: scanDrop.selection.index,
                frameStep: frameStep,
                autoStatic: staticOptimizeCheck.value,
                padding: padding,
                alphaEpsilon: alphaEpsilon,
                preserveChildren: preserveChildrenCheck.value,
                centerAnchor: centerAnchorCheck.value,
                allowCollapse2D: allowCollapse2DCheck.value,
                skipSolo: skipSoloCheck.value,
                strictUsageEffects: strictEffectsCheck.value,
                skipEssentialProperties: skipEssentialCheck.value,
                recursiveCrop: recursiveCheck.value,
                projectWide: projectWideCheck.value,
                dryRun: dryRunCheck.value
            };
            saveSettings(result);
            return result;
        }

        var running = false;
        okButton.onClick = function () {
            if (running) return;
            var settings = collectSettingsFromWindow();
            if (!settings) return;

            running = true;
            okButton.enabled = false;
            exitButton.enabled = false;
            estimate.text = "Running…";
            try { dlg.update(); } catch (beforeRunUpdateErr) {}

            try {
                settings.progressHost = progressHost;
                runCropWorkflow(settings);
            } catch (err) {
                alert(SCRIPT_NAME + ": " + errorToString(err));
            } finally {
                progressHost.finish();
                running = false;
                okButton.enabled = true;
                exitButton.enabled = true;
                refreshSelectionLabel();
                try { dlg.update(); } catch (afterRunUpdateErr) {}
            }
        };

        exitButton.onClick = function () { dlg.close(); };
        dlg.onActivate = refreshSelectionLabel;
        dlg.onClose = function () {
            try { $.global[MAIN_WINDOW_GLOBAL_KEY] = null; } catch (clearGlobalErr) {}
        };

        try { $.global[MAIN_WINDOW_GLOBAL_KEY] = dlg; } catch (storeGlobalErr) {}
        dlg.center();
        dlg.show();
    }

    function loadSavedSettings() {
        return {
            scanMode: readIntSetting("scanMode"),
            frameStep: readIntSetting("frameStep"),
            autoStatic: readBoolSetting("autoStatic"),
            padding: readFloatSetting("padding"),
            alphaEpsilon: readFloatSetting("alphaEpsilon"),
            preserveChildren: readBoolSetting("preserveChildren"),
            centerAnchor: readBoolSetting("centerAnchor"),
            allowCollapse2D: readBoolSetting("allowCollapse2D"),
            skipSolo: readBoolSetting("skipSolo"),
            strictUsageEffects: readBoolSetting("strictUsageEffects"),
            skipEssentialProperties: readBoolSetting("skipEssentialProperties"),
            recursiveCrop: readBoolSetting("recursiveCrop"),
            projectWide: readBoolSetting("projectWide"),
            dryRun: readBoolSetting("dryRun")
        };
    }

    function saveSettings(settings) {
        try {
            app.settings.saveSetting(SETTINGS_SECTION, "scanMode", String(settings.scanMode));
            app.settings.saveSetting(SETTINGS_SECTION, "frameStep", String(settings.frameStep));
            app.settings.saveSetting(SETTINGS_SECTION, "autoStatic", settings.autoStatic ? "1" : "0");
            app.settings.saveSetting(SETTINGS_SECTION, "padding", String(settings.padding));
            app.settings.saveSetting(SETTINGS_SECTION, "alphaEpsilon", String(settings.alphaEpsilon));
            app.settings.saveSetting(SETTINGS_SECTION, "preserveChildren", settings.preserveChildren ? "1" : "0");
            app.settings.saveSetting(SETTINGS_SECTION, "centerAnchor", settings.centerAnchor ? "1" : "0");
            app.settings.saveSetting(SETTINGS_SECTION, "allowCollapse2D", settings.allowCollapse2D ? "1" : "0");
            app.settings.saveSetting(SETTINGS_SECTION, "skipSolo", settings.skipSolo ? "1" : "0");
            app.settings.saveSetting(SETTINGS_SECTION, "strictUsageEffects", settings.strictUsageEffects ? "1" : "0");
            app.settings.saveSetting(SETTINGS_SECTION, "skipEssentialProperties", settings.skipEssentialProperties ? "1" : "0");
            app.settings.saveSetting(SETTINGS_SECTION, "recursiveCrop", settings.recursiveCrop ? "1" : "0");
            app.settings.saveSetting(SETTINGS_SECTION, "projectWide", settings.projectWide ? "1" : "0");
            app.settings.saveSetting(SETTINGS_SECTION, "dryRun", settings.dryRun ? "1" : "0");
        } catch (e) {}
    }

    function readRawSetting(key) {
        try {
            if (app.settings.haveSetting(SETTINGS_SECTION, key)) {
                return app.settings.getSetting(SETTINGS_SECTION, key);
            }
        } catch (e) {}
        return null;
    }

    function readBoolSetting(key) {
        var value = readRawSetting(key);
        if (value === null) return null;
        return value === "1" || value === "true";
    }

    function readIntSetting(key) {
        var value = readRawSetting(key);
        if (value === null) return null;
        var parsed = parseInt(value, 10);
        return isNaN(parsed) ? null : parsed;
    }

    function readFloatSetting(key) {
        var value = readRawSetting(key);
        if (value === null) return null;
        var parsed = parseFloat(value);
        return isNaN(parsed) ? null : parsed;
    }

    function createProgressController(totalFrames, phaseLabel, host) {
        if (!host) return null;
        try {
            host.begin(Math.max(1, totalFrames), phaseLabel || "scanning alpha");
            return {
                setText: function (s) { host.setText(s); },
                tick: function (s) { host.tick(s); },
                isCancelled: function () { return host.isCancelled(); },
                close: function () { host.finish(); }
            };
        } catch (err) {
            try { host.finish(); } catch (finishErr) {}
            return null;
        }
    }

    function showReport(report) {
        if (!report || report.length === 0) {
            alert(SCRIPT_NAME + ": nothing to do.");
            return;
        }

        var dlg = new Window("dialog", SCRIPT_NAME + " — report");
        dlg.orientation = "column";
        dlg.alignChildren = ["fill", "fill"];
        dlg.margins = 12;
        var text = dlg.add("edittext", undefined, report.join("\r\n"), {multiline: true, scrolling: true});
        text.preferredSize = [720, 420];
        var btn = dlg.add("button", undefined, "OK", {name: "ok"});
        dlg.show();
    }

    function showProjectPreviewReport(report) {
        var dlg = new Window("dialog", SCRIPT_NAME + " — project-wide preview");
        dlg.orientation = "column";
        dlg.alignChildren = ["fill", "fill"];
        dlg.margins = 12;

        var summary = summarizeProjectPreview(report);
        var message = dlg.add("statictext", undefined,
            summary + "\r\nReview the complete Dry Run below. Apply Crops will re-analyze and process every safe entry deepest-first; Cancel leaves the project unchanged.",
            {multiline: true});
        message.alignment = ["fill", "top"];

        var text = dlg.add("edittext", undefined, report.join("\r\n"), {multiline: true, scrolling: true});
        text.preferredSize = [760, 460];

        var buttons = dlg.add("group");
        buttons.alignment = ["fill", "top"];
        var applyButton = buttons.add("button", undefined, "Apply Crops", {name: "ok"});
        applyButton.preferredSize.width = 140;
        var spacer = buttons.add("group");
        spacer.alignment = ["fill", "fill"];
        var cancelButton = buttons.add("button", undefined, "Cancel", {name: "cancel"});
        cancelButton.preferredSize.width = 120;

        return dlg.show() === 1;
    }

    function summarizeProjectPreview(report) {
        var counts = {dry: 0, tight: 0, skipped: 0, warnings: 0, errors: 0};
        for (var i = 0; i < report.length; i++) {
            var line = report[i];
            if (line.indexOf("DRY  ") === 0) counts.dry++;
            else if (line.indexOf("OK   ") === 0) counts.tight++;
            else if (line.indexOf("SKIP ") === 0) counts.skipped++;
            else if (line.indexOf("WARN ") === 0) counts.warnings++;
            else if (line.indexOf("ERROR") === 0) counts.errors++;
        }
        return "Project summary — would crop: " + counts.dry +
            ", already tight: " + counts.tight +
            ", skipped: " + counts.skipped +
            ", warnings: " + counts.warnings +
            ", errors: " + counts.errors + ".";
    }

    // -------------------------------------------------------------------------
    // Selection / project traversal
    // -------------------------------------------------------------------------

    function collectSelectedPrecomps(selectedLayers) {
        var comps = [];
        var seen = {};
        for (var i = 0; i < selectedLayers.length; i++) {
            var layer = selectedLayers[i];
            if (!layer.source || !(layer.source instanceof CompItem)) continue;
            var key = String(layer.source.id);
            if (seen[key]) continue;
            seen[key] = true;
            comps.push(layer.source);
        }
        return comps;
    }

    function collectSelectedProjectComps() {
        var comps = [];
        var seen = {};
        var selection = [];
        try { selection = app.project.selection || []; } catch (e) {}

        for (var i = 0; i < selection.length; i++) {
            var item = selection[i];
            if (!(item instanceof CompItem)) continue;
            var key = String(item.id);
            if (seen[key]) continue;
            seen[key] = true;
            comps.push(item);
        }
        return comps;
    }

    function collectAllProjectComps() {
        var comps = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem) comps.push(item);
        }
        return comps;
    }

    function buildSelectedUsageMap(selectedLayers) {
        var map = {};
        for (var i = 0; i < selectedLayers.length; i++) {
            var layer = selectedLayers[i];
            if (!layer.source || !(layer.source instanceof CompItem)) continue;
            var key = String(layer.source.id);
            if (!map[key]) map[key] = [];
            map[key].push(layer);
        }
        return map;
    }

    function isSelectedUsage(sourceComp, layer, settings) {
        if (!settings.selectedUsageMap) return false;
        var list = settings.selectedUsageMap[String(sourceComp.id)];
        if (!list) return false;
        for (var i = 0; i < list.length; i++) {
            if (list[i] === layer) return true;
        }
        return false;
    }

    function buildProjectUsageIndex() {
        var index = {};
        var project = app.project;

        for (var i = 1; i <= project.numItems; i++) {
            var item = project.item(i);
            if (!(item instanceof CompItem)) continue;

            for (var j = 1; j <= item.numLayers; j++) {
                var layer = item.layer(j);
                var source = null;
                try { source = layer.source; } catch (e1) {}
                if (!source || !(source instanceof CompItem)) continue;

                var key = String(source.id);
                if (!index[key]) index[key] = [];
                index[key].push({layer: layer, comp: item});
            }
        }

        return index;
    }

    function collectRecursivePrecomps(rootComps) {
        var ordered = [];
        var visited = {};
        var visiting = {};

        function visit(comp) {
            var key = String(comp.id);
            if (visited[key]) return;
            if (visiting[key]) return; // AE normally prevents comp cycles; guard anyway.
            visiting[key] = true;

            for (var i = 1; i <= comp.numLayers; i++) {
                var layer = comp.layer(i);
                try {
                    if (layer.source && (layer.source instanceof CompItem)) {
                        visit(layer.source);
                    }
                } catch (e) {}
            }

            visiting[key] = false;
            visited[key] = true;
            ordered.push(comp);
        }

        for (var r = 0; r < rootComps.length; r++) visit(rootComps[r]);
        return ordered;
    }

    function buildRecursiveSelectedTimeMap(rootComps, settings, seedFromProjectCurrent) {
        var records = {};
        var queue = [];
        var queued = {};
        var noteMap = {};
        var fallbackComps = {};
        var activeComp = app.project.activeItem;

        function ensureRecord(comp) {
            var key = String(comp.id);
            if (!records[key]) {
                records[key] = {times: [], seen: {}, processed: {}, forcedFull: false};
            }
            return records[key];
        }

        function enqueue(comp) {
            var key = String(comp.id);
            if (queued[key]) return;
            queued[key] = true;
            queue.push(comp);
        }

        function addTime(comp, t) {
            var rec = ensureRecord(comp);
            var clamped = clamp(t, 0, maxRenderableTime(comp));
            var timeKey = String(Math.round(clamped * 1000000));
            if (rec.seen[timeKey]) return false;
            rec.seen[timeKey] = true;
            rec.times.push(clamped);
            enqueue(comp);
            return true;
        }

        function forceFullTimeline(comp, why) {
            var key = String(comp.id);
            var rec = ensureRecord(comp);
            if (rec.forcedFull) return;

            rec.forcedFull = true;
            rec.times = [];
            rec.seen = {};
            rec.processed = {};

            var full = getTimelineTimes(comp, 0, comp.duration, settings.frameStep);
            for (var i = 0; i < full.length; i++) {
                var tk = String(Math.round(full[i] * 1000000));
                if (!rec.seen[tk]) {
                    rec.seen[tk] = true;
                    rec.times.push(full[i]);
                }
            }

            fallbackComps[key] = true;
            if (!noteMap[key]) noteMap[key] = [];
            noteMap[key].push("WARN recursive selected-branch timing used the full source timeline (" + why + ") for");
            enqueue(comp);
        }

        // Seed either from the selected Project-panel compositions' own current
        // times or from selected layer instances in the active composition.
        for (var r = 0; r < rootComps.length; r++) {
            var root = rootComps[r];
            if (seedFromProjectCurrent) {
                addTime(root, root.time);
                continue;
            }

            var selected = settings.selectedUsageMap[String(root.id)] || [];
            if (selected.length === 0) continue;

            var usageData = [];
            var rootHasUsageEffects = false;
            for (var u = 0; u < selected.length; u++) {
                usageData.push({layer: selected[u], comp: activeComp});
                if (hasEffects(selected[u])) rootHasUsageEffects = true;
            }

            if (rootHasUsageEffects) {
                forceFullTimeline(root, "selected root usage has effects that may alter temporal sampling");
                continue;
            }

            var rootTimes = getUsedSourceTimes(root, usageData, settings.frameStep);
            if (!rootTimes.ok || rootTimes.times.length === 0) {
                forceFullTimeline(root, rootTimes.ok ? "selected usage produced no source samples" : "selected usage mapping failed: " + rootTimes.reason);
                continue;
            }

            for (var rt = 0; rt < rootTimes.times.length; rt++) addTime(root, rootTimes.times[rt]);
        }

        // Propagate only the actually sampled parent-source times into nested
        // precomp layers. New times can arrive through multiple branches, so a
        // queue + per-time processed set is used instead of a one-shot DFS.
        while (queue.length > 0) {
            var parentComp = queue.shift();
            var parentKey = String(parentComp.id);
            queued[parentKey] = false;
            var parentRec = records[parentKey];
            if (!parentRec) continue;

            for (var ti = 0; ti < parentRec.times.length; ti++) {
                var parentTime = parentRec.times[ti];
                var parentTimeKey = String(Math.round(parentTime * 1000000));
                if (parentRec.processed[parentTimeKey]) continue;
                parentRec.processed[parentTimeKey] = true;

                for (var li = 1; li <= parentComp.numLayers; li++) {
                    var nestedLayer = parentComp.layer(li);
                    var childComp = null;
                    try { childComp = nestedLayer.source; } catch (sourceErr) {}
                    if (!childComp || !(childComp instanceof CompItem)) continue;
                    if (!layerCanContributePixels(nestedLayer)) continue;
                    if (!isLayerActiveAtTime(nestedLayer, parentTime)) continue;

                    if (hasEffects(nestedLayer)) {
                        forceFullTimeline(childComp, "nested usage has effects in " + parentComp.name + " / " + nestedLayer.name);
                        continue;
                    }

                    try {
                        var childTime = mapUsageTimeToSourceTime(nestedLayer, childComp, parentTime);
                        addTime(childComp, childTime);

                        var useFrameBlending = false;
                        try { useFrameBlending = !!nestedLayer.frameBlending; } catch (fbErr) {}
                        if (useFrameBlending) {
                            addTime(childComp, childTime - childComp.frameDuration);
                            addTime(childComp, childTime + childComp.frameDuration);
                        }
                    } catch (mapErr) {
                        forceFullTimeline(childComp, "nested time mapping failed in " + parentComp.name + " / " + nestedLayer.name + ": " + errorToString(mapErr));
                    }
                }
            }
        }

        var timeMap = {};
        var compCount = 0;
        for (var key in records) {
            if (!records.hasOwnProperty(key)) continue;
            records[key].times.sort(function (a, b) { return a - b; });
            if (records[key].times.length > 0) {
                timeMap[key] = records[key].times;
                compCount++;
                if (!noteMap[key]) noteMap[key] = [];
                noteMap[key].push("INFO recursive selected-branch scan constrained analysis to " + records[key].times.length + " source sample(s) for");
            }
        }

        var fallbackCount = 0;
        for (var fk in fallbackComps) {
            if (fallbackComps.hasOwnProperty(fk)) fallbackCount++;
        }

        return {
            timeMap: timeMap,
            noteMap: noteMap,
            compCount: compCount,
            fallbackCount: fallbackCount
        };
    }

    function isLayerActiveAtTime(layer, t) {
        var eps = 0.0000001;
        try {
            return (t + eps >= layer.inPoint) && (t < layer.outPoint - eps);
        } catch (e) {
            return true;
        }
    }

    function collectUsageData(sourceComp, settings, report) {
        var usages = [];
        var indexed = [];

        if (settings.runtime && settings.runtime.usageIndex) {
            indexed = settings.runtime.usageIndex[String(sourceComp.id)] || [];
        } else {
            // Defensive fallback for future reuse of this function outside main().
            var fallbackIndex = buildProjectUsageIndex();
            indexed = fallbackIndex[String(sourceComp.id)] || [];
        }

        for (var i = 0; i < indexed.length; i++) {
            var item = indexed[i].comp;
            var layer = indexed[i].layer;

                var collapseEnabled = false;
                try { collapseEnabled = !!layer.collapseTransformation; } catch (collapseErr) {}

                if (collapseEnabled) {
                    var usageIs3D = false;
                    try { usageIs3D = !!layer.threeDLayer; } catch (usage3DErr) {}

                    if (usageIs3D) {
                        return {
                            ok: false,
                            reason: "usage has Collapse Transformations + 3D Layer enabled; exact compensation is not safe: " + item.name + " / " + layer.name
                        };
                    }

                    if (!settings.allowCollapse2D) {
                        return {
                            ok: false,
                            reason: "usage has 2D Collapse Transformations enabled and support is disabled in settings: " + item.name + " / " + layer.name
                        };
                    }

                    report.push("INFO " + sourceComp.name + ": preserving 2D Collapse Transformations usage: " + item.name + " / " + layer.name);
                }

                var anchor = getTransformProperty(layer, "ADBE Anchor Point");
                if (!canShiftPointProperty(anchor)) {
                    return {
                        ok: false,
                        reason: "usage Anchor Point is expression-driven or otherwise not shiftable: " + item.name + " / " + layer.name
                    };
                }

                var centerData = null;
                if (settings.centerAnchor) {
                    var centerResult = inspectCenterAnchorUsage(layer);
                    if (!centerResult.ok) {
                        report.push("WARN " + sourceComp.name + ": Anchor Point centering disabled for this usage; Crop will use standard anchor compensation: " + item.name + " / " + layer.name + " — " + centerResult.reason);
                    } else {
                        centerData = centerResult.data;
                    }
                }

                if (hasEssentialProperties(layer)) {
                    if (settings.skipEssentialProperties) {
                        var explicitlySelectedProjectRoot = settings.selectionMode === "project" &&
                            settings.selectedRootMap && settings.selectedRootMap[String(sourceComp.id)];
                        if (!explicitlySelectedProjectRoot) {
                            return {
                                ok: false,
                                reason: "usage has Essential Properties; per-instance overrides can change rendered bounds: " + item.name + " / " + layer.name
                            };
                        }
                        report.push("WARN " + sourceComp.name + ": explicitly selected Project-panel root has a usage with Essential Properties; cropping the selected source as requested, but per-instance override bounds cannot be guaranteed: " + item.name + " / " + layer.name);
                    } else {
                        report.push("WARN " + sourceComp.name + ": usage has Essential Properties; source-only alpha analysis cannot guarantee per-instance overridden bounds: " + item.name + " / " + layer.name);
                    }
                }

                if (settings.strictUsageEffects && hasEffects(layer)) {
                    return {
                        ok: false,
                        reason: "usage has effects and Strict Safety is enabled: " + item.name + " / " + layer.name
                    };
                }

                if (hasEffects(layer)) {
                    report.push("WARN " + sourceComp.name + ": usage has effects; layer-space effect controls are not automatically remapped: " + item.name + " / " + layer.name);
                }

                var masksResult = captureUsageMasks(layer);
                if (!masksResult.ok) {
                    return {
                        ok: false,
                        reason: "usage has an expression-driven mask path: " + item.name + " / " + layer.name
                    };
                }

                var children = [];
                if (settings.preserveChildren) {
                    for (var k = 1; k <= item.numLayers; k++) {
                        var child = item.layer(k);
                        if (child.parent !== layer) continue;
                        var childPos = getTransformProperty(child, "ADBE Position");
                        if (!canShiftPointProperty(childPos)) {
                            return {
                                ok: false,
                                reason: "direct child Position cannot be safely offset: " + item.name + " / " + child.name
                            };
                        }
                        children.push(child);
                    }
                }

                usages.push({
                    layer: layer,
                    comp: item,
                    anchorState: capturePointProperty(anchor),
                    centerData: centerData,
                    children: children,
                    masks: masksResult.masks,
                    collapseTransformation: collapseEnabled
                });
        }

        return {ok: true, usages: usages};
    }

    // -------------------------------------------------------------------------
    // Crop operation
    // -------------------------------------------------------------------------

    function cropPrecomp(comp, settings, report, progress) {
        if (!comp || !(comp instanceof CompItem)) return;

        if (progress) progress.setText("Checking: " + comp.name);

        if (comp.numLayers === 0) {
            report.push("SKIP " + comp.name + ": empty composition.");
            return;
        }

        var safety = inspectSourceComp(comp, settings);
        if (!safety.ok) {
            report.push("SKIP " + comp.name + ": " + safety.reason);
            return;
        }

        var dimWarnings = findDimensionDependentExpressions(comp);
        if (dimWarnings.length > 0) {
            report.push("WARN " + comp.name + ": " + dimWarnings.length + " expression(s) reference comp/layer dimensions; resizing may change their result.");
        }

        var usageResult = collectUsageData(comp, settings, report);
        if (!usageResult.ok) {
            report.push("SKIP " + comp.name + ": " + usageResult.reason);
            return;
        }

        var scanStart = new Date().getTime();
        var scan = scanAlphaBounds(comp, settings, progress, usageResult.usages);
        var scanMs = new Date().getTime() - scanStart;

        if (!scan.ok) {
            if (scan.cancelled) {
                settings.runtime.cancelled = true;
                report.push("STOP " + comp.name + ": analysis cancelled by user.");
                return;
            }
            report.push("SKIP " + comp.name + ": alpha scan failed: " + scan.reason);
            return;
        }

        if (scan.notes && scan.notes.length > 0) {
            for (var sn = 0; sn < scan.notes.length; sn++) {
                report.push(scan.notes[sn] + " " + comp.name);
            }
        }

        if (scan.staticOptimized) {
            report.push("INFO " + comp.name + ": static alpha proven; reduced " + scan.framesCandidate + " candidate frame(s) to 1 rendered-alpha frame.");
        } else if (scan.visibilityOptimized) {
            report.push("INFO " + comp.name + ": only layer visibility changes over time; reduced " + scan.framesCandidate + " candidate frame(s) to " + scan.framesScanned + " distinct visibility state(s).");
        }

        if (!scan.found) {
            report.push("SKIP " + comp.name + ": no non-zero alpha found in scanned frames (" + scan.framesScanned + " frame(s)).");
            return;
        }

        var p = settings.padding;
        var cropLeft = Math.floor(scan.left - p);
        var cropTop = Math.floor(scan.top - p);
        var cropRightExclusive = Math.ceil((scan.right + 1) + p);
        var cropBottomExclusive = Math.ceil((scan.bottom + 1) + p);

        var newW = Math.max(1, cropRightExclusive - cropLeft);
        var newH = Math.max(1, cropBottomExclusive - cropTop);
        var oldW = comp.width;
        var oldH = comp.height;

        if (newW === oldW && newH === oldH && cropLeft === 0 && cropTop === 0) {
            report.push("OK   " + comp.name + ": already alpha-tight (" + oldW + "x" + oldH + "), scanned " + scan.framesScanned + " frame(s) in " + scanMs + " ms" +
                (typeof scan.sampleCalls === "number" ? ", sampleImage=" + scan.sampleCalls : "") + ".");
            return;
        }

        var frameSummary = scan.framesScanned + " frame(s)";
        if ((scan.staticOptimized || scan.visibilityOptimized) && scan.framesCandidate > scan.framesScanned) {
            frameSummary += " from " + scan.framesCandidate + " candidate frame(s)";
        }

        var oldArea = Math.max(1, oldW * oldH);
        var newArea = Math.max(1, newW * newH);
        var areaSavedPct = Math.max(0, (1 - (newArea / oldArea)) * 100);

        var summary = comp.name + ": " + oldW + "x" + oldH + " -> " + newW + "x" + newH +
            ", area saved " + areaSavedPct.toFixed(1) + "%" +
            ", crop origin [" + cropLeft + ", " + cropTop + "]" +
            ", alpha bounds [" + scan.left + ", " + scan.top + "]..[" + scan.right + ", " + scan.bottom + "]" +
            ", " + frameSummary + ", " + scanMs + " ms" +
            (scan.scanLabel ? ", scan=" + scan.scanLabel : "") +
            (typeof scan.sampleCalls === "number" ? ", sampleImage=" + scan.sampleCalls : "") +
            (scan.sampleCacheHits ? ", cacheHits=" + scan.sampleCacheHits : "");

        if (settings.frameStep > 1 && settings.scanMode !== 4) {
            report.push("WARN " + comp.name + ": frame step is " + settings.frameStep + "; intermediate parent/source frames were not checked.");
        }

        if (settings.dryRun) {
            report.push("DRY  " + summary);
            return;
        }

        var dx = -cropLeft;
        var dy = -cropTop;

        // Move the source comp's rendered content so old pixel (x,y) becomes
        // new pixel (x-cropLeft, y-cropTop).
        shiftSourceRootLayers(comp, dx, dy);

        // The default compensation shifts Anchor Point by the crop offset. The
        // optional centered-anchor mode instead finishes with Anchor Point at the
        // new source center and applies the remaining transformed offset to
        // Position. Direct children follow the final Anchor Point delta.
        compensateUsageChildren(usageResult.usages, dx, dy, settings.centerAnchor, newW, newH);

        // Resize after root content has been shifted.
        comp.width = newW;
        comp.height = newH;

        // Restore usage anchors from values captured BEFORE resize, then offset.
        compensateUsagesAndMasks(usageResult.usages, dx, dy, settings.centerAnchor, newW, newH);

        report.push("OK   " + summary);
    }

    // -------------------------------------------------------------------------
    // Source safety / transform shifting
    // -------------------------------------------------------------------------

    function inspectSourceComp(comp, settings) {
        var hasSolo = false;

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);

            if (layer.solo) hasSolo = true;

            if (isCameraOrLight(layer)) {
                return {ok: false, reason: "contains a camera/light; exact 2D comp-space crop compensation is not safe."};
            }

            try {
                if (layer.threeDLayer) {
                    return {ok: false, reason: "contains a 3D layer: " + layer.name};
                }
            } catch (e) {}

            if (layer.parent === null) {
                var pos = getTransformProperty(layer, "ADBE Position");
                if (!canShiftPointProperty(pos)) {
                    return {ok: false, reason: "root Position cannot be safely offset: " + layer.name};
                }
            }
        }

        if (settings.skipSolo && hasSolo) {
            return {ok: false, reason: "Solo is active inside the source comp. Disable Solo or uncheck the safety option."};
        }

        return {ok: true};
    }

    function shiftSourceRootLayers(comp, dx, dy) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (layer.parent !== null) continue;
            var pos = getTransformProperty(layer, "ADBE Position");
            withLayerUnlocked(layer, function () {
                shiftPointProperty(pos, dx, dy);
            });
        }
    }

    function compensateUsageChildren(usages, dx, dy, centerAnchor, newW, newH) {
        for (var i = 0; i < usages.length; i++) {
            var anchorShift = [dx, dy];
            if (centerAnchor && usages[i].centerData) {
                var oldAnchor = usages[i].centerData.anchor;
                anchorShift = [(newW / 2) - oldAnchor[0], (newH / 2) - oldAnchor[1]];
            }
            var children = usages[i].children;
            for (var j = 0; j < children.length; j++) {
                var child = children[j];
                var pos = getTransformProperty(child, "ADBE Position");
                withLayerUnlocked(child, function () {
                    shiftPointProperty(pos, anchorShift[0], anchorShift[1]);
                });
            }
        }
    }

    function compensateUsagesAndMasks(usages, dx, dy, centerAnchor, newW, newH) {
        for (var i = 0; i < usages.length; i++) {
            var data = usages[i];
            withLayerUnlocked(data.layer, function () {
                var anchor = getTransformProperty(data.layer, "ADBE Anchor Point");
                if (centerAnchor && data.centerData) {
                    var targetAnchor = [newW / 2, newH / 2];
                    var defaultAnchor = [data.centerData.anchor[0] + dx, data.centerData.anchor[1] + dy];
                    var localRemainder = [targetAnchor[0] - defaultAnchor[0], targetAnchor[1] - defaultAnchor[1]];
                    var positionDelta = transform2DVector(localRemainder, data.centerData.scale, data.centerData.rotation);
                    var position = getTransformProperty(data.layer, "ADBE Position");

                    anchor.setValue(targetAnchor);
                    shiftPointProperty(position, positionDelta[0], positionDelta[1]);
                } else {
                    applyCapturedPointShift(anchor, data.anchorState, dx, dy);
                }
                applyCapturedMaskShift(data.masks, dx, dy);
            });
        }
    }

    function inspectCenterAnchorUsage(layer) {
        try {
            if (layer.threeDLayer) return {ok: false, reason: "3D usage"};
            if (layer.collapseTransformation) return {ok: false, reason: "Collapse Transformations is enabled"};

            var anchor = getTransformProperty(layer, "ADBE Anchor Point");
            var position = getTransformProperty(layer, "ADBE Position");
            var scale = getTransformProperty(layer, "ADBE Scale");
            var rotation = getTransformProperty(layer, "ADBE Rotate Z");
            var skew = getTransformProperty(layer, "ADBE Skew");
            var skewAxis = getTransformProperty(layer, "ADBE Skew Axis");

            if (!canShiftPointProperty(position)) return {ok: false, reason: "Position is expression-driven or otherwise not shiftable"};
            if ((anchor.numKeys || 0) > 0) return {ok: false, reason: "Anchor Point is animated"};
            if (!isStaticExpressionFreeProperty(scale)) return {ok: false, reason: "Scale is animated or expression-driven"};
            if (!isStaticExpressionFreeProperty(rotation)) return {ok: false, reason: "Rotation is animated or expression-driven"};
            if ((skew && !isStaticExpressionFreeProperty(skew)) || (skewAxis && !isStaticExpressionFreeProperty(skewAxis))) return {ok: false, reason: "Skew is animated or expression-driven"};
            if (skew && Math.abs(skew.value) > 0.0000001) return {ok: false, reason: "non-zero Skew is not supported by centered-anchor compensation"};

            return {
                ok: true,
                data: {
                    anchor: cloneValue(anchor.value),
                    scale: cloneValue(scale.value),
                    rotation: rotation.value
                }
            };
        } catch (e) {
            return {ok: false, reason: errorToString(e)};
        }
    }

    function isStaticExpressionFreeProperty(prop) {
        if (!prop) return false;
        try {
            return !prop.expressionEnabled && (prop.numKeys || 0) === 0;
        } catch (e) {
            return false;
        }
    }

    function transform2DVector(v, scale, rotationDegrees) {
        var sx = scale[0] / 100;
        var sy = scale[1] / 100;
        var radians = rotationDegrees * Math.PI / 180;
        var c = Math.cos(radians);
        var s = Math.sin(radians);
        var x = v[0] * sx;
        var y = v[1] * sy;
        return [(x * c) - (y * s), (x * s) + (y * c)];
    }

    // -------------------------------------------------------------------------
    // Alpha scan
    // -------------------------------------------------------------------------

    function scanAlphaBounds(comp, settings, progress, usages) {
        return scanAlphaBoundsFresh(comp, settings, progress, usages);
    }

    function scanAlphaBoundsFresh(comp, settings, progress, usages) {
        var analyzer = null;
        var opacityOverrides = [];
        try {
            var plan = buildScanPlan(comp, settings, usages);
            var times = plan.times;
            if (times.length === 0) {
                return {ok: false, reason: "no frame times to scan"};
            }

            opacityOverrides = forceLayerOpacityForBounds(comp);
            if (opacityOverrides.length > 0) {
                plan.notes.push("INFO Layer Opacity was treated as 100% for bounds analysis (" + opacityOverrides.length + " overridden layer(s)) for");
            }

            analyzer = createAlphaAnalyzer(comp, settings.alphaEpsilon, progress);
            var globalBounds = null;

            for (var i = 0; i < times.length; i++) {
                if (progress && progress.isCancelled()) {
                    return {ok: false, cancelled: true, reason: "cancelled by user"};
                }
                var t = times[i];
                if (progress) {
                    progress.tick("Scanning " + comp.name + " — frame " + (i + 1) + " / " + times.length);
                }

                if (globalBounds === null) {
                    if (!analyzer.hasAlphaRect(t, 0, 0, comp.width, comp.height)) {
                        continue;
                    }
                    globalBounds = findFullBoundsAtTime(analyzer, comp.width, comp.height, t);
                } else {
                    extendGlobalBoundsAtTime(analyzer, globalBounds, comp.width, comp.height, t);
                }
            }

            if (globalBounds === null) {
                return {
                    ok: true,
                    found: false,
                    framesScanned: times.length,
                    framesCandidate: plan.candidateCount,
                    staticOptimized: plan.staticOptimized,
                    visibilityOptimized: plan.visibilityOptimized,
                    scanLabel: plan.label,
                    notes: plan.notes,
                    sampleCalls: analyzer.getStats().sampleCalls,
                    sampleCacheHits: analyzer.getStats().cacheHits
                };
            }

            return {
                ok: true,
                found: true,
                left: globalBounds.left,
                top: globalBounds.top,
                right: globalBounds.right,
                bottom: globalBounds.bottom,
                framesScanned: times.length,
                framesCandidate: plan.candidateCount,
                staticOptimized: plan.staticOptimized,
                visibilityOptimized: plan.visibilityOptimized,
                scanLabel: plan.label,
                notes: plan.notes,
                sampleCalls: analyzer.getStats().sampleCalls,
                sampleCacheHits: analyzer.getStats().cacheHits
            };
        } catch (err) {
            try {
                if (err && err.ascCancelled) {
                    return {ok: false, cancelled: true, reason: "cancelled by user"};
                }
            } catch (cancelInspectErr) {}
            return {ok: false, reason: errorToString(err)};
        } finally {
            if (analyzer) analyzer.dispose();
            restoreLayerOpacityAfterBounds(opacityOverrides);
        }
    }

    function forceLayerOpacityForBounds(rootComp) {
        var states = [];
        var visited = {};

        function visit(comp) {
            var compKey = String(comp.id);
            if (visited[compKey]) return;
            visited[compKey] = true;

            for (var i = 1; i <= comp.numLayers; i++) {
                var layer = comp.layer(i);
                var opacity = getTransformProperty(layer, "ADBE Opacity");

                if (opacity) {
                    var needsOverride = false;
                    try {
                        needsOverride = !!opacity.expressionEnabled || (opacity.numKeys || 0) > 0 || Math.abs(opacity.value - 100) > 0.0000001;
                    } catch (inspectOpacityErr) {
                        needsOverride = true;
                    }

                    if (needsOverride) {
                        var canSet = false;
                        try { canSet = !!opacity.canSetExpression; } catch (canSetErr) {}
                        if (!canSet) {
                            throw new Error("Layer Opacity cannot be overridden safely for bounds analysis: " + comp.name + " / " + layer.name);
                        }

                        var state = {
                            layer: layer,
                            prop: opacity,
                            expression: "",
                            expressionEnabled: false,
                            wasLocked: false
                        };
                        try { state.expression = opacity.expression || ""; } catch (readExpressionErr) {}
                        try { state.expressionEnabled = !!opacity.expressionEnabled; } catch (readEnabledErr) {}
                        try { state.wasLocked = !!layer.locked; } catch (readLockErr) {}
                        states.push(state);

                        try {
                            if (state.wasLocked) layer.locked = false;
                            opacity.expression = "100";
                            opacity.expressionEnabled = true;
                        } finally {
                            try { if (state.wasLocked) layer.locked = true; } catch (restoreLockErr) {}
                        }
                    }
                }

                var source = null;
                try { source = layer.source; } catch (sourceErr) {}
                if (source && (source instanceof CompItem)) visit(source);
            }
        }

        try {
            visit(rootComp);
            return states;
        } catch (err) {
            restoreLayerOpacityAfterBounds(states);
            throw err;
        }
    }

    function restoreLayerOpacityAfterBounds(states) {
        if (!states) return;
        var firstError = null;
        for (var i = states.length - 1; i >= 0; i--) {
            var state = states[i];
            try {
                if (state.wasLocked) state.layer.locked = false;
                state.prop.expression = state.expression;
                state.prop.expressionEnabled = state.expressionEnabled;
            } catch (restoreErr) {
                if (!firstError) firstError = restoreErr;
            } finally {
                try { if (state.wasLocked) state.layer.locked = true; } catch (restoreLockErr) {}
            }
        }
        if (firstError) {
            throw new Error("Could not restore Layer Opacity after bounds analysis: " + errorToString(firstError));
        }
    }

    function createAlphaAnalyzer(sourceComp, alphaEpsilon, progress) {
        var project = app.project;
        var tmpName = "__AlphaSmartCropper_TMP__" + sourceComp.id + "_" + (new Date().getTime());
        var tmpComp = project.items.addComp(
            tmpName,
            sourceComp.width,
            sourceComp.height,
            sourceComp.pixelAspect,
            sourceComp.duration,
            sourceComp.frameRate
        );

        try {
            tmpComp.resolutionFactor = [1, 1];
            try { tmpComp.preserveNestedFrameRate = true; } catch (e1) {}
            try { tmpComp.preserveNestedResolution = false; } catch (e2) {}

            var srcLayer = tmpComp.layers.add(sourceComp);
            srcLayer.name = "__ASC_SOURCE__";
            srcLayer.startTime = 0;
            srcLayer.inPoint = 0;
            srcLayer.outPoint = sourceComp.duration;
            try { srcLayer.collapseTransformation = false; } catch (e3) {}
            try { srcLayer.motionBlur = false; } catch (e4) {}
            try { srcLayer.frameBlending = false; } catch (e5) {}

            var ctrl = tmpComp.layers.addNull();
            ctrl.name = "__ASC_CONTROLLER__";

            var effects = ctrl.property("ADBE Effect Parade");

            var pointFx = effects.addProperty("ADBE Point Control");
            pointFx.name = "ASC Sample Point";

            var radiusFx = effects.addProperty("ADBE Point Control");
            radiusFx.name = "ASC Sample Radius";

            var alphaFx = effects.addProperty("ADBE Slider Control");
            alphaFx.name = "ASC Alpha";

            // Adding properties to an indexed group invalidates old references.
            pointFx = effects.property("ASC Sample Point");
            radiusFx = effects.property("ASC Sample Radius");
            alphaFx = effects.property("ASC Alpha");

            var pointProp = pointFx.property(1);
            var radiusProp = radiusFx.property(1);
            var alphaProp = alphaFx.property(1);

            var srcIndex = srcLayer.index;
            alphaProp.expression =
                "thisComp.layer(" + srcIndex + ").sampleImage(" +
                "effect(\"ASC Sample Point\")(1), " +
                "effect(\"ASC Sample Radius\")(1), true, time)[3];";

            pointProp.setValue([0, 0]);
            radiusProp.setValue([0.5, 0.5]);
            var test = alphaProp.valueAtTime(0, false);
            if (typeof test !== "number") {
                throw new Error("sampleImage helper did not return a numeric alpha value");
            }
            if (alphaProp.expressionError && alphaProp.expressionError !== "") {
                throw new Error("sampleImage expression error: " + alphaProp.expressionError);
            }

            var rectCache = {};
            var sampleCalls = 0;
            var cacheHits = 0;

            function stopIfRequested() {
                if (progress && progress.isCancelled()) {
                    var cancelError = new Error("cancelled by user");
                    cancelError.ascCancelled = true;
                    throw cancelError;
                }
            }

            return {
                hasAlphaRect: function (time, x0, y0, x1, y1) {
                    stopIfRequested();
                    if (x1 <= x0 || y1 <= y0) return false;

                    var cacheKey = String(Math.round(time * 1000000)) + ":" +
                        x0 + "," + y0 + "," + x1 + "," + y1;
                    if (rectCache.hasOwnProperty(cacheKey)) {
                        cacheHits++;
                        return rectCache[cacheKey];
                    }

                    var rw = x1 - x0;
                    var rh = y1 - y0;
                    var cx = (x0 + x1 - 1) / 2;
                    var cy = (y0 + y1 - 1) / 2;
                    pointProp.setValue([cx, cy]);
                    radiusProp.setValue([rw / 2, rh / 2]);

                    var avgAlpha = alphaProp.valueAtTime(time, false);
                    sampleCalls++;
                    stopIfRequested();
                    if (typeof avgAlpha !== "number" || isNaN(avgAlpha)) {
                        throw new Error("invalid alpha sample at time " + time);
                    }

                    // sampleImage returns average alpha. Average * sampled area is
                    // monotonic for nested rectangle searches; epsilon=0 therefore
                    // means any non-zero alpha in the rectangle counts as occupied.
                    var alphaSum = avgAlpha * rw * rh;
                    var result = alphaSum > alphaEpsilon;
                    rectCache[cacheKey] = result;
                    return result;
                },
                getStats: function () {
                    return {sampleCalls: sampleCalls, cacheHits: cacheHits};
                },
                dispose: function () {
                    rectCache = {};
                    try { tmpComp.remove(); } catch (e) {}
                }
            };
        } catch (err) {
            try { tmpComp.remove(); } catch (cleanupErr) {}
            throw err;
        }
    }

    function findFullBoundsAtTime(analyzer, width, height, time) {
        var left = findLeft(analyzer, time, 0, width - 1, 0, height);
        var right = findRight(analyzer, time, left, width - 1, 0, height);
        var top = findTop(analyzer, time, 0, height - 1, left, right + 1);
        var bottom = findBottom(analyzer, time, top, height - 1, left, right + 1);
        return {left: left, top: top, right: right, bottom: bottom};
    }

    function extendGlobalBoundsAtTime(analyzer, b, width, height, time) {
        if (b.left > 0 && analyzer.hasAlphaRect(time, 0, 0, b.left, height)) {
            b.left = findLeft(analyzer, time, 0, b.left - 1, 0, height);
        }

        if (b.right < width - 1 && analyzer.hasAlphaRect(time, b.right + 1, 0, width, height)) {
            b.right = findRight(analyzer, time, b.right + 1, width - 1, 0, height);
        }

        if (b.top > 0 && analyzer.hasAlphaRect(time, b.left, 0, b.right + 1, b.top)) {
            b.top = findTop(analyzer, time, 0, b.top - 1, b.left, b.right + 1);
        }

        if (b.bottom < height - 1 && analyzer.hasAlphaRect(time, b.left, b.bottom + 1, b.right + 1, height)) {
            b.bottom = findBottom(analyzer, time, b.bottom + 1, height - 1, b.left, b.right + 1);
        }
    }

    function findLeft(analyzer, time, lo, hi, y0, y1) {
        var rangeStart = lo;
        while (lo < hi) {
            var mid = Math.floor((lo + hi) / 2);
            if (analyzer.hasAlphaRect(time, rangeStart, y0, mid + 1, y1)) {
                hi = mid;
            } else {
                lo = mid + 1;
                rangeStart = lo;
            }
        }
        return lo;
    }

    function findRight(analyzer, time, lo, hi, y0, y1) {
        var rangeEnd = hi + 1;
        while (lo < hi) {
            var mid = Math.ceil((lo + hi) / 2);
            if (analyzer.hasAlphaRect(time, mid, y0, rangeEnd, y1)) {
                lo = mid;
            } else {
                hi = mid - 1;
                rangeEnd = hi + 1;
            }
        }
        return lo;
    }

    function findTop(analyzer, time, lo, hi, x0, x1) {
        var rangeStart = lo;
        while (lo < hi) {
            var mid = Math.floor((lo + hi) / 2);
            if (analyzer.hasAlphaRect(time, x0, rangeStart, x1, mid + 1)) {
                hi = mid;
            } else {
                lo = mid + 1;
                rangeStart = lo;
            }
        }
        return lo;
    }

    function findBottom(analyzer, time, lo, hi, x0, x1) {
        var rangeEnd = hi + 1;
        while (lo < hi) {
            var mid = Math.ceil((lo + hi) / 2);
            if (analyzer.hasAlphaRect(time, x0, mid, x1, rangeEnd)) {
                lo = mid;
            } else {
                hi = mid - 1;
                rangeEnd = hi + 1;
            }
        }
        return lo;
    }

    function buildScanPlan(comp, settings, usages) {
        var base = buildBaseScanPlan(comp, settings, usages);
        var candidateCount = base.times.length;
        var times = base.times;
        var staticOptimized = false;
        var visibilityOptimized = false;

        if (settings.autoStatic && times.length > 1) {
            var memo = (settings.runtime && settings.runtime.staticMemo) ? settings.runtime.staticMemo : {};
            var temporalInfo = analyzeCompTemporalClass(comp, memo, {});

            if (temporalInfo.mode === "static") {
                times = [times[0]];
                staticOptimized = true;
            } else if (temporalInfo.mode === "visibility") {
                var reduced = reduceTimesByVisibilityState(comp, times);
                if (reduced.length < times.length) {
                    times = reduced;
                    visibilityOptimized = true;
                }
            } else if (settings.dryRun) {
                base.notes.push("INFO temporal optimization not used: " + temporalInfo.reason + " for");
            }
        }

        return {
            times: times,
            candidateCount: candidateCount,
            staticOptimized: staticOptimized,
            visibilityOptimized: visibilityOptimized,
            label: base.label,
            notes: base.notes || []
        };
    }

    function buildBaseScanPlan(comp, settings, usages) {
        var notes = [];

        // In recursive + selected-usage mode, the selected parent frame range is
        // propagated down the actual nested-precomp graph before any crop occurs.
        // This avoids falling back to unrelated project usages for nested comps.
        var hasRecursiveTimePlan = settings.recursiveCrop && settings.runtime && settings.runtime.recursiveSelectedTimes &&
            (settings.scanMode === 2 || (settings.scanMode === 4 && settings.selectionMode === "project"));
        if (hasRecursiveTimePlan) {
            var recursiveTimes = settings.runtime.recursiveSelectedTimes[String(comp.id)];
            if (recursiveTimes && recursiveTimes.length > 0) {
                var recursiveNotes = settings.runtime.recursiveSelectedNotes[String(comp.id)] || [];
                for (var rn = 0; rn < recursiveNotes.length; rn++) notes.push(recursiveNotes[rn]);

                var useRecursiveTimes = true;
                if (settings.scanMode === 4) {
                    var recursiveMemo = (settings.runtime && settings.runtime.staticMemo) ? settings.runtime.staticMemo : {};
                    var recursiveTemporal = analyzeCompTemporalClass(comp, recursiveMemo, {});
                    if (recursiveTemporal.mode !== "static") {
                        useRecursiveTimes = false;
                        notes.push("INFO recursive current-time constraint was expanded for animated bounds safety because " + recursiveTemporal.reason + " for");
                    }
                }

                if (useRecursiveTimes) {
                    return {
                        times: recursiveTimes.slice(0),
                        label: settings.runtime.recursiveTimeLabel || "recursive branch",
                        notes: notes
                    };
                }
            }
        }

        if (settings.scanMode === 4) {
            // Current Frame remains fast for static/opacity-only animation, but
            // automatically expands to the full timeline when any other visual
            // animation could move or reshape non-zero pixels. This prevents the
            // default mode from clipping animated transform extremes.
            var currentMemo = (settings.runtime && settings.runtime.staticMemo) ? settings.runtime.staticMemo : {};
            var currentTemporal = analyzeCompTemporalClass(comp, currentMemo, {});
            if (currentTemporal.mode !== "static") {
                notes.push("INFO Current Frame auto-expanded to the entire source timeline because " + currentTemporal.reason + " for");
                return {
                    times: getTimelineTimes(comp, 0, comp.duration, 1),
                    label: "current frame auto-expanded (animated bounds safety)",
                    notes: notes
                };
            }
            return {
                times: [clamp(comp.time, 0, maxRenderableTime(comp))],
                label: "current frame",
                notes: notes
            };
        }

        if (settings.scanMode === 3) {
            var waStart = clamp(comp.workAreaStart, 0, comp.duration);
            var waEnd = clamp(comp.workAreaStart + comp.workAreaDuration, 0, comp.duration);
            return {
                times: getTimelineTimes(comp, waStart, waEnd, settings.frameStep),
                label: "work area",
                notes: notes
            };
        }

        if (settings.scanMode === 1 || settings.scanMode === 2) {
            var selectedOnly = settings.scanMode === 2;
            var relevant = [];
            var i;

            for (i = 0; i < usages.length; i++) {
                if (!selectedOnly || isSelectedUsage(comp, usages[i].layer, settings)) {
                    relevant.push(usages[i]);
                }
            }

            if (selectedOnly && relevant.length === 0) {
                // This is expected for nested comps in recursive mode: those layers
                // were not directly selected in the active composition. Fall back to
                // all project usages so recursive cropping remains safe.
                relevant = usages;
                notes.push("INFO selected-usage scan had no directly selected instance; fell back to all project usages for");
            }

            if (selectedOnly && relevant.length > 0 && relevant.length < usages.length) {
                notes.push("WARN selected-usage scan covers " + relevant.length + " of " + usages.length + " project usage(s); animation used only by other instances can be cropped for");
            }

            if (relevant.length > 0) {
                // An effect on a precomp usage can alter time sampling (Echo, Timewarp,
                // third-party temporal effects, etc.). In the project-wide mode we
                // prefer correctness and fall back to the full source timeline. The
                // selected-only mode remains explicitly user-scoped and reports the
                // general usage-effects warning from collectUsageData().
                if (!selectedOnly) {
                    for (i = 0; i < relevant.length; i++) {
                        if (hasEffects(relevant[i].layer)) {
                            notes.push("WARN a project usage has effects, which may alter temporal sampling; used-frame optimization was disabled and the entire source timeline was scanned for");
                            return {
                                times: getTimelineTimes(comp, 0, comp.duration, settings.frameStep),
                                label: "entire source (usage-effect safety fallback)",
                                notes: notes
                            };
                        }
                    }
                }

                var usedPlan = getUsedSourceTimes(comp, relevant, settings.frameStep);
                if (usedPlan.ok && usedPlan.times.length > 0) {
                    return {
                        times: usedPlan.times,
                        label: selectedOnly
                            ? "selected usage frames (" + relevant.length + " usage(s))"
                            : "all usage frames (" + relevant.length + " usage(s))",
                        notes: notes
                    };
                }

                if (!usedPlan.ok) {
                    notes.push("WARN usage-time mapping failed (" + usedPlan.reason + "); fell back to the entire source timeline for");
                } else {
                    notes.push("WARN usage-time scan produced no source samples; fell back to the entire source timeline for");
                }
            } else {
                notes.push("WARN no project usages were found; fell back to the entire source timeline for");
            }
        }

        return {
            times: getTimelineTimes(comp, 0, comp.duration, settings.frameStep),
            label: "entire source",
            notes: notes
        };
    }

    function getUsedSourceTimes(sourceComp, usages, frameStep) {
        var times = [];
        var seen = {};

        try {
            for (var i = 0; i < usages.length; i++) {
                var data = usages[i];
                var layer = data.layer;
                var parentComp = data.comp;

                var start = Math.max(0, layer.inPoint);
                var end = Math.min(parentComp.duration, layer.outPoint);
                if (end <= start) continue;

                var parentTimes = getTimelineTimes(parentComp, start, end, frameStep);
                var useFrameBlending = false;
                try { useFrameBlending = !!layer.frameBlending; } catch (fbErr) {}

                for (var j = 0; j < parentTimes.length; j++) {
                    var sourceTime = mapUsageTimeToSourceTime(layer, sourceComp, parentTimes[j]);
                    addUniqueTime(times, seen, sourceTime);

                    // Frame Mix / Pixel Motion may consult adjacent source frames.
                    // Including immediate neighbors is conservative for the common
                    // case and costs almost nothing after de-duplication.
                    if (useFrameBlending) {
                        addUniqueTime(times, seen, clamp(sourceTime - sourceComp.frameDuration, 0, maxRenderableTime(sourceComp)));
                        addUniqueTime(times, seen, clamp(sourceTime + sourceComp.frameDuration, 0, maxRenderableTime(sourceComp)));
                    }
                }
            }
        } catch (err) {
            return {ok: false, reason: errorToString(err), times: []};
        }

        times.sort(function (a, b) { return a - b; });
        return {ok: true, times: times};
    }

    function mapUsageTimeToSourceTime(layer, sourceComp, parentTime) {
        var sourceTime;
        var remapEnabled = false;
        try { remapEnabled = !!layer.timeRemapEnabled; } catch (e1) {}

        if (remapEnabled) {
            var remap = null;
            try { remap = layer.property("ADBE Time Remapping"); } catch (e2) {}
            if (!remap) throw new Error("Time Remap is enabled but its property is unavailable on " + layer.name);
            sourceTime = remap.valueAtTime(parentTime, false);
        } else {
            var stretch = layer.stretch;
            if (!stretch || Math.abs(stretch) < 0.0000001) {
                throw new Error("invalid layer stretch on " + layer.name);
            }
            sourceTime = (parentTime - layer.startTime) * (100.0 / stretch);
        }

        if (typeof sourceTime !== "number" || isNaN(sourceTime)) {
            throw new Error("invalid mapped source time on " + layer.name + " at " + parentTime);
        }

        return clamp(sourceTime, 0, maxRenderableTime(sourceComp));
    }

    function addUniqueTime(times, seen, t) {
        // A microsecond key is far finer than any practical AE frame interval,
        // while collapsing floating-point noise from stretch/time-remap math.
        var key = String(Math.round(t * 1000000));
        if (seen[key]) return;
        seen[key] = true;
        times.push(t);
    }

    function getTimelineTimes(comp, startTime, endTime, frameStep) {
        var fd = comp.frameDuration;
        var totalFrames = Math.max(1, Math.ceil((comp.duration / fd) - 0.0000001));
        var firstFrame = Math.max(0, Math.ceil((startTime / fd) - 0.0000001));
        var lastFrame = Math.min(totalFrames - 1, Math.ceil((endTime / fd) - 0.0000001) - 1);

        if (lastFrame < firstFrame) {
            var fallback = clamp(startTime, 0, maxRenderableTime(comp));
            return [fallback];
        }

        var times = [];
        var step = Math.max(1, frameStep);
        for (var f = firstFrame; f <= lastFrame; f += step) {
            times.push(f * fd);
        }

        // With a coarse step, still include the last actually requested frame.
        var lastTime = lastFrame * fd;
        if (times.length === 0 || Math.abs(times[times.length - 1] - lastTime) > 0.0000001) {
            times.push(lastTime);
        }

        return times;
    }

    function maxRenderableTime(comp) {
        if (comp.duration <= 0) return 0;
        return Math.max(0, comp.duration - 0.000001);
    }

    // Conservative temporal classification. False negatives only cost speed;
    // false positives could crop animated pixels away, so unknown layer types or
    // implicit temporal generators are classified as dynamic.
    //
    // mode = "static"     : rendered output is identical at every source time.
    // mode = "visibility" : layer content/transforms are static; only In/Out
    //                       visibility switches can change the rendered output.
    // mode = "dynamic"    : full requested frame sampling is required.
    function analyzeCompTemporalClass(comp, memo, visiting) {
        var key = String(comp.id);
        if (memo[key]) return memo[key];
        if (visiting[key]) return {mode: "dynamic", reason: "recursive dependency"};
        visiting[key] = true;

        var hasVisibilityChanges = false;

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);

            // Disabled/null/guide layers cannot affect the nested render, except
            // track mattes, which are intentionally retained by this predicate.
            if (!layerCanContributePixels(layer)) continue;

            if (hasEffects(layer)) {
                visiting[key] = false;
                memo[key] = {mode: "dynamic", reason: "effects present on " + layer.name};
                return memo[key];
            }

            if (hasEssentialProperties(layer)) {
                visiting[key] = false;
                memo[key] = {mode: "dynamic", reason: "Essential Properties present on " + layer.name};
                return memo[key];
            }

            var timeVaryingPath = findFirstVisualTimeVaryingProperty(layer, layer.name);
            if (timeVaryingPath) {
                visiting[key] = false;
                memo[key] = {mode: "dynamic", reason: "time-varying property: " + timeVaryingPath};
                return memo[key];
            }

            var source = null;
            try { source = layer.source; } catch (e1) {}

            if (source && (source instanceof CompItem)) {
                var nested = analyzeCompTemporalClass(source, memo, visiting);
                // A nested comp whose own visibility changes with source time is
                // not static from the parent's perspective unless we also map the
                // child's event times through this layer. That optimization is
                // deliberately deferred; classify it as dynamic for correctness.
                if (nested.mode !== "static") {
                    visiting[key] = false;
                    memo[key] = {mode: "dynamic", reason: "nested comp is not time-invariant: " + source.name + " (" + nested.reason + ")"};
                    return memo[key];
                }
            } else if (source && (source instanceof FootageItem)) {
                if (!footageIsStill(source)) {
                    visiting[key] = false;
                    memo[key] = {mode: "dynamic", reason: "time-based footage: " + layer.name};
                    return memo[key];
                }
            } else if (isTextLayerObject(layer)) {
                var textSafety = inspectStaticTextLayer(layer);
                if (!textSafety.ok) {
                    visiting[key] = false;
                    memo[key] = {mode: "dynamic", reason: textSafety.reason};
                    return memo[key];
                }
            } else if (isShapeLayerObject(layer)) {
                var shapeSafety = inspectStaticShapeLayer(layer);
                if (!shapeSafety.ok) {
                    visiting[key] = false;
                    memo[key] = {mode: "dynamic", reason: shapeSafety.reason};
                    return memo[key];
                }
            } else {
                visiting[key] = false;
                memo[key] = {mode: "dynamic", reason: "unclassified visual layer type: " + layer.name};
                return memo[key];
            }

            // In/Out changes are special: if everything else is static, the
            // rendered image can only change when the active layer set changes.
            if (layer.inPoint > 0.0000001 || layer.outPoint < comp.duration - 0.0000001) {
                hasVisibilityChanges = true;
            }
        }

        visiting[key] = false;
        if (hasVisibilityChanges) {
            memo[key] = {mode: "visibility", reason: "only layer In/Out visibility changes"};
        } else {
            memo[key] = {mode: "static", reason: "time-invariant rendered content"};
        }
        return memo[key];
    }

    function isCompProvablyStatic(comp, memo, visiting) {
        var info = analyzeCompTemporalClass(comp, memo, visiting);
        return {isStatic: info.mode === "static", reason: info.reason};
    }

    function reduceTimesByVisibilityState(comp, times) {
        if (!times || times.length <= 1) return times || [];

        var contributing = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (layerCanContributePixels(layer)) contributing.push(layer);
        }

        if (contributing.length === 0) return [times[0]];

        var reduced = [];
        var seenStates = {};
        for (var t = 0; t < times.length; t++) {
            var tm = times[t];
            var sig = "";
            for (var l = 0; l < contributing.length; l++) {
                sig += isLayerActiveAtTime(contributing[l], tm) ? "1" : "0";
            }
            if (!seenStates[sig]) {
                seenStates[sig] = true;
                reduced.push(tm);
            }
        }

        return reduced;
    }

    function isTextLayerObject(layer) {
        try { if (layer instanceof TextLayer) return true; } catch (e1) {}
        try { return !!layer.property("ADBE Text Properties"); } catch (e2) {}
        return false;
    }

    function isShapeLayerObject(layer) {
        try { if (layer instanceof ShapeLayer) return true; } catch (e1) {}
        try { return !!layer.property("ADBE Root Vectors Group"); } catch (e2) {}
        return false;
    }

    function inspectStaticTextLayer(layer) {
        try {
            var textProps = layer.property("ADBE Text Properties");
            if (!textProps) return {ok: false, reason: "text properties unavailable: " + layer.name};

            // Plain static text is safe. Text Animators are intentionally treated
            // as unknown even when their exposed numeric properties are static,
            // because Wiggly/Expression selectors can evolve implicitly over time.
            var animators = textProps.property("ADBE Text Animators");
            if (animators && animators.numProperties > 0) {
                return {ok: false, reason: "Text Animator present: " + layer.name};
            }
            return {ok: true};
        } catch (e) {
            return {ok: false, reason: "could not inspect text layer: " + layer.name};
        }
    }

    function inspectStaticShapeLayer(layer) {
        try {
            var root = layer.property("ADBE Root Vectors Group");
            if (!root) return {ok: false, reason: "shape contents unavailable: " + layer.name};
            var unsafe = findImplicitTemporalShapeOperator(root, layer.name);
            if (unsafe) return {ok: false, reason: "implicit temporal shape operator: " + unsafe};
            return {ok: true};
        } catch (e) {
            return {ok: false, reason: "could not inspect shape layer: " + layer.name};
        }
    }

    function findImplicitTemporalShapeOperator(group, path) {
        if (!group || !group.numProperties) return null;

        for (var i = 1; i <= group.numProperties; i++) {
            var p;
            try { p = group.property(i); } catch (e1) { continue; }
            if (!p) continue;

            var matchName = "";
            var name = "";
            try { matchName = p.matchName || ""; } catch (e2) {}
            try { name = p.name || ""; } catch (e3) {}
            var childPath = path + " / " + name;

            // Wiggle Paths / Wiggle Transform are the main built-in vector
            // operators with implicit temporal behavior. Unknown expressions are
            // already rejected by isTimeVarying before this function is called.
            if (/wiggl/i.test(matchName) || /wiggl/i.test(name)) return childPath;

            try {
                if (p.propertyType !== PropertyType.PROPERTY) {
                    var hit = findImplicitTemporalShapeOperator(p, childPath);
                    if (hit) return hit;
                }
            } catch (e4) {}
        }

        return null;
    }

    function layerCanContributePixels(layer) {
        var isMatte = false;
        try { isMatte = !!layer.isTrackMatte; } catch (e0) {}

        // Track-matte layers can affect the final alpha even when their own video
        // switch is off, so they must remain part of the static proof.
        try { if (!layer.enabled && !isMatte) return false; } catch (e1) {}
        try { if (layer.nullLayer) return false; } catch (e2) {}
        try { if (layer.guideLayer && !isMatte) return false; } catch (e3) {}
        try { if (!layer.hasVideo && !isMatte) return false; } catch (e4) {}
        return true;
    }

    function footageIsStill(item) {
        try {
            if (item.useProxy && item.proxySource) return !!item.proxySource.isStill;
        } catch (e1) {}
        try { return !!item.mainSource.isStill; } catch (e2) {}
        return false;
    }

    function findFirstVisualTimeVaryingProperty(group, path) {
        if (!group || !group.numProperties) return null;

        for (var i = 1; i <= group.numProperties; i++) {
            var p;
            try { p = group.property(i); } catch (e1) { continue; }
            if (!p) continue;

            var matchName = "";
            try { matchName = p.matchName || ""; } catch (e2) {}

            // Markers, audio and motion-tracker metadata do not affect alpha.
            if (matchName === "ADBE Marker" ||
                matchName === "ADBE Audio Group" ||
                matchName === "ADBE MTrackers" ||
                matchName === "ADBE Opacity") {
                continue;
            }

            var childPath = path + " / " + p.name;
            try {
                if (p.propertyType === PropertyType.PROPERTY) {
                    if (p.isTimeVarying) return childPath;
                } else {
                    var hit = findFirstVisualTimeVaryingProperty(p, childPath);
                    if (hit) return hit;
                }
            } catch (e3) {}
        }

        return null;
    }

    function estimateTotalFrames(comps, settings) {
        var n = 0;
        var memo = (settings.runtime && settings.runtime.staticMemo) ? settings.runtime.staticMemo : {};

        for (var i = 0; i < comps.length; i++) {
            try {
                var temporal = settings.autoStatic ? analyzeCompTemporalClass(comps[i], memo, {}) : {mode: "dynamic"};
                if (temporal.mode === "static") {
                    n += 1;
                } else if (settings.scanMode === 4) {
                    var autoExpandedTimes = getTimelineTimes(comps[i], 0, comps[i].duration, 1);
                    n += temporal.mode === "visibility" ? reduceTimesByVisibilityState(comps[i], autoExpandedTimes).length : autoExpandedTimes.length;
                } else if (settings.scanMode === 3) {
                    var workTimes = getTimelineTimes(
                        comps[i],
                        comps[i].workAreaStart,
                        comps[i].workAreaStart + comps[i].workAreaDuration,
                        settings.frameStep
                    );
                    n += temporal.mode === "visibility" ? reduceTimesByVisibilityState(comps[i], workTimes).length : workTimes.length;
                } else if (settings.scanMode === 2 && settings.recursiveCrop && settings.runtime && settings.runtime.recursiveSelectedTimes && settings.runtime.recursiveSelectedTimes[String(comps[i].id)]) {
                    var recursiveTimes = settings.runtime.recursiveSelectedTimes[String(comps[i].id)];
                    n += temporal.mode === "visibility" ? reduceTimesByVisibilityState(comps[i], recursiveTimes).length : recursiveTimes.length;
                } else {
                    // Project-wide used-frame mode is known only after usage safety
                    // collection; full source duration remains a safe estimate.
                    var fullTimes = getTimelineTimes(comps[i], 0, comps[i].duration, settings.frameStep);
                    n += temporal.mode === "visibility" ? reduceTimesByVisibilityState(comps[i], fullTimes).length : fullTimes.length;
                }
            } catch (e) {
                n++;
            }
        }
        return Math.max(1, n);
    }

    // -------------------------------------------------------------------------
    // Property capture / shifting
    // -------------------------------------------------------------------------

    function getTransformProperty(layer, matchName) {
        var transform = layer.property("ADBE Transform Group");
        if (!transform) return null;
        return transform.property(matchName);
    }

    function canShiftPointProperty(prop) {
        if (!prop) return false;

        try {
            if (prop.dimensionsSeparated) {
                var x = prop.getSeparationFollower(0);
                var y = prop.getSeparationFollower(1);
                if (!x || !y) return false;
                if (x.expressionEnabled || y.expressionEnabled) return false;
                return true;
            }
        } catch (e) {}

        try {
            if (prop.expressionEnabled) return false;
        } catch (e2) {}

        return true;
    }

    function capturePointProperty(prop) {
        var state = {separated: false};

        if (prop.dimensionsSeparated) {
            state.separated = true;
            state.x = captureScalarProperty(prop.getSeparationFollower(0));
            state.y = captureScalarProperty(prop.getSeparationFollower(1));
            try {
                state.z = captureScalarProperty(prop.getSeparationFollower(2));
            } catch (e) {
                state.z = null;
            }
            return state;
        }

        state.numKeys = prop.numKeys || 0;
        state.values = [];
        if (state.numKeys > 0) {
            for (var i = 1; i <= state.numKeys; i++) {
                state.values.push(cloneValue(prop.keyValue(i)));
            }
        } else {
            state.value = cloneValue(prop.value);
        }
        return state;
    }

    function captureScalarProperty(prop) {
        if (!prop) return null;
        var s = {numKeys: prop.numKeys || 0, values: []};
        if (s.numKeys > 0) {
            for (var i = 1; i <= s.numKeys; i++) s.values.push(prop.keyValue(i));
        } else {
            s.value = prop.value;
        }
        return s;
    }

    function shiftPointProperty(prop, dx, dy) {
        if (prop.dimensionsSeparated) {
            shiftScalarProperty(prop.getSeparationFollower(0), dx);
            shiftScalarProperty(prop.getSeparationFollower(1), dy);
            return;
        }

        var n = prop.numKeys || 0;
        if (n > 0) {
            for (var i = 1; i <= n; i++) {
                var v = prop.keyValue(i);
                prop.setValueAtKey(i, addXY(v, dx, dy));
            }
        } else {
            prop.setValue(addXY(prop.value, dx, dy));
        }
    }

    function shiftScalarProperty(prop, delta) {
        if (!prop) return;
        var n = prop.numKeys || 0;
        if (n > 0) {
            for (var i = 1; i <= n; i++) {
                prop.setValueAtKey(i, prop.keyValue(i) + delta);
            }
        } else {
            prop.setValue(prop.value + delta);
        }
    }

    function applyCapturedPointShift(prop, state, dx, dy) {
        if (state.separated) {
            applyCapturedScalarShift(prop.getSeparationFollower(0), state.x, dx);
            applyCapturedScalarShift(prop.getSeparationFollower(1), state.y, dy);
            if (state.z) {
                try { applyCapturedScalarShift(prop.getSeparationFollower(2), state.z, 0); } catch (e) {}
            }
            return;
        }

        if (state.numKeys > 0) {
            for (var i = 1; i <= state.numKeys; i++) {
                prop.setValueAtKey(i, addXY(state.values[i - 1], dx, dy));
            }
        } else {
            prop.setValue(addXY(state.value, dx, dy));
        }
    }

    function applyCapturedScalarShift(prop, state, delta) {
        if (!prop || !state) return;
        if (state.numKeys > 0) {
            for (var i = 1; i <= state.numKeys; i++) {
                prop.setValueAtKey(i, state.values[i - 1] + delta);
            }
        } else {
            prop.setValue(state.value + delta);
        }
    }

    function addXY(v, dx, dy) {
        if (v instanceof Array) {
            if (v.length > 2) return [v[0] + dx, v[1] + dy, v[2]];
            return [v[0] + dx, v[1] + dy];
        }
        return v;
    }

    function cloneValue(v) {
        if (v instanceof Array) {
            var out = [];
            for (var i = 0; i < v.length; i++) out.push(v[i]);
            return out;
        }
        return v;
    }

    function withLayerUnlocked(layer, fn) {
        var wasLocked = false;
        try { wasLocked = layer.locked; } catch (e) {}
        try {
            if (wasLocked) layer.locked = false;
            fn();
        } finally {
            try { if (wasLocked) layer.locked = true; } catch (e2) {}
        }
    }

    // -------------------------------------------------------------------------
    // Usage masks
    // -------------------------------------------------------------------------

    function captureUsageMasks(layer) {
        var masks = [];
        var group = layer.property("ADBE Mask Parade");
        if (!group || group.numProperties === 0) return {ok: true, masks: masks};

        for (var i = 1; i <= group.numProperties; i++) {
            var mask = group.property(i);
            var path = mask.property("ADBE Mask Shape");
            if (!path) continue;
            if (path.expressionEnabled) return {ok: false};

            var state = {path: path, numKeys: path.numKeys || 0, values: []};
            if (state.numKeys > 0) {
                for (var k = 1; k <= state.numKeys; k++) {
                    state.values.push(path.keyValue(k));
                }
            } else {
                state.value = path.value;
            }
            masks.push(state);
        }

        return {ok: true, masks: masks};
    }

    function applyCapturedMaskShift(masks, dx, dy) {
        for (var i = 0; i < masks.length; i++) {
            var m = masks[i];
            if (m.numKeys > 0) {
                for (var k = 1; k <= m.numKeys; k++) {
                    m.path.setValueAtKey(k, shiftedShape(m.values[k - 1], dx, dy));
                }
            } else {
                m.path.setValue(shiftedShape(m.value, dx, dy));
            }
        }
    }

    function shiftedShape(shape, dx, dy) {
        var vertices = shape.vertices;
        var moved = [];
        for (var i = 0; i < vertices.length; i++) {
            moved.push([vertices[i][0] + dx, vertices[i][1] + dy]);
        }
        shape.vertices = moved;
        return shape;
    }

    // -------------------------------------------------------------------------
    // Warnings / misc
    // -------------------------------------------------------------------------

    function hasEffects(layer) {
        var fx = layer.property("ADBE Effect Parade");
        return !!(fx && fx.numProperties > 0);
    }

    function hasEssentialProperties(layer) {
        try {
            var ep = layer.property("ADBE Layer Overrides");
            return !!(ep && ep.numProperties > 0);
        } catch (e) {
            return false;
        }
    }

    function findDimensionDependentExpressions(comp) {
        var hits = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            scanPropertyGroupForDimensionExpressions(comp.layer(i), comp.layer(i).name, hits);
        }
        return hits;
    }

    function scanPropertyGroupForDimensionExpressions(group, path, hits) {
        if (!group || !group.numProperties) return;

        for (var i = 1; i <= group.numProperties; i++) {
            var p;
            try { p = group.property(i); } catch (e) { continue; }
            if (!p) continue;

            var childPath = path + " / " + p.name;

            try {
                if (p.propertyType === PropertyType.PROPERTY) {
                    if (p.expressionEnabled) {
                        var ex = p.expression || "";
                        if (/(thisComp\s*\.\s*(width|height)|thisLayer\s*\.\s*(width|height)|source\s*\.\s*(width|height)|sourceRectAtTime\s*\()/i.test(ex)) {
                            hits.push(childPath);
                        }
                    }
                } else {
                    scanPropertyGroupForDimensionExpressions(p, childPath, hits);
                }
            } catch (e2) {}
        }
    }

    function isCameraOrLight(layer) {
        try {
            if (layer instanceof CameraLayer) return true;
        } catch (e1) {}
        try {
            if (layer instanceof LightLayer) return true;
        } catch (e2) {}
        return false;
    }

    function clamp(v, a, b) {
        return Math.max(a, Math.min(b, v));
    }

    function errorToString(err) {
        var s = "";
        try { s += err.toString(); } catch (e) { s += "Unknown error"; }
        try {
            if (err.line) s += " (line " + err.line + ")";
        } catch (e2) {}
        return s;
    }

    showMainWindow();

})(this);
