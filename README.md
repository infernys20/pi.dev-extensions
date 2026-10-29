# Pi Extensions

Personal collection of extensions for [Pi](https://github.com/badlogic/pi-mono) — the AI coding agent harness.

This repo is a work in progress and **will be updated with more extensions as time goes on**. New extensions are added here as they are built, refined, and proven useful in real sessions. Expect the contents to change frequently; check back for updates, or watch the git history to follow along.

## Current extension: Watchdog

`watchdog.ts` — keeps a session alive when an assistant turn dies with an error.

Some provider failures (capacity errors, transient upstream hiccups, and other errors that Pi's built-in retry logic does not classify as retryable) end the turn and leave you staring at a dead session. The Watchdog extension notices these failed runs and automatically nudges the session to continue by queueing a single `.` user message after the run has settled.

**Behavior**

- Detects failed assistant turns (`stopReason === "error"`) and errored agent outcomes (`agent_before_settle` with `outcome === "error"`).
- After the run settles, sends a `.` follow-up message to resume the session.
- Uses exponential backoff between retries: 2s, 4s, 8s, 16s, … capped at 60s.
- Stops after 8 consecutive retries and notifies you with the last error message.
- Any successful assistant response resets the counter and disarms the extension.
- Aborted runs are treated as intentional interruptions and are not retried.
- Shows live state in the status line (`wd: on`, `wd: error queued`, `wd: retry 2/8 in 4s`, `wd: stopped`) and surfaces events as notifications.

**Commands**

| Command | Effect |
| --- | --- |
| `/watchdog` | Show current status |
| `/watchdog on` | Enable the watchdog |
| `/watchdog off` | Disable it (also cancels any pending retry) |
| `/watchdog reset` | Reset the retry counter and disarm |
| `/watchdog now` | Send `.` immediately, without waiting |

**Usage**

Copy `watchdog.ts` into your Pi extensions directory (e.g. `~/.pi/agent/extensions/`) and start Pi — extensions in that directory are loaded automatically.

## License

See [LICENSE](./LICENSE).
