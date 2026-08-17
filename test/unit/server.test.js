import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createLoginHelperServer } from "../../src/server.js";

test("remote mode accepts only same-origin API writes and exposes browser settings", async (t) => {
  const manager = fakeManager();
  const runtimeConfig = {
    host: "127.0.0.1",
    port: 43219,
    remoteMode: true,
    remoteBrowserUrl: "/browser/vnc_lite.html?path=browser/websockify",
    requestTimeoutMs: 400_000,
    minPostIntervalMs: 30_000,
    upstream: new URL("http://example.test/"),
  };
  const server = createLoginHelperServer({ config: runtimeConfig, manager });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, runtimeConfig.host, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const bootstrap = await callServer(port, {
    path: "/api/bootstrap",
    headers: { Host: "register.example.com" },
  });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.settings.remoteMode, true);
  assert.match(bootstrap.body.settings.remoteBrowserUrl, /vnc_lite/);

  const rejected = await callServer(port, {
    method: "POST",
    path: "/api/reset",
    headers: {
      Host: "register.example.com",
      Origin: "https://evil.example",
      "X-Local-Token": bootstrap.body.token,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(rejected.status, 403);

  const accepted = await callServer(port, {
    method: "POST",
    path: "/api/reset",
    headers: {
      Host: "register.example.com",
      Origin: "https://register.example.com",
      "X-Local-Token": bootstrap.body.token,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(accepted.status, 200);
  assert.equal(manager.resetCalls, 1);
});

function fakeManager() {
  return {
    resetCalls: 0,
    resetEventsForDashboard: () => [{ type: "dashboard.opened" }],
    publicState: () => ({ phase: "idle" }),
    events: () => [],
    recordApiError: () => {},
    reset() {
      this.resetCalls += 1;
      return { phase: "idle" };
    },
  };
}

function callServer(port, options) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode, body: JSON.parse(text) });
        });
      },
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}
