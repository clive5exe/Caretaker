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
