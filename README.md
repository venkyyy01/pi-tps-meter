# pi-tps-meter

Tokens per second meter for [pi CLI](https://pi.dev) with sparkline visualization.

## Install

```bash
pi install npm:pi-tps-meter
```

## Features

**During streaming** — a smooth, animated gauge that fills with live speed
(1/8-cell resolution, auto-scaled to your session's peak):
```
⠹ ▕███████▋···▏ 47 tps
```

**After a message** — a min-max normalized sparkline of your last 12 sampled
messages (newest on the right) plus aggregate stats:
```
▁▄▇▅▂▁▇█▅▃▆▇ 42 tps · μ 39 · p95 61
```

**Color coding:**
- 🟢 Green: 50+ tps (fast)
- 🟡 Yellow: 20-49 tps (medium)
- 🔴 Red: <20 tps (slow)

## Accuracy

- Uses the provider's **real** output token count (`message.usage.output`); the
  char/4 estimate is only a fallback for providers that don't report usage
- Rate is measured from the **first token to the last token**, so
  time-to-first-token (network/queue latency) and finalization delay don't drag
  down the reported tps. The first chunk's tokens are excluded with a
  proportional char/4 correction; when the provider reports exact usage, the
  corrected rate is an estimate. Single-chunk, no-delta, aborted, and errored
  responses are not sampled because they have no valid generation interval.
- Tracks **thinking tokens** (`thinking_delta`) and **tool-call argument tokens**
  (`toolcall_delta`) alongside text, so extended thinking and long tool calls
  report accurate generation speed

## Stats

- **avg**: unweighted mean of per-message TPS in the last 60 seconds
  (time-pruned; dropped from the footer once the window expires, while the
  sparkline and lifetime stats remain)
- **μ**: all-time mean of per-message TPS across the session
- **p95**: 95th percentile of the last 500 per-message TPS samples (bounded)

## Optimizations

- Single shared 200ms timer, torn down and live status finalized on both
  `message_end` and `agent_end` (no frozen spinner if a stream is aborted)
- Idle refresh expires samples one by one and drops the rolling average when
  the window empties
- Fixed-size circular buffers for p95 and the sparkline; the 60s window is
  time-pruned (no buffer allocations in the streaming repaint path)
- Memoized sparkline (rebuilt once per message, not on every tick)
- Insertion sort for p95 (cold path, runs once per message for ≤500 elements)

## Author

Venkata Sai Chirasani

## License

MIT
