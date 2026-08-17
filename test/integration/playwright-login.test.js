import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { LoginManager } from "../../src/login-manager.js";

const captchaPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("keeps the successful session in the same controlled browser", async (t) => {
  process.env.HEADLESS = "1";
  process.env.BROWSER_CHANNEL = "chrome";

  let postedCookie = "";
  let postedBody = "";
  let postCount = 0;
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/Signin.aspx") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": "ASP.NET_SessionId=test-session; Path=/; HttpOnly",
      });
      return response.end(loginPage());
    }
    if (request.method === "GET" && url.pathname === "/CodeImage.aspx") {
      assert.match(request.headers.cookie ?? "", /ASP\.NET_SessionId=test-session/);
      response.writeHead(200, { "Content-Type": "image/png" });
      return response.end(captchaPng);
    }
    if (request.method === "POST" && url.pathname === "/Signin.aspx") {
      postCount += 1;
      postedCookie = request.headers.cookie ?? "";
      postedBody = await readBody(request);
      if (postCount === 1) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return response.end(loginPage("حاول الإتصال بالموقع في وقتِ لاحق"));
      }
      response.writeHead(302, { Location: "/Choices.aspx" });
      return response.end();
    }
    if (request.method === "GET" && url.pathname === "/Choices.aspx") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end("<html><body><h1>Choices</h1></body></html>");
    }
    response.writeHead(404).end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        upstream.closeAllConnections();
        upstream.close(resolve);
      }),
  );

  const { port } = upstream.address();
  const manager = new LoginManager({
    upstream: new URL(`http://127.0.0.1:${port}/`),
    signInPath: "/Signin.aspx",
    requestTimeoutMs: 10_000,
    minPostIntervalMs: 0,
    remoteMode: true,
    userAgent: "Login helper integration test",
    browserType: chromium,
    random: () => 0,
  });
  t.after(() => manager.close());

  const prepared = await manager.prepare();
  assert.equal(prepared.state.phase, "prepared");
  assert.equal(prepared.state.busy, false);
  assert.equal(manager.captcha().contentType, "image/png");
  assert.ok(prepared.state.requestStats.total >= 2);
  assert.ok(prepared.state.requestStats.get >= 2);
  assert.equal(prepared.state.requestStats.post, 0);

  const firstResult = await manager.submit({
    graduateNumber: "123456",
    nationalNumber: "12345678901234",
    captcha: "246810",
  });
  assert.equal(firstResult.result.kind, "transient");
  assert.equal(firstResult.state.lastPost.outcome, "failed");
  assert.equal(firstResult.state.lastPost.status, 200);
  assert.match(firstResult.state.lastPost.message, /حاول/);
  assert.ok(firstResult.state.retryAfterMs >= 30_000);
  assert.ok(manager.events(50).some((event) => event.type === "login.transient_error"));

  await manager.prepare();
  const result = await manager.submit({
    graduateNumber: "123456",
    nationalNumber: "12345678901234",
    captcha: "135790",
  });
  assert.equal(result.result.kind, "success");
  assert.equal(result.state.lastPost.outcome, "success");
  assert.equal(result.state.lastPost.status, 302);
  assert.equal(postCount, 2);
  assert.match(postedCookie, /ASP\.NET_SessionId=test-session/);
  assert.match(postedBody, /__VIEWSTATE=fresh-state/);
  assert.match(postedBody, /txtNationalNumber=12345678901234/);
  assert.match(result.state.nextLocation, /\/Choices\.aspx$/);

  const eventsJson = JSON.stringify(manager.events(50));
  assert.match(eventsJson, /login\.success/);
  assert.match(eventsJson, /"status":302/);
  assert.doesNotMatch(eventsJson, /12345678901234|123456|246810|135790/);

  const requestStats = manager.publicState().requestStats;
  assert.equal(requestStats.post, 2);
  assert.equal(requestStats.completedPost, 2);
  assert.equal(requestStats.failedPost, 0);
  assert.ok(requestStats.completedGet >= 4);
  assert.ok(requestStats.total >= 6);
  manager.resetEventsForDashboard();
  assert.equal(manager.events(50).length, 1);
  assert.equal(manager.events(50)[0].type, "dashboard.opened");
  assert.equal(manager.publicState().requestStats.total, 0);
  assert.equal(manager.publicState().requestStats.get, 0);
  assert.equal(manager.publicState().requestStats.post, 0);
  assert.equal(manager.publicState().lastPost, null);
});

function loginPage(error = "") {
  return `<!doctype html><html><body>
    <form id="aspnetForm" method="post" action="Signin.aspx">
      <input type="hidden" name="__VIEWSTATE" value="fresh-state" />
      <input type="hidden" name="__EVENTVALIDATION" value="fresh-validation" />
      <span id="_ctl0_ContentPlaceHolder1_lblError">${error}</span>
      <input name="_ctl0:ContentPlaceHolder1:txtId" type="text" />
      <input name="_ctl0:ContentPlaceHolder1:txtNationalNumber" type="password" />
      <img src="CodeImage.aspx" alt="Hidden Code" width="120" height="80" />
      <input name="_ctl0:ContentPlaceHolder1:txtCertainNumber" type="text" />
      <input name="_ctl0:ContentPlaceHolder1:btnOk" type="submit" value="موافق" />
    </form>
  </body></html>`;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
