import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import adminScript from "../static/admin.js" with { type: "text" };

class TestElement {
  dataset: Record<string, string> = {};
  textContent = "";
  children: TestElement[] = [];
  append(...children: TestElement[]) {
    this.children.push(...children);
  }
  appendChild(child: TestElement) {
    this.children.push(child);
  }
}

const now = Date.now();
const source = { source: "codex", state: "available", source_observed_at_ms: now, snapshot_at_ms: now };
const provider = {
  access_token_expired: false,
  access_token_exp_ms: now + 86_400_000,
  health: {
    state: "degraded",
    stale: false,
    last_event: "reachable",
    last_status: 200,
    last_observed_at_ms: now,
    last_refresh_succeeded: false,
    last_refresh_at_ms: now - 10_000,
  },
};
const context = {
  document: { createElement: () => new TestElement() },
  formatDate: (value: number) => String(value),
  formatOptionalText: (value: unknown) => (typeof value === "string" ? value : "unknown"),
};
const sourceText = String(adminScript);
// Execute the shipped presenters, including their DOM fact writer. No copy of
// their status conditions or network/application bootstrap runs in this fixture.
runInNewContext(
  [
    sourceText.slice(sourceText.indexOf("const providerBadgeState"), sourceText.indexOf("const formatCapacityPercent")),
    sourceText.slice(sourceText.indexOf("const capacityProviderStatus"), sourceText.indexOf("let codexResetSettings")),
    "globalThis.present = capacityProviderStatus; globalThis.renderMeta = appendCapacitySourceMeta;",
  ].join("\n"),
  context
);
const presenters = context as typeof context & {
  present: (source: unknown, provider: unknown) => { label: string; badgeState: string; quotaReachable: boolean };
  renderMeta: (row: TestElement, source: unknown, provider: unknown) => void;
};

Deno.test("current accepted quota access is reachable while its failed refresh attempt stays visible", () => {
  const status = presenters.present(source, provider);
  assert.equal(status.label, "Reachable · Live");
  assert.equal(status.badgeState, "ok");
  assert.equal(provider.health.state, "degraded");
  const row = new TestElement();
  presenters.renderMeta(row, source, provider);
  const facts = row.children[0].children[1].children;
  const refresh = facts.find((fact) => fact.children[0].textContent === "Last refresh attempt");
  assert.equal(refresh?.children[1].textContent, `Failed · ${provider.health.last_refresh_at_ms} · Quota reads currently succeed`);
});

Deno.test("unavailable, stale and expired access retain warnings, while inference success remains healthy", () => {
  const cases = [
    {
      source: { ...source, state: "unavailable" },
      provider: { ...provider, health: { ...provider.health, state: "invalid", last_status: 401 } },
      label: "invalid · Quota unavailable",
    },
    { source: { ...source, state: "stale" }, provider, label: "degraded · Quota stale" },
    { source, provider: { ...provider, health: { ...provider.health, stale: true } }, label: "degraded · stale · Live" },
    { source, provider: { ...provider, access_token_expired: true }, label: "degraded · Live" },
    { source, provider: { ...provider, access_token_exp_ms: now - 1 }, label: "degraded · Live" },
    { source, provider: { ...provider, health: { ...provider.health, state: "healthy", last_event: "success" } }, label: "healthy · Live" },
  ];
  for (const fixture of cases) {
    const status = presenters.present(fixture.source, fixture.provider);
    assert.equal(status.label, fixture.label);
    assert.equal(status.quotaReachable, false);
    const row = new TestElement();
    presenters.renderMeta(row, fixture.source, fixture.provider);
    const refresh = row.children[0].children[1].children.find((fact) => fact.children[0].textContent === "Last refresh attempt");
    assert.equal(refresh?.children[1].textContent, `Failed · ${provider.health.last_refresh_at_ms}`);
  }
});
