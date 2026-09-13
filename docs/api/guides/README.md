# Guides

Six things people build with the Agent API, each written as a working
sequence you can copy.

The [quickstart](../quickstart.md) gets you from a token to a completed turn.
These go further: each one is a whole scenario, and each leans on a different
part of the platform, so reading two of them is not reading the same thing
twice.

| Guide | Build this when |
| --- | --- |
| [Work that spans hours](work-that-spans-hours.md) | The job takes several rounds and you do not want to repeat yourself |
| [Extracting structured data](extracting-structured-data.md) | You need JSON back, over a batch of inputs, without duplicate work |
| [Approvals in your own product](approvals-in-your-product.md) | A person has to say yes before the agent does something |
| [An agent behind your API](an-agent-behind-your-api.md) | Your service dispatches work and never waits for it |
| [Showing the agent's work](showing-the-agents-work.md) | Your users watch it happen, not a spinner |
| [Switching model providers](switching-model-providers.md) | You want to change model or vendor without changing code |

## Before any of them

```bash
export GOBARE_API=https://api.gobare.dev
export GOBARE_TOKEN=gbr_pat_…
```

Mint the token in the Console under **Build with API › API keys**, and choose
the **Agent API** type. The default CLI type only imports projects; every `/v1`
route refuses it.

Connect a model under **Settings › LLM models**. Gobare is bring-your-own-key:
the model bill is yours, the computer is ours.

## Two things that will save you an afternoon

**Wait for artifacts, not for the turn.** Files the agent writes under
`/workspace/outputs` are published *after* the turn settles, so for a moment
after `status: "completed"` the artifact list is legitimately empty. Wait for
the turn's `artifacts` field to leave `pending`:

```bash
until [ "$(curl -s "$GOBARE_API/v1/sessions/$SID/turns?limit=1" \
  -H "Authorization: Bearer $GOBARE_TOKEN" | jq -r '.data[0].artifacts')" != "pending" ]; do sleep 1; done
```

If you use webhooks you can ignore this: `turn.completed` is sent once
publishing has finished.

**Subscribe before you send.** Open the event stream first, then post the
message. The other order loses the opening events whenever the agent starts
quickly — which is to say intermittently, and never on your machine.

[`run-session.ts`](../run-session.ts) handles both, along with answering the
agent's calls into your code. It is the same file our own end-to-end tests run
against, so it cannot quietly stop working.
