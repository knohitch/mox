import { describe, expect, it } from "vitest";
import { ModelCapability, ModelDefinition, ModelId, ProviderId } from "@mox/contracts";
import { ModelRegistry, MOX_AI_ALIASES } from "../src/index.js";

function model(over: Partial<ModelDefinition> & Pick<ModelDefinition, "modelId" | "providerId">): ModelDefinition {
  return ModelDefinition.parse({
    displayName: over.modelId,
    contextWindowTokens: 128_000,
    capabilities: [ModelCapability.enum.chat],
    ...over,
  });
}

describe("ModelRegistry", () => {
  it("registers and resolves models by provider+model id", () => {
    const reg = new ModelRegistry();
    const def = model({ providerId: ProviderId.parse("p_openai"), modelId: ModelId.parse("gpt-4.1") });
    reg.register(def);
    expect(reg.resolve("p_openai", "gpt-4.1")?.definition.displayName).toBe("gpt-4.1");
    expect(reg.resolve("p_other", "gpt-4.1")).toBeUndefined();
  });

  it("mox AI aliases stay honest without a backend", () => {
    const reg = new ModelRegistry();
    for (const alias of MOX_AI_ALIASES) reg.registerAlias(alias); // no targets
    for (const alias of MOX_AI_ALIASES) {
      expect(reg.resolveSelection("p_mox", alias)).toBeUndefined();
    }
  });

  it("mox aliases resolve to their configured backend target", () => {
    const reg = new ModelRegistry();
    const target = model({ providerId: ProviderId.parse("p_openai"), modelId: ModelId.parse("gpt-4.1-mini") });
    reg.register(target);
    reg.registerAlias("mox-fast", { providerId: "p_openai", modelId: ModelId.parse("gpt-4.1-mini") });
    expect(reg.resolveSelection("p_mox", "mox-fast")?.definition.modelId).toBe("gpt-4.1-mini");
  });

  it("availability blocks dispatch; region restrictions are enforced", () => {
    const reg = new ModelRegistry();
    const eu = model({
      providerId: ProviderId.parse("p_openai"),
      modelId: ModelId.parse("eu-only"),
      regions: ["eu-central"],
    });
    reg.register(eu);
    reg.register(model({ providerId: ProviderId.parse("p_xai"), modelId: ModelId.parse("down") }), {
      available: false,
      unavailableReason: "provider outage",
    });

    const euEntry = reg.resolve("p_openai", "eu-only")!;
    expect(reg.checkDispatchable(euEntry, { region: "eu-central" }).ok).toBe(true);
    expect(reg.checkDispatchable(euEntry, { region: "us-east" }).ok).toBe(false);

    const down = reg.resolve("p_xai", "down")!;
    expect(reg.checkDispatchable(down, {}).ok).toBe(false);
  });

  it("deprecated status is flagged but does not hard-block", () => {
    const reg = new ModelRegistry();
    reg.register(
      model({
        providerId: ProviderId.parse("p_deepseek"),
        modelId: ModelId.parse("old-model"),
        status: "deprecated",
      }),
    );
    const entry = reg.resolve("p_deepseek", "old-model")!;
    expect(reg.isDeprecated(entry)).toBe(true);
    expect(reg.checkDispatchable(entry, {}).ok).toBe(true);
  });

  it("capability search only returns active available models with that capability", () => {
    const reg = new ModelRegistry();
    reg.register(
      model({
        providerId: ProviderId.parse("p_anthropic"),
        modelId: ModelId.parse("sonnet"),
        capabilities: [ModelCapability.enum.chat, ModelCapability.enum.tools],
      }),
    );
    reg.register(
      model({
        providerId: ProviderId.parse("p_google"),
        modelId: ModelId.parse("flash"),
        capabilities: [ModelCapability.enum.tools],
      }),
      { available: false },
    );
    const tools = reg.findByCapability(ModelCapability.enum.tools);
    expect(tools.map((t) => t.definition.modelId)).toEqual(["sonnet"]);
  });
});
