import { ok, strictEqual } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";

// Running ```bash fences: seeds a note with two bash blocks, opens it, and
// asserts each gets a Run bar, a run streams stdout and stderr into the panel
// in the note's folder and reports its exit code, and Stop kills a block that
// would otherwise sleep for a minute (see SPECs/run-code-blocks-spec.md).
//
// Requires a restorable workspace: seed
// `~/Library/Application Support/com.writer-computer.e2e/recent_workspaces.json`
// with a real directory before launching. Without one this suite self-skips.
describe("Running bash code blocks", function () {
  const FILE_STEM = "code-run-e2e";
  const DOC = [
    "# Code run check",
    "",
    "```bash",
    'echo "out:$(basename "$PWD")"',
    'echo "err-line" >&2',
    "exit 3",
    "```",
    "",
    "```bash",
    "for i in $(seq 60); do echo tick $i; sleep 1; done",
    "```",
    "",
    "after",
    "",
  ].join("\n");

  let workspaceRestored = false;
  let root = null;
  let filePath = null;

  async function invoke(cmd, args) {
    return browser.executeAsync(
      (c, a, done) => {
        window.__TAURI_INTERNALS__
          .invoke(c, a)
          .then((v) => done({ ok: true, value: v }))
          .catch((e) => done({ ok: false, error: e && e.message ? e.message : String(e) }));
      },
      cmd,
      args,
    );
  }

  /** Text of each run panel, in document order. */
  async function panels() {
    return browser.execute(() =>
      Array.from(document.querySelectorAll(".cm-code-run")).map((el) => ({
        button: el.querySelector(".cm-code-run-button").textContent,
        status: el.querySelector(".cm-code-run-status").textContent,
        failed: el.querySelector(".cm-code-run-status").dataset.failed ?? null,
        stdout: Array.from(el.querySelectorAll(".cm-code-run-stdout"))
          .map((s) => s.textContent)
          .join(""),
        stderr: Array.from(el.querySelectorAll(".cm-code-run-stderr"))
          .map((s) => s.textContent)
          .join(""),
      })),
    );
  }

  async function clickRun(index) {
    const buttons = await $$(".cm-code-run-button");
    await buttons[index].click();
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the document into");

    filePath = `${root}/${FILE_STEM}.md`;
    // Written from outside the app so the file watcher picks it up as a new
    // file; the app's own `write_file` is skipped by self-write detection.
    writeFileSync(filePath, DOC);
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (filePath) rmSync(filePath, { force: true });
  });

  it("shows a Run bar under each bash fence", async function () {
    const row = await $(`span*=Code run check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();

    await browser.waitUntil(async () => (await panels()).length === 2, {
      timeout: 10_000,
      timeoutMsg: "run bars never rendered",
    });
    const [first, second] = await panels();
    strictEqual(first.button, "Run");
    strictEqual(second.button, "Run");
  });

  it("streams stdout and stderr from the note's folder and reports the exit code", async function () {
    await clickRun(0);
    await browser.waitUntil(async () => (await panels())[0].status === "Exit 3", {
      timeout: 10_000,
      timeoutMsg: "first block never finished",
    });
    const [first] = await panels();
    const folder = root.split("/").filter(Boolean).pop();
    strictEqual(first.stdout, `out:${folder}\n`);
    strictEqual(first.stderr, "err-line\n");
    strictEqual(first.failed, "true");
    strictEqual(first.button, "Run");

    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/code-run-exit.png`);
    }
  });

  it("stops a long-running block", async function () {
    await clickRun(1);
    await browser.waitUntil(async () => (await panels())[1].stdout.includes("tick 2"), {
      timeout: 10_000,
      timeoutMsg: "second block never streamed output",
    });
    strictEqual((await panels())[1].button, "Stop");

    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/code-run-running.png`);
    }

    await clickRun(1);
    await browser.waitUntil(async () => (await panels())[1].status === "Stopped", {
      timeout: 5_000,
      timeoutMsg: "Stop did not end the run",
    });
    const stopped = (await panels())[1];
    ok(!stopped.stdout.includes("tick 10"), "run kept going after Stop");
    strictEqual(stopped.button, "Run");
  });
});
