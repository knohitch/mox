import { describe, expect, it } from "vitest";
import { DeviceProvider } from "../src/index.js";
import { ElevenLabsVoiceProvider, VoiceUsageMeter } from "../src/index.js";

function audioResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}

describe("voice provider", () => {
  it("reports unconfigured honestly without an API key", async () => {
    const provider = new ElevenLabsVoiceProvider({});
    expect(provider.configured).toBe(false);
    expect(provider.blocker).toContain("ELEVENLABS_API_KEY");
    await expect(provider.synthesize({ text: "hi", selection: { voiceId: "v" } })).rejects.toThrow(/not configured/);
    await expect(provider.verifyKey()).resolves.toMatchObject({ ok: false });
    // Unconfigured providers expose no fake voices.
    expect(await provider.listVoices()).toEqual([]);
  });

  it("synthesizes speech and emits usage metering events", async () => {
    const usage = new VoiceUsageMeter();
    const events: Array<{ characters: number; voiceId: string }> = [];
    usage.subscribe((u) => events.push({ characters: u.characters, voiceId: u.voiceId }));
    const provider = new ElevenLabsVoiceProvider({
      apiKey: "test-key",
      fetchImpl: async () => audioResponse(),
      usage,
    });
    const audio = await provider.synthesize({ text: "Hello from Mox", selection: { voiceId: "voice-9" } });
    expect(audio.mime).toBe("audio/mpeg");
    expect(audio.charactersBilled).toBe("Hello from Mox".length);
    expect(events).toEqual([{ characters: 14, voiceId: "voice-9" }]);
  });

  it("maps provider errors to friendly messages", async () => {
    const provider = new ElevenLabsVoiceProvider({
      apiKey: "k",
      fetchImpl: async () => new Response(JSON.stringify({ detail: {} }), { status: 429 }),
    });
    await expect(provider.verifyKey()).resolves.toMatchObject({ ok: false, message: /rate-limit/ });
  });

  it("lists voices from the provider catalogue", async () => {
    const provider = new ElevenLabsVoiceProvider({
      apiKey: "k",
      fetchImpl: async () =>
        new Response(JSON.stringify({ voices: [{ voice_id: "v1", name: "Aria", labels: { accent: "american" } }] }), {
          status: 200,
        }),
    });
    const voices = await provider.listVoices();
    expect(voices[0]).toMatchObject({ id: "v1", label: "Aria" });
    expect(voices[0]?.description).toContain("accent");
  });
});

describe("device provider", () => {
  function deviceSet() {
    const relayCalls: Array<{ deviceId: string; action: unknown }> = [];
    const provider = new DeviceProvider({
      async send(deviceId, action) {
        relayCalls.push({ deviceId, action });
        return { ok: true, output: { screenshot: "base64data" } };
      },
    });
    provider.registerDevice({
      deviceId: "phone-1",
      displayName: "Pixel Test",
      platform: "android",
      capabilities: { screenCapture: true, tapInput: true, keyboardInput: false, appLaunch: true },
      online: true,
    });
    provider.registerDevice({
      deviceId: "phone-off",
      displayName: "Offline Phone",
      platform: "android",
      capabilities: { screenCapture: true, tapInput: true, keyboardInput: true, appLaunch: true },
      online: false,
    });
    provider.authorizeUser("phone-1", "user-a");
    provider.authorizeUser("phone-off", "user-a");
    return { provider, relayCalls };
  }

  it("advertises capabilities and authorizes explicit users only", () => {
    const { provider } = deviceSet();
    expect(provider.listDevices("user-a").map((d) => d.deviceId)).toEqual(["phone-1", "phone-off"]);
    expect(provider.listDevices("user-b")).toEqual([]);
  });

  it("performs actions on capable online devices", async () => {
    const { provider, relayCalls } = deviceSet();
    const result = await provider.perform({ deviceId: "phone-1", userId: "user-a", kind: "screen.capture", payload: {} });
    expect(result.ok).toBe(true);
    expect(result.output?.screenshot).toBe("base64data");
    expect(relayCalls).toHaveLength(1);
  });

  it("fails gracefully for offline devices", async () => {
    const { provider, relayCalls } = deviceSet();
    const result = await provider.perform({ deviceId: "phone-off", userId: "user-a", kind: "screen.capture", payload: {} });
    expect(result).toEqual({ ok: false, reason: "offline" });
    expect(relayCalls).toHaveLength(0);
  });

  it("refuses actions the device capability set lacks", async () => {
    const { provider } = deviceSet();
    const result = await provider.perform({
      deviceId: "phone-1",
      userId: "user-a",
      kind: "input.type",
      payload: { text: "hi" },
    });
    expect(result).toEqual({ ok: false, reason: "capability_missing" });
  });

  it("blocks unauthorized users structurally", async () => {
    const { provider, relayCalls } = deviceSet();
    const result = await provider.perform({ deviceId: "phone-1", userId: "intruder", kind: "input.tap", payload: {} });
    expect(result).toEqual({ ok: false, reason: "not_authorized" });
    expect(relayCalls).toHaveLength(0);
  });
});
