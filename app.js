import { state, stateManager } from "./app/state.js";
import { refs, initRefs } from "./app/refs.js";
import {
  requestJson,
  mutate,
  refreshAll,
  refreshAuth,
  refreshTimeline,
  refreshOverviewWeek,
  applyPayload,
  setUICallbacks,
} from "./app/api.js";
import {
  renderAll,
  renderOverview,
  renderTimeline,
  renderSelectors,
  renderProducts,
  renderTreatments,
  renderMowing,
  renderZones,
  renderHealth,
  renderAuth,
  renderAccount,
  renderInvites,
  renderStorageSettings,
  renderGoogleStatus,
  renderRachioStatus,
  renderBackups,
  renderQueue,
  renderProfileForm,
  renderHortOrHoax,
  renderDraftLayer,
  setViewCallbacks,
} from "./app/views/index.js";
import {
  submitZoneForm,
  submitProductForm,
  submitTreatmentForm,
  submitMowingForm,
  submitProfileForm,
  submitInitialAdminForm,
  submitLoginForm,
  submitRegisterForm,
  submitLogout,
  submitInviteForm,
  submitGoogleForm,
  submitRachioForm,
  submitImportForm,
  resetZoneForm,
  resetProductForm,
  resetTreatmentForm,
  resetMowingForm,
  setFormCallbacks,
} from "./app/forms/index.js";

const MAX_NATIVE_ZOOM = 22;

initRefs();
setUICallbacks({
  renderAll,
  renderAuth,
  renderAccount,
  renderOverview,
  renderTimeline,
  showBanner,
  clearBanner,
  setHortFact,
});
setViewCallbacks({
  syncMapLayers,
  openTimelineDay,
});
setFormCallbacks({
  initializeAppAfterAuth,
  showBanner,
  clearDraftGeometry,
});
initDarkMode();
initialize().catch((error) => {
  showBanner(error.message || "GrassPass could not initialize.", "danger");
});

let profileLocationSuggestionTimer = null;
let profileLocationSuggestionRequest = 0;
let profileLocationSuggestions = [];
let profileLocationHighlightedIndex = -1;

function initDarkMode() {
  const saved = localStorage.getItem("gp-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = saved ? saved === "dark" : prefersDark;
  applyTheme(isDark);
}

function applyTheme(dark) {
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("light", !dark);
  const icon = refs.themeToggle.querySelector(".material-symbols-outlined");
  if (icon) icon.textContent = dark ? "light_mode" : "dark_mode";
}

async function showConfirmation(title, message) {
  return new Promise((resolve) => {
    refs.confirmationTitle.textContent = title;
    refs.confirmationMessage.textContent = message;
    refs.confirmationDialog.hidden = false;

    const handleConfirm = () => {
      cleanup();
      resolve(true);
    };
    const handleCancel = () => {
      cleanup();
      resolve(false);
    };
    const handleKeydown = (e) => {
      if (e.key === "Escape") {
        handleCancel();
      } else if (e.key === "Enter") {
        handleConfirm();
      }
    };

    const cleanup = () => {
      refs.confirmationDialog.hidden = true;
      refs.confirmationConfirm.removeEventListener("click", handleConfirm);
      refs.confirmationCancel.removeEventListener("click", handleCancel);
      document.removeEventListener("keydown", handleKeydown);
    };

    refs.confirmationConfirm.addEventListener("click", handleConfirm);
    refs.confirmationCancel.addEventListener("click", handleCancel);
    document.addEventListener("keydown", handleKeydown);
    refs.confirmationConfirm.focus();
  });
}

async function initialize() {
  bindNavigation();
  bindActions();
  bindForms();
  const auth = await refreshAuth({ quiet: true });
  if (!auth.user) {
    clearCachedAppState();
    renderAuth();
    return;
  }

  await initializeAppAfterAuth();
}

async function initializeAppAfterAuth() {
  if (!state.map.instance) {
    await initializeMap();
  }
  await refreshAll({ quiet: true });
}

function bindNavigation() {
  refs.navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = sanitizeText(button.dataset.sectionTarget, 30);
      if (!target) {
        return;
      }
      stateManager.setCurrentView(target);
      refs.views.forEach((view) => view.classList.toggle("active", view.id === target));
      refs.navButtons.forEach((item) =>
        item.classList.toggle("active", item.dataset.sectionTarget === target)
      );
      if (target === "lawn-map" && state.map.instance) {
        scheduleMapViewportRefresh();
      }
    });
  });
}

function bindActions() {
  refs.profileButton.addEventListener("click", async () => {
    if (state.auth?.user) {
      await submitLogout();
      return;
    }
    stateManager.setAuthMode("login");
    renderAuth();
  });

  refs.themeToggle.addEventListener("click", () => {
    const isDark = document.documentElement.classList.toggle("dark");
    document.documentElement.classList.toggle("light", !isDark);
    const icon = refs.themeToggle.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = isDark ? "light_mode" : "dark_mode";
    localStorage.setItem("gp-theme", isDark ? "dark" : "light");
  });

  refs.timelineRangeWeek.addEventListener("click", async () => {
    stateManager.setTimelineRange("week");
    await refreshTimeline();
  });

  refs.timelineRangeMonth.addEventListener("click", async () => {
    stateManager.setTimelineRange("month");
    await refreshTimeline();
  });

  refs.timelinePrevPeriod.addEventListener("click", async () => {
    stateManager.setTimelineAnchor(
      shiftTimelineAnchor(state.timelineAnchor, state.timelineRange, -1)
    );
    await refreshTimeline();
  });

  refs.timelineNextPeriod.addEventListener("click", async () => {
    stateManager.setTimelineAnchor(
      shiftTimelineAnchor(state.timelineAnchor, state.timelineRange, 1)
    );
    await refreshTimeline();
  });

  refs.overviewPrevPeriod.addEventListener("click", async () => {
    stateManager.setOverviewAnchor(shiftIsoDate(state.overviewAnchor, -7));
    await refreshOverviewWeek();
  });

  refs.overviewNextPeriod.addEventListener("click", async () => {
    stateManager.setOverviewAnchor(shiftIsoDate(state.overviewAnchor, 7));
    await refreshOverviewWeek();
  });

  const settingsTabs = [
    { btn: refs.settingsTabConnections, group: refs.settingsGroupConnections, key: "connections" },
    { btn: refs.settingsTabProperty,    group: refs.settingsGroupProperty,    key: "property" },
    { btn: refs.settingsTabAccess,      group: refs.settingsGroupAccess,      key: "access" },
  ];
  settingsTabs.forEach(({ btn, key }) => {
    btn.addEventListener("click", () => {
      stateManager.setSettingsTab(key);
      settingsTabs.forEach(({ btn: b, group: g, key: k }) => {
        b.classList.toggle("active", k === key);
        g.hidden = k !== key;
      });
    });
  });

  refs.googleDisconnect.addEventListener("click", async () => {
    const confirmed = await showConfirmation(
      "Disconnect Google Calendar?",
      "This will remove the Google Calendar connection. You can reconnect later."
    );
    if (!confirmed) {
      return;
    }
    await mutate(
      "/api/google/disconnect",
      { method: "POST" },
      "Google Calendar connection removed."
    );
  });

  refs.googleResync.addEventListener("click", async () => {
    await mutate(
      "/api/google/resync",
      { method: "POST" },
      "Google sync queue rebuilt and resubmitted."
    );
  });

  refs.rachioSyncBtn.addEventListener("click", async () => {
    refs.rachioSyncBtn.disabled = true;
    refs.rachioSyncBtn.textContent = "Syncing...";
    try {
      const result = await requestJson("/api/waterings/sync-rachio", {
        method: "POST",
      });
      applyPayload(result);
      await refreshAll({ quiet: true });
      renderRachioStatus();
      showBanner("Rachio schedule synced successfully!", "success");
    } catch (error) {
      showBanner(error.message || "Failed to sync Rachio schedule", "error");
    } finally {
      refs.rachioSyncBtn.disabled = false;
      refs.rachioSyncBtn.textContent = "Sync Schedule";
    }
  });

  refs.rachioDisconnect.addEventListener("click", async () => {
    const confirmed = await showConfirmation(
      "Disconnect Rachio?",
      "This will remove your Rachio API key. You can reconnect later."
    );
    if (!confirmed) {
      return;
    }
    const result = await requestJson("/api/rachio/disconnect", { method: "POST" });
    applyPayload(result);
    refs.rachioApiKey.value = "";
    renderRachioStatus();
  });

  refs.retryFailed.addEventListener("click", async () => {
    await mutate("/api/google/retry", { method: "POST" }, "Failed queue items retried.");
  });

  refs.hortHoaxPrevBtn.addEventListener("click", () => {
    if (state.hortFactIndex <= 0) {
      return;
    }
    state.hortFactIndex -= 1;
    stateManager.setHortFact(state.hortFactHistory[state.hortFactIndex] || null);
    renderHortOrHoax(state.hortFact);
  });

  refs.hortHoaxNextBtn.addEventListener("click", async () => {
    if (state.hortFactIndex < state.hortFactHistory.length - 1) {
      state.hortFactIndex += 1;
      stateManager.setHortFact(state.hortFactHistory[state.hortFactIndex] || null);
      renderHortOrHoax(state.hortFact);
      return;
    }

    const btn = refs.hortHoaxNextBtn;
    btn.disabled = true;
    btn.innerHTML = "Loading…";
    try {
      const excludeId = state.hortFact ? state.hortFact.id : null;
      const url = excludeId ? `/api/hort-or-hoax?exclude=${excludeId}` : "/api/hort-or-hoax";
      const result = await requestJson(url, { method: "GET" });
      if (result.item) {
        setHortFact(result.item, { appendHistory: true });
        renderHortOrHoax(state.hortFact);
      }
    } catch (_) {}
    btn.disabled = false;
    btn.innerHTML = `Next tip <span class="material-symbols-outlined" style="font-size:18px">arrow_forward</span>`;
  });

  refs.zoneCancel.addEventListener("click", resetZoneForm);
  refs.productCancel.addEventListener("click", resetProductForm);
  refs.treatmentCancel.addEventListener("click", resetTreatmentForm);
  refs.mowingCancel.addEventListener("click", resetMowingForm);

  refs.focusZones.addEventListener("click", focusSavedZones);
  refs.clearDraft.addEventListener("click", clearDraftGeometry);
  refs.locateMap.addEventListener("click", locateMap);

  refs.zonesList.addEventListener("click", handleZoneListAction);
  refs.productsList.addEventListener("click", handleProductListAction);
  refs.treatmentsList.addEventListener("click", handleTreatmentListAction);
  refs.mowingList.addEventListener("click", handleMowingListAction);
  refs.queueList.addEventListener("click", handleQueueListAction);
  refs.showRegister.addEventListener("click", () => {
    stateManager.setAuthMode("register");
    renderAuth();
  });
  refs.showLogin.addEventListener("click", () => {
    stateManager.setAuthMode("login");
    renderAuth();
  });

  refs.profileLocation.addEventListener("input", handleProfileLocationInput);
  refs.profileLocation.addEventListener("keydown", handleProfileLocationKeydown);
  refs.profileLocation.addEventListener("blur", () => {
    window.setTimeout(clearProfileLocationSuggestions, 120);
  });
}

function bindForms() {
  function managed(form, handler) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const btn = event.submitter ?? form.querySelector('button[type="submit"]');
      const label = btn?.textContent ?? "";
      if (btn) { btn.disabled = true; btn.textContent = "Saving\u2026"; }
      try {
        await handler(event);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
      }
    });
  }

  refs.authSetupForm.addEventListener("submit", submitInitialAdminForm);
  refs.authLoginForm.addEventListener("submit", submitLoginForm);
  refs.authRegisterForm.addEventListener("submit", submitRegisterForm);
  managed(refs.zoneForm, submitZoneForm);
  managed(refs.productForm, submitProductForm);
  managed(refs.treatmentForm, submitTreatmentForm);
  managed(refs.mowingForm, submitMowingForm);
  managed(refs.profileForm, submitProfileForm);
  managed(refs.googleForm, submitGoogleForm);
  managed(refs.rachioForm, submitRachioForm);
  managed(refs.importForm, submitImportForm);
  managed(refs.inviteForm, submitInviteForm);
}

function setHortFact(item, options = {}) {
  if (!item) {
    return;
  }
  if (options.resetHistory) {
    stateManager.setHortFactHistory([item]);
    stateManager.setHortFactIndex(0);
  } else if (options.appendHistory) {
    const current = state.hortFactHistory[state.hortFactIndex] || null;
    if (!current || current.id !== item.id) {
      const newHistory = state.hortFactHistory.slice(0, state.hortFactIndex + 1);
      newHistory.push(item);
      stateManager.setHortFactHistory(newHistory);
      stateManager.setHortFactIndex(newHistory.length - 1);
    }
  }
  stateManager.setHortFact(item);
}

function handleProfileLocationInput(event) {
  const value = String(event.target?.value || "").trim();
  profileLocationHighlightedIndex = -1;
  if (profileLocationSuggestionTimer) {
    window.clearTimeout(profileLocationSuggestionTimer);
  }

  if (value.length < 3) {
    clearProfileLocationSuggestions();
    return;
  }

  profileLocationSuggestionTimer = window.setTimeout(async () => {
    const requestId = ++profileLocationSuggestionRequest;
    try {
      const result = await requestJson(
        `/api/weather/suggestions?q=${encodeURIComponent(value)}`
      );
      if (requestId !== profileLocationSuggestionRequest) {
        return;
      }
      populateProfileLocationSuggestions(result.suggestions || [], value);
    } catch (_) {
      if (requestId !== profileLocationSuggestionRequest) {
        return;
      }
      clearProfileLocationSuggestions();
    }
  }, 220);
}

function handleProfileLocationKeydown(event) {
  if (!profileLocationSuggestions.length) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    profileLocationHighlightedIndex = Math.min(
      profileLocationHighlightedIndex + 1,
      profileLocationSuggestions.length - 1
    );
    renderProfileLocationSuggestions();
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    profileLocationHighlightedIndex = Math.max(profileLocationHighlightedIndex - 1, 0);
    renderProfileLocationSuggestions();
    return;
  }

  if (event.key === "Enter" && profileLocationHighlightedIndex >= 0) {
    event.preventDefault();
    applyProfileLocationSuggestion(
      profileLocationSuggestions[profileLocationHighlightedIndex]
    );
    return;
  }

  if (event.key === "Escape") {
    clearProfileLocationSuggestions();
  }
}

function populateProfileLocationSuggestions(suggestions, query) {
  if (!refs.profileLocationSuggestions) {
    return;
  }

  const normalizedQuery = String(query || "").trim().toLowerCase();
  profileLocationSuggestions = suggestions.filter(
    (suggestion) =>
      suggestion &&
      suggestion.toLowerCase() !== normalizedQuery
  );

  if (!profileLocationSuggestions.length) {
    clearProfileLocationSuggestions();
    return;
  }

  profileLocationHighlightedIndex = 0;
  renderProfileLocationSuggestions();
}

function renderProfileLocationSuggestions() {
  refs.profileLocationSuggestions.replaceChildren();

  if (!profileLocationSuggestions.length) {
    refs.profileLocationSuggestions.hidden = true;
    refs.profileLocation.setAttribute("aria-expanded", "false");
    return;
  }

  profileLocationSuggestions.forEach((suggestion, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "autocomplete-option";
    if (index === profileLocationHighlightedIndex) {
      button.classList.add("is-active");
    }
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === profileLocationHighlightedIndex ? "true" : "false");
    button.textContent = suggestion;
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyProfileLocationSuggestion(suggestion);
    });
    refs.profileLocationSuggestions.appendChild(button);
  });

  refs.profileLocationSuggestions.hidden = false;
  refs.profileLocation.setAttribute("aria-expanded", "true");
}

function applyProfileLocationSuggestion(suggestion) {
  refs.profileLocation.value = suggestion;
  clearProfileLocationSuggestions();
}

function clearProfileLocationSuggestions() {
  profileLocationSuggestions = [];
  profileLocationHighlightedIndex = -1;
  if (!refs.profileLocationSuggestions) {
    return;
  }
  refs.profileLocationSuggestions.replaceChildren();
  refs.profileLocationSuggestions.hidden = true;
  refs.profileLocation.setAttribute("aria-expanded", "false");
}

function shiftTimelineAnchor(anchor, range, direction) {
  if (range === "week") {
    return shiftIsoDate(anchor, direction * 7);
  }
  return shiftIsoMonth(anchor, direction);
}

function shiftIsoDate(isoDate, days) {
  const date = new Date(`${isoDate || todayIso()}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().split("T")[0];
}

function shiftIsoMonth(isoDate, months) {
  const date = new Date(`${isoDate || todayIso()}T12:00:00`);
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDayOfMonth));
  return date.toISOString().split("T")[0];
}

async function openTimelineDay(date, options = {}) {
  if (!date) {
    return;
  }

  if (options.forceWeek) {
    stateManager.setTimelineRange("week");
  }
  stateManager.setTimelineAnchor(date);
  stateManager.setTimelineSelectedDate(date);
  activateView("planner");
  await refreshTimeline();

  const target = document.getElementById(`timeline-day-${date}`);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  showBanner(`No planner items on ${formatDayLabel(date)}.`, "warning");
}

async function handleZoneListAction(event) {
  const action = event.target?.dataset?.action;
  const id = event.target?.dataset?.id;
  if (!action || !id) {
    return;
  }
  if (action === "edit") {
    const zone = byId(state.snapshot.zones, id);
    if (!zone) {
      return;
    }
    refs.zoneId.value = zone.id;
    refs.zoneName.value = zone.name;
    refs.zoneSurface.value = zone.surface;
    refs.zoneNotes.value = zone.notes || "";
    stateManager.setMapPendingGeometry(clone(zone.geometry));
    stateManager.setMapPendingAreaSqFt(zone.areaSqFt || null);
    refs.zoneFormStatus.textContent = zone.geometry
      ? "Editing an existing mapped zone. Save when metadata or geometry is ready."
      : "This zone has no geometry yet. Draw a polygon, then save.";
    state.currentView = "lawn-map";
    activateView("lawn-map");
    focusZone(id);
    return;
  }
  if (action === "focus") {
    focusZone(id);
    return;
  }
  if (action === "delete") {
    const confirmed = await showConfirmation(
      "Delete Zone?",
      "This will permanently delete the zone and unlink its events. This action cannot be undone."
    );
    if (!confirmed) {
      return;
    }
    await mutate(`/api/zones/${encodeURIComponent(id)}`, { method: "DELETE" }, "Zone deleted.");
    if (refs.zoneId.value === id) {
      resetZoneForm();
    }
  }
}

async function handleProductListAction(event) {
  const action = event.target?.dataset?.action;
  const id = event.target?.dataset?.id;
  if (!action || !id) {
    return;
  }
  if (action === "edit") {
    const product = byId(state.snapshot.products, id);
    if (!product) {
      return;
    }
    refs.productId.value = product.id;
    refs.productName.value = product.name;
    refs.productCategory.value = product.category;
    refs.productActive.value = product.activeIngredient || "";
    refs.productRate.value = product.coverageRateSqFt || "";
    refs.productQuantity.value = product.quantity || "";
    refs.productUnit.value = product.unit || "unit";
    refs.productNotes.value = product.notes || "";
    activateView("inventory");
    return;
  }
  if (action === "delete") {
    const confirmed = await showConfirmation(
      "Delete Product?",
      "This will permanently delete the product and unlink it from all treatments. This action cannot be undone."
    );
    if (!confirmed) {
      return;
    }
    await mutate(
      `/api/products/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      "Product deleted."
    );
    if (refs.productId.value === id) {
      resetProductForm();
    }
  }
}

async function handleTreatmentListAction(event) {
  const action = event.target?.dataset?.action;
  const id = event.target?.dataset?.id;
  if (!action || !id) {
    return;
  }
  if (action === "edit") {
    const treatment = byId(state.snapshot.treatments, id);
    if (!treatment) {
      return;
    }
    refs.treatmentId.value = treatment.id;
    refs.treatmentDate.value = treatment.date;
    refs.treatmentZone.value = treatment.zoneId || "";
    refs.treatmentType.value = treatment.type;
    refs.treatmentProduct.value = treatment.productId || "";
    refs.treatmentRepeat.value = treatment.repeatDays || "";
    refs.treatmentNotes.value = treatment.notes || "";
    refs.treatmentPush.checked = Boolean(treatment.pushToGoogle);
    activateView("planner");
    return;
  }
  if (action === "complete") {
    const treatment = byId(state.snapshot.treatments, id);
    if (!treatment) {
      return;
    }
    await mutate(
      `/api/treatments/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: {
          ...treatment,
          status: "Completed",
        },
      },
      "Treatment marked complete."
    );
    return;
  }
  if (action === "delete") {
    const confirmed = await showConfirmation(
      "Delete Treatment?",
      "This will permanently delete the treatment record. This action cannot be undone."
    );
    if (!confirmed) {
      return;
    }
    await mutate(
      `/api/treatments/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      "Treatment deleted."
    );
    if (refs.treatmentId.value === id) {
      resetTreatmentForm();
    }
  }
}

async function handleMowingListAction(event) {
  const action = event.target?.dataset?.action;
  const id = event.target?.dataset?.id;
  if (!action || !id) {
    return;
  }
  if (action === "edit") {
    const entry = byId(state.snapshot.mowingLogs, id);
    if (!entry) {
      return;
    }
    refs.mowingId.value = entry.id;
    refs.mowingDate.value = entry.date;
    refs.mowingZone.value = entry.zoneId || "";
    refs.mowingDuration.value = entry.durationMinutes;
    refs.mowingHeight.value = entry.heightInches;
    refs.mowingClippings.value = entry.clippings;
    refs.mowingNotes.value = entry.notes || "";
    refs.mowingPush.checked = Boolean(entry.pushToGoogle);
    activateView("planner");
    return;
  }
  if (action === "delete") {
    const confirmed = await showConfirmation(
      "Delete Mowing Log?",
      "This will permanently delete the mowing log. This action cannot be undone."
    );
    if (!confirmed) {
      return;
    }
    await mutate(
      `/api/mowing/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      "Mowing log deleted."
    );
    if (refs.mowingId.value === id) {
      resetMowingForm();
    }
  }
}

async function handleQueueListAction(event) {
  const action = event.target?.dataset?.action;
  const id = event.target?.dataset?.id;
  if (action === "retry" && id) {
    await mutate(
      "/api/google/retry",
      {
        method: "POST",
        body: { ids: [id] },
      },
      "Queue item retried."
    );
  }
}

async function initializeMap() {
  if (!window.L || !window.turf) {
    refs.zoneAreaReadout.textContent = "Map libraries failed to load.";
    return;
  }

  const config = await requestJson("/api/config");

  const mapInstance = L.map(refs.mapCanvas, {
    zoomControl: true,
    maxZoom: MAX_NATIVE_ZOOM,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
  }).setView([39.5, -98.35], 4);
  stateManager.setMapInstance(mapInstance);

  L.tileLayer(
    `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=${config.mapboxToken}`,
    {
      attribution:
        '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.maxar.com/">Maxar</a>',
      maxNativeZoom: MAX_NATIVE_ZOOM,
      maxZoom: MAX_NATIVE_ZOOM,
      tileSize: 512,
      zoomOffset: -1,
      detectRetina: false,
    }
  ).addTo(mapInstance);

  const savedGroup = new L.FeatureGroup();
  stateManager.setMapSavedGroup(savedGroup);
  mapInstance.addLayer(savedGroup);

  const drawControl = new L.Control.Draw({
    edit: {
      featureGroup: state.map.savedGroup,
      remove: true,
    },
    draw: {
      marker: false,
      circle: false,
      circlemarker: false,
      polyline: false,
      rectangle: false,
      polygon: {
        allowIntersection: false,
        showArea: true,
      },
    },
  });

  state.map.instance.addControl(drawControl);

  state.map.instance.on(L.Draw.Event.CREATED, (mapEvent) => {
    const feature = mapEvent.layer.toGeoJSON();
    const validation = validateZoneFeature(feature);
    if (validation.error) {
      showBanner(validation.error, "danger");
      return;
    }
    setDraftLayer(feature.geometry, validation.areaSqFt);
    refs.zoneFormStatus.textContent = `Draft geometry ready. Estimated area: ${formatArea(validation.areaSqFt)}.`;
  });

  state.map.instance.on(L.Draw.Event.EDITSTART, () => {
    state.map.editSnapshots.clear();
    state.map.savedGroup.eachLayer((layer) => {
      if (layer.zoneId) {
        state.map.editSnapshots.set(layer.zoneId, clone(layer.toGeoJSON().geometry));
      }
    });
  });

  state.map.instance.on(L.Draw.Event.EDITED, async (mapEvent) => {
    const updates = [];
    mapEvent.layers.eachLayer((layer) => {
      if (!layer.zoneId) {
        return;
      }
      const feature = layer.toGeoJSON();
      const validation = validateZoneFeature(feature);
      if (validation.error) {
        const fallback = state.map.editSnapshots.get(layer.zoneId);
        if (fallback) {
          layer.setLatLngs(L.geoJSON(fallback).getLayers()[0].getLatLngs());
        }
        showBanner(validation.error, "danger");
        return;
      }
      updates.push(
        requestJson(`/api/zones/${encodeURIComponent(layer.zoneId)}`, {
          method: "PATCH",
          body: {
            geometry: feature.geometry,
            areaSqFt: validation.areaSqFt,
          },
        })
      );
    });
    if (updates.length > 0) {
      await Promise.all(updates);
      await refreshAll({ quiet: true });
      showBanner("Zone geometry updated.", "success");
    }
  });

  state.map.instance.on(L.Draw.Event.DELETED, async (mapEvent) => {
    const deletions = [];
    mapEvent.layers.eachLayer((layer) => {
      if (layer.zoneId) {
        deletions.push(
          requestJson(`/api/zones/${encodeURIComponent(layer.zoneId)}`, {
            method: "DELETE",
          })
        );
      }
    });
    if (deletions.length > 0) {
      await Promise.all(deletions);
      await refreshAll({ quiet: true });
      showBanner("Deleted zone geometry and registry entries.", "success");
    }
  });
}

function syncMapLayers() {
  if (!state.map.instance || !state.snapshot) {
    return;
  }

  state.map.savedGroup.clearLayers();
  state.map.zoneLayers.clear();

  state.snapshot.zones.forEach((zone) => {
    if (!zone.geometry) {
      return;
    }
    const layer = L.geoJSON(zone.geometry, {
      style: {
        color: "#1d6b39",
        weight: 2,
        fillOpacity: 0.18,
      },
    });
    layer.eachLayer((innerLayer) => {
      innerLayer.zoneId = zone.id;
      innerLayer.bindPopup(`<strong>${zone.name}</strong><br>${formatArea(zone.areaSqFt)}`);
      state.map.savedGroup.addLayer(innerLayer);
      state.map.zoneLayers.set(zone.id, innerLayer);
    });
  });

  renderDraftLayer();

  if (state.currentView === "lawn-map") {
    scheduleMapViewportRefresh();
  }
}

function setDraftLayer(geometry, areaSqFt) {
  stateManager.setMapPendingGeometry(clone(geometry));
  stateManager.setMapPendingAreaSqFt(areaSqFt || null);
  refs.mapOnboard.hidden = true;
  refs.mapOnboard.setAttribute("aria-hidden", "true");
  renderDraftLayer();
}

function clearDraftGeometry() {
  stateManager.setMapPendingGeometry(null);
  stateManager.setMapPendingAreaSqFt(null);
  if (state.map.draftLayer && state.map.instance) {
    state.map.instance.removeLayer(state.map.draftLayer);
    stateManager.setMapDraftLayer(null);
  }
  const hasMappedZones = state.snapshot?.zones?.some((zone) => zone.geometry);
  refs.mapOnboard.hidden = Boolean(hasMappedZones);
  refs.mapOnboard.setAttribute("aria-hidden", hasMappedZones ? "true" : "false");
  refs.zoneFormStatus.textContent = "Draw a polygon on the map, then save the zone.";
}

function locateMap() {
  if (!navigator.geolocation || !state.map.instance) {
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.map.instance.flyTo(
        [position.coords.latitude, position.coords.longitude],
        18,
        { duration: 0.7 }
      );
    },
    () => {
      showBanner("Your location could not be determined.", "warning");
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function focusSavedZones() {
  if (!state.map.instance || state.map.savedGroup.getLayers().length === 0) {
    return;
  }
  state.map.instance.fitBounds(state.map.savedGroup.getBounds(), { padding: [24, 24] });
}

function focusZone(zoneId) {
  const layer = state.map.zoneLayers.get(zoneId);
  if (!layer || !state.map.instance) {
    return;
  }
  state.map.instance.invalidateSize();
  state.map.instance.fitBounds(layer.getBounds(), { padding: [24, 24] });
  layer.openPopup?.();
}

function shouldAutoFocusSavedZones() {
  if (!state.map.instance || !state.map.savedGroup) {
    return false;
  }
  const hasSavedLayers = state.map.savedGroup.getLayers().length > 0;
  if (!hasSavedLayers) {
    return false;
  }
  return state.map.instance.getZoom() <= 5;
}

function scheduleMapViewportRefresh() {
  if (!state.map.instance) {
    return;
  }
  setTimeout(() => {
    state.map.instance.invalidateSize();
    if (shouldAutoFocusSavedZones()) {
      focusSavedZones();
    }
  }, 120);
}

function currentZoneGeometry(zoneId) {
  return byId(state.snapshot.zones, zoneId)?.geometry || null;
}

function currentZoneArea(zoneId) {
  return byId(state.snapshot.zones, zoneId)?.areaSqFt || null;
}

function validateZoneFeature(feature) {
  try {
    if (!feature?.geometry) {
      return { error: "Zone geometry is missing." };
    }
    const type = feature.geometry.type;
    if (type !== "Polygon" && type !== "MultiPolygon") {
      return { error: "Zones must be saved as polygons." };
    }
    const kinks = turf.kinks(feature);
    if (kinks.features.length > 0) {
      return { error: "This polygon intersects itself. Adjust the shape and try again." };
    }
    const areaSqM = turf.area(feature);
    const areaSqFt = Math.round(areaSqM * 10.7639);
    if (!Number.isFinite(areaSqFt) || areaSqFt <= 0) {
      return { error: "Zone area must be greater than zero." };
    }
    return {
      areaSqFt,
      error: null,
    };
  } catch (error) {
    return { error: "This polygon could not be validated safely." };
  }
}

function activateView(target) {
  state.currentView = target;
  refs.views.forEach((view) => view.classList.toggle("active", view.id === target));
  refs.navButtons.forEach((button) =>
    button.classList.toggle("active", button.dataset.sectionTarget === target)
  );
  if (target === "lawn-map" && state.map.instance) {
    scheduleMapViewportRefresh();
  }
}

function clearCachedAppState() {
  return;
}

let _bannerTimer = null;
function showBanner(message, tone = "success") {
  clearTimeout(_bannerTimer);
  refs.statusBanner.hidden = false;
  refs.statusBanner.textContent = message;
  refs.statusBanner.classList.toggle("is-warning", tone === "warning");
  refs.statusBanner.classList.toggle("is-danger", tone === "danger");
  if (tone !== "danger") {
    _bannerTimer = setTimeout(clearBanner, 4000);
  }
}

function clearBanner() {
  refs.statusBanner.hidden = true;
  refs.statusBanner.textContent = "";
  refs.statusBanner.classList.remove("is-warning", "is-danger");
}

function calculateReadinessScore() {
  let score = 28;
  const zoneCount = state.snapshot.zones.length;
  const mappedZones = state.dashboard.mappedZones || 0;
  const upcomingCount = state.dashboard.upcoming.length;
  const lastMow = state.snapshot.mowingLogs[0] || null;

  if (state.snapshot.profile.propertyName) score += 6;
  if (state.dashboard.totalAreaSqFt > 0) score += 8;
  if (zoneCount > 0) score += 12;
  if (mappedZones > 0) {
    const mappedRatio = zoneCount ? mappedZones / zoneCount : 0;
    score += Math.round(Math.min(18, mappedRatio * 18));
  }
  if (state.snapshot.products.length > 0) score += 8;
  if (state.snapshot.treatments.length > 0) score += 10;
  if (upcomingCount > 0) score += Math.min(10, upcomingCount * 3);
  if (lastMow) {
    score += 8;
    if (daysSince(lastMow.date) <= 7) {
      score += 8;
    }
  }
  return Math.min(96, score);
}

function linkedEventCount(zoneId) {
  return (
    state.snapshot.treatments.filter((item) => item.zoneId === zoneId).length +
    state.snapshot.mowingLogs.filter((item) => item.zoneId === zoneId).length
  );
}

function zoneName(zoneId) {
  return byId(state.snapshot.zones, zoneId)?.name || "Unassigned";
}

function productName(productId) {
  return byId(state.snapshot.products, productId)?.name || "No product";
}

function byId(items, id) {
  return items.find((item) => item.id === id) || null;
}

function countBy(items, getKey) {
  return items.reduce((map, item) => {
    const key = getKey(item);
    if (!key) {
      return map;
    }
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map());
}

function groupBy(items, getKey) {
  return items.reduce((map, item) => {
    const key = getKey(item);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(item);
    return map;
  }, new Map());
}

function sum(items, getValue) {
  return items.reduce((total, item) => total + (getValue(item) || 0), 0);
}

function daysSince(isoDate) {
  const target = new Date(`${isoDate}T00:00:00`);
  const today = new Date();
  target.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today - target) / 86400000));
}

function formatArea(area) {
  return area ? `${Number(area).toLocaleString()} sq ft` : "Not set";
}

function formatShortDate(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatDayLabel(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatWeekdayShort(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
  });
}

function formatDateTime(value) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeText(value, maxLength = 80) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clone(value) {
  return value ? structuredClone(value) : null;
}
