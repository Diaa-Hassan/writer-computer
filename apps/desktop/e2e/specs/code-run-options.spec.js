import { ok, strictEqual } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";

// Fence options and terminal colours: cwd= runs in another folder,
// timeout= overrides the global limit, color asks tools for colour and the
// tray draws it, skip keeps a block out of Run All, and a sql block runs in
// SQLite (see SPECs/run-code-blocks-spec.md).
//
// Requires a restorable workspace: seed
// `~/Library/Application Support/com.writer-computer.e2e/recent_workspaces.json`
// with a real directory before launching. Without one this suite self-skips.
describe("Code block options", function () {
  const DOC = [
    "# Run options check",
    "",
    "```bash cwd=..",
    'echo "in:$(pwd)"',
    "```",
    "",
    // `skip` too: Run All must pass it by (a timed-out block would stop it).
    "```bash timeout=1 skip",
    "echo start; sleep 3; echo end",
    "```",
    "",
    "```bash color",
    'echo "force:$FORCE_COLOR"; printf "\\033[31mred\\033[0m \\033[1;38;5;208mbold orange\\033[0m\\n"',
    "```",
    "",
    "```bash skip",
    "echo skipped",
    "```",
    "",
    "```sql",
    "select 6 * 7 as answer;",
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

  /** Each tray, keyed by the index of its fence (trays only exist once run). */
  async function trays() {
    return browser.execute(() => {
      const toggles = Array.from(document.querySelectorAll(".cm-code-run-toggle"));
      const fenceOf = (tray) => {
        // A tray follows its fence; the nearest toggle above it is that fence's.
        let index = -1;
        for (const [i, toggle] of toggles.entries()) {
          if (toggle.compareDocumentPosition(tray) & Node.DOCUMENT_POSITION_FOLLOWING) index = i;
        }
        return index;
      };
      return Object.fromEntries(
        Array.from(document.querySelectorAll(".cm-code-run-tray")).map((el) => [
          fenceOf(el),
          {
            state: el.dataset.status,
            text: el.querySelector(".cm-code-run-output").textContent,
            spans: Array.from(el.querySelectorAll(".cm-code-run-output span")).map((s) => ({
              text: s.textContent,
              color: s.style.color,
              bold: s.classList.contains("cm-ansi-bold"),
            })),
          },
        ]),
      );
    });
  }

  async function runAndWait(index, until) {
    await (await $$(".cm-code-run-toggle"))[index].click();
    await browser.waitUntil(async () => until((await trays())[index]), {
      timeout: 10_000,
      timeoutMsg: `block ${index} never reached the expected state`,
    });
    return (await trays())[index];
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;
    const recents = await invoke("get_recent_workspaces", {});
    root = recents.ok ? recents.value[0] : null;
    ok(root, "no workspace root to seed the document into");
    await invoke("set_setting", { key: "code.trusted-folders", value: [root], scope: "global" });
    filePath = `${root}/code-run-options-e2e.md`;
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

  it("runs a cwd= block in that folder", async function () {
    const row = await $(`span*=Run options check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await $$(".cm-code-run-toggle")).length === 5, {
      timeout: 10_000,
      timeoutMsg: "run buttons never rendered",
    });
    const tray = await runAndWait(0, (t) => t?.state === "done");
    const parent = root.split("/").slice(0, -1).join("/");
    ok(tray.text.trim().endsWith(parent.split("/").pop()), `ran in ${tray.text}`);
  });

  it("stops at the block's own timeout", async function () {
    const tray = await runAndWait(1, (t) => t?.state === "timedout");
    strictEqual(tray.text, "start\n");
  });

  it("asks for colour and draws it", async function () {
    const tray = await runAndWait(2, (t) => t?.state === "done");
    ok(tray.text.startsWith("force:1\n"), tray.text);
    const red = tray.spans.find((s) => s.text === "red");
    const orange = tray.spans.find((s) => s.text === "bold orange");
    ok(red && red.color === "var(--ansi-1)", JSON.stringify(red));
    ok(orange && orange.bold && /^rgb\(255, 135, 0\)$/.test(orange.color), JSON.stringify(orange));
    ok(!tray.text.includes("\u001b"), "escape codes leaked into the text");

    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/code-run-options.png`);
    }
  });

  it("leaves a skip block out of Run All and runs SQL", async function () {
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    const runAll = await $('[cmdk-item][data-value="run-all-code-blocks"]');
    await runAll.waitForExist({ timeout: 5_000 });
    await runAll.click();
    await browser.waitUntil(async () => (await trays())[4]?.state === "done", {
      timeout: 20_000,
      timeoutMsg: "Run All never reached the sql block",
    });
    const all = await trays();
    strictEqual(all[3], undefined, "the skip block ran");
    strictEqual(all[1].state, "timedout", "Run All re-ran the skipped timeout block");
    ok(/answer\s*\n-+\s*\n\s*42/.test(all[4].text), all[4].text);
  });
});
