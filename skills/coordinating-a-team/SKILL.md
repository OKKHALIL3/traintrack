---
name: coordinating-a-team
description: Use when you have traintrack coordination tools and the user asks you to build several things at once, or when teammates may be messaging you. Covers acting as a lead (spawn workers, delegate, collect, synthesize) and as a peer in a shared-channel mesh (discover teammates, send/receive messages).
---

# Coordinating a Team (traintrack)

You have the traintrack tools: `list_team`, `check_messages`, `send_message`, `spawn_worker`, `delegate_task`, `await_results`, `join_team`. Every claude/codex session opened in this project auto-joins the **same team** over a shared local channel (resolved at the git repo root). You don't need to join or pass a channel path — you're already on the team.

## As a peer in the mesh

You are one of several sessions the human may be running at once. Treat the team like a chat channel you share.

- **Read your inbox often.** Call `check_messages` at the **start of each turn**, and immediately whenever a tool result shows a `📨 N unread` nudge — that nudge means a teammate wrote to you.
- **See who's around** with `list_team` (handles, agent type, role, online/offline).
- **Reach a teammate** with `send_message(to, body)`. They read it on *their* next turn — you cannot interrupt a session mid-task (a hard CLI limit), so don't block waiting on a live peer; keep working and check back.
- When a teammate asks you something, answer them with `send_message` back to their handle.

## As a lead (the user gives you multi-part work)

When the user says "build X, then Y, then Z" (or anything that splits cleanly across agents):

1. **Propose the split first.** State which part each worker takes and which agent runs it (claude or codex), then ask to proceed — unless the user said to just go.
2. **Spawn** one worker per part: `spawn_worker(agent, role, task, model?)`. Each worker runs **headless in its own git worktree** and replies automatically — these are your truly-hands-off teammates (unlike live sessions, they auto-receive instantly). Pass `model` to pin the worker's model (e.g. `"haiku"` for a cheap claude worker); omit it for the provider default.
3. **Collect** with `await_results()`. Send follow-ups to an existing worker with `delegate_task(handle, task)` and collect again.
4. **Synthesize** the workers' results into one answer for the user.

Keep the team small (spawn only what parallelism actually helps), and do trivial parts yourself rather than spawning.

## Notes

- `spawn_worker` already assigns the worker's first task — don't follow it with `delegate_task` for the same initial work. Use `delegate_task` for *follow-up* tasks to a worker that already exists.
- If a worker's reply never arrives, `list_team` to confirm it's registered, and check it isn't offline.
