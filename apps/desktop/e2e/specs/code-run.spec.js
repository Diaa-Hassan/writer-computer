import { ok, strictEqual } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";

// Running code fences: seeds a note with bash, python and js blocks, opens it, and
// asserts each gets a corner Run button, a run streams stdout and stderr into the panel
// in the note's folder and reports its exit code, and Stop kills a block that
// would otherwise sleep for a minute (see SPECs/run-code-blocks-spec.md).
//
// Requires a restorable workspace: seed
// `~/Library/Application Support/com.writer-computer.e2e/recent_workspaces.json`
// with a real directory before launching. Without one this suite self-skips.
describe("Running code blocks", function () {
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
    "```py",
    'print("py:", 6 * 7)',
    "```",
    "",
    "```js",
    'console.log("js:" + 6 * 7)',
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

  /** Corner toggle labels and output trays, each in document order. */
  async function ui() {
    return browser.execute(() => ({
      toggles: Array.from(document.querySelectorAll(".cm-code-run-toggle")).map(
        (b) => b.textContent,
      ),
      trays: Array.from(document.querySelectorAll(".cm-code-run-tray")).map((el) => ({
        status: el.querySelector(".cm-code-run-status").textContent,
        state: el.dataset.status,
        stdout: Array.from(el.querySelectorAll(".cm-code-run-stdout"))
          .map((s) => s.textContent)
          .join(""),
        stderr: Array.from(el.querySelectorAll(".cm-code-run-stderr"))
          .map((s) => s.textContent)
          .join(""),
      })),
    }));
  }

  async function clickToggle(index) {
    const buttons = await $$(".cm-code-run-toggle");
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

  it("puts a Run button in the corner of each runnable fence and no tray yet", async function () {
    const row = await $(`span*=Code run check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();

    await browser.waitUntil(async () => (await ui()).toggles.length === 4, {
      timeout: 10_000,
      timeoutMsg: "run buttons never rendered",
    });
    const { toggles, trays } = await ui();
    strictEqual(toggles.join(","), "Run,Run,Run,Run");
    strictEqual(trays.length, 0);
  });

  it("streams stdout and stderr from the note's folder and reports the exit code", async function () {
    await clickToggle(0);
    await browser.waitUntil(async () => (await ui()).trays[0]?.state === "failed", {
      timeout: 10_000,
      timeoutMsg: "first block never finished",
    });
    const [tray] = (await ui()).trays;
    const folder = root.split("/").filter(Boolean).pop();
    strictEqual(tray.stdout, `out:${folder}\n`);
    strictEqual(tray.stderr, "err-line\n");
    ok(tray.status.startsWith("Exit 3 · "), `unexpected status ${tray.status}`);
    strictEqual((await ui()).toggles[0], "Run");

    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/code-run-exit.png`);
    }
  });

  it("stops a long-running block from its corner button", async function () {
    await clickToggle(1);
    await browser.waitUntil(async () => (await ui()).trays[1]?.stdout.includes("tick 2"), {
      timeout: 10_000,
      timeoutMsg: "second block never streamed output",
    });
    const running = await ui();
    strictEqual(running.toggles[1], "Stop");
    ok(running.trays[1].status.startsWith("Running · "), running.trays[1].status);

    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/code-run-running.png`);
    }

    await clickToggle(1);
    await browser.waitUntil(async () => (await ui()).trays[1]?.state === "stopped", {
      timeout: 5_000,
      timeoutMsg: "Stop did not end the run",
    });
    const stopped = await ui();
    ok(!stopped.trays[1].stdout.includes("tick 10"), "run kept going after Stop");
    strictEqual(stopped.toggles[1], "Run");
  });

  it("runs other languages through the user's login-shell PATH", async function () {
    await clickToggle(2);
    await clickToggle(3);
    await browser.waitUntil(
      async () => {
        const { trays } = await ui();
        return trays.length === 4 && trays[2].state !== "running" && trays[3].state !== "running";
      },
      { timeout: 15_000, timeoutMsg: "python/node runs never finished" },
    );
    const { trays } = await ui();
    strictEqual(trays[2].stdout, "py: 42\n", `python: ${trays[2].stderr}`);
    strictEqual(trays[3].stdout, "js:42\n", `node: ${trays[3].stderr}`);
  });

  it("clears a tray", async function () {
    const clear = await $$(".cm-code-run-tray")[0].$('button[aria-label="Clear output"]');
    await clear.click();
    await browser.waitUntil(async () => (await ui()).trays.length === 3, {
      timeout: 5_000,
      timeoutMsg: "Clear did not remove the tray",
    });
  });
});
