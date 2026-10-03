# Codex mid-turn stop — root cause investigation and gateway patch surface — 2026-09-26

## Status

**Thirteen backtest rounds are recorded here, and the headline diagnosis was reversed three times.** Read this section
before any other.

What stands after all of them:

1. **Codex ends a turn when a whole response contains no tool call.** Verified in source and by measurement. This is the
   mechanism and it is not in dispute.
2. **The corpus measures continuation-message frequency, not a mid-task-stop rate.** The recorded frequency of `proceed`
   or similar replies after a completed turn is 0.578% for the GPT family and 0.361% for DeepSeek (ratio **1.6×**, p =
   0.17). Such replies can authorize a next step; they do not prove that unfinished authorized work remained. These
   figures establish no per-model defect ranking.
3. **Turn status distinguishes interrupted predecessors from completed ones.** The recorded corpus has 1,354 interrupted
   GPT turns against 79 DeepSeek, including the owner's reported stray ESC or stop-button interruptions. Filtering these
   is necessary for describing completed predecessors, but a completed status does not make a continuation reply a
   validated failure label.
4. **Nothing in this repository was changed, deployed, or pushed while preparing the original investigation.** The
   proposed gateway patch remains withdrawn. Its acknowledgement-labelled backtest does not establish detection
   accuracy, and the independent prohibition on hidden inference remains; see "Backtest result" and "Proposed patch
   surface — withdrawn".

What does _not_ stand, and should not be reused:

- The claim that DeepSeek's tiers stop mid-turn at 20 to 27 times the GPT rate. Both figures were artifacts.
- The onset date of 2026-09-19. It was a change in how often the owner typed `ok`, not in failure rate.
- The CLI version analysis built on that onset.
- Any use of `ok` as an outcome measure. It is ambiguous between acknowledgement and nudge, and the split differs by
  model.

**Metric correction:** the retained historical rounds below used acknowledgement or continuation replies as failure
labels without independently verifying unfinished authorized work. Their raw counts, arithmetic and experimental
provenance are preserved, but their stop-rate comparisons and rate-dependent negative or causal conclusions are
inconclusive and re-testable with independently validated task-completion outcomes. The conclusions below now carry that
qualification. Independent source observations remain distinct from those conclusions; no experiment or corpus recount
was performed for these corrections.

Scope: why Codex turns appear to stop before the task is finished, how that interacts with the DeepSeek tiers served by
this gateway, whether DeepSeek Harness (DSH) differs against the same gateway and the same model, and where a scoped
LithosAI `-ultra` patch would live if one were warranted.

## Symptom

A Codex turn ends while work remains. The observable shape is consistent: the assistant emits a short intent line ("Let
me check the files…", "Now holding one long wait on the worker", "Proceeding. Let me read the exact markup…") and the
turn terminates immediately after. No error, no failure banner. The owner resumes by typing `ok`, `proceed`, or `k`.

The owner reports the symptom across thousands of turns. The recorded reply frequencies do not establish its incidence
or attribute it to either model family: they mix continuation, authorization and interruption recovery without
independently validating unfinished authorized work.

## Round ledger, and what each round established or retracted

Thirteen rounds were run against the same corpus. Listed in order, because the sequence matters: most rounds corrected
an earlier one.

The ledger records what each historical round claimed at the time. Its reply-derived outcome claims and negative results
are superseded by the metric correction and qualified hypothesis status below; it is not a list of validated failure
conclusions.

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
rollouts. The historical run used the owner's acknowledgement as a positive label: an ack-only user message (`ok`,
`okay`, `k`, or an `ok`-prefixed follow-up). These labels are not task-completion ground truth, and the retained
"correctly" and "incorrectly" table captions describe agreement with those historical labels only.

This run pooled models. Its pooled and Ultra-only scores cannot establish detector performance on unfinished authorized
work without validated outcome labels.

|                                    | count     |
| ---------------------------------- | --------- |
| Positive (owner resumed with `ok`) | 46        |
| Negative (turn not resumed)        | 2,660     |
| Detector fires, correctly          | 46        |
| **Detector fires, incorrectly**    | **2,534** |
| Detector misses                    | 0         |

Historical acknowledgement-label precision 1.8%. Recall 100%. Baseline for always predicting an acknowledgement 1.7%.
These are not validated failure-detection scores.

The detector fired on 2,534 turns without the selected acknowledgement and on all 46 labelled positives. Neither group
is independently validated as finished or unfinished. The source observation that legitimate final answers can contain
text with no tool call survives, but these scores do not establish that no structural detector can distinguish task
outcomes.

Had this shipped, the rule could have force-continued legitimate final answers; its actual false-positive incidence is
unvalidated.

The historical gateway recheck was retired in `be89f4919` because hidden inference was forbidden. That independent
policy remains; its retirement does not prove that no deterministic predicate can exist.

## Refuted hypothesis: fragmented tool calls were dropped in translation

A separate hypothesis — that DSH merges fragmented `tool_calls` deltas by index while this gateway's Responses
translation loses them, so Codex never sees the call — was **checked and refuted**.

DSH does merge them, in `@deepseek-ai/dsh-llm-deepseek` `translate()`, accumulating per `call.index` and appending
`function.arguments` fragments into one block before `[DONE]`.

This gateway does the same in `src/deepseek/responses-stream.ts`, `mergeToolCallDelta()`, keyed by `raw.index` with
`existing.arguments += fn.arguments`. Fragmented calls are accumulated and announced at the terminal, not dropped.

The inspected paths use the same fragment-accumulation mechanism; this source comparison does not exclude every
translation or gateway defect. The two loops are also byte-identical at the deciding line
(`if (toolCalls.length === 0) return { kind: "completed" }`).

Historical feature comparisons against acknowledgement labels, not validated failure outcomes:

| Feature                                 | Positive | Negative    | Verdict              |
| --------------------------------------- | -------- | ----------- | -------------------- |
| Last item is assistant message, no call | 46/46    | 2,534/2,660 | 1.8% precision       |
| `content_item_kinds == ('unknown',)`    | 46/46    | 2,550/2,660 | universal, worthless |
| Output tokens (p50)                     | 303,449  | 429,515     | overlapping          |
| Reasoning tokens (p50)                  | 219,407  | 251,387     | overlapping          |
| Tool calls present in turn              | 42/46 ≥1 | —           | not a separator      |

The comparisons cover 46 acknowledgement-labelled turns. Whether these features distinguish unfinished authorized work
remains inconclusive and re-testable with validated outcomes.

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

This acknowledgement-frequency comparison does not independently reproduce the decision record's finding that "the
reminder alone is insufficient" (`be89f4919`, discussing PR #395). Any independently validated reproduction in that
record stands on its own evidence; reminder efficacy cannot be decided from these reply counts.

The Ultra-only population is **181 turns across 43 sessions, with 4 acknowledgement-labelled positives**.
Task-completion labels are missing regardless of sample size. The recorded ~2% and ~0.8% reply-frequency populations
also show why model mix must be controlled in a future validated comparison; they do not establish efficacy or its
absence.

## A prompt-side mechanism already exists; efficacy here is inconclusive

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

The source and recorded deployment establish that the reminder existed on this route with the stated tool-bearing scope.
The acknowledgement-derived comparison does not establish that it removed the symptom, failed to remove it, or left a
failure rate unchanged. Its efficacy is inconclusive here and may be re-tested with independently validated
unfinished-authorized-work outcomes.

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

## Historical ground-truth validation claim — superseded

The inspection recorded below checked reply text, not whether authorized work was unfinished. It does not validate
acknowledgement or continuation replies as ground truth for a premature stop; the historical claim and numbers are
retained here.

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

p = 0.28 on acknowledgement labels. This does not exclude reasoning-item presence as a factor in premature stops; the
hypothesis remains inconclusive and re-testable with validated task outcomes.

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

### Historical client-version comparison — inconclusive after metric retraction

Round 9 noted that CLI 0.155.1 is exactly the version in use from 09-19 and proposed a Codex 0.155 change as a
candidate. The historical acknowledgement ordering reverses when families are compared within each version:

| CLI version | DeepSeek         | GPT family    | Direction           |
| ----------- | ---------------- | ------------- | ------------------- |
| 0.154.0     | 0/154 (0.00%)    | 4/714 (0.56%) | DeepSeek **lower**  |
| 0.155.1     | 41/2,362 (1.74%) | 0/158 (0.00%) | DeepSeek **higher** |

The reversal does not exclude a client-version effect on unfinished authorized work. These are acknowledgement
frequencies with unmatched task outcomes, so the version hypothesis is inconclusive and re-testable.

The recorded breakdown holds version fixed and varies model, but it does not isolate a cause of premature stops:

| Model            | CLI version | Window      | Turns | Acks | Rate  |
| ---------------- | ----------- | ----------- | ----- | ---- | ----- |
| `deepseek-flash` | 0.155.1     | after 09-19 | 2,362 | 41   | 1.74% |
| `gpt-6-astra`    | 0.155.1     | after 09-19 | 88    | 0    | 0.00% |
| `gpt-5.6-luna`   | 0.155.1     | after 09-19 | 24    | 0    | 0.00% |

Same client version, gateway and period, with acknowledgements recorded only for DeepSeek in these rows. This does not
establish which turns stalled. The reverse comparison holds the period fixed at 09-16 to 09-18 where both families ran
0.154.0:

| Family     | CLI version | Window         | Turns | Acks |
| ---------- | ----------- | -------------- | ----- | ---- |
| DeepSeek   | 0.154.0     | 09-16 to 09-18 | 154   | 0    |
| GPT family | 0.154.0     | 09-16 to 09-18 | 45    | 0    |

Both acknowledgement counts are zero before the reported boundary. This does not validate either population as free of
premature stops.

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

### Historical prompt-length comparison — inconclusive

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
tested and inconclusive rather than as a weak positive. A future comparison needs validated task outcomes as well as
sufficient samples; more acknowledgement-labelled turns alone would not settle it.

### Historical turn-length comparison — inconclusive

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

The recorded roughly 2 to 3% frequencies concern acknowledgement labels, not validated premature stops. The turn-length
hypothesis remains inconclusive and re-testable; combining it with the retracted DSH control, onset and model
attribution does not establish a cause or failure incidence.

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

### Historical `phase` comparison — detection performance unvalidated

`agentMessage` items carry a `phase` field (`commentary` or `final_answer`) that had not been tested. For the DeepSeek
tiers it looked decisive: every one of the 236 stalled agent messages lacks a phase, against 92.2% of the 10,530
non-stalled ones. Fisher p = 1.3e-08, and the odds ratio is unbounded in this sample.

The historical precision calculation uses acknowledgement-derived labels. It records agreement with those labels, not
validated detection performance:

| DeepSeek message | Stalled | Total | Precision |
| ---------------- | ------- | ----- | --------- |
| Without a phase  | 236     | 9,944 | **2.37%** |
| With a phase     | 0       | 822   | 0.00%     |

The historical labelled base rate is about 2.2%, with 2.37% labelled positives among phase-less messages; 97.6% lack the
positive label. These percentages do not validate which messages stalled or finished. GPT-family messages carry a phase
97.9% of the time in the recorded sample, a population difference that must be considered in any future validated
detector comparison.

The association does not settle detection ability. Any future candidate needs precision against independently validated
outcomes and their observed base rate, not p alone.

### The version/date confound cannot be broken with this corpus

The boundary is clean on the model side and absent on the control side:

| Family                          | CLI before 0.155  | CLI 0.155+       | Comment                     |
| ------------------------------- | ----------------- | ---------------- | --------------------------- |
| DeepSeek                        | 0/334 (0.00%)     | 52/2,713 (1.92%) | p = 0.005                   |
| GPT family, full history        | 10/12,975 (0.08%) | 0/171 (0.00%)    | unchanged                   |
| GPT family, 09-16 to 09-24 only | 0/65 (0.00%)      | 0/171 (0.00%)    | unchanged inside the window |

The third row records GPT-family threads under both versions inside the same calendar window, with no acknowledgement on
either side. This does not establish whether the 0.155 upgrade affected unfinished authorized work for either family.
The version/date hypothesis remains inconclusive on these labels.

That still does not separate version from date, because for DeepSeek the two move together with only three exceptions:

| DeepSeek subset      | Window              | Turns | Acks |
| -------------------- | ------------------- | ----- | ---- |
| CLI 0.154            | 09-16 to 09-18 only | 154   | 0    |
| CLI 0.155+           | 09-18 onward        | 2,713 | 52   |
| CLI older than 0.154 | 08-14 to 08-25      | 180   | 0    |

There is no DeepSeek 0.154 turn after 09-19 and no DeepSeek 0.155 turn before 09-18. A version effect and a calendar
effect are therefore indistinguishable here, and the corpus cannot supply the missing cell.

### DSH is the control that rules out the gateway, and it has no onset

**Withdrawn causal conclusion:** the owner identified these DSH sessions as gateway-debugging work, so this is not a
matched task control. The historical series below is preserved, but it cannot exclude the gateway, upstream or client as
a cause, and the source observations show both loops use the same no-tool-call termination rule.

DSH runs against the same `:7999` gateway and the same model, so if the 2026-09-19 onset were produced by the gateway or
the upstream, DSH would show it too. DSH has continuous session coverage across the date: 1,385 sessions from 2026-08-14
to 2026-09-26, with 47 turns recorded on 09-19 itself.

Measuring the DSH analogue of a text-only turn — a turn containing no `tool/call` event at all:

| Window            | Bare turns | Total turns | Rate  |
| ----------------- | ---------- | ----------- | ----- |
| Before 2026-09-19 | 114        | 2,005       | 5.69% |
| 2026-09-19 onward | 60         | 951         | 6.31% |

The recorded bare-turn frequencies show no discontinuity, but they are not matched task-outcome frequencies and are not
comparable to Codex acknowledgement labels. The inspected loops use the same no-tool-call termination rule; different
loop logic cannot be inferred from these counts.

The combination is what matters:

| Series                      | Before 09-19                                     | After 09-19      | Behavior      |
| --------------------------- | ------------------------------------------------ | ---------------- | ------------- |
| Codex, DeepSeek tiers       | 0/334 (0.00%)                                    | 52/2,713 (1.92%) | discontinuity |
| Codex, GPT family           | steady ~0.2% background across July to September | no onset         | steady        |
| DSH, same gateway and model | 5.69%                                            | 6.31%            | no onset      |

The historical inference that only a Codex-client change could explain these series is withdrawn. Debugging-task
populations and reply-derived labels do not provide the matched task-completion control needed to exclude gateway,
upstream or client causes.

Neither this series nor the round-8 alternatives establish a cause. The request the Codex client builds remains a
candidate for a future validated experiment, alongside other unexcluded causes.

### The GPT baseline also clarifies what the symptom is not

GPT-family acknowledgements are spread evenly across July to September at a steady 0.2%, with no onset: single
acknowledgements on 08-06, 08-08, 08-14, 08-21, 09-07, 09-10, 09-11 and a pair on 09-12. A steady low background rate is
present in every client and every month, so a handful of acknowledgements at zero cost across a long history is not
evidence of the defect. The DeepSeek signal is a discontinuity on top of that background, not an exaggeration of it.

The date onset is worth recording anyway, because it narrows what to look for: something that changed on or around
2026-09-19, affecting only the DeepSeek Flash tier family, and leaving the GPT family untouched.

## The acknowledgement metric was measuring the wrong thing, and this is the central correction

> **Superseded as an outcome claim.** Neither `ok` nor `proceed` validates a failure without evidence that authorized
> work remained unfinished. The following section reports continuation-message frequency; it does not establish that a
> defect is absent or rank model families by defect incidence.

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
under "Continuation-message frequency, and the changed ordering".

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

## Continuation-message frequency, and the changed ordering

The recorded enumeration found **`proceed`**, 226 occurrences against 62 for `ok`. A continuation instruction is clearer
about the user's next requested action than an acknowledgement, but it can authorize a new or proposed step after a
legitimate completion. It does not establish that the preceding turn left authorized work unfinished.

The reported measure counts turns associated with a continuation message (`proceed`, `continue`, `go ahead`,
`keep going`, `finish`, `do it`, `next`, `yes`) and compares families. The historical query and numbers are preserved;
these are reply frequencies, not validated stop outcomes:

| Family     | Turns  | Turns with a continuation message | Continuation-message frequency |
| ---------- | ------ | --------------------------------- | ------------------------------ |
| DeepSeek   | 3,033  | 35                                | **1.15%**                      |
| GPT family | 13,017 | 200                               | **1.54%**                      |

Fisher p = 0.13. The recorded continuation-message ordering is the opposite of the earlier acknowledgement ordering, and
the frequency difference is not statistically significant at this sample size. Neither ordering measures comparative
failure incidence.

Per-model continuation-message frequencies, with no inferred defect ranking:

| Model                                   | Turns | Continuation-message turns | Continuation-message frequency |
| --------------------------------------- | ----- | -------------------------- | ------------------------------ |
| `gpt-5.3-codex-spark`                   | 181   | 7                          | 3.87%                          |
| `gpt-5.6-sol`                           | 3,033 | 67                         | 2.21%                          |
| `gpt-6-astra`                           | 1,180 | 25                         | 2.12%                          |
| `gpt-5.6-luna`                          | 3,934 | 62                         | 1.58%                          |
| `gpt-5.6-terra`                         | 2,901 | 38                         | 1.31%                          |
| `deepseek-flash`                        | 2,626 | 33                         | 1.26%                          |
| `deepseek-ai/DeepSeek-V4.1-Flash-ultra` | 193   | 2                          | 1.04%                          |
| `deepseek/deepseek-v4-pro`              | 160   | 0                          | 0.00%                          |

In this recorded table, every DeepSeek tier sits at or below every GPT tier with a usable sample in continuation-message
frequency. This does not establish which family or tier stops with unfinished authorized work more often.

### Why the first twelve rounds inverted it

`ok` is used for two different things, and the split differs by model. It is a genuine acknowledgement of a completed
answer, and it is also a nudge to continue. DeepSeek's turns end on a message that announces the next action, which
invites `ok` as a nudge; the GPT family ends on flatter text that invites `ok` as an acknowledgement. Counting `ok`
therefore measured how each family ends a turn rather than how often it stops short.

The reversal also disposes of the onset. The 2026-09-19 discontinuity in `ok` rate was a change in how often the owner
typed `ok`, not in how often turns failed, and the version analysis that grew out of it was measuring the same artifact.

### What replaces the earlier conclusion

The tiers differ in the recorded frequency of continuation replies. The corpus does not distinguish a legitimate
authorization reply from a nudge after unfinished authorized work, so this measure establishes neither a comparative
stop rate nor a cause.

> **A `k`-only signal would still require outcome validation.** There are zero bare `k` messages in this corpus, so the
> signal the owner pointed to is not present in `~/.codex` and its location is still unconfirmed. A shorter reply alone
> would not establish unfinished authorized work.

> **Stratified below by predecessor status.** The frequencies above include interrupted predecessors, which are heavily
> concentrated in the GPT family. The later split describes replies after completed predecessors; it does not validate
> them as premature-stop outcomes.

## Separating interrupted predecessors from completed predecessors

The owner reported that a `proceed` often follows an accidentally interrupted turn, where a stray ESC or a mis-clicked
stop button ended the turn by hand. Excluding interrupted predecessors removes those cases from the
completed-predecessor frequency, but it does not establish that the remaining replies indicate model failures.

`thread_turns.status` records this directly, with values `completed`, `interrupted`, `failed`, and `inProgress`.
Splitting every continuation instruction by the status of the turn it follows:

| Family     | Turns  | Message after **completed** | After **interrupted** | After other |
| ---------- | ------ | --------------------------- | --------------------- | ----------- |
| DeepSeek   | 3,047  | **11**                      | 2                     | 22          |
| GPT family | 13,138 | **76**                      | 38                    | 80          |

The recorded split supports two descriptions:

1. **Recorded interrupted turns are concentrated in the GPT family.** The corpus holds 1,354 interrupted GPT turns
   against 79 DeepSeek, a 17× difference. Status alone does not identify every interruption's cause.
2. **Continuation-message frequency after completed predecessors** is 76/13,138 = 0.578% for GPT against 11/3,047 =
   0.361% for DeepSeek. Ratio 1.60×, Fisher p = 0.17. A completed predecessor and a continuation reply do not prove
   unfinished authorized work.

The remaining 84 non-completed predecessors are `failed` turns, and 18 are `inProgress`; both are correctly excluded,
since a failed turn is not a model stopping short.

### The corrected conclusion

The recorded GPT continuation-message frequency after completed predecessors is roughly 1.6 times the DeepSeek
frequency, and the difference is not statistically significant at this sample size. This establishes neither a
DeepSeek-specific defect nor its absence, and it does not validate the owner's reported stops as model-specific
outcomes.

Per model, on continuation-message frequency after completed predecessors:

| Model                                   | Turns | Continuation-message turns | Continuation-message frequency |
| --------------------------------------- | ----- | -------------------------- | ------------------------------ |
| `gpt-5.3-codex-spark`                   | 192   | 4                          | 2.08%                          |
| `gpt-6-astra`                           | 1,192 | 17                         | 1.43%                          |
| `deepseek-ai/DeepSeek-V4.1-Flash-ultra` | 193   | 2                          | 1.04%                          |
| `gpt-5.6-sol`                           | 3,089 | 25                         | 0.81%                          |
| `gpt-5.6-terra`                         | 2,945 | 14                         | 0.48%                          |
| `gpt-5.6-luna`                          | 4,005 | 15                         | 0.38%                          |
| `deepseek-flash`                        | 2,632 | 9                          | 0.34%                          |
| `deepseek/deepseek-v4-pro`              | 162   | 0                          | 0.00%                          |

The table orders these models by recorded continuation-message frequency, not by premature-stop incidence, capability or
quality. Authorization replies and other legitimate continuations remain possible in every row; external outcome labels
are required before making a defect ranking.

A residual caution: interruptions are not evenly distributed across models. Removing interrupted predecessors changes
the reply-frequency population but does not resolve the remaining authorization-versus-unfinished-work ambiguity.

## Root cause

> **Superseded by the metric correction above.** This section asserted a false-complete mechanism from acknowledgement
> frequency. The recorded 94.7% contained tool actions, which establishes activity but neither task completion nor
> incompletion. No root cause is established from these labels; the inspected no-tool-call termination rule remains an
> independent source fact.

Codex closes a turn when a model response contains no tool call. The historical interpretation combined that source rule
with an unvalidated model-frequency claim to infer a false completion. The rule alone does not establish whether the
model intended to continue or whether authorized work remained.

What remains verified independently of the metric: a response containing no tool call does end the turn, and the
decision unit is the response rather than the text block. What is not established is that DeepSeek reaches that state
more often in a way that constitutes a defect.

The recorded gateway probes returned healthy, fully-formed responses. These limited successes do not establish a
client-side cause or exclude a gateway defect:

| Probe                          | Result                                            |
| ------------------------------ | ------------------------------------------------- |
| Chat Completions, generous cap | `finish_reason: stop`, 10,742 visible chars       |
| Responses, no cap              | `status: completed`, 9,283 visible chars          |
| Responses, long streaming turn | `response.completed`, 694 text deltas             |
| Reasoning effort none/high/max | 0 / 5225 / 8912 reasoning tokens, all `completed` |

The probes recorded different reasoning-token counts at the tested efforts. They do not exclude reasoning effort as a
factor in the reported premature stops.

## Why a gateway patch was considered, and why it remains withdrawn

The reasoning was that the gateway already rewrites this route in both directions, so it could supply the continuation
signal the client does not ask for.

**The backtest does not validate that reasoning.** A continuation requires evidence that authorized work remains, and
the historical 2,534 negative labels do not establish legitimate completions. A no-tool-call final answer can be
legitimate, so response shape alone cannot be assumed to justify continuation. Asking the model through hidden extra
inference is independently forbidden: this repository retired that construction in `be89f4919` ("retire hidden DeepSeek
continuation inference").

Both candidate mechanisms below are therefore withdrawn:

1. ~~Keep-alive / non-terminal framing~~ — no validated unfinished-work detector was established here.
2. ~~Server-side continuation~~ — the historical detector's 1.8% acknowledgement-label precision is not task-outcome
   accuracy, and unconsented hidden inference remains forbidden.

No gateway fix is established by this investigation, and no layer is excluded solely by these backtests. Existing scoped
LithosAI patching does not justify a continuation change without validated outcomes and the existing authorization
safeguards.

## Proposed patch surface — withdrawn

Withdrawn, with the historical proposal retained for provenance. The backtest used unvalidated acknowledgement labels;
any future detector evaluation needs independently validated task outcomes, and this proposal does not authorize hidden
inference.

A new module (working name `src/provider/lithos-continuation.ts`) would have owned the detector and the injection, gated
to `deepseek-ai/DeepSeek-V4.1-Flash-ultra`, in the scoped-patch style this route already uses (`src/provider/lithos.ts`,
`lithos-handlers.ts`, `lithos-rate-limits.ts`, `lithos-streams.ts`).

The detector below recorded 1.8% precision against acknowledgement labels. The historical "false positives" comment
describes those labels, not verified task outcomes:

```
stop_is_false_complete(response) :=      # REFUTED — 1.8% precision, 2,534 false positives
      response ends with an assistant message item
  AND that item carries no tool call
  AND no terminal error is present
  AND the turn's continuation budget is unexhausted
```

The first two clauses can match a legitimate final answer. Their presence alone does not establish unfinished work;
whether additional signals can discriminate outcomes remains unvalidated.

## Acceptance criteria — withdrawn with the patch

These are the withdrawn proposal's historical criteria. Its labelled backtest cannot validate them. Any future
evaluation needs independently labelled finished and unfinished authorized tasks before it can measure false positives;
the historical criteria and numbers below are retained, not promoted to validated acceptance evidence.

- A DeepSeek Ultra turn whose intent-only response would have ended the turn instead continues and reaches a tool call.
- **Historical criterion: zero false positives on the 2,534 presumed legitimate completions in the backtest corpus.**
  Those completion labels are unvalidated, so this corpus cannot establish whether a candidate meets the criterion. A
  legitimate final answer must remain a valid outcome.
- Non-Ultra tiers, other providers, and the Chat Completions path are byte-identical to current behavior.
- `deno task test` passes, with new coverage and a recorded-upstream fixture replayed through `scripts/replay.ts`.
- A decision entry is appended to `docs/provider-decision-journal.md` (behavior) or `docs/DECISIONS.md` (policy),
  following the established format: decision, behavior, reversal risk, residual gap.

## Reversal risk and residual gap

The historical 1.8% precision, 2,534 negative labels and 46 positive labels do not measure the risk of continuing
finished tasks or missing unfinished ones. That risk remains unvalidated. The proposal stays withdrawn because no
task-outcome evidence supports it, and the independent prohibition on hidden inference remains.

Residual gap: the symptom is not fixed by this document. The five rounds of historical candidate comparisons used
reply-derived labels, so they do not establish failure-detection accuracy or refute every candidate. Source observations
still show that legitimate final answers can contain text without a tool call.

The missing requirement is independently validated evidence of unfinished authorized work. The backtests do not prove
that such a signal is absent from every response, turn record or item type. The recorded directions of changing the
request or referencing prior authorized state remain unevaluated here; neither has been prototyped by this
investigation.

## Unresolved

The position after thirteen rounds, stated as plainly as the evidence allows:

**Established independently of reply labels.** The inspected client loops end a turn when the response carries no tool
call, and the recorded item streams contain ordinary text-only responses. The recorded continuation-message frequency
after completed predecessors is about 1.6× higher for GPT than DeepSeek (0.578% against 0.361%). As corrected above,
those frequencies establish no premature-stop rate or model ranking.

**Not established.** Why reported turns stop short, whether any tested feature detects unfinished authorized work, or
whether CLI version, reminder guidance, reasoning, effort or another factor affects it. The reply-derived labels cannot
settle those questions. The recorded lack of explicit cap events is a log observation, not a universal exclusion of
limits or gateway defects.

**Ordered next steps.**

1. **Locate the `k` continuation corpus.** There are zero bare `k` user messages in `~/.codex` across all 16,267 turns,
   any capitalisation, and zero in the DSH sessions. The owner reports using `k` as a shorter nudge, so it is stored
   somewhere not yet identified. A `k`-only reply would still require independently validated task-completion labels;
   locating more replies alone would not settle a failure hypothesis.
2. **Distinguish predecessor status in every future measurement.** A reply after an interrupted or failed turn must not
   be counted as a completed-turn premature stop. A completed predecessor still needs independent evidence of unfinished
   authorized work.
3. **Establish an outcome measure before measuring anything else.** The corpus has no record of what a task required, so
   a turn that stopped short and a turn that correctly yielded are indistinguishable except through the owner's
   judgement. Either the owner marks a set of known-bad turns, or a forward-looking capture records intent before a turn
   and verifies completion after it. Without one of these, further rounds will keep producing strong statistics about
   conversation.

The retained observations and hypothesis status follow. Rate-dependent negatives are inconclusive and re-testable with
independently validated outcomes; none is a do-not-retest instruction. Source facts stand on the recorded inspection,
with their historical scope:

- **Inconclusive:** whether response shape, item type, tokens, duration or wording separates unfinished authorized work
  from a legitimate completion. The historical labels did not validate either outcome.
- **Source observation:** both inspected client loops terminate on the same no-tool-call rule and tolerate text before
  tool calls. This does not establish equal task-completion behavior.
- **Source observation:** the inspected DSH and gateway paths accumulate fragmented tool calls by index. This does not
  exclude all gateway or transport defects.
- **Corpus observation:** every completed turn in the recorded sample ends on an assistant message. Its task-outcome
  detection value is unvalidated.
- **Source and deployment observation:** the continuation reminder existed with the recorded tool-bearing scope.
  **Inconclusive and re-testable:** whether it reduces premature stops; acknowledgement frequencies cannot decide
  efficacy.
- **Inconclusive and re-testable:** reasoning-item presence. The recorded acknowledgement-label contrast is 1.88% versus
  1.27%, p = 0.28, not a causal exclusion.
- ~~The gateway and the upstream are not implicated: DSH, on the same gateway and model, shows 5.69% before 2026-09-19
  and 6.31% after.~~ **Withdrawn.** The owner confirmed the DSH sessions in question were gateway-debugging work, so the
  DSH series is not a control and this argument cannot be used. The gateway remains unexcluded by any measurement here.
- ~~The symptom has an onset of 2026-09-19.~~ **Withdrawn.** The discontinuity was in how often the owner typed `ok`,
  not in failure rate, and it was a property of the corpus rather than of the system.
- **Source observation:** the inspected `fbb0383a7` diff touches usage accounting, and the other inspected commits in
  that window touch usage, admin layout and docs. This does not exclude all gateway causes.
- **Inconclusive and re-testable:** CLI version. On 0.155.1 the recorded acknowledgement labels are `gpt-6-astra` 0/88,
  `gpt-5.6-luna` 0/24 and `deepseek-flash` 41/2,362; ordering reverses between 0.154.0 and 0.155.1. Neither this
  ordering nor a non-significant comparison excludes a version effect on unfinished work.
- **Status observation:** the corpus records 1,354 interrupted GPT turns against 79 DeepSeek, including the owner's
  reported accidental stops. Distinguish `interrupted` and `failed` from completed predecessors; status alone does not
  establish interruption cause or task completion.
- **Inconclusive and re-testable:** `phase` as a detector. The historical labels give 236/236 positives without a phase
  and 9,708 of 10,530 negatives without one, with 2.37% label precision against a 2.2% labelled base rate. Task-outcome
  detection performance is unvalidated.
- **Corpus observation:** the inspected DeepSeek `reasoning` items have empty readable `content` and summary only,
  unchanged across the reported boundary. This does not exclude reasoning as a factor in premature stops.
- **Corpus observation:** reconstructed text-only response frequencies are 10.75% for DeepSeek and 9.80% for GPT. Their
  presence is ordinary in this sample; whether a specific text-only response leaves authorized work unfinished is
  unvalidated.
- **Inconclusive and re-testable:** `reasoning_effort`. In the post-09-19 window the recorded acknowledgement-label
  counts at `effort=max` are DeepSeek 47/2,643 and GPT 0/71. They do not establish or exclude a cause.
- **Inconclusive and re-testable:** turn shape. Historical positives appear in `CM`, `CCM`, `CCCM` and `M`, with 32 of
  452 turns containing no tool-bearing response. Those labels do not validate which shapes mark unfinished authorized
  work.
- **Log observation:** the recorded search for cap, limit, exceed, maximum, token, budget or truncation found standard
  span and HTTP lines, with no explicit cap-exceeded event in those turns. It does not establish that no limit could
  contribute to the symptom.
- **Inconclusive and re-testable:** work count. The recorded acknowledgement-labelled DeepSeek groups have median
  upstream-call counts of 4 versus 5; those groups are not validated stalled and completed tasks.
- **Inconclusive and re-testable:** turn length. At 4 upstream calls or fewer the acknowledgement-labelled frequency is
  2.98%, versus 2.44% for longer turns, p = 0.78. This does not exclude an effect on actual premature stops.
- **Inconclusive and re-testable:** prompt length. The recorded over-500-character comparison is 24.00% versus 11.59% on
  25 and 138 threads, p = 0.74, with no observed first-prompt difference. Task-outcome labels remain unvalidated
  regardless of sample size.

### The contam in `ok`, recorded so it is not reintroduced

`ok` is used for two different things and the split differs by model. It acknowledges a completed answer, and it also
nudges a turn to continue. DeepSeek's turns end on a message that announces the next action, which invites `ok` as a
nudge; the GPT family ends on flatter text that invites `ok` as an acknowledgement. Counting `ok` therefore measured how
each family ends a turn rather than how often it stops short, and it produced a 22× contrast in the wrong direction.

The recorded enumeration found **`proceed`**, 226 occurrences against 62 for `ok`. It can authorize a new step or
recover from the owner's reported accidental interruption, so it remains a continuation-message signal rather than a
validated unfinished-work outcome. Predecessor status and task-completion evidence are both required.

And the following methodological traps, each of which produced a wrong answer in these rounds:

- A 22× model contrast appeared from comparing interactive DeepSeek against a control dominated by
  `originator = '(none)'` headless threads. Unmatched controls fabricate model effects when the families sit in
  different client populations.
- Matching on `originator` shrank the historical control to 246 turns, with p = 0.43. Neither that comparison nor
  restriction to "has any user message" validates task completion or establishes a real failure effect.
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
