# Reading and steering an AI agent's conversations

For apps where an agent talks to people (a chat bot per customer, per team, per staff member),
the most useful admin page is one person's conversation with the agent, with a way to step in.
This is how it was built on [eve](https://github.com/vercel/eve), whose channels expose a
session per conversation address; other agent frameworks have the same pieces.

## Read

- **The transcript** from the app's own message log (every message in and out), not the agent's
  context, which gets summarised.
- **The agent's steps** from the session's recorded event stream, read without following:
  `session.getEventStream({ startIndex: tail - 800, follow: false })` after
  `resolveSession(address)`. Map events to rows: `message.received` (what started the turn),
  `actions.requested` (tool name and input), `action.result` (status, output),
  `message.completed` (the reply), `input.requested` / `input.resolved` (approval cards and their
  answers), `turn.waiting` (on `input`: waiting for the person), `turn.completed` /
  `turn.failed` / `turn.cancelled`, `step.failed`, `compaction.completed`. Clip long JSON.
- **State** from the last turn event: working (`turn.started`, `step.started`), waiting for the
  person (`turn.waiting` on `input`), idle (`turn.completed|failed|cancelled`, `session.waiting`).

## Steer

- **Instruct**: start a turn in that person's conversation with a tagged message, for example
  `[support team] Retry their last booking for 4 pm and tell them.` Build the turn exactly like
  the app's scheduled or system turns: same lookup of the person's chat, same verified identity,
  same channel `send`. The agent acts with that person's rights, and anything that needs their
  approval still asks them. Tell the agent in its instructions what the tag means, that the
  person can't see it, and to write whatever it sends for the person.
- **Only instruct an idle conversation.** If the person's turn is waiting on an approval card or a
  question (`turn.waiting` on `input`), a new message can be taken as their answer. Wait, or stop
  the turn first.
- **Stop**: `from(address).cancel()`: cooperative cancellation of the active turn.
  Returns `accepted` or `no_active_turn`.
- **Start over**: `from(address).reset({ reason })`: like the person sending `/new`.
  Returns `reset` or `no_active_session`; `SessionStrandedError` means the conversation was made by
  an older framework version and can't run here.
- **Log** every steer in the app's message log (so the agent and later reviews see it) and the
  admin's email in the server log.

## Don't

- Don't answer someone's approval card for them from the dashboard: approval is the person's.
- Don't send messages as the bot outside a turn: the agent wouldn't know it was said, and the
  next reply would contradict it.
- A cancelled question keeps its buttons in the chat app unless the channel edits them away;
  tapping one later should get a "that's closed" reply.
