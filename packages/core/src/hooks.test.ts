import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtinareyError } from './errors.ts';
import { branchChangedFiles, changedFiles } from './hooks.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'artinarey-hooks-'));
  git(repo, ['init', '-q', '-b', 'main']);
  return repo;
}

function addFile(repo: string, path: string, body = 'fixture\n'): void {
  const full = join(repo, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  git(repo, ['add', path]);
}

function commit(repo: string, message: string): void {
  git(repo, ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '-q', '-m', message]);
}

test('branchChangedFiles verifies a distinct merge target', () => {
  const repo = tempRepo();
  addFile(repo, 'base.txt');
  commit(repo, 'base');
  git(repo, ['checkout', '-q', '-b', 'feature']);
  addFile(repo, 'src/in.ts', 'feature only\n');
  commit(repo, 'feature edit');
  git(repo, ['checkout', '-q', 'main']);
  addFile(repo, 'main-only.txt', 'main only\n');
  commit(repo, 'main edit');
  git(repo, ['checkout', '-q', 'feature']);

  assert.deepEqual(branchChangedFiles(repo, 'main'), ['main-only.txt']);
  git(repo, ['checkout', '-q', 'main']);
  assert.deepEqual(branchChangedFiles(repo, 'feature'), ['src/in.ts']);
});

test('branchChangedFiles rejects the checked-out branch as a merge target', () => {
  const repo = tempRepo();
  addFile(repo, 'base.txt');
  commit(repo, 'base');
  git(repo, ['checkout', '-q', '-b', 'feature']);
  addFile(repo, 'src/in.ts');
  commit(repo, 'feature edit');

  for (const branch of ['feature', 'refs/heads/feature', 'HEAD']) {
    assert.throws(() => branchChangedFiles(repo, branch), (err: unknown) =>
      err instanceof ArtinareyError && err.code === 'INVALID_INPUT'
      && err.message.includes('verify needs a distinct merge target')
      && err.message.includes('is checked out'), branch);
  }
});

test('changedFiles parses name-status fields, including rename paths and exact names', () => {
  const repo = tempRepo();
  addFile(repo, 'src/keep.ts', 'keep\n');
  addFile(repo, 'src/delete.ts', 'delete\n');
  addFile(repo, 'src/rename.ts', 'rename\n');
  addFile(repo, 'src/copy.ts', 'copy source\n');
  addFile(repo, 'src/type-change', 'type\n');
  addFile(repo, 'src/ ü n i .ts ', 'unicode\n');
  commit(repo, 'fixture');

  writeFileSync(join(repo, 'src/keep.ts'), 'changed\n');
  rmSync(join(repo, 'src/delete.ts'));
  git(repo, ['mv', 'src/rename.ts', 'src/renamed.ts']);
  copyFileSync(join(repo, 'src/copy.ts'), join(repo, 'src/copied.ts'));
  rmSync(join(repo, 'src/type-change'));
  symlinkSync('keep.ts', join(repo, 'src/type-change'));
  git(repo, ['mv', 'src/ ü n i .ts ', 'src/ ü n i renamed .ts ']);
  git(repo, ['add', '-A']);

  const paths = changedFiles(repo, true);
  for (const path of [
    'src/keep.ts', 'src/delete.ts',
    'src/rename.ts', 'src/renamed.ts',
    'src/copied.ts',
    'src/type-change',
    'src/ ü n i .ts ', 'src/ ü n i renamed .ts ',
  ]) {
    assert.ok(paths.includes(path), `missing ${JSON.stringify(path)} in ${JSON.stringify(paths)}`);
  }
  assert.ok(!paths.includes('src/copy.ts'), `unexpected copy source in ${JSON.stringify(paths)}`);
});

test('changedFiles reports only the destination for a copy with an unchanged source', () => {
  const repo = tempRepo();
  addFile(repo, 'templates/base.ts');
  commit(repo, 'fixture');
  mkdirSync(join(repo, 'src'), { recursive: true });
  copyFileSync(join(repo, 'templates/base.ts'), join(repo, 'src/new.ts'));
  git(repo, ['add', '-A']);

  assert.deepEqual(changedFiles(repo, true), ['src/new.ts']);
});

test('changedFiles still reports a modified copy source as its own change', () => {
  const repo = tempRepo();
  const body = 'shared content line\n'.repeat(12);
  addFile(repo, 'templates/base.ts', body);
  commit(repo, 'fixture');
  mkdirSync(join(repo, 'src'), { recursive: true });
  copyFileSync(join(repo, 'templates/base.ts'), join(repo, 'src/new.ts'));
  writeFileSync(join(repo, 'templates/base.ts'), `${body}extra line\n`);
  git(repo, ['add', '-A']);

  assert.deepEqual(changedFiles(repo, true), ['src/new.ts', 'templates/base.ts']);
});

test('changedFiles reports both paths for a rename', () => {
  const repo = tempRepo();
  addFile(repo, 'src/old.ts');
  commit(repo, 'fixture');
  git(repo, ['mv', 'src/old.ts', 'src/new.ts']);
  git(repo, ['add', '-A']);

  assert.deepEqual(changedFiles(repo, true), ['src/old.ts', 'src/new.ts']);
});

test('changedFiles returns working-tree changes against HEAD', () => {
  const repo = tempRepo();
  addFile(repo, 'base.txt');
  commit(repo, 'base');
  writeFileSync(join(repo, 'base.txt'), 'changed\n');
  assert.deepEqual(changedFiles(repo, false), ['base.txt']);
});
