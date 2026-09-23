import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { resolveProviderAlias, parseModel } from "open-sse/services/model.js";

/**
 * Global guard against alias hijacking across the provider registry.
 *
 * `open-sse/services/model.js` builds a single alias -> providerId map by walking
 * the registry in order, last writer wins. So when two providers list the same
 * alias, the one registered later silently steals every request for the other —
 * exactly what happened when StepFun CN added `sfcn`, which SiliconFlow CN has
 * owned since v1.1.3 (verify-alias's token list even baked the wrong mapping in).
 *
 * These assertions fail the moment any alias is claimed twice, or an alias
 * shadows a different provider's id (parseModel resolves bare ids too), so a
 * future registry edit can't reintroduce the same class of bug unnoticed.
 */
describe("provider registry alias uniqueness", () => {
  it("no alias is claimed by more than one provider", () => {
    const owners = new Map(); // alias -> Set(providerId)
    for (const p of REGISTRY) {
      for (const a of Array.isArray(p.aliases) ? p.aliases : []) {
        if (!owners.has(a)) owners.set(a, new Set());
        owners.get(a).add(p.id);
      }
    }
    const collisions = [...owners.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([a, ids]) => `${a} -> ${[...ids].join(", ")}`);
    expect(collisions, `aliases claimed by multiple providers:\n${collisions.join("\n")}`).toEqual([]);
  });

  it("no alias shadows a different provider's id", () => {
    const ids = new Set(REGISTRY.map((p) => p.id));
    const conflicts = [];
    for (const p of REGISTRY) {
      for (const a of Array.isArray(p.aliases) ? p.aliases : []) {
        if (a !== p.id && ids.has(a)) conflicts.push(`${a} (alias of ${p.id}) collides with a provider id`);
      }
    }
    expect(conflicts, conflicts.join("\n")).toEqual([]);
  });

  // Regression pin for the sfcn fix: the short alias must resolve to its rightful
  // owner in both directions, and StepFun CN keeps its own `sf-cn`.
  it("sfcn resolves to siliconflow-cn, sf-cn to stepfun-cn", () => {
    expect(resolveProviderAlias("sfcn")).toBe("siliconflow-cn");
    expect(resolveProviderAlias("sf-cn")).toBe("stepfun-cn");
    expect(parseModel("sfcn/deepseek-ai/DeepSeek-V3.2").provider).toBe("siliconflow-cn");
    expect(parseModel("sf-cn/step-5-preview").provider).toBe("stepfun-cn");
  });
});
