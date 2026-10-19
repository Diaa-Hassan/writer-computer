import { ok, strictEqual } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";

// Shared sessions: a note's bash and Python blocks each run in one live
// session, so later blocks see earlier variables and folders; `fresh` runs
// on its own; Restart Code Sessions starts over (see SPECs/run-code-blocks-spec.md).
//
// Requires a restorable workspace: seed
// `~/Library/Application Support/com.writer-computer.e2e/recent_workspaces.json`
// with a real directory before launching. Without one this suite self-skips.
describe("Shared code sessions", function () {
  const DOC = [
    "# Run session check",
    "",
    "```bash",
    "answer=41; cd /",
    "```",
    "",
    "```bash",
    'echo "$((answer + 1)) in $(pwd)"',
    "```",
    "",
    "```python",
    "import math",
    "radius = 2",
    "```",
    "",
    "```python",
    "print(round(math.pi * radius ** 2, 2))",
    "```",
    "",
    "```bash fresh",
    'echo "fresh sees [${answer}]"',
    "```",
    "",
  ].join("\n");

  let workspaceRestored = false;
  let filePath = null;

  async function invoke(cmd, args) {
    return browser.executeAsync(
      (c, a, done) => {
        window.__TAURI_INTERNALS__
          .invoke(c, a)
          .then((v) => done({ ok: true, value: v }))
          .catch((e) => done({ ok: false, error: String(e) }));
      },
      cmd,
      args,
    );
  }

  async function trays() {
    return browser.execute(() =>
      Array.from(document.querySelectorAll(".cm-code-run-tray")).map((el) => ({
        state: el.dataset.status,
        status: el.querySelector(".cm-code-run-status").textContent,
        text: el.querySelector(".cm-code-run-output").textContent,
      })),
    );
  }

  async function palette(command) {
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    const item = await $(`[cmdk-item][data-value="${command}"]`);
    await item.waitForExist({ timeout: 5_000 });
    await item.click();
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;
    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok ? recents.value[0] : null;
    ok(root, "no workspace root to seed the document into");
    await invoke("set_setting", { key: "code.trusted-folders", value: [root], scope: "global" });
    filePath = `${root}/code-run-session-e2e.md`;
    // From outside the app so the watcher lists it (see code-run.spec.js).
    writeFileSync(filePath, DOC);
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (workspaceRestored) {
      await invoke("reset_setting", { key: "code.trusted-folders", scope: "global" });
    }
    if (filePath) rmSync(filePath, { force: true });
  });

  it("carries variables, imports and the folder across blocks", async function () {
    const row = await $(`span*=Run session check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await $$(".cm-code-run-toggle")).length === 5, {
      timeout: 10_000,
      timeoutMsg: "run buttons never rendered",
    });
    await palette("run-all-code-blocks");
    await browser.waitUntil(
      async () => {
        const all = await trays();
        return all.length === 5 && all.every((t) => t.state === "done");
      },
      { timeout: 20_000, timeoutMsg: "Run All didn't finish all five blocks" },
    );
    const all = await trays();
    strictEqual(all[1].text, "42 in /\n");
    strictEqual(all[3].text, "12.57\n");
    strictEqual(all[4].text, "fresh sees []\n");
    ok(all[1].status.endsWith("· session"), all[1].status);
    ok(!all[4].status.includes("session"), `fresh block says ${all[4].status}`);

    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/code-run-session.png`);
    }
  });

  it("Restart Code Sessions starts over", async function () {
    await palette("restart-code-sessions");
    await browser.pause(500);
    await (await $$(".cm-code-run-toggle"))[1].click();
    await browser.waitUntil(async () => (await trays())[1]?.text.startsWith("1 in "), {
      timeout: 10_000,
      timeoutMsg: "the restarted session still had the old variables",
    });
    ok(!(await trays())[1].text.endsWith("in /\n"), "the restarted session kept the old folder");
  });
});
