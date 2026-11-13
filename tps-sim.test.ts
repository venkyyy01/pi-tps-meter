/**
 * Offline simulation harness for the TPS meter extension.
 *
 * Drives the extension through pi's real event sequence with a mocked
 * ExtensionAPI + ctx, controllable clock, and instrumented timers — so we can
 * assert the token math, TTFT handling, real-usage-vs-fallback, abort cleanup,
 * retention semantics, theme changes, and sparkline memoization deterministically
 * without a network call.
 *
 * Run: node tps-sim.test.ts   (Node 23+ strips the type-only import)
 */
import tpsMeter from "./extensions/tps-meter.ts";

declare const process: { exit(code?: number): never };

// --- controllable monotonic clock ---
let T = 0;
const realNow = performance.now;
performance.now = () => T;

// --- instrumented timers (no real timers; count active) ---
let activeTimers = 0;
let lastIntervalCb: (() => void) | null = null;
let idleCb: (() => void) | null = null;
// @ts-ignore - override globals for the test
globalThis.setInterval = ((cb: () => void) => {
  activeTimers++;
  lastIntervalCb = cb;
  return { id: activeTimers } as any;
}) as any;
// @ts-ignore
globalThis.clearInterval = ((_h: any) => {
  if (activeTimers > 0) activeTimers--;
  lastIntervalCb = null;
}) as any;
// @ts-ignore
globalThis.setTimeout = ((cb: () => void) => {
  idleCb = cb;
  return { id: 1 } as any;
}) as any;
// @ts-ignore
globalThis.clearTimeout = ((_h: any) => {
  idleCb = null;
}) as any;

// --- mock pi + ctx ---
type Handler = (event: any, ctx: any) => any;
const handlers = new Map<string, Handler>();
const statuses: Record<string, string | undefined> = {};
const pi = { on: (name: string, h: Handler) => handlers.set(name, h) } as any;

// The theme object is stable (like pi's Theme proxy); its name/tokens change
// when the user switches themes. This proves both live and cached rendering
// follow the current theme.
let themeName = "A";
const colors: string[] = [];
const theme = {
  get name() {
    return themeName;
  },
  fg: (c: string, s: string) => {
    colors.push(c);
    return `[${themeName}]${s}`;
  },
  getFgAnsi: (c: string) => `[${themeName}:${c}]`,
};
const ctx = {
  ui: {
    theme,
    setStatus: (k: string, v: string | undefined) => {
      statuses[k] = v;
    },
  },
} as any;

const fire = (name: string, event: any) => handlers.get(name)?.(event, ctx);
const asst = (extra: any = {}) => ({ message: { role: "assistant", ...extra } });
const tick = () => lastIntervalCb?.();
const fireIdle = () => {
  const cb = idleCb;
  idleCb = null;
  cb?.();
};

// --- tiny assert ---
let failures = 0;
function ok(cond: boolean, label: string, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${tag}] ${label}${detail ? `  — ${detail}` : ""}`);
}
function approx(a: number, b: number, eps = 0.01) {
  return Math.abs(a - b) <= eps;
}
function plainStatus(): string {
  return (statuses["tps"] ?? "").replace(/\[[A-Z]\]/g, "");
}
function num(s: string | undefined): number {
  const m = (s ?? "").replace(/\[[A-Z]\]/g, "").match(/-?\d+(\.\d+)?/g);
  return m ? Number(m[0]) : NaN;
}
function stat(label: string): number {
  const m = plainStatus().match(new RegExp(`${label}\\s+(-?\\d+(?:\\.\\d+)?)`));
  return m ? Number(m[1]) : NaN;
}
function reset(): void {
  fire("session_start", {});
  themeName = "A";
  colors.length = 0;
}

tpsMeter(pi);

// ============================================================
// Test 1: real usage.output, TTFT excluded, first chunk excluded
// ============================================================
reset();
T = 1000;
fire("message_start", asst());
ok(activeTimers === 1, "timer started on message_start", `active=${activeTimers}`);

T = 1300; // 300ms TTFT; first chunk = 40 chars ≈ 10 tokens
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 2300; // 1.0s of generation after the first chunk
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
// 50 real output tokens; the first chunk is 50% of the estimated total, so
// the proportional correction measures 25 tokens over 1.0s.
fire("message_end", asst({ usage: { output: 50 } }));
ok(activeTimers === 0, "timer cleared on message_end", `active=${activeTimers}`);
{
  const v = num(statuses["tps"]);
  ok(approx(v, 25), "proportional first-chunk correction + TTFT-excluded rate = 25 tps", `got ${v} (${statuses["tps"]})`);
  ok(approx(stat("μ"), 25), "μ records the same rate", `got ${stat("μ")}`);
  ok(approx(stat("p95"), 25), "p95 records the same rate", `got ${stat("p95")}`);
}

// ============================================================
// Test 2: agent_end after a normal message_end preserves final stats
// ============================================================
fire("agent_end", {});
ok(approx(num(statuses["tps"]), 25), "agent_end after message_end preserves final stats", `got ${num(statuses["tps"])}`);

// ============================================================
// Test 3: fallback to char estimate when usage is absent
// chars = 800 -> tokEst = 200; first chunk = 100; elapsed = 1.0s -> 100 tps
// ============================================================
reset();
T = 5000;
fire("message_start", asst());
T = 5000; // first token immediately
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "y".repeat(400) },
});
T = 6000;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "y".repeat(400) },
});
T = 7000; // 1.0s later
fire("message_end", asst()); // no usage field
{
  const v = num(statuses["tps"]);
  ok(approx(v, 100), "char/4 fallback when usage missing = 100 tps", `got ${v} (${statuses["tps"]})`);
}

// ============================================================
// Test 4: abort with no history clears the live status
// ============================================================
reset();
T = 9000;
fire("message_start", asst());
ok(activeTimers === 1, "timer running mid-stream", `active=${activeTimers}`);
T = 9100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 9400;
tick();
ok((statuses["tps"] ?? "").includes("tps"), "live tick renders a status", `status=${statuses["tps"]}`);
fire("agent_end", {});
ok(activeTimers === 0, "agent_end stops runaway timer on abort", `active=${activeTimers}`);
ok(statuses["tps"] === undefined, "abort clears live status when no history", `status=${statuses["tps"]}`);

// ============================================================
// Test 5: abort with history restores the final stats
// ============================================================
reset();
T = 10000;
fire("message_start", asst());
T = 10100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 11100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 } }));
ok(approx(num(statuses["tps"]), 25), "setup: one completed message", `got ${num(statuses["tps"])}`);
fire("agent_end", {});

T = 12000;
fire("message_start", asst());
T = 12100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 12400;
tick();
ok((statuses["tps"] ?? "").includes("tps"), "setup: live status before abort", `status=${statuses["tps"]}`);
fire("agent_end", {});
ok((statuses["tps"] ?? "").includes("μ"), "abort restores final stats when history exists", `status=${statuses["tps"]}`);
ok(!(statuses["tps"] ?? "").includes("⠋"), "abort does not leave a spinner", `status=${statuses["tps"]}`);

// ============================================================
// Test 6: zero-token message with no deltas clears the live status
// ============================================================
reset();
T = 13000;
fire("message_start", asst());
T = 13100;
tick();
ok((statuses["tps"] ?? "").includes("tps"), "setup: live status before zero-token end", `status=${statuses["tps"]}`);
T = 13200;
fire("message_end", asst({ usage: { output: 0 } }));
ok(activeTimers === 0, "timer cleared on zero-token message_end", `active=${activeTimers}`);
ok(statuses["tps"] === undefined, "zero-token message clears live status", `status=${statuses["tps"]}`);

// ============================================================
// Test 7: zero usage with deltas must not fall back to the estimate
// ============================================================
reset();
T = 14000;
fire("message_start", asst());
T = 14100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 15100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
tick();
fire("message_end", asst({ usage: { output: 0 } }));
ok(statuses["tps"] === undefined, "zero usage with deltas records no sample", `status=${statuses["tps"]}`);

// ============================================================
// Test 8: single-chunk response is unmeasurable, even with a long tail
// ============================================================
reset();
T = 15000;
fire("message_start", asst());
T = 16000;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
});
T = 16100;
fire("message_end", asst({ usage: { output: 100 } }));
ok(statuses["tps"] === undefined, "single-chunk response produces no sample", `status=${statuses["tps"]}`);

// ============================================================
// Test 9: thinking and toolcall deltas count toward TPS
// ============================================================
reset();
T = 17000;
fire("message_start", asst());
T = 17100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(40) },
});
T = 18100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "toolcall_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 } }));
{
  const v = num(statuses["tps"]);
  ok(approx(v, 25), "thinking + toolcall deltas count toward TPS", `got ${v} (${statuses["tps"]})`);
}

// ============================================================
// Test 10: proportional first-chunk correction with exact usage
// 40 + 40 chars = 20 estimated tokens; first chunk = 10 estimated (50%).
// Exact total = 5 tokens -> 2.5 measured over 1.0s -> 2.5 tps.
// ============================================================
reset();
T = 18200;
fire("message_start", asst());
T = 18300;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 19300;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 5 } }));
{
  const v = num(statuses["tps"]);
  ok(approx(v, 2.5), "proportional first-chunk correction with exact usage = 2.5 tps", `got ${v} (${statuses["tps"]})`);
}

// ============================================================
// Test 11: the 60s window retains more than 60 completions
// 61 completions over 30.5s; rates 2, 4, ..., 122 -> avg 62
// ============================================================
reset();
for (let i = 0; i < 61; i++) {
  const start = 20000 + i * 500;
  T = start;
  fire("message_start", asst());
  T = start;
  fire("message_update", {
    ...asst(),
    assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4) },
  });
  T = start + 500;
  fire("message_update", {
    ...asst(),
    assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4) },
  });
  fire("message_end", asst({ usage: { output: 2 * (i + 1) } }));
}
{
  const v = num(statuses["tps"]);
  ok(approx(v, 62), "60s window retains all 61 completions", `got ${v} (${statuses["tps"]})`);
}

// ============================================================
// Test 12: samples older than 60s leave the window
// ============================================================
T += 61000;
{
  const start = T;
  fire("message_start", asst());
  T = start;
  fire("message_update", {
    ...asst(),
    assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4) },
  });
  T = start + 500;
  fire("message_update", {
    ...asst(),
    assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4) },
  });
  fire("message_end", asst({ usage: { output: 202 } }));
}
{
  const v = num(statuses["tps"]);
  ok(approx(v, 202), "expired samples leave the 60s window", `got ${v} (${statuses["tps"]})`);
}

// ============================================================
// Test 13: μ is lifetime; p95 is bounded to the last 500 samples
// First 100 samples 1000 tps, next 500 samples 10 tps.
// Lifetime μ = (100000 + 5000) / 600 = 175.
// Last-500 p95 = 10 (a lifetime p95 would be 1000).
// ============================================================
reset();
for (let i = 0; i < 600; i++) {
  const high = i < 100;
  const start = 200000 + i * 200;
  T = start;
  fire("message_start", asst());
  T = start;
  fire("message_update", {
    ...asst(),
    assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4) },
  });
  T = start + 200;
  fire("message_update", {
    ...asst(),
    assistantMessageEvent: {
      type: "text_delta",
      delta: "x".repeat(high ? 796 : 4),
    },
  });
  fire("message_end", asst({ usage: { output: high ? 201 : 4 } }));
}
{
  const mu = stat("μ");
  const p95 = stat("p95");
  ok(approx(mu, 175, 1), "μ is the lifetime mean across 600 samples", `got ${mu}`);
  ok(approx(p95, 10), "p95 is bounded to the last 500 samples", `got ${p95}`);
}

// ============================================================
// Test 14: the live timer follows a theme switch
// ============================================================
reset();
themeName = "A";
T = 300000;
fire("message_start", asst());
T = 300100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 300400;
tick();
ok((statuses["tps"] ?? "").includes("[A]"), "live status uses theme A", `status=${statuses["tps"]}`);
themeName = "B";
T = 300600;
tick();
ok((statuses["tps"] ?? "").includes("[B]"), "live status follows a theme switch", `status=${statuses["tps"]}`);
fire("agent_end", {});

// ============================================================
// Test 15: sparkline memoization — no work between message ends
// ============================================================
reset();
// feed a few completed messages so sparkline has data, then tick repeatedly
for (let i = 0; i < 3; i++) {
  const start = 310000 + i * 2000;
  T = start;
  fire("message_start", asst());
  T = start;
  fire("message_update", {
    ...asst(),
    assistantMessageEvent: { type: "text_delta", delta: "z".repeat(40) },
  });
  T = start + 1000;
  fire("message_update", {
    ...asst(),
    assistantMessageEvent: { type: "text_delta", delta: "z".repeat(200) },
  });
  fire("message_end", asst({ usage: { output: 30 + i * 20 } }));
}
// Start a new stream and tick the live timer many times; sparkline is static
T = 320000;
fire("message_start", asst());
T = 320100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "z".repeat(40) },
});
// `as any` defeats TS narrowing: the reassignments happen inside the
// setInterval override closure, which control-flow analysis can't see.
const liveCb: (() => void) | null = lastIntervalCb as any;
let crashed = false;
try {
  for (let i = 0; i < 50; i++) {
    T += 200;
    liveCb?.();
  }
} catch (e) {
  crashed = true;
  console.log("tick error:", (e as Error).message);
}
ok(!crashed && typeof statuses["tps"] === "string", "live ticks render without crashing", `status=${statuses["tps"]}`);
fire("agent_end", {});

// ============================================================
// Test 16: session_start resets stats and status
// ============================================================
reset();
T = 330000;
fire("message_start", asst());
T = 330100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 331100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 } }));
ok(approx(num(statuses["tps"]), 25), "setup: sample before reset", `got ${num(statuses["tps"])}`);

fire("session_start", {});
ok(statuses["tps"] === undefined, "session_start clears status", `status=${statuses["tps"]}`);

T = 340000;
fire("message_start", asst());
T = 340100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 341100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 } }));
ok(approx(stat("μ"), 25), "session_start resets μ", `got ${stat("μ")}`);
ok(approx(num(statuses["tps"]), 25), "session_start resets rolling avg", `got ${num(statuses["tps"])}`);

// ============================================================
// Test 17: missing usage with no deltas produces no sample
// ============================================================
reset();
T = 350000;
fire("message_start", asst());
T = 350200;
fire("message_end", asst());
ok(statuses["tps"] === undefined, "missing usage with no deltas produces no sample", `status=${statuses["tps"]}`);

// ============================================================
// Test 18: positive usage without deltas produces no sample
// ============================================================
reset();
T = 355000;
fire("message_start", asst());
T = 355200;
fire("message_end", asst({ usage: { output: 100 } }));
ok(statuses["tps"] === undefined, "positive usage without deltas produces no sample", `status=${statuses["tps"]}`);

// ============================================================
// Test 19: idle refresh drops the expired rolling average
// ============================================================
reset();
T = 360000;
fire("message_start", asst());
T = 360100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 361100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 } }));
ok(approx(num(statuses["tps"]), 25), "setup: sample before idle refresh", `got ${num(statuses["tps"])}`);
ok(idleCb !== null, "idle refresh scheduled after completion");

T += 61000;
fireIdle();
ok((statuses["tps"] ?? "").includes("μ"), "idle refresh keeps lifetime stats", `status=${statuses["tps"]}`);
ok(!(statuses["tps"] ?? "").includes("tps"), "idle refresh drops the expired rolling avg", `status=${statuses["tps"]}`);
ok(approx(stat("μ"), 25), "idle refresh preserves μ", `got ${stat("μ")}`);

// ============================================================
// Test 20: a new message_start cancels the idle refresh
// ============================================================
reset();
T = 430000;
fire("message_start", asst());
T = 430100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 431100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 } }));
ok(idleCb !== null, "setup: idle refresh scheduled");
T = 432000;
fire("message_start", asst());
ok(idleCb === null, "new message_start cancels the idle refresh");
fire("agent_end", {});

// ============================================================
// Test 21: raw character fraction preserves short multi-chunk responses
// 1 char + 3 chars = 4 chars; first chunk = 25%, so 4 exact tokens -> 3.
// ============================================================
reset();
T = 450000;
fire("message_start", asst());
T = 450100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x" },
});
T = 451100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "xxx" },
});
fire("message_end", asst({ usage: { output: 4 } }));
{
  const v = num(statuses["tps"]);
  ok(approx(v, 3), "raw char fraction preserves short multi-chunk responses", `got ${v} (${statuses["tps"]})`);
}

// ============================================================
// Test 22: session_shutdown stops a live interval
// ============================================================
reset();
T = 460000;
fire("message_start", asst());
T = 460100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
ok(activeTimers === 1, "setup: interval running before shutdown", `active=${activeTimers}`);
fire("session_shutdown", {});
ok(activeTimers === 0, "session_shutdown stops the interval", `active=${activeTimers}`);

// ============================================================
// Test 23: session_shutdown clears a pending idle refresh
// ============================================================
reset();
T = 470000;
fire("message_start", asst());
T = 470100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 471100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 } }));
ok(idleCb !== null, "setup: idle refresh pending before shutdown");
fire("session_shutdown", {});
ok(idleCb === null, "session_shutdown clears the idle refresh");

// ============================================================
// Test 24: aborted message_end does not record a sample
// ============================================================
reset();
T = 480000;
fire("message_start", asst());
T = 480100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 481100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 }, stopReason: "aborted" }));
fire("agent_end", {});
ok(statuses["tps"] === undefined, "aborted message_end does not record a sample", `status=${statuses["tps"]}`);

// ============================================================
// Test 25: errored message_end does not record a sample
// ============================================================
reset();
T = 485000;
fire("message_start", asst());
T = 485100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 486100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 }, stopReason: "error" }));
fire("agent_end", {});
ok(statuses["tps"] === undefined, "errored message_end does not record a sample", `status=${statuses["tps"]}`);

// ============================================================
// Test 26: same-timestamp deltas are excluded from the interval
// 40 + 40 chars at T, then 40 chars at T+1s.
// streamChars=120, firstChunkChars=80 -> 1/3 after the first timestamp.
// 30 exact tokens * 1/3 = 10 tokens over 1s -> 10 tps.
// ============================================================
reset();
T = 490000;
fire("message_start", asst());
T = 490100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 491100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 30 } }));
{
  const v = num(statuses["tps"]);
  ok(approx(v, 10), "same-timestamp deltas are excluded from the measured interval", `got ${v} (${statuses["tps"]})`);
}

// ============================================================
// Test 27: a first delta at time zero is still measured
// ============================================================
reset();
T = 0;
fire("message_start", asst());
T = 0;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 1000;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 } }));
ok(approx(num(statuses["tps"]), 25), "first delta at time zero is still measured", `got ${num(statuses["tps"])}`);

// ============================================================
// Test 28: elapsed below 100ms produces no sample
// ============================================================
reset();
T = 520000;
fire("message_start", asst());
T = 520100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 520150;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 } }));
ok(statuses["tps"] === undefined, "elapsed below 100ms produces no sample", `status=${statuses["tps"]}`);

// ============================================================
// Test 29: finalization delay is excluded with exact usage
// ============================================================
reset();
T = 530000;
fire("message_start", asst());
T = 530100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 531100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 531600; // 500ms finalization delay
fire("message_end", asst({ usage: { output: 50 } }));
ok(approx(num(statuses["tps"]), 25), "finalization delay is excluded from exact-usage rate", `got ${num(statuses["tps"])}`);

// ============================================================
// Test 30: sparkline cache invalidates on a stable theme proxy
// ============================================================
reset();
T = 540000;
fire("message_start", asst());
T = 540100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 541100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
fire("message_end", asst({ usage: { output: 50 } }));
ok((statuses["tps"] ?? "").includes("[A]"), "setup: sparkline uses theme A", `status=${statuses["tps"]}`);
themeName = "B";
T = 542000;
fire("message_start", asst());
T = 542100;
fire("message_end", asst({ usage: { output: 0 } }));
ok((statuses["tps"] ?? "").includes("[B]"), "sparkline cache renders with theme B", `status=${statuses["tps"]}`);
ok(!(statuses["tps"] ?? "").includes("[A]"), "sparkline cache invalidates on theme change", `status=${statuses["tps"]}`);

// ============================================================
// Test 31: idle refresh expires the oldest sample first
// ============================================================
reset();
T = 550000;
fire("message_start", asst());
T = 550000;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4) },
});
T = 550500;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4) },
});
fire("message_end", asst({ usage: { output: 10 } })); // 10 tps

T = 560000;
fire("message_start", asst());
T = 560000;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4) },
});
T = 560500;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4) },
});
fire("message_end", asst({ usage: { output: 8 } })); // 8 tps

T = 610501; // first sample expires (550500 + 60001)
fireIdle();
ok(approx(num(statuses["tps"]), 8), "idle refresh expires the oldest sample first", `got ${num(statuses["tps"])}`);
T = 620501; // second sample expires (560500 + 60001)
fireIdle();
ok(!(statuses["tps"] ?? "").includes("tps"), "idle refresh drops the avg after the last sample expires", `status=${statuses["tps"]}`);

// ============================================================
// Test 32: color follows the displayed rounded value
// 4 chars + 1 char = 5 chars; first chunk = 80%, so 248 * 0.2 = 49.6.
// 49.6 displays as "50" and must be green, not yellow.
// ============================================================
reset();
T = 570000;
fire("message_start", asst());
T = 570100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4) },
});
T = 571100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x" },
});
fire("message_end", asst({ usage: { output: 248 } }));
ok(approx(num(statuses["tps"]), 50), "setup: 49.6 displays as 50", `got ${num(statuses["tps"])}`);
ok(colors.includes("success"), "49.6 is colored green to match the displayed 50", `colors=${colors.join(",")}`);

// ============================================================
// Test 33: session_start clears p95, the idle refresh, and a live interval
// ============================================================
reset();
T = 580000;
fire("message_start", asst());
T = 580100;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
ok(activeTimers === 1, "setup: interval running before session_start", `active=${activeTimers}`);
fire("session_start", {});
ok(activeTimers === 0, "session_start stops a live interval", `active=${activeTimers}`);
ok(idleCb === null, "session_start clears the idle refresh");
ok(Number.isNaN(stat("p95")), "session_start clears p95");

// --- restore + summary ---
performance.now = realNow;
console.log("\n" + (failures === 0 ? "ALL TESTS PASSED ✅" : `${failures} TEST(S) FAILED ❌`));
process.exit(failures === 0 ? 0 : 1);
