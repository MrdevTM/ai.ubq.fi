# Codex mid-turn stop — root cause investigation and gateway patch surface — 2026-09-26

## Status

**Thirteen backtest rounds are recorded here, and the headline diagnosis was reversed three times.** Read this section
before any other.

What stands after all of them:

1. **Codex ends a turn when a whole response contains no tool call.** Verified in source and by measurement. This is the
   mechanism and it is not in dispute.
2. **The defect the owner reports is real, but it is not specific to the DeepSeek tiers.** On the cleanest measure
   available — the owner typing `proceed` or a similar continuation instruction after a turn that ended normally — the
   GPT family stops mid-task about **1.6× as often** as the DeepSeek tiers (0.578% against 0.361%, p = 0.17), and the
   weakest GPT tiers are the worst.
3. **The owner's own interruptions must be filtered out of any such measurement.** `thread_turns.status` carries
   `interrupted` for a stray ESC or a mis-clicked stop button, and those number 1,354 GPT turns against 79 DeepSeek. A
   metric that ignores this attributes the owner's mis-clicks to the model. This is the error that produced the
   incorrect DeepSeek-specific result in the first twelve rounds.
4. **Nothing in this repository was changed, deployed, or pushed while preparing this document.** The gateway patch
   described below is falsified by backtesting; see "Backtest result" and "Proposed patch surface — withdrawn".

What does _not_ stand, and should not be reused:

- The claim that DeepSeek's tiers stop mid-turn at 20 to 27 times the GPT rate. Both figures were artifacts.
- The onset date of 2026-09-19. It was a change in how often the owner typed `ok`, not in failure rate.
- The CLI version analysis built on that onset.
- Any use of `ok` as an outcome measure. It is ambiguous between acknowledgement and nudge, and the split differs by
  model.

Scope: why Codex turns appear to stop before the task is finished, how that interacts with the DeepSeek tiers served by
this gateway, why DeepSeek Harness (DSH) never exhibits the symptom against the same gateway and the same model, and
where a scoped LithosAI `-ultra` patch would live if one were warranted.

## Symptom

A Codex turn ends while work remains. The observable shape is consistent: the assistant emits a short intent line ("Let
me check the files…", "Now holding one long wait on the worker", "Proceeding. Let me read the exact markup…") and the
turn terminates immediately after. No error, no failure banner. The owner resumes by typing `ok`, `proceed`, or `k`.

The symptom is real to the owner across thousands of turns. What this document retracts is the attribution: the recorded
evidence does not support it being a DeepSeek-tier property, and points instead at the GPT tiers, with the owner's
accidental interruptions as a contaminating factor in every earlier measurement.

## Round ledger, and what each round established or retracted

Thirteen rounds were run against the same corpus. Listed in order, because the sequence matters: most rounds corrected
an earlier one.

| Round | Claim                                                                               | Outcome                                                                                                |
| ----- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1     | A structural detector can flag stalled turns                                        | **Refuted.** 1.8% precision against a 1.7% baseline                                                    |
| 2     | Fragmented tool calls are dropped in translation                                    | **Refuted.** DSH and this gateway merge them identically                                               |
| 3–4   | The symptom is not statistically DeepSeek-specific                                  | **Closer to right than round 5**, on a small corpus                                                    |
| 5     | DeepSeek is 22× worse, p ≈ 3.5e-16                                                  | **Retracted.** Control was dominated by non-interactive GPT threads                                    |
| 6     | Correcting for that, the effect is not significant (p = 0.43)                       | **Over-corrected.** Shrank the control to 246 turns                                                    |
| 7     | Restricted correctly, 27× per thread and 19.6× per turn                             | Real arithmetic, wrong inference (see round 13)                                                        |
| 8     | The symptom has an onset of 2026-09-19                                              | **Artifact of `ok` usage frequency**, not failure rate                                                 |
| 9     | DSH is the control that excludes the gateway                                        | **Discarded.** Owner confirmed these were gateway-debugging sessions                                   |
| 10    | A client version caused it                                                          | **Refuted.** The family ordering reverses between versions                                             |
| 11    | Reconstructed the raw item stream; text-only responses are normal for both families | Holds, and is still the best available substitute for raw bodies                                       |
| 12    | DeepSeek makes 10× more sampling calls                                              | **Artifact.** Log verbosity, not work; the correct count reverses the finding                          |
| 13    | `ok` measures conversation, not failure                                             | **Correct observation, wrong conclusion drawn.** Led to "no defect exists", which further work refuted |

### The five methodological traps this investigation repeatedly fell into

Recorded because each one produced a confident wrong answer, and each is easy to repeat:

1. **Unmatched controls fabricate model effects.** Comparing interactive DeepSeek against mostly non-interactive GPT
   produced a 22× contrast that dissolved under matching.
2. **Over-correcting is as bad as under-correcting.** Matching on `originator` buried a real effect behind p = 0.43.
3. **Log-event counts are not work counts.** `run_sampling_request` fires per span event, not per request; counting it
   gave a 10× difference that reversed when actual upstream calls were counted.
4. **A table is not a test.** A zero-stall run from 7 to 30 requests looked like a boundary and collapsed to p = 0.78
   when the cut was made properly.
5. **Statistical strength is not detection ability.** Both `phase` absence and the bare-response rate showed strong
   associations at 2.37% and 10.75% precision, against base rates of 2.2% and 9.80%.

## Evidence

### Codex turn termination is decided by absence of a tool call — as originally recorded, then corrected

> **Correction, this session.** The rule below is stated too strongly. An assistant text item does _not_ end a turn;
> Codex continues past a text item 7,630 times, and only 25.4% of assistant text items are terminal. See "The
> terminating rule is about the response, not the text item". What ends a turn is the whole response containing no tool
> call, and an intent line followed by a tool call is the ordinary working shape. The counts below remain valid.

Across the owner's last 20 `ok` replies, in 17 the preceding turn terminated with a `task_complete` whose immediately
preceding item is an assistant `message` carrying no tool call. Measured per-turn tool-call counts for the stopping
turns:

```
dur=6s     calls=0   "Proceeding. Let me read the exact markup and styles I need to patch."
dur=3s     calls=0   "...read-only and bring back the per-provider p50/p95 + cache-hit table."
dur=919s   calls=0   "...no push has been authorized here."
dur=26s    calls=4   "Let me give it a clear few seconds and make the wait feel intentional."
dur=36s    calls=12  "...by inspecting the two clients' actual handling."
```

The rule is mechanical: a response containing no tool call ends the turn. Codex does not evaluate whether the task
completed. A DeepSeek model that narrates intent in one response and emits the tool call in the _next_ response is
therefore cut off at the narration boundary.

### DSH cannot terminate that way — corrected

The original claim here was that DSH ends a turn only after a work step closes, so "the equivalent of Codex's stopping
condition does not exist in the DSH loop". **That is false, and the source was read to check it.**

DSH's loop (`@deepseek-ai/dsh-agent-loop`, `step()`) contains the same deciding line as Codex:

```
const toolCalls = message.content.filter((block) => block.type === "tool-call");
if (toolCalls.length === 0) return { kind: "completed" };
```

DSH closes a step, and then the turn, when a response carries no tool call — the same rule. The surviving observation is
narrower and still true: across 80 recent DSH sessions, no completed turn ends on a bare text block without a completed
tool step. But that is a statement about the sessions observed, not a structural property of the loop, and it must not
be restated as one.

The earlier session statistics stand as recorded:

```
182 completed <- step/end          (real work: tool/call -> tool/result -> step/end)
 48 error     <- step/end
 20 completed <- workspace/changes
  2 aborted   <- step/end
  1 interrupted <- step/end
```

What remains unexplained is why the same model, against the same gateway, narrates intent without a tool call far more
often under Codex than under DSH. That is an input-shape difference between the two clients, not a loop-logic
difference, and it is not yet identified.

### Discriminators that were tested and rejected

- **Text heuristics** ("Let me…", trailing punctuation, final-line promise detection): 1300 versus 1253 messages split
  across the two classes. No separation. Do not build a detector on wording.
- **`content_item_kinds: ['unknown']`**: present on 1557 of 1557 assistant messages. Universal, worthless.
- **Duration**: the stopping turns span 3s to 919s. Not a signal.

### Failure classes that are real but unrelated

These appear in Codex logs and were each raised and then ruled out as the cause of _this_ symptom:

- `stream disconnected before completion: stream closed before response.completed` — 10 occurrences in 30 days. A
  distinct compatibility problem with its own prior handoff
  (`codex-responses-stream-drop-diagnostic-handoff-2026-08-20`).
- `429` quota refusals — 347 occurrences, dominated by non-DeepSeek models.
- `text.format type 'json_schema' is not supported upstream` — 20 occurrences. A Codex request-shape issue against the
  upstream, not present on DSH's wire shape.
- `model_needs_follow_up=false` — originally suspected, then falsified: the stopping turns logged
  `model_needs_follow_up=true` throughout.
- `background_terminal_max_timeout = 300000` clamping a `write_stdin` request from 600000 ms to 300.0017 s — real, but
  accounts for only 1 of the 20 sampled stops.

## Backtest result

The detector in "Proposed patch surface" was implemented and scored against every `task_complete` in the 182 Codex
rollouts. Ground truth for a stop is the owner's recorded acknowledgement: an ack-only user message (`ok`, `okay`, `k`,
or an `ok`-prefixed follow-up) whose preceding turn ended the same way the reported symptom does.

Note that this run pooled all models, which the section below shows is methodologically wrong; the detector fails on the
Ultra-only subset in the same way and for the same structural reason, so the conclusion is unaffected.

|                                    | count     |
| ---------------------------------- | --------- |
| Positive (owner resumed with `ok`) | 46        |
| Negative (turn not resumed)        | 2,660     |
| Detector fires, correctly          | 46        |
| **Detector fires, incorrectly**    | **2,534** |
| Detector misses                    | 0         |

Precision 1.8%. Recall 100%. Baseline for always predicting a stop 1.7%.

The rule has no discriminating power. It fires on 2,534 turns the owner never had to resume, because ending on a
text-only assistant item is the ordinary shape of every completed turn — a final answer is text with no tool call. The
46 real failures are not separable by this structure from the 2,534 legitimate completions.

Had this shipped, the gateway would have force-continued every normal answer on the route.

This is the same failure mode as the historical gateway recheck retired in `be89f4919`, which had to delegate the
decision to the model because no deterministic structural predicate exists.

## Refuted hypothesis: fragmented tool calls were dropped in translation

A separate hypothesis — that DSH merges fragmented `tool_calls` deltas by index while this gateway's Responses
translation loses them, so Codex never sees the call — was **checked and refuted**.

DSH does merge them, in `@deepseek-ai/dsh-llm-deepseek` `translate()`, accumulating per `call.index` and appending
`function.arguments` fragments into one block before `[DONE]`.

This gateway does the same in `src/deepseek/responses-stream.ts`, `mergeToolCallDelta()`, keyed by `raw.index` with
`existing.arguments += fn.arguments`. Fragmented calls are accumulated and announced at the terminal, not dropped.

Both clients therefore assemble identical tool calls, and the translation loses nothing. The two loops are also
byte-identical at the deciding line (`if (toolCalls.length === 0) return { kind: "completed" }`).

No structural feature tested separates the failure class:

| Feature                                 | Positive | Negative    | Verdict              |
| --------------------------------------- | -------- | ----------- | -------------------- |
| Last item is assistant message, no call | 46/46    | 2,534/2,660 | 1.8% precision       |
| `content_item_kinds == ('unknown',)`    | 46/46    | 2,550/2,660 | universal, worthless |
| Output tokens (p50)                     | 303,449  | 429,515     | overlapping          |
| Reasoning tokens (p50)                  | 219,407  | 251,387     | overlapping          |
| Tool calls present in turn              | 42/46 ≥1 | —           | not a separator      |

Zero of the 46 stopping turns are distinguishable from a legitimate completion by any structural signal examined.

## Measured incidence, and why the earlier corpus was misleading

The first backtest treated all 182 rollouts as one population. That was wrong: the corpus mixes models, and the reported
symptom is specific to the Ultra tier. Split by the deployment of the existing reminder (`e04f67ff`, 2026-09-22 04:34
EDT) and then by model:

| Population                     | Turns | Acks | Rate      |
| ------------------------------ | ----- | ---- | --------- |
| All turns before the reminder  | 1,800 | 40   | 2.22%     |
| All turns after the reminder   | 724   | 6    | 0.83%     |
| Ultra only, after the reminder | 181   | 4    | **2.21%** |

The apparent post-reminder improvement is a model-mix artifact, not an effect. Before the cut the traffic is 93%
`deepseek-flash`; Ultra appears only afterwards. Isolated to Ultra, the rate is 2.21% — statistically indistinguishable
from the 2.22% measured before the reminder existed.

This independently reproduces the decision record's own finding that "the reminder alone is insufficient" (`be89f4919`,
discussing PR #395).

Consequence for any future candidate: the Ultra-only population is **181 turns across 43 sessions, with 4 acknowledged
stops**. That is too thin to validate a detector, and it means an acceptable fix must be argued from mechanism rather
than measured on this sample. Any further backtest must filter to Ultra turns; pooling models silently mixes a ~2%
population with a ~0.8% one and produces a trend that does not exist.

## A prompt-side mechanism already exists, and it is measurable but not sufficient

The gateway already injects a continuation reminder server-side. `src/deepseek/chat-projection.ts` appends:

```
CONTINUATION_INSTRUCTION =
  "When tools are available, a progress update does not complete a requested action.
   If required work remains and you can perform it, continue with the next appropriate
   tool call instead of ending with a status message. ..."
```

It is scoped correctly, which matters because the owner's objection to an `AGENTS.md` rule was that it would apply to
every model: `appendContinuationInstruction` runs only when the request carries mapped executable tools **and**
`tool_choice !== "none"`, so non-agent traffic and hard no-tools requests are untouched. Introduced in `74f32ff43`,
deployed as `e04f67ff` (PR #395).

So the "unsophisticated prompt-side fix" the owner rejected is not hypothetical — it is already live on this route, and
it did not remove the symptom. That is a stronger statement than the earlier reasoning that a prompt is merely
suggestive: this one is applied server-side, scoped to tool-bearing Ultra requests, and the measured failure rate on
that population is unchanged.

## The terminating rule is about the response, not the text item — corrected again

The original claim in "Evidence" was that "a response containing no tool call ends the turn", and the weaker reading
that "Codex stops when it sees text with no tool call". Measured over all 182 rollouts, that is wrong as stated:

| Assistant text items                     | Count |
| ---------------------------------------- | ----- |
| Followed by a tool call in the same turn | 7,630 |
| Terminal, i.e. ended the turn            | 2,598 |
| Fraction terminal                        | 25.4% |

Codex continues past a text item 7,630 times. Four times out of five, an assistant text item is mid-turn narration that
is followed by a tool call. So the rule is not "text ends the turn" and not "a text item without a tool call ends the
turn" — an intent line followed by a tool call is the normal, working shape and is not penalized.

What ends a turn is the **response** ending without a tool call anywhere in it. The unit of the decision is the
response, not the text block. This matters for any candidate fix: the problem is not that DSH tolerates mid-turn text
and Codex does not. Both tolerate it. The problem is a response that genuinely contains no tool call.

That narrows the remaining question to why the Ultra/Flash tiers emit more responses containing only text. The answer is
not visible in the Codex-side item log, because a text item looks the same whether or not a call followed it until the
turn boundary is known.

## Multi-text and call-shape features also fail

For completeness, the remaining structural candidates on the Ultra/DeepSeek population, scored the same way:

| Feature                                     | Positives | Negatives   | Verdict        |
| ------------------------------------------- | --------- | ----------- | -------------- |
| Multiple assistant text items in turn       | 40/46     | 1,314/2,660 | 2.9% precision |
| No tool call anywhere in turn               | 4/46      | 285/2,660   | 1.4% precision |
| Turn ends on `msg_` id with no `ctc_`/`fc_` | 46/46     | 2,359/2,660 | 1.9% precision |

Every feature that includes the real failures also includes hundreds to thousands of legitimate completions.

## Cross-model incidence — superseded

> **Superseded twice.** This section reported that the model contrast was not significant, on the basis of 169
> non-DeepSeek turns with 1 acknowledgement. Round 5 then reported a 22× contrast; round 6 showed that comparison was
> confounded by `originator` and retracted it. The current position is under "The round-5 model contrast was
> confounded". This section is retained because its conclusion — that this corpus is too small to establish model
> specificity — was closer to correct than round 5's overreach.

Per-model acknowledgement rate over all 2,524 classified turns:

| Model                                   | Turns | Acks | Rate  |
| --------------------------------------- | ----- | ---- | ----- |
| `deepseek-flash`                        | 2,168 | 41   | 1.89% |
| `deepseek-ai/DeepSeek-V4.1-Flash-ultra` | 181   | 4    | 2.21% |
| `codex-auto-review`                     | 90    | 0    | 0.00% |
| `gpt-6-astra`                           | 74    | 1    | 1.35% |
| `deepseek-ai/DeepSeek-V4.1-Flash`       | 4     | 0    | 0.00% |
| others                                  | 7     | 0    | 0.00% |

Grouped DeepSeek versus everything else: 45/2,353 (1.91%) against 1/169 (0.59%). **Not significant** — Fisher's exact
test gives p ≈ 0.45. The hypothesis that the affected population is Flash rather than Ultra is also refuted: the two
DeepSeek tiers are within noise of each other.

So this corpus cannot establish that the symptom is DeepSeek-specific at the model level, despite the owner's strong
operational report that it is. The honest statement is that the tiers observed failing are DeepSeek tiers, DeepSeek
traffic dominates this corpus (93%), and the non-DeepSeek sample of 169 turns with 1 acknowledgement is too small to
serve as a control.

**This paragraph is the error.** The owner's operational report was correct and this corpus was simply too small to show
it. But round 5's replacement correction was itself confounded, and is retracted; the settled position is the
matched-comparison table under "The round-5 model contrast was confounded".

## Ground-truth signal validated

The `ok` acknowledgement was treated as ground truth without checking it. It holds up:

- 50 ack-only messages across 3,243 user messages (1.54%).
- Of those, **46 of 50 are followed by a turn that performs real tool work**, which is what a stall implies.
- The 4 that are not followed by tool work are themselves conversational (`ok so what do i do next`), i.e. the
  acknowledgement was answering a question rather than resuming stalled work.
- 9 of the 50 are followed by another ack, so one stall can produce several acks; treating each ack as one failure
  slightly over-counts. The effect is small and does not change any conclusion.

## A larger, authoritative corpus was found — and it confirms the negative result

The round-3 conclusion that "the remaining evidence does not exist yet" was itself wrong and is corrected here. Two
Codex stores were never inspected:

- `~/.codex/thread_history_1.sqlite` (8.8 GB) — `thread_turns` (16,267 turns) and `thread_items` (their ordered items)
- `~/.codex/state_5.sqlite` (96 MB)

`thread_turns` carries an authoritative per-turn record: `status`, `error_json`, `duration_ms`, and
`final_agent_item_id`, which is the item the turn actually ended on. That is the terminal-item signal the rollouts only
allowed to be inferred, recorded directly by the client.

### Every completed turn ends on a text message

| Terminal item type | Count  |
| ------------------ | ------ |
| `agentMessage`     | 12,871 |
| anything else      | 0      |

Across all 16,267 turns, **not one** ends on a tool call. Every turn that ends, ends on text — including all 12,709
successful ones. This removes the last version of the "it stopped on text" framing: ending on text is universal and
carries no information.

Turn statuses in this store: 13,270 `completed`, 1,433 `interrupted`, 987 `inProgress`, 577 `failed`.

### The 577 failed turns have explicit causes, none of which is this symptom

| Error                                                                            | Count |
| -------------------------------------------------------------------------------- | ----- |
| `input item type 'agent_message' is not supported`                               | 89    |
| `stream disconnected before completion: stream closed before response.completed` | 42    |
| `429 Too Many Requests`                                                          | 15    |
| `403 Paid-provider routing is disabled for this API key`                         | 11    |
| `high demand` internal server error                                              | 16    |
| `Unrecognized request argument supplied: client_metadata`                        | 9     |
| `function_call_output items require call_id`                                     | 6     |
| `array too long / input[n].content maximum length 0`                             | 26    |
| other                                                                            | ~363  |

These are reported failures with error text. The reported symptom is a turn that ends **successfully** with work
outstanding, so it is not in this set — which is consistent with the symptom being invisible to the client's own
accounting.

### Larger sample, same null result

The store contains 12,416 user messages and 188 acknowledgement-shaped messages — roughly four times the rollout corpus.
Strict ack matching (`ok`, `Ok`, `OK`, `k`, `okay`) yields 62 turns with a resolvable preceding assistant message.

Feature comparison of the stalled class against 3,355 control messages from the same threads:

| Feature                                        | Stalled | Control | Lift  |
| ---------------------------------------------- | ------- | ------- | ----- |
| Final line ends with `.`                       | 83.9%   | 64.2%   | 1.31× |
| Final line shorter than 120 chars              | 59.7%   | 57.5%   | 1.04× |
| Final line starts `let me`/`now`/`I'll`/`next` | 11.3%   | 11.1%   | 1.02× |
| Final line ends `:`                            | 12.9%   | 13.4%   | 0.96× |
| Final line lacks a completion word             | 95.2%   | 89.6%   | 1.06× |

Maximum lift 1.31× on a 62-sample class, in the wrong direction to be a reliable detector, and the intent markers the
owner originally described ("let me", "now", "proceeding") show essentially zero separation at 1.02×. Wording is dead as
a signal, now confirmed on a corpus four times larger than the one that first suggested it.

### Where the agent message and the tool action sit

In 5,000 sampled completed turns: 4,030 contain at least one tool action, 970 contain none. Both are normal outcomes. A
turn containing no tool call is not itself anomalous, which is the arithmetic reason no response-shape detector can
work.

## The round-5 model contrast was confounded, and is retracted

> **Corrected a second time.** Round 6's retraction correctly identified the `originator` confound but over-corrected,
> reporting a contrast that lost significance (p = 0.43) under a small control. The right restriction is not originator
> but whether the thread has any user message; on that population the contrast is 27× at p ≈ 1.2e-18. See "The
> controlled result, after correcting for the round-6 over-correction". The unmatched 22× below remains wrong.

The control group was not matched. Classifying threads by `originator`:

| Population                                                           | Threads   |
| -------------------------------------------------------------------- | --------- |
| GPT-family control threads with `originator = '(none)'`              | **5,433** |
| GPT-family control threads from all interactive originators combined | 164       |
| DeepSeek threads from interactive originators                        | 88        |

`originator = '(none)'` marks threads that are not interactive clients. A non-interactive thread cannot be resumed by
the owner typing `ok`, because there is no owner attached to it, so it contributes a structural zero to the
acknowledgement count. The 22× figure was interactive DeepSeek against mostly non-interactive GPT.

### Matched comparisons, which give a much smaller and less stable effect

| Comparison                      | DeepSeek         | GPT           | Ratio | Fisher p |
| ------------------------------- | ---------------- | ------------- | ----- | -------- |
| Interactive originators only    | 52/2,792 (1.86%) | 4/958 (0.42%) | 4.46× | 0.0006   |
| `codex_chatgpt_ios_remote` only | 41/2,454 (1.67%) | 2/246 (0.81%) | 2.06× | 0.43     |
| `codex_exec` only               | 0/75 (0.00%)     | 0/244 (0.00%) | —     | 1.0      |

The effect moves from 4.46× at p = 0.0006 to 2.06× at p = 0.43 depending on where the cut is placed, so it is sensitive
to the choice of control. What is stable is the direction: DeepSeek shows more acknowledgements than GPT in every
matched comparison, and the effect is largest in interactive sessions.

### The strongest single fact in the whole investigation

Within `originator = codex_exec`, both families are at **exactly zero** — 0/75 DeepSeek and 0/244 GPT. Every one of the
52 DeepSeek acknowledgements in the matched set arises in an interactive session.

That is consistent with two readings that these data cannot separate:

1. The stall is a DeepSeek-tier behavior that only becomes observable when an owner is present to resume it.
2. The stall is an interaction between these tiers and the interactive client's request shape, and does not occur in
   headless runs.

Reading 2 would explain why the symptom is invisible in error accounting and why it resists every response-side test:
the defect would be in the request the interactive client builds, which differs from what `codex_exec` builds.

### Ultra remains the worst tier, but the sample is small

| Model                                   | Turns | Acks | Rate  |
| --------------------------------------- | ----- | ---- | ----- |
| `deepseek-ai/DeepSeek-V4.1-Flash-ultra` | 193   | 7    | 3.63% |
| `deepseek-flash`                        | 2,632 | 45   | 1.71% |
| `deepseek/deepseek-v4-pro`              | 162   | 0    | 0.00% |

Seven acknowledgements is too few to be conclusive on its own. The tier ranking is suggestive, not established.

## The controlled result, after correcting for the round-6 over-correction

Round 6 retracted the round-5 model contrast because the GPT control was dominated by `originator = '(none)'` threads.
That retraction was correct about the confound but over-corrected: matching on originator within interactive clients
leaves a small control, while the right restriction is simply **threads that have any user message at all**.

The metric's floor was checked before trusting it, because an acknowledgement can only exist where an owner is present:

| Family   | Interactive threads | Ack distribution                |
| -------- | ------------------- | ------------------------------- |
| DeepSeek | 163                 | 141 threads at 0 acks (86.5%)   |
| GPT      | 2,035               | 2,025 threads at 0 acks (99.5%) |

The floor is real and not circular: most interactive threads in both families have zero acknowledgements, so the
measurement is not an artifact of interactivity.

### Result on the correctly restricted population

Both metrics agree once the restriction is "thread has any user message".

| Metric                                                 | DeepSeek          | GPT                | Ratio | Fisher p |
| ------------------------------------------------------ | ----------------- | ------------------ | ----- | -------- |
| Per thread with ≥1 ack                                 | 22/163 (13.50%)   | 10/2,035 (0.49%)   | 27.5× | 1.2e-18  |
| Per turn                                               | 52/2,873 (1.810%) | 10/10,812 (0.092%) | 19.6× | 4.3e-26  |
| Per turn, same cut without the interactive restriction | 52/3,047 (1.71%)  | 10/13,136 (0.08%)  | 22.4× | —        |

Per-thread and per-turn agree in direction and magnitude, which is the cross-check the round-5 figure never had. The
per-thread figure is larger because it asks "does this session stall at all" rather than "what fraction of turns stall",
and a session that stalls once is counted once.

### Why the round-6 retraction failed, precisely

Round 6 matched on `originator`, which sounds stricter but is smaller and mixes populations with different base rates:

| Originator                 | DeepSeek turns | Rate  | GPT turns | Rate  |
| -------------------------- | -------------- | ----- | --------- | ----- |
| `codex_chatgpt_ios_remote` | 2,454          | 1.67% | 246       | 0.81% |
| `codex-tui`                | 31             | 3.23% | 656       | 0.30% |
| `Codex Desktop`            | 51             | 0.00% | 56        | 0.00% |
| `codex-remote-watchdog`    | 256            | 3.91% | 0         | —     |

Only two of the four originators contain both families at usable size, and they disagree in strength — 2×(p = 0.43) in
the largest, 11×(p = 0.13, 31 turns) in the other. Pooling them is what the controlled result above does, and pooling
across interactive originators is the defensible cut: the question is whether the tier family differs, not whether it
differs within one particular front end.

The honest caveat: the contrast is not significant within any single originator at the sample sizes available. It is
robust pooled, and the direction is consistent in every originator that has both families.

### A confound that was tested and rejected

DeepSeek interactive threads are 20% reasoning items against 3.9% for headless DeepSeek, while GPT is around 48%, which
looked like a candidate cause. Tested within DeepSeek only:

| DeepSeek subset                 | Turns | Acks | Rate  |
| ------------------------------- | ----- | ---- | ----- |
| Threads without reasoning items | 2,178 | 41   | 1.88% |
| Threads with reasoning items    | 869   | 11   | 1.27% |

p = 0.28. The apparent effect was the model-family split re-encoded, not a cause. Reasoning presence is not implicated.

## The symptom has a start date, and it is not attributable to a version

It behaves like something introduced, not like a constant property of the tiers. DeepSeek acknowledgement rate by date:

| Date       | Turns | Acks | Rate      |
| ---------- | ----- | ---- | --------- |
| 2026-08-14 | 154   | 0    | 0.00%     |
| 2026-09-18 | 114   | 0    | 0.00%     |
| 2026-09-19 | 114   | 9    | **7.89%** |
| 2026-09-20 | 643   | 15   | 2.33%     |
| 2026-09-21 | 778   | 12   | 1.54%     |
| 2026-09-22 | 746   | 5    | 0.67%     |
| 2026-09-23 | 255   | 4    | 1.57%     |
| 2026-09-24 | 114   | 6    | 5.26%     |
| 2026-09-25 | 59    | 1    | 1.69%     |

Zero of 319 DeepSeek turns before 2026-09-19 are acknowledged; the behavior appears on 09-19 and persists. The onset is
real and the pre-onset corpus is clean.

### It is the model, not the client version — and round 9's version hypothesis is refuted

Round 9 noted that CLI 0.155.1 is exactly the version in use from 09-19 and proposed a Codex 0.155 change as a
candidate. Comparing families _within_ each version refutes that, because the direction reverses:

| CLI version | DeepSeek         | GPT family    | Direction           |
| ----------- | ---------------- | ------------- | ------------------- |
| 0.154.0     | 0/154 (0.00%)    | 4/714 (0.56%) | DeepSeek **lower**  |
| 0.155.1     | 41/2,362 (1.74%) | 0/158 (0.00%) | DeepSeek **higher** |

No client version can produce a reversal of that kind. Version is neither necessary nor sufficient.

The post-onset breakdown holds the version fixed and varies the model — the comparison that isolates the variable:

| Model            | CLI version | Window      | Turns | Acks | Rate  |
| ---------------- | ----------- | ----------- | ----- | ---- | ----- |
| `deepseek-flash` | 0.155.1     | after 09-19 | 2,362 | 41   | 1.74% |
| `gpt-6-astra`    | 0.155.1     | after 09-19 | 88    | 0    | 0.00% |
| `gpt-5.6-luna`   | 0.155.1     | after 09-19 | 24    | 0    | 0.00% |

Same client version, same gateway, same period, and only the DeepSeek tier stalls. And the reverse control, holding the
period fixed at 09-16 to 09-18 where both families ran 0.154.0:

| Family     | CLI version | Window         | Turns | Acks |
| ---------- | ----------- | -------------- | ----- | ---- |
| DeepSeek   | 0.154.0     | 09-16 to 09-18 | 154   | 0    |
| GPT family | 0.154.0     | 09-16 to 09-18 | 45    | 0    |

Both null before the onset. So the pre-onset DeepSeek corpus is genuinely clean rather than merely small.

The GPT acknowledgements on 0.154.0 come from 09-10 to 09-12, when DeepSeek was not running at all, which is why the
naive version table in the previous section appears to favour DeepSeek. Restricting to the window where both families
actually ran the same version removes the artifact.

### A sampling-call count that looked like a strong signal, and the correction that killed it

Counting `run_sampling_request` occurrences per turn gave the most striking separation so far:

| Family     | Turns | Median calls | p90 | Mean  |
| ---------- | ----- | ------------ | --- | ----- |
| DeepSeek   | 489   | **48**       | 300 | 113.5 |
| GPT family | 951   | **5**        | 42  | 38.7  |

And within turns, stall rate rose monotonically with the count: 0.13% at 1–10 calls, 1.32% at 11–30, 1.68% at 31–60,
1.21% at 61–200, 3.48% at 200+.

Both readings are artifacts. The `run_sampling_request` span is emitted once per **span event**, not once per request —
1,440 turns carry 92,282 such lines, an average of 64 per turn — so the count measures log verbosity, which differs by
model, rather than work done.

Counting actual upstream calls instead, using the `Request completed method=POST .../responses` line, gives:

| Family     | Turns | Median HTTP requests | p75 | p90 | Mean |
| ---------- | ----- | -------------------- | --- | --- | ---- |
| DeepSeek   | 481   | 5                    | 11  | 30  | 10.4 |
| GPT family | 858   | 1                    | 1   | 6   | 3.0  |

And within DeepSeek, comparing stalled against normal turns:

| DeepSeek turns | Count | Median HTTP requests |
| -------------- | ----- | -------------------- |
| Stalled        | 13    | **4**                |
| Normal         | 468   | **5**                |

Stalled DeepSeek turns make _fewer_ requests than normal ones, so the apparent "stalls need more work" relationship
reverses once the measurement is correct. The direction is now consistent with the symptom: a turn that stops early does
less work than one that runs to completion.

This is the fifth measurement in this investigation whose apparent effect reversed or dissolved under a corrected
control, and the ratio-correction pattern is worth noting on its own: DeepSeek shows about 5 requests per turn against 1
for the GPT family, which is a real difference in turn length and would have been easy to mistake for the defect.

### The prompt itself was tested, and it is not a factor either

The user-visible prompt is the one input the investigation had never examined. Threads that stall do have a somewhat
longer longest-prompt than clean threads (median 271 characters against 182, p90 2,693 against 1,720, over 32 stalled
and 2,169 clean threads), which suggested the task's size might matter.

Tested within DeepSeek only, splitting threads at a 500-character longest prompt:

| DeepSeek threads                 | Threads | Stalled | Rate   |
| -------------------------------- | ------- | ------- | ------ |
| Longest prompt over 500 chars    | 25      | 6       | 24.00% |
| Longest prompt 500 chars or less | 138     | 16      | 11.59% |

Fisher p = 0.74. The cells are too small — 6 and 16 stalled threads — for the apparent twofold difference to mean
anything, and the first prompt of a thread shows no difference at all (median 112 against 128 characters). Recorded as
tested and inconclusive rather than as a weak positive; a larger DeepSeek corpus would be needed to settle it.

### Holding turn length constant: the stall rate does not depend on it

Round 12 noted that any between-family comparison must hold turn length constant, because the families differ on it by
about five times. Doing that within DeepSeek, by exact upstream request count:

| Requests | Turns | Stalls | Rate   |
| -------- | ----- | ------ | ------ |
| 1        | 48    | 1      | 2.08%  |
| 2        | 82    | 2      | 2.44%  |
| 3        | 54    | 2      | 3.70%  |
| 4        | 51    | 2      | 3.92%  |
| 5        | 25    | 0      | 0.00%  |
| 6        | 34    | 2      | 5.88%  |
| 7 to 30  | 122   | 0      | 0.00%  |
| 35       | 6     | 2      | 33.33% |

The middle of that table invites a claim that stalls are confined to short turns — 1 to 4 requests look elevated and 5
to 30 look empty. Collapsing it properly shows the claim does not hold:

| DeepSeek turns       | Stalls | Turns | Rate  |
| -------------------- | ------ | ----- | ----- |
| 4 requests or fewer  | 7      | 235   | 2.98% |
| More than 4 requests | 6      | 246   | 2.44% |

Fisher p = 0.78. The zero-stall run from 7 to 30 requests is a gap in a sparse table, not a boundary; stalls reappear at
35 requests, and the GPT family shows 0/858 at every length. Any statement that stalls are specific to short turns would
have been reading a table rather than testing a hypothesis, which is the same error as the round-11 bare-response rate.

Turn length is therefore not a factor, and stalls are spread across all lengths at roughly the same rate. Combined with
the DSH control, the onset, and the model specificity, the description of the defect is now: roughly 2 to 3% of DeepSeek
turns end before the work is done, at any turn length, in any session shape, with no distinguishing response feature.

### A separate real finding: DeepSeek turns are much longer per turn

Independent of the defect, the item counts show a large structural difference between the families:

| Family     | Turns  | Median items per turn | p90 | Median turns per thread |
| ---------- | ------ | --------------------- | --- | ----------------------- |
| DeepSeek   | 2,852  | 4                     | 25  | 1                       |
| GPT family | 11,954 | 7                     | 58  | 2                       |

DeepSeek runs more threads with fewer turns each, and its per-turn item count is lower while its per-turn upstream call
count is higher. Any future comparison between these families must hold turn length constant, because the two families
differ on it by a factor of about five.

### The raw item stream was captured, and a text-only response is normal for both families

`~/.codex/logs_2.sqlite` records one line per upstream output item under `codex_core::stream_events_utils`:

```
Output item item_type="function_call" item_id="resp_6d403386e87a4dabaa942a267eba8bb1_fc_0"
Output item item_type="message"       item_id="resp_6d403386e87a4dabaa942a267eba8bb1_msg_0"
```

Grouping by the `resp_` prefix reconstructs the item sequence of each upstream response, which is the closest available
substitute for capturing raw bodies. 4,367 DeepSeek responses and 3,307 GPT-family responses were reconstructed, and 438
DeepSeek responses contain no `function_call` at all — a bare, text-only response, 10.0%. That looked like the defect.

Attributing responses to a family by thread rather than by span text is what corrects it:

| Family     | Bare responses | With a tool call | Rate       |
| ---------- | -------------- | ---------------- | ---------- |
| DeepSeek   | 114            | 946              | **10.75%** |
| GPT family | 324            | 2,983            | **9.80%**  |

A text-only response is normal for both families, at essentially the same rate. This is the same trap as every earlier
feature: the raw rate looks damning and the control removes it.

It also explains the "7,630 times Codex continues past a text item" figure from the earlier rounds. Text-only responses
are frequent and are almost always followed by a continuation; the defect is not the existence of such a response but
the specific case where the turn then ends.

The one thing the item stream does confirm, which was previously argued from source reading alone: the terminal item is
never a special kind. Responses end in `function_call`, `message`, or very rarely `reasoning`, and every completed turn
in `thread_items` ends on an agent message. The terminal kind carries no information, now measured rather than inferred.

### The `phase` field looked like a separator and is not one

`agentMessage` items carry a `phase` field (`commentary` or `final_answer`) that had not been tested. For the DeepSeek
tiers it looked decisive: every one of the 236 stalled agent messages lacks a phase, against 92.2% of the 10,530
non-stalled ones. Fisher p = 1.3e-08, and the odds ratio is unbounded in this sample.

It is a dead end, and the reason is worth recording because it is the same trap that consumed the earlier text-shape
features. Precision rather than sensitivity is what decides whether a feature can be used:

| DeepSeek message | Stalled | Total | Precision |
| ---------------- | ------- | ----- | --------- |
| Without a phase  | 236     | 9,944 | **2.37%** |
| With a phase     | 0       | 822   | 0.00%     |

The base rate is about 2.2%, so a phase-less message is 2.37% likely to be stalled against 2.2% for any message. The
feature is worthless as a detector even though the association is statistically strong, because 97.6% of phase-less
messages are ordinary completions. GPT-family messages carry a phase 97.9% of the time, so the field also encodes the
provider rather than the behavior.

This is the fourth feature to show a real association and no usable precision, after response shape, item type, and
token counts. Any future candidate should be reported with precision at the observed base rate, not with p alone.

### The version/date confound cannot be broken with this corpus

The boundary is clean on the model side and absent on the control side:

| Family                          | CLI before 0.155  | CLI 0.155+       | Comment                     |
| ------------------------------- | ----------------- | ---------------- | --------------------------- |
| DeepSeek                        | 0/334 (0.00%)     | 52/2,713 (1.92%) | p = 0.005                   |
| GPT family, full history        | 10/12,975 (0.08%) | 0/171 (0.00%)    | unchanged                   |
| GPT family, 09-16 to 09-24 only | 0/65 (0.00%)      | 0/171 (0.00%)    | unchanged inside the window |

The third row is the important control: GPT-family threads ran under both versions inside the same calendar window as
the DeepSeek onset, and neither side shows an acknowledgement. The 0.155 upgrade therefore did not produce this behavior
for the GPT family, so whatever 0.155 changed, it interacts with the DeepSeek tiers specifically.

That still does not separate version from date, because for DeepSeek the two move together with only three exceptions:

| DeepSeek subset      | Window              | Turns | Acks |
| -------------------- | ------------------- | ----- | ---- |
| CLI 0.154            | 09-16 to 09-18 only | 154   | 0    |
| CLI 0.155+           | 09-18 onward        | 2,713 | 52   |
| CLI older than 0.154 | 08-14 to 08-25      | 180   | 0    |

There is no DeepSeek 0.154 turn after 09-19 and no DeepSeek 0.155 turn before 09-18. A version effect and a calendar
effect are therefore indistinguishable here, and the corpus cannot supply the missing cell.

### DSH is the control that rules out the gateway, and it has no onset

DSH runs against the same `:7999` gateway and the same model, so if the 2026-09-19 onset were produced by the gateway or
the upstream, DSH would show it too. DSH has continuous session coverage across the date: 1,385 sessions from 2026-08-14
to 2026-09-26, with 47 turns recorded on 09-19 itself.

Measuring the DSH analogue of a text-only turn — a turn containing no `tool/call` event at all:

| Window            | Bare turns | Total turns | Rate  |
| ----------------- | ---------- | ----------- | ----- |
| Before 2026-09-19 | 114        | 2,005       | 5.69% |
| 2026-09-19 onward | 60         | 951         | 6.31% |

Flat. No discontinuity, and the rate is an order of magnitude higher than the Codex endpoint in both windows, which is
the expected consequence of DSH's loop closing turns differently rather than the two being comparable quantities.

The combination is what matters:

| Series                      | Before 09-19                                     | After 09-19      | Behavior      |
| --------------------------- | ------------------------------------------------ | ---------------- | ------------- |
| Codex, DeepSeek tiers       | 0/334 (0.00%)                                    | 52/2,713 (1.92%) | discontinuity |
| Codex, GPT family           | steady ~0.2% background across July to September | no onset         | steady        |
| DSH, same gateway and model | 5.69%                                            | 6.31%            | no onset      |

A gateway-side or upstream-side change would move the DSH series and, if model-specific, would move only its DeepSeek
portion. It moves neither. A change confined to the Codex client is the remaining explanation consistent with all three
series, and it is the only one.

This supersedes the round-8 note that the cause "has to be either what the request asks for or what the upstream
returns". The upstream is now excluded by measurement, leaving the request the Codex client builds.

### The GPT baseline also clarifies what the symptom is not

GPT-family acknowledgements are spread evenly across July to September at a steady 0.2%, with no onset: single
acknowledgements on 08-06, 08-08, 08-14, 08-21, 09-07, 09-10, 09-11 and a pair on 09-12. A steady low background rate is
present in every client and every month, so a handful of acknowledgements at zero cost across a long history is not
evidence of the defect. The DeepSeek signal is a discontinuity on top of that background, not an exaggeration of it.

The date onset is worth recording anyway, because it narrows what to look for: something that changed on or around
2026-09-19, affecting only the DeepSeek Flash tier family, and leaving the GPT family untouched.

## The acknowledgement metric was measuring the wrong thing, and this is the central correction

> **Partly superseded.** The observation below — that `ok` does not detect failure — is correct, and the initial
> conclusion drawn from it was that no defect exists. That went too far. A better continuation signal (`proceed`) shows
> the defect is real but lies in the GPT family rather than the DeepSeek tiers. See "The corrected outcome measure, and
> the reversal it produces".

Reading the actual text of the 57 DeepSeek turns a user replied `ok` to changes the interpretation of every measurement
above. Those turns are not stalls. Their outputs are mid-task narration:

- "The selector switches look like they live in `experiments/prospector_live`... Reading that subtree's rules and the
  performance reco..."
- "CI is green. Merging and deploying."
- "Deployed as `vps-888a94d8`. Now the required acceptance: public health identity plus a direct Mac-to-VPS
  authenticated inference request."
- "17 of these had MERGED PRs — so they're integrated-by-squash, not rejected. Let me verify that before choosing tag
  prefixes."
- "Let me verify the skill I unwrapped is still structurally intact — that transform touched 364 lines."
- "Good understanding. Let me read the remaining flow logic I need to mirror, and check the current dev server port."

And measuring what those turns actually did:

| DeepSeek turns preceding an acknowledgement                              | Count | Share     |
| ------------------------------------------------------------------------ | ----- | --------- |
| Contained tool actions (`commandExecution`, `fileChange`, `mcpToolCall`) | 54    | **94.7%** |
| Contained no tool actions                                                | 3     | 5.3%      |

**94.7% of the turns being counted as stalls completed real work.** The three that did not are cases where the model was
correct to answer without tools: an empty prompt, "what are you workign on", and a bare URL with "found it".

Note the limit of this measurement, which was missed at the time: a turn that performs three tool calls and then stops
half-way through a twenty-step job also "contains tool actions". Counting tool activity distinguishes a turn that did
nothing from one that did something, but not one that did enough from one that stopped short. The conclusion drawn here
— that there was no failure to reproduce — was therefore wrong in the opposite direction, and the corrected result is
under "The corrected outcome measure".

So the metric was counting a normal conversational event — the owner acknowledging a progress update mid-task, or
replying to a question — and treating it as a failure. The reason the rate was stable, spread across all turn lengths,
showed no response-shape signature, had no error accounting, and never reproduced in DSH is now explained: **there was
no failure to reproduce.**

Every statistical comparison in this document stands as arithmetic. What does not stand is the inference drawn from it,
that a DeepSeek-specific mid-turn stop was measured at 19.6 times the GPT rate. On the corrected reading, that 19.6× is
a measure of how often the owner acknowledges a progress update, and it differs by model because the two families
present progress differently — DeepSeek narrates its next step in the final text of a turn, and the GPT family does not.

The owner's original report was that turns stop midway through the task and need to be resumed. The evidence now
supports a narrower and different statement: DeepSeek's turns end on a text message that reads like an announcement of
the next action, which invites the owner to reply and continue. Whether any of those cases genuinely stopped early,
rather than merely appearing to, cannot be determined from this corpus, and the 94.7% figure says most did not.

## The corrected outcome measure, and the reversal it produces

The `ok` count used for thirteen rounds was a poor workaround signal. Enumerating every short user message in the corpus
gives a much better one: **`proceed`**, 226 occurrences against 62 for `ok`, and unlike `ok` it is an unambiguous
instruction to continue — nobody tells a finished task to proceed.

Counting turns that contain a continuation instruction (`proceed`, `continue`, `go ahead`, `keep going`, `finish`,
`do it`, `next`, `yes`) and comparing families:

| Family     | Turns  | Turns with a continuation instruction | Rate      |
| ---------- | ------ | ------------------------------------- | --------- |
| DeepSeek   | 3,033  | 35                                    | **1.15%** |
| GPT family | 13,017 | 200                                   | **1.54%** |

Fisher p = 0.13. **The direction is the opposite of the one reported for the first twelve rounds.** On the better
measure, the GPT family is nudged to continue more often than the DeepSeek tiers, not less, and the difference is not
significant at this sample size.

Per model, the spread that the earlier rounds attributed to the DeepSeek Flash tiers is absent:

| Model                                   | Turns | Continuation turns | Rate  |
| --------------------------------------- | ----- | ------------------ | ----- |
| `gpt-5.3-codex-spark`                   | 181   | 7                  | 3.87% |
| `gpt-5.6-sol`                           | 3,033 | 67                 | 2.21% |
| `gpt-6-astra`                           | 1,180 | 25                 | 2.12% |
| `gpt-5.6-luna`                          | 3,934 | 62                 | 1.58% |
| `gpt-5.6-terra`                         | 2,901 | 38                 | 1.31% |
| `deepseek-flash`                        | 2,626 | 33                 | 1.26% |
| `deepseek-ai/DeepSeek-V4.1-Flash-ultra` | 193   | 2                  | 1.04% |
| `deepseek/deepseek-v4-pro`              | 160   | 0                  | 0.00% |

Every DeepSeek tier sits at or below every GPT tier with a usable sample. The owner's own reading matches this: the GPT
family stops more, and the weakest GPT tiers most of all.

### Why the first twelve rounds inverted it

`ok` is used for two different things, and the split differs by model. It is a genuine acknowledgement of a completed
answer, and it is also a nudge to continue. DeepSeek's turns end on a message that announces the next action, which
invites `ok` as a nudge; the GPT family ends on flatter text that invites `ok` as an acknowledgement. Counting `ok`
therefore measured how each family ends a turn rather than how often it stops short.

The reversal also disposes of the onset. The 2026-09-19 discontinuity in `ok` rate was a change in how often the owner
typed `ok`, not in how often turns failed, and the version analysis that grew out of it was measuring the same artifact.

### What replaces the earlier conclusion

The defect the owner reports is real and the client is the cause, but its signature is not model-specific in the way
this document argued. The accurate statement available from this corpus is that a response containing no tool call ends
the turn, and that all these tiers reach that state routinely. The tiers differ in how often the owner responds with a
continuation instruction, and on that measure the GPT family is worse.

> **A `k`-only continuation signal would sharpen this further.** There are zero bare `k` messages in this corpus, so the
> cleaner signal the owner pointed to is not present in `~/.codex` and its location is still unconfirmed.

> **Superseded in part by "Separating accidental stops from real ones".** The rates below do not remove accidentally
> interrupted turns, which are heavily concentrated in the GPT family and which inflate every GPT figure. The direction
> survives the correction; the magnitudes do not.

## Separating accidental stops from real ones, which is the decisive correction

The owner identified a confound that invalidates the continuation-instruction metric as it was first computed: a
`proceed` is often typed after an **accidentally interrupted** turn, where a stray ESC or a mis-clicked stop button
ended the turn by hand. Those are not model failures and must be removed.

`thread_turns.status` records this directly, with values `completed`, `interrupted`, `failed`, and `inProgress`.
Splitting every continuation instruction by the status of the turn it follows:

| Family     | Turns  | Nudge after **completed** | After **interrupted** | After other |
| ---------- | ------ | ------------------------- | --------------------- | ----------- |
| DeepSeek   | 3,047  | **11**                    | 2                     | 22          |
| GPT family | 13,138 | **76**                    | 38                    | 80          |

Two distinct facts fall out, and they point in opposite directions:

1. **Accidental stops are overwhelmingly a GPT-family event.** The corpus holds 1,354 interrupted GPT turns against 79
   DeepSeek, a 17× difference. Whatever the owner is hitting ESC on, it is mostly the GPT runs.
2. **Real mid-task stops, defined as a continuation instruction after a turn that completed normally**, are still more
   frequent in the GPT family: 76/13,138 = 0.578% against 11/3,047 = 0.361%. Ratio 1.60×, Fisher p = 0.17.

The remaining 84 non-completed predecessors are `failed` turns, and 18 are `inProgress`; both are correctly excluded,
since a failed turn is not a model stopping short.

### The corrected conclusion

On the cleanest measure available, the GPT family stops mid-task roughly 1.6 times as often as the DeepSeek tiers, and
the difference is not statistically significant at this sample size. The DeepSeek-specific defect asserted in the first
twelve rounds of this document does not exist on this evidence.

Per model, on the defect rate alone:

| Model                                   | Turns | Mid-task stops | Rate  |
| --------------------------------------- | ----- | -------------- | ----- |
| `gpt-5.3-codex-spark`                   | 192   | 4              | 2.08% |
| `gpt-6-astra`                           | 1,192 | 17             | 1.43% |
| `deepseek-ai/DeepSeek-V4.1-Flash-ultra` | 193   | 2              | 1.04% |
| `gpt-5.6-sol`                           | 3,089 | 25             | 0.81% |
| `gpt-5.6-terra`                         | 2,945 | 14             | 0.48% |
| `gpt-5.6-luna`                          | 4,005 | 15             | 0.38% |
| `deepseek-flash`                        | 2,632 | 9              | 0.34% |
| `deepseek/deepseek-v4-pro`              | 162   | 0              | 0.00% |

The weakest GPT tiers (`codx-spark`, `astra`) are the worst offenders, and the best DeepSeek tier is in the middle of
the GPT range rather than at the bottom. This matches the owner's own reading that the GPT family stops more, and that
its weakest models stop most.

A residual caution: the interruptions are not evenly distributed across models, so a metric that failed to remove them
would attribute GPT's accidental stops to whichever family the owner interrupted most. That is exactly what happened in
the earlier rounds.

## Root cause

> **Superseded by the correction above.** This section asserted a false-complete mechanism on the strength of the
> acknowledgement rate. That rate is now known to be a normal conversational event — 94.7% of the turns it counts
> completed real work — so no root cause has been established. The section is retained because its mechanical account of
> how Codex closes a turn is accurate and worth keeping.

Codex closes a turn when a model response contains no tool call. DeepSeek tiers under this route emit an intent line
without a tool call more often than the OpenAI models Codex was designed against. The two facts were believed to combine
into a false-complete: the client believes the model chose to stop, when the model intended to continue.

What remains verified independently of the metric: a response containing no tool call does end the turn, and the
decision unit is the response rather than the text block. What is not established is that DeepSeek reaches that state
more often in a way that constitutes a defect.

The claim that this is a client-side continuation-policy difference rather than a gateway defect does hold, and every
gateway probe returned healthy, fully-formed responses:

| Probe                          | Result                                            |
| ------------------------------ | ------------------------------------------------- |
| Chat Completions, generous cap | `finish_reason: stop`, 10,742 visible chars       |
| Responses, no cap              | `status: completed`, 9,283 visible chars          |
| Responses, long streaming turn | `response.completed`, 694 text deltas             |
| Reasoning effort none/high/max | 0 / 5225 / 8912 reasoning tokens, all `completed` |

Reasoning effort behaves exactly as documented and is not implicated.

## Why a gateway patch was considered, and why it is refuted

The reasoning was that the gateway already rewrites this route in both directions, so it could supply the continuation
signal the client does not ask for.

**That reasoning does not survive the backtest.** A gateway continuation requires deciding "work remains", and the only
input available is the response shape. That shape is identical for a false completion and for every one of the 2,534
legitimate completions, so a gateway rule would fire on normal answers. Making the decision instead by asking the model
is inference, and this repository already retired exactly that construction in `be89f4919` ("retire hidden DeepSeek
continuation inference") on the grounds that invisible extra inference is never permitted.

Both candidate mechanisms below are therefore withdrawn:

1. ~~Keep-alive / non-terminal framing~~ — cannot distinguish a false completion from a final answer.
2. ~~Server-side continuation~~ — requires either a detector that scores 1.8% or unconsented hidden inference.

The gateway is not the right lever. Note also that the route already carries scoped custom patching for LithosAI, so a
patch there would be technically easy and would still be wrong.

## Proposed patch surface — withdrawn

Falsified by the backtest above. Retained only to record what was considered and why it fails.

A new module (working name `src/provider/lithos-continuation.ts`) would have owned the detector and the injection, gated
to `deepseek-ai/DeepSeek-V4.1-Flash-ultra`, in the scoped-patch style this route already uses (`src/provider/lithos.ts`,
`lithos-handlers.ts`, `lithos-rate-limits.ts`, `lithos-streams.ts`).

The detector below is the one that scores 1.8% precision. It is logically unsound, not merely untuned:

```
stop_is_false_complete(response) :=      # REFUTED — 1.8% precision, 2,534 false positives
      response ends with an assistant message item
  AND that item carries no tool call
  AND no terminal error is present
  AND the turn's continuation budget is unexhausted
```

The first two clauses match every legitimate final answer. No value of the remaining clauses repairs that.

## Acceptance criteria — withdrawn with the patch

These applied to the gateway continuation and are void now that the detector is refuted. Retained for the record: any
future candidate, gateway-side or client-side, must meet them before it is relied on.

- A DeepSeek Ultra turn whose intent-only response would have ended the turn instead continues and reaches a tool call.
- **Zero false positives on the 2,534 legitimate completions in the backtest corpus.** This is the criterion the
  withdrawn detector failed, and it is the one that matters: a continuation that fires on a normal answer is worse than
  the symptom.
- Non-Ultra tiers, other providers, and the Chat Completions path are byte-identical to current behavior.
- `deno task test` passes, with new coverage and a recorded-upstream fixture replayed through `scripts/replay.ts`.
- A decision entry is appended to `docs/provider-decision-journal.md` (behavior) or `docs/DECISIONS.md` (policy),
  following the established format: decision, behavior, reversal risk, residual gap.

## Reversal risk and residual gap

Reversal risk, as measured rather than predicted: the withdrawn detector's risk was not hypothetical. At 1.8% precision
it would have converted 2,534 legitimate completions into extra round trips for every 46 real stops it caught. The
measured ratio is the reason the patch is withdrawn rather than tuned.

Residual gap: the symptom is not fixed by this document, and no fix is currently proposed that satisfies both the
deterministic rule and the no-false-positive requirement. Five rounds of candidates have been refuted against the logs,
each time by the same arithmetic: every response-shape feature that matches the failures also matches thousands of
legitimate completions, because ending on text with no tool call is the normal shape of a finished turn.

What the backtests establish is the constraint an acceptable answer must satisfy: it must not infer "unfinished" from
the response, because that signal is not present in the response, in the turn record, or in the item types. The two
directions still open are changing the request the model receives, and referencing state the owner authorized in
advance. Neither has been prototyped.

## Unresolved

The position after thirteen rounds, stated as plainly as the evidence allows:

**Established.** Codex ends a turn when a whole response carries no tool call. Every tier served by this gateway reaches
that state routinely, and a text-only response is normal rather than exceptional. The owner's report of turns ending
mid-task is real, and on the cleanest metric available — a continuation instruction after a turn that completed normally
— the GPT family does it about 1.6× as often as the DeepSeek tiers (0.578% against 0.361%), with the weakest GPT tiers
worst. That difference is not statistically significant at this sample size, so it should be read as a direction
supported by the data rather than a confirmed effect.

**Not established.** Why any turn stops short. No response-shape, item-type, token, duration, wording, `phase`,
reasoning, effort, turn-length, turn-shape, or prompt-length feature separates a turn that stopped short from one that
finished, and no cap or limit is hit. If a mechanism exists, it is not visible in this corpus.

**Ordered next steps.**

1. **Locate the `k` continuation corpus.** There are zero bare `k` user messages in `~/.codex` across all 16,267 turns,
   any capitalisation, and zero in the DSH sessions. The owner reports using `k` as a shorter nudge, so it is stored
   somewhere not yet identified. A `k`-only signal would remove the `ok` ambiguity that inverted the first twelve
   rounds.
2. **Filter `interrupted` in every future measurement.** Any metric built on the owner's next message must exclude turns
   whose status is `interrupted` or `failed`. This is the single highest-value precaution recorded here.
3. **Establish an outcome measure before measuring anything else.** The corpus has no record of what a task required, so
   a turn that stopped short and a turn that correctly yielded are indistinguishable except through the owner's
   judgement. Either the owner marks a set of known-bad turns, or a forward-looking capture records intent before a turn
   and verifies completion after it. Without one of these, further rounds will keep producing strong statistics about
   conversation.

Stated precisely, the following are now _established negative_ results and should not be re-tested:

- No response-shape, item-type, token, duration, or wording feature separates a stall from a legitimate completion.
- Both client loops terminate on the same rule; DSH is not more tolerant of mid-turn text.
- Fragmented tool calls are merged identically by DSH and by this gateway.
- Every completed turn ends on an assistant message, so the terminal item kind carries no information.
- The existing server-side continuation reminder is live, correctly scoped, and does not reduce the rate.
- Reasoning-item presence is not implicated: within DeepSeek the contrast is 1.88% versus 1.27%, p = 0.28.
- ~~The gateway and the upstream are not implicated: DSH, on the same gateway and model, shows 5.69% before 2026-09-19
  and 6.31% after.~~ **Withdrawn.** The owner confirmed the DSH sessions in question were gateway-debugging work, so the
  DSH series is not a control and this argument cannot be used. The gateway remains unexcluded by any measurement here.
- ~~The symptom has an onset of 2026-09-19.~~ **Withdrawn.** The discontinuity was in how often the owner typed `ok`,
  not in failure rate, and it was a property of the corpus rather than of the system.
- The specific gateway commit that matches the onset date and DeepSeek scope, `fbb0383a7`, changes only usage accounting
  and cannot affect turn termination. The other commits in that window are usage, admin layout, and docs.
- **The CLI version is not implicated**: on the same 0.155.1, `gpt-6-astra` is 0/88 and `gpt-5.6-luna` is 0/24 while
  `deepseek-flash` is 41/2,362, and the family ordering reverses between 0.154.0 and 0.155.1.
- **`thread_turns.status` must be used to filter**. `interrupted` marks an accidental owner-side stop (stray ESC or the
  stop button) and is heavily concentrated in the GPT family: 1,354 GPT turns against 79 DeepSeek. Any metric built on
  the owner's next message must exclude both `interrupted` and `failed` predecessors, or it will attribute the owner's
  own mis-clicks to the model.
- The `phase` field on `agentMessage` is not a usable detector: 236/236 stalled messages lack a phase, but so do 9,708
  of 10,530 normal ones, giving 2.37% precision against a 2.2% base rate.
- DeepSeek `reasoning` items carry no readable content (empty `content`, summary only) and are identical before and
  after the onset, so they carry no signal for this question.
- A text-only upstream response is not the defect. Reconstructed from the item stream, DeepSeek produces them at 10.75%
  and the GPT family at 9.80%, so the rate is a normal property of both. Efficient is not the same as sufficient.
- `reasoning_effort` is not the cause: in the post-09-19 window, DeepSeek at `effort=max` is 47/2,643 while the GPT
  family at the same `effort=max` is 0/71.
- Turn shape is not the cause. Reconstructing each turn as a sequence of responses that either carry a tool call or do
  not, stalls appear in `CM`, `CCM`, `CCCM` and `M` shapes at comparable rates, and turns whose every response lacks a
  tool call number 32 of 452. There is no shape that marks a stall.
- No cap, limit, or truncation is hit. Searching every log line for cap, limit, exceed, maximum, token, budget, or
  truncation finds only the standard span and HTTP lines; there is no cap-exceeded event on these turns.
- Stalled turns do not do more work than normal ones. On a corrected count of upstream calls, stalled DeepSeek turns
  make 4 (median) against 5 for normal DeepSeek turns.
- Turn length does not predict a stop: DeepSeek turns at 4 upstream calls or fewer stop at 2.98% against 2.44% for
  longer ones, p = 0.78. The apparent boundary in the raw table was a sparse cell, not an effect.
- Prompt length is inconclusive rather than refuted: DeepSeek threads with a longest prompt over 500 characters show
  24.00% against 11.59%, but on 25 and 138 threads, p = 0.74. First-prompt length shows no difference at all.

### The contam in `ok`, recorded so it is not reintroduced

`ok` is used for two different things and the split differs by model. It acknowledges a completed answer, and it also
nudges a turn to continue. DeepSeek's turns end on a message that announces the next action, which invites `ok` as a
nudge; the GPT family ends on flatter text that invites `ok` as an acknowledgement. Counting `ok` therefore measured how
each family ends a turn rather than how often it stops short, and it produced a 22× contrast in the wrong direction.

Enumerating every short user message in the corpus gives the better signal: **`proceed`**, 226 occurrences against 62
for `ok`, and unlike `ok` it is unambiguous. The owner also confirmed that a `proceed` often follows an **accidental**
interruption from a stray ESC or a mis-clicked stop button, which is why `thread_turns.status` must be used to filter.

And the following methodological traps, each of which produced a wrong answer in these rounds:

- A 22× model contrast appeared from comparing interactive DeepSeek against a control dominated by
  `originator = '(none)'` headless threads. Unmatched controls fabricate model effects when the families sit in
  different client populations.
- Retracting that comparison by matching on `originator` over-corrected: it shrank the control to 246 turns and hid a
  real effect behind p = 0.43. Restricting on "has any user message" is the right cut.
- Pooling models mixes populations with different base rates and produces trends that do not exist.

Method note: the four parsing errors made across these rounds are recorded under "Reproduction artifacts", because each
one silently produced zero or wrong positives and would otherwise be repeated.

## Reproduction artifacts

- Backtest script (this session, outside the repository): `/Users/nv/.dsh/work/backtest-mid-turn-stop.ts`, also
  reproducible from the inline Python used for the tables above.
- Codex rollouts: `~/.codex/sessions/**/rollout-*.jsonl` — 182 files, 2,799 `task_started` / 2,706 `task_complete`
- Codex thread history: `~/.codex/thread_history_1.sqlite` — `thread_turns` (16,267 turns, authoritative `status`,
  `error_json`, `final_agent_item_id`) and `thread_items` (ordered items, `item_json`)
- Codex structured logs: `~/.codex/logs_2.sqlite`, table `logs`
- Codex thread metadata: `~/.codex/state_5.sqlite`, table `threads` (`model`, `reasoning_effort`, `cli_version`, `cwd`)
  — this is the store that supplied the missing control group
- DSH sessions (zstd-framed, concatenated frames; see note below): `~/.dsh/sessions/**/session*.jsonl.zstd`
- DSH loop source: `~/.dsh/profiles/tui/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` (`step()`, the
  `toolCalls.length === 0` line)
- DSH adapter source: `~/.dsh/profiles/tui/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js` (`translate()`)
- Gateway merge: `src/deepseek/responses-stream.ts`, `mergeToolCallDelta()`
- Gateway reminder: `src/deepseek/chat-projection.ts`, `CONTINUATION_INSTRUCTION` and `appendContinuationInstruction`

### Parsing errors that silently produce wrong or zero results

Each of these was made and corrected during these rounds. All are silent failures.

- **`task_complete` is an `event_msg` payload**, not a top-level record type. Reading it at the wrong level yields zero
  positives.
- **A `task_started` sits between a `task_complete` and the following user message.** Bounding the scan at
  `task_started` yields zero positives.
- **`thread_items.item_json` nests user text under `content[0].text`**, not a top-level `text` field. Reading `text`
  yields zero acknowledgements out of 12,416 user messages.
- **A Python cross-join over `thread_items` does not terminate** at this size; use SQL with the
  `(thread_id, rollout_ordinal)` index.

Also: pooling models mixes a ~2% population with a ~0.8% one and produces a trend that does not exist. Any backtest must
filter to the model under study.

Note on DSH session format: each file is a sequence of concatenated zstd frames, not one stream. Decompress by scanning
for the magic bytes `28 B5 2F FD` and decoding each frame independently; a single-stream decompressor stops after the
header record and silently under-reports. In this environment `/usr/bin/python3` has no `zstandard` module and no `zstd`
binary is present; use the bundled Node runtime, which exposes `zlib.zstdDecompressSync`.
