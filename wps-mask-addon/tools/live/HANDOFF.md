# Real-host verification: closed

*[中文](HANDOFF_zh.md)*

Status: closed on 2026-11-25. The three open items were measured on WPS Spreadsheets 12.1.0.29161. The verdicts live in [the verification page](../../docs/verification.md); this file keeps how they were obtained and the traps that make a COM-only run report false failures.

## Answers

| Question | Answer |
| --- | --- |
| Does the pane get a host object? | Yes. It listed the selection's columns and their detected types, masked the 10-row × 3-column range with 「映射并写入」 and restored it with 「反映射还原值」 |
| Does `CreateTaskPane` take a `file://` URL? | Yes. The pane opened from the installed add-in's own URL and rendered its title and content |
| Do whole-column array writes work, and how fast? | Yes. One column of 100,000 rows: 「快速映射」 to the first masked cell took about 7 seconds, the read-back check passed and the hidden table was created (`Visible = 2`). The figure is end-to-end, not the raw assignment |

## How they were obtained

- Attach to the visible window through the running-object table, not `New-Object`: every fresh COM client gets its own hidden WPS instance, which cannot see the window a person is looking at. `Marshal.GetActiveObject` does not exist on .NET Core, so the call is P/Invoked on `oleaut32!GetActiveObject`.
- The ribbon is custom-drawn, so UIA cannot see the tab. `PrintWindow` screenshots the window, the tab and buttons are located by pixel, and `mouse_event` clicks them.
- Bring the window to the foreground by minimizing and restoring it; `SetForegroundWindow` alone is refused.

## Traps

- **An unclicked modal dialog makes the host answer zeros.** One `--ui` run returned 0 CommandBars and a null `Worksheets` while a WPS add-in confirmation dialog was waiting for a click; the same operations work once the window is clean. Treat an all-zero `controls` answer as "look at the screen", not "the host lost its ribbon".
- **Each COM client gets a fresh process.** `Workbooks.Count` is 0 in the new instance even while another window is open; only the running-object table gives the instance behind the visible window.
- **A paused host is not a failing host.** A 120s timeout on `stat` says the call did not return, not that the write failed.

## Still worth checking

Nothing from the original list. What the probe could not do from outside is still true: the add-in's buttons have no CommandBars entry and no UIA tab, so a machine-driven run through the ribbon is still blocked — but the panel runs the same engine and one click opens it.

`npm run live:probe:log` re-runs the machine-checkable items; `--ui --perf` adds the window and the 100k rows. The decisions behind this tooling are in [the note](../../../.agents/notes/implemented/2026-11-25-live-probe.md).
