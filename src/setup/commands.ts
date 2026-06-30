import type { CommandFormat } from './types.js'

export const COMMAND_DESCRIPTION =
  'Drive your traintrack agent team — list members, spawn workers, delegate, and collect results.'

// The shared `/team` command behavior. The token `__ARGS__` marks where the host's
// argument placeholder goes (replaced per format); hosts with no placeholder get a
// descriptive phrase instead.
const BODY = `You are the LEAD of a traintrack agent team. Drive the team based on this request: __ARGS__

Interpret the FIRST WORD of the request as the action:

- (no args) or "status" → Call \`list_team\`. Give a one-line summary of each member: handle, agent type, role, and current status (online / working / done).
- "spawn <description>" → Call \`spawn_worker(agent, role, task)\` to start ONE worker for the task. Choose agent = "claude" or "codex" for the task, pick a short role, pass a clear task. Report the new worker's handle.
- "delegate <description>" → Break the work into a few parallel parts. For each, call \`spawn_worker\` with a suitable agent + role, then \`await_results\` to collect and synthesize one result. Keep the team small; do trivial parts yourself.
- "send <handle> <message>" → Call \`send_message(to=<handle>, body=<message>)\`.
- "sync" or "collect" → Call \`check_messages\` then \`await_results\`; summarize what each teammate delivered.
- "check" → Call \`check_messages\` and act on anything teammates sent you.
- "help" → Briefly explain these actions and the tools: list_team, spawn_worker, delegate_task, send_message, check_messages, await_results, join_team.

Workers run headless in their own git worktree and reply over the shared channel. If unsure who is available, start with \`list_team\`.`

/** Substitute the args token without String.replace's `$` pitfalls. */
function withArgs(placeholder: string): string {
  return BODY.split('__ARGS__').join(placeholder)
}

/** Body for hosts that have no argument placeholder. */
const NO_ARG_BODY = withArgs('whatever you typed after the command')

/** Render the `/team` command file content for a host's command format. */
export function renderCommand(format: CommandFormat): string {
  switch (format) {
    case 'md-args':
      return `---\ndescription: ${COMMAND_DESCRIPTION}\nargument-hint: "[status|spawn|delegate|send|sync|check|help]"\n---\n${withArgs('$ARGUMENTS')}\n`
    case 'continue-prompt':
      return `---\nname: team\ndescription: ${COMMAND_DESCRIPTION}\ninvokable: true\n---\n${withArgs('$ARGUMENTS')}\n`
    case 'md-plain':
      return `${NO_ARG_BODY}\n`
    case 'workflow':
      return `---\ndescription: ${COMMAND_DESCRIPTION}\n---\n${NO_ARG_BODY}\n`
    case 'skill':
      return `---\nname: team\ndescription: ${COMMAND_DESCRIPTION}\n---\n${NO_ARG_BODY}\n`
    case 'steering-manual':
      return `---\ninclusion: manual\n---\n${NO_ARG_BODY}\n`
    case 'toml-args':
      // Triple-quoted TOML string; the body has no `"""` or backslashes to escape.
      return `description = "${COMMAND_DESCRIPTION}"\nprompt = """\n${withArgs('{{args}}')}\n"""\n`
  }
}
