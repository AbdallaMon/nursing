const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
  ["lt", "<"],
  ["gt", ">"],
  ["nbsp", "\u00a0"],
]);

export function decodeEntities(value = "") {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : match;
    }
    return NAMED_ENTITIES.get(entity.toLowerCase()) ?? match;
  });
}

export function stripTags(value = "") {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAttributes(tag) {
  const attributes = {};
  const pattern = /([^\s=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(tag))) {
    const name = match[1].toLowerCase();
    if (name === "input" || name === "form" || name === "img" || name === "span") {
      continue;
    }
    attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function elementTextByIdSuffix(html, suffix) {
  const pattern = new RegExp(
    `<([a-z][\\w:-]*)\\b([^>]*\\bid=["'][^"']*${escapeRegExp(suffix)}["'][^>]*)>([\\s\\S]*?)<\\/\\1>`,
    "i",
  );
  return stripTags(pattern.exec(html)?.[3] ?? "");
}

export function parseLoginPage(html) {
  const formMatch = /<form\b([^>]*)\bmethod=["']?post["']?[^>]*>([\s\S]*?)<\/form>/i.exec(
    html,
  );

  if (!formMatch) {
    return {
      hasLoginForm: false,
      hiddenFields: {},
      fieldNames: {},
      action: null,
      captchaPath: null,
      errorText: elementTextByIdSuffix(html, "lblError"),
    };
  }

  const formAttributes = parseAttributes(formMatch[1]);
  const formHtml = formMatch[2];
  const hiddenFields = {};
  const fieldNames = {};
  const inputPattern = /<input\b[^>]*>/gi;
  let inputMatch;

  while ((inputMatch = inputPattern.exec(formHtml))) {
    const attributes = parseAttributes(inputMatch[0]);
    if (!attributes.name) continue;

    if ((attributes.type ?? "text").toLowerCase() === "hidden") {
      hiddenFields[attributes.name] = attributes.value ?? "";
    }

    if (attributes.name.endsWith(":txtId")) fieldNames.graduate = attributes.name;
    if (attributes.name.endsWith(":txtNationalNumber")) {
      fieldNames.national = attributes.name;
    }
    if (attributes.name.endsWith(":txtCertainNumber")) {
      fieldNames.captcha = attributes.name;
    }
    if (attributes.name.endsWith(":btnOk")) {
      fieldNames.submit = attributes.name;
      fieldNames.submitValue = attributes.value || "موافق";
    }
  }

  const captchaMatch = /<img\b[^>]*\bsrc=["']([^"']*CodeImage\.aspx[^"']*)["'][^>]*>/i.exec(
    formHtml,
  );

  return {
    hasLoginForm: true,
    hiddenFields,
    fieldNames,
    action: formAttributes.action || "Signin.aspx",
    captchaPath: decodeEntities(captchaMatch?.[1] ?? "CodeImage.aspx"),
    errorText: elementTextByIdSuffix(html, "lblError"),
  };
}

export function classifyLoginResponse({ status, location, text }) {
  const normalizedLocation = location ? new URL(location, "http://local/") : null;
  const isSignInLocation = normalizedLocation?.pathname
    .toLowerCase()
    .endsWith("/signin.aspx");

  if (status >= 300 && status < 400 && location && !isSignInLocation) {
    return { kind: "success", message: "تم تسجيل الدخول وتحويل الجلسة للصفحة التالية." };
  }

  if (status >= 500 || /Server Error in ['"]?\/['"]? Application|Runtime Error/i.test(text)) {
    return { kind: "transient", message: "السيرفر أعاد خطأ داخليًا مؤقتًا." };
  }

  const page = parseLoginPage(text);
  if (!page.hasLoginForm) {
    return { kind: "success", message: "اختفى نموذج الدخول؛ تم اعتبار الجلسة ناجحة." };
  }

  const error = page.errorText;
  if (/حاول\s+(?:الإ|ا)?تصال|وقت.{0,8}لاحق/i.test(error)) {
    return { kind: "transient", message: error || "الموقع طلب المحاولة لاحقًا." };
  }
  if (/تأكيدي|captcha/i.test(error)) {
    return { kind: "input", field: "captcha", message: error };
  }
  if (/غير\s+صحيح|غير\s+سليم|رقم\s+قومي|رقم\s+الخريج/i.test(error)) {
    return { kind: "input", field: "credentials", message: error };
  }
  if (error) return { kind: "input", field: "unknown", message: error };

  return {
    kind: "unknown",
    message: "رجع نموذج الدخول بدون رسالة واضحة؛ لن نكرر الطلب تلقائيًا.",
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
