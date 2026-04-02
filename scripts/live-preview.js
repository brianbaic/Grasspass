const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const PREVIEW_PORT = Number(process.env.PORT || 3000);
const APP_PORT = Number(process.env.PREVIEW_APP_PORT || PREVIEW_PORT + 1);
const WATCHED_FILES = new Set([
  "app.js",
  "index.html",
  "styles.css",
  "server.js",
  "db/schema.sql",
]);
const EVENT_CLIENTS = new Set();
const WATCH_DEBOUNCE_MS = 120;

let appServer = null;
let fileWatcher = null;
let previewServer = null;
let restartPromise = Promise.resolve();
const pendingChanges = new Map();

function log(message) {
  console.log(`[preview] ${message}`);
}

function injectLiveReloadClient(html) {
  const clientScript = `
    <script>
      (() => {
        let source;
        const connect = () => {
          source = new EventSource("/__preview/events");
          source.addEventListener("reload", () => window.location.reload());
          source.onerror = () => {
            source.close();
            setTimeout(connect, 500);
          };
        };
        connect();
      })();
    </script>
  `;

  if (html.includes("</body>")) {
    return html.replace("</body>", `${clientScript}\n  </body>`);
  }

  return `${html}\n${clientScript}`;
}

function sendReloadEvent(changedPath) {
  const payload = JSON.stringify({
    path: changedPath,
    refreshedAt: new Date().toISOString(),
  });

  for (const response of EVENT_CLIENTS) {
    response.write(`event: reload\n`);
    response.write(`data: ${payload}\n\n`);
  }

  log(`Reload queued for ${changedPath}`);
}

function handleEventStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  response.write(": connected\n\n");
  EVENT_CLIENTS.add(response);

  request.on("close", () => {
    EVENT_CLIENTS.delete(response);
  });
}

function toRelativePath(fileName) {
  return fileName.split(path.sep).join("/");
}

function loadCreateAppServer() {
  const serverModulePath = path.join(ROOT_DIR, "server.js");
  delete require.cache[require.resolve(serverModulePath)];
  return require(serverModulePath).createAppServer;
}

async function startAppServer(createAppServer = loadCreateAppServer()) {
  appServer = await createAppServer({
    rootDir: ROOT_DIR,
    port: APP_PORT,
  });
  await appServer.start(APP_PORT);
}

async function stopAppServer() {
  if (!appServer) {
    return;
  }

  const currentServer = appServer;
  appServer = null;
  await currentServer.close();
}

function restartAppServer(reason) {
  restartPromise = restartPromise.then(async () => {
    log(`Restarting app server after ${reason}`);
    const createAppServer = loadCreateAppServer();
    await stopAppServer();
    await startAppServer(createAppServer);
    sendReloadEvent(reason);
  });

  return restartPromise.catch((error) => {
    log(`Restart failed: ${error.stack || error.message || error}`);
  });
}

function proxyRequest(request, response) {
  const proxy = http.request(
    {
      hostname: "127.0.0.1",
      port: APP_PORT,
      method: request.method,
      path: request.url,
      headers: {
        ...request.headers,
        host: `127.0.0.1:${APP_PORT}`,
      },
    },
    (upstream) => {
      const headers = { ...upstream.headers };
      const contentType = String(headers["content-type"] || "");
      const shouldInjectPreviewClient =
        request.method === "GET" && contentType.includes("text/html");

      if (request.method === "GET") {
        headers["cache-control"] = "no-store";
      }

      if (!shouldInjectPreviewClient) {
        response.writeHead(upstream.statusCode || 200, headers);
        upstream.pipe(response);
        return;
      }

      const chunks = [];
      upstream.on("data", (chunk) => chunks.push(chunk));
      upstream.on("end", () => {
        const html = Buffer.concat(chunks).toString("utf8");
        const nextHtml = injectLiveReloadClient(html);
        delete headers["content-length"];
        headers["content-length"] = Buffer.byteLength(nextHtml);
        response.writeHead(upstream.statusCode || 200, headers);
        response.end(nextHtml);
      });
    }
  );

  proxy.on("error", (error) => {
    response.writeHead(502, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      `Preview proxy could not reach the app server on port ${APP_PORT}.\n${error.message}`
    );
  });

  request.pipe(proxy);
}

function onFileChange(relativePath) {
  if (relativePath === "server.js" || relativePath === "db/schema.sql") {
    restartAppServer(relativePath);
    return;
  }

  sendReloadEvent(relativePath);
}

function watchProjectFiles() {
  fileWatcher = fs.watch(ROOT_DIR, { recursive: true }, (_eventType, fileName) => {
    if (!fileName) {
      return;
    }

    const relativePath = toRelativePath(fileName);
    if (!WATCHED_FILES.has(relativePath)) {
      return;
    }

    clearTimeout(pendingChanges.get(relativePath));
    const timer = setTimeout(() => {
      pendingChanges.delete(relativePath);
      onFileChange(relativePath);
    }, WATCH_DEBOUNCE_MS);

    pendingChanges.set(relativePath, timer);
  });
}

async function shutdown() {
  for (const timer of pendingChanges.values()) {
    clearTimeout(timer);
  }
  pendingChanges.clear();

  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }

  for (const response of EVENT_CLIENTS) {
    response.end();
  }
  EVENT_CLIENTS.clear();

  if (previewServer) {
    const currentPreview = previewServer;
    previewServer = null;
    await new Promise((resolve, reject) =>
      currentPreview.close((error) => (error ? reject(error) : resolve()))
    );
  }

  await stopAppServer();
}

async function main() {
  await startAppServer();
  watchProjectFiles();

  previewServer = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/__preview/events") {
      handleEventStream(request, response);
      return;
    }

    proxyRequest(request, response);
  });

  await new Promise((resolve) => previewServer.listen(PREVIEW_PORT, resolve));

  log(`Live preview running at http://localhost:${PREVIEW_PORT}`);
  log(`App runtime is proxied through internal port ${APP_PORT}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, async () => {
    await shutdown();
    process.exit(0);
  });
});
