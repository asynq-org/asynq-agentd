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

test("update service parses structured notes from linked pull requests", async () => {
  const updates = new UpdateService({
    currentVersion: "0.4.0",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/releases/latest")) {
        return new Response(JSON.stringify({
          tag_name: "v0.5.0",
          html_url: "https://github.com/asynq-org/asynq-agentd/releases/tag/v0.5.0",
          body: [
            "Release summary with linked PRs:",
            "- https://github.com/asynq-org/asynq-agentd/pull/5",
            "- https://github.com/asynq-org/asynq-agentd/pull/3",
          ].join("\n"),
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/pulls/5")) {
        return new Response(JSON.stringify({
          html_url: "https://github.com/asynq-org/asynq-agentd/pull/5",
          body: [
            "### asynq-agentd@0.5.0",
            "",
            "### Major Changes",
            "- Add managed update approvals.",
            "",
            "### Minor Changes",
            "- Improve dashboard summaries.",
            "",
            "### Patch Changes",
            "- Fix update status race.",
          ].join("\n"),
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      if (url.includes("/pulls/3")) {
        return new Response(JSON.stringify({
          html_url: "https://github.com/asynq-org/asynq-agentd/pull/3",
          body: [
            "### asynq-agentd@0.4.9",
            "",
            "### Minor Changes",
            "- Add compatibility hints to overview.",
          ].join("\n"),
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const status = await updates.checkNow();
  assert.equal(status.status, "update_available");
  assert.match(status.release_notes ?? "", /asynq-agentd@0\.5\.0/i);
  assert.match(status.release_notes ?? "", /Major Changes/i);
  assert.match(status.release_notes ?? "", /Patch Changes/i);
  assert.match(status.release_notes ?? "", /pull\/5/i);
});
