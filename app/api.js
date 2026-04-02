import { state, stateManager } from "./state.js";
import { refs } from "./refs.js";

let renderAllCallback = null;
let renderAuthCallback = null;
let renderAccountCallback = null;
let renderOverviewCallback = null;
let renderTimelineCallback = null;
let showBannerCallback = null;
let clearBannerCallback = null;
let setHortFactCallback = null;

export function setUICallbacks(callbacks = {}) {
  renderAllCallback = callbacks.renderAll || null;
  renderAuthCallback = callbacks.renderAuth || null;
  renderAccountCallback = callbacks.renderAccount || null;
  renderOverviewCallback = callbacks.renderOverview || null;
  renderTimelineCallback = callbacks.renderTimeline || null;
  showBannerCallback = callbacks.showBanner || null;
  clearBannerCallback = callbacks.clearBanner || null;
  setHortFactCallback = callbacks.setHortFact || null;
}

function clearCachedAppState() {
  stateManager.setSnapshot(null);
  stateManager.setDashboard(null);
  stateManager.setHealth(null);
  state.storage = null;
  state.timeline = null;
  state.weeklyTimeline = null;
}

function todayIso() {
  return new Date().toISOString().split("T")[0];
}

function activeTimelineAnchor() {
  return state.timelineAnchor || todayIso();
}

function activeOverviewAnchor() {
  return state.overviewAnchor || todayIso();
}

function applyPayload(payload) {
  if (Object.prototype.hasOwnProperty.call(payload, "auth")) {
    stateManager.setAuth(
      payload.auth
        ? {
            ...payload.auth,
            invites: payload.auth.invites || state.auth?.invites || [],
          }
        : payload.auth
    );
  }
  if (Object.prototype.hasOwnProperty.call(payload, "snapshot")) {
    stateManager.setSnapshot(payload.snapshot);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "dashboard")) {
    stateManager.setDashboard(payload.dashboard);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "health")) {
    stateManager.setHealth(payload.health);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "storage")) {
    state.storage = payload.storage;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "timeline")) {
    state.timeline = payload.timeline;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "weeklyTimeline")) {
    state.weeklyTimeline = payload.weeklyTimeline;
  }
  if (payload.hortFact && setHortFactCallback) {
    setHortFactCallback(payload.hortFact, { resetHistory: true });
  }
}

async function mutate(url, options, successMessage) {
  const result = await requestJson(url, options);
  applyPayload(result);
  await refreshTimeline();
  if (renderAllCallback) {
    renderAllCallback();
  }
  if (successMessage && showBannerCallback) {
    showBannerCallback(successMessage, "success");
  }
  return result;
}

async function requestJson(url, options = {}) {
  const init = {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
  };

  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (response.status === 401 && payload.auth) {
      stateManager.setAuth(payload.auth);
      stateManager.setSnapshot(null);
      stateManager.setDashboard(null);
      stateManager.setHealth(null);
      state.storage = null;
      state.timeline = null;
      state.weeklyTimeline = null;
      stateManager.setHortFact(null);
      stateManager.setHortFactHistory([]);
      stateManager.setHortFactIndex(-1);
      clearCachedAppState();
      if (renderAllCallback) {
        renderAllCallback();
      }
    }
    throw new Error(payload.error || `Request failed with status ${response.status}.`);
  }
  return payload;
}

async function refreshAll(options = {}) {
  try {
    const [bootstrap, timeline, weeklyTimeline] = await Promise.all([
      requestJson("/api/bootstrap"),
      requestJson(`/api/timeline?range=${state.timelineRange}&anchor=${activeTimelineAnchor()}`),
      requestJson(`/api/timeline?range=week&anchor=${activeOverviewAnchor()}`),
    ]);
    applyPayload({
      snapshot: bootstrap.snapshot,
      dashboard: bootstrap.dashboard,
      health: bootstrap.health,
      storage: bootstrap.storage,
      hortFact: bootstrap.hortFact,
      timeline,
      weeklyTimeline,
    });
    if (renderAllCallback) {
      renderAllCallback();
    }
    if (!options.quiet && clearBannerCallback) {
      clearBannerCallback();
    }
  } catch (error) {
    if (!state.snapshot) {
      throw error;
    }
    if (showBannerCallback) {
      showBannerCallback(
        error.message || "The API could not be reached. Showing the most recent cached state.",
        "warning"
      );
    }
  }
}

async function refreshTimeline() {
  refs.timelineRangeWeek.classList.toggle("active", state.timelineRange === "week");
  refs.timelineRangeMonth.classList.toggle("active", state.timelineRange === "month");
  const [timeline, weeklyTimeline] = await Promise.all([
    requestJson(`/api/timeline?range=${state.timelineRange}&anchor=${activeTimelineAnchor()}`),
    requestJson(`/api/timeline?range=week&anchor=${activeOverviewAnchor()}`),
  ]);
  stateManager.setTimeline(timeline);
  stateManager.setWeeklyTimeline(weeklyTimeline);
  if (renderOverviewCallback) {
    renderOverviewCallback();
  }
  if (renderTimelineCallback) {
    renderTimelineCallback();
  }
}

async function refreshOverviewWeek() {
  const weeklyTimeline = await requestJson(
    `/api/timeline?range=week&anchor=${activeOverviewAnchor()}`
  );
  stateManager.setWeeklyTimeline(weeklyTimeline);
  if (renderOverviewCallback) {
    renderOverviewCallback();
  }
}

async function refreshAuth(options = {}) {
  const result = await requestJson("/api/auth/session");
  stateManager.setAuth(result.auth);
  if (state.auth?.user?.role === "admin") {
    try {
      const invites = await requestJson("/api/auth/invites");
      state.auth.invites = invites.invites || [];
    } catch (error) {
      state.auth.invites = [];
    }
  } else if (state.auth) {
    state.auth.invites = [];
  }
  if (renderAuthCallback) {
    renderAuthCallback();
  }
  if (renderAccountCallback) {
    renderAccountCallback();
  }
  if (!options.quiet && state.auth?.user && clearBannerCallback) {
    clearBannerCallback();
  }
  return state.auth;
}

export {
  requestJson,
  mutate,
  refreshAll,
  refreshAuth,
  refreshTimeline,
  refreshOverviewWeek,
  applyPayload,
};
