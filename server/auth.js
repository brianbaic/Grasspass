const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

// Imported from main server.js - these constants/functions need to be passed in
// or imported from shared utilities
const SESSION_TTL_DAYS = 30;

// Helper function - will be imported from utilities
function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function compareDateTime(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// ── Auth State Store ──
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

// ── Auth Manager ──
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
    // Migrate legacy file-based auth on first read if needed
    const fileState = await this.fileStore.read();
    if (fileState.users.length > 0 || fileState.invites.length > 0 || fileState.sessions.length > 0) {
      await writeAuthStateToSQLite(this.runtimeStore.activeStore.db, fileState);
    }
    return readAuthStateFromSQLite(this.runtimeStore.activeStore.db);
  }

  async writeState(state) {
    const normalized = normalizeAuthState(state);
    await writeAuthStateToSQLite(this.runtimeStore.activeStore.db, normalized);
    return normalized;
  }
}

// ── Helper Functions ──
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

// Placeholder exports - these will be filled in from main server.js
// TODO: Import these from a shared utilities module
function createDefaultAuthState() {
  throw new Error("createDefaultAuthState must be provided");
}

function normalizeAuthState(state) {
  throw new Error("normalizeAuthState must be provided");
}

function normalizeEmail(email) {
  throw new Error("normalizeEmail must be provided");
}

function sanitizeText(text, maxLength) {
  throw new Error("sanitizeText must be provided");
}

function createId(prefix) {
  throw new Error("createId must be provided");
}

async function readAuthStateFromSQLite(db) {
  throw new Error("readAuthStateFromSQLite must be provided from server.js");
}

async function writeAuthStateToSQLite(db, state) {
  throw new Error("writeAuthStateToSQLite must be provided from server.js");
}

// ── Exports ──
module.exports = {
  AuthStateStore,
  AuthManager,
  hashPassword,
  verifyPassword,
  sanitizeUserForClient,
  sanitizeInviteForClient,
  buildAuthClientState,
  buildAuthClientStateFromUser,
  createSessionRecord,
  createInviteCode,
  SESSION_TTL_DAYS,
};
