// Applies committed drizzle migrations in lexicographic order. 
import { readdir, readFile } from "node:fs/promises"; 
import { createHash } from "node:crypto"; 
import pg from "pg"; 
 
const connectionString = process.env.DATABASE_URL; 
if (!connectionString) { 
  console.error("DATABASE_URL is required"); 
  process.exit(1); 
} 
 
const client = new pg.Client({ connectionString }); 
await client.connect(); 
await client.query( 
  "CREATE TABLE IF NOT EXISTS mox_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())" 
); 
 
const files = (await readdir(new URL("../migrations/", import.meta.url))).filter((f) => f.endsWith(".sql")).sort(); 
for (const file of files) { 
  const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"); 
  const checksum = createHash("sha256").update(sql).digest("hex"); 
  const applied = await client.query("SELECT checksum FROM mox_migrations WHERE name = $1", [file]); 
  if (applied.rowCount > 0) { 
    if (applied.rows[0].checksum !== checksum) { 
      console.error(`checksum mismatch for ${file}; refusing to apply`); 
      process.exit(1); 
    } 
    console.log(`skip ${file}`); 
    continue; 
  } 
  await client.query("BEGIN"); 
  try { 
    await client.query(sql); 
    await client.query("INSERT INTO mox_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]); 
    await client.query("COMMIT"); 
    console.log(`apply ${file}`); 
  } catch (error) { 
    await client.query("ROLLBACK"); 
    throw error; 
  } 
} 
await client.end(); 
