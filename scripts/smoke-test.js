const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { createAppServer } = require("../server");

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grasspass-smoke-"));
  const storageDir = path.join(tempRoot, "runtime");
  const backupDir = path.join(storageDir, "backups");
  const rootDir = path.resolve(__dirname, "..");

  const app = await createAppServer({
    rootDir,
    storageDir,
    backupDir,
    startSchedulers: false,
  });

  try {
    const address = await app.start(0);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = createApiClient(baseUrl);

    const auth = await client("/api/auth/register", {
      method: "POST",
      body: {
        displayName: "Smoke Admin",
        email: "smoke@example.com",
        password: "smoke-pass-123",
      },
    });
    assert(auth.auth.user?.role === "admin", "Initial admin registration failed.");

    let response = await client("/api/bootstrap");
    assert(response.snapshot.schemaVersion === 2, "Bootstrap did not return schema v2.");

    const zone = await client("/api/zones", {
      method: "POST",
      body: {
        name: "Front Lawn",
        surface: "Cool-Season",
        areaSqFt: 3200,
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
      },
    });
    const zoneId = zone.snapshot.zones[0].id;

    const product = await client("/api/products", {
      method: "POST",
      body: {
        name: "Starter Feed",
        category: "Fertilizer",
        coverageRateSqFt: 5000,
        quantity: 1,
        unit: "bag",
      },
    });
    const productId = product.snapshot.products[0].id;

    await client("/api/treatments", {
      method: "POST",
      body: {
        date: todayIso(),
        zoneId,
        type: "Fertilizer",
        productId,
        repeatDays: 30,
        notes: "Smoke test recurring treatment",
      },
    });

    await client("/api/mowing", {
      method: "POST",
      body: {
        date: todayIso(),
        zoneId,
        durationMinutes: 32,
        heightInches: 3.25,
        clippings: "Mulched",
      },
    });

    const timeline = await client("/api/timeline?range=month&anchor=" + todayIso());
    assert(timeline.summary.total >= 2, "Timeline did not merge treatment and mowing events.");

    const backup = await client("/api/backups/run", { method: "POST" });
    assert(backup.backup?.path, "Backup run did not return a file path.");

    const exportResponse = await fetch(`${baseUrl}/api/export`, {
      headers: client.headers(),
    });
    assert(exportResponse.ok, "Export endpoint failed.");
    const exported = await exportResponse.json();
    assert(exported.snapshot, "Export payload missing snapshot.");

    await client("/api/reset", { method: "POST" });
    response = await client("/api/bootstrap");
    assert(response.snapshot.zones.length === 0, "Reset did not clear zones.");

    await client("/api/import", {
      method: "POST",
      body: exported,
    });
    response = await client("/api/bootstrap");
    assert(response.snapshot.zones.length === 1, "Import did not restore zones.");

    await client("/api/reset", { method: "POST" });
    await client("/api/migrate/local-storage", {
      method: "POST",
      body: {
        legacyState: {
          profile: { lawnSqFt: 8200 },
          map: {
            lawnSqFt: 8200,
            polygonGeoJson: {
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
          },
          products: [
            {
              id: "old-product",
              name: "Legacy Feed",
              category: "Fertilizer",
            },
          ],
          treatments: [
            {
              id: "old-treatment",
              date: todayIso(),
              zone: "Front Lawn",
              type: "Fertilizer",
              productId: "old-product",
              status: "Scheduled",
            },
          ],
          mowingLogs: [
            {
              id: "old-mow",
              date: todayIso(),
              zone: "Front Lawn",
              duration: 35,
              height: 3.5,
              clippings: "Mulched",
            },
          ],
        },
      },
    });
    response = await client("/api/bootstrap");
    assert(response.snapshot.migrationJournal.length > 0, "Legacy migration journal entry missing.");

    console.log("Smoke test passed.");
  } finally {
    await app.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function createApiClient(baseUrl) {
  let cookie = "";
  const api = async (route, options = {}) => {
    const response = await fetch(baseUrl + route, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      cookie = setCookie.split(";")[0];
    }
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `Request failed for ${route}`);
    }
    return payload;
  };
  api.headers = () => ({
    Accept: "application/json",
    ...(cookie ? { Cookie: cookie } : {}),
  });
  return api;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
