/**
 * Demo tools: local document read/write/delete.
 * Money never moves through this file — spends go through the guard, which
 * calls near.attemptSpend after its policy/intent/money checks.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo');

export function docPath(name) {
  return join(DOCS_DIR, `${name}.md`);
}

export function readDoc(name) {
  const path = docPath(name);
  if (!existsSync(path)) throw new Error(`Doc ${name} not found`);
  return readFileSync(path, 'utf8');
}

export function writeDoc(name, text) {
  const path = docPath(name);
  writeFileSync(path, text);
  return `Wrote ${name}.md`;
}

export function deleteDoc(name) {
  const path = docPath(name);
  if (!existsSync(path)) throw new Error(`Doc ${name} not found`);
  rmSync(path);
  return `Deleted ${name}.md`;
}
