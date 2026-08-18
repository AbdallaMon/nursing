const elements = {
  statusBadge: document.querySelector("#statusBadge"),
  statusTitle: document.querySelector("#statusTitle"),
  statusMessage: document.querySelector("#statusMessage"),
  sessionSavedBadge: document.querySelector("#sessionSavedBadge"),
  currentPageLabel: document.querySelector("#currentPageLabel"),
  currentPagePath: document.querySelector("#currentPagePath"),
  attemptCount: document.querySelector("#attemptCount"),
  lastDuration: document.querySelector("#lastDuration"),
  timeoutValue: document.querySelector("#timeoutValue"),
  prepareButton: document.querySelector("#prepareButton"),
  newSessionButton: document.querySelector("#newSessionButton"),
  checkButton: document.querySelector("#checkButton"),
  loginForm: document.querySelector("#loginForm"),
  graduateNumber: document.querySelector("#graduateNumber"),
  nationalNumber: document.querySelector("#nationalNumber"),
  captchaValue: document.querySelector("#captchaValue"),
  captchaImage: document.querySelector("#captchaImage"),
  captchaPlaceholder: document.querySelector("#captchaPlaceholder"),
  refreshCaptchaButton: document.querySelector("#refreshCaptchaButton"),
  submitButton: document.querySelector("#submitButton"),
  autoPrepare: document.querySelector("#autoPrepare"),
  countdownPanel: document.querySelector("#countdownPanel"),
  countdownText: document.querySelector("#countdownText"),
  cancelCountdownButton: document.querySelector("#cancelCountdownButton"),
  clearButton: document.querySelector("#clearButton"),
  lastErrorText: document.querySelector("#lastErrorText"),
  activityLog: document.querySelector("#activityLog"),
  activeGetRequests: document.querySelector("#activeGetRequests"),
  activePostRequests: document.querySelector("#activePostRequests"),
  getRequests: document.querySelector("#getRequests"),
  postRequests: document.querySelector("#postRequests"),
  completedGetRequests: document.querySelector("#completedGetRequests"),
  failedGetRequests: document.querySelector("#failedGetRequests"),
  completedPostRequests: document.querySelector("#completedPostRequests"),
  failedPostRequests: document.querySelector("#failedPostRequests"),
  lastPostBadge: document.querySelector("#lastPostBadge"),
  lastPostTitle: document.querySelector("#lastPostTitle"),
  lastPostMessage: document.querySelector("#lastPostMessage"),
  lastPostAttempt: document.querySelector("#lastPostAttempt"),
  lastPostHttp: document.querySelector("#lastPostHttp"),
  lastPostDuration: document.querySelector("#lastPostDuration"),
  rememberCredentials: document.querySelector("#rememberCredentials"),
  deploymentModeLabel: document.querySelector("#deploymentModeLabel"),
  remoteBrowserCard: document.querySelector("#remoteBrowserCard"),
  remoteBrowserPanel: document.querySelector("#remoteBrowserPanel"),
  remoteBrowserFrame: document.querySelector("#remoteBrowserFrame"),
  toggleBrowserButton: document.querySelector("#toggleBrowserButton"),
  openBrowserButton: document.querySelector("#openBrowserButton"),
};

const CREDENTIALS_STORAGE_KEY = "nursing-login-helper.credentials.v1";

let token = "";
let currentState = null;
let captchaObjectUrl = null;
let countdownTimer = null;
let operationPending = false;
let lastAutoRetryAttempt = null;
let currentEvents = [];
let remoteBrowserUrl = null;
let remoteBrowserAutoOpened = false;

async function bootstrap() {
  try {
    const response = await fetch("/api/bootstrap", { cache: "no-store" });
    const payload = await response.json();
    token = payload.token;
    currentState = payload.state;
    currentEvents = payload.events ?? [];
    configureRemoteBrowser(payload.settings);
    restoreSavedCredentials();
    elements.timeoutValue.textContent = `${Math.round(payload.settings.requestTimeoutMs / 1000)} ث`;
    renderState();
    renderEvents();
  } catch {
    showLocalError("تعذر الاتصال بالبرنامج المحلي. أعد تشغيل start.bat.");
  }
}

function configureRemoteBrowser(settings = {}) {
  remoteBrowserUrl = settings.remoteMode ? settings.remoteBrowserUrl : null;
  elements.deploymentModeLabel.textContent = settings.remoteMode
    ? "الطلبات تخرج من الـVPS"
    : "الطلبات تخرج من جهازك الحالي";
  elements.remoteBrowserCard.classList.toggle("hidden", !remoteBrowserUrl);
  if (remoteBrowserUrl) toggleRemoteBrowser(true);
}

function ensureRemoteBrowserLoaded() {
  if (!remoteBrowserUrl) return false;
  if (!elements.remoteBrowserFrame.getAttribute("src")) {
    elements.remoteBrowserFrame.src = remoteBrowserUrl;
  }
  return true;
}

function toggleRemoteBrowser(forceOpen = null) {
  if (!ensureRemoteBrowserLoaded()) return;
  const shouldOpen = forceOpen ?? elements.remoteBrowserPanel.classList.contains("hidden");
  elements.remoteBrowserPanel.classList.toggle("hidden", !shouldOpen);
  elements.toggleBrowserButton.textContent = shouldOpen ? "إخفاء المتصفح" : "إظهار المتصفح";
}

function openRemoteBrowserTab() {
  if (!remoteBrowserUrl) return;
  window.open(remoteBrowserUrl, "nursing-register-vps-browser", "noopener");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      "X-Local-Token": token,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    const error = new Error(payload.message || "فشل الطلب المحلي.");
    error.retryAfterMs = payload.retryAfterMs || 0;
    throw error;
  }
  return payload;
}

async function runOperation(action) {
  if (operationPending) return;
  operationPending = true;
  cancelCountdown();
  renderState({ busy: true });
  try {
    return await action();
  } catch (error) {
    showLocalError(error.message);
    if (error.retryAfterMs) startCountdown(error.retryAfterMs);
    return null;
  } finally {
    operationPending = false;
    renderState();
    void pollDashboardState();
  }
}

async function prepare(reset = false) {
  const payload = await runOperation(() =>
    api("/api/prepare", { method: "POST", body: { reset } }),
  );
  if (!payload) return;
  currentState = payload.state;
  if (currentState.phase === "prepared") await loadCaptcha();
  else revokeCaptchaUrl();
  elements.captchaValue.value = "";
  renderState();
  if (currentState.phase === "prepared") elements.captchaValue.focus();
}

async function loadCaptcha() {
  revokeCaptchaUrl();
  const response = await fetch("/api/captcha", {
    headers: { "X-Local-Token": token },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("تعذر عرض الكود التأكيدي.");
  captchaObjectUrl = URL.createObjectURL(await response.blob());
  elements.captchaImage.src = captchaObjectUrl;
  elements.captchaImage.classList.remove("hidden");
  elements.captchaPlaceholder.classList.add("hidden");
}

async function submitLogin(event) {
  event.preventDefault();
  if (!elements.loginForm.reportValidity()) return;
  persistCredentialsIfEnabled();

  const payload = await runOperation(() =>
    api("/api/submit", {
      method: "POST",
      body: {
        graduateNumber: elements.graduateNumber.value,
        nationalNumber: elements.nationalNumber.value,
        captcha: elements.captchaValue.value,
      },
    }),
  );
  if (!payload) return;

  currentState = payload.state;
  revokeCaptchaUrl();
  elements.captchaValue.value = "";
  renderState();

  if (payload.result.kind === "transient" && elements.autoPrepare.checked) {
    startCountdown(currentState.retryAfterMs);
  }
}

async function checkSession() {
  const payload = await runOperation(() => api("/api/check", { method: "POST", body: {} }));
  if (!payload) return;
  currentState = payload.state;
  if (currentState.phase === "prepared") await loadCaptcha();
  renderState();
}

async function resetSession(clearFields = false) {
  const payload = await runOperation(() => api("/api/reset", { method: "POST", body: {} }));
  if (!payload) return;
  currentState = payload.state;
  revokeCaptchaUrl();
  elements.captchaValue.value = "";
  if (clearFields) {
    elements.graduateNumber.value = "";
    elements.nationalNumber.value = "";
    clearSavedCredentials();
  }
  renderState();
}

function startCountdown(durationMs) {
  cancelCountdown();
  const endsAt = Date.now() + Math.max(1000, durationMs);
  elements.countdownPanel.classList.remove("hidden");

  const tick = () => {
    const seconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    elements.countdownText.textContent = `تجهيز محاولة جديدة بعد ${seconds} ثانية — لن يتم إرسال POST تلقائيًا.`;
    if (seconds <= 0) {
      cancelCountdown();
      prepare(false);
    }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

async function pollDashboardState() {
  if (!token || !currentState) return;
  try {
    const payload = await api("/api/status");
    const previousPhase = currentState.phase;
    currentState = payload.state;
    currentEvents = payload.events ?? [];
    renderState();
    renderEvents();
    if (
      previousPhase !== "transient" &&
      currentState.phase === "transient" &&
      elements.autoPrepare.checked &&
      lastAutoRetryAttempt !== currentState.attempt
    ) {
      lastAutoRetryAttempt = currentState.attempt;
      startCountdown(currentState.retryAfterMs);
    }
  } catch {
    // The next poll will retry the local status call.
  }
}

function cancelCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  elements.countdownPanel.classList.add("hidden");
}

function renderState(override = {}) {
  if (!currentState) return;
  const state = { ...currentState, ...override };
  const prepared = state.phase === "prepared";
  const busy = operationPending || state.busy || override.busy;
  const success = state.phase === "success";

  const labels = {
    idle: ["غير مجهز", "ابدأ بتجهيز جلسة"],
    preparing: ["جاري التجهيز", "انتظار صفحة الدخول"],
    prepared: ["جاهز", "اكتب الكابتشا وأرسل"],
    submitting: ["Pending", "السيرفر يعالج محاولة الدخول"],
    transient: ["ضغط سيرفر", "المحاولة لم تنجح"],
    "input-error": ["راجع البيانات", "الموقع رفض أحد المدخلات"],
    uncertain: ["النتيجة غير مؤكدة", "افحص الجلسة قبل المحاولة التالية"],
    checking: ["جاري الفحص", "فحص الجلسة الحالية"],
    unknown: ["رد غير واضح", "لن نكرر الطلب تلقائيًا"],
    success: ["نجاح", "تم تسجيل الدخول"],
  };
  const [badge, title] = labels[state.phase] ?? ["حالة جديدة", "راجع الرسالة"];

  elements.statusBadge.textContent = busy ? "طلب جارٍ" : badge;
  elements.statusBadge.dataset.phase = state.phase;
  elements.statusTitle.textContent = title;
  elements.statusMessage.textContent = state.message;
  elements.sessionSavedBadge.textContent = state.sessionPersisted
    ? "الجلسة محفوظة على الـVPS"
    : "لا توجد جلسة محفوظة";
  elements.sessionSavedBadge.dataset.saved = state.sessionPersisted ? "true" : "false";
  elements.currentPageLabel.textContent = state.currentPage?.label ?? "Chrome غير مفتوح";
  elements.currentPagePath.textContent = state.currentPage?.path ?? "—";
  elements.attemptCount.textContent = String(state.attempt ?? 0);
  elements.lastDuration.textContent = state.lastDurationMs
    ? `${(state.lastDurationMs / 1000).toFixed(2)} ث`
    : "—";

  const requests = state.requestStats ?? {};
  elements.activeGetRequests.textContent = String(requests.activeGet ?? 0);
  elements.activePostRequests.textContent = String(requests.activePost ?? 0);
  elements.getRequests.textContent = String(requests.get ?? 0);
  elements.postRequests.textContent = String(requests.post ?? 0);
  elements.completedGetRequests.textContent = String(requests.completedGet ?? 0);
  elements.failedGetRequests.textContent = String(requests.failedGet ?? 0);
  elements.completedPostRequests.textContent = String(requests.completedPost ?? 0);
  elements.failedPostRequests.textContent = String(requests.failedPost ?? 0);
  renderLastPost(state.lastPost);

  elements.prepareButton.disabled = busy || success;
  elements.newSessionButton.disabled = busy;
  elements.refreshCaptchaButton.disabled = busy || !prepared;
  elements.graduateNumber.disabled = busy || !prepared;
  elements.nationalNumber.disabled = busy || !prepared;
  elements.captchaValue.disabled = busy || !prepared;
  elements.submitButton.disabled = busy || !prepared;
  elements.checkButton.classList.toggle("hidden", state.phase !== "uncertain");
  if (!success) remoteBrowserAutoOpened = false;
  if (success && remoteBrowserUrl && !remoteBrowserAutoOpened) {
    remoteBrowserAutoOpened = true;
    toggleRemoteBrowser(true);
  }
}

function renderEvents() {
  const visibleEvents = currentEvents.filter((event) => {
    if (!event.type?.startsWith("http.")) return true;
    const urlPath = event.details?.urlPath ?? "";
    return /\.aspx$/i.test(urlPath) && !/\/CodeImage\.aspx$/i.test(urlPath);
  });
  elements.activityLog.replaceChildren();
  if (!visibleEvents.length) {
    const empty = document.createElement("li");
    empty.className = "empty-log";
    empty.textContent = "في انتظار أول حدث...";
    elements.activityLog.append(empty);
    elements.lastErrorText.textContent = "لا يوجد خطأ حتى الآن.";
    return;
  }

  for (const event of visibleEvents) {
    const item = document.createElement("li");
    item.className = `log-item log-${event.level}`;

    const top = document.createElement("div");
    top.className = "log-item-top";
    const level = document.createElement("span");
    level.className = "log-level";
    level.textContent = levelLabel(event.level);
    const time = document.createElement("time");
    time.dateTime = event.at;
    time.textContent = new Date(event.at).toLocaleTimeString("ar-EG", { hour12: false });
    top.append(level, time);

    const message = document.createElement("p");
    message.textContent = event.message;
    item.append(top, message);

    const detailsText = formatEventDetails(event.details);
    if (detailsText) {
      const details = document.createElement("small");
      details.textContent = detailsText;
      item.append(details);
    }
    elements.activityLog.append(item);
  }

  const latestError = visibleEvents.find((event) => event.level === "error");
  elements.lastErrorText.textContent = latestError
    ? `${latestError.message}${formatEventDetails(latestError.details) ? ` — ${formatEventDetails(latestError.details)}` : ""}`
    : "لا يوجد خطأ حتى الآن.";
}

function renderLastPost(lastPost) {
  const post = lastPost ?? {
    outcome: "none",
    attempt: null,
    status: null,
    durationMs: null,
    message: "بعد إرسال تسجيل الدخول ستظهر النتيجة هنا.",
  };
  const labels = {
    none: ["لم يُرسل", "لا توجد محاولة POST بعد"],
    pending: ["Pending", "آخر POST ما زال جاريًا"],
    success: ["نجح", "آخر POST نجح وسجّل الدخول"],
    failed: ["فشل", "آخر POST لم يسجّل الدخول"],
  };
  const [badge, title] = labels[post.outcome] ?? labels.none;
  elements.lastPostBadge.textContent = badge;
  elements.lastPostBadge.dataset.outcome = post.outcome;
  elements.lastPostTitle.textContent = title;
  elements.lastPostMessage.textContent = post.message;
  elements.lastPostAttempt.textContent = post.attempt ? String(post.attempt) : "—";
  elements.lastPostHttp.textContent = post.status ? String(post.status) : "—";
  elements.lastPostDuration.textContent =
    post.durationMs !== null && post.durationMs !== undefined
      ? `${(post.durationMs / 1000).toFixed(2)} ث`
      : "—";
}

function levelLabel(level) {
  return { info: "معلومة", success: "نجاح", warn: "تنبيه", error: "خطأ" }[level] ?? level;
}

function formatEventDetails(details = {}) {
  const parts = [];
  if (details.attempt) parts.push(`محاولة ${details.attempt}`);
  if (details.status) parts.push(`HTTP ${details.status}`);
  if (details.durationMs !== undefined) parts.push(`${(details.durationMs / 1000).toFixed(2)} ثانية`);
  if (details.retryAfterMs) parts.push(`إعادة التجهيز بعد ${Math.ceil(details.retryAfterMs / 1000)} ثانية`);
  if (details.urlPath) parts.push(details.urlPath);
  if (details.browserChannel) parts.push(`Browser: ${details.browserChannel}`);
  if (details.technical) parts.push(details.technical);
  if (details.method) parts.push(details.method);
  if (details.activeRequests !== undefined) parts.push(`جاري: ${details.activeRequests}`);
  if (details.totalRequests !== undefined) parts.push(`إجمالي: ${details.totalRequests}`);
  return parts.join(" • ");
}

function restoreSavedCredentials() {
  try {
    const raw = localStorage.getItem(CREDENTIALS_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (/^\d{1,14}$/.test(saved.graduateNumber ?? "")) {
      elements.graduateNumber.value = saved.graduateNumber;
    }
    if (/^\d{14}$/.test(saved.nationalNumber ?? "")) {
      elements.nationalNumber.value = saved.nationalNumber;
    }
    elements.rememberCredentials.checked = true;
  } catch {
    clearSavedCredentials();
  }
}

function persistCredentialsIfEnabled() {
  if (!elements.rememberCredentials.checked) {
    try {
      localStorage.removeItem(CREDENTIALS_STORAGE_KEY);
    } catch {
      // Storage may be unavailable in a locked-down browser profile.
    }
    return;
  }
  try {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify({
        graduateNumber: elements.graduateNumber.value,
        nationalNumber: elements.nationalNumber.value,
      }),
    );
  } catch {
    elements.rememberCredentials.checked = false;
  }
}

function clearSavedCredentials() {
  try {
    localStorage.removeItem(CREDENTIALS_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in a locked-down browser profile.
  }
  elements.rememberCredentials.checked = false;
}

function showLocalError(message) {
  if (!currentState) currentState = { phase: "unknown", attempt: 0 };
  currentState = { ...currentState, phase: "unknown", message };
  renderState();
}

function revokeCaptchaUrl() {
  if (captchaObjectUrl) URL.revokeObjectURL(captchaObjectUrl);
  captchaObjectUrl = null;
  elements.captchaImage.removeAttribute("src");
  elements.captchaImage.classList.add("hidden");
  elements.captchaPlaceholder.classList.remove("hidden");
}

elements.prepareButton.addEventListener("click", () => prepare(false));
elements.newSessionButton.addEventListener("click", () => prepare(true));
elements.refreshCaptchaButton.addEventListener("click", () => prepare(false));
elements.loginForm.addEventListener("submit", submitLogin);
elements.checkButton.addEventListener("click", checkSession);
elements.cancelCountdownButton.addEventListener("click", cancelCountdown);
elements.clearButton.addEventListener("click", () => resetSession(true));
elements.rememberCredentials.addEventListener("change", persistCredentialsIfEnabled);
elements.graduateNumber.addEventListener("input", persistCredentialsIfEnabled);
elements.nationalNumber.addEventListener("input", persistCredentialsIfEnabled);
elements.toggleBrowserButton.addEventListener("click", () => toggleRemoteBrowser());
elements.openBrowserButton.addEventListener("click", openRemoteBrowserTab);
window.addEventListener("beforeunload", revokeCaptchaUrl);

bootstrap();
setInterval(pollDashboardState, 1500);
