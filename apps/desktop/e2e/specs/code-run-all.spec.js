import { ok, strictEqual } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";

// Run All from the command palette: seeds a note whose third block fails,
// runs "Run All Code Blocks" from ⌘P, and asserts the blocks ran top to
// bottom and the one after the failure never ran
// (see SPECs/run-code-blocks-spec.md).
//
// Requires a restorable workspace: seed
// `~/Library/Application Support/com.writer-computer.e2e/recent_workspaces.json`
// with a real directory before launching. Without one this suite self-skips.
describe("Run All code blocks", function () {
  const DOC = [
    "# Run all check",
    "",
    "```bash",
    "echo first",
    "```",
    "",
    "```py",
    'print("second")',
    "```",
    "",
    "```bash",
    "echo third; exit 4",
    "```",
    "",
    "```bash",
    "echo never",
    "```",
    "",
  ].join("\n");

  let workspaceRestored = false;
  let filePath = null;

  async function trays() {
    return browser.execute(() =>
      Array.from(document.querySelectorAll(".cm-code-run-tray")).map((el) => ({
        state: el.dataset.status,
        text: el.querySelector(".cm-code-run-output").textContent,
      })),
    );
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const root = await browser.executeAsync((done) => {
      window.__TAURI_INTERNALS__
        .invoke("get_recent_workspaces", {})
        .then((v) => done(v[0]))
        .catch(() => done(null));
    });
    ok(root, "no workspace root to seed the document into");
    filePath = `${root}/code-run-all-e2e.md`;
    // From outside the app so the watcher lists it (see code-run.spec.js).
    writeFileSync(filePath, DOC);
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(function () {
    if (filePath) rmSync(filePath, { force: true });
  });

  it("runs every block in order and stops at the first failure", async function () {
    const row = await $(`span*=Run all check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await $$(".cm-code-run-toggle")).length === 4, {
      timeout: 10_000,
      timeoutMsg: "run buttons never rendered",
    });

    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    const command = await $('[cmdk-item][data-value="run-all-code-blocks"]');
    await command.waitForExist({ timeout: 5_000 });
    await command.click();

    await browser.waitUntil(async () => (await trays())[2]?.state === "failed", {
      timeout: 15_000,
      timeoutMsg: "Run All never reached the failing block",
    });
    // Give a wrongly-continuing sequence time to start the fourth block.
    await browser.pause(500);
    const result = await trays();
    strictEqual(result.length, 3, "the block after the failure ran");
    strictEqual(result[0].text, "first\n");
    strictEqual(result[1].text, "second\n");
    strictEqual(result[2].text, "third\n");

    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/code-run-all.png`);
    }
  });
});
