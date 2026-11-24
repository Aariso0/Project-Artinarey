import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export type IndexedMail = {
  id: string;
  thread: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  kind: string;
  createdAt: string;
  file: string;
};

export type IndexReport = { indexed: number; skipped: number };

export type QueryOptions = {
  recipient?: string;
  thread?: string;
  limit?: number;
};

type Frontmatter = Record<string, string | string[]>;

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  return value;
}

function parseFrontmatter(text: string): Frontmatter | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return undefined;
  const end = lines.indexOf('---', 1);
  if (end === -1) return undefined;

  const out: Frontmatter = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z_][a-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) return undefined;
    const [, key, raw] = match;
    out[key!] = raw!.startsWith('[') && raw!.endsWith(']')
      ? raw!.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean)
      : unquote(raw!);
  }
  return out;
}

function mailFiles(storeDir: string): string[] {
  const root = join(storeDir, 'mail');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .filter((entry) => String(entry).endsWith('.md'))
    .map((entry) => join(root, String(entry)));
}

function isScalar(value: string | string[] | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Rebuild the derived index from the mail files. The files always win. */
export function buildIndex(indexFile: string, storeDir: string): IndexReport {
  mkdirSync(dirname(indexFile), { recursive: true });
  const db = new Database(indexFile);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS mail (
      id TEXT PRIMARY KEY,
      thread TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_json TEXT NOT NULL,
      cc_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      file TEXT NOT NULL
    )`);
    const columns = db.pragma('table_info(mail)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'cc_json')) {
      db.exec("ALTER TABLE mail ADD COLUMN cc_json TEXT NOT NULL DEFAULT '[]'");
    }

    // The delete and every insert stand or fall together: a failed read must not
    // leave the index empty or half rebuilt.
    const rebuild = db.transaction((): IndexReport => {
      db.prepare('DELETE FROM mail').run();
      const insert = db.prepare(`INSERT INTO mail (id, thread, from_id, to_json, cc_json, subject, kind, created_at, file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, file = excluded.file,
          cc_json = excluded.cc_json`);

      let indexed = 0;
      let skipped = 0;
      for (const file of mailFiles(storeDir)) {
        const frontmatter = parseFrontmatter(readFileSync(file, 'utf8'));
        const to = frontmatter?.to;
        if (!frontmatter || !isScalar(frontmatter.id) || !isScalar(frontmatter.thread) ||
            !isScalar(frontmatter.from) || !isScalar(frontmatter.subject) ||
            !isScalar(frontmatter.kind) || !isScalar(frontmatter.created_at) ||
            !Array.isArray(to)) {
          skipped++;
          continue;
        }
        const cc = Array.isArray(frontmatter.cc) ? frontmatter.cc : [];
        insert.run(frontmatter.id, frontmatter.thread, frontmatter.from,
          JSON.stringify(to), JSON.stringify(cc), frontmatter.subject, frontmatter.kind,
          frontmatter.created_at, file);
        indexed++;
      }
      return { indexed, skipped };
    });
    return rebuild();
  } finally {
    db.close();
  }
}

type MailRow = {
  id: string; thread: string; from_id: string; to_json: string; cc_json?: string | null;
  subject: string; kind: string; created_at: string; file: string;
};

/** Read-only queries against the derived index. */
export function queryMail(indexFile: string, opts: QueryOptions = {}): IndexedMail[] {
  if (!existsSync(indexFile)) return [];
  const db = new Database(indexFile, { readonly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mail'").get();
    if (!exists) return [];
    const rows = db.prepare('SELECT * FROM mail ORDER BY id').all() as MailRow[];
    let result: IndexedMail[] = rows.map((r) => ({
      id: r.id, thread: r.thread, from: r.from_id,
      to: JSON.parse(r.to_json) as string[],
      cc: r.cc_json ? JSON.parse(r.cc_json) as string[] : [],
      subject: r.subject, kind: r.kind, createdAt: r.created_at, file: r.file,
    }));
    if (opts.recipient) {
      result = result.filter((m) => m.to.includes(opts.recipient!) || m.cc.includes(opts.recipient!));
    }
    if (opts.thread) result = result.filter((m) => m.thread === opts.thread);
    if (opts.limit !== undefined) result = result.slice(0, opts.limit);
    return result;
  } finally {
    db.close();
  }
}
