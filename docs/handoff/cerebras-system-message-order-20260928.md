# Cerebras chat template requires one leading system message

Goal: the Cerebras route must never send an upstream Chat Completions body whose `system` message is absent from,
followed by, or repeated after another `system` message, so `qwen-3.8-27b` stops failing with the provider's
`wrong_api_format` error.

## Reproduced (2026-09-28, Mac release `mac-b43550f2e`, `/v1/responses` on loopback)

| Request                                                      | Result                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `instructions` + user                                        | 200                                                                                                        |
| `instructions` + leading `developer` item + user             | **400** `Failed to apply chat template to messages due to error: System message must be at the beginning.` |
| user + mid-list `developer` + user                           | **400** same error                                                                                         |
| `POST /v1/chat/completions` with `system`, `developer`, user | **400** same error                                                                                         |
| `gpt-oss-120b` with `instructions` + leading `developer`     | 200 (the harmony template tolerates it)                                                                    |

The Responses projection turns `instructions` into a leading `system` message and every `developer` item into a `system`
message in place (`src/deepseek/chat-projection.ts:237`, `:300`), and the Chat wire already rewrites `developer` to
`system` (`src/provider/cerebras.ts:263`). Qwen's template accepts exactly one leading system message, so any second one
at index 1 or later is rejected before inference.

## Change

1. Collapse every `system` message on the Cerebras wires into one leading `system` message, in original order, joined
   with a blank line; leave all other messages in order and return the array unchanged when there is at most one leading
   system message.
2. Apply it on the Responses adapter (`src/provider/cerebras-responses.ts`) after the shared translation and on the Chat
   wire (`src/provider/cerebras-handlers.ts`) where the developer-to-system mapping happens.
3. Keep it Cerebras-scoped; DeepSeek and LithosAI wires are untouched.

## Acceptance

- The two failing Responses shapes from the table return 200 on the deployed release and the upstream body carries
  exactly one leading `system` message.
- The chat wire accepts `system`+`developer`+user.
- `gpt-oss-120b`, the existing suites, and `sh scripts/verify.sh` stay green.
