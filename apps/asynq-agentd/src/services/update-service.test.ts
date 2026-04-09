import test from "node:test";
import assert from "node:assert/strict";
import { UpdateService } from "./update-service.ts";

test("update service reports compatibility requirements", () => {
  const updates = new UpdateService({
    currentVersion: "0.4.0",
    minSupportedBuddyVersion: "0.2.0",
  });

  const compatibility = updates.getCompatibility({
    app_version: "0.1.0",
    min_supported_agentd_version: "0.5.0",
  });

  assert.equal(compatibility.requires_buddy_update, true);
  assert.equal(compatibility.requires_agentd_update, true);
  assert.equal(compatibility.min_supported_buddy_version, "0.2.0");
  assert.equal(compatibility.agentd_version, "0.4.0");
});

test("update service detects a newer GitHub release", async () => {
  const updates = new UpdateService({
    currentVersion: "0.4.0",
    fetchImpl: async () => new Response(JSON.stringify({
      tag_name: "v0.5.0",
      html_url: "https://example.com/releases/v0.5.0",
      body: "Important fixes and compatibility updates.",
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
  });

  const status = await updates.checkNow();
  assert.equal(status.status, "update_available");
  assert.equal(status.latest_version, "0.5.0");
  assert.match(status.release_notes ?? "", /Important fixes/i);
});
