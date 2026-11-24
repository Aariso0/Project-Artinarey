import { useEffect, useState } from 'react';
import type {
  GuiMail, GuiPersona, GuiProject, GuiWorktree,
} from '../../../packages/daemon/src/gui.ts';
import { type DaemonError, type GuiApi } from './api.ts';
import {
  ErrorPanel, Logo, MailView, PersonaView, ProjectView, WorktreeView,
} from './components.tsx';

export type Snapshots = {
  projects: GuiProject[];
  personas: GuiPersona[];
  worktrees: GuiWorktree[];
  mail: GuiMail[];
};

export type AppProps = {
  api: GuiApi;
  initial?: Snapshots;
  initialError?: DaemonError | null;
};

function typedError(value: unknown): DaemonError {
  if (value && typeof value === 'object' && 'code' in value && 'message' in value) {
    const error = value as { code: unknown; message: unknown };
    if (typeof error.code === 'string' && typeof error.message === 'string') {
      return { code: error.code, message: error.message };
    }
  }
  return { code: 'INTERNAL_ERROR', message: value instanceof Error ? value.message : 'request failed' };
}

export function App({ api, initial, initialError }: AppProps) {
  const [snapshots, setSnapshots] = useState<Snapshots | undefined>(initial);
  const [error, setError] = useState<DaemonError | null>(initialError ?? null);
  const [loading, setLoading] = useState(!initial && !initialError);
  const scopeName = snapshots?.projects[0]?.name;
  const scope = snapshots ? (scopeName ? `Scoped to ${scopeName}` : 'No project selected') : undefined;

  useEffect(() => {
    if (initial || initialError) return;
    let active = true;
    void (async () => {
      try {
        const projects = await api.projects();
        const projectId = projects[0]?.id;
        const [personas, worktrees, mail] = projectId
          ? await Promise.all([
            api.personas(projectId),
            api.worktrees(projectId),
            api.mail({ projectId }),
          ])
          : [[], [], []] as [GuiPersona[], GuiWorktree[], GuiMail[]];
        if (active) setSnapshots({ projects, personas, worktrees, mail });
      } catch (err) {
        if (active) setError(typedError(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api, initial, initialError]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <div>
            <p className="brand-name">Artinarey</p>
            <p className="brand-note">Read-only window</p>
          </div>
        </div>
        <nav aria-label="Views">
          <a href="#projects">Projects</a>
          <a href="#personas">Personas</a>
          <a href="#worktrees">Worktrees</a>
          <a href="#mail">Mail</a>
        </nav>
        <p className="sidebar-note">Snapshots only. No actions are available.</p>
      </aside>
      <main className="content">
        <header className="page-header">
          <h1>Current state</h1>
          <p>Projects, agents, worktrees and mail metadata as reported by the daemon.</p>
        </header>
        {error && <ErrorPanel error={error} />}
        {loading && <p className="loading" role="status">Loading snapshot…</p>}
        {snapshots && (
          <div className="views">
            <ProjectView rows={snapshots.projects} />
            <PersonaView rows={snapshots.personas} scope={scope} />
            <WorktreeView rows={snapshots.worktrees} scope={scope} />
            <MailView rows={snapshots.mail} scope={scope} />
          </div>
        )}
      </main>
    </div>
  );
}
