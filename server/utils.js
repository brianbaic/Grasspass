// Low-level utility functions for state management and validation
// No business logic — these are pure functions used by normalization and other modules

const crypto = require("crypto");
const path = require("path");

function nowIso() {
  return new Date().toISOString();
}

function todayIso() {
  return new Date().toISOString().split("T")[0];
}

function parseIsoDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(isoDate, days) {
  const parsed = parseIsoDate(isoDate);
  parsed.setDate(parsed.getDate() + days);
  return parsed.toISOString().split("T")[0];
}

function addDaysIso(days) {
  const now = new Date();
  now.setDate(now.getDate() + days);
  return now.toISOString().split("T")[0];
}

function daysBetween(fromDate, toDate) {
  const first = parseIsoDate(fromDate);
  const second = parseIsoDate(toDate);
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.floor((second.getTime() - first.getTime()) / oneDay);
}

function compareIsoDate(first, second) {
  return first.localeCompare(second);
}

function compareDateTime(first, second) {
  const firstTime = new Date(first || 0).getTime();
  const secondTime = new Date(second || 0).getTime();
  return firstTime - secondTime;
}

function compactTimestamp(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "-",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}

function iterateDays(start, end) {
  const items = [];
  let cursor = start;
  while (compareIsoDate(cursor, end) <= 0) {
    items.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return items;
}

function formatShortDate(isoDate) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(parseIsoDate(isoDate));
}

function formatDayLabel(isoDate) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(parseIsoDate(isoDate));
}

function formatMonthLabel(isoDate) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(parseIsoDate(isoDate));
}

function sanitizeText(value, maxLength = 200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeNumber(value, options = {}) {
  const { min = 0, max = Number.MAX_SAFE_INTEGER, decimals = 2 } = options;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const bounded = Math.min(max, Math.max(min, parsed));
  return Number(bounded.toFixed(decimals));
}

function sanitizeBoolean(value) {
  return Boolean(value);
}

function sanitizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? value.split("T")[0] : null;
}

function sanitizeDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeEmail(value) {
  return sanitizeText(String(value ?? "").toLowerCase().trim(), 255);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findById(collection, id) {
  return collection.find((item) => item.id === id) || null;
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sortZones(snapshot) {
  snapshot.zones.sort((first, second) => first.name.localeCompare(second.name));
}

function sortProducts(snapshot) {
  snapshot.products.sort((first, second) => first.name.localeCompare(second.name));
}

function sortTreatments(snapshot) {
  snapshot.treatments.sort((first, second) => compareIsoDate(first.date, second.date));
}

function sortMowingLogs(snapshot) {
  snapshot.mowingLogs.sort((first, second) => compareIsoDate(second.date, first.date));
}

function sortWaterings(snapshot) {
  snapshot.waterings.sort((first, second) => compareIsoDate(first.date, second.date));
}

function normalizeGeometry(value) {
  if (!value) return null;
  if (!isObject(value) || !Array.isArray(value.coordinates)) return null;
  return value;
}

function normalizeQueueStatus(value) {
  const valid = ["pending", "processing", "synced", "failed"];
  return valid.includes(value) ? value : "pending";
}

function getTimelineWindow(range, anchor) {
  const safeAnchor = sanitizeDate(anchor) || todayIso();
  if (range === "week") {
    const parsed = parseIsoDate(safeAnchor);
    parsed.setDate(parsed.getDate() - parsed.getDay());
    const start = parsed.toISOString().split("T")[0];
    const end = addDays(start, 6);
    return {
      range: "week",
      start,
      end,
      label: `${formatShortDate(start)} - ${formatShortDate(end)}`,
    };
  }

  const startDate = parseIsoDate(safeAnchor);
  startDate.setDate(1);
  const start = startDate.toISOString().split("T")[0];
  const endDate = parseIsoDate(safeAnchor);
  endDate.setMonth(endDate.getMonth() + 1, 0);
  const end = endDate.toISOString().split("T")[0];
  return {
    range: "month",
    start,
    end,
    label: formatMonthLabel(safeAnchor),
  };
}

function summarizeQueue(queue) {
  return {
    total: queue.length,
    pending: queue.filter((item) => item.status === "pending").length,
    processing: queue.filter((item) => item.status === "processing").length,
    synced: queue.filter((item) => item.status === "synced").length,
    failed: queue.filter((item) => item.status === "failed").length,
  };
}

function getBackupFreshness(backups) {
  if (!backups.lastBackupAt) return null;
  const lastBackup = new Date(backups.lastBackupAt);
  const now = new Date();
  const ageMs = now.getTime() - lastBackup.getTime();
  const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
  return {
    lastBackupAt: backups.lastBackupAt,
    lastResult: backups.lastResult,
    ageHours,
  };
}

function getTotalArea(snapshot) {
  const zonedArea = snapshot.zones.reduce((sum, zone) => sum + (zone.areaSqFt || 0), 0);
  return zonedArea || snapshot.profile.manualAreaSqFt || null;
}

function resolveZoneName(snapshot, zoneId) {
  const zone = findById(snapshot.zones, zoneId);
  return zone ? zone.name : "Unassigned";
}

function resolveProductName(snapshot, productId) {
  const product = findById(snapshot.products, productId);
  return product ? product.name : "";
}

module.exports = {
  nowIso,
  todayIso,
  addDays,
  addDaysIso,
  daysBetween,
  compareIsoDate,
  compareDateTime,
  compactTimestamp,
  iterateDays,
  formatDayLabel,
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
  getTimelineWindow,
  summarizeQueue,
  getBackupFreshness,
  getTotalArea,
  resolveZoneName,
  resolveProductName,
};
