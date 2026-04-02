const fs = require("fs/promises");
const path = require("path");

// Constants - will be provided by caller or imported
const MAX_QUEUE_ATTEMPTS = 5;
const APP_STATE_KEY = "primary";
const BACKUP_RETENTION = 12;

// Will be imported from utilities
function nowIso() {
  return new Date().toISOString();
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

function compareIsoDate(first, second) {
  return first.localeCompare(second);
}

function compareDateTime(first, second) {
  const firstTime = new Date(first || 0).getTime();
  const secondTime = new Date(second || 0).getTime();
  return firstTime - secondTime;
}

function createId(prefix) {
  const { randomUUID } = require("crypto");
  return `${prefix}-${randomUUID()}`;
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

// External dependencies that will be injected or imported
let dispatchGoogleCalendarEvent = null;
let createPortableExport = null;
let pruneBackupDirectory = null;

function setDependencies(deps) {
  dispatchGoogleCalendarEvent = deps.dispatchGoogleCalendarEvent;
  createPortableExport = deps.createPortableExport;
  pruneBackupDirectory = deps.pruneBackupDirectory;
}

// ── Background Jobs Factory ──
function createBackgroundJobs(options) {
  const { store, backupDir } = options;
  let queueTimer = null;
  let backupTimer = null;
  let queueInFlight = false;
  let backupInFlight = false;

  async function processQueueNow() {
    if (queueInFlight) return;
    queueInFlight = true;
    try {
      const snapshots = await store.listSnapshots();
      for (const entry of snapshots) {
        try {
          const snapshot = entry.snapshot;
          const googleCalendar = snapshot.integrations.googleCalendar;
          if (!googleCalendar.connected || !googleCalendar.accessToken) continue;

          const candidates = snapshot.syncQueue
            .filter(
              (item) =>
                (item.status === "pending" || item.status === "failed") &&
                item.attempts < MAX_QUEUE_ATTEMPTS
            )
            .sort((first, second) => {
              if (first.date !== second.date) {
                return compareIsoDate(first.date, second.date);
              }
              return compareDateTime(first.updatedAt, second.updatedAt);
            })
            .slice(0, 8);

          if (candidates.length === 0) continue;

          const queueMap = new Map(snapshot.syncQueue.map((item) => [item.id, item]));
          for (const candidate of candidates) {
            const queueItem = queueMap.get(candidate.id);
            if (!queueItem) continue;

            queueItem.status = "processing";
            queueItem.attempts += 1;
            queueItem.lastAttemptAt = nowIso();
            queueItem.updatedAt = nowIso();

            try {
              const dispatchResult = await dispatchGoogleCalendarEvent(googleCalendar, queueItem);
              queueItem.status = "synced";
              queueItem.lastError = null;
              queueItem.updatedAt = nowIso();
              snapshot.integrations.googleCalendar.lastSyncAt = nowIso();
              snapshot.integrations.googleCalendar.lastError = null;
              if (queueItem.action === "delete") {
                queueItem.googleEventId = "";
              } else {
                queueItem.googleEventId = dispatchResult.googleEventId || queueItem.googleEventId;
              }
            } catch (error) {
              queueItem.status = "failed";
              queueItem.lastError = sanitizeText(error.message, 400) || "Sync failed.";
              queueItem.updatedAt = nowIso();
              snapshot.integrations.googleCalendar.lastError = queueItem.lastError;
            }
          }

          snapshot.syncQueue = snapshot.syncQueue.filter(
            (item) => !(item.action === "delete" && item.status === "synced" && !item.googleEventId)
          );
          snapshot.meta.updatedAt = nowIso();

          try {
            await store.writeSnapshot(snapshot, entry.subject);
          } catch (writeError) {
            console.error("Failed to persist queue state:", writeError.message || writeError);
            throw writeError;
          }
        } catch (entryError) {
          console.error("Queue processing failed for entry:", entryError.message || entryError);
        }
      }
    } catch (error) {
      console.error("Queue processor job failed:", error.message || error);
    } finally {
      queueInFlight = false;
    }
  }

  async function maybeRunScheduledBackup() {
    if (backupInFlight) return;

    try {
      const snapshots = await store.listSnapshots();
      for (const entry of snapshots) {
        const snapshot = entry.snapshot;
        const intervalMinutes = sanitizeNumber(snapshot.backups.intervalMinutes, {
          min: 15,
          max: 7 * 24 * 60,
          decimals: 0,
        });

        if (!intervalMinutes) continue;

        const lastBackupAt = snapshot.backups.lastBackupAt;
        if (lastBackupAt) {
          const ageMinutes = Math.floor((Date.now() - new Date(lastBackupAt).getTime()) / 60000);
          if (ageMinutes < intervalMinutes) continue;
        }

        await runBackupNow("scheduled", entry.subject);
      }
    } catch (error) {
      console.error("Scheduled backup job failed:", error.message || error);
    }
  }

  async function runBackupNow(reason, subject = APP_STATE_KEY) {
    if (backupInFlight) return null;

    backupInFlight = true;
    try {
      const snapshot = await store.readSnapshot(subject);
      const exportPayload = createPortableExport(snapshot, { reason });
      await fs.mkdir(backupDir, { recursive: true });
      const backupId = createId("backup");
      const fileName = `grasspass-backup-${compactTimestamp(new Date())}.json`;
      const fullPath = path.join(backupDir, fileName);

      await fs.writeFile(fullPath, JSON.stringify(exportPayload, null, 2), "utf8");

      const metadata = {
        id: backupId,
        createdAt: nowIso(),
        result: "success",
        reason,
        path: fullPath,
      };

      snapshot.backups.lastBackupAt = metadata.createdAt;
      snapshot.backups.lastBackupPath = metadata.path;
      snapshot.backups.lastResult = metadata.result;
      snapshot.backups.history = [metadata, ...snapshot.backups.history].slice(0, BACKUP_RETENTION);
      snapshot.meta.updatedAt = nowIso();

      try {
        await store.writeSnapshot(snapshot, subject);
      } catch (writeError) {
        console.error("Failed to persist backup state:", writeError.message || writeError);
        throw writeError;
      }

      try {
        await store.recordBackup(metadata);
      } catch (recordError) {
        console.error("Failed to record backup metadata:", recordError.message || recordError);
      }

      await pruneBackupDirectory(backupDir, BACKUP_RETENTION);
      return metadata;
    } catch (error) {
      console.error("Backup job failed:", error.message || error);
      return null;
    } finally {
      backupInFlight = false;
    }
  }

  function start() {
    if (!queueTimer) {
      queueTimer = setInterval(() => {
        processQueueNow().catch((error) => {
          console.error("Unhandled queue processor error:", error.message || error);
        });
      }, 45_000);
    }
    if (!backupTimer) {
      backupTimer = setInterval(() => {
        maybeRunScheduledBackup().catch((error) => {
          console.error("Unhandled backup scheduler error:", error.message || error);
        });
      }, 60_000);
    }
  }

  function stop() {
    if (queueTimer) {
      clearInterval(queueTimer);
      queueTimer = null;
    }
    if (backupTimer) {
      clearInterval(backupTimer);
      backupTimer = null;
    }
  }

  return { start, stop, processQueueNow, runBackupNow };
}

module.exports = {
  createBackgroundJobs,
  setDependencies,
};
