import { ok, strictEqual } from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";

// Note variables: frontmatter `vars:` and a ```vars block reach bash (shell
// variables) and Python (typed values), and `{{name}}` in prose shows the value
// (see SPECs/run-code-blocks-spec.md).
//
// Requires a restorable workspace: seed
// `~/Library/Application Support/com.writer-computer.e2e/recent_workspaces.json`
// with a real directory before launching. Without one this suite self-skips.
describe("Note variables", function () {
  const DOC = [
    "---",
    "vars:",
    "  env: staging",
    "---",
    "# Run vars check",
    "",
    "Deploy to {{host}} on port {{port}} ({{env}}). Not a variable: {{nothing}}.",
    "",
    "```vars",
    "port = 8080",
    'host = "api.local"',
    "```",
    "",
    "```bash",
    'echo "$host:$port $env"',
    "```",
    "",
    "```python",
    "print(port + 1, type(port).__name__, host.upper())",
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

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;
    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok ? recents.value[0] : null;
    ok(root, "no workspace root to seed the document into");
    await invoke("set_setting", { key: "code.trusted-folders", value: [root], scope: "global" });
    filePath = `${root}/code-run-vars-e2e.md`;
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

  it("shows declared {{names}} in prose as their values", async function () {
    const row = await $(`span*=Run vars check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();
    await browser.waitUntil(async () => (await $$(".cm-code-var")).length === 3, {
      timeout: 10_000,
      timeoutMsg: "variable chips never rendered",
    });
    const chips = await browser.execute(() =>
      Array.from(document.querySelectorAll(".cm-code-var")).map((el) => el.textContent),
    );
    strictEqual(chips.join(","), "api.local,8080,staging");
    const prose = await browser.execute(
      () =>
        Array.from(document.querySelectorAll(".cm-line")).find((l) =>
          l.textContent.includes("Deploy"),
        )?.textContent,
    );
    ok(prose.includes("{{nothing}}"), `an undeclared name was replaced: ${prose}`);
  });

  it("passes them to bash and, typed, to Python", async function () {
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    const runAll = await $('[cmdk-item][data-value="run-all-code-blocks"]');
    await runAll.waitForExist({ timeout: 5_000 });
    await runAll.click();
    await browser.waitUntil(
      async () =>
        (
          await browser.execute(() =>
            Array.from(document.querySelectorAll(".cm-code-run-tray")).map((t) => t.dataset.status),
          )
        ).join() === "done,done",
      { timeout: 15_000, timeoutMsg: "the two blocks never finished" },
    );
    const outputs = await browser.execute(() =>
      Array.from(document.querySelectorAll(".cm-code-run-output")).map((o) => o.textContent),
    );
    strictEqual(outputs[0], "api.local:8080 staging\n");
    strictEqual(outputs[1], "8081 int API.LOCAL\n");

    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/code-run-vars.png`);
    }
  });
});
