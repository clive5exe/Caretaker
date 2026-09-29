# Vendors

The harness hooks at the SDK level, so a vendor is an adapter satisfying:

```
run(workspace, prompt, policy) -> { diff, transcript, verdict, cost }
```

## The adapter is per-API, not per-model

This is the fact that makes broad support cheap. Almost everything self-hosted
speaks an **OpenAI-compatible chat-completions API with tool calling** — vLLM,
SGLang, Ollama, llama.cpp, TGI all expose one. So the adapter count is small:

| adapter | covers |
|---|---|
| `anthropic` | Claude, via the Agent SDK |
| `openai` | GPT, via the Responses API |
| `google` | Gemini, function calling |
| `openai-compatible` | **everything self-hosted**, plus most hosted Chinese APIs |

Four adapters, not forty models. Adding DeepSeek or Qwen behind vLLM is a config
line, not code.

## Open-weight models

Genuinely strong at code, and they fit the local-only thesis better than anything
else does: a model running on your own hardware is the complete version of "your
code never leaves".

Worth testing first, all open weight: **DeepSeek** (V3, R1 — strong at code,
permissive licence), **Qwen** (Qwen2.5-Coder and later, Apache-2.0 on most
sizes), **GLM** (Zhipu), **Kimi** (Moonshot, notable for agentic tool use),
**Llama** and **Mistral**.

Model quality moves faster than this document can, so this is a starting list
rather than a ranking. The selection criterion below is what matters and does not
go out of date.

## THE DISCRIMINATOR IS TOOL-USE RELIABILITY, NOT BENCHMARK SCORE

An agent loop lives or dies on three behaviours, and none of them is what a code
benchmark measures:

1. emitting **well-formed tool calls**, every time, over many turns
2. **stopping** when the work is done rather than looping
3. not **hallucinating a tool** that was never offered

Plenty of models that score well on code benchmarks are unreliable at multi-turn
tool use, and the failure is expensive rather than obvious: the loop burns tokens
and produces nothing. This is testable, so it should be a fixture rather than an
opinion — a fixed task with a known-good diff, run against each candidate, scoring
those three behaviours.

## Why the second vendor should be a local model

The rule is two vendors before the seam counts as proven. The second one should
be **an OpenAI-compatible local model, not another frontier API**, because it
stresses the seam far harder:

- different tool-call formatting quirks
- **no prompt caching**, which changes the cost model completely
- smaller context windows, so context selection actually has to work
- no hosted rate limits, but real GPU contention instead

A second frontier API would agree with the first about almost everything and
prove almost nothing.

## Two wrinkles this creates elsewhere

**Cost stops being one number.** A hosted model bills per token; a self-hosted one
has no marginal token cost and a real GPU cost. Estimating in tokens still works
as the unit of *effort*, but the money conversion is per-deployment. The run log
should record tokens and let cost be a projection, not store a price.

**Hardware honesty.** Self-hosting a useful coding model needs a GPU box. The
development box here has 6.5GiB and cannot run one. Self-hosted is a real option
and it is not a free one.

## Hosted API and open weights are different questions

Worth separating, because they get conflated and the distinction is factual
rather than political.

Using a **hosted API** sends your code to whoever runs it, wherever they run it.
That is true of every hosted vendor and is a data-residency question each team
answers for itself.

Running **open weights on your own hardware** sends your code nowhere. The
model's origin is then irrelevant to data residency, because no request leaves
the building.

So "we support DeepSeek" means two quite different things depending on which one
is meant, and the tool should make which one is in play obvious in the config
rather than leaving it to be inferred from a model name.

## What the second vendor showed

`bin/openai-compatible.mjs` is the second adapter behind
`run(workspace, prompt, policy)`. Nothing above the harness changed for it:
`runstore.mjs`, `verify.mjs`, `reconcile.mjs` and the read model run it
unmodified, and its tests archive and read back a run made through it. What
did have to move is recorded here, because each item is a place where the
first vendor's shape had been taken for the general one.

- **The cost vocabulary was Anthropic's.** `cost.tokens` is
  `in + cached + write + out`, with `in` meaning fresh input only. OpenAI's
  `prompt_tokens` *includes* the cached part, so reporting it as `in` would
  count cached tokens twice. The adapter splits it. There is no `write` at all
  on this API, and a local model reports no cache, which stays null rather
  than zero.
- **"Which CLI ran" was assumed.** The verdict named the default CLI on every
  run, so a run through any other adapter would have been recorded as a
  Claude run that never happened. `verdict.cli` is now null unless the cli
  adapter ran.
- **The tool loop was invisible.** With a CLI, the loop runs inside the
  vendor's binary, so nothing could score it. Only an adapter that drives the
  loop can count malformed calls, invented tools and stopping, so
  `verdict.toolUse` is optional and absent for CLIs. `bin/tool-fixture.mjs`
  scores a candidate on those three behaviours and on whether it did the task.
- **`net: none` works on this path, and cannot on the CLI path.** The model
  call leaves from the harness, above the container, so the container needs
  no egress for the agent's own traffic. With a CLI, the model traffic starts
  inside, so its API host has to be on the allowlist.
- **Policy grew adapter-specific keys:** `endpoint`, `apiKeyEnv`, `maxTurns`,
  beside the CLI-specific `cli` and `extraCliArgs`. Policy is one flat bag,
  and it now visibly holds two adapters' settings. That is tolerable at two
  adapters, and worth splitting before a third.

**Not yet proven on a real local model.** Every check here ran against a
scripted fake server, and the box these were built on has no GPU. The claim
the task makes — that a local model stresses the seam harder — needs one run
through `node bin/tool-fixture.mjs --endpoint … --model …` against a real
server. Until then the adapter is proven to the API, not to a model.
