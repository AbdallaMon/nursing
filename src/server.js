import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { LoginManager, PublicError } from "./login-manager.js";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(rootDirectory, "public");

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

export function createLoginHelperServer(options = {}) {
  const runtimeConfig = options.config ?? config;
  const manager = options.manager ?? new LoginManager(runtimeConfig);
  const localToken = randomBytes(24).toString("base64url");
  const expectedOrigins = new Set([
    `http://${runtimeConfig.host}:${runtimeConfig.port}`,
    `http://localhost:${runtimeConfig.port}`,
  ]);
  const expectedHosts = new Set([
    `${runtimeConfig.host}:${runtimeConfig.port}`,
    `localhost:${runtimeConfig.port}`,
  ]);

  const server = createHttpServer(async (request, response) => {
    setSecurityHeaders(response);
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    try {
      if (!isAllowedHost(request.headers.host, expectedHosts, runtimeConfig.remoteMode)) {
        return sendJson(response, 403, { success: false, message: "Invalid local Host header." });
      }

      if (request.method === "GET" && url.pathname === "/healthz") {
        return sendJson(response, 200, { success: true, mode: runtimeConfig.remoteMode ? "vps" : "local" });
      }

      if (request.method === "GET" && staticFiles.has(url.pathname)) {
        const [fileName, contentType] = staticFiles.get(url.pathname);
        const body = await readFile(path.join(publicDirectory, fileName));
        response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
        return response.end(body);
      }

      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        const events = manager.resetEventsForDashboard();
        return sendJson(response, 200, {
          success: true,
          token: localToken,
          state: manager.publicState(),
          events,
          settings: {
            requestTimeoutMs: runtimeConfig.requestTimeoutMs,
            minPostIntervalMs: runtimeConfig.minPostIntervalMs,
            upstreamHost: runtimeConfig.upstream.host,
            remoteMode: runtimeConfig.remoteMode,
            remoteBrowserUrl: runtimeConfig.remoteMode ? runtimeConfig.remoteBrowserUrl : null,
          },
        });
      }

      if (url.pathname.startsWith("/api/")) {
        authorizeLocalApi(request, localToken, expectedOrigins, runtimeConfig.remoteMode);
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        return sendJson(response, 200, {
          success: true,
          state: manager.publicState(),
          events: manager.events(30),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/captcha") {
        const captcha = manager.captcha();
        if (!captcha) throw new PublicError("لا توجد Captcha جاهزة.", 404);
        response.writeHead(200, {
          "Content-Type": captcha.contentType,
          "Content-Length": captcha.body.length,
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
        return response.end(captcha.body);
      }

      if (request.method === "POST" && url.pathname === "/api/prepare") {
        const body = await readJson(request);
        const result = await manager.prepare({ reset: body.reset === true });
        return sendJson(response, 200, { success: true, ...result });
      }

      if (request.method === "POST" && url.pathname === "/api/submit") {
        const body = await readJson(request);
        const result = await manager.submit(body);
        return sendJson(response, 200, { success: true, ...result });
      }

      if (request.method === "POST" && url.pathname === "/api/check") {
        await readJson(request);
        const result = await manager.checkSession();
        return sendJson(response, 200, { success: true, ...result });
      }

      if (request.method === "POST" && url.pathname === "/api/reset") {
        await readJson(request);
        const state = await manager.reset();
        return sendJson(response, 200, { success: true, state });
      }

      return sendJson(response, 404, { success: false, message: "Not found" });
    } catch (error) {
      const status = error instanceof PublicError ? error.status : 500;
      const message =
        error instanceof PublicError
          ? error.message
          : "حدث خطأ محلي غير متوقع. راجع نافذة التشغيل.";
      manager.recordApiError?.(message, status);
      if (!(error instanceof PublicError)) {
        console.error(`[local-error] ${error?.name ?? "Error"}: ${error?.message ?? error}`);
      }
      return sendJson(response, status, {
        success: false,
        message,
        retryAfterMs: error instanceof PublicError ? error.retryAfterMs : 0,
      });
    }
  });
  server.loginManager = manager;
  return server;
}

function authorizeLocalApi(request, token, expectedOrigins, remoteMode) {
  if (request.headers["x-local-token"] !== token) {
    throw new PublicError("Local security token is missing or invalid.", 403);
  }
  if (
    request.method !== "GET" &&
    !isAllowedOrigin(request.headers.origin, request.headers.host, expectedOrigins, remoteMode)
  ) {
    throw new PublicError("Invalid local request origin.", 403);
  }
}

function isAllowedHost(host, expectedHosts, remoteMode) {
  if (expectedHosts.has(host ?? "")) return true;
  return Boolean(
    remoteMode &&
      typeof host === "string" &&
      host.length <= 255 &&
      /^[a-zA-Z0-9.:[\]-]+$/.test(host),
  );
}

function isAllowedOrigin(origin, host, expectedOrigins, remoteMode) {
  if (expectedOrigins.has(origin ?? "")) return true;
  if (!remoteMode || !origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.host === host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 16 * 1024) throw new PublicError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PublicError("Invalid JSON request.", 400);
  }
}

function setSecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response, status, payload) {
  if (response.headersSent) return response.end();
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function openBrowser(url) {
  if (process.env.NO_OPEN === "1") return;
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } else {
      const command = process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(command, [url], { detached: true, stdio: "ignore" });
      child.unref();
    }
  } catch {
    // The URL is also printed for manual opening.
  }
}

export function startServer() {
  const server = createLoginHelperServer();
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${config.port} is already in use. Close the old helper window and retry.`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    const url = `http://${config.host}:${config.port}`;
    console.log(
      config.remoteMode
        ? "Nursing Register Remote Browser is running behind the VPS proxy."
        : "Nursing Register Login Helper is running locally.",
    );
    console.log(`Open: ${url}`);
    console.log(`Remote request timeout: ${Math.round(config.requestTimeoutMs / 1000)} seconds`);
    console.log("Press Ctrl+C to stop. No credentials are written to disk or logs.");
    openBrowser(url);
  });

  const shutdown = async () => {
    console.log("Closing the controlled browser and local helper...");
    await server.loginManager.close();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer();
