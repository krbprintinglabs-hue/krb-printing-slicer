/* List 3MF uploads in the Supabase bucket (names only — no secrets printed). */
import { readFileSync } from "node:fs";
const envPath = String.raw`D:\open code projects\KRB Printing Site\.env.local`;
const env = {};
for (const l of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/list/custom-prints`, {
  method: "POST",
  headers: {
    apikey: env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ prefix: "", limit: 1000 }),
});
const rows = await res.json();
if (!Array.isArray(rows)) { console.log("list failed:", JSON.stringify(rows).slice(0, 200)); process.exit(1); }
console.log("objects:", rows.length);
for (const o of rows) {
  if (/\.3mf$/i.test(o.name)) console.log(`${o.name}  (${o.metadata?.size ?? "?"} bytes, ${o.created_at})`);
}

