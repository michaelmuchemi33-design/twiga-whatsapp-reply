import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("TWIGA reply service starts and responds to /healthz", async () => {
  const port = String(18000 + Math.floor(Math.random() * 1000));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: port,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      OPENWA_BASE_URL: "http://127.0.0.1:2785",
      OPENWA_API_KEY: "test-openwa-api-key",
      OPENWA_WEBHOOK_SECRET: "test-webhook-secret-at-least-16-characters"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });

  try {
    let response;
    let lastError;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error("Service exited early: " + output);
      try {
        response = await fetch("http://127.0.0.1:" + port + "/healthz", { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
        lastError = new Error("HTTP " + response.status);
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(response?.ok, "health endpoint did not become ready: " + String(lastError) + "\n" + output);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, "twiga-whatsapp-reply");
    assert.ok(body.model);

    const base = "http://127.0.0.1:" + port;
    const unauthStatus = await fetch(base + "/api/whatsapp/status?businessId=00000000-0000-0000-0000-000000000001");
    assert.equal(unauthStatus.status, 401, "business WhatsApp routes must require a signed-in user");

    const unauthUpload = await fetch(base + "/api/catalog/upload-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ businessId: "00000000-0000-0000-0000-000000000001", contentType: "image/png", sizeBytes: 128 })
    });
    assert.equal(unauthUpload.status, 401, "product image signing must require business membership");

    const unsignedWebhook = await fetch(base + "/webhooks/openwa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "message.received", sessionId: "test", data: {} })
    });
    assert.equal(unsignedWebhook.status, 401, "OpenWA webhooks must reject unsigned events");
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 1500);
    });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
