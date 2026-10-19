import { ok, strictEqual } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";

// Code settings: seeds a note, then checks the first run in the folder asks
// for permission and Allow adds it to Trusted Folders, the Run Time Limit stops a slow
// block, an Interpreters entry replaces a language's program, and turning
// off Run Code Blocks in Settings removes the Run buttons
// (see SPECs/run-code-blocks-spec.md).
//
// Requires a restorable workspace: seed
// `~/Library/Application Support/com.writer-computer.e2e/recent_workspaces.json`
// with a real directory before launching. Without one this suite self-skips.
describe("Code run settings", function () {
  const DOC = [
    "# Run settings check",
    "",
    "```bash",
    "echo start; sleep 5; echo end",
    "```",
    "",
    "```sh",
    'echo "zsh:$ZSH_VERSION"',
    "```",
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
          .catch((e) => done({ ok: false, error: String(e) }));
      },
      cmd,
      args,
    );
  }

  const setGlobal = (key, value) => invoke("set_setting", { key, value, scope: "global" });

  async function trays() {
    return browser.execute(() =>
      Array.from(document.querySelectorAll(".cm-code-run-tray")).map((el) => ({
        state: el.dataset.status,
        status: el.querySelector(".cm-code-run-status").textContent,
        text: el.querySelector(".cm-code-run-output").textContent,
      })),
    );
  }

  async function clickToggle(index) {
    await (await $$(".cm-code-run-toggle"))[index].click();
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;
    const recents = await invoke("get_recent_workspaces", {});
    root = recents.ok ? recents.value[0] : null;
    await invoke("reset_setting", { key: "code.trusted-folders", scope: "global" });
    ok(root, "no workspace root to seed the document into");
    filePath = `${root}/code-run-settings-e2e.md`;
    // From outside the app so the watcher lists it (see code-run.spec.js).
    writeFileSync(filePath, DOC);
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (!workspaceRestored) return;
    for (const key of [
      "code.timeout-seconds",
      "code.interpreters",
      "code.run-enabled",
      "code.trusted-folders",
    ]) {
      await invoke("reset_setting", { key, scope: "global" });
    }
    if (filePath) rmSync(filePath, { force: true });
  });

  it("asks before the first run in a folder, and Allow trusts it", async function () {
    const row = await $(`span*=Run settings check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await $$(".cm-code-run-toggle")).length === 2, {
      timeout: 10_000,
      timeoutMsg: "run buttons never rendered",
    });

    await clickToggle(1);
    await browser.waitUntil(async () => (await trays())[0]?.state === "needs-trust", {
      timeout: 10_000,
      timeoutMsg: "no permission prompt for an untrusted folder",
    });
    const shown = await browser.execute(
      () => document.querySelector(".cm-code-run-trust-folder")?.textContent,
    );
    ok(shown && shown.endsWith(root.split("/").pop()), `prompt names ${shown}`);
    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/code-run-trust.png`);
    }

    await (await $(".cm-code-run-trust-allow")).click();
    await browser.waitUntil(async () => (await trays())[0]?.state === "done", {
      timeout: 10_000,
      timeoutMsg: "the block didn't run after Allow",
    });
    const saved = await invoke("get_setting", { key: "code.trusted-folders" });
    ok(
      saved.ok && JSON.stringify(saved.value).includes(root.split("/").pop()),
      JSON.stringify(saved),
    );
  });

  it("stops a block at the time limit", async function () {
    ok((await setGlobal("code.timeout-seconds", 1)).ok, "could not set the time limit");

    await clickToggle(0);
    await browser.waitUntil(async () => (await trays())[0]?.state === "timedout", {
      timeout: 4_000,
      timeoutMsg: "the 1s limit did not stop a 5s block",
    });
    const [tray] = await trays();
    strictEqual(tray.text, "start\n");
    ok(tray.status.startsWith("Time limit reached · "), tray.status);
  });

  it("runs a language with the interpreter set in Settings", async function () {
    ok((await setGlobal("code.interpreters", ["sh=/bin/zsh"])).ok, "could not set interpreters");
    await clickToggle(1);
    // This block already ran once (the permission test), so wait for the new
    // output rather than a "done" status that is already there.
    await browser.waitUntil(async () => /^zsh:\d/.test((await trays())[1]?.text ?? ""), {
      timeout: 10_000,
      timeoutMsg: "the sh block never ran with zsh",
    });
    ok(/^zsh:\d/.test((await trays())[1].text), (await trays())[1].text);
  });

  it("removes the Run buttons when running is turned off in Settings", async function () {
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    const settingsCommand = await $('[cmdk-item][data-value="open-settings"]');
    await settingsCommand.waitForExist({ timeout: 5_000 });
    await settingsCommand.click();

    const toggle = await $("[data-settings-panel]").$(
      `//div[text()="Run Code Blocks"]/ancestor::div[contains(@class,"justify-between")]//button[@role="switch"]`,
    );
    await toggle.waitForExist({ timeout: 5_000 });
    await toggle.click();

    // Back to the note: its editor stayed mounted behind the settings tab.
    await (await $(`span*=Run settings check`)).click();
    await browser.waitUntil(async () => (await $$(".cm-code-run-toggle")).length === 0, {
      timeout: 5_000,
      timeoutMsg: "Run buttons still shown with running turned off",
    });
    strictEqual((await trays()).length, 0);
  });
});
