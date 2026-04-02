import { state, stateManager } from "../state.js";
import { refs } from "../refs.js";
import { mutate, requestJson, applyPayload, refreshAuth } from "../api.js";
import {
  renderAll,
  renderAuth,
  renderAccount,
  renderInvites,
  renderRachioStatus,
} from "../views/index.js";

let initializeAppAfterAuthCallback = null;
let showBannerCallback = null;
let clearDraftGeometryCallback = null;

export function setFormCallbacks(callbacks = {}) {
  initializeAppAfterAuthCallback = callbacks.initializeAppAfterAuth || null;
  showBannerCallback = callbacks.showBanner || null;
  clearDraftGeometryCallback = callbacks.clearDraftGeometry || null;
}

function showBanner(message, tone = "success") {
  showBannerCallback?.(message, tone);
}

function showAuthMessage(message) {
  refs.authMessage.hidden = false;
  refs.authMessage.textContent = message;
}

function clearAuthMessage() {
  refs.authMessage.hidden = true;
  refs.authMessage.textContent = "";
}

function clearCachedAppState() {
  stateManager.setSnapshot(null);
  stateManager.setDashboard(null);
  stateManager.setHealth(null);
  state.storage = null;
  state.timeline = null;
  state.weeklyTimeline = null;
  stateManager.setHortFact(null);
  stateManager.setHortFactHistory([]);
  stateManager.setHortFactIndex(-1);
}

function byId(items, id) {
  return items.find((item) => item.id === id) || null;
}

function currentZoneGeometry(zoneId) {
  return byId(state.snapshot.zones, zoneId)?.geometry || null;
}

function currentZoneArea(zoneId) {
  return byId(state.snapshot.zones, zoneId)?.areaSqFt || null;
}

export async function submitZoneForm(event) {
  event.preventDefault();
  if (!state.map.pendingGeometry && !refs.zoneId.value) {
    showBanner("Draw or edit a polygon before saving a zone.", "warning");
    return;
  }

  const payload = {
    name: refs.zoneName.value,
    surface: refs.zoneSurface.value,
    notes: refs.zoneNotes.value,
    geometry: state.map.pendingGeometry || currentZoneGeometry(refs.zoneId.value),
    areaSqFt: state.map.pendingAreaSqFt || currentZoneArea(refs.zoneId.value),
  };

  const isEditing = Boolean(refs.zoneId.value);
  const url = isEditing ? `/api/zones/${encodeURIComponent(refs.zoneId.value)}` : "/api/zones";
  await mutate(
    url,
    {
      method: isEditing ? "PATCH" : "POST",
      body: payload,
    },
    isEditing ? "Zone updated." : "Zone saved."
  );
  resetZoneForm();
}

export async function submitProductForm(event) {
  event.preventDefault();
  const rateValue = refs.productRate.value;
  if (rateValue !== "" && Number(rateValue) <= 0) {
    showBanner("Coverage rate must be greater than 0.", "warning");
    return;
  }
  const isEditing = Boolean(refs.productId.value);
  const url = isEditing
    ? `/api/products/${encodeURIComponent(refs.productId.value)}`
    : "/api/products";
  await mutate(
    url,
    {
      method: isEditing ? "PATCH" : "POST",
      body: {
        name: refs.productName.value,
        category: refs.productCategory.value,
        activeIngredient: refs.productActive.value,
        coverageRateSqFt: refs.productRate.value,
        quantity: refs.productQuantity.value,
        unit: refs.productUnit.value,
        notes: refs.productNotes.value,
      },
    },
    isEditing ? "Product updated." : "Product saved."
  );
  resetProductForm();
}

export async function submitTreatmentForm(event) {
  event.preventDefault();
  const isEditing = Boolean(refs.treatmentId.value);
  const url = isEditing
    ? `/api/treatments/${encodeURIComponent(refs.treatmentId.value)}`
    : "/api/treatments";
  await mutate(
    url,
    {
      method: isEditing ? "PATCH" : "POST",
      body: {
        date: refs.treatmentDate.value,
        zoneId: refs.treatmentZone.value,
        type: refs.treatmentType.value,
        productId: refs.treatmentProduct.value,
        repeatDays: refs.treatmentRepeat.value,
        notes: refs.treatmentNotes.value,
        pushToGoogle: refs.treatmentPush.checked,
      },
    },
    isEditing ? "Treatment updated." : "Treatment saved."
  );
  resetTreatmentForm();
}

export async function submitMowingForm(event) {
  event.preventDefault();
  const isEditing = Boolean(refs.mowingId.value);
  const url = isEditing
    ? `/api/mowing/${encodeURIComponent(refs.mowingId.value)}`
    : "/api/mowing";
  await mutate(
    url,
    {
      method: isEditing ? "PATCH" : "POST",
      body: {
        date: refs.mowingDate.value,
        zoneId: refs.mowingZone.value,
        durationMinutes: refs.mowingDuration.value,
        heightInches: refs.mowingHeight.value,
        clippings: refs.mowingClippings.value,
        notes: refs.mowingNotes.value,
        pushToGoogle: refs.mowingPush.checked,
      },
    },
    isEditing ? "Mowing log updated." : "Mowing log saved."
  );
  resetMowingForm();
}

export async function submitProfileForm(event) {
  event.preventDefault();
  const areaValue = refs.profileArea.value;
  if (areaValue !== "" && Number(areaValue) <= 0) {
    showBanner("Property area must be greater than 0.", "warning");
    return;
  }
  await mutate(
    "/api/profile",
    {
      method: "PATCH",
      body: {
        propertyName: refs.profileName.value,
        location: refs.profileLocation.value,
        manualAreaSqFt: refs.profileArea.value,
      },
    },
    "Profile saved."
  );
}

export async function submitInitialAdminForm(event) {
  event.preventDefault();
  await completeAuth("/api/auth/register", {
    displayName: refs.setupDisplayName.value,
    email: refs.setupEmail.value,
    password: refs.setupPassword.value,
  });
}

export async function submitLoginForm(event) {
  event.preventDefault();
  await completeAuth("/api/auth/login", {
    email: refs.loginEmail.value,
    password: refs.loginPassword.value,
  });
}

export async function submitRegisterForm(event) {
  event.preventDefault();
  await completeAuth("/api/auth/register", {
    displayName: refs.registerDisplayName.value,
    email: refs.registerEmail.value,
    password: refs.registerPassword.value,
    inviteCode: refs.registerInviteCode.value,
  });
}

export async function completeAuth(url, body) {
  try {
    const result = await requestJson(url, {
      method: "POST",
      body,
    });
    state.auth = result.auth;
    clearAuthMessage();
    stateManager.setAuthMode("login");
    refs.authSetupForm.reset();
    refs.authLoginForm.reset();
    refs.authRegisterForm.reset();
    renderAuth();
    renderAccount();
    if (initializeAppAfterAuthCallback) {
      await initializeAppAfterAuthCallback();
    }
    await refreshAuth({ quiet: true });
    showBanner(
      state.auth?.setupRequired ? "Authentication updated." : "Signed in successfully.",
      "success"
    );
  } catch (error) {
    showAuthMessage(error.message || "Authentication failed.");
    showBanner(error.message || "Authentication failed.", "danger");
  }
}

export async function submitLogout() {
  try {
    const result = await requestJson("/api/auth/logout", {
      method: "POST",
    });
    state.auth = result.auth;
    state.snapshot = null;
    state.dashboard = null;
    state.health = null;
    state.storage = null;
    state.timeline = null;
    state.weeklyTimeline = null;
    clearCachedAppState();
    renderAll();
    showBanner("Signed out.", "success");
  } catch (error) {
    showBanner(error.message || "Sign out failed.", "danger");
  }
}

export async function submitInviteForm(event) {
  event.preventDefault();
  try {
    const result = await requestJson("/api/auth/invites", {
      method: "POST",
      body: {
        role: refs.inviteRole.value,
        note: refs.inviteNote.value,
      },
    });
    stateManager.setAuth(result.auth || state.auth);
    state.auth.invites = result.invites || [];
    refs.inviteForm.reset();
    refs.inviteRole.value = "member";
    renderInvites();
    showBanner("Invite code created.", "success");
  } catch (error) {
    showBanner(error.message || "Invite creation failed.", "danger");
  }
}

export async function submitGoogleForm(event) {
  event.preventDefault();
  await mutate(
    "/api/google/connect",
    {
      method: "POST",
      body: {
        calendarId: refs.googleCalendarId.value,
        accessToken: refs.googleAccessToken.value,
      },
    },
    "Google Calendar settings saved."
  );
  refs.googleAccessToken.value = "";
}

export async function submitRachioForm(event) {
  event.preventDefault();
  const apiKey = String(refs.rachioApiKey.value || "").trim().replace(/^Bearer\s+/i, "");
  if (!apiKey) {
    const result = await requestJson("/api/rachio/disconnect", { method: "POST" });
    applyPayload(result);
    refs.rachioApiKey.value = "";
    renderRachioStatus();
    return;
  }
  const result = await requestJson("/api/rachio/connect", {
    method: "POST",
    body: { apiKey },
  });
  applyPayload(result);
  refs.rachioApiKey.value = "";
  showBanner("Rachio API key saved. Click 'Sync Schedule' to fetch your schedule.", "success");
  renderRachioStatus();
}

export async function submitImportForm(event) {
  event.preventDefault();
  const [file] = refs.importFile.files || [];
  if (!file) {
    showBanner("Choose a JSON export to import.", "warning");
    return;
  }
  const text = await file.text();
  const payload = JSON.parse(text);
  await mutate(
    "/api/import",
    {
      method: "POST",
      body: payload,
    },
    "Portable JSON imported."
  );
  refs.importForm.reset();
}

export function resetZoneForm() {
  refs.zoneForm.reset();
  refs.zoneId.value = "";
  refs.zoneSurface.value = "Mixed Turf";
  refs.zoneFormStatus.textContent = "Draw a polygon on the map, then save the zone.";
  clearDraftGeometryCallback?.();
}

export function resetProductForm() {
  refs.productForm.reset();
  refs.productId.value = "";
  refs.productUnit.value = "bag";
}

export function resetTreatmentForm() {
  refs.treatmentForm.reset();
  refs.treatmentId.value = "";
  refs.treatmentPush.checked = true;
}

export function resetMowingForm() {
  refs.mowingForm.reset();
  refs.mowingId.value = "";
  refs.mowingClippings.value = "Mulched";
  refs.mowingPush.checked = true;
}
