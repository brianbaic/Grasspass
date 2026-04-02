import { state, stateManager } from "../state.js";
import { refs } from "../refs.js";

let syncMapLayersCallback = null;
let openTimelineDayCallback = null;

export function setViewCallbacks(callbacks = {}) {
  syncMapLayersCallback = callbacks.syncMapLayers || null;
  openTimelineDayCallback = callbacks.openTimelineDay || null;
}

export function renderAll() {
  renderAuth();
  renderAccount();
  if (!state.auth?.user || !state.snapshot || !state.dashboard || !state.health || !state.storage) {
    return;
  }

  renderOverview();
  renderGettingStarted();
  renderTimeline();
  renderSelectors();
  renderProducts();
  renderTreatments();
  renderMowing();
  renderZones();
  renderHealth();
  renderStorageSettings();
  renderGoogleStatus();
  renderRachioStatus();
  renderBackups();
  renderQueue();
  renderProfileForm();
  renderInvites();
  syncMapLayersCallback?.();
}

export function renderOverview() {
  const nextEvent = state.dashboard.nextEvent;
  const lastMow = state.snapshot.mowingLogs[0] || null;
  const totalZones = state.snapshot.zones.length;
  const mappedZones = state.snapshot.zones.filter((item) => item.geometry).length;
  const readiness = calculateReadinessScore();
  const propertyName = state.snapshot.profile.propertyName || "Home Lawn";
  const dayGreeting = getDayGreeting();
  const mowingCadence = getMowingCadence(lastMow);
  const plannerDepth = getPlannerDepth();
  const weeklySnapshot = buildWeeklySnapshot(state.weeklyTimeline || state.timeline);
  const mappingCoverage = getMappingCoverage(
    mappedZones,
    totalZones,
    state.dashboard.totalAreaSqFt
  );
  const estateStatus = getEstateStatus(readiness, nextEvent, mappedZones) || {
    label: "Getting Started",
    className: "is-starting",
  };

  refs.heroMeta.textContent =
    "Your field guide for mapping the lawn, planning treatments, logging mowing, and keeping the season in motion.";
  refs.overviewGreeting.textContent = `${dayGreeting}, ${propertyName}.`;
  refs.overviewCopy.textContent = buildOverviewCopy({
    propertyName,
    mappedZones,
    nextEvent,
    totalAreaSqFt: state.dashboard.totalAreaSqFt,
  });
  refs.estateStatus.textContent = `Plan Status: ${estateStatus.label}`;
  refs.estateStatus.className = `estate-pill ${estateStatus.className}`;
  refs.growthDial.style.setProperty("--progress", String(readiness));
  refs.growthDialValue.textContent = `${readiness}%`;
  refs.careRhythmGuideButton.hidden = readiness >= 100;
  refs.readinessTitle.textContent =
    readiness >= 84
      ? "The lawn plan feels composed and in motion."
      : readiness >= 62
        ? "The lawn story is taking shape."
        : "A few core routines will anchor the season.";
  refs.readinessNote.textContent =
    nextEvent
      ? `Next on deck: ${nextEvent.title} for ${nextEvent.zoneName} on ${formatDayLabel(nextEvent.date)}.`
      : "Use the planner to line up the next treatment or mowing pass for the week ahead.";

  refs.overviewMetrics.replaceChildren(
    renderOverviewMetric("Property Story", mappingCoverage.value, mappingCoverage.copy),
    renderOverviewMetric("Season Plan", plannerDepth.value, plannerDepth.copy),
    renderOverviewMetric("Mowing Rhythm", mowingCadence.value, mowingCadence.copy)
  );

  refs.plannerFocusTitle.textContent = weeklySnapshot.title;
  refs.plannerFocusCopy.textContent = weeklySnapshot.copy;
  refs.plannerFocusMeta.replaceChildren();
  refs.plannerFocusMeta.append(
    createMetaChip(weeklySnapshot.totalLabel),
    createMetaChip(weeklySnapshot.treatmentLabel),
    createMetaChip(weeklySnapshot.mowingLabel),
    createMetaChip(weeklySnapshot.wateringLabel)
  );
  const selectedOverviewDate = resolveSelectedOverviewDate(weeklySnapshot.days);
  const selectedItems = weeklySnapshot.items.filter((item) => item.date === selectedOverviewDate);
  renderList(
    refs.weeklySnapshotDays,
    weeklySnapshot.days,
    renderWeeklySnapshotDay,
    "The week view will appear here.",
    "view_week"
  );
  renderList(
    refs.weeklySnapshotList,
    selectedItems,
    renderWeeklySnapshotItem,
    `No activity is scheduled or logged for ${formatDayLabel(selectedOverviewDate)}.`,
    "event_busy"
  );

  renderList(
    refs.overviewUpcoming,
    state.dashboard.upcoming.slice(0, 3),
    renderOverviewShowcaseCard,
    "No upcoming activities yet.",
    "upcoming"
  );
  renderList(
    refs.overviewActivity,
    state.dashboard.activity,
    renderOverviewActivityCard,
    "No recent activity yet.",
    "history"
  );
  renderHortOrHoax(state.hortFact);
}

export function renderGettingStarted() {
  const readiness = calculateReadinessScore();
  const checklist = buildCareRhythmChecklist();
  const outstanding = checklist.filter((item) => !item.done);

  refs.gettingStartedTitle.textContent =
    readiness >= 100
      ? "Care rhythm is fully established."
      : "Build the first 100% season rhythm.";
  refs.gettingStartedCopy.textContent =
    readiness >= 100
      ? "The core routines are in place. Use this page as a reference for how GrassPass stays organized through the season."
      : "GrassPass raises your care rhythm as you complete the foundational setup and keep real lawn work flowing through the app.";
  refs.gettingStartedScore.textContent = `${readiness}%`;
  refs.gettingStartedScoreCopy.textContent =
    readiness >= 100
      ? "Every core setup task is complete and the system has enough data to keep the season moving."
      : `${outstanding.length} core step${outstanding.length === 1 ? "" : "s"} still need attention before the rhythm is fully built.`;
  refs.gettingStartedProgressBar.style.width = `${Math.max(4, readiness)}%`;

  renderList(
    refs.gettingStartedChecklist,
    checklist,
    renderGettingStartedChecklistItem,
    "Everything needed for the first 100% rhythm is already complete.",
    "task_alt"
  );
  renderList(
    refs.gettingStartedAreas,
    buildGettingStartedAreas(),
    renderGettingStartedAreaCard,
    "The main workspace areas will appear here.",
    "grid_view"
  );
  const nextAction = getGettingStartedNextAction(outstanding[0]) || {
    target: "overview",
    label: "Back To Overview",
  };
  refs.gettingStartedNextStep.textContent =
    outstanding[0]?.nextStep || "Keep logging real lawn work so the system stays current.";
  if (refs.gettingStartedNextAction) {
    refs.gettingStartedNextAction.dataset.sectionTarget = nextAction.target;
    refs.gettingStartedNextAction.textContent = nextAction.label;
    refs.gettingStartedNextAction.hidden = readiness >= 100;
  }
}

export function renderTimeline() {
  if (!state.timeline) {
    return;
  }

  refs.timelineRangeWeek.classList.toggle("active", state.timeline.range === "week");
  refs.timelineRangeMonth.classList.toggle("active", state.timeline.range === "month");
  const timelineLabel = state.timeline?.window?.label || "Current plan window";
  const timelineTotal = Number(state.timeline?.summary?.total || 0);
  refs.timelineCaption.textContent = `${timelineLabel} • ${timelineTotal} total event${timelineTotal === 1 ? "" : "s"}`;

  const selectedTimelineDate = resolveSelectedTimelineDate(state.timeline.days);
  const selectedDay = state.timeline.days.find((day) => day.date === selectedTimelineDate) || null;
  const selectedItems = state.timeline.items.filter((item) => item.date === selectedTimelineDate);

  refs.timelineDays.replaceChildren();
  state.timeline.days.forEach((day) => {
    const button = document.createElement("button");
    button.type = "button";
    const classes = ["timeline-day"];
    if ((day.eventCount || 0) > 0) {
      classes.push("is-busy");
    }
    if (day.date === todayIso()) {
      classes.push("is-today");
    }
    if (day.date === selectedTimelineDate) {
      classes.push("is-selected");
    }
    button.className = classes.join(" ");
    button.innerHTML = `
      <div class="timeline-day-head">
        <p class="timeline-day-label">${escapeHtml(formatWeekdayShort(day.date))}</p>
        ${day.date === todayIso() ? '<span class="weekly-snapshot-today-badge">Today</span>' : ""}
      </div>
      <p class="timeline-day-date">${escapeHtml(formatShortDate(day.date))}</p>
      <p class="timeline-day-count">${day.eventCount} event${day.eventCount === 1 ? "" : "s"}</p>
      ${renderInlineWeather(day.weather)}
    `;
    button.addEventListener("click", () => {
      stateManager.setTimelineSelectedDate(day.date);
      renderTimeline();
    });
    refs.timelineDays.appendChild(button);
  });

  refs.timelineEvents.replaceChildren();
  const block = document.createElement("article");
  block.className = "panel";
  block.id = `timeline-day-${selectedTimelineDate}`;

  const head = document.createElement("div");
  head.className = "section-head";
  head.innerHTML = `
    <div>
      <h3>${escapeHtml(formatDayLabel(selectedTimelineDate))}</h3>
      ${renderInlineWeather(selectedDay?.weather)}
    </div>
    <span class="pill">${selectedItems.length} item${selectedItems.length === 1 ? "" : "s"}</span>
  `;
  block.appendChild(head);

  const list = document.createElement("div");
  list.className = "list-stack";
  if (selectedItems.length === 0) {
    list.appendChild(
      renderEmpty(`No planner activity is scheduled or logged for ${formatDayLabel(selectedTimelineDate)}.`, "event_busy")
    );
  } else {
    selectedItems.forEach((item) => list.appendChild(renderTimelineCard(item)));
  }
  block.appendChild(list);

  refs.timelineEvents.appendChild(block);
}

export function renderOverviewMetric(label, value, copy) {
  const card = document.createElement("article");
  card.className = "overview-metric-card";
  card.innerHTML = `
    <p class="overview-metric-label">${escapeHtml(label)}</p>
    <p class="overview-metric-value">${escapeHtml(value)}</p>
    <p class="overview-metric-copy">${escapeHtml(copy)}</p>
  `;
  return card;
}

export function renderHortOrHoax(item) {
  if (!item) {
    refs.hortHoaxClaim.textContent = "Loading lawn tip...";
    refs.hortHoaxExplanation.textContent = "";
    refs.hortHoaxBestPractice.textContent = "";
    refs.hortHoaxCategory.textContent = "";
    refs.hortHoaxVerdictBadge.textContent = "";
    refs.hortHoaxVerdictBadge.className = "";
    refs.hortHoaxPrevBtn.disabled = true;
    return;
  }
  const isHort = item.verdict === "hort";
  refs.hortHoaxClaim.textContent = item.claim;
  refs.hortHoaxExplanation.textContent = item.explanation;
  refs.hortHoaxBestPractice.textContent = item.bestPractice ? `Best practice: ${item.bestPractice}` : "";
  refs.hortHoaxCategory.textContent = item.category
    ? item.category.charAt(0).toUpperCase() + item.category.slice(1)
    : "";
  const badge = refs.hortHoaxVerdictBadge;
  badge.textContent = isHort ? "✓ Horticultural Fact" : "✗ Common Hoax";
  badge.className = isHort
    ? "flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-bold font-headline bg-primary-container text-on-primary-container"
    : "flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-bold font-headline bg-error-container text-on-error-container";
  refs.hortHoaxPrevBtn.disabled = state.hortFactIndex <= 0;
}

export function renderSelectors() {
  const zones = state.snapshot.zones;
  const products = state.snapshot.products;

  hydrateSelect(refs.treatmentZone, zones, {
    placeholder: "Select a zone",
    getLabel: (item) => item.name,
    selectedValue: refs.treatmentZone.value,
  });
  hydrateSelect(refs.mowingZone, zones, {
    placeholder: "Select a zone",
    getLabel: (item) => item.name,
    selectedValue: refs.mowingZone.value,
  });
  hydrateSelect(refs.treatmentProduct, products, {
    placeholder: "No product linked",
    getLabel: (item) => item.name,
    selectedValue: refs.treatmentProduct.value,
    allowBlank: true,
  });
}

export function renderProducts() {
  const treatmentUsage = countBy(state.snapshot.treatments, (item) => item.productId);
  renderList(
    refs.productsList,
    state.snapshot.products,
    (product) => {
      const item = createEntityCard({
        title: product.name,
        badge: product.category,
        meta: [
          product.activeIngredient || "No active ingredient listed",
          product.coverageRateSqFt
            ? `${product.coverageRateSqFt.toLocaleString()} sq ft/${product.unit}`
            : "No coverage rate",
          product.quantity ? `${product.quantity} ${product.unit} on hand` : "No quantity",
          `${treatmentUsage.get(product.id) || 0} treatment links`,
        ],
        notes: product.notes,
      });
      item.appendChild(
        createActionRow([
          actionChip("Edit", "chip chip-edit", "edit", product.id),
          actionChip("Delete", "chip chip-delete", "delete", product.id),
        ])
      );
      return item;
    },
    "No products saved yet.",
    "science"
  );
}

export function renderTreatments() {
  renderList(
    refs.treatmentsList,
    state.snapshot.treatments,
    (treatment) => {
      const item = createEntityCard({
        title: `${treatment.type} • ${zoneName(treatment.zoneId)}`,
        badge: treatment.status,
        meta: [
          formatDayLabel(treatment.date),
          treatment.productId ? productName(treatment.productId) : "No product linked",
          treatment.repeatDays ? `Repeats every ${treatment.repeatDays} day(s)` : "One-time plan",
        ],
        notes: treatment.notes,
      });
      const actions = [actionChip("Edit", "chip chip-edit", "edit", treatment.id)];
      if (treatment.status !== "Completed") {
        actions.push(actionChip("Complete", "chip chip-complete", "complete", treatment.id));
      }
      actions.push(actionChip("Delete", "chip chip-delete", "delete", treatment.id));
      item.appendChild(createActionRow(actions));
      return item;
    },
    "No treatments scheduled yet.",
    "calendar_month"
  );
}

export function renderMowing() {
  renderList(
    refs.mowingList,
    state.snapshot.mowingLogs,
    (entry) => {
      const item = createEntityCard({
        title: `${zoneName(entry.zoneId)} • ${entry.heightInches}" cut`,
        badge: "Mowing",
        meta: [
          formatDayLabel(entry.date),
          `${entry.durationMinutes} minutes`,
          entry.clippings,
        ],
        notes: entry.notes,
      });
      item.appendChild(
        createActionRow([
          actionChip("Edit", "chip chip-edit", "edit", entry.id),
          actionChip("Delete", "chip chip-delete", "delete", entry.id),
        ])
      );
      return item;
    },
    "No mowing history yet.",
    "content_cut"
  );
}

export function renderZones() {
  const mappedCount = state.snapshot.zones.filter((item) => item.geometry).length;
  refs.zoneAreaReadout.textContent = mappedCount > 0
    ? `Mapped zone area: ${formatArea(sum(state.snapshot.zones, (item) => item.areaSqFt || 0))}`
    : "Draw a polygon to create the first mapped zone.";
  const showMapOnboard = mappedCount === 0 && !state.map.pendingGeometry;
  refs.mapOnboard.hidden = !showMapOnboard;
  refs.mapOnboard.setAttribute("aria-hidden", showMapOnboard ? "false" : "true");

  renderList(
    refs.zonesList,
    state.snapshot.zones,
    (zone) => {
      const usage = linkedEventCount(zone.id);
      const item = createEntityCard({
        title: zone.name,
        badge: zone.geometry ? "Mapped" : "Registry Only",
        meta: [
          zone.surface,
          zone.areaSqFt ? formatArea(zone.areaSqFt) : "No area saved",
          `${usage} linked event${usage === 1 ? "" : "s"}`,
        ],
        notes: zone.notes,
      });
      item.appendChild(
        createActionRow([
          actionChip("Edit", "chip chip-edit", "edit", zone.id),
          actionChip("Focus", "chip chip-edit", "focus", zone.id),
          actionChip("Delete", "chip chip-delete", "delete", zone.id),
        ])
      );
      return item;
    },
    "No zones in the registry yet.",
    "yard"
  );
}

export function renderHealth() {
  refs.healthList.replaceChildren();
  const isAdmin = state.auth?.user?.role === "admin";
  const dbInsights = state.storage?.database?.insights;
  const cards = [
    {
      title: `Storage: ${state.health.storageMode}`,
      detail: `Schema v${state.health.schemaVersion}`,
    },
    {
      title: `${state.health.counts.mappedZones}/${state.health.counts.zones} mapped`,
      detail: "Zone geometry coverage",
    },
    {
      title: state.health.backup.label,
      detail: state.health.backup.lastBackupAt
        ? `Last run ${formatDateTime(state.health.backup.lastBackupAt)}`
        : "No backup yet",
    },
    {
      title: `${state.health.queue.failed} queue failures`,
      detail: `${state.health.queue.pending} pending • ${state.health.queue.synced} synced`,
    },
    {
      title: `${state.health.migrations} migrations`,
      detail: "Schema checkpoints recorded",
    },
  ];

  if (isAdmin && dbInsights) {
    cards.push(
      {
        title: `${dbInsights.users} users`,
        detail: "Registered accounts",
      },
      {
        title: `${dbInsights.fields} fields tracked`,
        detail: `${dbInsights.tables} grasspass_* tables detected`,
      },
      {
        title: `${dbInsights.records} records stored`,
        detail: "Total rows across core GrassPass tables",
      },
      {
        title: "DB insight refreshed",
        detail: dbInsights.generatedAt
          ? formatDateTime(dbInsights.generatedAt)
          : "Generated on request",
      }
    );
  }

  cards.forEach((card) => {
    const element = document.createElement("article");
    element.className = "mini-card";
    element.innerHTML = `<p class="item-title">${card.title}</p><p>${card.detail}</p>`;
    refs.healthList.appendChild(element);
  });
}

export function renderAuth() {
  if (!state.auth) {
    return;
  }

  const signedIn = Boolean(state.auth.user);
  refs.authOverlay.hidden = signedIn;
  if (signedIn) {
    clearAuthMessage();
    refs.authSetupForm.hidden = true;
    refs.authLoginForm.hidden = true;
    refs.authRegisterForm.hidden = true;
    return;
  }

  const setupRequired = state.auth.setupRequired;
  refs.authTitle.textContent = setupRequired
    ? "Create the first admin account"
    : state.authMode === "register"
      ? "Register with an invite"
      : "Sign in";
  refs.authCopy.textContent = setupRequired
    ? "The first registered account becomes the admin. After that, registration is invite only."
    : state.authMode === "register"
      ? "Use an invite code from the admin to create your account."
      : "Sign in to access your GrassPass workspace.";

  refs.authSetupForm.hidden = !setupRequired;
  refs.authLoginForm.hidden = setupRequired || state.authMode !== "login";
  refs.authRegisterForm.hidden = setupRequired || state.authMode !== "register";
}

export function renderAccount() {
  if (!state.auth?.user) {
    refs.profileLabel.textContent = "Sign In";
    refs.profileIcon.textContent = "account_circle";
    return;
  }

  refs.profileLabel.textContent = `${state.auth.user.displayName} (${state.auth.user.role})`;
  refs.profileIcon.textContent = "logout";
}

export function renderInvites() {
  const isAdmin = state.auth?.user?.role === "admin";
  refs.invitePanel.hidden = !isAdmin;
  if (!isAdmin) {
    return;
  }

  const invites = state.auth.invites || [];
  renderList(
    refs.inviteList,
    invites,
    (invite) =>
      createEntityCard({
        title: invite.code,
        badge: invite.usedAt ? "Used" : invite.role,
        meta: [
          invite.note || "No note",
          invite.usedAt ? `Redeemed ${formatDateTime(invite.usedAt)}` : "Ready to share",
        ],
      }),
    "No invite codes created yet.",
    "mail"
  );
}

export function renderStorageSettings() {
  // SQLite-only storage. No configuration needed.
  // This function is retained for compatibility but performs no actions.
}

export function renderGoogleStatus() {
  const google = state.snapshot.integrations.googleCalendar;
  refs.googleCalendarId.value = google.calendarId || "primary";
  refs.googleStatus.innerHTML = `
    <p class="item-title">${google.connected ? "Connected for one-way push" : "Disconnected"}</p>
    <p class="item-meta">${google.hasAccessToken ? "Server-side token present" : "No server-side access token stored"}</p>
    <p class="item-meta">${google.lastSyncAt ? `Last sync ${formatDateTime(google.lastSyncAt)}` : "No successful sync yet"}</p>
    <p class="item-meta">${google.lastError || "Queue is ready for manual resync or automatic processing."}</p>
  `;
}

export function renderRachioStatus() {
  const rachio = state.snapshot.integrations?.rachio || {};
  const lastSyncTime = rachio.lastSyncAt || null;
  if (refs.rachioApiKey) {
    refs.rachioApiKey.value = "";
  }

  const waterings = state.snapshot.waterings || [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thirtyDaysOut = new Date(today);
  thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);

  const scheduledCount = waterings.filter((watering) => {
    const wateringDate = new Date(watering.date);
    return wateringDate >= today && wateringDate <= thirtyDaysOut && !watering.completed;
  }).length;

  const lastSyncDisplay = lastSyncTime
    ? `Last sync ${formatDateTime(lastSyncTime)}`
    : "No successful sync yet";

  refs.rachioStatus.innerHTML = `
    <p class="item-title">${scheduledCount > 0 ? "Connected & scheduling" : "Ready to sync"}</p>
    <p class="item-meta">${scheduledCount} watering${scheduledCount === 1 ? "" : "s"} scheduled in next 30 days</p>
    <p class="item-meta">${rachio.hasApiKey ? "✓ API key stored" : "No API key configured yet"}</p>
    <p class="item-meta">${lastSyncDisplay}</p>
    <p class="item-meta">Click "Sync Schedule" to fetch your latest Rachio watering plan.</p>
  `;
}

export function renderBackups() {
  const history = state.snapshot.backups.history || [];
  renderList(
    refs.backupList,
    history,
    (item) =>
      createEntityCard({
        title: `${item.reason} backup`,
        badge: item.result,
        meta: [formatDateTime(item.createdAt), item.path || "No path recorded"],
      }),
    "No backups have been captured yet.",
    "backup"
  );
}

export function renderQueue() {
  renderList(
    refs.queueList,
    state.snapshot.syncQueue,
    (item) => {
      const card = createEntityCard({
        title: item.label,
        badge: item.status,
        meta: [
          formatDayLabel(item.date),
          item.action === "delete" ? "Delete remote event" : "Upsert remote event",
          `${item.attempts} attempt${item.attempts === 1 ? "" : "s"}`,
        ],
        notes: item.lastError,
      });
      if (item.status === "failed") {
        card.appendChild(
          createActionRow([actionChip("Retry", "chip chip-complete", "retry", item.id)])
        );
      }
      return card;
    },
    "The Google sync queue is currently empty.",
    "check_circle"
  );
}

export function renderProfileForm() {
  refs.profileName.value = state.snapshot.profile.propertyName || "";
  refs.profileLocation.value = state.snapshot.profile.location || "";
  refs.profileArea.value = state.snapshot.profile.manualAreaSqFt || "";
}

export function renderWeeklySnapshotDay(day) {
  const card = document.createElement("button");
  const classes = ["weekly-snapshot-day"];
  if ((day.eventCount || 0) > 0) {
    classes.push("is-busy");
  }
  if (day.date === todayIso()) {
    classes.push("is-today");
  }
  if (day.date === state.overviewSelectedDate) {
    classes.push("is-selected");
  }
  card.type = "button";
  card.className = classes.join(" ");
  card.innerHTML = `
    <div class="weekly-snapshot-day-head">
      <p class="weekly-snapshot-day-label">${escapeHtml(formatWeekdayShort(day.date))}</p>
      ${day.date === todayIso() ? '<span class="weekly-snapshot-today-badge">Today</span>' : ""}
    </div>
    <p class="weekly-snapshot-day-date">${escapeHtml(formatShortDate(day.date))}</p>
    ${renderInlineWeather(day.weather)}
    <p class="weekly-snapshot-day-count">${day.eventCount || 0} item${day.eventCount === 1 ? "" : "s"}</p>
  `;
  card.addEventListener("click", () => {
    stateManager.setOverviewSelectedDate(day.date);
    renderOverview();
  });
  return card;
}

export function renderWeeklySnapshotItem(item) {
  const card = document.createElement("article");
  const typeClass =
    item.eventType === "Treatment"
      ? "is-treatment"
      : item.eventType === "Mowing"
        ? "is-mowing"
        : "";
  card.className = `weekly-snapshot-item ${typeClass}`.trim();
  card.innerHTML = `
    <div class="weekly-snapshot-item-head">
      <div>
        <p class="weekly-snapshot-item-type">${escapeHtml(item.eventType || "Event")}</p>
        <p class="weekly-snapshot-item-title">${escapeHtml(item.title || "Untitled event")}</p>
      </div>
      <p class="weekly-snapshot-item-date">${escapeHtml(formatShortDate(item.date))}</p>
    </div>
    <p class="weekly-snapshot-item-copy">${escapeHtml(item.zoneName || "Unassigned")}${item.detail ? ` • ${escapeHtml(item.detail)}` : ""}</p>
    <span class="weekly-snapshot-item-status">${escapeHtml(item.status || "Scheduled")}</span>
  `;
  return card;
}

export function renderOverviewShowcaseCard(item) {
  const card = document.createElement("article");
  const typeClass =
    item.eventType === "Mowing" ? "is-mowing" : "is-treatment";
  card.className = `overview-showcase-card ${typeClass}`.trim();
  card.innerHTML = `
    <div class="overview-showcase-overlay"></div>
    <div class="overview-showcase-content">
      <span class="overview-date-badge">${escapeHtml(formatShortDate(item.date))}</span>
      <h3>${escapeHtml(item.title || item.eventType || "Upcoming")}</h3>
      <p>${escapeHtml(item.zoneName || "Unassigned")}</p>
      <p>${escapeHtml(item.detail || item.status || "Planned event")}</p>
    </div>
  `;
  return card;
}

export function renderOverviewActivityCard(item) {
  const card = document.createElement("article");
  card.className = "overview-activity-card";
  const icon = document.createElement("span");
  icon.className = "material-symbols-outlined overview-activity-icon";
  icon.textContent =
    item.eventType === "Mowing"
      ? "content_cut"
      : item.eventType === "Watering"
        ? "water_drop"
        : "event";

  const body = document.createElement("div");
  body.innerHTML = `
    <p class="item-title">${escapeHtml(item.title || item.eventType || "Recent activity")}</p>
    <p class="item-meta">${escapeHtml(formatDayLabel(item.date))}${item.zoneName ? ` • ${escapeHtml(item.zoneName)}` : ""}</p>
    <p class="item-meta">${escapeHtml(item.detail || item.status || "Logged")}</p>
  `;

  card.appendChild(icon);
  card.appendChild(body);
  return card;
}

export function renderGettingStartedChecklistItem(item) {
  const card = document.createElement("article");
  card.className = `getting-started-checklist-item ${item.done ? "is-complete" : "is-outstanding"}`;
  card.innerHTML = `
    <div class="getting-started-checklist-head">
      <span class="material-symbols-outlined getting-started-checklist-icon">${item.done ? "task_alt" : "radio_button_unchecked"}</span>
      <div>
        <p class="item-title">${escapeHtml(item.title)}</p>
        <p class="item-meta">${escapeHtml(item.copy)}</p>
      </div>
    </div>
    <p class="getting-started-next-copy">${escapeHtml(item.nextStep)}</p>
  `;
  return card;
}

export function renderGettingStartedAreaCard(item) {
  const card = document.createElement("article");
  card.className = "getting-started-area-card";
  card.innerHTML = `
    <p class="item-title">${escapeHtml(item.title)}</p>
    <p class="item-meta">${escapeHtml(item.copy)}</p>
  `;
  return card;
}

export function renderDraftLayer() {
  if (!state.map.instance) {
    return;
  }

  if (state.map.draftLayer) {
    state.map.instance.removeLayer(state.map.draftLayer);
    stateManager.setMapDraftLayer(null);
  }

  if (!state.map.pendingGeometry) {
    return;
  }

  const draftLayer = L.geoJSON(state.map.pendingGeometry, {
    style: {
      color: "#c76d3a",
      weight: 3,
      dashArray: "8 6",
      fillOpacity: 0.08,
    },
  }).addTo(state.map.instance);
  stateManager.setMapDraftLayer(draftLayer);
}

export function renderList(container, items, renderer, emptyMessage, emptyIcon) {
  container.replaceChildren();
  if (!items || items.length === 0) {
    container.appendChild(renderEmpty(emptyMessage, emptyIcon));
    return;
  }
  items.forEach((item) => container.appendChild(renderer(item)));
}

export function renderTimelineCard(item) {
  return createEntityCard({
    title: `${item.eventType} • ${item.title}`,
    badge: item.status,
    meta: [formatDayLabel(item.date), item.zoneName, item.detail],
    notes: item.isProjected ? "Projected recurring event" : item.notes,
  });
}

export function renderEmpty(message, icon = "inbox") {
  const wrap = document.createElement("div");
  wrap.className = "empty";
  const iconElement = document.createElement("span");
  iconElement.className = "material-symbols-outlined empty-icon";
  iconElement.textContent = icon;
  const text = document.createElement("p");
  text.className = "empty-message";
  text.textContent = message;
  wrap.appendChild(iconElement);
  wrap.appendChild(text);
  return wrap;
}

function clearAuthMessage() {
  refs.authMessage.hidden = true;
  refs.authMessage.textContent = "";
}

function buildOverviewCopy(input) {
  if (input.nextEvent) {
    return `${input.propertyName} has ${input.mappedZones} mapped zone${input.mappedZones === 1 ? "" : "s"}, and the next planned move is ${input.nextEvent.title} on ${formatShortDate(input.nextEvent.date)}.`;
  }
  if (input.mappedZones > 0) {
    return `${input.propertyName} is mapped across ${formatArea(input.totalAreaSqFt)}. Use the planner to turn those zones into an actual season plan.`;
  }
  return `${input.propertyName} is ready for a lawn map, a working planner, and a mowing rhythm that feels intentional instead of improvised.`;
}

function getDayGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Morning";
  if (hour < 18) return "Afternoon";
  return "Evening";
}

function getMowingCadence(lastMow) {
  if (!lastMow) {
    return {
      value: "No mow logged",
      copy: "Log the next cut to start building mowing rhythm.",
    };
  }
  const days = daysSince(lastMow.date);
  if (days <= 4) {
    return {
      value: "On rhythm",
      copy: `Last cut ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}.`,
    };
  }
  if (days <= 8) {
    return {
      value: "Due soon",
      copy: `Last cut ${days} days ago. The lawn is nearing the next pass.`,
    };
  }
  return {
    value: "Needs attention",
    copy: `Last cut ${days} days ago. A new mowing log would re-establish cadence.`,
  };
}

function getPlannerDepth() {
  const upcoming = state.dashboard.upcoming.length;
  if (upcoming === 0) {
    return {
      value: "Open canvas",
      copy: "No upcoming work is on the planner yet.",
    };
  }
  if (upcoming <= 2) {
    return {
      value: "Taking shape",
      copy: "A few upcoming tasks are already giving the season structure.",
    };
  }
  return {
    value: "In motion",
    copy: `${upcoming} upcoming tasks are already layered into the lawn plan.`,
  };
}

function buildWeeklySnapshot(timeline) {
  if (!timeline) {
    return {
      title: "This week is coming into focus.",
      copy: "Pulling the current weekly planner view now.",
      totalLabel: "Loading week",
      treatmentLabel: "Treatments loading",
      mowingLabel: "Mowing loading",
      days: [],
      items: [],
    };
  }

  const activeDays = (timeline.days || []).filter((day) => day.eventCount > 0).length;
  const { total = 0, treatments = 0, mowing = 0, waterings = 0 } = timeline.summary || {};
  const timelineLabel = timeline?.window?.label || "This period";

  if (total === 0) {
    return {
      title: "This week is still open.",
      copy: `${timelineLabel} has no logged mowing or scheduled treatments yet.`,
      totalLabel: "0 items this week",
      treatmentLabel: "0 treatments",
      mowingLabel: "0 mowing entries",
      wateringLabel: "0 scheduled waterings",
      days: timeline.days || [],
      items: [],
    };
  }

  return {
    title:
      total === 1
        ? "One lawn action is shaping this week."
        : `${total} lawn actions are shaping this week.`,
    copy: `${timelineLabel} carries ${treatments} treatment${treatments === 1 ? "" : "s"}, ${mowing} mowing item${mowing === 1 ? "" : "s"}, and ${waterings} scheduled watering${waterings === 1 ? "" : "s"} across ${activeDays} active day${activeDays === 1 ? "" : "s"}.`,
    totalLabel: `${total} item${total === 1 ? "" : "s"} this week`,
    treatmentLabel: `${treatments} treatment${treatments === 1 ? "" : "s"}`,
    mowingLabel: `${mowing} mowing item${mowing === 1 ? "" : "s"}`,
    wateringLabel: `${waterings} scheduled watering${waterings === 1 ? "" : "s"}`,
    days: timeline.days || [],
    items: (timeline.items || []).slice(0, 4),
  };
}

function getMappingCoverage(mappedZones, totalZones, totalAreaSqFt) {
  if (mappedZones === 0) {
    return {
      value: "Needs map",
      copy: "Draw the first zone to anchor the rest of the app.",
    };
  }
  if (mappedZones === totalZones) {
    return {
      value: "Fully mapped",
      copy: `${mappedZones} zone${mappedZones === 1 ? "" : "s"} connected across ${formatArea(totalAreaSqFt)}.`,
    };
  }
  return {
    value: "Partially mapped",
    copy: `${mappedZones} of ${totalZones} zones are already connected to the property plan.`,
  };
}

function getEstateStatus(score, nextEvent, mappedZones) {
  if (score >= 82) {
    return {
      label: "Optimal",
      className: "is-optimal",
    };
  }
  if (nextEvent || mappedZones > 0) {
    return {
      label: "In Motion",
      className: "is-moving",
    };
  }
  return {
    label: "Getting Started",
    className: "is-starting",
  };
}

function createMetaChip(text) {
  const chip = document.createElement("span");
  chip.className = "overview-meta-chip";
  chip.textContent = text;
  return chip;
}

function buildCareRhythmChecklist() {
  const zones = state.snapshot.zones || [];
  const mappedZones = zones.filter((item) => item.geometry).length;
  const products = state.snapshot.products || [];
  const treatments = state.snapshot.treatments || [];
  const mowingLogs = state.snapshot.mowingLogs || [];
  const hasUpcoming = (state.dashboard.upcoming || []).length > 0;
  const hasLocation = Boolean(state.snapshot.profile.location);
  const hasPropertyName = Boolean(state.snapshot.profile.propertyName);

  return [
    {
      done: hasPropertyName,
      title: "Name the property",
      copy: "A named property personalizes the dashboard and confirms the workspace is configured.",
      nextStep: "Open Settings and give the property a clear name.",
      targetView: "settings",
      actionLabel: "Open Settings",
    },
    {
      done: hasLocation,
      title: "Save a weather location",
      copy: "A valid address powers the forecast badges on the homepage and planner.",
      nextStep: "Use the Property Location field in Settings and choose one of the address suggestions.",
      targetView: "settings",
      actionLabel: "Add Weather Location",
    },
    {
      done: zones.length > 0,
      title: "Create the first zone",
      copy: "Zones are the foundation for planning, mowing, and watering activity.",
      nextStep: "Open Lawn Map and save the first zone record.",
      targetView: "lawn-map",
      actionLabel: "Open Lawn Map",
    },
    {
      done: mappedZones > 0,
      title: "Map at least one lawn area",
      copy: "Mapped polygons connect the plan to the real property layout.",
      nextStep: "Draw a polygon in the map so the property story is grounded in a real area.",
      targetView: "lawn-map",
      actionLabel: "Draw A Zone",
    },
    {
      done: products.length > 0,
      title: "Add at least one product",
      copy: "Products make treatment plans more useful and help inventory stay connected to work.",
      nextStep: "Add a fertilizer, herbicide, or amendment in Inventory.",
      targetView: "inventory",
      actionLabel: "Open Inventory",
    },
    {
      done: treatments.length > 0,
      title: "Plan the first treatment",
      copy: "A scheduled treatment creates the first real season plan inside the planner.",
      nextStep: "Open Planner and save a treatment for the coming days.",
      targetView: "planner",
      actionLabel: "Plan A Treatment",
    },
    {
      done: mowingLogs.length > 0,
      title: "Log the first mowing session",
      copy: "Mowing history is what turns the rhythm dial from setup into real maintenance cadence.",
      nextStep: "Record your latest mowing pass in the Planner.",
      targetView: "planner",
      actionLabel: "Log A Mowing",
    },
    {
      done: hasUpcoming,
      title: "Keep one next step on deck",
      copy: "The rhythm climbs when there is always another lawn action waiting in the queue.",
      nextStep: "Schedule the next treatment or watering so the plan stays active.",
      targetView: "planner",
      actionLabel: "Open Planner",
    },
  ];
}

function getGettingStartedNextAction(item) {
  if (!item) {
    return {
      target: "overview",
      label: "Back To Overview",
    };
  }

  return {
    target: item.targetView || "planner",
    label: item.actionLabel || "Go To Step",
  };
}

function buildGettingStartedAreas() {
  return [
    {
      title: "Overview",
      copy: "Tracks the care rhythm, upcoming activity, recent work, and the weekly weather snapshot.",
    },
    {
      title: "Planner",
      copy: "Used to schedule treatments, log mowing sessions, review daily weather, and navigate through weeks or months.",
    },
    {
      title: "Lawn Map",
      copy: "Used to draw the first zone and visually connect the property layout to the planning system.",
    },
    {
      title: "Inventory",
      copy: "Stores the products used by treatments so the work log stays connected to actual materials.",
    },
    {
      title: "Settings",
      copy: "Holds property details, weather location, storage, and external integrations like Rachio and Google Calendar.",
    },
  ];
}

function resolveSelectedOverviewDate(days) {
  if (!Array.isArray(days) || days.length === 0) {
    return todayIso();
  }
  if (days.some((day) => day.date === state.overviewSelectedDate)) {
    return state.overviewSelectedDate;
  }
  const today = todayIso();
  if (days.some((day) => day.date === today)) {
    stateManager.setOverviewSelectedDate(today);
    return today;
  }
  stateManager.setOverviewSelectedDate(days[0].date);
  return days[0].date;
}

function resolveSelectedTimelineDate(days) {
  if (!Array.isArray(days) || days.length === 0) {
    return todayIso();
  }
  if (days.some((day) => day.date === state.timelineSelectedDate)) {
    return state.timelineSelectedDate;
  }
  const today = todayIso();
  if (days.some((day) => day.date === today)) {
    stateManager.setTimelineSelectedDate(today);
    return today;
  }
  stateManager.setTimelineSelectedDate(days[0].date);
  return days[0].date;
}

function renderInlineWeather(weather) {
  if (!weather || weather.tempFHigh == null) {
    return "";
  }

  const lowText =
    weather.tempFLow == null ? "" : `<span class="weather-inline-low">${escapeHtml(String(weather.tempFLow))}F low</span>`;
  const rainText =
    weather.precipitationChance == null
      ? ""
      : `<span class="weather-inline-rain">${escapeHtml(String(weather.precipitationChance))}% rain</span>`;

  return `
    <div class="weather-inline" title="${escapeHtml(buildWeatherTitle(weather))}">
      <span class="material-symbols-outlined weather-inline-icon">${escapeHtml(getWeatherSymbol(weather.icon))}</span>
      <span class="weather-inline-high">${escapeHtml(String(weather.tempFHigh))}F</span>
      ${lowText}
      ${rainText}
    </div>
  `;
}

function buildWeatherTitle(weather) {
  const parts = [weather.condition];
  if (weather.tempFHigh != null) {
    parts.push(`High ${weather.tempFHigh}F`);
  }
  if (weather.tempFLow != null) {
    parts.push(`Low ${weather.tempFLow}F`);
  }
  if (weather.precipitationChance != null) {
    parts.push(`${weather.precipitationChance}% rain chance`);
  }
  return parts.filter(Boolean).join(" • ");
}

function getWeatherSymbol(icon) {
  switch (icon) {
    case "sunny":
      return "sunny";
    case "partly_cloudy_day":
      return "partly_cloudy_day";
    case "cloud":
      return "cloud";
    case "foggy":
      return "foggy";
    case "rainy":
      return "rainy";
    case "cloudy_snowing":
      return "cloudy_snowing";
    case "thunderstorm":
      return "thunderstorm";
    default:
      return "partly_cloudy_day";
  }
}

function createEntityCard(input) {
  const wrapper = document.createElement("article");
  wrapper.className = "item";

  const head = document.createElement("div");
  head.className = "item-row";
  head.innerHTML = `
    <div>
      <p class="item-title">${escapeHtml(input.title)}</p>
      ${input.meta
        .filter(Boolean)
        .map((line) => `<p class="item-meta">${escapeHtml(line)}</p>`)
        .join("")}
      ${input.notes ? `<p class="item-meta">${escapeHtml(input.notes)}</p>` : ""}
    </div>
    <span class="${input.badge === "Completed" ? "pill" : "pill pill-alt"}">${escapeHtml(input.badge)}</span>
  `;
  wrapper.appendChild(head);
  return wrapper;
}

function createActionRow(actions) {
  const row = document.createElement("div");
  row.className = "item-actions";
  actions.forEach((action) => row.appendChild(action));
  return row;
}

function actionChip(label, className, action, id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

function hydrateSelect(select, items, options) {
  const previous = options.selectedValue || "";
  select.replaceChildren();
  if (options.allowBlank !== false) {
    select.appendChild(new Option(options.placeholder, ""));
  }
  items.forEach((item) => {
    select.appendChild(new Option(options.getLabel(item), item.id));
  });
  if ([...select.options].some((item) => item.value === previous)) {
    select.value = previous;
  }
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
