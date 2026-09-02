import { useEffect, useMemo, useState } from "react";
import { useMox } from "../api/store.js";
import { useRoute } from "../router.js";
import { Badge, Button, ErrorState, LoadingState } from "../ui/primitives.js";
import { slugFromName } from "../domain/authoring.js";
import {
  ONBOARDING_GOALS,
  ONBOARDING_PERSONAS,
  ONBOARDING_PERMISSION_PRESETS,
  ONBOARDING_STEP_META,
  ONBOARDING_TOTAL_STEPS,
  deriveOnboardingReview,
  ONBOARDING_REVIEW_BADGE,
} from "../domain/onboarding.js";
import type {
  ModelConnectionRow,
  ModelOption,
  OnboardingPersona,
  OnboardingState,
  ServerOrderView,
  ServerSummary,
} from "../api/types.js";

/**
 * Mandatory customer onboarding — a STANDALONE full-screen flow.
 *
 * This view never renders the customer sidebar or any application chrome:
 * it is mounted by the customer surface router BEFORE the CustomerShell wrap
 * (apps/web/src/App.tsx), like the public auth pages but authenticated-only.
 * It reuses the shared design system (buttons, cards, badges, tokens) and
 * every real product authority (BYOK credential vault, agent authoring,
 * server ordering). Deferred choices are honest — they never mark a feature
 * configured.
 */

const STEP_ORDER = [1, 2, 3, 4, 5, 6] as const;

function clampStep(step: number | undefined | null): number {
  if (!step || !Number.isFinite(step)) return 1;
  return Math.min(ONBOARDING_TOTAL_STEPS, Math.max(1, Math.trunc(step)));
}

function cloneState(state: OnboardingState | null): OnboardingState | null {
  if (!state) return null;
  return {
    ...state,
    completedSteps: [...state.completedSteps],
    goals: [...state.goals],
  };
}

interface CatalogBundle {
  models: ModelOption[];
  connections: ModelConnectionRow[];
  servers: ServerSummary[];
  includedServerCount: number | null;
  includedComputeClass: string | null;
  catalogError: string | null;
}

export function OnboardingView() {
  const mox = useMox();
  const { navigate } = useRoute();
  const [state, setState] = useState<OnboardingState | null>(() => cloneState(mox.onboarding));
  const [step, setStep] = useState<number>(() => clampStep(mox.onboarding?.currentStep));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogBundle | null>(null);

  // Keep local state in sync when the store re-loads (org switch, login).
  useEffect(() => {
    setState((current) => (mox.onboarding && !current ? cloneState(mox.onboarding) : current));
  }, [mox.onboarding]);

  const loadCatalog = async () => {
    setError(null);
    try {
      const [models, connections, servers, ents] = await Promise.all([
        mox.api.listModels().catch(() => [] as ModelOption[]),
        mox.api.listModelConnections().catch(() => [] as ModelConnectionRow[]),
        mox.api.listServers().catch(() => [] as ServerSummary[]),
        mox.entitlements ? Promise.resolve(mox.entitlements) : mox.api.getEntitlements().catch(() => undefined),
      ]);
      const values = (ents?.values ?? {}) as Record<string, unknown>;
      setCatalog({
        models,
        connections,
        servers,
        includedServerCount: typeof values.included_server_count === "number" ? values.included_server_count : null,
        includedComputeClass: typeof values.included_compute_class === "string" ? values.included_compute_class : null,
        catalogError: null,
      });
    } catch (err) {
      setCatalog((prev) =>
        prev ?? {
          models: [],
          connections: [],
          servers: [],
          includedServerCount: null,
          includedComputeClass: null,
          catalogError: err instanceof Error ? err.message : String(err),
        },
      );
    }
  };

  useEffect(() => {
    if (!catalog) void loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = async (input: Parameters<typeof mox.api.updateOnboarding>[0]): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const next = await mox.api.updateOnboarding(input);
      setState(cloneState(next));
      void mox.refreshOnboarding();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const goTo = (nextStep: number) => {
    setError(null);
    setStep(clampStep(nextStep));
  };

  const advance = async (input: Parameters<typeof mox.api.updateOnboarding>[0]) => {
    const ok = await patch({ ...input, advanceTo: clampStep(input.step + 1) });
    if (ok) goTo(clampStep(input.step + 1));
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const completed = await mox.api.completeOnboarding();
      setState(cloneState(completed));
      void mox.refreshOnboarding();
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    // Honest failure: the durable state could not be loaded (availability
    // incident). Never fabricate progress; offer a retry.
    const loadFailure = mox.error !== null || (mox.ready && !mox.onboarding);
    if (loadFailure) {
      return (
        <div className="onboarding-shell">
          <div className="onboarding-card onboarding-card-narrow">
            <ErrorState
              message={`Your onboarding progress could not be loaded from the Mox control plane.${mox.error ? ` Backend unavailable: ${mox.error}` : " Nothing was lost — retry to resume."}`}
              onRetry={() => void mox.refreshOnboarding()}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="onboarding-shell">
        <div className="onboarding-card onboarding-card-narrow">
          <LoadingState label="Loading your onboarding progress…" />
        </div>
      </div>
    );
  }

  const meta = ONBOARDING_STEP_META[step]!;

  // Focused full-screen flow: NO header, footer or sidebar chrome — a single
  // centered card with the progress indicator, the step content and an inline
  // action row only.
  const onBack = step > 1 ? () => goTo(step - 1) : undefined;

  return (
    <div className="onboarding-shell">
      <main className="onboarding-main">
        <section className="onboarding-card" aria-labelledby="onboarding-step-title">
          <div className="onboarding-progress" role="progressbar" aria-label="Onboarding progress" aria-valuemin={1} aria-valuemax={ONBOARDING_TOTAL_STEPS} aria-valuenow={step} aria-valuetext={`Step ${step} of ${ONBOARDING_TOTAL_STEPS}: ${meta.kicker}`}>
            <div className="onboarding-progress-track" aria-hidden="true">
              <div className="onboarding-progress-fill" style={{ width: `${(step / ONBOARDING_TOTAL_STEPS) * 100}%` }} />
            </div>
            <p className="onboarding-progress-text">
              Step <strong>{step}</strong> of {ONBOARDING_TOTAL_STEPS} — {meta.kicker}
            </p>
            <ol className="onboarding-steps" aria-label="Onboarding steps">
              {STEP_ORDER.map((n) => (
                <li
                  key={n}
                  className={`onboarding-step${n === step ? " current" : ""}${state.completedSteps.includes(n) ? " done" : ""}`}
                  aria-current={n === step ? "step" : undefined}
                >
                  {n}. {ONBOARDING_STEP_META[n]!.kicker}
                </li>
              ))}
            </ol>
            <p className="onboarding-save-note muted">Progress is saved as you continue — you can leave and resume any time.</p>
          </div>

          <h1 id="onboarding-step-title">{meta.title}</h1>
          {error ? (
            <div className="mastra-error-box" role="alert">
              {error}
            </div>
          ) : null}
          {mox.error ? (
            <div className="mastra-error-box" role="alert">
              Backend unavailable: {mox.error}
            </div>
          ) : null}

          {step === 1 ? <StepWorkspace state={state} busy={busy} onAdvance={advance} onBack={onBack} /> : null}
          {step === 2 ? <StepGoals state={state} busy={busy} onAdvance={advance} onBack={onBack} /> : null}
          {step === 3 ? (
            <StepModels
              state={state}
              busy={busy}
              catalog={catalog}
              onAdvance={advance}
              onBack={onBack}
              onReloadCatalog={() => void loadCatalog()}
            />
          ) : null}
          {step === 4 ? <StepAgent state={state} busy={busy} catalog={catalog} onAdvance={advance} onBack={onBack} /> : null}
          {step === 5 ? (
            <StepInfrastructure
              busy={busy}
              catalog={catalog}
              onAdvance={advance}
              onBack={onBack}
              onReloadCatalog={() => void loadCatalog()}
            />
          ) : null}
          {step === 6 ? (
            <StepConnections state={state} busy={busy} catalog={catalog} onPatch={patch} onAdvance={advance} onBack={onBack} onFinish={finish} />
          ) : null}

        </section>
      </main>
    </div>
  );
}

// ---- Step 1: welcome / workspace ------------------------------------------------

function StepWorkspace({
  state,
  busy,
  onAdvance,
  onBack,
}: {
  state: OnboardingState;
  busy: boolean;
  onAdvance: (input: { step: number; persona: OnboardingPersona; displayName: string; workspaceName: string }) => Promise<void>;
  onBack?: () => void;
}) {
  const mox = useMox();
  const [displayName, setDisplayName] = useState(state.displayName ?? mox.me?.displayName ?? "");
  const [workspaceName, setWorkspaceName] = useState(state.workspaceName ?? mox.me?.orgDisplayName ?? "");
  const [persona, setPersona] = useState<OnboardingPersona | null>((state.persona as OnboardingPersona | null) ?? null);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = () => {
    if (!persona) {
      setLocalError("Choose the description that fits you best.");
      return;
    }
    if (!displayName.trim() || !workspaceName.trim()) {
      setLocalError("Your name and the workspace name are required.");
      return;
    }
    setLocalError(null);
    void onAdvance({ step: 1, persona, displayName: displayName.trim(), workspaceName: workspaceName.trim() });
  };

  return (
    <div className="onboarding-body">
      <p className="onboarding-lede">
        Confirm your details, then we will tailor setup to how you plan to use Mox. Everything you already told us at
        signup is prefilled.
      </p>
      {localError ? (
        <div className="mastra-error-box" role="alert">
          {localError}
        </div>
      ) : null}
      <div className="onboarding-field">
        <label htmlFor="onb-display-name">Your name</label>
        <input id="onb-display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" />
      </div>
      <div className="onboarding-field">
        <label htmlFor="onb-workspace-name">Workspace name</label>
        <input id="onb-workspace-name" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
        <p className="muted onboarding-hint">Shown across the dashboard. You can change it later in Settings.</p>
      </div>
      <fieldset className="onboarding-option-grid">
        <legend>Which best describes you?</legend>
        {ONBOARDING_PERSONAS.map((option) => (
          <label key={option.id} className={`onboarding-option${persona === option.id ? " selected" : ""}`}>
            <input
              type="radio"
              name="onb-persona"
              value={option.id}
              checked={persona === option.id}
              onChange={() => setPersona(option.id)}
            />
            <span className="onboarding-option-text">
              <strong>{option.label}</strong>
              <small>{option.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <footer className="onboarding-actions">
        {onBack ? (
          <Button kind="ghost" onClick={onBack} disabled={busy}>
            Back
          </Button>
        ) : null}
        <div className="onboarding-actions-end">
          <Button kind="primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Continue"}
          </Button>
        </div>
      </footer>
    </div>
  );
}

// ---- Step 2: goals ----------------------------------------------------------------

function StepGoals({
  state,
  busy,
  onAdvance,
  onBack,
}: {
  state: OnboardingState;
  busy: boolean;
  onAdvance: (input: { step: number; goals: string[] }) => Promise<void>;
  onBack?: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(state.goals));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="onboarding-body">
      <p className="onboarding-lede">
        Pick everything that applies. This only personalizes your setup — it never changes what your plan allows.
      </p>
      <fieldset className="onboarding-option-grid">
        <legend>Reasons for using Mox</legend>
        {ONBOARDING_GOALS.map((goal) => (
          <label key={goal.id} className={`onboarding-option${selected.has(goal.id) ? " selected" : ""}`}>
            <input type="checkbox" checked={selected.has(goal.id)} onChange={() => toggle(goal.id)} />
            <span className="onboarding-option-text">
              <strong>{goal.label}</strong>
              <small>{goal.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <footer className="onboarding-actions">
        {onBack ? (
          <Button kind="ghost" onClick={onBack} disabled={busy}>
            Back
          </Button>
        ) : null}
        <div className="onboarding-actions-end">
          <Button kind="primary" onClick={() => void onAdvance({ step: 2, goals: [...selected] })} disabled={busy}>
            {busy ? "Saving…" : "Continue"}
          </Button>
        </div>
      </footer>
    </div>
  );
}

// ---- Step 3: AI / model setup ------------------------------------------------------

function StepModels({
  state,
  busy,
  catalog,
  onAdvance,
  onBack,
  onReloadCatalog,
}: {
  state: OnboardingState;
  busy: boolean;
  catalog: CatalogBundle | null;
  onAdvance: (input: { step: number; modelSetupChoice: "mox_managed" | "own_provider" | "deferred"; modelProviderId?: string }) => Promise<void>;
  onBack?: () => void;
  onReloadCatalog: () => void;
}) {
  const mox = useMox();
  const byokProviders = (catalog?.connections ?? []).filter((c) => c.authMethods.includes("api_key"));
  const moxManagedAvailable = (catalog?.models ?? []).some((m) => m.providerId === "mox");
  const moxConnected = (catalog?.models ?? []).some((m) => m.providerId === "mox" && m.available);

  const [mode, setMode] = useState<"managed" | "own" | "later" | null>(
    state.modelSetupChoice === "deferred" ? "later" : state.modelSetupChoice ? "managed" : null,
  );
  const [providerId, setProviderId] = useState(state.modelProviderId ?? byokProviders[0]?.providerId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [stepError, setStepError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const selectedProvider = byokProviders.find((p) => p.providerId === providerId) ?? null;

  const connectOwnProvider = async () => {
    if (!selectedProvider) {
      setStepError("Choose a provider to connect.");
      return;
    }
    if (!apiKey.trim()) {
      setStepError("An API key is required. It is stored in the customer credential vault, never in onboarding state.");
      return;
    }
    setConnecting(true);
    setStepError(null);
    try {
      await mox.api.connectModelConnection(selectedProvider.providerId, {
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
      });
      setApiKey("");
      onReloadCatalog();
      await onAdvance({ step: 3, modelSetupChoice: "own_provider", modelProviderId: selectedProvider.providerId });
    } catch (err) {
      setStepError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  const continueDisabled =
    busy || connecting || mode === null || (mode === "own" && !apiKey.trim() && !selectedProvider?.connected);

  return (
    <div className="onboarding-body">
      <p className="onboarding-lede">Choose how Mox reaches the models your agents will run on. You can change this any time on the Models page.</p>
      {stepError ? (
        <div className="mastra-error-box" role="alert">
          {stepError}
        </div>
      ) : null}
      {moxConnected ? (
        <div className="onboarding-connected-note" role="status">
          <Badge tone="good">Connected</Badge> Mox-managed models are active in this workspace.
        </div>
      ) : null}

      <fieldset className="onboarding-option-grid">
        <legend>Model access</legend>
        <label className={`onboarding-option${mode === "managed" ? " selected" : ""}${moxManagedAvailable ? "" : " disabled"}`}>
          <input
            type="radio"
            name="onb-model-mode"
            checked={mode === "managed"}
            onChange={() => setMode("managed")}
            disabled={!moxManagedAvailable}
          />
          <span className="onboarding-option-text">
            <strong>Use Mox-managed models</strong>
            <small>
              {moxManagedAvailable
                ? "Included Mox-managed model access for this workspace."
                : "Mox-managed model configuration is not available on this deployment."}
            </small>
          </span>
        </label>
        <label className={`onboarding-option${mode === "own" ? " selected" : ""}`}>
          <input type="radio" name="onb-model-mode" checked={mode === "own"} onChange={() => setMode("own")} />
          <span className="onboarding-option-text">
            <strong>Connect my own provider</strong>
            <small>Your API key goes into the encrypted customer credential vault — it is never shown again.</small>
          </span>
        </label>
        <label className={`onboarding-option${mode === "later" ? " selected" : ""}`}>
          <input type="radio" name="onb-model-mode" checked={mode === "later"} onChange={() => setMode("later")} />
          <span className="onboarding-option-text">
            <strong>Configure later</strong>
            <small>Recorded as deferred — nothing is connected until you set a provider up.</small>
          </span>
        </label>
      </fieldset>

      {mode === "own" ? (
        <div className="onboarding-subform">
          <div className="onboarding-field">
            <label htmlFor="onb-provider">Provider</label>
            <select id="onb-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {byokProviders.length === 0 ? <option value="">No BYOK providers available</option> : null}
              {byokProviders.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.displayName}
                  {provider.connected ? " (connected)" : ""}
                </option>
              ))}
            </select>
          </div>
          {selectedProvider?.connected ? (
            <p className="muted onboarding-hint" role="note">
              {selectedProvider.displayName} is already connected. Continue to keep it, or rotate its key on the Models page.
            </p>
          ) : (
            <>
              <div className="onboarding-field">
                <label htmlFor="onb-api-key">API key</label>
                <input
                  id="onb-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  placeholder={`${selectedProvider?.displayName ?? "Provider"} API key`}
                />
              </div>
              {selectedProvider?.baseUrlSupported ? (
                <div className="onboarding-field">
                  <label htmlFor="onb-base-url">Base URL (optional)</label>
                  <input id="onb-base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" />
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {mode === "later" ? (
        <p className="onboarding-defer-note muted">Deferred is a normal choice. Agents you create will wait for model access — Mox will never pretend a provider is connected.</p>
      ) : null}

      <footer className="onboarding-actions">
        {onBack ? (
          <Button kind="ghost" onClick={onBack} disabled={busy || connecting}>
            Back
          </Button>
        ) : null}
        <div className="onboarding-actions-end">
          {mode === "own" ? (
            <Button kind="primary" onClick={() => void connectOwnProvider()} disabled={continueDisabled}>
              {connecting ? "Connecting…" : "Connect and continue"}
            </Button>
          ) : (
            <Button
              kind="primary"
              disabled={continueDisabled}
              onClick={() => {
                if (mode === "managed") void onAdvance({ step: 3, modelSetupChoice: "mox_managed" });
                if (mode === "later") void onAdvance({ step: 3, modelSetupChoice: "deferred" });
              }}
            >
              {busy ? "Saving…" : "Continue"}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

// ---- Step 4: first agent -----------------------------------------------------------

function StepAgent({
  state,
  busy,
  catalog,
  onAdvance,
  onBack,
}: {
  state: OnboardingState;
  busy: boolean;
  catalog: CatalogBundle | null;
  onAdvance: (input: { step: number; agentSetupChoice: "created" | "deferred"; agentId?: string }) => Promise<void>;
  onBack?: () => void;
}) {
  const mox = useMox();
  const availableModels = (catalog?.models ?? []).filter((m) => m.available);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState(availableModels[0] ? `${availableModels[0].providerId}/${availableModels[0].modelId}` : "");
  const [preset, setPreset] = useState<SimpleAgentPreset>("safe");
  const [stepError, setStepError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      setStepError("Give your agent a name.");
      return;
    }
    if (!model) {
      setStepError("No model is available yet. Configure model access in the previous step, or defer the agent.");
      return;
    }
    setCreating(true);
    setStepError(null);
    try {
      const result = await mox.api.createAgentDraft({
        mode: "simple",
        slug: slugFromName(name.trim()) ?? "agent",
        input: {
          displayName: name.trim(),
          role: role.trim() || undefined,
          instructions: instructions.trim(),
          model,
          toolNames: [],
          browserEnabled: false,
          permissionsPreset: preset,
          target: { kind: "sandbox" },
        },
      });
      await onAdvance({ step: 4, agentSetupChoice: "created", agentId: result.agentId });
    } catch (err) {
      setStepError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const existingAgent = state.agentSetupChoice === "created" && state.agentId;

  return (
    <div className="onboarding-body">
      <p className="onboarding-lede">
        Create a real agent draft with the canonical authoring flow — or start from the dashboard later. Drafts stay
        unpublished until you publish them.
      </p>
      {stepError ? (
        <div className="mastra-error-box" role="alert">
          {stepError}
        </div>
      ) : null}
      {existingAgent ? (
        <div className="onboarding-connected-note" role="status">
          <Badge tone="good">Created</Badge> Your first agent draft is saved in this workspace.
        </div>
      ) : null}
      <div className="onboarding-field">
        <label htmlFor="onb-agent-name">Agent name</label>
        <input id="onb-agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Research assistant" />
      </div>
      <div className="onboarding-field">
        <label htmlFor="onb-agent-role">Role / purpose (optional)</label>
        <input id="onb-agent-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Weekly competitor digest" />
      </div>
      <div className="onboarding-field">
        <label htmlFor="onb-agent-instructions">Instructions (optional)</label>
        <textarea
          id="onb-agent-instructions"
          rows={3}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="What should this agent do?"
        />
      </div>
      <div className="onboarding-field">
        <label htmlFor="onb-agent-model">Model</label>
        <select id="onb-agent-model" value={model} onChange={(e) => setModel(e.target.value)}>
          {availableModels.length === 0 ? <option value="">No models available yet</option> : null}
          {availableModels.map((m) => (
            <option key={`${m.providerId}/${m.modelId}`} value={`${m.providerId}/${m.modelId}`}>
              {m.displayName}
            </option>
          ))}
        </select>
        {availableModels.length === 0 ? (
          <p className="muted onboarding-hint">Models become available once a provider is connected in the previous step.</p>
        ) : null}
      </div>
      <fieldset className="onboarding-option-grid onboarding-option-row">
        <legend>Permission preset</legend>
        {ONBOARDING_PERMISSION_PRESETS.map((option) => (
          <label key={option.id} className={`onboarding-option${preset === option.id ? " selected" : ""}`}>
            <input type="radio" name="onb-preset" checked={preset === option.id} onChange={() => setPreset(option.id)} />
            <span className="onboarding-option-text">
              <strong>{option.label}</strong>
              <small>{option.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="muted onboarding-hint">The draft targets the Mox sandbox — you can retarget it to your own server after infrastructure is ready.</p>

      <footer className="onboarding-actions">
        {onBack ? (
          <Button kind="ghost" onClick={onBack} disabled={busy || creating}>
            Back
          </Button>
        ) : null}
        <div className="onboarding-actions-end">
          <Button kind="ghost" onClick={() => void onAdvance({ step: 4, agentSetupChoice: "deferred" })} disabled={busy || creating}>
            {busy ? "Saving…" : "I'll create my first agent from the dashboard"}
          </Button>
          <Button kind="primary" onClick={() => void submit()} disabled={busy || creating}>
            {creating ? "Creating…" : "Create my first agent"}
          </Button>
        </div>
      </footer>
    </div>
  );
}

type SimpleAgentPreset = "safe" | "balanced" | "full";

// ---- Step 5: infrastructure ---------------------------------------------------------

function StepInfrastructure({
  busy,
  catalog,
  onAdvance,
  onBack,
  onReloadCatalog,
}: {
  busy: boolean;
  catalog: CatalogBundle | null;
  onAdvance: (input: { step: number; infrastructureSetupChoice: "provisioned" | "deferred"; serverOrderId?: string }) => Promise<void>;
  onBack?: () => void;
  onReloadCatalog: () => void;
}) {
  const mox = useMox();
  const servers = catalog?.servers ?? [];
  const included = catalog?.includedServerCount;
  const computeClass = catalog?.includedComputeClass ?? null;
  const commerciallyEntitled = mox.entitlements?.commerciallyEntitled === true;
  const canProvision = commerciallyEntitled && typeof included === "number" && included >= 1 && Boolean(computeClass);

  const [hostname, setHostname] = useState("");
  const [stepError, setStepError] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [order, setOrder] = useState<ServerOrderView | null>(null);

  const provision = async () => {
    const host = hostname.trim() || `${(mox.me?.orgSlug ?? "workspace").slice(0, 20)}-01`;
    setOrdering(true);
    setStepError(null);
    try {
      const placed = await mox.api.orderServer({
        computeClassCode: computeClass!,
        hostname: host,
        idempotencyKey: `onboarding-server-${mox.me?.orgId ?? ""}`,
      });
      setOrder(placed);
      onReloadCatalog();
      await onAdvance({ step: 5, infrastructureSetupChoice: "provisioned", serverOrderId: placed.orderId });
    } catch (err) {
      setStepError(err instanceof Error ? err.message : String(err));
    } finally {
      setOrdering(false);
    }
  };

  return (
    <div className="onboarding-body">
      <p className="onboarding-lede">
        This is your real commercial state. Mox never provisions a server just because you signed up — ordering is
        explicit and uses the server-order authority.
      </p>
      {stepError ? (
        <div className="mastra-error-box" role="alert">
          {stepError}
        </div>
      ) : null}
      <div className="onboarding-facts">
        <div className="onboarding-fact">
          <span className="onboarding-fact-label">Included servers</span>
          <strong>{included === null ? "Unknown" : included}</strong>
        </div>
        <div className="onboarding-fact">
          <span className="onboarding-fact-label">Compute class</span>
          <strong>{computeClass ?? "Not included"}</strong>
        </div>
        <div className="onboarding-fact">
          <span className="onboarding-fact-label">Current servers</span>
          <strong>{servers.length}</strong>
        </div>
        <div className="onboarding-fact">
          <span className="onboarding-fact-label">State</span>
          <strong>{servers[0] ? servers[0].state : "None"}</strong>
        </div>
      </div>

      {!commerciallyEntitled ? (
        <div className="onboarding-unavailable" role="note">
          <Badge tone="bad">Unavailable</Badge> Commercial access is not active for this workspace, so provisioning is
          unavailable right now. You can defer and set up billing from the Billing page.
        </div>
      ) : canProvision ? (
        <div className="onboarding-subform">
          <div className="onboarding-field">
            <label htmlFor="onb-hostname">Server hostname</label>
            <input id="onb-hostname" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder={`${mox.me?.orgSlug ?? "workspace"}-01`} />
            <p className="muted onboarding-hint">Ordered on the {computeClass} compute class included with your plan.</p>
          </div>
          {order ? (
            <p className="onboarding-connected-note" role="status">
              <Badge tone="accent">Provisioning</Badge> Order {order.orderId.slice(0, 8)} accepted — real state appears on the Servers page.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="onboarding-unavailable" role="note">
          <Badge tone="bad">Unavailable</Badge> This plan does not include a server entitlement, so provisioning is not
          available here.
        </div>
      )}

      <footer className="onboarding-actions">
        {onBack ? (
          <Button kind="ghost" onClick={onBack} disabled={busy || ordering}>
            Back
          </Button>
        ) : null}
        <div className="onboarding-actions-end">
          <Button kind="ghost" onClick={() => void onAdvance({ step: 5, infrastructureSetupChoice: "deferred" })} disabled={busy || ordering}>
            {busy ? "Saving…" : "I'll provision infrastructure later"}
          </Button>
          {canProvision && !order ? (
            <Button kind="primary" onClick={() => void provision()} disabled={busy || ordering}>
              {ordering ? "Ordering…" : "Provision my server"}
            </Button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

// ---- Step 6: connections + ready ---------------------------------------------------

function StepConnections({
  state,
  busy,
  catalog,
  onPatch,
  onAdvance,
  onBack,
  onFinish,
}: {
  state: OnboardingState;
  busy: boolean;
  catalog: CatalogBundle | null;
  onPatch: (input: { step: number; connectionsSetupChoice: "configured" | "deferred" }) => Promise<boolean>;
  onAdvance: (input: { step: number; connectionsSetupChoice: "configured" | "deferred" }) => Promise<void>;
  onBack?: () => void;
  onFinish: () => Promise<void>;
}) {
  const mox = useMox();
  const [integrations, setIntegrations] = useState<Awaited<ReturnType<typeof mox.api.listIntegrations>>>([]);
  const [channels, setChannels] = useState<Awaited<ReturnType<typeof mox.api.listChannels>>>([]);
  const [tokens, setTokens] = useState<Awaited<ReturnType<typeof mox.api.listApiTokens>>>([]);
  const [agents, setAgents] = useState<Awaited<ReturnType<typeof mox.api.listAgents>>>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const load = async () => {
    setListError(null);
    try {
      const [ints, chans, toks, ags] = await Promise.all([
        mox.api.listIntegrations().catch(() => []),
        mox.api.listChannels().catch(() => []),
        mox.api.listApiTokens().catch(() => []),
        mox.api.listAgents().catch(() => []),
      ]);
      setIntegrations(ints);
      setChannels(chans);
      setTokens(toks);
      setAgents(ags);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reviewInputs = useMemo(
    () => ({
      onboarding: state,
      models: catalog?.models ?? [],
      modelConnections: catalog?.connections ?? [],
      agentCount: Math.max(agents.length, state.agentId ? 1 : 0),
      servers: catalog?.servers ?? [],
      integrations,
      channels,
      apiTokens: tokens,
      includedServerCount: catalog?.includedServerCount ?? null,
    }),
    [state, catalog, agents.length, integrations, channels, tokens],
  );
  const review = useMemo(() => deriveOnboardingReview(reviewInputs), [reviewInputs]);

  const createToken = async () => {
    setWorking("token");
    setStepError(null);
    try {
      const created = await mox.api.createApiToken({ name: "Onboarding token", scopes: ["agents", "models", "servers", "integrations", "channels", "usage", "settings"] });
      setCreatedToken(created.token);
      await onPatch({ step: 6, connectionsSetupChoice: "configured" });
      await load();
    } catch (err) {
      setStepError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(null);
    }
  };

  const configuredCount =
    integrations.filter((i) => i.connected).length + channels.filter((c) => c.connected).length + tokens.filter((t) => !t.revoked).length;
  const agentForChannels = agents[0]?.agentId ?? (state.agentSetupChoice === "created" ? state.agentId : null);

  return (
    <div className="onboarding-body">
      <p className="onboarding-lede">
        Connect what you need now — nothing here is required to finish. Everything below uses the real connection
        authorities, so counts reflect reality.
      </p>
      {stepError || listError ? (
        <div className="mastra-error-box" role="alert">
          {stepError ?? listError}
        </div>
      ) : null}

      <div className="onboarding-connection-groups">
        <section className="onboarding-connection-group">
          <h2>Channels</h2>
          <p className="muted">
            {channels.filter((c) => c.connected).length} connected of {channels.length} available
            {channels.length > 0 && !agentForChannels ? " — channels bind to an agent, so create your first agent to connect one." : "."}
          </p>
          {channels.filter((c) => c.connected).length > 0 ? <Badge tone="good">Connected</Badge> : <Badge tone="neutral">None yet</Badge>}
        </section>
        <section className="onboarding-connection-group">
          <h2>Integrations</h2>
          <p className="muted">
            {integrations.filter((i) => i.connected).length} connected of {integrations.length} available. Connect the
            rest any time from the Integrations page.
          </p>
          {integrations.filter((i) => i.connected).length > 0 ? <Badge tone="good">Connected</Badge> : <Badge tone="neutral">None yet</Badge>}
        </section>
        <section className="onboarding-connection-group">
          <h2>Developer / API access</h2>
          <p className="muted">{tokens.filter((t) => !t.revoked).length} active API tokens.</p>
          {createdToken ? (
            <div className="onboarding-token-reveal" role="alert">
              <strong>Copy your token now — it is shown only once:</strong>
              <code>{createdToken}</code>
            </div>
          ) : (
            <Button size="sm" onClick={() => void createToken()} disabled={working === "token"}>
              {working === "token" ? "Creating…" : "Create API token"}
            </Button>
          )}
        </section>
      </div>

      <h2 className="onboarding-review-title">Readiness review</h2>
      <dl className="onboarding-review">
        {review.map((row) => {
          const badge = ONBOARDING_REVIEW_BADGE[row.status];
          return (
            <div className="onboarding-review-row" key={row.key}>
              <dt>{row.label}</dt>
              <dd>
                <Badge tone={badge.tone}>{row.detail}</Badge>
                <span className="visually-hidden"> {badge.label}</span>
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="muted onboarding-hint">
        Deferred items are honest, not failures — they show where to pick up in the dashboard.
      </p>

      <footer className="onboarding-actions">
        {onBack ? (
          <Button kind="ghost" onClick={onBack} disabled={busy || working !== null}>
            Back
          </Button>
        ) : null}
        <div className="onboarding-actions-end">
          {state.connectionsSetupChoice !== "deferred" ? (
            <Button
              kind="ghost"
              onClick={() => void onAdvance({ step: 6, connectionsSetupChoice: "deferred" })}
              disabled={busy || working !== null}
            >
              {busy ? "Saving…" : "I'll connect apps later"}
            </Button>
          ) : (
            <span className="muted">Connections deferred — you can connect apps any time.</span>
          )}
          <Button kind="primary" onClick={() => void onFinish()} disabled={busy || working !== null}>
            {busy ? "Finishing…" : configuredCount > 0 ? `Finish onboarding (${configuredCount} configured)` : "Finish onboarding"}
          </Button>
        </div>
      </footer>
    </div>
  );
}
