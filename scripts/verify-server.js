import { config } from "../src/config.js";
import { createLoginHelperServer } from "../src/server.js";
import { createServer } from "node:http";

const port = await findFreePort();
const runtimeConfig = { ...config, port };
const server = createLoginHelperServer({ config: runtimeConfig });
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtimeConfig.port, runtimeConfig.host, resolve);
  });
  const baseUrl = `http://${runtimeConfig.host}:${runtimeConfig.port}`;
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();
  if (response.status !== 200 || !html.includes("مساعد تسجيل الدخول")) {
    throw new Error("The local dashboard did not return the expected HTML.");
  }
  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
  const bootstrap = await bootstrapResponse.json();
  if (
    bootstrap.settings.requestTimeoutMs !== 400_000 ||
    !Array.isArray(bootstrap.events) ||
    bootstrap.events.length !== 1 ||
    bootstrap.events[0].type !== "dashboard.opened"
  ) {
    throw new Error("The dashboard bootstrap is missing the timeout or in-memory events.");
  }
  const statusResponse = await fetch(`${baseUrl}/api/status`, {
    headers: { "X-Local-Token": bootstrap.token },
  });
  const status = await statusResponse.json();
  if (!status.success || !Array.isArray(status.events)) {
    throw new Error("The live activity endpoint did not return events.");
  }
  console.log(`Local dashboard verified on ${baseUrl}`);
  console.log(`Timeout verified: ${bootstrap.settings.requestTimeoutMs}ms`);
  console.log(`In-memory activity events verified: ${status.events.length}`);
} finally {
  await server.loginManager.close();
  await new Promise((resolve) => server.close(resolve));
}

async function findFreePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}
