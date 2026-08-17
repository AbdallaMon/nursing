import test from "node:test";
import assert from "node:assert/strict";
import { classifyLoginResponse, parseLoginPage } from "../../src/html.js";

const loginHtml = ({ error = "" } = {}) => `
  <html><body>
    <form id="aspnetForm" method="post" action="Signin.aspx">
      <input type="hidden" name="__VIEWSTATE" value="state&amp;value" />
      <input type="hidden" name="__EVENTVALIDATION" value="validation" />
      <span id="_ctl0_ContentPlaceHolder1_lblError">${error}</span>
      <input name="_ctl0:ContentPlaceHolder1:txtId" type="text" />
      <input name="_ctl0:ContentPlaceHolder1:txtNationalNumber" type="password" />
      <img src="CodeImage.aspx" alt="Hidden Code" />
      <input name="_ctl0:ContentPlaceHolder1:txtCertainNumber" type="text" />
      <input name="_ctl0:ContentPlaceHolder1:btnOk" type="submit" value="موافق" />
    </form>
  </body></html>`;

test("parses the WebForms login fields and captcha", () => {
  const page = parseLoginPage(loginHtml());
  assert.equal(page.hasLoginForm, true);
  assert.equal(page.hiddenFields.__VIEWSTATE, "state&value");
  assert.equal(page.fieldNames.graduate, "_ctl0:ContentPlaceHolder1:txtId");
  assert.equal(page.fieldNames.national, "_ctl0:ContentPlaceHolder1:txtNationalNumber");
  assert.equal(page.fieldNames.captcha, "_ctl0:ContentPlaceHolder1:txtCertainNumber");
  assert.equal(page.fieldNames.submit, "_ctl0:ContentPlaceHolder1:btnOk");
  assert.equal(page.captchaPath, "CodeImage.aspx");
});

test("treats the site's retry-later message as transient even with HTTP 200", () => {
  const result = classifyLoginResponse({
    status: 200,
    location: null,
    text: loginHtml({ error: "حاول الإتصال بالموقع في وقتِ لاحق" }),
  });
  assert.equal(result.kind, "transient");
});

test("treats a non-Signin redirect as success", () => {
  const result = classifyLoginResponse({
    status: 302,
    location: "/Choices.aspx",
    text: "",
  });
  assert.equal(result.kind, "success");
});

test("treats the ASP.NET Runtime Error page as transient", () => {
  const result = classifyLoginResponse({
    status: 500,
    location: null,
    text: "Server Error in '/' Application. Runtime Error",
  });
  assert.equal(result.kind, "transient");
});

test("does not call an unexplained login-form HTTP 200 a success", () => {
  const result = classifyLoginResponse({ status: 200, location: null, text: loginHtml() });
  assert.equal(result.kind, "unknown");
});
