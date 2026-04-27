---
name: google-calendar
description: Query and modify the user's Google Calendar. Available in main and trusted containers via the mcp__onecli__gcal_* tools. Reads/writes events on lim@igolnik.com with OAuth handled transparently by OneCLI.
---

# Google Calendar

When the user asks about their calendar, upcoming events, scheduling, availability, or wants to create/modify events, use the `mcp__onecli__gcal_*` structured tools. They wrap the Google Calendar REST API and route through OneCLI's HTTPS proxy which injects OAuth automatically — no token handling, no curl, no client secrets.

The connected account is `lim@igolnik.com` with `calendar.readonly` + `calendar.events` scopes.

## Tools

| Tool | When to use |
|---|---|
| `mcp__onecli__gcal_list_events` | "What's on my calendar this week / today / Friday / between X and Y" |
| `mcp__onecli__gcal_get_event` | User references a specific event; you need attendees / description / full details |
| `mcp__onecli__gcal_create_event` | "Add / book / schedule a meeting / block time for X" |
| `mcp__onecli__gcal_update_event` | "Change / move / rename / add location to event X" |
| `mcp__onecli__gcal_delete_event` | "Cancel / remove event X" |
| `mcp__onecli__gcal_list_calendars` | User asks about secondary/shared calendars, or you need a non-primary calendar ID |
| `mcp__onecli__gcal_freebusy` | "When am I free / busy between X and Y" — faster than listing events when you only need open windows |

## Input conventions

- All tools default `calendarId` to `"primary"` — the user's main calendar. Override only when you have a specific calendar ID from `gcal_list_calendars`.
- Times are RFC3339 strings with timezone offset, e.g. `"2026-04-25T10:00:00-07:00"`. For all-day events pass `{"date": "YYYY-MM-DD"}` instead of `{"dateTime": ...}`.
- For `create_event` / `update_event`: if you're not explicitly sending email invites, leave `sendUpdates` at its default `"none"`. Only use `"all"` when the user says "send invites."

## Notes

- Prefer these structured tools over raw `curl`. They enforce schemas and the agent gets proper input hints.
- If a call returns a 401/403, OneCLI's token may be stale — report back; don't loop.
- This skill is only active in trusted containers (main DM + groups with `containerConfig.trusted = true`). Untrusted groups don't see the MCP tools or this skill.
