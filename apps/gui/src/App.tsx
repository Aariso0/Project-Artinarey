import { useEffect, useState } from 'react';
import type {
  GuiMail, GuiPersona, GuiProject, GuiWorktree,
} from '../../../packages/daemon/src/gui.ts';
import { type DaemonError, type GuiApi, type MailQuery } from './api.ts';
import {
  ErrorPanel, Logo, MailView, PersonaView, ProjectView, ReadOnlySelect, WorktreeView,
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

const ALL_RECIPIENTS = 'all';

function typedError(value: unknown): DaemonError {
  if (value && typeof value === 'object' && 'code' in value && 'message' in value) {
    const error = value as { code: unknown; message: unknown };
    if (typeof error.code === 'string' && typeof error.message === 'string') {
      return { code: error.code, message: error.message };
    }
  }
  return { code: 'INTERNAL_ERROR', message: value instanceof Error ? value.message : 'request failed' };
}

/** 'all' leaves the recipient filter out of the query entirely. */
export function scopedMailQuery(projectId: string, recipient: string): MailQuery {
  return recipient === ALL_RECIPIENTS ? { projectId } : { projectId, recipient };
}

/** The only data that changes when the user selects a project or mail recipient. */
export async function loadScopedSnapshots(
  api: GuiApi,
  projectId: string,
  recipient: string,
): Promise<Pick<Snapshots, 'personas' | 'worktrees' | 'mail'>> {
  const [personas, worktrees, mail] = await Promise.all([
    api.personas(projectId),
    api.worktrees(projectId),
    api.mail(scopedMailQuery(projectId, recipient)),
  ]);
  return { personas, worktrees, mail };
}

/** One option per persona role, with the unfiltered 'all' option first. */
export function mailRecipientOptions(personas: GuiPersona[]): string[] {
  return [ALL_RECIPIENTS, ...new Set(personas.map((persona) => persona.role).filter(Boolean))];
}

export function App({ api, initial, initialError }: AppProps) {
  const [snapshots, setSnapshots] = useState<Snapshots | undefined>(initial);
  const [selectedProjectId, setSelectedProjectId] = useState(initial?.projects[0]?.id ?? '');
  const [recipient, setRecipient] = useState(ALL_RECIPIENTS);
  const [scopeRequest, setScopeRequest] = useState<{
    projectId: string;
    recipient: string;
  } | null>(null);
  const [error, setError] = useState<DaemonError | null>(initialError ?? null);
  const [loading, setLoading] = useState(!initial && !initialError);
  const [scopeLoading, setScopeLoading] = useState(false);

  const selectedProject = snapshots?.projects.find((project) => project.id === selectedProjectId)
    ?? snapshots?.projects[0];
  const scopeName = selectedProject?.name;
  const scope = snapshots ? (scopeName ? `Scoped to ${scopeName}` : 'No project selected') : undefined;

  useEffect(() => {
    if (initial || initialError) return;
    let active = true;
    void (async () => {
      try {
        const projects = await api.projects();
        const projectId = projects[0]?.id ?? '';
        const scoped = projectId
          ? await loadScopedSnapshots(api, projectId, ALL_RECIPIENTS)
          : { personas: [], worktrees: [], mail: [] } as Pick<
            Snapshots, 'personas' | 'worktrees' | 'mail'
          >;
        if (active) {
          setSelectedProjectId(projectId);
          setSnapshots({ projects, ...scoped });
        }
      } catch (err) {
        if (active) setError(typedError(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api, initial, initialError]);

  useEffect(() => {
    if (!scopeRequest) return;
    let active = true;
    setScopeLoading(true);
    void (async () => {
      try {
        const scoped = await loadScopedSnapshots(
          api, scopeRequest.projectId, scopeRequest.recipient,
        );
        if (!active) return;
        setError(null);
        setSnapshots((current) => current && { ...current, ...scoped });
      } catch (err) {
        if (active) setError(typedError(err));
      } finally {
        if (active) setScopeLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api, scopeRequest]);

  function chooseProject(projectId: string) {
    setSelectedProjectId(projectId);
    setRecipient(ALL_RECIPIENTS);
    setScopeRequest({ projectId, recipient: ALL_RECIPIENTS });
  }

  function chooseRecipient(value: string) {
    setRecipient(value);
    if (selectedProjectId) setScopeRequest({ projectId: selectedProjectId, recipient: value });
  }

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
            <div className="selectors">
              <ReadOnlySelect
                id="project-select"
                label="Project"
                value={selectedProjectId}
                options={snapshots.projects.map((project) => ({
                  value: project.id, label: project.name,
                }))}
                onChange={chooseProject}
              />
              <ReadOnlySelect
                id="recipient-select"
                label="Mail recipient"
                value={recipient}
                options={mailRecipientOptions(snapshots.personas).map((value) => ({
                  value, label: value === ALL_RECIPIENTS ? 'All recipients' : value,
                }))}
                onChange={chooseRecipient}
              />
              {scopeLoading && <p className="loading" role="status">Reloading snapshot…</p>}
            </div>
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
