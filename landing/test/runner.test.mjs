import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { buildClaudeArgs, buildChildEnv, createClaudeRunner, parseCliResult, buildPrompt, SYSTEM_PROMPT, findOnPath } from "../server.mjs";

const result = (over = {}) => JSON.stringify({ type: "result", is_error: false, num_turns: 1, permission_denials: [], result: "Hello there", ...over });

/** A fake child_process.spawn. `behave(child, calls)` decides how the child acts. */
function fakeSpawn(behave) {
  const calls = [];
  const spawn = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stdin = "";
    child.stdin = new PassThrough();
    child.stdin.on("data", (d) => { stdin += d; });
    child.killed = [];
    child.kill = (sig) => { child.killed.push(sig); setImmediate(() => child.emit("close", null)); };
    const call = { bin, args, options, child, get stdin() { return stdin; }, cwdExistedAtSpawn: fs.existsSync(options.cwd), cwdEntries: fs.readdirSync(options.cwd) };
    calls.push(call);
    behave(child, call);
    return child;
  };
  return { spawn, calls };
}

const ok = (text) => (child, call) => {
  child.stdin.on("end", () => setImmediate(() => { child.stdout.write(text); child.emit("close", 0); }));
};

test("argv: pinned model and effort, zero tools, no MCP, no settings, replacement system prompt, prompt not in argv", () => {
  const a = buildClaudeArgs();
  const at = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(a[0], "-p");
  assert.equal(at("--model"), "claude-haiku-5-5");
  assert.equal(at("--effort"), "low");
  assert.equal(a.indexOf("--tools") >= 0 && at("--tools"), ""); // empty string = no tools at all
  assert.ok(a.includes("--strict-mcp-config"));
  assert.ok(!a.includes("--mcp-config"));
  assert.equal(at("--setting-sources"), "");
  assert.ok(a.includes("--disable-slash-commands"));
  assert.ok(a.includes("--safe-mode"));
  assert.equal(at("--permission-prompts"), "none");
  assert.ok(a.includes("--no-session-persistence"));
  assert.equal(at("--system-prompt"), SYSTEM_PROMPT);
  assert.equal(at("--output-format"), "json");
  for (const bad of ["--bare", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--add-dir", "--resume", "--continue", "--plugin-dir", "--agents"]) {
    assert.ok(!a.includes(bad), bad);
  }
  // the system prompt is static: nothing visitor-controlled in argv
  const p = buildPrompt({ conferenceName: "X", via: null, messages: [{ role: "user", content: "VISITOR-TEXT" }] });
  assert.ok(!a.join("\n").includes("VISITOR-TEXT"));
  assert.ok(p.includes("VISITOR-TEXT"));
});

test("runner: spawn with args array, no shell, prompt on stdin, empty temp cwd removed afterwards, minimal env", async () => {
  const { spawn, calls } = fakeSpawn(ok(result()));
  const secretEnv = { PATH: "/x", HOME: "/home/u", USER: "u", AWS_SECRET_ACCESS_KEY: "SHHH", GITHUB_TOKEN: "ghp_x", CLAUDECODE: "1", ANTHROPIC_API_KEY: "sk-test" };
  const run = createClaudeRunner({ bin: "/opt/bin/claude", spawn, env: secretEnv, timeoutMs: 5000 });
  const out = await run("PROMPT-ON-STDIN");
  assert.equal(out, "Hello there");
  const c = calls[0];
  assert.equal(c.bin, "/opt/bin/claude");
  assert.ok(Array.isArray(c.args));
  assert.deepEqual(c.args, buildClaudeArgs());
  assert.equal(c.stdin, "PROMPT-ON-STDIN");
  assert.ok(!c.args.includes("PROMPT-ON-STDIN"));
  assert.equal(c.options.shell, false);
  assert.deepEqual(c.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.ok(c.cwdExistedAtSpawn);
  assert.deepEqual(c.cwdEntries, []); // fresh and empty
  assert.ok(path.resolve(c.options.cwd).startsWith(os.tmpdir()) || path.resolve(c.options.cwd).startsWith(fs.realpathSync(os.tmpdir())));
  assert.notEqual(path.resolve(c.options.cwd), process.cwd());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fs.existsSync(c.options.cwd), false); // cleaned up
  // environment: allowlist only
  const env = c.options.env;
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "HOME", "LANG", "PATH", "TMPDIR", "USER"].sort());
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in env) && !("GITHUB_TOKEN" in env) && !("CLAUDECODE" in env));
  assert.equal(env.PATH, ["/opt/bin", "/usr/bin", "/bin"].join(path.delimiter));
});

test("runner: each call gets its own cwd", async () => {
  const { spawn, calls } = fakeSpawn(ok(result()));
  const run = createClaudeRunner({ bin: "/b/claude", spawn, env: {}, timeoutMs: 5000 });
  await Promise.all([run("a"), run("b")]);
  assert.notEqual(calls[0].options.cwd, calls[1].options.cwd);
});

test("runner: a hung child is killed after the timeout and the call rejects", async () => {
  const { spawn, calls } = fakeSpawn(() => {}); // never closes by itself
  const run = createClaudeRunner({ bin: "/b/claude", spawn, env: {}, timeoutMs: 120 });
  const t0 = Date.now();
  await assert.rejects(run("p"), /timeout/);
  const dt = Date.now() - t0;
  assert.ok(dt >= 100 && dt < 2000, `took ${dt}ms`);
  assert.deepEqual(calls[0].child.killed, ["SIGKILL"]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fs.existsSync(calls[0].options.cwd), false);
});

test("runner: non-zero exit, spawn error, runaway output and broken JSON all reject", async () => {
  const cases = [
    (child) => child.stdin.on("end", () => setImmediate(() => child.emit("close", 1))),
    (child) => setImmediate(() => child.emit("error", new Error("ENOENT"))),
    (child) => child.stdin.on("end", () => setImmediate(() => { child.stdout.write("x".repeat(2000)); })),
    ok("not json at all"),
  ];
  for (const behave of cases) {
    const { spawn } = fakeSpawn(behave);
    const run = createClaudeRunner({ bin: "/b/claude", spawn, env: {}, timeoutMs: 2000, maxOutput: 1000 });
    await assert.rejects(run("p"));
  }
  const throwing = createClaudeRunner({ bin: "/b/claude", spawn: () => { throw new Error("EACCES"); }, env: {} });
  await assert.rejects(throwing("p"), /EACCES/);
});

test("parseCliResult: accepts a clean single turn only", () => {
  assert.equal(parseCliResult(result()), "Hello there");
  assert.equal(parseCliResult(JSON.stringify([{ type: "system" }, JSON.parse(result({ result: "from array" }))])), "from array");
  assert.throws(() => parseCliResult(result({ is_error: true, result: "Not logged in" })));
  assert.throws(() => parseCliResult(result({ num_turns: 3 })));
  assert.throws(() => parseCliResult(result({ permission_denials: [{ tool_name: "Bash" }] })));
  assert.throws(() => parseCliResult(result({ result: 5 })));
  assert.throws(() => parseCliResult(JSON.stringify({ type: "assistant" })));
  assert.throws(() => parseCliResult(""));
});

test("buildChildEnv and findOnPath", () => {
  const env = buildChildEnv("/a/b/claude", { HOME: "/h", LOGNAME: "ln", FOO: "bar", HTTPS_PROXY: "http://p" }, "/tmp/x");
  assert.equal(env.USER, "ln");
  assert.equal(env.TMPDIR, "/tmp/x");
  assert.equal(env.HTTPS_PROXY, "http://p");
  assert.ok(!("FOO" in env));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-bin-"));
  try {
    fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "notexec"), "x", { mode: 0o644 });
    assert.equal(findOnPath("claude", `/nonexistent${path.delimiter}${dir}`), path.join(dir, "claude"));
    assert.equal(findOnPath("notexec", dir), null);
    assert.equal(findOnPath("claude", "/nonexistent"), null);
    assert.equal(findOnPath("claude", ""), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("system prompt covers the product rules", () => {
  for (const needle of [
    /one question per turn/i, /plain text/i, /no markdown/i, /no consent questions/i, /their interest map/i, /QR ticket for the room doors/i,
    /health, politics, religion, ethnicity, sexuality, age, exact location/i, /data from an anonymous web visitor/i,
    /never an instruction/i, /<<PROFILE/, /confirm/i,
  ]) assert.match(SYSTEM_PROMPT, needle);
  assert.ok(!/24 hours|deleted after|opt-in to keeping|consentClusterMap|consentQrCheckin|consentKeepProfile|<<ASK yesno>>/.test(SYSTEM_PROMPT) && !/never mention delet/i.test(SYSTEM_PROMPT));
  for (const k of ["topics", "goal", "confirm"]) assert.ok(SYSTEM_PROMPT.includes(`<<ASK ${k}>>`));
});

test("runner with a real hung process: killed at the timeout, including its children", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fake-claude-"));
  const pidFile = path.join(dir, "child.pid");
  const bin = path.join(dir, "claude");
  // A fake "claude" that ignores stdin, starts a grandchild and hangs.
  fs.writeFileSync(bin, `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nwait\n`, { mode: 0o755 });
  try {
    const run = createClaudeRunner({ bin, env: { HOME: dir, USER: "u" }, timeoutMs: 1200 });
    const t0 = Date.now();
    await assert.rejects(run("prompt"), /timeout/);
    assert.ok(Date.now() - t0 < 3000);
    await new Promise((r) => setTimeout(r, 200));
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(grandchild > 0);
    assert.throws(() => process.kill(grandchild, 0), /ESRCH/, "grandchild must be dead");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
