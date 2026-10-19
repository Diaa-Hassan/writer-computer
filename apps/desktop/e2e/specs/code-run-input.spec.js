import { ok, strictEqual } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";

// Typing into running code: bash `read` and Python `input()` get the line
// typed in the tray, a password prompt masks and doesn't echo, and End
// input sends end-of-file (see SPECs/run-code-blocks-spec.md).
//
// Requires a restorable workspace: seed
// `~/Library/Application Support/com.writer-computer.e2e/recent_workspaces.json`
// with a real directory before launching. Without one this suite self-skips.
describe("Typing into running code", function () {
  const DOC = [
    "# Run input check",
    "",
    "```bash",
    'printf "Name: "; read name; echo "hi $name"',
    "```",
    "",
    "```python",
    'name = input("Language? ")',
    "print(name.upper())",
    "```",
    "",
    "```bash",
    'printf "Password: "; read -s pw; echo; echo "got ${#pw} chars"',
    "```",
    "",
    "```bash",
    'cat; echo "end of input"',
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

  /** Tray `index` (in document order) with its input line. */
  async function tray(index) {
    return browser.execute((i) => {
      const el = document.querySelectorAll(".cm-code-run-tray")[i];
      if (!el) return null;
      const input = el.querySelector(".cm-code-run-input-field");
      return {
        state: el.dataset.status,
        text: el.querySelector(".cm-code-run-output").textContent,
        inputShown: !el.querySelector(".cm-code-run-input").hidden,
        inputType: input.type,
      };
    }, index);
  }

  /** Type a line into tray `index`'s input and press Enter. */
  async function type(index, text) {
    await browser.execute(
      (i, value) => {
        const input = document.querySelectorAll(".cm-code-run-tray")[i].querySelector("input");
        input.focus();
        input.value = value;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      },
      index,
      text,
    );
  }

  const waitFor = (index, until, message) =>
    browser.waitUntil(async () => until(await tray(index)), {
      timeout: 10_000,
      timeoutMsg: message,
    });

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;
    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok ? recents.value[0] : null;
    ok(root, "no workspace root to seed the document into");
    await invoke("set_setting", { key: "code.trusted-folders", value: [root], scope: "global" });
    filePath = `${root}/code-run-input-e2e.md`;
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

  it("answers a bash read from the tray", async function () {
    const row = await $(`span*=Run input check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await $$(".cm-code-run-toggle")).length === 4, {
      timeout: 10_000,
      timeoutMsg: "run buttons never rendered",
    });

    await (await $$(".cm-code-run-toggle"))[0].click();
    await waitFor(0, (t) => t?.inputShown && t.text === "Name: ", "no prompt / input line");
    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/code-run-input.png`);
    }
    await type(0, "Diaa");
    await waitFor(0, (t) => t?.state === "done", "bash never finished");
    const done = await tray(0);
    strictEqual(done.text, "Name: Diaa\nhi Diaa\n");
    ok(!done.inputShown, "input line still shown after the run ended");
  });

  it("answers Python input()", async function () {
    await (await $$(".cm-code-run-toggle"))[1].click();
    await waitFor(1, (t) => t?.text === "Language? ", "python prompt never shown");
    await type(1, "rust");
    await waitFor(1, (t) => t?.state === "done", "python never finished");
    strictEqual((await tray(1)).text, "Language? rust\nRUST\n");
  });

  it("masks a password and doesn't echo it", async function () {
    await (await $$(".cm-code-run-toggle"))[2].click();
    await waitFor(2, (t) => t?.inputType === "password", "input wasn't masked after Password:");
    await type(2, "hunter22");
    await waitFor(2, (t) => t?.state === "done", "password block never finished");
    const done = await tray(2);
    ok(!done.text.includes("hunter22"), `password echoed: ${done.text}`);
    ok(done.text.endsWith("got 8 chars\n"), done.text);
  });

  it("End input sends end-of-file", async function () {
    await (await $$(".cm-code-run-toggle"))[3].click();
    await waitFor(3, (t) => t?.inputShown, "no input line for cat");
    await type(3, "line one");
    await waitFor(3, (t) => t?.text === "line one\nline one\n", "cat didn't echo the line");
    await browser.execute(() =>
      document
        .querySelectorAll(".cm-code-run-tray")[3]
        .querySelector(".cm-code-run-input-end")
        .click(),
    );
    await waitFor(3, (t) => t?.state === "done", "cat never saw end of input");
    ok((await tray(3)).text.endsWith("end of input\n"));
  });
});
