/**
 * Voice + device capability abstractions (Prompt 11).
 *
 * VoiceProvider ports OpenMaus' ElevenLabs TTS into a provider-neutral
 * interface with usage-metering hooks and extension points for
 * OpenAI/Google/Azure/AWS realtime providers. Keys stay server-side.
 *
 * DeviceProvider covers Android/device CUA capabilities behind a
 * capability-advertised interface: unavailable devices degrade gracefully,
 * never assuming desktop-local Electron exists.
 */

export interface VoiceSelection {
  voiceId: string;
  /** Provider-specific model, e.g. eleven_flash_v2_5. */
  model?: string;
}

export interface SpeechRequest {
  text: string;
  selection: VoiceSelection;
  format?: "mp3_44100_64" | "mp3_44100_128" | "wav";
}

export interface SpeechAudio {
  bytes: Uint8Array;
  mime: string;
  /** Character count for usage metering (voice_minutes / TTS chars). */
  charactersBilled: number;
}

export type VoiceUsageListener = (usage: { providerName: string; characters: number; voiceId: string }) => void;

export interface VoiceProvider {
  readonly name: string;
  readonly configured: boolean;
  readonly blocker?: string;
  listVoices(): Promise<Array<{ id: string; label: string; description?: string }>>;
  synthesize(request: SpeechRequest): Promise<SpeechAudio>;
  verifyKey(): Promise<{ ok: boolean; message?: string }>;
}

/** Usage metering hook registry — the usage meter consumes these events. */
export class VoiceUsageMeter {
  private readonly listeners = new Set<VoiceUsageListener>();

  subscribe(listener: VoiceUsageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(usage: { providerName: string; characters: number; voiceId: string }): void {
    for (const listener of this.listeners) listener(usage);
  }
}

/**
 * ElevenLabs adapter ported from OpenMausBot server/tts/elevenlabs.ts:
 * one request per utterance, key verified before storage, honest error
 * messages from the provider, key never leaves the server side.
 */
export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly name = "elevenlabs";
  readonly configured: boolean;
  readonly blocker?: string;

  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly usage: VoiceUsageMeter;

  constructor(options: { apiKey?: string; apiBase?: string; fetchImpl?: typeof fetch; usage?: VoiceUsageMeter }) {
    this.apiKey = options.apiKey ?? "";
    this.configured = this.apiKey.length > 0;
    this.blocker = this.configured ? undefined : "missing ELEVENLABS_API_KEY configuration";
    this.apiBase = options.apiBase ?? "https://api.elevenlabs.io/v1";
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.usage = options.usage ?? new VoiceUsageMeter();
  }

  get usageMeter(): VoiceUsageMeter {
    return this.usage;
  }

  async verifyKey(): Promise<{ ok: boolean; message?: string }> {
    if (!this.configured) return { ok: false, message: this.blocker };
    const res = await this.fetchImpl(`${this.apiBase}/user`, {
      headers: { "xi-api-key": this.apiKey },
    });
    if (!res.ok) return { ok: false, message: friendlyError(res.status) };
    return { ok: true };
  }

  async listVoices(): Promise<Array<{ id: string; label: string; description?: string }>> {
    if (!this.configured) return [];
    const res = await this.fetchImpl(`${this.apiBase}/voices`, {
      headers: { "xi-api-key": this.apiKey },
    });
    if (!res.ok) throw new Error(friendlyError(res.status));
    const body = (await res.json()) as {
      voices?: Array<{ voice_id: string; name: string; labels?: Record<string, string> }>;
    };
    return (body.voices ?? []).map((v) => ({
      id: v.voice_id,
      label: v.name,
      description: v.labels ? Object.entries(v.labels).map(([k, val]) => `${k}: ${val}`).join(", ") : undefined,
    }));
  }

  async synthesize(request: SpeechRequest): Promise<SpeechAudio> {
    if (!this.configured) throw new Error(`voice provider not configured: ${this.blocker}`);
    const model = request.selection.model ?? "eleven_flash_v2_5";
    const format = request.format ?? "mp3_44100_64";
    const res = await this.fetchImpl(
      `${this.apiBase}/text-to-speech/${encodeURIComponent(request.selection.voiceId)}?output_format=${format}`,
      {
        method: "POST",
        headers: { "xi-api-key": this.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: request.text, model_id: model }),
      },
    );
    if (!res.ok) throw new Error(friendlyError(res.status));
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.usage.emit({
      providerName: this.name,
      characters: request.text.length,
      voiceId: request.selection.voiceId,
    });
    return { bytes, mime: format.startsWith("wav") ? "audio/wav" : "audio/mpeg", charactersBilled: request.text.length };
  }
}

function friendlyError(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "Voice provider rejected the API key or its scopes.";
    case 402:
      return "Voice provider account is out of credit.";
    case 429:
      return "Voice provider is rate-limiting this account; retry shortly.";
    default:
      return `voice provider request failed (${status})`;
  }
}

// ---- Device/CUA capabilities ---------------------------------------------------

export interface DeviceCapabilitySet {
  screenCapture: boolean;
  tapInput: boolean;
  keyboardInput: boolean;
  appLaunch: boolean;
}

export interface DeviceDescriptor {
  deviceId: string;
  displayName: string;
  platform: "android" | "ios" | "desktop";
  capabilities: DeviceCapabilitySet;
  online: boolean;
}

/**
 * DeviceProvider advertises capabilities up front. Actions against offline
 * or uncapable devices fail gracefully with explicit reasons — no silent
 * mock success, no Electron assumption.
 */
export interface DeviceAction {
  kind: "screen.capture" | "input.tap" | "input.type" | "app.launch";
  payload: Record<string, unknown>;
}

export interface DeviceActionResult {
  ok: boolean;
  output?: Record<string, unknown>;
  reason?: "offline" | "capability_missing" | "not_authorized";
}

const REQUIRED_CAPABILITY: Record<DeviceAction["kind"], keyof DeviceCapabilitySet> = {
  "screen.capture": "screenCapture",
  "input.tap": "tapInput",
  "input.type": "keyboardInput",
  "app.launch": "appLaunch",
};

export interface DeviceTransport {
  send(deviceId: string, action: DeviceAction): Promise<{ ok: boolean; output?: Record<string, unknown> }>;
}

export class HttpDeviceTransport implements DeviceTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(deviceId: string, action: DeviceAction): Promise<{ ok: boolean; output?: Record<string, unknown> }> {
    try {
      const res = await this.fetchImpl(`/device-relay/${encodeURIComponent(deviceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      });
      return res.ok ? { ok: true } : { ok: false };
    } catch {
      return { ok: false };
    }
  }
}

export class DeviceProvider {
  readonly name = "mox-device-relay";

  constructor(
    private readonly transport: DeviceTransport = new HttpDeviceTransport(),
    private readonly devices = new Map<string, DeviceDescriptor>(),
    private readonly authorizedUsers = new Map<string, Set<string>>(),
  ) {}

  registerDevice(device: DeviceDescriptor): void {
    this.devices.set(device.deviceId, device);
  }

  authorizeUser(deviceId: string, userId: string): void {
    let set = this.authorizedUsers.get(deviceId);
    if (!set) {
      set = new Set();
      this.authorizedUsers.set(deviceId, set);
    }
    set.add(userId);
  }

  listDevices(userId: string): DeviceDescriptor[] {
    return [...this.devices.values()].filter((d) => this.authorizedUsers.get(d.deviceId)?.has(userId));
  }

  async perform(input: { deviceId: string; userId: string } & DeviceAction): Promise<DeviceActionResult> {
    const device = this.devices.get(input.deviceId);
    if (!device || !this.authorizedUsers.get(input.deviceId)?.has(input.userId)) {
      return { ok: false, reason: "not_authorized" };
    }
    if (!device.online) return { ok: false, reason: "offline" };
    const required = REQUIRED_CAPABILITY[input.kind];
    if (!device.capabilities[required]) return { ok: false, reason: "capability_missing" };
    try {
      const result = await this.transport.send(input.deviceId, input);
      return result.ok ? { ok: true, output: result.output } : { ok: false, reason: "offline" };
    } catch {
      return { ok: false, reason: "offline" };
    }
  }
}
