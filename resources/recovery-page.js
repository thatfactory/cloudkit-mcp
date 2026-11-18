"use strict";
// No token is displayed, persisted, copied, or written to the browser console.
(() => {
  const signin = document.getElementById("signin");
  const cancel = document.getElementById("cancel");
  const status = document.getElementById("status");
  let challenge;
  let popup;
  let finished = false;
  let watcher;
  let deadline;
  const post = (route, body) => fetch(route, { method: "POST", cache: "no-store", credentials: "omit", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const finish = (message) => {
    finished = true;
    clearInterval(watcher);
    clearTimeout(deadline);
    window.removeEventListener("message", receive);
    signin.disabled = true;
    cancel.disabled = true;
    if (popup && !popup.closed) popup.close();
    popup = undefined;
    challenge = undefined;
    status.textContent = message;
  };
  const invalid = (check, origin) => {
    const knownOrigins = { "https://api.apple-cloudkit.com": "cloudkitApi", "https://cdn.apple-cloudkit.com": "cloudkitCdn", "https://idmsa.apple.com": "appleSignIn", "https://www.icloud.com": "icloudWeb", "https://icloud.com": "icloudWeb", "https://appleid.apple.com": "appleId", "https://account.apple.com": "appleAccount", "https://icloud.developer.apple.com": "developerConsole", "null": "opaque" };
    const originClass = origin === window.location.origin ? "localPage" : knownOrigins[origin] || "other";
    let source = origin === "null" ? "opaque" : typeof origin === "string" && origin.length === 0 ? "empty" : "unavailable";
    try { const parsed = new URL(origin); if (["https:", "http:"].includes(parsed.protocol)) source = parsed.hostname; } catch {}
    const callbackHost = /^[a-z.-]+\.(?:apple|icloud|cdn-apple|apple-cloudkit)\.com$/.test(source) ? source : undefined;
    void post("invalid", { check, originClass, callbackHost }).catch(() => {});
    finish(`The sign-in response could not be validated. Callback source: ${source}. Return to your agent for recovery status.`);
  };
  const receive = async (event) => {
    if (finished || !popup || event.source !== popup) return;
    const data = event.data;
    // Auth windows may send unrelated readiness messages before their token callback.
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    if (data.ckWebAuthToken === undefined && data.ckSession === undefined && data.errorMessage === undefined) return;
    let origin = event.origin;
    try { origin = new URL(origin).origin; } catch {}
    if (!challenge || !challenge.callbackOrigins.includes(origin)) { invalid("origin", event.origin); return; }
    const values = [data.ckWebAuthToken, data.ckSession].filter((value) => value !== undefined);
    if (values.length === 0 || values.some((value) => typeof value !== "string" || value.length < 1 || value.length > 4096) || values.some((value) => value !== values[0]) || data.errorMessage !== undefined) { invalid(data.errorMessage !== undefined ? "provider" : "payload", event.origin); return; }
    // Stop accepting messages before the first asynchronous boundary.
    finished = true;
    try {
      const response = await post("token", { token: values[0] });
      finish(response.ok ? "Apple sign-in received. Return to your agent for session verification and recovery status." : "The recovery attempt is no longer accepting sign-in. Return to your agent.");
    } catch { finish("The connector could not receive sign-in. Return to your agent for recovery status."); }
  };
  window.addEventListener("message", receive);
  signin.addEventListener("click", () => {
    if (!challenge || finished || popup) return;
    popup = window.open(challenge.url, "_blank", "popup,width=640,height=600");
    if (!popup) { status.textContent = "Allow the sign-in window, then click Open Apple sign-in again."; return; }
    signin.disabled = true;
    status.textContent = "Complete Apple sign-in and verification in the sign-in window.";
    watcher = setInterval(() => { if (!finished && popup && popup.closed) cancel.click(); }, 500);
  });
  cancel.addEventListener("click", () => {
    if (finished) return;
    void post("cancel").catch(() => {});
    finish("Recovery cancelled. The diagnostic session remains unavailable.");
  });
  window.addEventListener("pagehide", () => { if (!finished) navigator.sendBeacon("cancel", ""); });
  fetch("challenge", { cache: "no-store", credentials: "omit" }).then(async (response) => {
    if (!response.ok) throw new Error();
    challenge = await response.json();
    if (finished) { challenge = undefined; return; }
    document.getElementById("context").textContent = `Profile: ${challenge.profileId} · Environment: ${challenge.environment}`;
    deadline = setTimeout(() => {
      if (finished) return;
      void post("cancel").catch(() => {});
      finish("Recovery timed out. Return to your agent to start a fresh attempt.");
    }, Math.max(0, challenge.expiresAt - Date.now()));
    signin.disabled = false;
    status.textContent = "Ready. Open Apple sign-in to continue.";
  }).catch(() => finish("The sign-in page is no longer available. Return to your agent for recovery status."));
})();
