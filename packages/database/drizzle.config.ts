import { defineConfig } from "drizzle-kit"; 
 
/** 
 * Deterministic migration generation: SQL is committed under ./migrations 
 * and applied by scripts/migrate.mjs in order. 
 */ 
export default defineConfig({ 
  dialect: "postgresql", 
  schema: "./src/schema/index.ts", 
  out: "./migrations", 
}); 
