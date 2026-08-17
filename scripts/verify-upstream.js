import { config } from "../src/config.js";
import { LoginManager } from "../src/login-manager.js";

process.env.HEADLESS = "1";
const manager = new LoginManager({
  ...config,
  requestTimeoutMs: Math.min(config.requestTimeoutMs, 60_000),
});

try {
  const result = await manager.prepare();
  const state = result.state;
  console.log(
    JSON.stringify({
      phase: state.phase,
      browserChannel: state.browserChannel,
      hasCaptcha: state.hasCaptcha,
      durationMs: state.lastDurationMs,
    }),
  );
  if (state.phase !== "prepared" || !state.hasCaptcha) process.exitCode = 1;
} finally {
  await manager.close();
}
