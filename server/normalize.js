// State normalization utilities extracted from server.js

const {
  nowIso,
  todayIso,
  addDays,
  addDaysIso,
  daysBetween,
  sanitizeText,
  sanitizeNumber,
  sanitizeBoolean,
  sanitizeDate,
  sanitizeDateTime,
  normalizeEmail,
  normalizeGeometry,
  normalizeQueueStatus,
  isObject,
  findById,
  createId,
  sortZones,
  sortProducts,
  sortTreatments,
  sortMowingLogs,
  sortWaterings,
  compareIsoDate,
  compareDateTime,
  getTimelineWindow,
  getTotalArea,
  resolveZoneName,
  resolveProductName,
  summarizeQueue,
  getBackupFreshness,
  iterateDays,
  formatDayLabel,
} = require("./utils");
const { enrichTimelineDaysWithWeather } = require("./weather");

const SCHEMA_VERSION = 2;
const BACKUP_RETENTION = 12;
const DEFAULT_BACKUP_INTERVAL_MINUTES = 12 * 60;
const SESSION_COOKIE_NAME = "grasspass.session";
const SESSION_TTL_DAYS = 30;

async function mutateSnapshot(store, mutator) {
  const current = await store.readSnapshot();
  const draft = structuredClone(current);
  const next = await mutator(draft);
  const normalized = normalizeState(next || draft, { storageMode: store.mode });
  normalized.meta.updatedAt = nowIso();
  await store.writeSnapshot(normalized);
  return normalized;
}

function createDefaultState(storageMode = "file") {
  const now = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      createdAt: now,
      updatedAt: now,
      storageMode,
      source: "api-owned",
    },
    profile: {
      propertyName: "Home Lawn",
      location: "",
      manualAreaSqFt: null,
      updatedAt: now,
    },
    zones: [],
    products: [],
    treatments: [],
    mowingLogs: [],
    waterings: [],
    syncQueue: [],
    backups: {
      intervalMinutes: DEFAULT_BACKUP_INTERVAL_MINUTES,
      lastBackupAt: null,
      lastBackupPath: null,
      lastResult: "idle",
      history: [],
    },
    integrations: {
      googleCalendar: {
        connected: false,
        calendarId: "primary",
        accessToken: "",
        connectedAt: null,
        lastSyncAt: null,
        lastError: null,
        mode: "manual_access_token",
      },
      rachio: {
        connected: false,
        apiKey: "",
        lastSyncAt: null,
      },
    },
    migrationJournal: [],
  };
}

function createDefaultAuthState() {
  return {
    users: [],
    invites: [],
    sessions: [],
  };
}

function normalizeAuthState(rawState) {
  const safe = isObject(rawState) ? rawState : {};
  return {
    users: Array.isArray(safe.users)
      ? safe.users.map(normalizeAuthUser).filter((item) => item.email)
      : [],
    invites: Array.isArray(safe.invites)
      ? safe.invites.map(normalizeInvite).filter((item) => item.code)
      : [],
    sessions: Array.isArray(safe.sessions)
      ? safe.sessions.map(normalizeSession).filter((item) => item.userId && item.expiresAt)
      : [],
  };
}

function normalizeAuthUser(raw) {
  return {
    id: sanitizeText(raw?.id, 80) || createId("usr"),
    email: normalizeEmail(raw?.email),
    displayName: sanitizeText(raw?.displayName, 80),
    role: sanitizeText(raw?.role, 20) === "admin" ? "admin" : "member",
    passwordHash: sanitizeText(raw?.passwordHash, 512),
    createdAt: sanitizeDateTime(raw?.createdAt) || nowIso(),
    updatedAt: sanitizeDateTime(raw?.updatedAt) || nowIso(),
    lastLoginAt: sanitizeDateTime(raw?.lastLoginAt),
  };
}

function normalizeInvite(raw) {
  return {
    id: sanitizeText(raw?.id, 80) || createId("inv"),
    code: sanitizeText(raw?.code, 80).toUpperCase(),
    role: sanitizeText(raw?.role, 20) === "admin" ? "admin" : "member",
    note: sanitizeText(raw?.note, 120),
    createdByUserId: sanitizeText(raw?.createdByUserId, 80),
    createdAt: sanitizeDateTime(raw?.createdAt) || nowIso(),
    usedAt: sanitizeDateTime(raw?.usedAt),
    usedByUserId: sanitizeText(raw?.usedByUserId, 80),
  };
}

function normalizeSession(raw) {
  return {
    id: sanitizeText(raw?.id, 120) || createId("ses"),
    userId: sanitizeText(raw?.userId, 80),
    createdAt: sanitizeDateTime(raw?.createdAt) || nowIso(),
    expiresAt: sanitizeDateTime(raw?.expiresAt) || addDaysIso(SESSION_TTL_DAYS),
  };
}


function snapshotHasMeaningfulData(snapshot) {
  if (!snapshot) {
    return false;
  }
  return Boolean(
    snapshot.profile?.manualAreaSqFt ||
      (snapshot.profile?.propertyName &&
        snapshot.profile.propertyName !== createDefaultState().profile.propertyName) ||
      snapshot.profile?.location ||
      snapshot.zones?.length ||
      snapshot.products?.length ||
      snapshot.treatments?.length ||
      snapshot.mowingLogs?.length ||
      snapshot.syncQueue?.length ||
      snapshot.backups?.history?.length ||
      snapshot.migrationJournal?.length ||
      snapshot.integrations?.googleCalendar?.connected
  );
}

function normalizeState(rawState, options = {}) {
  const base = createDefaultState(options.storageMode || "file");
  const safe = isObject(rawState) ? rawState : {};
  const googleCalendarSafe = isObject(safe.integrations?.googleCalendar)
    ? safe.integrations.googleCalendar
    : {};
  const rachioSafe = isObject(safe.integrations?.rachio)
    ? safe.integrations.rachio
    : {};

  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      createdAt: sanitizeDateTime(safe.meta?.createdAt) || base.meta.createdAt,
      updatedAt: sanitizeDateTime(safe.meta?.updatedAt) || base.meta.updatedAt,
      storageMode:
        options.storageMode ||
        sanitizeText(safe.meta?.storageMode, 30) ||
        base.meta.storageMode,
      source: "api-owned",
    },
    profile: {
      propertyName:
        sanitizeText(safe.profile?.propertyName, 80) || base.profile.propertyName,
      location: sanitizeText(safe.profile?.location, 160),
      manualAreaSqFt: sanitizeNumber(safe.profile?.manualAreaSqFt, {
        min: 1,
        max: 250000,
        decimals: 0,
      }),
      updatedAt: sanitizeDateTime(safe.profile?.updatedAt) || base.profile.updatedAt,
    },
    zones: Array.isArray(safe.zones)
      ? safe.zones.map(normalizeZone).filter((item) => item.name)
      : [],
    products: Array.isArray(safe.products)
      ? safe.products.map(normalizeProduct).filter((item) => item.name)
      : [],
    treatments: Array.isArray(safe.treatments)
      ? safe.treatments
          .map(normalizeTreatment)
          .filter((item) => item.date && item.type)
      : [],
    mowingLogs: Array.isArray(safe.mowingLogs)
      ? safe.mowingLogs
          .map(normalizeMowing)
          .filter((item) => item.date && item.durationMinutes)
      : [],
    waterings: Array.isArray(safe.waterings)
      ? safe.waterings
          .map(normalizeWatering)
          .filter((item) => item.date)
      : [],
    syncQueue: Array.isArray(safe.syncQueue)
      ? safe.syncQueue.map((item) => normalizeQueueItem(item, safe))
      : [],
    backups: {
      intervalMinutes:
        sanitizeNumber(safe.backups?.intervalMinutes, {
          min: 15,
          max: 7 * 24 * 60,
          decimals: 0,
        }) || base.backups.intervalMinutes,
      lastBackupAt: sanitizeDateTime(safe.backups?.lastBackupAt),
      lastBackupPath: sanitizeText(safe.backups?.lastBackupPath, 320),
      lastResult:
        sanitizeText(safe.backups?.lastResult, 20) || base.backups.lastResult,
      history: Array.isArray(safe.backups?.history)
        ? safe.backups.history
            .map(normalizeBackupHistoryItem)
            .filter((item) => item.id)
            .slice(0, BACKUP_RETENTION)
        : [],
    },
    integrations: {
      googleCalendar: {
        connected: sanitizeBoolean(googleCalendarSafe.connected),
        calendarId:
          sanitizeText(googleCalendarSafe.calendarId, 160) || "primary",
        accessToken: sanitizeText(googleCalendarSafe.accessToken, 4096),
        connectedAt: sanitizeDateTime(googleCalendarSafe.connectedAt),
        lastSyncAt: sanitizeDateTime(googleCalendarSafe.lastSyncAt),
        lastError: sanitizeText(googleCalendarSafe.lastError, 400),
        mode: "manual_access_token",
      },
      rachio: {
        connected: sanitizeBoolean(rachioSafe.connected),
        apiKey: sanitizeText(rachioSafe.apiKey, 1024),
        lastSyncAt: sanitizeDateTime(rachioSafe.lastSyncAt),
      },
    },
    migrationJournal: Array.isArray(safe.migrationJournal)
      ? safe.migrationJournal
          .map(normalizeMigrationEntry)
          .filter((item) => item.id)
          .slice(0, 24)
      : [],
  };

  sortZones(normalized);
  sortProducts(normalized);
  sortTreatments(normalized);
  sortMowingLogs(normalized);
  sortWaterings(normalized);
  normalized.syncQueue = normalized.syncQueue.sort((first, second) => {
    if (first.date !== second.date) {
      return compareIsoDate(first.date, second.date);
    }
    return compareDateTime(first.updatedAt, second.updatedAt);
  });

  return normalized;
}

function normalizeZone(raw) {
  const geometry = normalizeGeometry(raw?.geometry);
  return {
    id: sanitizeText(raw?.id, 80) || createId("zone"),
    name: sanitizeText(raw?.name, 80),
    surface: sanitizeText(raw?.surface, 40) || "Mixed Turf",
    notes: sanitizeText(raw?.notes, 400),
    areaSqFt: sanitizeNumber(raw?.areaSqFt, {
      min: 1,
      max: 250000,
      decimals: 0,
    }),
    geometry,
    lastValidGeometry: normalizeGeometry(raw?.lastValidGeometry) || geometry,
    createdAt: sanitizeDateTime(raw?.createdAt) || nowIso(),
    updatedAt: sanitizeDateTime(raw?.updatedAt) || nowIso(),
  };
}

function normalizeProduct(raw) {
  return {
    id: sanitizeText(raw?.id, 80) || createId("prd"),
    name: sanitizeText(raw?.name, 120),
    category: sanitizeText(raw?.category, 60) || "Other",
    activeIngredient: sanitizeText(raw?.activeIngredient, 120),
    coverageRateSqFt: sanitizeNumber(raw?.coverageRateSqFt ?? raw?.coverageRate, {
      min: 1,
      max: 250000,
      decimals: 0,
    }),
    quantity: sanitizeNumber(raw?.quantity, {
      min: 0,
      max: 10000,
      decimals: 2,
    }),
    unit: sanitizeText(raw?.unit, 20) || "unit",
    notes: sanitizeText(raw?.notes, 400),
    createdAt: sanitizeDateTime(raw?.createdAt) || nowIso(),
    updatedAt: sanitizeDateTime(raw?.updatedAt) || nowIso(),
  };
}

function normalizeTreatment(raw) {
  const status =
    sanitizeText(raw?.status, 20) === "Completed" ? "Completed" : "Scheduled";
  return {
    id: sanitizeText(raw?.id, 80) || createId("trt"),
    type: sanitizeText(raw?.type, 80) || "Treatment",
    date: sanitizeDate(raw?.date),
    zoneId: sanitizeText(raw?.zoneId, 80),
    productId: sanitizeText(raw?.productId, 80),
    repeatDays: sanitizeNumber(raw?.repeatDays, {
      min: 0,
      max: 365,
      decimals: 0,
    }),
    notes: sanitizeText(raw?.notes, 400),
    status,
    pushToGoogle:
      raw?.pushToGoogle === undefined ? true : sanitizeBoolean(raw?.pushToGoogle),
    createdAt: sanitizeDateTime(raw?.createdAt) || nowIso(),
    updatedAt: sanitizeDateTime(raw?.updatedAt) || nowIso(),
    completedAt:
      status === "Completed" ? sanitizeDateTime(raw?.completedAt) || nowIso() : null,
  };
}

function normalizeMowing(raw) {
  return {
    id: sanitizeText(raw?.id, 80) || createId("mow"),
    date: sanitizeDate(raw?.date),
    zoneId: sanitizeText(raw?.zoneId, 80),
    durationMinutes: sanitizeNumber(raw?.durationMinutes ?? raw?.duration, {
      min: 1,
      max: 600,
      decimals: 0,
    }),
    heightInches: sanitizeNumber(raw?.heightInches ?? raw?.height, {
      min: 0.5,
      max: 6.5,
      decimals: 2,
    }),
    clippings: sanitizeText(raw?.clippings, 40) || "Mulched",
    notes: sanitizeText(raw?.notes, 400),
    pushToGoogle:
      raw?.pushToGoogle === undefined ? true : sanitizeBoolean(raw?.pushToGoogle),
    createdAt: sanitizeDateTime(raw?.createdAt) || nowIso(),
    updatedAt: sanitizeDateTime(raw?.updatedAt) || nowIso(),
  };
}

function normalizeWatering(raw) {
  return {
    id: sanitizeText(raw?.id, 80) || createId("wat"),
    date: sanitizeDate(raw?.date),
    scheduledTime: sanitizeText(raw?.scheduledTime, 10) || "04:00",
    durationMinutes: sanitizeNumber(raw?.durationMinutes ?? raw?.duration, {
      min: 1,
      max: 600,
      decimals: 0,
    }) || 15,
    zoneId: sanitizeText(raw?.zoneId, 80),
    source: sanitizeText(raw?.source, 40) || "manual",
    rachioEventId: sanitizeText(raw?.rachioEventId, 160),
    notes: sanitizeText(raw?.notes, 400),
    completed: sanitizeBoolean(raw?.completed) || false,
    completedAt: sanitizeDateTime(raw?.completedAt),
    createdAt: sanitizeDateTime(raw?.createdAt) || nowIso(),
    updatedAt: sanitizeDateTime(raw?.updatedAt) || nowIso(),
  };
}

function normalizeQueueItem(raw, state) {
  return {
    id: sanitizeText(raw?.id, 80) || createId("sync"),
    entityType: sanitizeText(raw?.entityType, 40) || "event",
    entityId: sanitizeText(raw?.entityId, 80),
    date: sanitizeDate(raw?.date ?? raw?.occurrenceDate),
    action: sanitizeText(raw?.action, 20) === "delete" ? "delete" : "upsert",
    status: normalizeQueueStatus(raw?.status),
    attempts: sanitizeNumber(raw?.attempts, {
      min: 0,
      max: 99,
      decimals: 0,
    }) || 0,
    lastError: sanitizeText(raw?.lastError, 400),
    lastAttemptAt: sanitizeDateTime(raw?.lastAttemptAt),
    googleEventId: sanitizeText(raw?.googleEventId, 160),
    payload: isObject(raw?.payload) ? structuredClone(raw.payload) : {},
    createdAt: sanitizeDateTime(raw?.createdAt) || nowIso(),
    updatedAt: sanitizeDateTime(raw?.updatedAt) || nowIso(),
    label: sanitizeText(raw?.label, 160) || buildQueueLabel(raw, state),
  };
}

function normalizeMigrationEntry(raw) {
  return {
    id: sanitizeText(raw?.id, 80) || createId("mig"),
    type: sanitizeText(raw?.type, 60) || "migration",
    detail: sanitizeText(raw?.detail, 240),
    createdAt: sanitizeDateTime(raw?.createdAt) || nowIso(),
  };
}

function normalizeBackupHistoryItem(raw) {
  return {
    id: sanitizeText(raw?.id, 80) || "",
    createdAt: sanitizeDateTime(raw?.createdAt) || nowIso(),
    result: sanitizeText(raw?.result, 20) || "success",
    reason: sanitizeText(raw?.reason, 40) || "manual",
    path: sanitizeText(raw?.path, 320),
  };
}

function buildQueueLabel(raw, state) {
  if (!state) {
    return sanitizeText(raw?.label, 160) || "Calendar event";
  }

  if (sanitizeText(raw?.entityType, 40) === "mowing") {
    const mowing = findById(state.mowingLogs || [], sanitizeText(raw?.entityId, 80));
    return mowing ? `Mowing • ${resolveZoneName(state, mowing.zoneId)}` : "Mowing";
  }

  const treatment = findById(state.treatments || [], sanitizeText(raw?.entityId, 80));
  return treatment
    ? `${treatment.type} • ${resolveZoneName(state, treatment.zoneId)}`
    : "Treatment";
}

function buildDashboard(snapshot) {
  const totalAreaSqFt = getTotalArea(snapshot);
  const upcomingActivity = collectUpcomingDashboardItems(snapshot);
  const recentActivity = collectRecentDashboardItems(snapshot);
  const nextEvent = upcomingActivity[0] || null;

  return {
    totalAreaSqFt,
    mappedZones: snapshot.zones.filter((item) => item.geometry).length,
    nextEvent,
    queue: summarizeQueue(snapshot.syncQueue),
    backupFreshness: getBackupFreshness(snapshot.backups),
    upcoming: upcomingActivity,
    activity: recentActivity,
    counts: {
      zones: snapshot.zones.length,
      products: snapshot.products.length,
      treatments: snapshot.treatments.length,
      mowingLogs: snapshot.mowingLogs.length,
    },
  };
}

function collectUpcomingDashboardItems(snapshot) {
  const today = todayIso();
  return collectTimelineItems(snapshot, {
    start: today,
    end: addDays(today, 45),
  })
    .filter((item) => {
      if (item.eventType === "Watering") {
        return item.status === "Scheduled";
      }
      if (item.eventType === "Treatment") {
        return item.status !== "Completed";
      }
      return compareIsoDate(item.date, today) >= 0;
    })
    .slice(0, 5);
}

function collectRecentDashboardItems(snapshot) {
  const today = todayIso();
  const items = [];

  snapshot.treatments.forEach((treatment) => {
    if (treatment.status !== "Completed" || compareIsoDate(treatment.date, today) > 0) {
      return;
    }
    items.push({
      id: treatment.id,
      entityId: treatment.id,
      eventType: "Treatment",
      date: treatment.date,
      title: treatment.type,
      zoneName: resolveZoneName(snapshot, treatment.zoneId),
      zoneId: treatment.zoneId,
      status: "Completed",
      notes: treatment.notes,
      detail: treatment.productId
        ? resolveProductName(snapshot, treatment.productId)
        : "No product linked",
      repeatDays: treatment.repeatDays || null,
      isProjected: false,
    });
  });

  snapshot.mowingLogs.forEach((entry) => {
    if (compareIsoDate(entry.date, today) > 0) {
      return;
    }
    items.push({
      id: entry.id,
      entityId: entry.id,
      eventType: "Mowing",
      date: entry.date,
      title: `${entry.heightInches}" cut`,
      zoneName: resolveZoneName(snapshot, entry.zoneId),
      zoneId: entry.zoneId,
      status: "Logged",
      notes: entry.notes,
      detail: `${entry.durationMinutes} min • ${entry.clippings}`,
      repeatDays: null,
      isProjected: false,
    });
  });

  (snapshot.waterings || []).forEach((watering) => {
    if (!watering.completed || compareIsoDate(watering.date, today) > 0) {
      return;
    }
    items.push({
      id: watering.id,
      entityId: watering.id,
      eventType: "Watering",
      date: watering.date,
      title: "Watering",
      zoneName: resolveZoneName(snapshot, watering.zoneId),
      zoneId: watering.zoneId,
      status: "Completed",
      notes: watering.notes,
      detail: `${watering.scheduledTime || ""} (${watering.durationMinutes} min)`,
      repeatDays: null,
      isProjected: false,
    });
  });

  return items
    .sort((first, second) => {
      if (first.date !== second.date) {
        return compareIsoDate(second.date, first.date);
      }
      return first.eventType.localeCompare(second.eventType);
    })
    .slice(0, 5);
}

function buildHealth(snapshot) {
  return {
    storageMode: snapshot.meta.storageMode,
    schemaVersion: snapshot.schemaVersion,
    counts: {
      zones: snapshot.zones.length,
      mappedZones: snapshot.zones.filter((item) => item.geometry).length,
      products: snapshot.products.length,
      treatments: snapshot.treatments.length,
      mowingLogs: snapshot.mowingLogs.length,
    },
    googleCalendar: {
      connected: snapshot.integrations.googleCalendar.connected,
      calendarId: snapshot.integrations.googleCalendar.calendarId,
      hasAccessToken: Boolean(snapshot.integrations.googleCalendar.accessToken),
      lastSyncAt: snapshot.integrations.googleCalendar.lastSyncAt,
      lastError: snapshot.integrations.googleCalendar.lastError,
    },
    queue: summarizeQueue(snapshot.syncQueue),
    backup: getBackupFreshness(snapshot.backups),
    migrations: snapshot.migrationJournal.length,
  };
}

async function buildTimelinePayload(snapshot, options) {
  const { start, end, label, range } = getTimelineWindow(options.range, options.anchor);
  const items = collectTimelineItems(snapshot, { start, end });
  const countsByDate = new Map();
  items.forEach((item) => {
    countsByDate.set(item.date, (countsByDate.get(item.date) || 0) + 1);
  });
  const days = await enrichTimelineDaysWithWeather(
    iterateDays(start, end).map((date) => ({
      date,
      label: formatDayLabel(date),
      eventCount: countsByDate.get(date) || 0,
    })),
    snapshot.profile
  );

  return {
    range,
    anchor: options.anchor,
    window: {
      start,
      end,
      label,
    },
    summary: {
      total: items.length,
      treatments: items.filter((item) => item.eventType === "Treatment").length,
      mowing: items.filter((item) => item.eventType === "Mowing").length,
      waterings: items.filter((item) => item.eventType === "Watering").length,
    },
    days,
    items,
  };
}

function collectTimelineItems(snapshot, window) {
  const items = [];
  snapshot.treatments.forEach((treatment) => {
    expandTreatmentOccurrences(treatment, window).forEach((occurrence) => {
      items.push({
        id: `${treatment.id}:${occurrence.date}`,
        entityId: treatment.id,
        eventType: "Treatment",
        date: occurrence.date,
        title: treatment.type,
        zoneName: resolveZoneName(snapshot, treatment.zoneId),
        zoneId: treatment.zoneId,
        status:
          occurrence.isProjected || compareIsoDate(occurrence.date, treatment.date) !== 0
            ? "Scheduled"
            : treatment.status,
        notes: treatment.notes,
        detail: treatment.productId
          ? resolveProductName(snapshot, treatment.productId)
          : "No product linked",
        repeatDays: treatment.repeatDays || null,
        isProjected: occurrence.isProjected,
      });
    });
  });

  snapshot.mowingLogs.forEach((entry) => {
    if (
      compareIsoDate(entry.date, window.start) >= 0 &&
      compareIsoDate(entry.date, window.end) <= 0
    ) {
      items.push({
        id: entry.id,
        entityId: entry.id,
        eventType: "Mowing",
        date: entry.date,
        title: `${entry.heightInches}" cut`,
        zoneName: resolveZoneName(snapshot, entry.zoneId),
        zoneId: entry.zoneId,
        status: "Logged",
        notes: entry.notes,
        detail: `${entry.durationMinutes} min • ${entry.clippings}`,
        repeatDays: null,
        isProjected: false,
      });
    }
  });

  (snapshot.waterings || []).forEach((watering) => {
    if (
      compareIsoDate(watering.date, window.start) >= 0 &&
      compareIsoDate(watering.date, window.end) <= 0 &&
      !watering.completed
    ) {
      items.push({
        id: watering.id,
        entityId: watering.id,
        eventType: "Watering",
        date: watering.date,
        title: "Watering",
        zoneName: resolveZoneName(snapshot, watering.zoneId),
        zoneId: watering.zoneId,
        status: "Scheduled",
        notes: watering.notes,
        detail: `${watering.scheduledTime || ""} (${watering.durationMinutes} min)`,
        repeatDays: null,
        isProjected: false,
      });
    }
  });

  return items.sort((first, second) => {
    if (first.date !== second.date) {
      return compareIsoDate(first.date, second.date);
    }
    if (first.eventType !== second.eventType) {
      return first.eventType.localeCompare(second.eventType);
    }
    return first.title.localeCompare(second.title);
  });
}

function expandTreatmentOccurrences(treatment, window) {
  if (!treatment.date) {
    return [];
  }

  const items = [];
  const repeatDays = treatment.repeatDays || 0;
  let dateCursor = treatment.date;
  let steps = 0;

  if (repeatDays > 0 && compareIsoDate(dateCursor, window.start) < 0) {
    const daysAhead = daysBetween(dateCursor, window.start);
    const skipCount = Math.max(0, Math.floor(daysAhead / repeatDays) - 1);
    if (skipCount > 0) {
      dateCursor = addDays(dateCursor, repeatDays * skipCount);
    }
    while (compareIsoDate(dateCursor, window.start) < 0) {
      dateCursor = addDays(dateCursor, repeatDays);
    }
  }

  while (steps < 90 && compareIsoDate(dateCursor, window.end) <= 0) {
    if (compareIsoDate(dateCursor, window.start) >= 0) {
      items.push({
        date: dateCursor,
        isProjected: compareIsoDate(dateCursor, treatment.date) !== 0,
      });
    }

    if (!repeatDays) {
      break;
    }

    dateCursor = addDays(dateCursor, repeatDays);
    steps += 1;
  }

  return items;
}

function createPortableExport(snapshot, options = {}) {
  const portableSnapshot = sanitizeSnapshotForExport(snapshot);
  return {
    app: "GrassPass",
    exportedAt: nowIso(),
    reason: sanitizeText(options.reason, 40) || "export",
    schemaVersion: portableSnapshot.schemaVersion,
    snapshot: portableSnapshot,
  };
}

function sanitizeSnapshotForExport(snapshot) {
  return {
    ...sanitizeSnapshotForClient(snapshot),
    integrations: {
      googleCalendar: {
        connected: snapshot.integrations.googleCalendar.connected,
        calendarId: snapshot.integrations.googleCalendar.calendarId,
        connectedAt: snapshot.integrations.googleCalendar.connectedAt,
        lastSyncAt: snapshot.integrations.googleCalendar.lastSyncAt,
        lastError: snapshot.integrations.googleCalendar.lastError,
        mode: "manual_access_token",
        hasAccessToken: Boolean(snapshot.integrations.googleCalendar.accessToken),
      },
      rachio: {
        connected: snapshot.integrations.rachio?.connected || false,
        lastSyncAt: snapshot.integrations.rachio?.lastSyncAt || null,
      },
    },
  };
}

function sanitizeSnapshotForClient(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    meta: structuredClone(snapshot.meta),
    profile: structuredClone(snapshot.profile),
    zones: structuredClone(snapshot.zones),
    products: structuredClone(snapshot.products),
    treatments: structuredClone(snapshot.treatments),
    mowingLogs: structuredClone(snapshot.mowingLogs),
    waterings: structuredClone(snapshot.waterings),
    syncQueue: structuredClone(snapshot.syncQueue),
    backups: structuredClone(snapshot.backups),
    migrationJournal: structuredClone(snapshot.migrationJournal),
    integrations: {
      googleCalendar: {
        connected: snapshot.integrations.googleCalendar.connected,
        calendarId: snapshot.integrations.googleCalendar.calendarId,
        connectedAt: snapshot.integrations.googleCalendar.connectedAt,
        lastSyncAt: snapshot.integrations.googleCalendar.lastSyncAt,
        lastError: snapshot.integrations.googleCalendar.lastError,
        mode: "manual_access_token",
        hasAccessToken: Boolean(snapshot.integrations.googleCalendar.accessToken),
      },
      rachio: {
        connected: snapshot.integrations.rachio?.connected || false,
        lastSyncAt: snapshot.integrations.rachio?.lastSyncAt || null,
        hasApiKey: Boolean(snapshot.integrations.rachio?.apiKey),
      },
    },
  };
}

module.exports = {
  createDefaultState,
  createDefaultAuthState,
  normalizeAuthState,
  normalizeAuthUser,
  normalizeInvite,
  normalizeSession,
  snapshotHasMeaningfulData,
  normalizeState,
  normalizeZone,
  normalizeProduct,
  normalizeTreatment,
  normalizeMowing,
  normalizeWatering,
  normalizeQueueItem,
  normalizeMigrationEntry,
  normalizeBackupHistoryItem,
  buildQueueLabel,
  buildDashboard,
  buildHealth,
  buildTimelinePayload,
  expandTreatmentOccurrences,
  mutateSnapshot,
  createPortableExport,
  sanitizeSnapshotForExport,
  sanitizeSnapshotForClient,
};
