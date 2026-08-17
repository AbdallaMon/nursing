import { chromium } from "playwright-core";
import { classifyLoginResponse } from "./html.js";

const SELECTORS = Object.freeze({
  form: "form#aspnetForm",
  graduate: 'input[name$=":txtId"]',
  national: 'input[name$=":txtNationalNumber"]',
  captcha: 'input[name$=":txtCertainNumber"]',
  submit: 'input[name$=":btnOk"]',
  captchaImage: 'img[src*="CodeImage.aspx"]',
});

export class LoginManager {
  #browser = null;
  #context = null;
  #page = null;
  #busy = false;
  #prepared = false;
  #captcha = null;
  #lastPostAt = 0;
  #pendingPost = null;
  #random;
  #events = [];
  #eventSequence = 0;
  #trackedRequests = new Map();
  #requestStats = {
    total: 0,
    get: 0,
    post: 0,
    completedGet: 0,
    completedPost: 0,
    failedGet: 0,
    failedPost: 0,
  };

  constructor(options) {
    this.options = options;
    this.browserType = options.browserType ?? chromium;
    this.#random = options.random ?? Math.random;
    this.state = this.#initialState();
    this.#log("info", "helper.ready", "البرنامج المحلي جاهز.");
  }

  #initialState() {
    return {
      phase: "idle",
      message: "اضغط تجهيز جلسة لفتح Chrome وتحميل صفحة الدخول.",
      attempt: 0,
      retryAfterMs: 0,
      lastDurationMs: null,
      nextLocation: null,
      preparedAt: null,
      browserChannel: null,
      lastPost: null,
    };
  }

  publicState() {
    return {
      ...this.state,
      busy: this.#busy,
      hasCaptcha: Boolean(this.#captcha),
      postPending: Boolean(this.#pendingPost),
      requestStats: this.#requestStatsSnapshot(),
    };
  }

  captcha() {
    return this.#captcha ? { ...this.#captcha } : null;
  }

  events(limit = 30) {
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 30));
    return this.#events.slice(-safeLimit).reverse().map((event) => ({
      ...event,
      details: { ...event.details },
    }));
  }

  recordApiError(message, status) {
    if (status === 403) return;
    this.#log("error", "api.error", message, { status });
  }

  resetEventsForDashboard() {
    this.#events = [];
    const active = [...this.#trackedRequests.values()];
    this.#requestStats = {
      total: active.length,
      get: active.filter((request) => request.method === "GET").length,
      post: active.filter((request) => request.method === "POST").length,
      completedGet: 0,
      completedPost: 0,
      failedGet: 0,
      failedPost: 0,
    };
    if (!this.#pendingPost && !active.some((request) => request.method === "POST")) {
      this.state.lastPost = null;
    }
    this.#log("info", "dashboard.opened", "تم فتح الداشبورد وبدء سجل جديد.");
    return this.events(30);
  }

  async prepare({ reset = false } = {}) {
    return this.#exclusive(async () => {
      if (this.#pendingPost) {
        throw new PublicError(
          "محاولة الدخول ما زالت Pending داخل Chrome؛ لن نلغيها أو نرسل طلبًا آخر.",
          409,
        );
      }
      if (reset) await this.#resetBrowser();
      this.#log(
        "info",
        "session.prepare_started",
        reset ? "جاري إنشاء Chrome وSession جديدين." : "جاري تجهيز صفحة دخول جديدة.",
      );
      await this.#ensureBrowser();

      this.state.phase = "preparing";
      this.state.message = "جاري تحميل صفحة الدخول داخل Chrome...";
      this.#prepared = false;
      this.#captcha = null;
      const startedAt = performance.now();

      let response;
      try {
        response = await this.#page.goto(this.#signInUrl(), {
          waitUntil: "domcontentloaded",
          timeout: this.options.requestTimeoutMs,
        });
      } catch (error) {
        if (isPlaywrightTimeout(error)) {
          this.state.phase = "uncertain";
          this.state.message =
            "تحميل الصفحة تجاوز المهلة وما زال قد يكتمل داخل Chrome. انتظر أو أنشئ جلسة جديدة يدويًا.";
          throw new PublicError(this.state.message, 504);
        }
        throw error;
      }

      if (response && response.status() >= 500) {
        this.#log("error", "http.signin_error", "صفحة الدخول أعادت خطأ من السيرفر.", {
          status: response.status(),
          durationMs: Math.round(performance.now() - startedAt),
        });
        throw new PublicError(`السيرفر أعاد HTTP ${response.status()}.`, 502);
      }

      this.#log("info", "http.signin_loaded", "تم تحميل Signin.aspx داخل Chrome.", {
        status: response?.status() ?? null,
        durationMs: Math.round(performance.now() - startedAt),
      });

      await this.#capturePreparedPage();
      this.state.lastDurationMs = Math.round(performance.now() - startedAt);
      this.state.phase = "prepared";
      this.state.message =
        "Chrome والجلسة جاهزان. أدخل البيانات والكود في الواجهة ثم أرسل محاولة واحدة.";
      this.state.preparedAt = new Date().toISOString();
      this.state.retryAfterMs = 0;
      this.#log("success", "session.prepared", "الجلسة والكابتشا جاهزتان.", {
        durationMs: this.state.lastDurationMs,
        browserChannel: this.state.browserChannel,
      });
      await this.#page.bringToFront();
      return { state: this.publicState(), result: { kind: "prepared" } };
    });
  }

  async submit({ graduateNumber, nationalNumber, captcha }) {
    validateCredentials({ graduateNumber, nationalNumber, captcha });

    return this.#exclusive(async () => {
      if (this.#pendingPost) throw new PublicError("يوجد POST ما زال Pending داخل Chrome.", 409);
      if (!this.#prepared || !this.#page || this.#page.isClosed()) {
        throw new PublicError("لا توجد جلسة مجهزة. اضغط تجهيز جلسة أولًا.", 409);
      }

      const now = Date.now();
      const remaining = this.options.minPostIntervalMs - (now - this.#lastPostAt);
      if (this.#lastPostAt && remaining > 0) {
        throw new PublicError(
          `انتظر ${Math.ceil(remaining / 1000)} ثانية قبل POST آخر.`,
          429,
          remaining,
        );
      }

      await this.#page.locator(SELECTORS.graduate).fill(graduateNumber.trim());
      await this.#page.locator(SELECTORS.national).fill(nationalNumber.trim());
      await this.#page.locator(SELECTORS.captcha).fill(captcha.trim());

      this.#lastPostAt = now;
      this.#prepared = false;
      this.#captcha = null;
      this.state.phase = "submitting";
      this.state.message = "تم إرسال POST واحد داخل Chrome؛ جاري انتظار السيرفر...";
      this.state.attempt += 1;
      this.state.retryAfterMs = 0;
      this.state.lastPost = {
        outcome: "pending",
        attempt: this.state.attempt,
        status: null,
        durationMs: null,
        message: "POST تسجيل الدخول ما زال Pending.",
        at: new Date().toISOString(),
      };

      this.#log("info", "login.post_started", "تم إرسال محاولة تسجيل دخول واحدة.", {
        attempt: this.state.attempt,
      });

      const startedAt = performance.now();
      const responsePromise = this.#waitForLoginPostResponse();
      await this.#page.locator(SELECTORS.submit).evaluate((button) => button.click());

      const settlement = responsePromise
        .then((response) => this.#settlePostResponse(response, startedAt))
        .catch((error) => this.#settlePostFailure(error, startedAt));
      const tracked = settlement.finally(() => {
        if (this.#pendingPost === tracked) this.#pendingPost = null;
      });
      this.#pendingPost = tracked;

      const timedOut = Symbol("timed-out");
      const outcome = await Promise.race([
        tracked,
        delay(this.options.requestTimeoutMs, timedOut),
      ]);

      if (outcome === timedOut) {
        this.state.phase = "uncertain";
        this.state.message =
          "انتهت مهلة المتابعة، لكن POST ما زال داخل Chrome ولم نلغِه. لن نسمح بمحاولة أخرى قبل وصول الرد.";
        this.state.lastDurationMs = Math.round(performance.now() - startedAt);
        this.state.lastPost = {
          ...this.state.lastPost,
          outcome: "pending",
          durationMs: this.state.lastDurationMs,
          message: "انتهت مهلة المتابعة، لكن POST ما زال Pending داخل Chrome.",
        };
        this.#log("warn", "login.post_pending", "انتهت مهلة المتابعة والـPOST ما زال Pending.", {
          attempt: this.state.attempt,
          durationMs: this.state.lastDurationMs,
        });
        return {
          state: this.publicState(),
          result: { kind: "uncertain", message: this.state.message },
        };
      }

      return outcome;
    });
  }

  async checkSession() {
    return this.#exclusive(async () => {
      this.#log("info", "session.check_started", "جاري فحص حالة الجلسة الحالية.");
      if (this.#pendingPost) {
        this.state.phase = "uncertain";
        this.state.message = "POST ما زال Pending داخل Chrome؛ استمر في الانتظار بدون إعادة إرسال.";
        this.#log("warn", "session.check_pending", this.state.message, {
          attempt: this.state.attempt,
        });
        return {
          state: this.publicState(),
          result: { kind: "pending", message: this.state.message },
        };
      }
      if (!this.#page || this.#page.isClosed()) {
        throw new PublicError("Chrome غير مفتوح. جهّز جلسة جديدة.", 409);
      }

      const currentUrl = new URL(this.#page.url());
      if (!currentUrl.pathname.toLowerCase().endsWith("/signin.aspx")) {
        this.state.phase = "success";
        this.state.message = "Chrome انتقل بعيدًا عن صفحة الدخول؛ الجلسة محفوظة في نفس المتصفح.";
        this.state.nextLocation = currentUrl.href;
        if (this.state.lastPost?.outcome === "pending") {
          this.state.lastPost = {
            ...this.state.lastPost,
            outcome: "success",
            message: "فحص الجلسة أكد نجاح تسجيل الدخول.",
            at: new Date().toISOString(),
          };
        }
        this.#log("success", "session.check_success", this.state.message, {
          urlPath: currentUrl.pathname,
        });
        return {
          state: this.publicState(),
          result: { kind: "success", message: this.state.message },
        };
      }

      const content = await this.#page.content();
      const result = classifyLoginResponse({ status: 200, location: null, text: content });
      if (result.kind === "success") {
        this.state.phase = "success";
        this.state.message = result.message;
        this.state.nextLocation = this.#page.url();
        if (this.state.lastPost?.outcome === "pending") {
          this.state.lastPost = {
            ...this.state.lastPost,
            outcome: "success",
            message: result.message,
            at: new Date().toISOString(),
          };
        }
        return { state: this.publicState(), result };
      }

      await this.#capturePreparedPage();
      this.state.phase = "prepared";
      this.state.message = "الجلسة لم تسجل الدخول؛ النموذج الحالي جاهز لمحاولة يدوية جديدة.";
      this.#log("info", "session.check_prepared", this.state.message);
      return { state: this.publicState(), result: { kind: "prepared" } };
    });
  }

  async reset() {
    if (this.#busy) throw new PublicError("انتظر انتهاء العملية المحلية الحالية أولًا.", 409);
    if (this.#pendingPost) {
      throw new PublicError(
        "يوجد POST Pending. إغلاق الجلسة الآن سيلغي المتصفح؛ انتظر الرد أولًا.",
        409,
      );
    }
    await this.#resetBrowser();
    this.#lastPostAt = 0;
    this.state = this.#initialState();
    this.#log("info", "session.reset", "تم مسح الجلسة وحقول المتصفح المخصص.");
    return this.publicState();
  }

  async close() {
    await this.#resetBrowser({ allowPending: true });
  }

  async #ensureBrowser() {
    if (this.#browser?.isConnected() && this.#page && !this.#page.isClosed()) return;

    let lastError;
    const configured = process.env.BROWSER_CHANNEL?.trim();
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH?.trim();
    const channels = executablePath ? ["custom"] : configured ? [configured] : ["chrome", "msedge"];
    for (const channel of channels) {
      try {
        const launchOptions = {
          headless: process.env.HEADLESS === "1",
        };
        if (executablePath) launchOptions.executablePath = executablePath;
        else if (channel !== "chromium") launchOptions.channel = channel;
        if (this.options.remoteMode) {
          const width = Number(process.env.REMOTE_SCREEN_WIDTH) || 1440;
          const height = Number(process.env.REMOTE_SCREEN_HEIGHT) || 900;
          launchOptions.args = [`--window-size=${width},${height}`, "--start-maximized"];
        }
        this.#browser = await this.browserType.launch(launchOptions);
        this.state.browserChannel = channel;
        this.#log("success", "browser.launched", `تم تشغيل ${channel} بنجاح.`, {
          browserChannel: channel,
        });
        break;
      } catch (error) {
        lastError = error;
        this.#log("warn", "browser.launch_failed", `تعذر تشغيل قناة ${channel}.`, {
          browserChannel: channel,
        });
      }
    }

    if (!this.#browser) {
      throw new PublicError(
        `تعذر تشغيل Chrome أو Edge بواسطة Playwright. ${lastError?.message ?? ""}`.trim(),
        500,
      );
    }

    this.#context = await this.#browser.newContext({
      locale: "ar-EG",
      userAgent: this.options.userAgent,
      ignoreHTTPSErrors: true,
      ...(this.options.remoteMode ? { viewport: null } : {}),
    });
    await this.#context.route("**/*", async (route) => {
      const request = route.request();
      const type = request.resourceType();
      const pathname = new URL(request.url()).pathname.toLowerCase();
      const captcha = pathname.endsWith("/codeimage.aspx");
      if (type === "font" || type === "media" || (type === "image" && !captcha)) {
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    this.#page = await this.#context.newPage();
    this.#page.setDefaultTimeout(20_000);
    this.#page.on("request", (request) => this.#trackRequestStarted(request));
    this.#page.on("requestfinished", (request) => {
      void this.#trackRequestFinished(request);
    });
    this.#page.on("requestfailed", (request) => this.#trackRequestFailed(request));
    this.#page.on("close", () => {
      this.#prepared = false;
      this.#captcha = null;
      if (!this.#pendingPost) {
        this.state.phase = "idle";
        this.state.message = "تم إغلاق نافذة Chrome. جهّز جلسة لفتحها من جديد.";
        this.#log("warn", "browser.closed", this.state.message);
      }
    });
  }

  async #capturePreparedPage() {
    await this.#page.locator(SELECTORS.form).waitFor({ state: "attached" });
    for (const selector of [
      SELECTORS.graduate,
      SELECTORS.national,
      SELECTORS.captcha,
      SELECTORS.submit,
    ]) {
      if ((await this.#page.locator(selector).count()) !== 1) {
        throw new PublicError(`تعذر العثور على حقل النموذج: ${selector}`, 502);
      }
    }

    const captcha = this.#page.locator(SELECTORS.captchaImage);
    await captcha.waitFor({ state: "visible", timeout: this.options.requestTimeoutMs });
    await captcha.evaluate(
      (image) =>
        image.complete && image.naturalWidth > 0
          ? true
          : new Promise((resolve, reject) => {
              image.addEventListener("load", () => resolve(true), { once: true });
              image.addEventListener("error", () => reject(new Error("Captcha failed")), {
                once: true,
              });
            }),
    );
    this.#captcha = {
      body: await captcha.screenshot({ type: "png" }),
      contentType: "image/png",
    };
    this.#prepared = true;
  }

  #waitForLoginPostResponse() {
    return new Promise((resolve, reject) => {
      const matches = (request) => {
        try {
          const url = new URL(request.url());
          return (
            request.method() === "POST" &&
            url.origin === this.options.upstream.origin &&
            url.pathname.toLowerCase().endsWith("/signin.aspx")
          );
        } catch {
          return false;
        }
      };
      const cleanup = () => {
        this.#page.off("response", onResponse);
        this.#page.off("requestfailed", onFailed);
        this.#page.off("close", onClose);
      };
      const onResponse = (response) => {
        if (!matches(response.request())) return;
        cleanup();
        resolve(response);
      };
      const onFailed = (request) => {
        if (!matches(request)) return;
        cleanup();
        reject(new Error(request.failure()?.errorText || "Login request failed"));
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Chrome page was closed while login was pending"));
      };
      this.#page.on("response", onResponse);
      this.#page.on("requestfailed", onFailed);
      this.#page.on("close", onClose);
    });
  }

  async #settlePostResponse(response, startedAt) {
    const headers = response.headers();
    const text = await response.text().catch(() => "");
    const result = classifyLoginResponse({
      status: response.status(),
      location: headers.location ?? null,
      text,
    });
    this.state.lastDurationMs = Math.round(performance.now() - startedAt);
    this.state.message = result.message;
    this.state.nextLocation = headers.location
      ? new URL(headers.location, this.options.upstream).href
      : null;
    this.state.lastPost = {
      outcome: result.kind === "success" ? "success" : "failed",
      attempt: this.state.attempt,
      status: response.status(),
      durationMs: this.state.lastDurationMs,
      message: result.message,
      at: new Date().toISOString(),
    };

    this.#log("info", "login.response", "وصل رد محاولة تسجيل الدخول.", {
      attempt: this.state.attempt,
      status: response.status(),
      durationMs: this.state.lastDurationMs,
      urlPath: new URL(response.url()).pathname,
    });

    if (result.kind === "success") {
      this.state.phase = "success";
      this.state.retryAfterMs = 0;
      if (headers.location) {
        const expectedUrl = new URL(headers.location, this.options.upstream).href;
        await this.#page
          .waitForURL(expectedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
          .catch(() => {});
      } else {
        await this.#page
          .waitForLoadState("domcontentloaded", { timeout: 30_000 })
          .catch(() => {});
      }
      this.state.nextLocation = this.#page.url();
      this.#log("success", "login.success", result.message, {
        attempt: this.state.attempt,
        status: response.status(),
        durationMs: this.state.lastDurationMs,
        urlPath: new URL(this.state.nextLocation).pathname,
      });
      await this.#page.bringToFront().catch(() => {});
    } else if (result.kind === "transient") {
      this.state.phase = "transient";
      this.state.retryAfterMs = this.#backoffFor(this.state.attempt);
      this.#log("error", "login.transient_error", result.message, {
        attempt: this.state.attempt,
        status: response.status(),
        durationMs: this.state.lastDurationMs,
        retryAfterMs: this.state.retryAfterMs,
      });
    } else if (result.kind === "input") {
      this.state.phase = "input-error";
      this.state.retryAfterMs = 0;
      this.#log("error", "login.input_error", result.message, {
        attempt: this.state.attempt,
        status: response.status(),
      });
    } else {
      this.state.phase = "unknown";
      this.state.retryAfterMs = 0;
      this.#log("error", "login.unknown_response", result.message, {
        attempt: this.state.attempt,
        status: response.status(),
        durationMs: this.state.lastDurationMs,
      });
    }
    return { state: this.publicState(), result };
  }

  #settlePostFailure(error, startedAt) {
    this.state.phase = "uncertain";
    this.state.message =
      "انقطع طلب الدخول أو أُغلقت الصفحة. افحص Chrome والجلسة قبل إرسال POST جديد.";
    this.state.lastDurationMs = Math.round(performance.now() - startedAt);
    this.state.retryAfterMs = 0;
    this.state.lastPost = {
      outcome: "failed",
      attempt: this.state.attempt,
      status: null,
      durationMs: this.state.lastDurationMs,
      message: this.state.message,
      at: new Date().toISOString(),
    };
    this.#log("error", "login.request_failed", this.state.message, {
      attempt: this.state.attempt,
      durationMs: this.state.lastDurationMs,
      technical: safeTechnicalMessage(error),
    });
    return {
      state: this.publicState(),
      result: { kind: "uncertain", message: this.state.message, technical: error.message },
    };
  }

  #backoffFor(attempt) {
    const [min, max] =
      attempt <= 1 ? [30, 45] : attempt === 2 ? [45, 75] : [60, 120];
    return Math.round((min + this.#random() * (max - min)) * 1000);
  }

  #trackRequestStarted(request) {
    if (!this.#shouldTrackRequest(request) || this.#trackedRequests.has(request)) return;
    const method = request.method().toUpperCase();
    const urlPath = new URL(request.url()).pathname;
    this.#trackedRequests.set(request, {
      method,
      urlPath,
      startedAt: performance.now(),
    });
    this.#requestStats.total += 1;
    if (method === "GET") this.#requestStats.get += 1;
    if (method === "POST") this.#requestStats.post += 1;
    const snapshot = this.#requestStatsSnapshot();
    this.#log("info", "http.request_started", `${method} ${urlPath} بدأ.`, {
      method,
      urlPath,
      activeRequests: snapshot.active,
      totalRequests: snapshot.total,
    });
  }

  async #trackRequestFinished(request) {
    const tracked = this.#trackedRequests.get(request);
    if (!tracked) return;
    this.#trackedRequests.delete(request);
    if (tracked.method === "POST") this.#requestStats.completedPost += 1;
    else this.#requestStats.completedGet += 1;
    const response = await request.response().catch(() => null);
    const status = response?.status() ?? null;
    const snapshot = this.#requestStatsSnapshot();
    this.#log(
      status && status >= 400 ? "error" : "success",
      "http.request_finished",
      `${tracked.method} ${tracked.urlPath} انتهى${status ? ` بـ HTTP ${status}` : ""}.`,
      {
        method: tracked.method,
        urlPath: tracked.urlPath,
        status,
        durationMs: Math.round(performance.now() - tracked.startedAt),
        activeRequests: snapshot.active,
        totalRequests: snapshot.total,
      },
    );
  }

  #trackRequestFailed(request) {
    const tracked = this.#trackedRequests.get(request);
    if (!tracked) return;
    this.#trackedRequests.delete(request);
    if (tracked.method === "POST") this.#requestStats.failedPost += 1;
    else this.#requestStats.failedGet += 1;
    const snapshot = this.#requestStatsSnapshot();
    this.#log("error", "http.request_failed", `${tracked.method} ${tracked.urlPath} فشل.`, {
      method: tracked.method,
      urlPath: tracked.urlPath,
      durationMs: Math.round(performance.now() - tracked.startedAt),
      activeRequests: snapshot.active,
      totalRequests: snapshot.total,
      technical: request.failure()?.errorText ?? "Request failed",
    });
  }

  #shouldTrackRequest(request) {
    try {
      const url = new URL(request.url());
      if (url.origin !== this.options.upstream.origin) return false;
      const type = request.resourceType();
      const pathname = url.pathname.toLowerCase();
      const captcha = pathname.endsWith("/codeimage.aspx");
      return !(type === "font" || type === "media" || (type === "image" && !captcha));
    } catch {
      return false;
    }
  }

  #requestStatsSnapshot() {
    const active = [...this.#trackedRequests.values()];
    return {
      ...this.#requestStats,
      active: active.length,
      activeGet: active.filter((request) => request.method === "GET").length,
      activePost: active.filter((request) => request.method === "POST").length,
      completed: this.#requestStats.completedGet + this.#requestStats.completedPost,
      failed: this.#requestStats.failedGet + this.#requestStats.failedPost,
    };
  }

  #log(level, type, message, details = {}) {
    const allowedDetails = {};
    for (const key of [
      "attempt",
      "status",
      "durationMs",
      "retryAfterMs",
      "urlPath",
      "browserChannel",
      "technical",
      "method",
      "activeRequests",
      "totalRequests",
    ]) {
      if (details[key] !== undefined && details[key] !== null) {
        allowedDetails[key] = details[key];
      }
    }
    this.#events.push({
      id: ++this.#eventSequence,
      at: new Date().toISOString(),
      level,
      type,
      message,
      details: allowedDetails,
    });
    if (this.#events.length > 50) this.#events.splice(0, this.#events.length - 50);
  }

  async #resetBrowser({ allowPending = false } = {}) {
    if (this.#pendingPost && !allowPending) {
      throw new PublicError("لا يمكن إغلاق Chrome أثناء وجود POST Pending.", 409);
    }
    this.#prepared = false;
    this.#captcha = null;
    const browser = this.#browser;
    this.#page = null;
    this.#context = null;
    this.#browser = null;
    if (browser) await browser.close().catch(() => {});
    this.#trackedRequests.clear();
  }

  #signInUrl() {
    return new URL(this.options.signInPath, this.options.upstream).href;
  }

  async #exclusive(action) {
    if (this.#busy) throw new PublicError("يوجد أمر محلي جارٍ بالفعل.", 409);
    this.#busy = true;
    try {
      const result = await action();
      this.#busy = false;
      if (result?.state) result.state = this.publicState();
      return result;
    } catch (error) {
      this.#log("error", "operation.error", error?.message || "حدث خطأ غير متوقع.", {
        technical: safeTechnicalMessage(error),
      });
      throw error;
    } finally {
      this.#busy = false;
    }
  }
}

export class PublicError extends Error {
  constructor(message, status = 400, retryAfterMs = 0) {
    super(message);
    this.name = "PublicError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function validateCredentials({ graduateNumber, nationalNumber, captcha }) {
  if (!/^\d{1,14}$/.test(graduateNumber?.trim() ?? "")) {
    throw new PublicError("رقم الخريج يجب أن يتكون من أرقام فقط (بحد أقصى 14).", 400);
  }
  if (!/^\d{14}$/.test(nationalNumber?.trim() ?? "")) {
    throw new PublicError("الرقم القومي يجب أن يتكون من 14 رقمًا.", 400);
  }
  if (!/^\d{1,10}$/.test(captcha?.trim() ?? "")) {
    throw new PublicError("اكتب الكود التأكيدي الظاهر كأرقام فقط.", 400);
  }
}

function isPlaywrightTimeout(error) {
  return error?.name === "TimeoutError" || /Timeout .* exceeded/i.test(error?.message ?? "");
}

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(resolve, ms, value));
}

function safeTechnicalMessage(error) {
  const message = String(error?.message ?? error ?? "Unknown error");
  return message.replace(/[\r\n]+/g, " ").slice(0, 240);
}
