export type TeamRosterEntry = {
  handle: string
  role: string
  agent: string
  kind: 'live' | 'headless'
}

/** Build the onboarding briefing handed to every team member so it knows the
 *  team, its teammates, the coordination tools, and that it must watch for messages. */
export function buildBriefing(args: {
  teamName: string
  selfHandle: string
  selfRole: string
  roster: TeamRosterEntry[]
}): string {
  const others = args.roster.filter((r) => r.handle !== args.selfHandle)
  const rosterLines = others.length
    ? others.map((r) => `  - ${r.handle} (${r.agent}, role: ${r.role})`).join('\n')
    : '  (no other members yet — more may join)'
  return [
    `You are a member of the "${args.teamName}" agent team. Your role: ${args.selfRole}.`,
    `Your teammates:`,
    rosterLines,
    ``,
    `How you coordinate: you run as a headless worker turn — you do NOT have MCP tools.`,
    `Just reply in plain text. Your reply is automatically delivered back to whoever`,
    `messaged you, so you do not need to "send" or "check" anything by hand.`,
    ``,
    `To direct your reply at a SPECIFIC teammate instead of the sender, start your`,
    `reply with @<their-handle-or-role> followed by your message — e.g. "@lead done: ...".`,
    `Otherwise your reply goes back to whoever messaged you.`,
    ``,
    `A teammate may message you at ANY time; each incoming message starts a fresh turn`,
    `for you with that message included, so you will always see new requests.`
  ].join('\n')
}
