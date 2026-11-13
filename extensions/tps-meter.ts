/**
 * TPS Meter v3 — Tokens Per Second with Sparkline Trend
 *
 * Footer display:
 *   Streaming:  ⠹ ▕███████▋···▏ 47 tps   (smooth, animated, auto-scaled gauge)
 *   Complete:   ▁▄▇▅▂▁▇█▅▃▆▇ 42 tps · μ 39 · p95 61
 *
 * Features:
 *   - Live sub-cell gauge (1/8-cell resolution) that fills as you stream
 *   - Min-max normalized sparkline (▁▂▃▄▅▆▇█) so the trend's shape is readable
 *   - Color-coded by speed (green fast / yellow mid / red slow)
 *   - Animated spinner during streaming
 *   - Rolling 60s window for avg, all-time for μ, last 500 samples for p95
 *
 * Accuracy:
 *   - Uses the provider's real output token count (message.usage.output);
 *     bitwise char/4 estimate is only a fallback for providers without usage
 *   - Rate is measured from the first token to the last token, excluding TTFT
 *     and finalization delay. The first chunk's tokens are excluded with a
 *     proportional char/4 correction; when the provider reports exact usage,
 *     the corrected rate is an estimate.
 *   - Single-chunk and no-delta responses are not sampled because they have no
 *     measurable generation interval.
 *
 * Optimizations:
 *   - Fixed-size circular buffers for p95 and sparkline; the 60s window is
 *     time-pruned (no allocations in the streaming repaint path)
 *   - Memoized sparkline (rebuilt once per message, not every tick)
 *   - Single shared 200ms timer, torn down and live status finalized on
 *     message_end and agent_end
 *   - Insertion sort for p95 (cold path, ≤500 elements)
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

// --- Config ---
const WINDOW_MS = 60_000;
const STREAM_INTERVAL_MS = 200;
const SPARK_LEN = 12;
const ALLTIME_CAP = 500;
const FAST = 50;
const MED = 20;

// --- Sparkline chars (8 vertical levels) ---
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

// --- Horizontal partial blocks for the live gauge (1/8th-cell resolution) ---
// index = eighths of a cell that are filled (0 = empty .. 7 = ▉); 8 = full "█"
const HBLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const GAUGE_LEN = 11; // gauge width in cells
const GAUGE_FLOOR = 40; // tps that reads as a "full-ish" bar before we have history
const TRACK = "·"; // faint empty-track glyph (less janky than blank space)

// --- State ---
let streamStartMs = 0;
let firstTokenMs: number | null = null; // when the first delta arrived (excludes TTFT from rate)
let lastTokenMs: number | null = null; // when the last delta arrived (excludes finalization delay)
let firstChunkChars = 0; // characters in the first delta (generated during TTFT)
let streamChars = 0;
let streamTokens = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let streaming = false;

// Rolling window (time-pruned samples)
type WindowSample = { tps: number; ms: number };
const winSamples: WindowSample[] = [];

// All-time stats: lifetime sum/count for μ, ring buffer for p95
const atBuf = new Float64Array(ALLTIME_CAP);
let atLen = 0;
let atHead = 0;
let atTotalSum = 0;
let atTotalCount = 0;

// Sparkline history (ring buffer of TPS values, last N messages)
const sparkBuf = new Float64Array(SPARK_LEN);
let sparkLen = 0;
let sparkHead = 0;
let sparkMax = 1; // track max for normalization
let sparkCache = ""; // memoized rendered sparkline (only changes once per message)
let sparkDirty = true;
let sparkThemeKey = ""; // invalidate cache if the theme changes mid-session

// --- Helpers ---

function now(): number {
  // performance.now() is monotonic, so wall-clock corrections cannot make a
  // stream duration negative or corrupt the rolling-window ordering.
  return performance.now();
}

function tokEst(ch: number): number {
  return (ch >>> 2) + ((ch & 3) > 0 ? 1 : 0);
}

function postFirstChunkTokens(totalTokens: number): number {
  if (streamChars <= 0) return 0;
  // Use raw character counts here so rounding cannot erase a short second
  // chunk (for example, 1 char followed by 3 chars).
  const afterFirst = Math.max(0, streamChars - firstChunkChars);
  // Scale the post-first-chunk estimate to the authoritative total. This keeps
  // exact usage and the char/4 first-chunk estimate on a compatible basis.
  return totalTokens * (afterFirst / streamChars);
}

function winPush(tps: number, ms: number): void {
  winSamples.push({ tps, ms });
  pruneWindow(ms);
}

function pruneWindow(nowMs: number): void {
  const cutoff = nowMs - WINDOW_MS;
  let drop = 0;
  while (drop < winSamples.length && winSamples[drop].ms < cutoff) drop++;
  if (drop > 0) winSamples.splice(0, drop);
}

function winAvg(): number {
  pruneWindow(now());
  if (winSamples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < winSamples.length; i++) sum += winSamples[i].tps;
  return sum / winSamples.length;
}

function atPush(tps: number): void {
  atTotalSum += tps;
  atTotalCount++;
  atBuf[atHead] = tps;
  atHead = (atHead + 1) % ALLTIME_CAP;
  if (atLen < ALLTIME_CAP) atLen++;
}

function atMean(): number {
  return atTotalCount === 0 ? 0 : atTotalSum / atTotalCount;
}

function atP95(): number {
  if (atLen === 0) return 0;
  const tmp = new Float64Array(atLen);
  const oldest = atLen < ALLTIME_CAP ? 0 : atHead;
  for (let i = 0; i < atLen; i++) tmp[i] = atBuf[(oldest + i) % ALLTIME_CAP];
  // Insertion sort
  for (let i = 1; i < tmp.length; i++) {
    const v = tmp[i];
    let j = i - 1;
    while (j >= 0 && tmp[j] > v) {
      tmp[j + 1] = tmp[j];
      j--;
    }
    tmp[j + 1] = v;
  }
  return tmp[Math.ceil(tmp.length * 0.95) - 1] || 0;
}

function sparkPush(tps: number): void {
  sparkBuf[sparkHead] = tps;
  sparkHead = (sparkHead + 1) % SPARK_LEN;
  if (sparkLen < SPARK_LEN) sparkLen++;
  if (tps > sparkMax) sparkMax = tps;
  // Decay max slowly so sparkline adapts
  if (sparkMax > 10) sparkMax *= 0.99;
  sparkDirty = true;
}

function fmt(v: number): string {
  if (v < 10) return v.toFixed(1);
  if (v < 100) return v.toFixed(0);
  return `${Math.round(v)}`;
}

function fmtValue(v: number): number {
  // Color by the value actually shown, so 49.6 does not display "50" in yellow.
  return v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
}

// --- Sparkline rendering ---

function themeKey(theme: Theme): string {
  // ctx.ui.theme is a stable Proxy, so identity comparison cannot detect a
  // theme switch. Compare the tokens the sparkline actually colors with.
  return `${theme.name ?? ""}:${theme.getFgAnsi("success")}:${theme.getFgAnsi("warning")}:${theme.getFgAnsi("error")}:${theme.getFgAnsi("dim")}`;
}

function sparkline(theme: Theme): string {
  // Sparkline data only changes once per message (sparkPush), so memoize the
  // rendered string instead of re-allocating + recoloring on every 200ms tick.
  // Invalidate if the active theme changed (user switched themes mid-session).
  const key = themeKey(theme);
  if (key !== sparkThemeKey) {
    sparkDirty = true;
    sparkThemeKey = key;
  }
  if (!sparkDirty) return sparkCache;

  if (sparkLen === 0) {
    sparkCache = theme.fg("dim", "▁".repeat(SPARK_LEN));
    sparkDirty = false;
    return sparkCache;
  }

  // Read ring buffer in order (oldest first)
  const vals = new Float64Array(SPARK_LEN);
  const oldest = sparkLen < SPARK_LEN ? 0 : sparkHead;
  for (let i = 0; i < sparkLen; i++) {
    vals[i] = sparkBuf[(oldest + i) % SPARK_LEN];
  }

  // Min-max normalize over the window so the trend's *shape* is visible.
  // (Normalizing by max alone squashes 40/42/45 into a flat top — the old jank.)
  let mn = Infinity;
  let mx = 0;
  for (let i = 0; i < sparkLen; i++) {
    const v = vals[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = mx - mn;

  // Pad the left so a partial window is right-aligned (newest at the right edge).
  const pad = SPARK_LEN - sparkLen;
  let result = pad > 0 ? theme.fg("dim", TRACK.repeat(pad)) : "";

  for (let i = 0; i < sparkLen; i++) {
    const v = vals[i];
    // Flat series -> mid-height bar; otherwise spread across the full 0..7 range.
    let norm: number;
    if (range < 1e-6) {
      norm = mx > 0 ? 4 : 0;
    } else {
      norm = Math.min(7, Math.max(0, Math.round(((v - mn) / range) * 7)));
    }
    const ch = BLOCKS[norm];

    // Color each bar by absolute speed (green fast / yellow mid / red slow).
    const shown = fmtValue(v);
    let colored: string;
    if (shown >= FAST) colored = theme.fg("success", ch);
    else if (shown >= MED) colored = theme.fg("warning", ch);
    else colored = theme.fg("error", ch);

    result += colored;
  }
  sparkCache = result;
  sparkDirty = false;
  return result;
}

// --- Live gauge (smooth sub-cell horizontal bar) ---

function gauge(tps: number, theme: Theme): string {
  // Auto-scale to the session peak with a sane floor, so the bar is stable
  // (no wild rescaling) yet still meaningful across slow and fast models.
  const scale = Math.max(sparkMax, GAUGE_FLOOR);
  let frac = scale > 0 ? tps / scale : 0;
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;

  const eighths = Math.round(frac * GAUGE_LEN * 8);
  const full = (eighths / 8) | 0;
  const rem = eighths % 8;

  let fill = "█".repeat(full);
  let used = full;
  if (full < GAUGE_LEN && rem > 0) {
    fill += HBLOCKS[rem];
    used++;
  }
  const track = TRACK.repeat(GAUGE_LEN - used);

  return (
    theme.fg("dim", "▕") +
    speedColor(fmtValue(tps), fill, theme) +
    theme.fg("dim", track + "▏")
  );
}

// --- Spinner ---

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinI = 0;
function spin(): string {
  const s = SPIN[spinI];
  spinI = (spinI + 1) % SPIN.length;
  return s;
}

function speedColor(tps: number, text: string, theme: Theme): string {
  if (tps >= FAST) return theme.fg("success", text);
  if (tps >= MED) return theme.fg("warning", text);
  return theme.fg("error", text);
}

// --- Rendering ---

function renderLive(theme: Theme): string {
  // Measure generation rate from the first token, not from message_start, so
  // network/queue latency (TTFT) doesn't drag down the reported speed. Exclude
  // the first chunk for the same reason as the final rate.
  const ref = firstTokenMs ?? streamStartMs;
  const elapsed = (now() - ref) / 1000;
  const measuredTokens = postFirstChunkTokens(streamTokens);
  const tps = elapsed > 0.3 ? measuredTokens / elapsed : 0;

  // Live, animated, sub-cell gauge that fills as generation speeds up — this is
  // the moving "graph" during streaming (the historical sparkline is static).
  const s = theme.fg("accent", spin());
  const g = gauge(tps, theme);
  const num = speedColor(fmtValue(tps), `${fmt(tps)}`, theme);
  const unit = theme.fg("dim", "tps");
  return `${s} ${g} ${num} ${unit}`;
}

function renderFinal(theme: Theme): string {
  const avg = winAvg();
  const mu = atMean();
  const p95 = atP95();
  if (avg === 0 && mu === 0) return "";

  const sep = theme.fg("dim", "·");
  const m = `${theme.fg("dim", "μ")} ${speedColor(fmtValue(mu), fmt(mu), theme)}`;
  const p = `${theme.fg("dim", "p95")} ${speedColor(fmtValue(p95), fmt(p95), theme)}`;
  const sp = sparkline(theme);

  // Once the 60s window expires, drop the stale average rather than showing
  // an old number as if it were current. The sparkline and lifetime stats
  // remain useful.
  if (avg === 0) return `${sp} ${m} ${sep} ${p}`;

  const a = speedColor(fmtValue(avg), fmt(avg), theme);
  const label = theme.fg("dim", "tps");

  return `${sp} ${a} ${label} ${sep} ${m} ${sep} ${p}`;
}

// --- Single shared timer ---

function startTick(ctx: ExtensionContext): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (!streaming) {
      stopTick();
      return;
    }
    // Read the theme on every tick so a mid-stream theme switch is reflected.
    ctx.ui.setStatus("tps", renderLive(ctx.ui.theme));
  }, STREAM_INTERVAL_MS);
}

function stopTick(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleRefresh(ctx: ExtensionContext): void {
  clearIdleTimer();
  if (winSamples.length === 0) return;
  // Refresh when the oldest retained sample expires, then reschedule for the
  // next one. This keeps the rolling average accurate while the session idles.
  const delay = Math.max(0, winSamples[0].ms + WINDOW_MS + 1 - now());
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (streaming) return;
    pruneWindow(now());
    const txt = renderFinal(ctx.ui.theme);
    ctx.ui.setStatus("tps", txt || undefined);
    if (winSamples.length > 0) scheduleIdleRefresh(ctx);
  }, delay);
}

function finishStream(ctx: ExtensionContext): void {
  streaming = false;
  stopTick();
  const txt = renderFinal(ctx.ui.theme);
  ctx.ui.setStatus("tps", txt || undefined);
  scheduleIdleRefresh(ctx);
}

// ============================
// Extension
// ============================

export default function tpsMeter(pi: ExtensionAPI): void {

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    clearIdleTimer();
    streamStartMs = now();
    firstTokenMs = null;
    lastTokenMs = null;
    firstChunkChars = 0;
    streamChars = 0;
    streamTokens = 0;
    streaming = true;
    spinI = 0;
    startTick(ctx);
  });

  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;
    if (!event.assistantMessageEvent) return;
    const evt = event.assistantMessageEvent;
    // Count tool-call argument generation too: writing long files / commands
    // streams their content as `toolcall_delta` tokens, which otherwise look
    // like 0 TPS. text/thinking already count; toolcall was the missing branch.
    if (evt.type === "text_delta" || evt.type === "thinking_delta" || evt.type === "toolcall_delta") {
      const d = evt.delta;
      if (!d) return;
      const t = now();
      if (firstTokenMs === null) {
        firstTokenMs = t;
        // Tokens in the first chunk were generated during TTFT, before the
        // first token arrived. Exclude them from the measured interval.
        firstChunkChars = d.length;
      } else if (t === firstTokenMs) {
        // A buffered provider can emit several chunks at the same timestamp;
        // they were all generated before the measured interval starts.
        firstChunkChars += d.length;
      }
      lastTokenMs = t;
      streamChars += d.length;
      streamTokens = tokEst(streamChars);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    streaming = false;
    stopTick();

    // Aborted/errored responses are not valid throughput samples.
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
      finishStream(ctx);
      return;
    }

    // Prefer the provider's real output token count; fall back to the char
    // estimate only when usage is unavailable (e.g. some local providers).
    // A reported zero is authoritative: it is not a missing value.
    const realOut = event.message?.usage?.output;
    const tokens =
      typeof realOut === "number" && Number.isFinite(realOut) ? realOut : streamTokens;

    // Rate is generation-only: from first token to last token, excluding TTFT
    // and finalization delay. Without a first/last delta there is no measurable
    // generation interval, so skip the sample instead of using message start/end.
    if (firstTokenMs === null || lastTokenMs === null) {
      finishStream(ctx);
      return;
    }
    const elapsed = (lastTokenMs - firstTokenMs) / 1000;
    const measuredTokens = postFirstChunkTokens(tokens);

    if (elapsed < 0.1 || measuredTokens <= 0) {
      finishStream(ctx);
      return;
    }

    const tps = measuredTokens / elapsed;

    // Record to all buffers
    winPush(tps, now());
    atPush(tps);
    sparkPush(tps);

    finishStream(ctx);
  });

  // Safety net: if a stream is aborted (Esc/Ctrl-C) or errors, message_end may
  // not fire for that message — agent_end always does. Finalize the footer so
  // an aborted stream cannot leave a frozen spinner and live number behind.
  pi.on("agent_end", async (_event, ctx) => {
    if (streaming) {
      finishStream(ctx);
    } else {
      stopTick();
    }
  });

  // Extension disposal: stop both timers so a reload/quit cannot leave a
  // callback holding a stale context or keeping the process alive.
  pi.on("session_shutdown", async () => {
    streaming = false;
    stopTick();
    clearIdleTimer();
  });

  pi.on("session_start", async (_event, ctx) => {
    streaming = false;
    stopTick();
    clearIdleTimer();
    streamStartMs = 0;
    firstTokenMs = null;
    lastTokenMs = null;
    firstChunkChars = 0;
    streamChars = 0;
    streamTokens = 0;
    winSamples.length = 0;
    atLen = 0;
    atHead = 0;
    atTotalSum = 0;
    atTotalCount = 0;
    sparkLen = 0;
    sparkHead = 0;
    sparkMax = 1;
    sparkCache = "";
    sparkDirty = true;
    sparkThemeKey = "";
    spinI = 0;
    ctx.ui.setStatus("tps", undefined);
  });
}
