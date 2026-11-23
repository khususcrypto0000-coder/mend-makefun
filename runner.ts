// The trial runner: when main.ts runs with MAKEFUN_ENV_URL set, this file
// reads the trial's checks from the env, runs main.ts on each one in a fresh
// directory, and posts the results back. Node 22, standard library only.
//
//   GET  $MAKEFUN_ENV_URL/checks    {"checks": [{"id", "argv", "stdin", "files"}]}
//   POST $MAKEFUN_ENV_URL/results   {"results": [{"id", "exit", "stdout", "files"}]}

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One check: the CLI's arguments, its standard input and the files it starts with. */
export interface Check {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
}

/** What the CLI did on one check. */
export interface Result {
  id: string;
  exit: number;
  stdout: string;
  files: Record<string, string>;
}

/** The CLI this repository builds, beside this file. */
export const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

/** A run longer than this is stopped and reported as exit 124. */
export const TIMEOUT_MS = 10_000;
/** The env takes at most this much stdout and this many files a result. */
export const MAX_STDOUT_BYTES = 64 * 1024;
export const MAX_FILES = 64;
/** Results posted at a time, and how often a request that failed on the network is sent again. */
export const BATCH = 10;
export const RETRIES = 4;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** fetch, sent again after a network error (never after an answer, whatever its status). */
async function send(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      await sleep(250 * (attempt + 1));
    }
  }
}

/** Every regular file under `dir`, as paths relative to it with `/` separators. */
function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && Object.keys(out).length < MAX_FILES) {
        out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

/** Run main.ts (or `program`) on one check, in a fresh directory holding exactly its files. */
export function runCheck(c: Check, program = MAIN): Result {
  const dir = mkdtempSync(join(tmpdir(), 'mend-'));
  try {
    for (const [p, text] of Object.entries(c.files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const env = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const r = spawnSync(process.execPath, [program, ...c.argv], {
      cwd: dir,
      env,
      input: c.stdin ?? '',
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * MAX_STDOUT_BYTES,
    });
    const exit = r.error !== undefined || r.status === null ? 124 : r.status;
    let stdout = r.stdout ?? '';
    while (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
      stdout = stdout.slice(0, Math.floor(stdout.length / 2));
    }
    return { id: c.id, exit, stdout, files: readTree(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A trial: every check of the env at `envUrl` run and its result posted. */
export async function runTrial(envUrl: string): Promise<void> {
  const base = envUrl.replace(/\/+$/, '');
  const post = async (results: Result[]): Promise<void> => {
    const res = await send(`${base}/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ results }),
    });
    // Every answer's body is read, so no connection is left holding the process open once the trial is done.
    const body = await res.text();
    if (!res.ok && res.status !== 409) throw new Error(`POST /results answered ${res.status}: ${body}`);
  };
  const res = await send(`${base}/checks`);
  if (!res.ok) throw new Error(`GET /checks answered ${res.status}`);
  const { checks } = (await res.json()) as { checks: Check[] };
  let batch: Result[] = [];
  for (const c of checks) {
    batch.push(runCheck(c));
    if (batch.length === BATCH) {
      await post(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await post(batch);
  process.stdout.write(`posted ${checks.length} results\n`);
}
