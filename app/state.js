// ── State Manager with pub/sub notification system ──
class StateManager {
  constructor() {
    const today = new Date().toISOString().split("T")[0];
    this._state = {
      auth: null,
      authMode: "login",
      snapshot: null,
      dashboard: null,
      health: null,
      storage: null,
      timeline: null,
      weeklyTimeline: null,
      currentView: "overview",
      timelineRange: "month",
      timelineAnchor: today,
      timelineSelectedDate: today,
      overviewAnchor: today,
      overviewSelectedDate: today,
      settingsTab: "connections",
      hortFact: null,
      hortFactHistory: [],
      hortFactIndex: -1,
      map: {
        instance: null,
        savedGroup: null,
        draftLayer: null,
        editSnapshots: new Map(),
        zoneLayers: new Map(),
        pendingGeometry: null,
        pendingAreaSqFt: null,
      },
    };
    this._subscribers = new Set();
  }

  getState() {
    return this._state;
  }

  subscribe(callback) {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  _notify(changedProps) {
    this._subscribers.forEach((callback) => callback(changedProps));
  }

  setAuth(auth) {
    this._state.auth = auth;
    this._notify({ auth: true });
  }

  setAuthMode(mode) {
    this._state.authMode = mode;
    this._notify({ authMode: true });
  }

  setCurrentView(view) {
    this._state.currentView = view;
    this._notify({ currentView: true });
  }

  setTimelineRange(range) {
    this._state.timelineRange = range;
    this._notify({ timelineRange: true });
  }

  setTimelineAnchor(anchor) {
    this._state.timelineAnchor = anchor;
    this._notify({ timelineAnchor: true });
  }

  setTimelineSelectedDate(date) {
    this._state.timelineSelectedDate = date;
    this._notify({ timelineSelectedDate: true });
  }

  setOverviewAnchor(anchor) {
    this._state.overviewAnchor = anchor;
    this._notify({ overviewAnchor: true });
  }

  setOverviewSelectedDate(date) {
    this._state.overviewSelectedDate = date;
    this._notify({ overviewSelectedDate: true });
  }

  setSettingsTab(tab) {
    this._state.settingsTab = tab;
    this._notify({ settingsTab: true });
  }

  setSnapshot(snapshot) {
    this._state.snapshot = snapshot;
    this._notify({ snapshot: true });
  }

  setDashboard(dashboard) {
    this._state.dashboard = dashboard;
    this._notify({ dashboard: true });
  }

  setHealth(health) {
    this._state.health = health;
    this._notify({ health: true });
  }

  setTimeline(timeline) {
    this._state.timeline = timeline;
    this._notify({ timeline: true });
  }

  setWeeklyTimeline(weeklyTimeline) {
    this._state.weeklyTimeline = weeklyTimeline;
    this._notify({ weeklyTimeline: true });
  }

  setHortFact(fact) {
    this._state.hortFact = fact;
    this._notify({ hortFact: true });
  }

  setHortFactHistory(history) {
    this._state.hortFactHistory = history;
    this._notify({ hortFactHistory: true });
  }

  setHortFactIndex(index) {
    this._state.hortFactIndex = index;
    this._notify({ hortFactIndex: true });
  }

  setMapInstance(instance) {
    this._state.map.instance = instance;
    this._notify({ "map.instance": true });
  }

  setMapSavedGroup(group) {
    this._state.map.savedGroup = group;
    this._notify({ "map.savedGroup": true });
  }

  setMapDraftLayer(layer) {
    this._state.map.draftLayer = layer;
    this._notify({ "map.draftLayer": true });
  }

  getMapEditSnapshots() {
    return this._state.map.editSnapshots;
  }

  getMapZoneLayers() {
    return this._state.map.zoneLayers;
  }

  setMapPendingGeometry(geometry) {
    this._state.map.pendingGeometry = geometry;
    this._notify({ "map.pendingGeometry": true });
  }

  setMapPendingAreaSqFt(area) {
    this._state.map.pendingAreaSqFt = area;
    this._notify({ "map.pendingAreaSqFt": true });
  }
}

export const stateManager = new StateManager();
export const state = stateManager.getState();
