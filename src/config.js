const clamp = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const upstream = new URL(
  process.env.UPSTREAM_URL ?? "http://mhealthmobasn.cu.edu.eg/",
);

if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
  throw new Error("UPSTREAM_URL must use HTTP or HTTPS");
}

export const config = Object.freeze({
  host: "127.0.0.1",
  port: clamp(process.env.PORT, 4317, 1024, 65535),
  remoteMode: process.env.REMOTE_MODE === "1",
  remoteBrowserUrl:
    "/browser/vnc_lite.html?autoconnect=true&resize=scale&reconnect=true&path=browser/websockify",
  upstream,
  signInPath: "/Signin.aspx",
  requestTimeoutMs: clamp(
    process.env.REQUEST_TIMEOUT_MS,
    400_000,
    30_000,
    600_000,
  ),
  minPostIntervalMs: clamp(
    process.env.MIN_POST_INTERVAL_MS,
    30_000,
    10_000,
    300_000,
  ),
  maxResponseBytes: 2 * 1024 * 1024,
  maxCaptchaBytes: 1024 * 1024,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
});
