import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"; 
import { Pool } from "pg"; 
import * as schema from "./schema/index.js"; 
 
/** Database handle bound to the Mox schema. */ 
export type MoxDb = NodePgDatabase<typeof schema>; 
 
export interface CreateDbOptions { 
  connectionString: string; 
  max?: number; 
} 
 
export function createDb(options: CreateDbOptions): { db: MoxDb; pool: Pool } { 
  const pool = new Pool({ connectionString: options.connectionString, max: options.max ?? 10 }); 
  return { db: drizzle(pool, { schema }), pool }; 
} 
