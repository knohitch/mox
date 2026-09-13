-- Expand the customer-visible BYOK model-provider catalog.
--
-- The control-plane reads model_providers/models dynamically, so these rows
-- immediately surface on both the Models page and onboarding Step 3. A small
-- trigger keeps the same catalog available to organizations created after this
-- migration. Existing connection/credential rows are never touched.

CREATE OR REPLACE FUNCTION mox_seed_extended_model_catalog(target_org uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO model_providers (org_id, slug, display_name, kind, capabilities)
  VALUES
    (target_org, 'qwen', 'Qwen (Alibaba Cloud)', 'api', '{"authMethods":["api_key"],"baseUrlSupported":true}'::jsonb),
    (target_org, 'glm', 'Z.AI / GLM', 'api', '{"authMethods":["api_key"],"baseUrlSupported":true}'::jsonb),
    (target_org, 'kimi', 'Kimi (Moonshot AI)', 'api', '{"authMethods":["api_key"],"baseUrlSupported":true}'::jsonb),
    (target_org, 'mimo', 'Xiaomi MiMo', 'api', '{"authMethods":["api_key"],"baseUrlSupported":true}'::jsonb),
    (target_org, 'minimax', 'MiniMax', 'api', '{"authMethods":["api_key"],"baseUrlSupported":true}'::jsonb),
    (target_org, 'meta', 'Meta Muse', 'api', '{"authMethods":["api_key"],"baseUrlSupported":true}'::jsonb),
    (target_org, 'openai-compatible', 'Other OpenAI-compatible endpoint', 'api', '{"authMethods":["api_key"],"baseUrlSupported":true}'::jsonb)
  ON CONFLICT (org_id, slug) DO UPDATE
  SET
    display_name = EXCLUDED.display_name,
    kind = EXCLUDED.kind,
    capabilities = EXCLUDED.capabilities,
    updated_at = now();

  INSERT INTO models (org_id, provider_id, slug, display_name, context_window)
  SELECT
    target_org,
    provider.id,
    seeded.model_slug,
    seeded.model_display_name,
    seeded.context_window
  FROM (
    VALUES
      ('qwen', 'qwen-plus', 'Qwen · Plus', NULL::integer),
      ('glm', 'glm-5.1', 'Z.AI · GLM-5.1', NULL::integer),
      ('kimi', 'kimi-k2.6', 'Kimi · K2.6', NULL::integer),
      ('mimo', 'mimo-v2.5-pro', 'Xiaomi · MiMo V2.5 Pro', NULL::integer),
      ('minimax', 'MiniMax-M2.7', 'MiniMax · M2.7', 204800),
      ('meta', 'muse-spark-1.3', 'Meta · Muse Spark 1.3', 1048576)
  ) AS seeded(provider_slug, model_slug, model_display_name, context_window)
  JOIN model_providers AS provider
    ON provider.org_id = target_org
   AND provider.slug = seeded.provider_slug
  ON CONFLICT (provider_id, slug) DO UPDATE
  SET
    display_name = EXCLUDED.display_name,
    context_window = EXCLUDED.context_window;
END;
$$;

-- Backfill every existing workspace.
DO $$
DECLARE
  org_row record;
BEGIN
  FOR org_row IN SELECT id FROM organizations LOOP
    PERFORM mox_seed_extended_model_catalog(org_row.id);
  END LOOP;
END;
$$;

-- Keep future workspaces in sync without relying on a deployment restart.
CREATE OR REPLACE FUNCTION mox_seed_extended_model_catalog_for_new_org()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM mox_seed_extended_model_catalog(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_seed_extended_model_catalog ON organizations;
CREATE TRIGGER organizations_seed_extended_model_catalog
AFTER INSERT ON organizations
FOR EACH ROW
EXECUTE FUNCTION mox_seed_extended_model_catalog_for_new_org();
