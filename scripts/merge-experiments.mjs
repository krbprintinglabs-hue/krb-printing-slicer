/* Round 2: isolate Bambu CLI merge semantics. */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";

const EXE = "C:\\Program Files\\Bambu Studio\\bambu-studio.exe";
const run = promisify(execFile);
const WALLETV6 = "C:/Users/Baha Eddine/Downloads/WalletV6.3mf";
const CHIBI = "test-fixtures/chibi-roger-federer-elegant-backhand-tennis.3mf";

function cfg(name, wd) {
  const p = path.join(wd, name);
  fs.writeFileSync(p, fs.readFileSync(path.join("profiles", "bambu", name), "utf8"));
  return p;
}

function readGcodeConfig(out3mf, probes) {
  const buf = fs.readFileSync(out3mf);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const found = {};
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(ptr + 10);
    const csize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    if (/plate_\d+\.gcode$/i.test(name)) {
      const lho = buf.readUInt32LE(ptr + 42);
      const lnLen = buf.readUInt16LE(lho + 26);
      const leLen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnLen + leLen;
      const raw = buf.subarray(start, start + csize);
      const text = (method === 0 ? Buffer.from(raw) : inflateRawSync(raw)).toString("latin1");
      found.gcodeEntry = name;
      for (const k of probes) {
        const m = text.match(new RegExp(`^;\\s*${k}\\s*=\\s*(.+)$`, "mi"));
        if (m && !found[k]) found[k] = m[1].trim().slice(0, 48);
      }
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return found;
}

async function attempt(label, file, argsBuild, wd, probes) {
  fs.mkdirSync(wd, { recursive: true });
  const out3mf = path.join(wd, "out.gcode.3mf");
  const args = argsBuild(wd, out3mf);
  process.stdout.write(`${label}: `);
  try {
    const t0 = Date.now();
    await run(EXE, args, { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
    console.log(`ok ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log("   ", JSON.stringify(readGcodeConfig(out3mf, probes)));
  } catch (e) {
    console.log(`FAIL killed=${e.killed} code=${e.code} ${String(e.stderr ?? "").slice(-160).replace(/\n/g, " | ")}`);
  }
}

const PROBES = ["layer_height", "sparse_infill_density", "enable_support", "filament_type", "printer_model", "nozzle_temperature"];

// E1: pure embedded — no settings/filament flags at all
await attempt("E1 wallet pure-embedded", WALLETV6,
  (wd, out) => ["--slice", "0", "--export-3mf", out, WALLETV6],
  "combo-out/merge2/e1", PROBES);

// E2: wallet + machine only
await attempt("E2 wallet machine-only", WALLETV6,
  (wd, out) => ["--slice", "0", "--load-settings", cfg("krb-a1-machine.json", wd), "--export-3mf", out, WALLETV6],
  "combo-out/merge2/e2", PROBES);

// E3: wallet + machine + filaments (no process)
await attempt("E3 wallet machine+filaments", WALLETV6,
  (wd, out) => ["--slice", "0", "--load-settings", cfg("krb-a1-machine.json", wd), "--load-filaments", cfg("krb-a1-filament.json", wd), "--export-3mf", out, WALLETV6],
  "combo-out/merge2/e3", PROBES);

// E4: chibi + machine + partial-process override(lh .12) + filaments
{
  const wd = "combo-out/merge2/e4";
  fs.mkdirSync(wd, { recursive: true });
  const ov = path.join(wd, "override.json");
  fs.writeFileSync(ov, JSON.stringify({ layer_height: "0.12", from: "user", type: "process", name: "KRB ov" }));
  await attempt("E4 chibi machine+ov(0.12)+fil", CHIBI,
    (w, out) => ["--slice", "0", "--load-settings", `${cfg("krb-a1-machine.json", w)};${ov}`, "--load-filaments", cfg("krb-a1-filament.json", w), "--export-3mf", out, CHIBI],
    wd, PROBES);
}

// E5: pin + machine + filaments (does explicit PLA replace embedded PETG?)
await attempt("E5 pin machine+fil(PLA)", "C:/Users/Baha Eddine/Desktop/Door lock pin.3mf",
  (wd, out) => ["--slice", "0", "--load-settings", cfg("krb-a1-machine.json", wd), "--load-filaments", cfg("krb-a1-filament.json", wd), "--export-3mf", out, "C:/Users/Baha Eddine/Desktop/Door lock pin.3mf"],
  "combo-out/merge2/e5", PROBES);
