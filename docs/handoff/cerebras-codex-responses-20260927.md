# Cerebras models on the Codex surface

Goal: let a Codex client see and use the two Cerebras ids (`gpt-oss-120b`, `qwen-3.8-27b`) from
`GET /v1/models?client_version=<ver>` on `/v1/responses`, not only over `/v1/chat/completions`.

## Verified state (2026-09-27, Mac release 1c5081cf3)

- `GET /v1/models` lists both ids; `GET /v1/models?client_version=0.44.0` does not, because `catalogResponse` appends
  rows only for providers that serve the Responses wire (paid tiers, DeepSeek official, LithosAI).
- `POST /v1/responses` with `gpt-oss-120b` is refused `400 unsupported_model` at `src/responses-request.ts:224`;
  `POST /v1/chat/completions` serves both ids (200), and the KV model whitelist already contains both ids.
- No branch or PR implements a Cerebras Responses profile (`git log --all -S` found none).

## Change

1. `src/deepseek/responses.ts`: add `"cerebras"` to `ChatOnlyResponsesProfile["id"]` and export
   `CEREBRAS_RESPONSES_PROFILE` (label, `cerebrasUpstreamModelFor`, per-id tier projection from `cerebrasProviderHint`,
   shared finish/usage helpers, `requiresStreamUsageOption: false`).
2. `src/provider/cerebras-responses.ts`: new `handleCerebrasResponses` mirroring `handleLithosResponses`
   (`src/provider/lithos-handlers.ts:783`): translate with `toDeepSeekResponsesChatBody`, reuse the Cerebras transport
   and its buffered replay (`streamCerebrasChatCompletion`), project tool schemas with `projectCerebrasToolSchema`, keep
   the route's error mapping and telemetry.
3. `src/responses-handler.ts`: dispatch Cerebras-owned ids to the new handler beside the DeepSeek/Lithos branches.
4. `src/responses-request.ts`: delete the `unsupported_model` refusal.
5. `src/catalog/models.ts` + `src/catalog/index.ts`: `cerebrasCodexModels()` / `withCerebrasModels()` rows
   (131,072-token window, per-id tiers, `supported_endpoint_types: ["openai-response","openai-chat"]`) appended in
   `catalogResponse` and `meteredCatalogResponse`, and included in the catalog-only short-circuit condition.
6. Tests: `tests/cerebras-responses.test.ts` plus catalog coverage; `sh scripts/verify.sh` must pass.

## Acceptance

- `GET /v1/models?client_version=<ver>` lists `gpt-oss-120b` and `qwen-3.8-27b` on the deployed release.
- `POST /v1/responses` with `qwen-3.8-27b` returns a completed Responses object; `none` reasoning is accepted only for
  qwen, `ultra` is refused for both.
- Chat-completions behavior for the same ids is unchanged; existing suites stay green.

## Rollout

PR into `development` through the normal CI-gated loop, then `deno task deploy:vps` and `deno task deploy:mac`, then
re-run the acceptance checks on both surfaces.
