# Guides

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/guides> — read it there; this copy is for offline and for tooling.

Six things people build with the Agent API. Each one is a complete working
program, not a sequence of fragments — copy it, run it, then change the parts
that are about your business rather than ours.

The [quickstart](../quickstart.md) gets you from a token to a completed turn.
These go further, and each leans on a different part of the platform, so
reading two of them is not reading the same thing twice.

| I want to… | Guide |
| --- | --- |
| Turn a pile of PDFs, contracts or reports into rows in my database | [Turn documents into structured JSON](extracting-structured-data.md) |
| Hand work to an agent from my own API and collect it later | [Put an agent behind your own API](an-agent-behind-your-api.md) |
| Make a person approve something before the agent does it | [Require human approval before the agent acts](approvals-in-your-product.md) |
| Show my users what the agent is doing, live | [Stream the agent's progress into your UI](showing-the-agents-work.md) |
| Keep one job going across hours, pausing in between | [Continue work across hours and rounds](work-that-spans-hours.md) |
| Change model or vendor without touching my code | [Swap model providers without changing your code](switching-model-providers.md) |

Every script here is standard library only. No SDK to install, in any language.

## Before any of them

```bash
export GOBARE_API=https://api.gobare.dev
export GOBARE_TOKEN=gbr_pat_…
```

Mint the token in the Console under **Settings › Developer access**, choosing
**Agent API · read/write**. The default **CLI import** type holds only the `cli`
scope and is refused by every `/v1` route.

Then connect a model — `POST /v1/model-credentials`, or the Console under
**Settings › LLM models**. Gobare is bring-your-own-key: the model bill is
yours, the computer is ours.

One call proves all three:

```bash
curl -s $GOBARE_API/v1/model-credentials -H "Authorization: Bearer $GOBARE_TOKEN"
```

A list back means your token is valid, scoped, and has a model to run. The
`model` in it is what goes in `agent.model`.

## Four things that will save you an afternoon

These are not trivia. Each one is a mistake that costs hours because it
produces *plausible* behaviour rather than an error.

**Wait for artifacts, not for the turn.** Files the agent writes under
`/workspace/outputs` are published *after* the turn settles, so for a moment
after `status: "completed"` the artifact list is legitimately empty — and
indistinguishable from a turn that produced nothing. Poll the turn's
`artifacts` field until it leaves `pending`. With [webhooks](../webhooks.md)
you can ignore this: `turn.completed` is sent once publishing has finished.

**Subscribe before you send.** Open the event stream first, then post the
message. The other order loses the opening frames whenever the agent starts
quickly — which is to say intermittently, and never on your machine.

**Tell the agent not to ask questions**, if nothing in your product can answer
one. An agent that meets ambiguity parks on a `question`, which **the API
cannot answer** — only a person in the Console can. One line in `instructions`
prevents it:

```
Never ask the user a clarifying question: if something is ambiguous,
state your assumption and continue.
```

**Two `429`s mean opposite things.** `rate_limit_exceeded` is worth retrying;
`project_limit_exceeded` means the organization is at its session ceiling and
retrying never clears it. Branch on `error.code`, never on the status alone.

## The reference

The guides show a shape; the reference pages have every field.

- [sessions.md](../sessions.md) — repositories, files, secrets, permissions
- [input.md](../input.md) — the four things you can send a session
- [events.md](../events.md) — the event vocabulary
- [errors.md](../errors.md) — every refusal, in one shape
- [limits.md](../limits.md) — every ceiling, with its number
- [troubleshooting.md](../troubleshooting.md) — arriving with a symptom instead of a question

[`run-session.ts`](../run-session.ts) is a TypeScript client that handles the
first two afternoon-savers above, plus answering the agent's calls into your
code. It is the same file our own end-to-end tests run against, so it cannot
quietly stop working.
