const http = require("http");
const { execFileSync } = require("child_process");
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { createBackgroundJobs, setDependencies: setJobsDependencies } = require("./server/jobs");
const {
  mutateSnapshot,
  createDefaultState,
  createDefaultAuthState,
  normalizeAuthState,
  snapshotHasMeaningfulData,
  normalizeState,
  normalizeZone,
  normalizeProduct,
  normalizeTreatment,
  normalizeMowing,
  normalizeWatering,
  normalizeQueueItem,
  normalizeMigrationEntry,
  buildDashboard,
  buildHealth,
  buildTimelinePayload,
  expandTreatmentOccurrences,
  createPortableExport,
  sanitizeSnapshotForClient,
} = require("./server/normalize");
const { searchLocationSuggestions } = require("./server/weather");

// Load .env file if present (no external dependency needed)
const envPath = path.join(__dirname, ".env");
if (fsSync.existsSync(envPath)) {
  for (const line of fsSync.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const ROOT_DIR = __dirname;
const APP_STATE_KEY = "primary";
const SCHEMA_VERSION = 2;
const HORT_OR_HOAX_PATH = path.join(ROOT_DIR, "_private", "hort-or-hoax.json");
let _hortOrHoaxCache = null;
const BACKUP_RETENTION = 12;
const MAX_QUEUE_ATTEMPTS = 5;
const DEFAULT_BACKUP_INTERVAL_MINUTES = 12 * 60;
const LEGACY_STORAGE_KEY = "grasspass.v1";
const DEFAULT_DATABASE_PORT = 5432;
const SESSION_COOKIE_NAME = "grasspass.session";
const SESSION_TTL_DAYS = 30;
const RELATIONAL_SYNC_VERSION = 1;
const PROFILE_ROW_KEY = "primary";
const BACKUP_ROW_KEY = "primary";
const GOOGLE_INTEGRATION_ROW_KEY = "primary";
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
  // Note: /app/* paths are served by the module route below.
]);

class SQLiteStore {
  constructor(options) {
    this.mode = "sqlite";
    this.rootDir = options.rootDir;
    this.storageDir =
      options.storageDir || path.join(options.rootDir, "_private", "runtime");
    this.dbPath = path.join(this.storageDir, "grasspass.db");
    this.db = null;
  }

  async init() {
    await fs.mkdir(this.storageDir, { recursive: true });

    try {
      this.db = new Database(this.dbPath);
      this.db.pragma("journal_mode = WAL");
    } catch (error) {
      throw new Error(`Failed to open SQLite database at ${this.dbPath}: ${error.message}`);
    }

    const schemaPath = path.join(this.rootDir, "db", "sqlite-schema.sql");
    const schemaSql = await fs.readFile(schemaPath, "utf8");

    try {
      this.db.exec(schemaSql);
    } catch (error) {
      throw new Error(`Failed to initialize database schema: ${error.message}`);
    }

    const current = this.db
      .prepare("SELECT state_key, data FROM grasspass_app_state")
      .all();

    if (current.length === 0) {
      await this.writeSnapshot(createDefaultState(this.mode), APP_STATE_KEY);
      return;
    }

    for (const row of current) {
      const subject = stateKeyToSubject(row.state_key);
      const snapshot = normalizeState(JSON.parse(row.data), { storageMode: this.mode });
      await this.syncAuthToSQLite(snapshot);
    }
  }

  async readSnapshot(subject = APP_STATE_KEY) {
    const stateKey = subjectToStateKey(subject);
    const row = this.db
      .prepare("SELECT data FROM grasspass_app_state WHERE state_key = ?")
      .get(stateKey);

    if (!row) {
      if (subject !== APP_STATE_KEY) {
        const userCount = this.db
          .prepare("SELECT COUNT(*) as count FROM grasspass_app_state WHERE state_key LIKE 'user:%'")
          .get();
        const primary = this.db
          .prepare("SELECT data FROM grasspass_app_state WHERE state_key = ?")
          .get(APP_STATE_KEY);

        if (userCount.count === 0 && primary) {
          const migrated = normalizeState(JSON.parse(primary.data), { storageMode: this.mode });
          await this.writeSnapshot(migrated, subject);
          await this.writeSnapshot(createDefaultState(this.mode), APP_STATE_KEY);
          return migrated;
        }
      }
      const fresh = createDefaultState(this.mode);
      await this.writeSnapshot(fresh, subject);
      return fresh;
    }

    return normalizeState(JSON.parse(row.data), { storageMode: this.mode });
  }

  async writeSnapshot(snapshot, subject = APP_STATE_KEY) {
    const stateKey = subjectToStateKey(subject);
    const normalized = normalizeState(snapshot, { storageMode: this.mode });
    const dataJson = JSON.stringify(normalized);

    this.db
      .prepare(
        `INSERT INTO grasspass_app_state (state_key, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(stateKey, dataJson, nowIso());

    await this.syncAuthToSQLite(normalized);
  }

  async recordBackup(metadata) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO grasspass_backup_runs (id, created_at, metadata)
         VALUES (?, ?, ?)`
      )
      .run(metadata.id, nowIso(), JSON.stringify(metadata));
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async listSnapshots() {
    const rows = this.db
      .prepare("SELECT state_key, data FROM grasspass_app_state ORDER BY updated_at DESC")
      .all();

    return rows.map((row) => ({
      subject: stateKeyToSubject(row.state_key),
      snapshot: normalizeState(JSON.parse(row.data), { storageMode: this.mode }),
    }));
  }

  async getDatabaseInsights() {
    const tables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'grasspass_%' ORDER BY name"
      )
      .all();

    const trackedTables = [
      "grasspass_users",
      "grasspass_invites",
      "grasspass_sessions",
      "grasspass_backup_runs",
      "grasspass_app_state",
    ];

    const userResult = this.db.prepare("SELECT COUNT(*) as count FROM grasspass_users").get();
    const recordCounts = {};

    for (const tableName of trackedTables) {
      try {
        const result = this.db
          .prepare(`SELECT COUNT(*) as count FROM ${tableName}`)
          .get();
        recordCounts[tableName] = result?.count || 0;
      } catch (error) {
        recordCounts[tableName] = 0;
      }
    }

    const totalRecords = Object.values(recordCounts).reduce(
      (total, count) => total + Number(count || 0),
      0
    );

    return {
      generatedAt: nowIso(),
      users: userResult?.count || 0,
      tables: tables.length,
      fields: 0,
      records: totalRecords,
      recordsByTable: recordCounts,
    };
  }

  async syncAuthToSQLite(snapshot) {
    if (!snapshot || !snapshot.auth) {
      return;
    }

    const normalized = normalizeState(snapshot, { storageMode: this.mode });
    const authState = {
      users: normalized.auth?.users || [],
      invites: normalized.auth?.invites || [],
      sessions: normalized.auth?.sessions || [],
    };

    const transaction = this.db.transaction(() => {
      // Delete users not in current set
      const userIds = authState.users.map((u) => u.id);
      if (userIds.length > 0) {
        const placeholders = userIds.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM grasspass_users WHERE id NOT IN (${placeholders})`).run(...userIds);
      } else {
        this.db.prepare("DELETE FROM grasspass_users").run();
      }

      // Upsert users
      for (const user of authState.users) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO grasspass_users
             (id, email, display_name, role, password_hash, created_at, updated_at, last_login_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            user.id,
            user.email,
            user.displayName,
            user.role,
            user.passwordHash,
            user.createdAt,
            user.updatedAt,
            user.lastLoginAt || null
          );
      }

      // Delete invites not in current set
      const inviteIds = authState.invites.map((i) => i.id);
      if (inviteIds.length > 0) {
        const placeholders = inviteIds.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM grasspass_invites WHERE id NOT IN (${placeholders})`).run(...inviteIds);
      } else {
        this.db.prepare("DELETE FROM grasspass_invites").run();
      }

      // Upsert invites
      for (const invite of authState.invites) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO grasspass_invites
             (id, code, role, note, created_by_user_id, created_at, used_at, used_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            invite.id,
            invite.code,
            invite.role,
            invite.note || null,
            invite.createdByUserId || null,
            invite.createdAt,
            invite.usedAt || null,
            invite.usedByUserId || null
          );
      }

      // Delete sessions not in current set
      const sessionIds = authState.sessions.map((s) => s.id);
      if (sessionIds.length > 0) {
        const placeholders = sessionIds.map(() => "?").join(",");
        this.db
          .prepare(`DELETE FROM grasspass_sessions WHERE id NOT IN (${placeholders})`)
          .run(...sessionIds);
      } else {
        this.db.prepare("DELETE FROM grasspass_sessions").run();
      }

      // Upsert sessions
      for (const session of authState.sessions) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO grasspass_sessions
             (id, user_id, created_at, expires_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(session.id, session.userId, session.createdAt, session.expiresAt);
      }
    });

    transaction();
  }
}

class RuntimeStoreManager {
  constructor(options) {
    this.rootDir = options.rootDir;
    this.storageDir = options.storageDir;
    this.activeStore = null;
    this.activeSource = "sqlite";
  }

  get mode() {
    return this.activeStore?.mode || "sqlite";
  }

  async init() {
    this.activeStore = await createStore({
      rootDir: this.rootDir,
      storageDir: this.storageDir,
    });
  }

  async readSnapshot(subject = APP_STATE_KEY) {
    return this.activeStore.readSnapshot(subject);
  }

  async writeSnapshot(snapshot, subject = APP_STATE_KEY) {
    return this.activeStore.writeSnapshot(snapshot, subject);
  }

  async recordBackup(metadata) {
    return this.activeStore.recordBackup(metadata);
  }

  async listSnapshots() {
    return this.activeStore.listSnapshots();
  }

  async close() {
    if (this.activeStore) {
      await this.activeStore.close();
    }
  }

  async getClientState() {
    let insights = null;

    if (this.activeStore && typeof this.activeStore.getDatabaseInsights === "function") {
      try {
        insights = await this.activeStore.getDatabaseInsights();
      } catch (error) {
        insights = null;
      }
    }

    return {
      mode: "sqlite",
      storage: {
        status: "connected",
        type: "sqlite",
        insights,
      },
    };
  }
}

class AuthStateStore {
  constructor(options) {
    this.storageDir =
      options.storageDir || path.join(options.rootDir, "_private", "runtime");
    this.filePath = path.join(this.storageDir, "auth-state.json");
  }

  async init() {
    await fs.mkdir(this.storageDir, { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch (error) {
      await this.write(createDefaultAuthState());
    }
  }

  async read() {
    const raw = await fs.readFile(this.filePath, "utf8");
    return normalizeAuthState(JSON.parse(raw));
  }

  async write(state) {
    const normalized = normalizeAuthState(state);
    await fs.mkdir(this.storageDir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  }
}

class AuthManager {
  constructor(options) {
    this.fileStore = new AuthStateStore(options);
    this.runtimeStore = options.runtimeStore;
  }

  async init() {
    await this.fileStore.init();
  }

  async getClientState(sessionId = "") {
    const state = await this.readState();
    const normalized = await this.cleanupExpiredSessions(state);
    const session = normalized.sessions.find((item) => item.id === sessionId) || null;
    const user = session ? normalized.users.find((item) => item.id === session.userId) || null : null;
    return buildAuthClientState(normalized, user);
  }

  async requireUser(sessionId = "") {
    const state = await this.readState();
    const normalized = await this.cleanupExpiredSessions(state);
    const session = normalized.sessions.find((item) => item.id === sessionId) || null;
    if (!session) {
      return null;
    }
    return normalized.users.find((item) => item.id === session.userId) || null;
  }

  async register(input) {
    const state = await this.readState();
    const normalized = await this.cleanupExpiredSessions(state);
    const hasUsers = normalized.users.length > 0;
    const email = normalizeEmail(input.email);
    const displayName = sanitizeText(input.displayName, 80);
    const password = String(input.password || "");
    const inviteCode = sanitizeText(input.inviteCode, 80).toUpperCase();

    if (!email || !displayName || password.length < 8) {
      throw new Error("Display name, email, and an 8+ character password are required.");
    }
    if (normalized.users.some((item) => item.email === email)) {
      throw new Error("That email is already registered.");
    }

    let role = "member";
    if (!hasUsers) {
      role = "admin";
    } else {
      const invite = normalized.invites.find(
        (item) => item.code === inviteCode && !item.usedAt
      );
      if (!invite) {
        throw new Error("A valid invite code is required for registration.");
      }
      role = invite.role || "member";
      invite.usedAt = nowIso();
    }

    const userId = createId("usr");
    const passwordHash = hashPassword(password);
    const user = {
      id: userId,
      email,
      displayName,
      role,
      passwordHash,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastLoginAt: nowIso(),
    };
    normalized.users.push(user);

    if (hasUsers) {
      const invite = normalized.invites.find(
        (item) => item.code === inviteCode && item.usedAt && !item.usedByUserId
      );
      if (invite) {
        invite.usedByUserId = userId;
      }
    }

    const session = createSessionRecord(userId);
    normalized.sessions = normalized.sessions
      .filter((item) => item.userId !== userId)
      .concat(session);
    await this.writeState(normalized);

    return {
      sessionId: session.id,
      auth: buildAuthClientState(normalized, sanitizeUserForClient(user)),
    };
  }

  async login(input) {
    const state = await this.readState();
    const normalized = await this.cleanupExpiredSessions(state);
    const email = normalizeEmail(input.email);
    const password = String(input.password || "");
    const user = normalized.users.find((item) => item.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new Error("Email or password is incorrect.");
    }

    user.lastLoginAt = nowIso();
    user.updatedAt = nowIso();
    const session = createSessionRecord(user.id);
    normalized.sessions = normalized.sessions
      .filter((item) => item.userId !== user.id)
      .concat(session);
    await this.writeState(normalized);

    return {
      sessionId: session.id,
      auth: buildAuthClientState(normalized, sanitizeUserForClient(user)),
    };
  }

  async logout(sessionId = "") {
    const state = await this.readState();
    const normalized = await this.cleanupExpiredSessions(state);
    normalized.sessions = normalized.sessions.filter((item) => item.id !== sessionId);
    await this.writeState(normalized);
    return {
      auth: buildAuthClientState(normalized, null),
    };
  }

  async listInvites(currentUser) {
    if (!currentUser || currentUser.role !== "admin") {
      throw new Error("Only admins can manage invites.");
    }
    const state = await this.readState();
    const normalized = await this.cleanupExpiredSessions(state);
    return normalized.invites
      .slice()
      .sort((first, second) => compareDateTime(second.createdAt, first.createdAt))
      .map(sanitizeInviteForClient);
  }

  async createInvite(currentUser, input) {
    if (!currentUser || currentUser.role !== "admin") {
      throw new Error("Only admins can create invites.");
    }
    const state = await this.readState();
    const normalized = await this.cleanupExpiredSessions(state);
    const invite = {
      id: createId("inv"),
      code: createInviteCode(),
      role: sanitizeText(input.role, 20) === "admin" ? "admin" : "member",
      note: sanitizeText(input.note, 120),
      createdByUserId: currentUser.id,
      createdAt: nowIso(),
      usedAt: null,
      usedByUserId: null,
    };
    normalized.invites.unshift(invite);
    await this.writeState(normalized);
    return {
      auth: buildAuthClientState(normalized, sanitizeUserForClient(currentUser)),
      invites: normalized.invites.map(sanitizeInviteForClient),
    };
  }

  async cleanupExpiredSessions(state) {
    const normalized = normalizeAuthState(state);
    const active = normalized.sessions.filter((item) => compareDateTime(item.expiresAt, nowIso()) > 0);
    if (active.length !== normalized.sessions.length) {
      normalized.sessions = active;
      await this.writeState(normalized);
      return normalized;
    }
    return normalized;
  }

  async readState() {
    if (!this.isSQLiteBacked()) {
      return this.fileStore.read();
    }
    await this.migrateFileAuthToSQLite();
    return readAuthStateFromSQLite(this.runtimeStore.activeStore.db);
  }

  async writeState(state) {
    const normalized = normalizeAuthState(state);
    if (!this.isSQLiteBacked()) {
      return this.fileStore.write(normalized);
    }
    await writeAuthStateToSQLite(this.runtimeStore.activeStore.db, normalized);
    return normalized;
  }

  isSQLiteBacked() {
    return Boolean(
      this.runtimeStore &&
        this.runtimeStore.mode === "sqlite" &&
        this.runtimeStore.activeStore &&
        this.runtimeStore.activeStore.db
    );
  }

  async migrateFileAuthToSQLite() {
    if (!this.isSQLiteBacked()) {
      return;
    }
    const db = this.runtimeStore.activeStore.db;
    const current = db.prepare("SELECT COUNT(*) as count FROM grasspass_users").get();
    if ((current?.count || 0) > 0) {
      return;
    }
    const fileState = await this.fileStore.read();
    if (fileState.users.length === 0 && fileState.invites.length === 0 && fileState.sessions.length === 0) {
      return;
    }
    await writeAuthStateToSQLite(db, fileState);
  }
}

function readAuthStateFromSQLite(db) {
  const users = db
    .prepare("SELECT * FROM grasspass_users ORDER BY created_at ASC")
    .all()
    .map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at,
    }));

  const invites = db
    .prepare("SELECT * FROM grasspass_invites ORDER BY created_at DESC")
    .all()
    .map((row) => ({
      id: row.id,
      code: row.code,
      role: row.role,
      note: row.note,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      usedAt: row.used_at,
      usedByUserId: row.used_by_user_id,
    }));

  const sessions = db
    .prepare("SELECT * FROM grasspass_sessions ORDER BY created_at DESC")
    .all()
    .map((row) => ({
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));

  return normalizeAuthState({
    users,
    invites,
    sessions,
  });
}

async function writeAuthStateToSQLite(db, state) {
  const normalized = normalizeAuthState(state);
  const authState = {
    users: normalized.users || [],
    invites: normalized.invites || [],
    sessions: normalized.sessions || [],
  };

  const transaction = db.transaction(() => {
    // Delete users not in current set
    const userIds = authState.users.map((u) => u.id);
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM grasspass_users WHERE id NOT IN (${placeholders})`).run(...userIds);
    } else {
      db.prepare("DELETE FROM grasspass_users").run();
    }

    // Upsert users
    for (const user of authState.users) {
      db.prepare(
        `INSERT OR REPLACE INTO grasspass_users
         (id, email, display_name, role, password_hash, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        user.id,
        user.email,
        user.displayName,
        user.role,
        user.passwordHash,
        user.createdAt,
        user.updatedAt,
        user.lastLoginAt || null
      );
    }

    // Delete invites not in current set
    const inviteIds = authState.invites.map((i) => i.id);
    if (inviteIds.length > 0) {
      const placeholders = inviteIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM grasspass_invites WHERE id NOT IN (${placeholders})`).run(...inviteIds);
    } else {
      db.prepare("DELETE FROM grasspass_invites").run();
    }

    // Upsert invites
    for (const invite of authState.invites) {
      db.prepare(
        `INSERT OR REPLACE INTO grasspass_invites
         (id, code, role, note, created_by_user_id, created_at, used_at, used_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        invite.id,
        invite.code,
        invite.role,
        invite.note || null,
        invite.createdByUserId || null,
        invite.createdAt,
        invite.usedAt || null,
        invite.usedByUserId || null
      );
    }

    // Delete sessions not in current set
    const sessionIds = authState.sessions.map((s) => s.id);
    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM grasspass_sessions WHERE id NOT IN (${placeholders})`).run(...sessionIds);
    } else {
      db.prepare("DELETE FROM grasspass_sessions").run();
    }

    // Upsert sessions
    for (const session of authState.sessions) {
      db.prepare(
        `INSERT OR REPLACE INTO grasspass_sessions
         (id, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
      ).run(session.id, session.userId, session.createdAt, session.expiresAt);
    }
  });

  transaction();
}

async function createStore(options) {
  const sqliteStore = new SQLiteStore(options);
  await sqliteStore.init();
  return sqliteStore;
}

async function createAppServer(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const storageDir =
    options.storageDir || path.join(rootDir, "_private", "runtime");
  const backupDir = options.backupDir || path.join(storageDir, "backups");
  const store = new RuntimeStoreManager({
    rootDir,
    storageDir,
  });
  await store.init();
  const auth = new AuthManager({
    rootDir,
    storageDir,
    runtimeStore: store,
  });
  await auth.init();

  const jobs = createBackgroundJobs({
    store,
    backupDir,
  });

  const server = http.createServer((request, response) =>
    handleRequest(request, response, {
      rootDir,
      store,
      auth,
      jobs,
      backupDir,
    }).catch((error) => {
      sendJson(response, 500, {
        error: error.message || "Unexpected server error.",
      });
    })
  );

  return {
    server,
    store,
    jobs,
    async start(port = options.port || Number(process.env.PORT || 3000)) {
      await new Promise((resolve) => server.listen(port, resolve));
      if (options.startSchedulers !== false) {
        jobs.start();
      }
      return server.address();
    },
    async close() {
      jobs.stop();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await store.close();
    },
  };
}

async function handleRequest(request, response, context) {
  const requestUrl = new URL(request.url, "http://localhost");
  const pathname = requestUrl.pathname;
  const cookies = parseCookies(request.headers.cookie || "");
  const sessionId = cookies[SESSION_COOKIE_NAME] || "";
  const currentUser = await context.auth.requireUser(sessionId);
  const subject = currentUser?.id || APP_STATE_KEY;
  const scopedStore = {
    mode: context.store.mode,
    readSnapshot: () => context.store.readSnapshot(subject),
    writeSnapshot: (snapshot) => context.store.writeSnapshot(snapshot, subject),
    recordBackup: (metadata) => context.store.recordBackup(metadata),
    listSnapshots: () => context.store.listSnapshots(),
  };

  if (request.method === "GET" && STATIC_FILES.has(pathname)) {
    return serveStatic(response, path.join(context.rootDir, STATIC_FILES.get(pathname)));
  }

  if (request.method === "GET" && pathname.startsWith("/app/")) {
    return serveStatic(response, path.join(context.rootDir, pathname));
  }

  if (request.method === "GET" && pathname === "/api/auth/session") {
    return sendJson(response, 200, {
      ok: true,
      auth: await context.auth.getClientState(sessionId),
    });
  }

  if (request.method === "POST" && pathname === "/api/auth/register") {
    const body = await readJsonBody(request);
    const result = await context.auth.register(body);
    setSessionCookie(response, result.sessionId);
    return sendJson(response, 200, {
      ok: true,
      auth: result.auth,
    });
  }

  if (request.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJsonBody(request);
    const result = await context.auth.login(body);
    setSessionCookie(response, result.sessionId);
    return sendJson(response, 200, {
      ok: true,
      auth: result.auth,
    });
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const result = await context.auth.logout(sessionId);
    clearSessionCookie(response);
    return sendJson(response, 200, {
      ok: true,
      auth: result.auth,
    });
  }

  if (request.method === "GET" && pathname === "/api/auth/invites") {
    return sendJson(response, 200, {
      ok: true,
      invites: await context.auth.listInvites(currentUser),
    });
  }

  if (request.method === "POST" && pathname === "/api/auth/invites") {
    const body = await readJsonBody(request);
    return sendJson(response, 200, {
      ok: true,
      ...(await context.auth.createInvite(currentUser, body)),
    });
  }

  if (request.method === "GET" && pathname === "/api/config") {
    return sendJson(response, 200, {
      mapboxToken: process.env.MAPBOX_ACCESS_TOKEN || "",
    });
  }

  if (pathname.startsWith("/api/") && !currentUser) {
    return sendJson(response, 401, {
      error: "Sign in to continue.",
      auth: await context.auth.getClientState(""),
    });
  }

  if (request.method === "GET" && pathname === "/api/hort-or-hoax") {
    try {
      const item = await pickHortOrHoax(requestUrl.searchParams.get("exclude"));
      return sendJson(response, 200, { item });
    } catch (error) {
      return sendJson(response, 500, { error: "Could not load tip." });
    }
  }

  if (request.method === "GET" && pathname === "/api/health") {
    const snapshot = await scopedStore.readSnapshot();
    return sendJson(response, 200, {
      ok: true,
      health: buildHealth(snapshot),
      storage: await context.store.getClientState(),
      auth: buildAuthClientStateFromUser(currentUser, await context.auth.getClientState(sessionId)),
    });
  }

  if (request.method === "GET" && pathname === "/api/bootstrap") {
    const snapshot = await scopedStore.readSnapshot();
    let hortFact = null;
    try { hortFact = await pickHortOrHoax(null); } catch (_) {}
    return sendJson(response, 200, {
      serverTime: nowIso(),
      snapshot: sanitizeSnapshotForClient(snapshot),
      dashboard: buildDashboard(snapshot),
      health: buildHealth(snapshot),
      storage: await context.store.getClientState(),
      auth: buildAuthClientStateFromUser(currentUser, await context.auth.getClientState(sessionId)),
      legacyKey: LEGACY_STORAGE_KEY,
      hortFact,
    });
  }

  if (request.method === "GET" && pathname === "/api/storage") {
    return sendJson(response, 200, {
      ok: true,
      storage: await context.store.getClientState(),
    });
  }

  if (request.method === "GET" && pathname === "/api/timeline") {
    const snapshot = await scopedStore.readSnapshot();
    const range = sanitizeText(requestUrl.searchParams.get("range"), 20) || "month";
    const anchor = sanitizeDate(requestUrl.searchParams.get("anchor")) || todayIso();
    return sendJson(response, 200, await buildTimelinePayload(snapshot, { range, anchor }));
  }

  if (request.method === "GET" && pathname === "/api/weather/suggestions") {
    const query = sanitizeText(requestUrl.searchParams.get("q"), 160);
    return sendJson(response, 200, {
      ok: true,
      suggestions: await searchLocationSuggestions(query),
    });
  }

  if (request.method === "GET" && pathname === "/api/export") {
    const snapshot = await scopedStore.readSnapshot();
    const portableExport = createPortableExport(snapshot, {
      reason: "manual-export",
    });
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="grasspass-export-${todayIso()}.json"`,
    });
    response.end(JSON.stringify(portableExport, null, 2));
    return;
  }

  return handleMutationRequest(
    request,
    response,
    {
      ...context,
      currentUser,
      subject,
      scopedStore,
    },
    pathname
  );
}

async function handleMutationRequest(request, response, context, pathname) {
  const { scopedStore, subject } = context;
  if (request.method === "POST" && pathname === "/api/seed-demo") {
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) =>
      buildDemoState(draft)
    );
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  if (request.method === "POST" && pathname === "/api/reset") {
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) =>
      resetStatePreservingOperations(draft)
    );
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  if (request.method === "PATCH" && pathname === "/api/profile") {
    const body = await readJsonBody(request);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.profile.propertyName =
        sanitizeText(body.propertyName, 80) || draft.profile.propertyName;
      draft.profile.location = sanitizeText(body.location, 160);
      draft.profile.manualAreaSqFt = sanitizeNumber(body.manualAreaSqFt, {
        min: 1,
        max: 250000,
        decimals: 0,
      });
      draft.profile.updatedAt = nowIso();
      return draft;
    });
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  if (request.method === "POST" && pathname === "/api/import") {
    const body = await readJsonBody(request);
    const incoming = body?.snapshot || body?.data || body;
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) =>
      importPortableSnapshot(draft, incoming)
    );
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  if (request.method === "POST" && pathname === "/api/migrate/local-storage") {
    const body = await readJsonBody(request);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) =>
      migrateLegacyLocalState(draft, body?.legacyState)
    );
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  if (request.method === "POST" && pathname === "/api/backups/run") {
    const metadata = await context.jobs.runBackupNow("manual", subject);
    const snapshot = await scopedStore.readSnapshot();
    return sendJson(response, 200, {
      ok: true,
      backup: metadata,
      snapshot: sanitizeSnapshotForClient(snapshot),
      dashboard: buildDashboard(snapshot),
      health: buildHealth(snapshot),
      storage: await context.store.getClientState(),
    });
  }

  if (request.method === "POST" && pathname === "/api/google/connect") {
    const body = await readJsonBody(request);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      const googleCalendar = draft.integrations.googleCalendar;
      googleCalendar.connected = true;
      googleCalendar.calendarId =
        sanitizeText(body.calendarId, 160) || googleCalendar.calendarId || "primary";
      const accessToken = sanitizeText(body.accessToken, 4096);
      if (accessToken) {
        googleCalendar.accessToken = accessToken;
      }
      googleCalendar.connectedAt = nowIso();
      googleCalendar.lastError = null;
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  if (request.method === "POST" && pathname === "/api/google/disconnect") {
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.integrations.googleCalendar.connected = false;
      draft.integrations.googleCalendar.accessToken = "";
      draft.integrations.googleCalendar.lastError = null;
      draft.integrations.googleCalendar.connectedAt = nowIso();
      return draft;
    });
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  if (request.method === "POST" && pathname === "/api/rachio/connect") {
    const body = await readJsonBody(request);
    const apiKey = String(body?.apiKey || "").trim().replace(/^Bearer\s+/i, "");
    if (!apiKey) {
      return sendJson(response, 400, { error: "API key required" });
    }
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.integrations.rachio.apiKey = apiKey;
      draft.integrations.rachio.connected = true;
      return draft;
    });
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  if (request.method === "POST" && pathname === "/api/rachio/disconnect") {
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.integrations.rachio.apiKey = "";
      draft.integrations.rachio.connected = false;
      draft.integrations.rachio.lastSyncAt = null;
      return draft;
    });
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  if (request.method === "POST" && pathname === "/api/google/resync") {
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      rebuildSyncQueue(draft, { forcePending: true });
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  if (request.method === "POST" && pathname === "/api/google/retry") {
    const body = await readJsonBody(request);
    const retryIds = Array.isArray(body?.ids)
      ? body.ids.map((item) => sanitizeText(item, 80)).filter(Boolean)
      : [];
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.syncQueue = draft.syncQueue.map((item) => {
        if (retryIds.length > 0 && !retryIds.includes(item.id)) {
          return item;
        }

        if (item.status !== "failed") {
          return item;
        }

        return normalizeQueueItem(
          {
            ...item,
            status: "pending",
            lastError: null,
          },
          draft
        );
      });
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  const zoneMatch = pathname.match(/^\/api\/zones\/([^/]+)$/);
  if (request.method === "POST" && pathname === "/api/zones") {
    const body = await readJsonBody(request);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.zones.unshift(normalizeZone(body));
      sortZones(draft);
      return draft;
    });
    return sendMutationResponse(response, nextSnapshot, context.store);
  }
  if (zoneMatch && request.method === "PATCH") {
    const body = await readJsonBody(request);
    const zoneId = decodeURIComponent(zoneMatch[1]);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      const existing = findById(draft.zones, zoneId);
      if (!existing) {
        throw new Error("Zone not found.");
      }
      Object.assign(existing, normalizeZone({ ...existing, ...body, id: zoneId }));
      sortZones(draft);
      return draft;
    });
    return sendMutationResponse(response, nextSnapshot, context.store);
  }
  if (zoneMatch && request.method === "DELETE") {
    const zoneId = decodeURIComponent(zoneMatch[1]);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.zones = draft.zones.filter((item) => item.id !== zoneId);
      draft.treatments = draft.treatments.map((item) =>
        item.zoneId === zoneId ? normalizeTreatment({ ...item, zoneId: "" }) : item
      );
      draft.mowingLogs = draft.mowingLogs.map((item) =>
        item.zoneId === zoneId ? normalizeMowing({ ...item, zoneId: "" }) : item
      );
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
  if (request.method === "POST" && pathname === "/api/products") {
    const body = await readJsonBody(request);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.products.unshift(normalizeProduct(body));
      sortProducts(draft);
      return draft;
    });
    return sendMutationResponse(response, nextSnapshot, context.store);
  }
  if (productMatch && request.method === "PATCH") {
    const body = await readJsonBody(request);
    const productId = decodeURIComponent(productMatch[1]);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      const existing = findById(draft.products, productId);
      if (!existing) {
        throw new Error("Product not found.");
      }
      Object.assign(
        existing,
        normalizeProduct({ ...existing, ...body, id: productId })
      );
      sortProducts(draft);
      return draft;
    });
    return sendMutationResponse(response, nextSnapshot, context.store);
  }
  if (productMatch && request.method === "DELETE") {
    const productId = decodeURIComponent(productMatch[1]);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.products = draft.products.filter((item) => item.id !== productId);
      draft.treatments = draft.treatments.map((item) =>
        item.productId === productId
          ? normalizeTreatment({ ...item, productId: "" })
          : item
      );
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  const treatmentMatch = pathname.match(/^\/api\/treatments\/([^/]+)$/);
  if (request.method === "POST" && pathname === "/api/treatments") {
    const body = await readJsonBody(request);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.treatments.unshift(normalizeTreatment(body));
      sortTreatments(draft);
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }
  if (treatmentMatch && request.method === "PATCH") {
    const body = await readJsonBody(request);
    const treatmentId = decodeURIComponent(treatmentMatch[1]);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      const existing = findById(draft.treatments, treatmentId);
      if (!existing) {
        throw new Error("Treatment not found.");
      }
      Object.assign(
        existing,
        normalizeTreatment({ ...existing, ...body, id: treatmentId })
      );
      sortTreatments(draft);
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }
  if (treatmentMatch && request.method === "DELETE") {
    const treatmentId = decodeURIComponent(treatmentMatch[1]);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.treatments = draft.treatments.filter((item) => item.id !== treatmentId);
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  const mowingMatch = pathname.match(/^\/api\/mowing\/([^/]+)$/);
  if (request.method === "POST" && pathname === "/api/mowing") {
    const body = await readJsonBody(request);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.mowingLogs.unshift(normalizeMowing(body));
      sortMowingLogs(draft);
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }
  if (mowingMatch && request.method === "PATCH") {
    const body = await readJsonBody(request);
    const mowingId = decodeURIComponent(mowingMatch[1]);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      const existing = findById(draft.mowingLogs, mowingId);
      if (!existing) {
        throw new Error("Mowing log not found.");
      }
      Object.assign(existing, normalizeMowing({ ...existing, ...body, id: mowingId }));
      sortMowingLogs(draft);
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }
  if (mowingMatch && request.method === "DELETE") {
    const mowingId = decodeURIComponent(mowingMatch[1]);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.mowingLogs = draft.mowingLogs.filter((item) => item.id !== mowingId);
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  const wateringMatch = pathname.match(/^\/api\/waterings\/([^/]+)$/);
  if (request.method === "POST" && pathname === "/api/waterings") {
    const body = await readJsonBody(request);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.waterings.unshift(normalizeWatering(body));
      sortWaterings(draft);
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }
  if (wateringMatch && request.method === "PATCH") {
    const body = await readJsonBody(request);
    const wateringId = decodeURIComponent(wateringMatch[1]);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      const existing = findById(draft.waterings, wateringId);
      if (!existing) {
        throw new Error("Watering not found.");
      }
      Object.assign(existing, normalizeWatering({ ...existing, ...body, id: wateringId }));
      sortWaterings(draft);
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }
  if (wateringMatch && request.method === "DELETE") {
    const wateringId = decodeURIComponent(wateringMatch[1]);
    const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
      draft.waterings = draft.waterings.filter((item) => item.id !== wateringId);
      rebuildSyncQueue(draft);
      return draft;
    });
    await context.jobs.processQueueNow();
    return sendMutationResponse(response, nextSnapshot, context.store);
  }

  if (request.method === "POST" && pathname === "/api/waterings/sync-rachio") {
    try {
      const currentSnapshot = await scopedStore.readSnapshot();
      const apiKey = currentSnapshot.integrations.rachio?.apiKey || process.env.RACHIO_API_KEY;
      if (!apiKey) {
        return sendJson(response, 400, {
          error: "Rachio API key required. Save your API key in Settings first.",
        });
      }

      const rachioWaterings = await fetchRachioWaterings(apiKey);
      const nextSnapshot = await mutateSnapshot(scopedStore, (draft) => {
        for (const watering of rachioWaterings) {
          const normalized = normalizeWatering(watering);
          const existing = draft.waterings.find(
            (w) => w.date === normalized.date && w.zoneId === normalized.zoneId && w.source === "rachio"
          );
          if (!existing) {
            draft.waterings.unshift(normalized);
          }
        }
        draft.integrations.rachio.lastSyncAt = nowIso();
        sortWaterings(draft);
        rebuildSyncQueue(draft);
        return draft;
      });
      await context.jobs.processQueueNow();
      return sendMutationResponse(response, nextSnapshot, context.store);
    } catch (error) {
      return sendJson(response, 400, {
        error: error.message || "Failed to sync Rachio waterings",
      });
    }
  }

  sendJson(response, 404, {
    error: `No route for ${request.method} ${pathname}`,
  });
}

async function dispatchGoogleCalendarEvent(googleCalendar, queueItem) {
  const calendarId = encodeURIComponent(googleCalendar.calendarId || "primary");
  const baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`;
  const headers = {
    Authorization: `Bearer ${googleCalendar.accessToken}`,
    "Content-Type": "application/json",
  };

  if (queueItem.action === "delete") {
    if (!queueItem.googleEventId) {
      return { deleted: true };
    }

    const response = await fetch(
      `${baseUrl}/${encodeURIComponent(queueItem.googleEventId)}`,
      {
        method: "DELETE",
        headers,
      }
    );

    if (response.status === 404 || response.status === 410) {
      return { deleted: true };
    }

    if (!response.ok) {
      throw new Error(await extractGoogleError(response));
    }

    return { deleted: true };
  }

  const response = await fetch(
    queueItem.googleEventId
      ? `${baseUrl}/${encodeURIComponent(queueItem.googleEventId)}`
      : baseUrl,
    {
      method: queueItem.googleEventId ? "PUT" : "POST",
      headers,
      body: JSON.stringify(queueItem.payload),
    }
  );

  if (!response.ok) {
    throw new Error(await extractGoogleError(response));
  }

  const payload = await response.json();
  return {
    googleEventId: sanitizeText(payload.id, 160),
  };
}

async function extractGoogleError(response) {
  try {
    const payload = await response.json();
    return (
      sanitizeText(payload?.error?.message, 280) ||
      `Google Calendar request failed (${response.status}).`
    );
  } catch (error) {
    return `Google Calendar request failed (${response.status}).`;
  }
}

function rebuildSyncQueue(snapshot, options = {}) {
  const previousMap = new Map(
    snapshot.syncQueue.map((item) => [queueNaturalKey(item), item])
  );
  const nextItems = [];
  const desiredItems = buildDesiredSyncItems(snapshot);
  const desiredKeys = new Set();

  desiredItems.forEach((item) => {
    const key = queueNaturalKey(item);
    desiredKeys.add(key);
    const previous = previousMap.get(key);
    const samePayload =
      previous && JSON.stringify(previous.payload) === JSON.stringify(item.payload);
    const shouldKeepStatus =
      previous &&
      samePayload &&
      previous.action === item.action &&
      !options.forcePending;

    nextItems.push(
      normalizeQueueItem(
        {
          ...previous,
          ...item,
          id: previous?.id || item.id,
          status: shouldKeepStatus
            ? previous.status === "processing"
              ? "pending"
              : previous.status
            : "pending",
          attempts: shouldKeepStatus ? previous.attempts : 0,
          lastError:
            shouldKeepStatus && previous.status === "failed"
              ? previous.lastError
              : null,
          googleEventId: previous?.googleEventId || "",
          updatedAt: nowIso(),
        },
        snapshot
      )
    );
  });

  snapshot.syncQueue
    .filter(
      (item) =>
        !desiredKeys.has(queueNaturalKey(item)) &&
        item.googleEventId &&
        item.action !== "delete"
    )
    .forEach((item) => {
      nextItems.push(
        normalizeQueueItem(
          {
            ...item,
            action: "delete",
            status: "pending",
            attempts: 0,
            lastError: null,
            updatedAt: nowIso(),
          },
          snapshot
        )
      );
    });

  snapshot.syncQueue = nextItems.sort((first, second) => {
    if (first.date !== second.date) {
      return compareIsoDate(first.date, second.date);
    }
    return compareDateTime(first.updatedAt, second.updatedAt);
  });
}

function buildDesiredSyncItems(snapshot) {
  const items = [];
  const from = addDays(todayIso(), -180);
  const to = addDays(todayIso(), 365);

  snapshot.treatments
    .filter((item) => item.pushToGoogle)
    .forEach((treatment) => {
      expandTreatmentOccurrences(treatment, { start: from, end: to }).forEach(
        (occurrence) => {
          items.push({
            id: createId("sync"),
            entityType: "treatment",
            entityId: treatment.id,
            date: occurrence.date,
            action: "upsert",
            status: "pending",
            label: `${treatment.type} • ${resolveZoneName(snapshot, treatment.zoneId)}`,
            payload: buildGooglePayloadForTreatment(
              snapshot,
              treatment,
              occurrence.date,
              occurrence.isProjected
            ),
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
        }
      );
    });

  snapshot.mowingLogs
    .filter((item) => item.pushToGoogle)
    .forEach((entry) => {
      items.push({
        id: createId("sync"),
        entityType: "mowing",
        entityId: entry.id,
        date: entry.date,
        action: "upsert",
        status: "pending",
        label: `Mowing • ${resolveZoneName(snapshot, entry.zoneId)}`,
        payload: buildGooglePayloadForMowing(snapshot, entry),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    });

  return items;
}

function buildGooglePayloadForTreatment(snapshot, treatment, occurrenceDate, isProjected) {
  const zoneName = resolveZoneName(snapshot, treatment.zoneId);
  const productName = resolveProductName(snapshot, treatment.productId);
  const descriptionLines = [
    `GrassPass treatment plan`,
    `Zone: ${zoneName}`,
    `Status: ${isProjected ? "Scheduled recurrence" : treatment.status}`,
  ];

  if (productName) {
    descriptionLines.push(`Product: ${productName}`);
  }
  if (treatment.repeatDays) {
    descriptionLines.push(`Repeats every ${treatment.repeatDays} day(s)`);
  }
  if (treatment.notes) {
    descriptionLines.push(`Notes: ${treatment.notes}`);
  }

  return {
    summary: `GrassPass • ${treatment.type} • ${zoneName}`,
    description: descriptionLines.join("\n"),
    start: { date: occurrenceDate },
    end: { date: addDays(occurrenceDate, 1) },
    extendedProperties: {
      private: {
        grasspassEntity: "treatment",
        grasspassId: treatment.id,
        grasspassDate: occurrenceDate,
      },
    },
  };
}

function buildGooglePayloadForMowing(snapshot, entry) {
  const zoneName = resolveZoneName(snapshot, entry.zoneId);
  const descriptionLines = [
    `GrassPass mowing log`,
    `Zone: ${zoneName}`,
    `Height: ${entry.heightInches}"`,
    `Duration: ${entry.durationMinutes} minutes`,
    `Clippings: ${entry.clippings}`,
  ];

  if (entry.notes) {
    descriptionLines.push(`Notes: ${entry.notes}`);
  }

  return {
    summary: `GrassPass • Mowing • ${zoneName}`,
    description: descriptionLines.join("\n"),
    start: { date: entry.date },
    end: { date: addDays(entry.date, 1) },
    extendedProperties: {
      private: {
        grasspassEntity: "mowing",
        grasspassId: entry.id,
        grasspassDate: entry.date,
      },
    },
  };
}

function importPortableSnapshot(currentSnapshot, incoming) {
  const safeIncoming = isObject(incoming)
    ? incoming.snapshot && isObject(incoming.snapshot)
      ? incoming.snapshot
      : incoming
    : {};
  const next = normalizeState(safeIncoming, {
    storageMode: currentSnapshot.meta.storageMode,
  });
  next.integrations.googleCalendar.accessToken =
    currentSnapshot.integrations.googleCalendar.accessToken;
  next.integrations.googleCalendar.connected =
    currentSnapshot.integrations.googleCalendar.connected;
  next.integrations.googleCalendar.calendarId =
    currentSnapshot.integrations.googleCalendar.calendarId;
  next.integrations.rachio.apiKey =
    currentSnapshot.integrations.rachio?.apiKey || "";
  next.integrations.rachio.connected =
    currentSnapshot.integrations.rachio?.connected || false;
  next.backups.intervalMinutes = currentSnapshot.backups.intervalMinutes;
  next.migrationJournal.unshift(
    normalizeMigrationEntry({
      type: "import",
      detail: "Portable JSON import applied.",
    })
  );
  rebuildSyncQueue(next, { forcePending: true });
  return next;
}

function migrateLegacyLocalState(currentSnapshot, legacyState) {
  const next = resetStatePreservingOperations(currentSnapshot);
  const legacy = isObject(legacyState) ? legacyState : {};
  const zoneMap = new Map();

  function getZoneIdByName(name, extras = {}) {
    const normalizedName = sanitizeText(name, 80);
    if (!normalizedName) {
      return "";
    }

    const key = normalizedName.toLowerCase();
    const existingId = zoneMap.get(key);
    if (existingId) {
      return existingId;
    }

    const zone = normalizeZone({
      name: normalizedName,
      ...extras,
    });
    next.zones.push(zone);
    zoneMap.set(key, zone.id);
    return zone.id;
  }

  const legacyProducts = Array.isArray(legacy.products) ? legacy.products : [];
  next.products = legacyProducts.map((item) =>
    normalizeProduct({
      ...item,
      id: sanitizeText(item?.id, 80) || createId("prd"),
      coverageRateSqFt: item?.coverageRate,
    })
  );

  const importedZoneNames = new Set();
  const legacyTreatments = Array.isArray(legacy.treatments) ? legacy.treatments : [];
  const legacyMowingLogs = Array.isArray(legacy.mowingLogs) ? legacy.mowingLogs : [];

  legacyTreatments.forEach((item) => {
    const zoneName = sanitizeText(item?.zone, 80);
    if (zoneName) {
      importedZoneNames.add(zoneName);
    }
  });
  legacyMowingLogs.forEach((item) => {
    const zoneName = sanitizeText(item?.zone, 80);
    if (zoneName) {
      importedZoneNames.add(zoneName);
    }
  });

  importedZoneNames.forEach((zoneName) => {
    getZoneIdByName(zoneName);
  });

  const polygonGeometry = normalizeGeometry(legacy?.map?.polygonGeoJson);
  if (polygonGeometry) {
    const zoneName =
      importedZoneNames.size === 1
        ? [...importedZoneNames][0]
        : sanitizeText(legacy?.profile?.propertyName, 80) || "Mapped Lawn";
    const zoneId = getZoneIdByName(zoneName, {
      areaSqFt: legacy?.map?.lawnSqFt || legacy?.profile?.lawnSqFt,
      geometry: polygonGeometry,
      lastValidGeometry: polygonGeometry,
    });
    const mappedZone = findById(next.zones, zoneId);
    if (mappedZone) {
      mappedZone.geometry = polygonGeometry;
      mappedZone.lastValidGeometry = polygonGeometry;
      mappedZone.areaSqFt =
        sanitizeNumber(legacy?.map?.lawnSqFt, {
          min: 1,
          max: 250000,
          decimals: 0,
        }) || mappedZone.areaSqFt;
    }
  }

  next.treatments = legacyTreatments.map((item) =>
    normalizeTreatment({
      id: sanitizeText(item?.id, 80) || createId("trt"),
      date: item?.date,
      zoneId: getZoneIdByName(item?.zone),
      type: item?.type,
      productId: sanitizeText(item?.productId, 80),
      repeatDays: item?.repeatDays,
      notes: item?.notes,
      status: item?.status,
      createdAt: item?.createdAt,
      updatedAt: item?.createdAt,
    })
  );

  next.mowingLogs = legacyMowingLogs.map((item) =>
    normalizeMowing({
      id: sanitizeText(item?.id, 80) || createId("mow"),
      date: item?.date,
      zoneId: getZoneIdByName(item?.zone),
      durationMinutes: item?.duration,
      heightInches: item?.height,
      clippings: item?.clippings,
      notes: item?.notes,
      createdAt: item?.createdAt,
      updatedAt: item?.createdAt,
    })
  );

  next.profile.propertyName =
    sanitizeText(legacy?.profile?.propertyName, 80) || currentSnapshot.profile.propertyName;
  next.profile.manualAreaSqFt = sanitizeNumber(
    legacy?.profile?.lawnSqFt ?? legacy?.map?.lawnSqFt,
    {
      min: 1,
      max: 250000,
      decimals: 0,
    }
  );
  next.profile.updatedAt = nowIso();
  next.migrationJournal.unshift(
    normalizeMigrationEntry({
      type: "localStorage-migration",
      detail: `Imported legacy data from ${LEGACY_STORAGE_KEY}.`,
    })
  );

  sortZones(next);
  sortProducts(next);
  sortTreatments(next);
  sortMowingLogs(next);
  rebuildSyncQueue(next, { forcePending: true });
  return next;
}

function buildDemoState(currentSnapshot) {
  const next = resetStatePreservingOperations(currentSnapshot);
  const today = todayIso();
  const frontZone = normalizeZone({
    name: "Front Lawn",
    surface: "Cool-Season",
    notes: "Street-facing mix that gets the earliest sun.",
    areaSqFt: 3600,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-98.3512, 39.5009],
          [-98.3496, 39.5009],
          [-98.3496, 39.4998],
          [-98.3512, 39.4998],
          [-98.3512, 39.5009],
        ],
      ],
    },
  });
  const backZone = normalizeZone({
    name: "Backyard",
    surface: "Mixed Turf",
    notes: "Holds moisture longer and handles family traffic.",
    areaSqFt: 2950,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-98.3515, 39.4994],
          [-98.3492, 39.4994],
          [-98.3492, 39.4979],
          [-98.3515, 39.4979],
          [-98.3515, 39.4994],
        ],
      ],
    },
  });
  const sideZone = normalizeZone({
    name: "Side Strip",
    surface: "Warm-Season",
    notes: "High-heat edge zone for spot control work.",
    areaSqFt: 1180,
  });

  const fertilizer = normalizeProduct({
    name: "Turf Builder Lawn Food",
    category: "Fertilizer",
    activeIngredient: "Nitrogen blend",
    coverageRateSqFt: 5000,
    quantity: 1.5,
    unit: "bag",
    notes: "Water within 24 hours when temperatures stay under 80 F.",
  });
  const herbicide = normalizeProduct({
    name: "Broadleaf Control",
    category: "Herbicide",
    activeIngredient: "2,4-D",
    coverageRateSqFt: 4000,
    quantity: 1,
    unit: "bottle",
    notes: "Target low-wind evenings.",
  });

  next.zones = [frontZone, backZone, sideZone];
  next.products = [fertilizer, herbicide];
  next.treatments = [
    normalizeTreatment({
      type: "Fertilizer",
      date: addDays(today, 2),
      zoneId: frontZone.id,
      productId: fertilizer.id,
      repeatDays: 42,
      notes: "Water in lightly after application.",
      status: "Scheduled",
    }),
    normalizeTreatment({
      type: "Herbicide",
      date: addDays(today, -6),
      zoneId: sideZone.id,
      productId: herbicide.id,
      repeatDays: 0,
      notes: "Avoid mowing for two days after spot treatment.",
      status: "Completed",
    }),
  ];
  next.mowingLogs = [
    normalizeMowing({
      date: addDays(today, -1),
      zoneId: frontZone.id,
      durationMinutes: 38,
      heightInches: 3.25,
      clippings: "Mulched",
      notes: "Dry cut with clean stripes.",
    }),
    normalizeMowing({
      date: addDays(today, -4),
      zoneId: backZone.id,
      durationMinutes: 44,
      heightInches: 3.5,
      clippings: "Bagged",
      notes: "Heavy spring flush after rain.",
    }),
  ];
  next.profile.propertyName = "Verdant House";
  next.profile.manualAreaSqFt = 7730;
  next.profile.updatedAt = nowIso();
  next.migrationJournal.unshift(
    normalizeMigrationEntry({
      type: "demo-seed",
      detail: "Demo data loaded for timeline, map, and sync verification.",
    })
  );
  rebuildSyncQueue(next, { forcePending: true });
  return next;
}

function resetStatePreservingOperations(currentSnapshot) {
  const next = createDefaultState(currentSnapshot.meta.storageMode);
  next.backups.intervalMinutes = currentSnapshot.backups.intervalMinutes;
  next.integrations.googleCalendar = {
    ...next.integrations.googleCalendar,
    connected: currentSnapshot.integrations.googleCalendar.connected,
    calendarId: currentSnapshot.integrations.googleCalendar.calendarId,
    accessToken: currentSnapshot.integrations.googleCalendar.accessToken,
    connectedAt: currentSnapshot.integrations.googleCalendar.connectedAt,
    lastSyncAt: currentSnapshot.integrations.googleCalendar.lastSyncAt,
    lastError: null,
  };
  next.migrationJournal.unshift(
    normalizeMigrationEntry({
      type: "reset",
      detail: "Application data reset while operational settings were preserved.",
    })
  );
  return next;
}

function queueNaturalKey(item) {
  return [item.entityType, item.entityId, item.date].join(":");
}

function summarizeQueue(queue) {
  return queue.reduce(
    (summary, item) => {
      summary.total += 1;
      summary[item.status] += 1;
      return summary;
    },
    {
      total: 0,
      pending: 0,
      processing: 0,
      synced: 0,
      failed: 0,
    }
  );
}

function getBackupFreshness(backups) {
  const intervalMinutes =
    sanitizeNumber(backups.intervalMinutes, {
      min: 15,
      max: 7 * 24 * 60,
      decimals: 0,
    }) || DEFAULT_BACKUP_INTERVAL_MINUTES;
  if (!backups.lastBackupAt) {
    return {
      label: "Never backed up",
      tone: "warning",
      lastBackupAt: null,
      intervalMinutes,
    };
  }

  const ageMinutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(backups.lastBackupAt).getTime()) / 60000)
  );

  if (ageMinutes <= intervalMinutes) {
    return {
      label: "Fresh backup",
      tone: "healthy",
      lastBackupAt: backups.lastBackupAt,
      intervalMinutes,
    };
  }

  if (ageMinutes <= intervalMinutes * 2) {
    return {
      label: "Backup aging",
      tone: "warning",
      lastBackupAt: backups.lastBackupAt,
      intervalMinutes,
    };
  }

  return {
    label: "Backup attention needed",
    tone: "danger",
    lastBackupAt: backups.lastBackupAt,
    intervalMinutes,
  };
}

function getTimelineWindow(range, anchor) {
  const safeAnchor = sanitizeDate(anchor) || todayIso();
  if (range === "week") {
    const start = startOfWeek(safeAnchor);
    const end = addDays(start, 6);
    return {
      range: "week",
      start,
      end,
      label: `${formatShortDate(start)} - ${formatShortDate(end)}`,
    };
  }

  const start = startOfMonth(safeAnchor);
  const end = endOfMonth(safeAnchor);
  return {
    range: "month",
    start,
    end,
    label: formatMonthLabel(safeAnchor),
  };
}

function getTotalArea(snapshot) {
  const zonedArea = snapshot.zones.reduce(
    (sum, zone) => sum + (zone.areaSqFt || 0),
    0
  );
  return zonedArea || snapshot.profile.manualAreaSqFt || null;
}

function resolveZoneName(snapshot, zoneId) {
  const match = findById(snapshot.zones, zoneId);
  return match ? match.name : "Unassigned";
}

function resolveProductName(snapshot, productId) {
  const match = findById(snapshot.products, productId);
  return match ? match.name : "";
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

function findById(collection, id) {
  return collection.find((item) => item.id === id) || null;
}

async function pruneBackupDirectory(backupDir, keepCount) {
  try {
    const entries = await fs.readdir(backupDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const fullPath = path.join(backupDir, entry.name);
          const stat = await fs.stat(fullPath);
          return {
            path: fullPath,
            mtimeMs: stat.mtimeMs,
          };
        })
    );

    const sorted = files.sort((first, second) => second.mtimeMs - first.mtimeMs);
    const toDelete = sorted.slice(keepCount);
    await Promise.all(toDelete.map((item) => fs.unlink(item.path)));
  } catch (error) {}
}

// Inject dependencies into the background jobs module
setJobsDependencies({
  dispatchGoogleCalendarEvent,
  createPortableExport,
  pruneBackupDirectory,
});

async function serveStatic(response, filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypeForFile(filePath),
    });
    response.end(buffer);
  } catch (error) {
    sendJson(response, 404, { error: "Static file not found." });
  }
}

async function sendMutationResponse(response, snapshot, store) {
  return sendJson(response, 200, {
    ok: true,
    snapshot: sanitizeSnapshotForClient(snapshot),
    dashboard: buildDashboard(snapshot),
    health: buildHealth(snapshot),
    storage: store ? await store.getClientState() : undefined,
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function setSessionCookie(response, sessionId) {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}`
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const payload = Buffer.concat(chunks).toString("utf8");
  if (!payload.trim()) {
    return {};
  }
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error("Request body must be valid JSON.");
  }
}

function contentTypeForFile(filePath) {
  const extension = path.extname(filePath);
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function parseCookies(rawCookieHeader) {
  return String(rawCookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) {
        return accumulator;
      }
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (key) {
        accumulator[key] = decodeURIComponent(value);
      }
      return accumulator;
    }, {});
}

function subjectToStateKey(subject = APP_STATE_KEY) {
  return subject === APP_STATE_KEY ? APP_STATE_KEY : `user:${subject}`;
}

function stateKeyToSubject(stateKey = APP_STATE_KEY) {
  return stateKey === APP_STATE_KEY ? APP_STATE_KEY : String(stateKey).replace(/^user:/, "");
}

function jsonValue(value) {
  return value ? JSON.stringify(value) : null;
}

function nullableTimestamp(value) {
  return value || null;
}

function sanitizeText(value, maxLength = 200) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeEmail(value) {
  return sanitizeText(value, 160).toLowerCase();
}

function sanitizeNumber(value, options = {}) {
  const { min = 0, max = Number.MAX_SAFE_INTEGER, decimals = 2 } = options;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const bounded = Math.min(max, Math.max(min, parsed));
  return Number(bounded.toFixed(decimals));
}

function sanitizeBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function sanitizeDate(value) {
  const normalized = sanitizeText(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return "";
  }
  const [year, month, day] = normalized.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return "";
  }
  return normalized;
}

function sanitizeDateTime(value) {
  const normalized = sanitizeText(value, 40);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function addDaysIso(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${derivedKey}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expected] = String(storedHash || "").split(":");
  if (!salt || !expected) {
    return false;
  }
  const derivedKey = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(derivedKey, "hex"));
}

function sanitizeUserForClient(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function sanitizeInviteForClient(invite) {
  return {
    id: invite.id,
    code: invite.code,
    role: invite.role,
    note: invite.note,
    createdAt: invite.createdAt,
    usedAt: invite.usedAt,
    usedByUserId: invite.usedByUserId,
  };
}

function buildAuthClientState(state, user) {
  const currentUser = user ? sanitizeUserForClient(user) : null;
  return {
    setupRequired: state.users.length === 0,
    inviteOnly: state.users.length > 0,
    user: currentUser,
    usersCount: state.users.length,
    invitesCount: state.invites.filter((item) => !item.usedAt).length,
  };
}

function buildAuthClientStateFromUser(user, fallbackState) {
  if (!fallbackState) {
    return null;
  }
  return {
    ...fallbackState,
    user: user ? sanitizeUserForClient(user) : fallbackState.user || null,
  };
}

function createSessionRecord(userId) {
  return {
    id: crypto.randomBytes(24).toString("hex"),
    userId,
    createdAt: nowIso(),
    expiresAt: addDaysIso(SESSION_TTL_DAYS),
  };
}

function createInviteCode() {
  return `${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase()}`;
}


function normalizeGeometry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (value.type === "Feature" && value.geometry) {
    return normalizeGeometry(value.geometry);
  }
  if (
    (value.type === "Polygon" || value.type === "MultiPolygon") &&
    Array.isArray(value.coordinates)
  ) {
    return structuredClone({
      type: value.type,
      coordinates: value.coordinates,
    });
  }
  return null;
}

function normalizeQueueStatus(value) {
  const normalized = sanitizeText(value, 20).toLowerCase();
  if (["pending", "processing", "synced", "failed"].includes(normalized)) {
    return normalized;
  }
  return "pending";
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function pickHortOrHoax(excludeId) {
  if (!_hortOrHoaxCache) {
    const raw = await fs.readFile(HORT_OR_HOAX_PATH, "utf8");
    _hortOrHoaxCache = JSON.parse(raw).items;
  }
  const items = _hortOrHoaxCache;
  const excludeNum = excludeId ? parseInt(excludeId, 10) : null;
  const pool = excludeNum && items.length > 1
    ? items.filter((item) => item.id !== excludeNum)
    : items;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function fetchRachioWaterings(apiKey) {
  if (!apiKey) {
    throw new Error("Rachio API key required");
  }
  try {
    const normalizedApiKey = String(apiKey).trim().replace(/^Bearer\s+/i, "");
    const authHeaders = [
      { authorization: normalizedApiKey },
      { authorization: `Bearer ${normalizedApiKey}` },
    ];
    const personInfoUrls = [
      "https://api.rach.io/1/public/person/info",
      "https://api.rach.io/1/person/info",
    ];

    let userData = null;
    let lastUserError = null;
    let workingHeaders = null;
    let workingInfoUrl = null;

    for (const infoUrl of personInfoUrls) {
      for (const headers of authHeaders) {
        try {
          const response = await fetch(infoUrl, {
            method: "GET",
            headers,
          });
          if (!response.ok) {
            lastUserError = `Rachio user info failed (${response.status}) at ${infoUrl}`;
            continue;
          }
          userData = await response.json();
          workingHeaders = headers;
          workingInfoUrl = infoUrl;
          break;
        } catch (error) {
          lastUserError = error.message;
        }
      }
      if (userData) {
        break;
      }
    }

    if (!userData || !userData.id) {
      throw new Error(
        `Rachio authentication failed. Please confirm your API key in the Rachio web app account settings. ${lastUserError || ""}`.trim()
      );
    }

    const personId = userData.id;
    const personBasePath = workingInfoUrl && workingInfoUrl.includes("/public/") ? "public/person" : "person";
    const personUrl = `https://api.rach.io/1/${personBasePath}/${personId}`;

    const devicesRes = await fetch(personUrl, {
      method: "GET",
      headers: workingHeaders,
    });

    if (!devicesRes.ok) {
      throw new Error(`Rachio API error: ${devicesRes.status}. Unable to fetch devices for this account.`);
    }

    const devicesData = await devicesRes.json();
    const devices = devicesData.devices || [];

    // Collect all scheduled events from all zones
    const waterings = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thirtyDaysOut = new Date(today);
    thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);

    for (const device of devices) {
      for (const zone of device.zones || []) {
        // Parse schedule from zone if available
        if (zone.schedule && Array.isArray(zone.schedule)) {
          for (const scheduleItem of zone.schedule) {
            // Extract watering time from zone schedule
            const wateringDate = new Date(today);
            if (scheduleItem.startTime) {
              const [hours, minutes] = scheduleItem.startTime.split(":").map(Number);
              wateringDate.setHours(hours, minutes, 0, 0);
            }

            if (wateringDate >= today && wateringDate <= thirtyDaysOut) {
              waterings.push({
                date: formatIsoDate(wateringDate),
                scheduledTime: scheduleItem.startTime || "04:00",
                durationMinutes: scheduleItem.durationMinutes || 15,
                zoneId: zone.id || zone.name,
                source: "rachio",
                rachioEventId: zone.id,
                notes: `Zone: ${zone.name || "Unknown"}`,
              });
            }
          }
        }
      }
    }

    return waterings;
  } catch (error) {
    console.error("Rachio fetch error:", error.message);
    throw error;
  }
}


function nowIso() {
  return new Date().toISOString();
}

function todayIso() {
  const now = new Date();
  return formatIsoDate(now);
}

function formatIsoDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function parseIsoDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(isoDate, days) {
  const parsed = parseIsoDate(isoDate);
  parsed.setDate(parsed.getDate() + days);
  return formatIsoDate(parsed);
}

function startOfWeek(isoDate) {
  const parsed = parseIsoDate(isoDate);
  parsed.setDate(parsed.getDate() - parsed.getDay());
  return formatIsoDate(parsed);
}

function startOfMonth(isoDate) {
  const parsed = parseIsoDate(isoDate);
  parsed.setDate(1);
  return formatIsoDate(parsed);
}

function endOfMonth(isoDate) {
  const parsed = parseIsoDate(isoDate);
  parsed.setMonth(parsed.getMonth() + 1, 0);
  return formatIsoDate(parsed);
}

function daysBetween(fromDate, toDate) {
  const first = parseIsoDate(fromDate);
  const second = parseIsoDate(toDate);
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.floor((second.getTime() - first.getTime()) / oneDay);
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

function compareIsoDate(first, second) {
  return first.localeCompare(second);
}

function compareDateTime(first, second) {
  const firstTime = new Date(first || 0).getTime();
  const secondTime = new Date(second || 0).getTime();
  return firstTime - secondTime;
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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  createAppServer,
  createDefaultState,
  normalizeState,
  buildTimelinePayload,
  buildDashboard,
  buildHealth,
};

if (require.main === module) {
  createAppServer()
    .then(async (app) => {
      const address = await app.start();
      const port = address?.port || process.env.PORT || 3000;
      console.log(`GrassPass listening on http://localhost:${port}`);
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}
