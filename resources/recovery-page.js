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
  const post = (route, body) => fetch(route, { method: "POST", cache: "no-store", credentials: "omit", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const finish = (message) => {
    finished = true;
    clearInterval(watcher);
    window.removeEventListener("message", receive);
    signin.disabled = true;
    cancel.disabled = true;
    if (popup && !popup.closed) popup.close();
    popup = undefined;
    challenge = undefined;
    status.textContent = message;
  };
  const invalid = () => { void post("invalid").catch(() => {}); finish("The sign-in response could not be validated. Return to your agent for recovery status."); };
  const receive = async (event) => {
    if (finished || !popup || event.source !== popup) return;
    if (!challenge || event.origin !== challenge.origin) { invalid(); return; }
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) { invalid(); return; }
    const values = [data.ckWebAuthToken, data.ckSession].filter((value) => value !== undefined);
    if (values.length === 0 || values.some((value) => typeof value !== "string" || value.length < 1 || value.length > 4096) || values.some((value) => value !== values[0]) || data.errorMessage !== undefined) { invalid(); return; }
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
    signin.disabled = false;
    status.textContent = "Ready. Open Apple sign-in to continue.";
  }).catch(() => finish("The sign-in page is no longer available. Return to your agent for recovery status."));
})();
