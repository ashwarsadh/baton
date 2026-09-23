# The Board

The Board is an optional module (**Settings › Modules › Board**) that turns a JSON file into a
tappable to-do list on your phone. Each tap becomes one line of text delivered to your **Conductor**
session (Settings › Advanced › Conductor session id), which reads it and acts.

Use it when one coordinating session keeps a running list of things that need you — decisions,
questions, stuck sessions — and you want to clear them from your phone with a tap.

## Where the file lives

`board.json` in the board folder: `~/.baton/board/board.json` by default, or the folder set in
Settings › Advanced › Board folder. Anything can write it — typically the Conductor session itself,
or a scheduled script. Baton only reads it (and appends an audit log, `board-actions.jsonl`, next
to it).

## Format

```json
{
  "built_at": "2026-01-01T09:00:00Z",
  "conductor": "local_…",
  "rows": [
    {
      "id": "local_…",
      "title": "Migrate database to Postgres 17",
      "bucket": "decide",
      "ask": "Run the migration tonight or wait for the backup?",
      "ask_kind": "decision",
      "project": "backend",
      "age": 1
    }
  ],
  "inbox": [
    { "n": 12, "text": "Renew the TLS certificate before Friday", "session": "local_…", "ts": "2026-01-01T08:00:00Z" }
  ],
  "goals": [
    { "id": "g1", "title": "Ship v2 API", "status": "open", "due": "2026-01-15", "checks": ["docs", "tests"] }
  ]
}
```

- **rows** are sessions that need something. `id` is the session id, so a row can open the session.
  `bucket` is one of `decide`, `nudge`, `buried`, `un`, `open` (the app groups by it). Rows older
  than `age` 7 days are hidden from the counts.
- **inbox** items are notes for you, numbered by `n`.
- **goals** are optional and shown read-only.
- `conductor` is used when no Conductor session is set in Settings.

## What a tap sends

| Tap | Line delivered to the Conductor |
|---|---|
| Yes on a row | `yes <id>   # <title>` |
| Skip on a row | `skip <id>   # <title>` |
| Answer on a row | `answer <id>: <your text>   # <title>` |
| Done on an inbox item | `done #<n>   # #<n> <text>` |
| Answer on an inbox item | `answer #<n>: <your text>   # #<n> <text>` |

Tell your Conductor session what these lines mean once (for example in its CLAUDE.md), and it can
act on them.
