import { execFileSync } from 'node:child_process';

export type GitWorktree = {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  bare: boolean;
};

/** Parses the block-oriented output of `git worktree list --porcelain`. */
export function parseWorktreePorcelain(text: string): GitWorktree[] {
  return text
    .split(/\n\s*\n/)
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const worktree: GitWorktree = {
        path: '',
        head: '',
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
        bare: false,
      };

      for (const line of block.split('\n')) {
        const space = line.indexOf(' ');
        const key = space === -1 ? line : line.slice(0, space);
        const value = space === -1 ? '' : line.slice(space + 1);
        switch (key) {
          case 'worktree':
            worktree.path = value;
            break;
          case 'HEAD':
            worktree.head = value;
            break;
          case 'branch':
            worktree.branch = value.replace(/^refs\/heads\//, '');
            break;
          case 'detached':
            worktree.detached = true;
            break;
          case 'locked':
            worktree.locked = true;
            break;
          case 'prunable':
            worktree.prunable = true;
            break;
          case 'bare':
            worktree.bare = true;
            break;
        }
      }
      return worktree;
    });
}

export function listGitWorktrees(repoDir: string): GitWorktree[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  return parseWorktreePorcelain(output);
}
