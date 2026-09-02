// CSRF protection (Flask-WTF): every state-changing fetch() call below needs
// the per-session token attached as a header, since these are JSON API
// calls rather than native form submissions. Patching fetch() once here
// means the ~20 call sites throughout this file don't each need to
// remember to add it themselves.
(() => {
    const token = document.querySelector('meta[name="csrf-token"]')?.content || "";
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
        const method = (init.method || "GET").toUpperCase();
        if (method === "GET" || method === "HEAD") return nativeFetch(input, init);
        return nativeFetch(input, {
            ...init,
            headers: { ...(init.headers || {}), "X-CSRFToken": token },
        });
    };
})();

const MIN_GAP_HOURS = 0.5;
const REFRESH_INTERVAL_SECONDS = 300;
// Deliberately excludes the widgets' primary line colors (#2f7a4f green for
// USGS, #1f6f8b teal for NYISO) so an added site never matches the primary.
const EXTRA_SERIES_COLORS = [
    "#e07a1f",
    "#7a3fa0",
    "#b3261e",
    "#c9a227",
    "#d6408c",
    "#444444",
];

// Wires the decorative overlay (see .entry-input-hint in style.css) that
// stands in for a search box's native `placeholder` attribute, so the hint
// text can slide back and forth when it's too wide for the box — a real
// `placeholder` can't be animated. Keyed by input id so callers elsewhere
// (e.g. applying a saved site) can retarget an input's hint by id.
const HINT_SLIDE_PX_PER_SECOND = 40;
const hintControllers = {};

function initSlidingHint(input) {
    const wrap = input.closest(".entry-input-wrap");
    const hint = wrap.querySelector(".entry-input-hint");
    const hintText = wrap.querySelector(".entry-input-hint-text");

    function measure() {
        hintText.classList.remove("sliding");
        hintText.style.removeProperty("--slide-distance");
        hintText.style.removeProperty("animation-duration");

        // Measured via rendered rects rather than scrollWidth/clientWidth:
        // the text starts inset by the container's left padding, so a
        // clientWidth-based diff undercounts overflow by that padding and
        // the animation stops just short of the final character(s).
        const overflow = hintText.getBoundingClientRect().right - hint.getBoundingClientRect().right;
        if (overflow > 2) {
            const distance = -(overflow + 4);
            hintText.style.setProperty("--slide-distance", `${distance}px`);
            hintText.style.animationDuration = `${Math.max(3, Math.abs(distance) / HINT_SLIDE_PX_PER_SECOND)}s`;
            hintText.classList.add("sliding");
        }
    }

    function updateVisibility() {
        hint.classList.toggle("entry-input-hint-hidden", input.value.trim() !== "");
    }

    function setText(text) {
        hintText.textContent = text;
        measure();
        updateVisibility();
    }

    input.addEventListener("input", updateVisibility);
    window.addEventListener("resize", measure);

    const controller = { setText, sync: updateVisibility };
    hintControllers[input.id] = controller;
    return controller;
}

// Wires the per-panel "Auto-scale" / "Full range" Y-axis toggle. Auto-scale
// is Chart.js's default tight-fit behavior (left as-is); full range just
// forces the axis to include zero (via beginAtZero) so the chart can't make
// small fluctuations look dramatic without any indication it's zoomed in.
// The choice is remembered per panel type across reloads via localStorage.
function initScaleToggle(root, panelType, onChange) {
    const btn = root.querySelector(".scale-toggle-btn");
    const storageKey = `yScaleMode:${panelType}`;
    let mode = localStorage.getItem(storageKey) === "full" ? "full" : "auto";

    function render() {
        const isFull = mode === "full";
        btn.textContent = isFull ? "Full range" : "Auto-scale";
        btn.setAttribute("aria-pressed", String(isFull));
    }

    btn.addEventListener("click", () => {
        mode = mode === "full" ? "auto" : "full";
        localStorage.setItem(storageKey, mode);
        render();
        onChange();
    });

    render();

    return { get mode() { return mode; } };
}

// Skeleton loading state shared by all three panels. A request lifecycle
// moves through three visual states:
//   "loading" — shimmering placeholders in place of title/legend/chart
//   "timeout" — request has been in flight past LOADING_TIMEOUT_MS; the
//               shimmer is swapped for a plain "still fetching" message so
//               a slow response doesn't look identical to a frozen page
//   "loaded"  — real title/chart shown, controls re-enabled
// The range slider and download controls stay visible the whole time (never
// hidden) so the panel's height never jumps once loading resolves — they're
// just dimmed/disabled while state isn't "loaded".
const LOADING_TIMEOUT_MS = 9000;

function initLoadingState(root, serviceLabel) {
    const chartContainer = root.querySelector(".chart-container");
    const chartTitleId = root.querySelector(".chart-title-id");
    const chartTitleRange = root.querySelector(".chart-title-range");
    const chartSkeleton = root.querySelector(".chart-skeleton");
    const chartCanvasWrap = root.querySelector(".chart-canvas-wrap");
    const loadingMessage = root.querySelector(".loading-message");
    const rangeStart = root.querySelector(".range-start");
    const rangeEnd = root.querySelector(".range-end");
    const downloadFormat = root.querySelector(".download-format");
    const downloadBtn = root.querySelector(".download-btn");
    const rangeSliderContainer = root.querySelector(".range-slider-container");
    const downloadContainer = root.querySelector(".download-container");

    loadingMessage.textContent = `Still fetching from ${serviceLabel}… this can take a moment.`;

    let timeoutTimer = null;

    function setState(state) {
        chartContainer.hidden = false;
        root.classList.add("has-chart");

        const loading = state === "loading";
        const timedOut = state === "timeout";
        const loaded = state === "loaded";

        chartTitleId.classList.toggle("is-skeleton", loading || timedOut);
        chartTitleRange.classList.toggle("is-skeleton", loading || timedOut);
        chartSkeleton.hidden = !loading;
        loadingMessage.hidden = !timedOut;
        chartCanvasWrap.hidden = !loaded;

        const disable = !loaded;
        rangeStart.disabled = disable;
        rangeEnd.disabled = disable;
        downloadFormat.disabled = disable;
        downloadBtn.disabled = disable;
        rangeSliderContainer.classList.toggle("is-disabled", disable);
        downloadContainer.classList.toggle("is-disabled", disable);
    }

    function startLoading() {
        clearTimeout(timeoutTimer);
        setState("loading");
        timeoutTimer = setTimeout(() => setState("timeout"), LOADING_TIMEOUT_MS);
    }

    function finishLoading() {
        clearTimeout(timeoutTimer);
        setState("loaded");
    }

    // Only for the case where this id has never successfully loaded before
    // (first attempt fails) — collapses the panel back to its pre-request
    // look instead of leaving an empty "loaded" shell showing.
    function collapseAfterFailedFirstLoad() {
        chartContainer.hidden = true;
        root.classList.remove("has-chart");
    }

    return { startLoading, finishLoading, collapseAfterFailedFirstLoad };
}

const toastEl = document.getElementById("toast");
let toastTimer = null;

function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toastEl.classList.remove("visible");
    }, 4000);
}

function formatCountdown(seconds) {
    const clamped = Math.max(0, seconds);
    const m = Math.floor(clamped / 60);
    const s = clamped % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}

// Draws a vertical guide line from the hovered point down to the x-axis,
// like a crosshair. Registered once, applies to every chart on the page.
const crosshairPlugin = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
        const active = chart.tooltip && chart.tooltip._active;
        if (!active || !active.length) return;

        const { ctx, chartArea } = chart;
        const x = active[0].element.x;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(90, 90, 90, 0.5)";
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
    },
};

Chart.register(crosshairPlugin);

function csvEscape(value) {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function xmlEscape(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

// One consistent "Mon DD, H:MM AM/PM" format for every date/time label across
// all three panels — slider range labels, chart title captions, and download
// filenames alike — so USGS/NYISO (single-day) and the NOAA forecast
// (multi-day) never disagree on style the way "12:00 AM" vs "Aug 27, 6:00 PM"
// used to.
function formatDateTime(ms) {
    return new Date(ms).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

function formatTimeOnly(ms) {
    return new Date(ms).toLocaleString([], { hour: "numeric", minute: "2-digit" });
}

// Formats a [startMs, endMs] range for display. When both ends land on the
// same calendar day, the end label omits the repeated date rather than
// special-casing any phrasing (e.g. no one-off "Midnight (end of day)").
function formatRange(startMs, endMs) {
    const sameDay = new Date(startMs).toDateString() === new Date(endMs).toDateString();
    return {
        start: formatDateTime(startMs),
        end: sameDay ? formatTimeOnly(endMs) : formatDateTime(endMs),
    };
}

// How stale the power forecast panel's newest timestamp can get before it's
// flagged (see the FORECAST badge tooltip): NWM forecast issuance ~hourly,
// with a 2x buffer so normal jitter in the source's own publishing doesn't
// false-flag.
const REACH_STALE_MS = 2 * 60 * 60 * 1000;

// Builds the "Forecast issued: ..." caption shown under the power forecast
// chart's title, so a glance answers "as of when is this data" without
// doing date math against the axis. Returns null when there's nothing
// loaded yet (caller should just clear/hide the caption).
function freshnessLabel(prefix, latestMs, staleThresholdMs) {
    if (latestMs == null) return null;
    return {
        text: `${prefix} ${formatDateTime(latestMs)}`,
        isStale: Date.now() - latestMs > staleThresholdMs,
    };
}

function applyFreshnessLabel(el, label) {
    if (!el) return;
    if (!label) {
        el.textContent = "";
        el.classList.remove("is-stale");
        return;
    }
    el.textContent = label.text;
    el.classList.toggle("is-stale", label.isStale);
}

/**
 * A single shared modal that any widget's "Expand" button can borrow. Rather
 * than the native Fullscreen API (which looked jarring and left the chart
 * mis-sized after collapsing), this physically moves the chart's own
 * .chart-container — canvas, slider, download controls and all — into a
 * centered popup, then moves it right back to its original spot on close.
 */
const chartModal = {
    backdrop: document.getElementById("chart-modal-backdrop"),
    panel: document.getElementById("chart-modal-panel"),
    closeBtn: document.getElementById("chart-modal-close"),
    placeholder: null,
    activeGetChartInstance: null,
};

function closeChartModal() {
    if (!chartModal.placeholder) return;

    const chartContainer = chartModal.panel.querySelector(".chart-container");
    const getChartInstance = chartModal.activeGetChartInstance;

    if (chartContainer) {
        chartModal.placeholder.parentNode.replaceChild(chartContainer, chartModal.placeholder);
        chartContainer.classList.remove("is-expanded");
    } else {
        chartModal.placeholder.remove();
    }

    chartModal.placeholder = null;
    chartModal.activeGetChartInstance = null;
    chartModal.backdrop.hidden = true;
    document.body.style.overflow = "";

    setTimeout(() => {
        const chart = getChartInstance && getChartInstance();
        if (chart) chart.resize();
    }, 50);
}

function openChartModal(chartContainer, getChartInstance) {
    if (chartModal.placeholder) {
        closeChartModal();
    }

    chartModal.placeholder = document.createComment("chart-placeholder");
    chartContainer.parentNode.insertBefore(chartModal.placeholder, chartContainer);
    chartModal.panel.appendChild(chartContainer);
    chartContainer.classList.add("is-expanded");
    chartModal.activeGetChartInstance = getChartInstance;
    chartModal.backdrop.hidden = false;
    document.body.style.overflow = "hidden";

    setTimeout(() => {
        const chart = getChartInstance();
        if (chart) chart.resize();
    }, 50);
}

chartModal.closeBtn.addEventListener("click", closeChartModal);
chartModal.backdrop.addEventListener("click", (event) => {
    if (event.target === chartModal.backdrop) closeChartModal();
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeChartModal();
});

function wireExpandButton(root, chartContainer, getChartInstance) {
    const expandBtn = root.querySelector(".expand-btn");
    if (!expandBtn) return;

    expandBtn.addEventListener("click", () => openChartModal(chartContainer, getChartInstance));
}

/**
 * Wires up one self-contained "gauge/PTID lookup + chart + slider + download"
 * widget inside `root`. USGS streamflow and NYISO LBMP each get an instance
 * with different endpoints/columns but identical UI behavior.
 */
function createWidget(root, config) {
    const input = root.querySelector(".entry-input");
    const hint = initSlidingHint(input);
    hint.setText(input.getAttribute("placeholder") || "");
    const loadingState = initLoadingState(root, config.serviceLabel);
    const form = root.querySelector(".entry-form");
    const pinBtn = root.querySelector(".pin-icon-btn");
    const statusEl = root.querySelector(".status");
    const submitBtn = form.querySelector("button[type=submit]");
    const addSiteBtn = root.querySelector(".add-site-btn");
    const pinnedChips = root.querySelector(".pinned-chips");
    const chartContainer = root.querySelector(".chart-container");
    const chartTitleId = root.querySelector(".chart-title-id");
    const chartTitleRange = root.querySelector(".chart-title-range");
    const chartCanvas = root.querySelector(".readings-chart");
    const extraSeriesChips = root.querySelector(".extra-series-chips");
    const rangeStart = root.querySelector(".range-start");
    const rangeEnd = root.querySelector(".range-end");
    const rangeStartLabel = root.querySelector(".range-start-label");
    const rangeEndLabel = root.querySelector(".range-end-label");
    const downloadBtn = root.querySelector(".download-btn");
    const downloadFormat = root.querySelector(".download-format");
    const alertBanner = root.querySelector(".alert-banner");

    let chartInstance = null;
    let currentId = null;
    let currentReadings = [];
    let dayStartMs = null;
    let filteredReadings = [];
    let extraSeries = []; // [{ id, readings }] — additional lines added via "+ Add site"
    let currentThreshold = null;
    const dataChangeListeners = []; // notified whenever loadChart() resolves, success or empty
    const loadStartListeners = []; // notified when a fetch begins, ahead of dataChangeListeners

    function notifyDataChange() {
        dataChangeListeners.forEach((fn) => fn());
    }

    function notifyLoadStart() {
        loadStartListeners.forEach((fn) => fn());
    }

    function getPinned() {
        try {
            return JSON.parse(localStorage.getItem(config.storageKey)) || [];
        } catch {
            return [];
        }
    }

    function savePinned(ids) {
        localStorage.setItem(config.storageKey, JSON.stringify(ids));
    }

    function renderPinnedChips() {
        const ids = getPinned();
        pinnedChips.innerHTML = "";

        ids.forEach((id) => {
            const chip = document.createElement("span");
            chip.className = "chip";

            const label = document.createElement("span");
            label.textContent = id;
            chip.appendChild(label);

            const remove = document.createElement("span");
            remove.className = "remove";
            remove.textContent = "×";
            remove.title = "Unpin";
            remove.addEventListener("click", (event) => {
                event.stopPropagation();
                savePinned(getPinned().filter((g) => g !== id));
                renderPinnedChips();
            });
            chip.appendChild(remove);

            chip.addEventListener("click", () => {
                input.value = id;
                hint.sync();
                form.requestSubmit();
            });

            pinnedChips.appendChild(chip);
        });
    }

    function pinId(id) {
        const ids = getPinned();
        if (!ids.includes(id)) {
            ids.push(id);
            savePinned(ids);
            renderPinnedChips();
        }
    }

    async function loadThreshold(id) {
        const response = await fetch(
            `/api/alerts?panel_type=${config.panelType}&external_id=${encodeURIComponent(id)}`
        );
        currentThreshold = response.ok ? (await response.json()).threshold : null;
    }

    function evaluateAlert() {
        if (!currentThreshold || !currentReadings.length) {
            alertBanner.hidden = true;
            return;
        }

        const latest = currentReadings[currentReadings.length - 1];
        const value = latest[config.valueField];
        if (value === null || value === undefined) {
            alertBanner.hidden = true;
            return;
        }

        const { direction, threshold_value: thresholdValue } = currentThreshold;
        const triggered = direction === "above" ? value > thresholdValue : value < thresholdValue;

        alertBanner.hidden = !triggered;
        if (triggered) {
            alertBanner.textContent =
                `⚠ ${config.entityLabel} ${currentId}: latest ${config.valueLabel} is ${value}, ` +
                `${direction} your alert threshold of ${thresholdValue}.`;
        }
    }

    function renderExtraSeriesChips() {
        extraSeriesChips.innerHTML = "";

        extraSeries.forEach((series, index) => {
            const chip = document.createElement("span");
            chip.className = "chip";
            chip.style.borderLeft = `4px solid ${EXTRA_SERIES_COLORS[index % EXTRA_SERIES_COLORS.length]}`;

            const label = document.createElement("span");
            label.textContent = series.id;
            chip.appendChild(label);

            const remove = document.createElement("span");
            remove.className = "remove";
            remove.textContent = "×";
            remove.title = `Remove ${series.id} from chart`;
            remove.addEventListener("click", () => {
                extraSeries = extraSeries.filter((s) => s.id !== series.id);
                renderExtraSeriesChips();
                renderChart();
            });
            chip.appendChild(remove);

            extraSeriesChips.appendChild(chip);
        });
    }

    function getSliderHours() {
        let start = parseFloat(rangeStart.value);
        let end = parseFloat(rangeEnd.value);

        if (start > end - MIN_GAP_HOURS) {
            if (document.activeElement === rangeStart) {
                start = end - MIN_GAP_HOURS;
                rangeStart.value = start;
            } else {
                end = start + MIN_GAP_HOURS;
                rangeEnd.value = end;
            }
        }

        return { start, end };
    }

    function renderChart() {
        const { start, end } = getSliderHours();

        const startBoundary = dayStartMs + start * 3600000;
        const endBoundary = dayStartMs + end * 3600000;
        const rangeLabels = formatRange(startBoundary, endBoundary);
        rangeStartLabel.textContent = rangeLabels.start;
        rangeEndLabel.textContent = rangeLabels.end;

        const inRange = (r) => {
            const t = new Date(r.datetime).getTime();
            return t >= startBoundary && t <= endBoundary;
        };

        const hasExtras = extraSeries.length > 0;

        const primaryFiltered = currentReadings.filter(inRange);
        const primaryDataset = {
            label: hasExtras ? currentId : config.valueLabel,
            data: primaryFiltered.map((r) => ({ x: new Date(r.datetime), y: r[config.valueField] })),
            borderColor: config.color,
            backgroundColor: config.fillColor,
            tension: 0.25,
            fill: !hasExtras,
            pointRadius: 2,
        };

        const extraDatasets = extraSeries.map((series, index) => {
            const filtered = series.readings.filter(inRange);
            const color = EXTRA_SERIES_COLORS[index % EXTRA_SERIES_COLORS.length];
            return {
                filtered,
                dataset: {
                    label: series.id,
                    data: filtered.map((r) => ({ x: new Date(r.datetime), y: r[config.valueField] })),
                    borderColor: color,
                    backgroundColor: color,
                    tension: 0.25,
                    fill: false,
                    pointRadius: 2,
                },
            };
        });

        filteredReadings = primaryFiltered.concat(extraDatasets.flatMap((d) => d.filtered));
        downloadBtn.disabled = filteredReadings.length === 0;

        chartTitleId.textContent = hasExtras
            ? `Comparing ${[currentId, ...extraSeries.map((s) => s.id)].join(", ")}`
            : `${config.entityLabel} ${currentId}`;
        chartTitleRange.textContent = `${rangeLabels.start} – ${rangeLabels.end}`;

        if (chartInstance) {
            chartInstance.destroy();
        }

        chartInstance = new Chart(chartCanvas, {
            type: "line",
            data: { datasets: [primaryDataset, ...extraDatasets.map((d) => d.dataset)] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "nearest", intersect: true },
                plugins: {
                    legend: { display: true },
                },
                scales: {
                    x: {
                        type: "time",
                        min: new Date(startBoundary),
                        max: new Date(endBoundary),
                        time: {
                            unit: "hour",
                            stepSize: 2,
                            displayFormats: { hour: "HH:mm" },
                            tooltipFormat: "MMM d, HH:mm",
                        },
                        title: { display: true, text: "Time" },
                    },
                    y: {
                        beginAtZero: scaleToggle.mode === "full",
                        title: { display: true, text: config.valueLabel },
                    },
                },
            },
        });
    }

    async function loadChart(id) {
        const response = await fetch(
            `${config.readingsUrl}?${config.idParam}=${encodeURIComponent(id)}`
        );
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Failed to load chart data.");
        }

        if (!data.readings.length) {
            loadingState.finishLoading();
            chartContainer.hidden = true;
            root.classList.remove("has-chart");
            currentId = null;
            extraSeries = [];
            renderExtraSeriesChips();
            alertBanner.hidden = true;
            notifyDataChange();
            return;
        }

        const isNewPrimary = id !== currentId;

        currentId = id;
        currentReadings = data.readings;
        dayStartMs = new Date(data.start).getTime();

        if (isNewPrimary) {
            extraSeries = [];
            renderExtraSeriesChips();
            rangeStart.value = 0;
            rangeEnd.value = 24;
            await loadThreshold(id);
        }

        loadingState.finishLoading();
        notifyDataChange();
        evaluateAlert();
        renderChart();
    }

    async function fetchReadingsFor(id) {
        const fetchResponse = await fetch(config.fetchUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [config.idParam]: id }),
        });
        const fetchData = await fetchResponse.json();
        if (!fetchResponse.ok) {
            throw new Error(fetchData.error || "Something went wrong.");
        }

        const resolvedId = fetchData[config.idParam];
        const readingsResponse = await fetch(
            `${config.readingsUrl}?${config.idParam}=${encodeURIComponent(resolvedId)}`
        );
        const readingsData = await readingsResponse.json();
        if (!readingsResponse.ok) {
            throw new Error(readingsData.error || "Failed to load chart data.");
        }
        if (!readingsData.readings.length) {
            throw new Error(`No data for ${resolvedId} today.`);
        }

        return { resolvedId, readings: readingsData.readings };
    }

    async function addSite() {
        const id = input.value.trim();
        if (!id) return;

        if (id === currentId || extraSeries.some((s) => s.id === id)) {
            statusEl.className = "status error";
            statusEl.textContent = `${id} is already on this chart.`;
            return;
        }

        addSiteBtn.disabled = true;
        statusEl.className = "status";
        statusEl.textContent = `Adding ${config.entityLabel.toLowerCase()} ${id}...`;

        try {
            const { resolvedId, readings } = await fetchReadingsFor(id);
            extraSeries.push({ id: resolvedId, readings });
            statusEl.className = "status success";
            statusEl.textContent = `Added ${resolvedId} to the chart.`;
            input.value = "";
            hint.sync();
            renderExtraSeriesChips();
            renderChart();
        } catch (err) {
            statusEl.className = "status error";
            statusEl.textContent = `Could not add site: ${err.message}`;
        } finally {
            addSiteBtn.disabled = false;
        }
    }

    function buildCsv(rows) {
        const header = config.columns.join(",");
        const lines = rows.map((r) => config.columns.map((col) => csvEscape(r[col])).join(","));
        return [header, ...lines].join("\n");
    }

    function buildJson(rows) {
        return JSON.stringify(
            rows.map((r) => {
                const ordered = {};
                config.columns.forEach((col) => (ordered[col] = r[col] ?? null));
                return ordered;
            }),
            null,
            2
        );
    }

    function buildXml(rows) {
        const items = rows
            .map((r) => {
                const fields = config.columns
                    .map((col) => `    <${col}>${xmlEscape(r[col])}</${col}>`)
                    .join("\n");
                return `  <reading>\n${fields}\n  </reading>`;
            })
            .join("\n");
        return `<?xml version="1.0" encoding="UTF-8"?>\n<readings>\n${items}\n</readings>`;
    }

    const FORMATS = {
        csv: { build: buildCsv, mime: "text/csv", extension: "csv" },
        json: { build: buildJson, mime: "application/json", extension: "json" },
        xml: { build: buildXml, mime: "application/xml", extension: "xml" },
    };

    function downloadData() {
        if (!filteredReadings.length) return;

        const format = FORMATS[downloadFormat.value] || FORMATS.csv;
        const content = format.build(filteredReadings);

        const { start, end } = getSliderHours();
        const startTag = formatDateTime(dayStartMs + start * 3600000).replace(/[:,\s]/g, "");
        const endTag = formatDateTime(dayStartMs + end * 3600000).replace(/[:,\s]/g, "");
        const idTag = extraSeries.length
            ? [currentId, ...extraSeries.map((s) => s.id)].join("-")
            : currentId;
        const filename = `${config.filePrefix}${idTag}_${startTag}-${endTag}.${format.extension}`;

        const blob = new Blob([content], { type: format.mime });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    async function fetchAndLoad(id) {
        submitBtn.disabled = true;
        statusEl.className = "status";
        statusEl.textContent = `Fetching data for ${config.entityLabel.toLowerCase()} ${id}...`;
        loadingState.startLoading();
        notifyLoadStart();

        try {
            const response = await fetch(config.fetchUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ [config.idParam]: id }),
            });

            const data = await response.json();

            if (!response.ok) {
                statusEl.className = "status error";
                statusEl.textContent = data.error || "Something went wrong.";
                loadingState.finishLoading();
                if (!currentId) loadingState.collapseAfterFailedFirstLoad();
                return;
            }

            const resolvedId = data[config.idParam];
            statusEl.className = "status";
            statusEl.textContent = "";

            await loadChart(resolvedId);
        } catch (err) {
            statusEl.className = "status error";
            statusEl.textContent = `Request failed: ${err.message}`;
            loadingState.finishLoading();
            if (!currentId) loadingState.collapseAfterFailedFirstLoad();
        } finally {
            submitBtn.disabled = false;
        }
    }

    const scaleToggle = initScaleToggle(root, config.panelType, () => {
        if (currentId) renderChart();
    });

    pinBtn.addEventListener("click", () => {
        const id = input.value.trim();
        if (!id) return;

        if (getPinned().includes(id)) {
            statusEl.className = "status";
            statusEl.textContent = `${id} is already pinned.`;
            return;
        }

        pinId(id);
        statusEl.className = "status success";
        statusEl.textContent = `Pinned ${id}.`;
    });

    rangeStart.addEventListener("input", renderChart);
    rangeEnd.addEventListener("input", renderChart);
    downloadBtn.addEventListener("click", downloadData);
    addSiteBtn.addEventListener("click", addSite);
    wireExpandButton(root, chartContainer, () => chartInstance);

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const id = input.value.trim();
        if (id) fetchAndLoad(id);
    });

    renderPinnedChips();

    return {
        async refresh() {
            if (!currentId) return;
            const tasks = [fetchAndLoad(currentId)];
            extraSeries.forEach((series) => {
                tasks.push(
                    fetchReadingsFor(series.id)
                        .then(({ readings }) => {
                            series.readings = readings;
                        })
                        .catch(() => {})
                );
            });
            await Promise.all(tasks);
            renderChart();
        },
        async refreshThreshold() {
            if (!currentId) return;
            await loadThreshold(currentId);
            evaluateAlert();
        },
        getPrimarySeries() {
            if (!currentId) return null;
            return {
                id: currentId,
                entityLabel: config.entityLabel,
                valueLabel: config.valueLabel,
                color: config.color,
                readings: currentReadings.map((r) => ({ datetime: r.datetime, value: r[config.valueField] })),
                latestMs: currentReadings.length
                    ? Math.max(...currentReadings.map((r) => new Date(r.datetime).getTime()))
                    : null,
            };
        },
        onDataChange(fn) {
            dataChangeListeners.push(fn);
        },
        onLoadStart(fn) {
            loadStartListeners.push(fn);
        },
    };
}

const usgsWidgetEl = document.getElementById("usgs-widget");
const usgsWidget = usgsWidgetEl && createWidget(usgsWidgetEl, {
    storageKey: "pinnedGauges",
    panelType: "usgs",
    serviceLabel: "USGS",
    entityLabel: "Gauge",
    idParam: "site_no",
    fetchUrl: "/api/fetch",
    readingsUrl: "/api/readings",
    valueField: "value",
    valueLabel: "Discharge (ft³/s)",
    color: "#2f7a4f",
    fillColor: "rgba(47, 122, 79, 0.15)",
    filePrefix: "gauge_",
    columns: [
        "site_no",
        "site_name",
        "latitude",
        "longitude",
        "parameter_cd",
        "parameter_name",
        "unit_code",
        "datetime",
        "value",
        "qualifiers",
        "inserted_at",
    ],
});

const nyisoWidgetEl = document.getElementById("nyiso-widget");
const nyisoWidget = nyisoWidgetEl && createWidget(nyisoWidgetEl, {
    storageKey: "pinnedPtids",
    panelType: "nyiso",
    serviceLabel: "NYISO",
    entityLabel: "PTID",
    idParam: "ptid",
    fetchUrl: "/api/nyiso/fetch",
    readingsUrl: "/api/nyiso/readings",
    valueField: "lbmp",
    valueLabel: "LBMP ($/MWHr)",
    color: "#1f6f8b",
    fillColor: "rgba(31, 111, 139, 0.15)",
    filePrefix: "ptid_",
    columns: [
        "ptid",
        "name",
        "datetime",
        "lbmp",
        "marginal_cost_losses",
        "marginal_cost_congestion",
        "inserted_at",
    ],
});

/**
 * NOAA NWPS forecast widget: overlays short/medium/long range + medium range
 * blend as separate lines on one chart, with a time-range slider like the
 * other widgets — except the slider's domain is the actual span of whatever
 * forecast data came back (it can run well past a single calendar day),
 * rather than a fixed 0-24h-from-midnight window.
 */
function createReachWidget(root, config) {
    const input = root.querySelector(".entry-input");
    const hint = initSlidingHint(input);
    hint.setText(input.getAttribute("placeholder") || "");
    const loadingState = initLoadingState(root, config.serviceLabel);
    const form = root.querySelector(".entry-form");
    const pinBtn = root.querySelector(".pin-icon-btn");
    const statusEl = root.querySelector(".status");
    const submitBtn = form.querySelector("button[type=submit]");
    const addSiteBtn = root.querySelector(".add-site-btn");
    const pinnedChips = root.querySelector(".pinned-chips");
    const chartContainer = root.querySelector(".chart-container");
    const chartTitleId = root.querySelector(".chart-title-id");
    const chartTitleRange = root.querySelector(".chart-title-range");
    const chartCanvas = root.querySelector(".readings-chart");
    const extraSeriesChips = root.querySelector(".extra-series-chips");
    const rangeStart = root.querySelector(".range-start");
    const rangeEnd = root.querySelector(".range-end");
    const rangeStartLabel = root.querySelector(".range-start-label");
    const rangeEndLabel = root.querySelector(".range-end-label");
    const downloadBtn = root.querySelector(".download-btn");
    const downloadFormat = root.querySelector(".download-format");
    const alertBanner = root.querySelector(".alert-banner");

    let chartInstance = null;
    let currentId = null;
    let currentReadings = [];
    let seriesStartMs = null;
    let totalHours = 24;
    let filteredReadings = [];
    let extraSeries = []; // [{ id, readings }] — additional reaches added via "+ Compare"
    let currentThreshold = null;
    const dataChangeListeners = []; // notified whenever loadChart() resolves, success or empty
    const loadStartListeners = []; // notified when a fetch begins, ahead of dataChangeListeners

    function notifyDataChange() {
        dataChangeListeners.forEach((fn) => fn());
    }

    function notifyLoadStart() {
        loadStartListeners.forEach((fn) => fn());
    }

    function getPinned() {
        try {
            return JSON.parse(localStorage.getItem(config.storageKey)) || [];
        } catch {
            return [];
        }
    }

    function savePinned(ids) {
        localStorage.setItem(config.storageKey, JSON.stringify(ids));
    }

    function renderPinnedChips() {
        const ids = getPinned();
        pinnedChips.innerHTML = "";

        ids.forEach((id) => {
            const chip = document.createElement("span");
            chip.className = "chip";

            const label = document.createElement("span");
            label.textContent = id;
            chip.appendChild(label);

            const remove = document.createElement("span");
            remove.className = "remove";
            remove.textContent = "×";
            remove.title = "Unpin";
            remove.addEventListener("click", (event) => {
                event.stopPropagation();
                savePinned(getPinned().filter((g) => g !== id));
                renderPinnedChips();
            });
            chip.appendChild(remove);

            chip.addEventListener("click", () => {
                input.value = id;
                hint.sync();
                form.requestSubmit();
            });

            pinnedChips.appendChild(chip);
        });
    }

    function pinId(id) {
        const ids = getPinned();
        if (!ids.includes(id)) {
            ids.push(id);
            savePinned(ids);
            renderPinnedChips();
        }
    }

    async function loadThreshold(id) {
        const response = await fetch(
            `/api/alerts?panel_type=${config.panelType}&external_id=${encodeURIComponent(id)}`
        );
        currentThreshold = response.ok ? (await response.json()).threshold : null;
    }

    function evaluateAlert() {
        if (!currentThreshold || !currentReadings.length) {
            alertBanner.hidden = true;
            return;
        }

        const latest = currentReadings[currentReadings.length - 1];
        const value = latest.flow;
        if (value === null || value === undefined) {
            alertBanner.hidden = true;
            return;
        }

        const { direction, threshold_value: thresholdValue } = currentThreshold;
        const triggered = direction === "above" ? value > thresholdValue : value < thresholdValue;

        alertBanner.hidden = !triggered;
        if (triggered) {
            alertBanner.textContent =
                `⚠ Reach ${currentId}: latest forecasted flow is ${value}, ` +
                `${direction} your alert threshold of ${thresholdValue}.`;
        }
    }

    function renderExtraSeriesChips() {
        extraSeriesChips.innerHTML = "";

        extraSeries.forEach((series, index) => {
            const chip = document.createElement("span");
            chip.className = "chip";
            chip.style.borderLeft = `4px solid ${EXTRA_SERIES_COLORS[index % EXTRA_SERIES_COLORS.length]}`;

            const label = document.createElement("span");
            label.textContent = series.id;
            chip.appendChild(label);

            const remove = document.createElement("span");
            remove.className = "remove";
            remove.textContent = "×";
            remove.title = `Remove ${series.id} from chart`;
            remove.addEventListener("click", () => {
                extraSeries = extraSeries.filter((s) => s.id !== series.id);
                renderExtraSeriesChips();
                renderChart();
            });
            chip.appendChild(remove);

            extraSeriesChips.appendChild(chip);
        });
    }

    function getSliderHours() {
        let start = parseFloat(rangeStart.value);
        let end = parseFloat(rangeEnd.value);

        if (start > end - MIN_GAP_HOURS) {
            if (document.activeElement === rangeStart) {
                start = end - MIN_GAP_HOURS;
                rangeStart.value = start;
            } else {
                end = start + MIN_GAP_HOURS;
                rangeEnd.value = end;
            }
        }

        return { start, end };
    }

    function renderChart() {
        const { start, end } = getSliderHours();

        const startBoundary = seriesStartMs + start * 3600000;
        const endBoundary = seriesStartMs + end * 3600000;
        const rangeLabels = formatRange(startBoundary, endBoundary);
        rangeStartLabel.textContent = rangeLabels.start;
        rangeEndLabel.textContent = rangeLabels.end;

        const inRange = (r) => {
            const t = new Date(r.valid_time).getTime();
            return t >= startBoundary && t <= endBoundary;
        };

        const hasExtras = extraSeries.length > 0;
        const primaryFiltered = currentReadings.filter(inRange);

        const extraDatasets = extraSeries.map((series, index) => {
            const color = EXTRA_SERIES_COLORS[index % EXTRA_SERIES_COLORS.length];
            const filtered = series.readings.filter((r) => r.series === config.series[0].key && inRange(r));
            return {
                filtered,
                dataset: {
                    label: series.id,
                    data: filtered.map((r) => ({ x: new Date(r.valid_time), y: r.flow })),
                    borderColor: color,
                    backgroundColor: color,
                    tension: 0.2,
                    fill: false,
                    pointRadius: 2,
                    spanGaps: true,
                },
            };
        });

        filteredReadings = primaryFiltered.concat(extraDatasets.flatMap((d) => d.filtered));
        downloadBtn.disabled = filteredReadings.length === 0;
        chartTitleId.textContent = hasExtras
            ? `Comparing ${[currentId, ...extraSeries.map((s) => s.id)].join(", ")}`
            : `Reach ${currentId}`;
        chartTitleRange.textContent = `${rangeLabels.start} – ${rangeLabels.end}`;

        const datasets = config.series.map((s) => ({
            label: hasExtras ? currentId : s.label,
            data: primaryFiltered
                .filter((r) => r.series === s.key)
                .map((r) => ({ x: new Date(r.valid_time), y: r.flow })),
            borderColor: s.color,
            backgroundColor: s.fillColor || s.color,
            tension: 0.2,
            fill: Boolean(s.fillColor) && !hasExtras,
            pointRadius: 2,
            spanGaps: true,
        }));

        if (chartInstance) {
            chartInstance.destroy();
        }

        chartInstance = new Chart(chartCanvas, {
            type: "line",
            data: { datasets: [...datasets, ...extraDatasets.map((d) => d.dataset)] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "nearest", intersect: true },
                scales: {
                    x: {
                        type: "time",
                        min: new Date(startBoundary),
                        max: new Date(endBoundary),
                        time: { tooltipFormat: "MMM d, HH:mm" },
                        title: { display: true, text: "Time" },
                    },
                    y: {
                        beginAtZero: scaleToggle.mode === "full",
                        title: { display: true, text: "Flow" },
                    },
                },
            },
        });
    }

    async function loadChart(id) {
        const response = await fetch(
            `${config.readingsUrl}?${config.idParam}=${encodeURIComponent(id)}`
        );
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Failed to load chart data.");
        }

        if (!data.readings.length) {
            loadingState.finishLoading();
            chartContainer.hidden = true;
            root.classList.remove("has-chart");
            currentId = null;
            extraSeries = [];
            renderExtraSeriesChips();
            alertBanner.hidden = true;
            notifyDataChange();
            return;
        }

        const isNewPrimary = id !== currentId;

        currentId = id;
        currentReadings = data.readings;

        const times = currentReadings.map((r) => new Date(r.valid_time).getTime());
        seriesStartMs = Math.min(...times);
        const seriesEndMs = Math.max(...times);
        totalHours = Math.max(MIN_GAP_HOURS, (seriesEndMs - seriesStartMs) / 3600000);

        rangeStart.max = totalHours;
        rangeEnd.max = totalHours;
        rangeStart.value = 0;
        rangeEnd.value = totalHours;

        if (isNewPrimary) {
            extraSeries = [];
            renderExtraSeriesChips();
            await loadThreshold(id);
        }

        loadingState.finishLoading();
        notifyDataChange();
        evaluateAlert();
        renderChart();
    }

    async function fetchReadingsFor(id) {
        const fetchResponse = await fetch(config.fetchUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [config.idParam]: id }),
        });
        const fetchData = await fetchResponse.json();
        if (!fetchResponse.ok) {
            throw new Error(fetchData.error || "Something went wrong.");
        }

        const resolvedId = fetchData[config.idParam];
        const readingsResponse = await fetch(
            `${config.readingsUrl}?${config.idParam}=${encodeURIComponent(resolvedId)}`
        );
        const readingsData = await readingsResponse.json();
        if (!readingsResponse.ok) {
            throw new Error(readingsData.error || "Failed to load chart data.");
        }
        if (!readingsData.readings.length) {
            throw new Error(`No forecast data available for ${resolvedId} right now.`);
        }

        return { resolvedId, readings: readingsData.readings };
    }

    async function addSite() {
        const id = input.value.trim();
        if (!id) return;

        if (id === currentId || extraSeries.some((s) => s.id === id)) {
            statusEl.className = "status error";
            statusEl.textContent = `${id} is already on this chart.`;
            return;
        }

        addSiteBtn.disabled = true;
        statusEl.className = "status";
        statusEl.textContent = `Adding reach ${id}...`;

        try {
            const { resolvedId, readings } = await fetchReadingsFor(id);
            extraSeries.push({ id: resolvedId, readings });
            statusEl.className = "status success";
            statusEl.textContent = `Added ${resolvedId} to the chart.`;
            input.value = "";
            hint.sync();
            renderExtraSeriesChips();
            renderChart();
        } catch (err) {
            statusEl.className = "status error";
            statusEl.textContent = `Could not add site: ${err.message}`;
        } finally {
            addSiteBtn.disabled = false;
        }
    }

    function buildCsv(rows) {
        const header = config.columns.join(",");
        const lines = rows.map((r) => config.columns.map((col) => csvEscape(r[col])).join(","));
        return [header, ...lines].join("\n");
    }

    function buildJson(rows) {
        return JSON.stringify(
            rows.map((r) => {
                const ordered = {};
                config.columns.forEach((col) => (ordered[col] = r[col] ?? null));
                return ordered;
            }),
            null,
            2
        );
    }

    function buildXml(rows) {
        const items = rows
            .map((r) => {
                const fields = config.columns
                    .map((col) => `    <${col}>${xmlEscape(r[col])}</${col}>`)
                    .join("\n");
                return `  <reading>\n${fields}\n  </reading>`;
            })
            .join("\n");
        return `<?xml version="1.0" encoding="UTF-8"?>\n<readings>\n${items}\n</readings>`;
    }

    const FORMATS = {
        csv: { build: buildCsv, mime: "text/csv", extension: "csv" },
        json: { build: buildJson, mime: "application/json", extension: "json" },
        xml: { build: buildXml, mime: "application/xml", extension: "xml" },
    };

    function downloadData() {
        if (!filteredReadings.length) return;

        const format = FORMATS[downloadFormat.value] || FORMATS.csv;
        const content = format.build(filteredReadings);

        const { start, end } = getSliderHours();
        const startTag = formatDateTime(seriesStartMs + start * 3600000).replace(/[:,\s]/g, "");
        const endTag = formatDateTime(seriesStartMs + end * 3600000).replace(/[:,\s]/g, "");
        const idTag = extraSeries.length
            ? [currentId, ...extraSeries.map((s) => s.id)].join("-")
            : currentId;
        const filename = `${config.filePrefix}${idTag}_${startTag}-${endTag}.${format.extension}`;

        const blob = new Blob([content], { type: format.mime });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    async function fetchAndLoad(id) {
        submitBtn.disabled = true;
        statusEl.className = "status";
        statusEl.textContent = `Fetching data for ${config.entityLabel.toLowerCase()} ${id}...`;
        loadingState.startLoading();
        notifyLoadStart();

        try {
            const response = await fetch(config.fetchUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ [config.idParam]: id }),
            });

            const data = await response.json();

            if (!response.ok) {
                statusEl.className = "status error";
                statusEl.textContent = data.error || "Something went wrong.";
                loadingState.finishLoading();
                if (!currentId) loadingState.collapseAfterFailedFirstLoad();
                return;
            }

            const resolvedId = data[config.idParam];
            statusEl.className = "status";
            statusEl.textContent = "";

            await loadChart(resolvedId);
        } catch (err) {
            statusEl.className = "status error";
            statusEl.textContent = `Request failed: ${err.message}`;
            loadingState.finishLoading();
            if (!currentId) loadingState.collapseAfterFailedFirstLoad();
        } finally {
            submitBtn.disabled = false;
        }
    }

    const scaleToggle = initScaleToggle(root, config.panelType, () => {
        if (currentId) renderChart();
    });

    pinBtn.addEventListener("click", () => {
        const id = input.value.trim();
        if (!id) return;

        if (getPinned().includes(id)) {
            statusEl.className = "status";
            statusEl.textContent = `${id} is already pinned.`;
            return;
        }

        pinId(id);
        statusEl.className = "status success";
        statusEl.textContent = `Pinned ${id}.`;
    });

    rangeStart.addEventListener("input", renderChart);
    rangeEnd.addEventListener("input", renderChart);
    downloadBtn.addEventListener("click", downloadData);
    addSiteBtn.addEventListener("click", addSite);
    wireExpandButton(root, chartContainer, () => chartInstance);

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const id = input.value.trim();
        if (id) fetchAndLoad(id);
    });

    renderPinnedChips();

    return {
        async refresh() {
            if (!currentId) return;
            const tasks = [fetchAndLoad(currentId)];
            extraSeries.forEach((series) => {
                tasks.push(
                    fetchReadingsFor(series.id)
                        .then(({ readings }) => {
                            series.readings = readings;
                        })
                        .catch(() => {})
                );
            });
            await Promise.all(tasks);
            renderChart();
        },
        async refreshThreshold() {
            if (!currentId) return;
            await loadThreshold(currentId);
            evaluateAlert();
        },
        getPrimarySeries() {
            if (!currentId) return null;
            const key = config.series[0].key;
            const referenceTimes = currentReadings
                .filter((r) => r.reference_time)
                .map((r) => new Date(r.reference_time).getTime());
            return {
                id: currentId,
                entityLabel: config.entityLabel,
                valueLabel: config.series[0].label,
                color: config.series[0].color,
                readings: currentReadings
                    .filter((r) => r.series === key)
                    .map((r) => ({ datetime: r.valid_time, value: r.flow })),
                latestMs: referenceTimes.length ? Math.max(...referenceTimes) : null,
            };
        },
        onDataChange(fn) {
            dataChangeListeners.push(fn);
        },
        onLoadStart(fn) {
            loadStartListeners.push(fn);
        },
    };
}

const reachWidgetEl = document.getElementById("reach-widget");
const reachWidget = reachWidgetEl && createReachWidget(reachWidgetEl, {
    storageKey: "pinnedReachIds",
    panelType: "reach",
    serviceLabel: "NOAA",
    entityLabel: "Reach ID",
    idParam: "reach_id",
    fetchUrl: "/api/reach/fetch",
    readingsUrl: "/api/reach/readings",
    filePrefix: "reach_",
    series: [
        { key: "short_range", label: "Short Range", color: "#e07a1f", fillColor: "rgba(224, 122, 31, 0.15)" },
    ],
    columns: ["reach_id", "series", "reference_time", "valid_time", "flow", "units", "inserted_at"],
});

/**
 * Power generation (synthetic): P = η · ρ · g · Q · H, applied to whatever
 * flow data is already loaded in the USGS and NOAA reach panels above (both
 * report flow in cfs, converted to m³/s here). Output is reported in MW.
 *
 * H (head) comes from the saved site currently loaded from the dropdown, if
 * that site has one set (see the "Manage Sites" form) — there's no real data
 * source for it otherwise, so a site with no head value, or no site loaded
 * at all, falls back to DEFAULT_HEAD_M. setActiveSiteHead() below is the
 * bridge from the saved-sites section (further down this file) into here.
 *
 * Each of the two charts (actual / forecast) gets its own expand button that
 * borrows the shared chartModal, same as the streamflow panels above. Unlike
 * those panels, the time-range slider only needs to be usable, not always
 * visible — so it lives inside .power-expand-controls, which CSS shows only
 * once the chart is expanded. The turbine efficiency (η) slider stays
 * visible in the compact card view too.
 */
const DEFAULT_HEAD_M = 30;
let activeSiteHeadM = null;
const headChangeListeners = [];

function setActiveSiteHead(headM) {
    activeSiteHeadM = headM;
    const headNoteEl = document.getElementById("power-head-note");
    if (headNoteEl) {
        headNoteEl.textContent =
            headM != null ? `${headM} m, from the loaded site` : `${DEFAULT_HEAD_M} m, default`;
    }
    headChangeListeners.forEach((fn) => fn());
}

const powerWidgetEl = document.getElementById("power-widget");

if (powerWidgetEl && usgsWidget && reachWidget) {
    const CFS_TO_M3S = 0.0283168466;
    const WATER_DENSITY_KG_M3 = 1000;
    const GRAVITY_M_S2 = 9.81;
    const WATTS_PER_MW = 1_000_000;

    function computePowerMW(flowCfs, efficiency) {
        if (flowCfs === null || flowCfs === undefined) return null;
        const headM = activeSiteHeadM != null ? activeSiteHeadM : DEFAULT_HEAD_M;
        const flowM3s = flowCfs * CFS_TO_M3S;
        const watts = efficiency * WATER_DENSITY_KG_M3 * GRAVITY_M_S2 * flowM3s * headM;
        return watts / WATTS_PER_MW;
    }

    function createPowerChartController(prefix, freshnessPrefix, staleThresholdMs) {
        const emptyEl = document.getElementById(`power-${prefix}-empty`);
        const containerEl = document.getElementById(`power-${prefix}-container`);
        const skeletonEl = document.getElementById(`power-${prefix}-skeleton`);
        const latestEl = document.getElementById(`power-${prefix}-latest`);
        const canvas = document.getElementById(`power-${prefix}-canvas`);
        const canvasWrapEl = canvas.parentElement;
        const rangeStart = document.getElementById(`power-${prefix}-range-start`);
        const rangeEnd = document.getElementById(`power-${prefix}-range-end`);
        const rangeStartLabel = document.getElementById(`power-${prefix}-range-start-label`);
        const rangeEndLabel = document.getElementById(`power-${prefix}-range-end-label`);
        const effSlider = document.getElementById(`power-${prefix}-eff-slider`);
        const effValueLabel = document.getElementById(`power-${prefix}-eff-value`);

        let chartInstance = null;
        let currentSeries = null;
        let seriesStartMs = null;
        let seriesEndMs = null;
        // True only once the user has actually dragged a handle. Every
        // update() (i.e. every refresh, since that's the only thing that
        // calls it) resets this to false, so a refresh always plots the
        // complete freshly-loaded series rather than re-deriving the old
        // boundary from the range sliders' current (possibly
        // browser-rounded) values, which could clip off the newest reading
        // and make the chart look like it never changed.
        let userAdjustedRange = false;

        wireExpandButton(containerEl, containerEl, () => chartInstance);

        function getSliderHours() {
            let start = parseFloat(rangeStart.value);
            let end = parseFloat(rangeEnd.value);

            if (start > end - MIN_GAP_HOURS) {
                if (document.activeElement === rangeStart) {
                    start = end - MIN_GAP_HOURS;
                    rangeStart.value = start;
                } else {
                    end = start + MIN_GAP_HOURS;
                    rangeEnd.value = end;
                }
            }

            return { start, end };
        }

        function render() {
            if (!currentSeries) return;

            const efficiency = parseFloat(effSlider.value);
            effValueLabel.textContent = efficiency.toFixed(2);

            let startBoundary;
            let endBoundary;
            if (userAdjustedRange) {
                const { start, end } = getSliderHours();
                startBoundary = seriesStartMs + start * 3600000;
                endBoundary = seriesStartMs + end * 3600000;
            } else {
                startBoundary = seriesStartMs;
                endBoundary = seriesEndMs;
            }
            const rangeLabels = formatRange(startBoundary, endBoundary);
            rangeStartLabel.textContent = rangeLabels.start;
            rangeEndLabel.textContent = rangeLabels.end;

            const rows = currentSeries.readings
                .filter((r) => {
                    const t = new Date(r.datetime).getTime();
                    return t >= startBoundary && t <= endBoundary;
                })
                .map((r) => ({ x: new Date(r.datetime), y: computePowerMW(r.value, efficiency) }));

            if (chartInstance) chartInstance.destroy();

            chartInstance = new Chart(canvas, {
                type: "line",
                data: {
                    datasets: [
                        {
                            label: currentSeries.label,
                            data: rows,
                            borderColor: currentSeries.color,
                            backgroundColor: currentSeries.color,
                            tension: 0.2,
                            pointRadius: 2,
                            fill: false,
                            spanGaps: true,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: "nearest", intersect: true },
                    plugins: { legend: { display: false } },
                    scales: {
                        x: {
                            type: "time",
                            time: { tooltipFormat: "MMM d, HH:mm" },
                            title: { display: true, text: "Time" },
                        },
                        y: {
                            beginAtZero: true,
                            title: { display: true, text: "Power (MW)" },
                        },
                    },
                },
            });
        }

        rangeStart.addEventListener("input", () => {
            userAdjustedRange = true;
            render();
        });
        rangeEnd.addEventListener("input", () => {
            userAdjustedRange = true;
            render();
        });
        effSlider.addEventListener("input", render);

        return {
            // Called as soon as the underlying gauge/reach fetch starts
            // (submit or refresh), so this chart shows the same shimmering
            // placeholder as the streamflow panels while it waits, instead
            // of just quietly sitting there until the new data lands.
            showLoading() {
                emptyEl.hidden = true;
                containerEl.hidden = false;
                skeletonEl.hidden = false;
                canvasWrapEl.hidden = true;
            },
            update(label, color, readings, latestMs) {
                applyFreshnessLabel(
                    latestEl,
                    freshnessPrefix ? freshnessLabel(freshnessPrefix, latestMs, staleThresholdMs) : null
                );

                if (!readings || !readings.length) {
                    emptyEl.hidden = false;
                    containerEl.hidden = true;
                    skeletonEl.hidden = true;
                    canvasWrapEl.hidden = false;
                    currentSeries = null;
                    return;
                }

                emptyEl.hidden = true;
                containerEl.hidden = false;
                skeletonEl.hidden = true;
                canvasWrapEl.hidden = false;

                const times = readings.map((r) => new Date(r.datetime).getTime());
                seriesStartMs = Math.min(...times);
                seriesEndMs = Math.max(...times);
                const totalHours = Math.max(MIN_GAP_HOURS, (seriesEndMs - seriesStartMs) / 3600000);

                rangeStart.max = totalHours;
                rangeEnd.max = totalHours;
                rangeStart.value = 0;
                rangeEnd.value = totalHours;
                userAdjustedRange = false;

                currentSeries = { label, color, readings };
                render();
            },
        };
    }

    const actualController = createPowerChartController("actual", null, null);
    const forecastController = createPowerChartController("forecast", "Forecast issued:", REACH_STALE_MS);

    function updatePowerCharts() {
        // Each controller update runs in its own try/catch: usgsWidget and
        // reachWidget each fire this on their own onDataChange, so a bad
        // reading in one series shouldn't leave the other chart stuck too.
        try {
            const actualSeries = usgsWidget.getPrimarySeries();
            actualController.update(
                actualSeries ? `Gauge ${actualSeries.id} power` : null,
                "#2f7a4f",
                actualSeries ? actualSeries.readings : null,
                actualSeries ? actualSeries.latestMs : null
            );
        } catch (err) {
            console.error("Failed to update actual power chart:", err);
        }

        try {
            const forecastSeries = reachWidget.getPrimarySeries();
            forecastController.update(
                forecastSeries ? `Reach ${forecastSeries.id} forecasted power` : null,
                "#e07a1f",
                forecastSeries ? forecastSeries.readings : null,
                forecastSeries ? forecastSeries.latestMs : null
            );
        } catch (err) {
            console.error("Failed to update forecast power chart:", err);
        }
    }

    usgsWidget.onDataChange(updatePowerCharts);
    reachWidget.onDataChange(updatePowerCharts);
    headChangeListeners.push(updatePowerCharts);
    usgsWidget.onLoadStart(() => {
        actualController.showLoading();
        powerWidgetEl.classList.add("has-chart");
    });
    reachWidget.onLoadStart(() => {
        forecastController.showLoading();
        powerWidgetEl.classList.add("has-chart");
    });

    updatePowerCharts();
}

/**
 * One shared 5-minute timer/button for the whole dashboard, instead of a
 * separate countdown per panel. Refreshing re-fetches whatever ID is
 * currently loaded in each of the three panels (a panel with nothing loaded
 * yet is simply skipped).
 *
 * The button shows time SINCE the last refresh ("Updated 2:14 ago"), not
 * time until the next one — for a monitoring tool, "how stale is this data
 * right now" is the more trustworthy signal, and a countdown was easy to
 * misread as something else entirely.
 */
const globalRefreshBtn = document.getElementById("global-refresh-btn");
const globalRefreshLabel = document.getElementById("global-refresh-label");
let lastRefreshedAt = Date.now();

function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    return `${formatCountdown(seconds)} ago`;
}

function updateGlobalRefreshButton() {
    globalRefreshLabel.textContent = `Updated ${formatElapsed(Date.now() - lastRefreshedAt)}`;
    const exact = new Date(lastRefreshedAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
    });
    globalRefreshBtn.title = `Panels last refreshed at ${exact}. Auto-refreshes every 5 min. Click to refresh now.`;
}

function refreshAllWidgets() {
    usgsWidget?.refresh();
    nyisoWidget?.refresh();
    reachWidget?.refresh();
    loadNotifications();
    lastRefreshedAt = Date.now();
    updateGlobalRefreshButton();
}

updateGlobalRefreshButton();
setInterval(() => {
    if (Date.now() - lastRefreshedAt >= REFRESH_INTERVAL_SECONDS * 1000) {
        refreshAllWidgets();
    } else {
        updateGlobalRefreshButton();
    }
}, 1000);

globalRefreshBtn.addEventListener("click", refreshAllWidgets);

const profileIconBtn = document.getElementById("profile-icon-btn");
const profileDropdown = document.getElementById("profile-dropdown");

profileIconBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    profileDropdown.hidden = !profileDropdown.hidden;
});

profileDropdown.addEventListener("click", (event) => event.stopPropagation());

document.addEventListener("click", () => {
    profileDropdown.hidden = true;
});

/**
 * Notification bell — the in-app half of the alerts feature. The background
 * poller (server-side) creates a row here every time one of the user's
 * thresholds newly crosses; this just displays them. Loaded on page load
 * and re-checked whenever the dashboard's own refresh cycle runs, so the
 * unread count stays roughly in step with the poller without a dedicated
 * timer of its own.
 */
const notificationBellBtn = document.getElementById("notification-bell-btn");
const notificationDropdown = document.getElementById("notification-dropdown");
const notificationBadge = document.getElementById("notification-badge");
const notificationList = document.getElementById("notification-list");
const notificationMarkReadBtn = document.getElementById("notification-mark-read-btn");

const NOTIFICATION_PANEL_LABELS = { usgs: "Gauge", nyiso: "PTID", reach: "Reach" };

function formatNotificationTime(iso) {
    const ms = new Date(iso).getTime();
    const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return formatDateTime(ms);
}

function renderNotificationList(notifications) {
    notificationList.innerHTML = "";

    if (!notifications.length) {
        const empty = document.createElement("div");
        empty.className = "notification-empty";
        empty.textContent = "No alerts triggered yet.";
        notificationList.appendChild(empty);
        return;
    }

    notifications.forEach((n) => {
        const item = document.createElement("div");
        item.className = `notification-item${n.is_read ? "" : " is-unread"}`;

        const title = document.createElement("div");
        title.className = "notification-item-title";
        title.textContent = `${NOTIFICATION_PANEL_LABELS[n.panel_type] || n.panel_type} ${n.external_id}`;
        item.appendChild(title);

        const detail = document.createElement("div");
        detail.className = "notification-item-detail";
        const verb = n.direction === "above" ? "rose above" : "dropped below";
        detail.textContent =
            `Value ${verb} ${n.threshold_value}, observed ${n.observed_value}` + (n.email_sent ? " · emailed" : "");
        item.appendChild(detail);

        const time = document.createElement("div");
        time.className = "notification-item-time";
        time.textContent = formatNotificationTime(n.created_at);
        item.appendChild(time);

        notificationList.appendChild(item);
    });
}

async function loadNotifications() {
    const response = await fetch("/api/notifications");
    if (!response.ok) return;
    const data = await response.json();
    renderNotificationList(data.notifications || []);
    const count = data.unread_count || 0;
    notificationBadge.textContent = count > 9 ? "9+" : String(count);
    notificationBadge.hidden = count === 0;
}

notificationBellBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = notificationDropdown.hidden;
    notificationDropdown.hidden = !notificationDropdown.hidden;
    if (opening) loadNotifications();
});

notificationDropdown.addEventListener("click", (event) => event.stopPropagation());

notificationMarkReadBtn.addEventListener("click", async () => {
    await fetch("/api/notifications/read", { method: "POST" });
    await loadNotifications();
});

document.addEventListener("click", () => {
    notificationDropdown.hidden = true;
});

loadNotifications();

/**
 * Saved sites: a user-owned bundle of {gauge_id, ptid, reach_id} under one
 * name, stored server-side (unlike pinned chips, which are per-browser
 * localStorage). The dropdown on the main page is for quick loading only;
 * add/edit/delete all live in the "Manage Sites" modal off the profile menu.
 */
const savedSitesSelect = document.getElementById("saved-sites-select");

const manageSitesOpenBtn = document.getElementById("manage-sites-open-btn");
const manageSitesBackdrop = document.getElementById("manage-sites-modal-backdrop");
const manageSitesCloseBtn = document.getElementById("manage-sites-close-btn");
const manageSitesList = document.getElementById("manage-sites-list");
const manageSitesAddBtn = document.getElementById("manage-sites-add-btn");
const manageSiteForm = document.getElementById("manage-site-form");
const manageSiteFormCancel = document.getElementById("manage-site-form-cancel");
const manageSitesStatus = document.getElementById("manage-sites-status");

let savedSitesCache = [];

const COMPARE_HINTS = {
    "usgs-input": "Enter another gauge number to compare",
    "nyiso-input": "Enter another PTID to compare",
    "reach-input": "Enter another reach ID to compare",
};

function applySavedId(inputId, value) {
    if (!value) return;
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = value;
    input.closest("form").requestSubmit();

    // The submit handler above reads input.value synchronously, so it's
    // already captured the id by the time requestSubmit() returns — safe
    // to clear the field now and hint that it's ready for a "+ Compare" id.
    input.value = "";
    if (COMPARE_HINTS[inputId]) {
        hintControllers[inputId]?.setText(COMPARE_HINTS[inputId]);
    } else {
        hintControllers[inputId]?.sync();
    }
}

function renderSavedSitesSelect() {
    if (!savedSitesSelect) return;
    const previousValue = savedSitesSelect.value;
    savedSitesSelect.innerHTML = '<option value="">Select a saved site…</option>';
    savedSitesCache.forEach((site) => {
        const option = document.createElement("option");
        option.value = site.id;
        option.textContent = site.name;
        savedSitesSelect.appendChild(option);
    });
    if (savedSitesCache.some((s) => String(s.id) === previousValue)) {
        savedSitesSelect.value = previousValue;
    }
}

function idsSummary(site) {
    const parts = [];
    if (site.gauge_id) parts.push(`Gauge ${site.gauge_id}`);
    if (site.ptid) parts.push(`PTID ${site.ptid}`);
    if (site.reach_id) parts.push(`Reach ${site.reach_id}`);
    const idsText = parts.join(" · ") || "No IDs set";
    const headText = site.head_m != null ? `H ${site.head_m} m` : "H default (30 m)";
    return `${idsText} · ${headText}`;
}

function renderManageSitesList() {
    manageSitesList.innerHTML = "";

    savedSitesCache.forEach((site) => {
        const row = document.createElement("div");
        row.className = "site-row";

        const info = document.createElement("div");
        info.className = "site-row-info";

        const name = document.createElement("div");
        name.className = "site-row-name";
        name.textContent = site.name;
        info.appendChild(name);

        const ids = document.createElement("div");
        ids.className = "site-row-ids";
        ids.textContent = idsSummary(site);
        info.appendChild(ids);

        row.appendChild(info);

        const actions = document.createElement("div");
        actions.className = "site-row-actions";

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "edit-site-btn";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => openManageSiteForm(site));
        actions.appendChild(editBtn);

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-site-btn";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => deleteSite(site));
        actions.appendChild(deleteBtn);

        row.appendChild(actions);
        manageSitesList.appendChild(row);
    });
}

async function loadSavedSites() {
    const response = await fetch("/api/sites");
    if (!response.ok) return;
    const data = await response.json();
    savedSitesCache = data.sites || [];
    renderSavedSitesSelect();
    renderManageSitesList();
}

function openManageSiteForm(site) {
    manageSiteForm.hidden = false;
    manageSitesStatus.textContent = "";
    manageSiteForm.elements.site_id.value = site ? site.id : "";
    manageSiteForm.elements.name.value = site ? site.name : "";
    manageSiteForm.elements.gauge_id.value = site ? site.gauge_id || "" : "";
    manageSiteForm.elements.ptid.value = site ? site.ptid || "" : "";
    manageSiteForm.elements.reach_id.value = site ? site.reach_id || "" : "";
    manageSiteForm.elements.head_m.value = site && site.head_m != null ? site.head_m : "";
    document.getElementById("manage-site-form-submit").textContent = site ? "Save changes" : "Save";
}

function closeManageSiteForm() {
    manageSiteForm.hidden = true;
    manageSiteForm.reset();
    manageSitesStatus.textContent = "";
}

async function deleteSite(site) {
    if (!confirm(`Delete saved site "${site.name}"?`)) return;

    const response = await fetch(`/api/sites/${site.id}`, { method: "DELETE" });
    if (response.ok) {
        await loadSavedSites();
    } else {
        const data = await response.json().catch(() => ({}));
        manageSitesStatus.className = "save-site-status error";
        manageSitesStatus.textContent = data.error || "Could not delete site.";
    }
}

savedSitesSelect?.addEventListener("change", () => {
    const site = savedSitesCache.find((s) => String(s.id) === savedSitesSelect.value);
    if (!site) return;

    applySavedId("usgs-input", site.gauge_id);
    applySavedId("nyiso-input", site.ptid);
    applySavedId("reach-input", site.reach_id);
    setActiveSiteHead(site.head_m != null ? Number(site.head_m) : null);

    const parts = [];
    if (site.gauge_id) parts.push(`gauge ${site.gauge_id}`);
    if (site.ptid) parts.push(`PTID ${site.ptid}`);
    if (site.reach_id) parts.push(`reach ${site.reach_id}`);
    showToast(`Loaded "${site.name}": ${parts.join(", ")}`);
});

function openManageSitesModal() {
    profileDropdown.hidden = true;
    manageSitesBackdrop.hidden = false;
    closeManageSiteForm();
}

manageSitesOpenBtn.addEventListener("click", openManageSitesModal);

const manageSitesLinkBtn = document.getElementById("manage-sites-link-btn");
manageSitesLinkBtn?.addEventListener("click", openManageSitesModal);

manageSitesCloseBtn.addEventListener("click", () => {
    manageSitesBackdrop.hidden = true;
});

manageSitesBackdrop.addEventListener("click", (event) => {
    if (event.target === manageSitesBackdrop) manageSitesBackdrop.hidden = true;
});

manageSitesAddBtn.addEventListener("click", () => openManageSiteForm(null));
manageSiteFormCancel.addEventListener("click", closeManageSiteForm);

manageSiteForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(manageSiteForm);
    const siteId = formData.get("site_id");
    const payload = {
        name: (formData.get("name") || "").trim(),
        gauge_id: (formData.get("gauge_id") || "").trim(),
        ptid: (formData.get("ptid") || "").trim(),
        reach_id: (formData.get("reach_id") || "").trim(),
        head_m: (formData.get("head_m") || "").trim(),
    };

    manageSitesStatus.className = "save-site-status";
    manageSitesStatus.textContent = "Saving...";

    try {
        const response = await fetch(siteId ? `/api/sites/${siteId}` : "/api/sites", {
            method: siteId ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await response.json();

        if (!response.ok) {
            manageSitesStatus.className = "save-site-status error";
            manageSitesStatus.textContent = data.error || "Could not save site.";
            return;
        }

        manageSitesStatus.className = "save-site-status success";
        manageSitesStatus.textContent = `Saved "${data.name}".`;
        closeManageSiteForm();
        await loadSavedSites();
    } catch (err) {
        manageSitesStatus.className = "save-site-status error";
        manageSitesStatus.textContent = `Request failed: ${err.message}`;
    }
});

loadSavedSites();

const DASHBOARD_HINT_DISMISSED_KEY = "dashboardHintDismissed";
const dashboardHint = document.getElementById("dashboard-hint");
const dashboardHintDismiss = document.getElementById("dashboard-hint-dismiss");

if (dashboardHint && localStorage.getItem(DASHBOARD_HINT_DISMISSED_KEY)) {
    dashboardHint.hidden = true;
}

dashboardHintDismiss?.addEventListener("click", () => {
    dashboardHint.hidden = true;
    localStorage.setItem(DASHBOARD_HINT_DISMISSED_KEY, "1");
});

/**
 * Manage Alerts: profile-menu modal listing every alert threshold the user
 * has set, across all three panel types, with add/edit/delete — mirrors the
 * Manage Sites modal. The banners themselves stay on their panels; this is
 * only the configuration surface.
 */
const manageAlertsOpenBtn = document.getElementById("manage-alerts-open-btn");
const manageAlertsBackdrop = document.getElementById("manage-alerts-modal-backdrop");
const manageAlertsCloseBtn = document.getElementById("manage-alerts-close-btn");
const manageAlertsList = document.getElementById("manage-alerts-list");
const manageAlertsAddBtn = document.getElementById("manage-alerts-add-btn");
const manageAlertForm = document.getElementById("manage-alert-form");
const manageAlertFormCancel = document.getElementById("manage-alert-form-cancel");
const manageAlertsStatus = document.getElementById("manage-alerts-status");

let alertsCache = [];

const PANEL_TYPE_LABELS = { usgs: "USGS Gauge", nyiso: "NYISO PTID", reach: "NOAA Reach" };

function refreshAllThresholds() {
    usgsWidget?.refreshThreshold();
    nyisoWidget?.refreshThreshold();
    reachWidget?.refreshThreshold();
}

function renderManageAlertsList() {
    manageAlertsList.innerHTML = "";

    alertsCache.forEach((alert) => {
        const row = document.createElement("div");
        row.className = "site-row";

        const info = document.createElement("div");
        info.className = "site-row-info";

        const name = document.createElement("div");
        name.className = "site-row-name";
        name.textContent = `${PANEL_TYPE_LABELS[alert.panel_type] || alert.panel_type} ${alert.external_id}`;
        info.appendChild(name);

        const details = document.createElement("div");
        details.className = "site-row-ids";
        details.textContent = `Alert when ${alert.direction} ${alert.threshold_value}`;
        info.appendChild(details);

        row.appendChild(info);

        const actions = document.createElement("div");
        actions.className = "site-row-actions";

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "edit-site-btn";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => openManageAlertForm(alert));
        actions.appendChild(editBtn);

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-site-btn";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => deleteAlert(alert));
        actions.appendChild(deleteBtn);

        row.appendChild(actions);
        manageAlertsList.appendChild(row);
    });
}

async function loadManageAlertsList() {
    const response = await fetch("/api/alerts/list");
    if (!response.ok) return;
    const data = await response.json();
    alertsCache = data.alerts || [];
    renderManageAlertsList();
}

function openManageAlertForm(alert) {
    manageAlertForm.hidden = false;
    manageAlertsStatus.textContent = "";
    manageAlertForm.elements.original_panel_type.value = alert ? alert.panel_type : "";
    manageAlertForm.elements.original_external_id.value = alert ? alert.external_id : "";
    manageAlertForm.elements.panel_type.value = alert ? alert.panel_type : "usgs";
    manageAlertForm.elements.external_id.value = alert ? alert.external_id : "";
    manageAlertForm.elements.direction.value = alert ? alert.direction : "above";
    manageAlertForm.elements.threshold_value.value = alert ? alert.threshold_value : "";
    document.getElementById("manage-alert-form-submit").textContent = alert ? "Save changes" : "Save";
}

function closeManageAlertForm() {
    manageAlertForm.hidden = true;
    manageAlertForm.reset();
    manageAlertsStatus.textContent = "";
}

async function deleteAlert(alert) {
    if (!confirm(`Delete alert for ${PANEL_TYPE_LABELS[alert.panel_type] || alert.panel_type} ${alert.external_id}?`)) {
        return;
    }

    const response = await fetch(
        `/api/alerts?panel_type=${alert.panel_type}&external_id=${encodeURIComponent(alert.external_id)}`,
        { method: "DELETE" }
    );

    if (response.ok) {
        await loadManageAlertsList();
        refreshAllThresholds();
    } else {
        const data = await response.json().catch(() => ({}));
        manageAlertsStatus.className = "save-site-status error";
        manageAlertsStatus.textContent = data.error || "Could not delete alert.";
    }
}

const alertsEnabledCheckbox = document.getElementById("alerts-enabled-checkbox");

async function loadAlertsEnabled() {
    const response = await fetch("/api/settings/alerts");
    if (!response.ok) return;
    const data = await response.json();
    alertsEnabledCheckbox.checked = Boolean(data.enabled);
}

alertsEnabledCheckbox.addEventListener("change", async () => {
    await fetch("/api/settings/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: alertsEnabledCheckbox.checked }),
    });
    refreshAllThresholds();
});

const contactSettingsForm = document.getElementById("contact-settings-form");
const contactEmailInput = document.getElementById("contact-email-input");
const emailAlertsEnabledCheckbox = document.getElementById("email-alerts-enabled-checkbox");
const contactSettingsStatus = document.getElementById("contact-settings-status");

async function loadContactSettings() {
    const response = await fetch("/api/settings/contact");
    if (!response.ok) return;
    const data = await response.json();
    contactEmailInput.value = data.email || "";
    emailAlertsEnabledCheckbox.checked = Boolean(data.email_alerts_enabled);
}

contactSettingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    contactSettingsStatus.className = "save-site-status";
    contactSettingsStatus.textContent = "Saving...";

    try {
        const response = await fetch("/api/settings/contact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: contactEmailInput.value.trim(),
                email_alerts_enabled: emailAlertsEnabledCheckbox.checked,
            }),
        });
        const data = await response.json();

        if (!response.ok) {
            contactSettingsStatus.className = "save-site-status error";
            contactSettingsStatus.textContent = data.error || "Could not save.";
            return;
        }

        contactSettingsStatus.className = "save-site-status success";
        contactSettingsStatus.textContent = "Saved.";
    } catch (err) {
        contactSettingsStatus.className = "save-site-status error";
        contactSettingsStatus.textContent = `Request failed: ${err.message}`;
    }
});

function openManageAlertsModal() {
    profileDropdown.hidden = true;
    manageAlertsBackdrop.hidden = false;
    closeManageAlertForm();
    loadManageAlertsList();
    loadAlertsEnabled();
    loadContactSettings();
    contactSettingsStatus.textContent = "";
}

manageAlertsOpenBtn.addEventListener("click", openManageAlertsModal);

manageAlertsCloseBtn.addEventListener("click", () => {
    manageAlertsBackdrop.hidden = true;
});

manageAlertsBackdrop.addEventListener("click", (event) => {
    if (event.target === manageAlertsBackdrop) manageAlertsBackdrop.hidden = true;
});

manageAlertsAddBtn.addEventListener("click", () => openManageAlertForm(null));
manageAlertFormCancel.addEventListener("click", closeManageAlertForm);

manageAlertForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(manageAlertForm);
    const originalPanelType = formData.get("original_panel_type");
    const originalExternalId = formData.get("original_external_id");
    const panelType = formData.get("panel_type");
    const externalId = (formData.get("external_id") || "").trim();
    const direction = formData.get("direction");
    const thresholdValue = parseFloat(formData.get("threshold_value"));

    if (!externalId || Number.isNaN(thresholdValue)) {
        manageAlertsStatus.className = "save-site-status error";
        manageAlertsStatus.textContent = "Enter an ID and a numeric threshold.";
        return;
    }

    manageAlertsStatus.className = "save-site-status";
    manageAlertsStatus.textContent = "Saving...";

    try {
        const isRename =
            originalPanelType && (originalPanelType !== panelType || originalExternalId !== externalId);

        if (isRename) {
            await fetch(
                `/api/alerts?panel_type=${originalPanelType}&external_id=${encodeURIComponent(originalExternalId)}`,
                { method: "DELETE" }
            );
        }

        const response = await fetch("/api/alerts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                panel_type: panelType,
                external_id: externalId,
                direction,
                threshold_value: thresholdValue,
            }),
        });
        const data = await response.json();

        if (!response.ok) {
            manageAlertsStatus.className = "save-site-status error";
            manageAlertsStatus.textContent = data.error || "Could not save alert.";
            return;
        }

        manageAlertsStatus.className = "save-site-status success";
        manageAlertsStatus.textContent = "Saved.";
        closeManageAlertForm();
        await loadManageAlertsList();
        refreshAllThresholds();
    } catch (err) {
        manageAlertsStatus.className = "save-site-status error";
        manageAlertsStatus.textContent = `Request failed: ${err.message}`;
    }
});

/**
 * Keeps the whole dashboard fitting inside one screen with no page scroll.
 * The chrome above .dashboard-grid (header, hint, insight banner, control
 * bar) varies in height depending on which banners happen to be visible, so
 * rather than guessing a fixed pixel budget, this measures how much vertical
 * space is actually left and shrinks the expanded card height — and its
 * internal chart canvas — to fit exactly. Both shrink together so a card's
 * title/controls/slider/download rows keep their normal size and only the
 * chart area itself gives up the space.
 */
const DEFAULT_CARD_HEIGHT = 565;
const DEFAULT_CANVAS_HEIGHT = 145;
// Sized so the power widget's two stacked canvases, plus their headers and
// always-visible efficiency sliders, fit inside DEFAULT_CARD_HEIGHT without
// the card needing to scroll (see .power-canvas-wrap in style.css).
const DEFAULT_COMBINED_CANVAS_HEIGHT = 240;
const MIN_CARD_HEIGHT = 380;
const MIN_CANVAS_HEIGHT = 90;
const MIN_COMBINED_CANVAS_HEIGHT = 160;

function fitDashboardToViewport() {
    const grid = document.querySelector(".dashboard-grid");
    if (!grid) return;

    const gridTop = grid.getBoundingClientRect().top;
    const bodyBottomPadding = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
    const available = window.innerHeight - gridTop - bodyBottomPadding;

    const cardHeight = Math.max(MIN_CARD_HEIGHT, Math.min(DEFAULT_CARD_HEIGHT, available));
    const shrinkBy = DEFAULT_CARD_HEIGHT - cardHeight;
    const canvasHeight = Math.max(MIN_CANVAS_HEIGHT, DEFAULT_CANVAS_HEIGHT - shrinkBy);
    const combinedCanvasHeight = Math.max(MIN_COMBINED_CANVAS_HEIGHT, DEFAULT_COMBINED_CANVAS_HEIGHT - shrinkBy);

    const root = document.documentElement.style;
    root.setProperty("--card-height", `${cardHeight}px`);
    root.setProperty("--canvas-height", `${canvasHeight}px`);
    root.setProperty("--combined-canvas-height", `${combinedCanvasHeight}px`);
}

window.addEventListener("resize", fitDashboardToViewport);

// Any banner/toolbar above the grid showing, hiding, or changing size shifts
// how much room is left — rather than hunting down every call site that
// toggles one of them, just watch the whole chrome region for changes.
new MutationObserver(() => requestAnimationFrame(fitDashboardToViewport)).observe(document.body, {
    attributes: true,
    attributeFilter: ["hidden"],
    childList: true,
    subtree: true,
});

fitDashboardToViewport();
