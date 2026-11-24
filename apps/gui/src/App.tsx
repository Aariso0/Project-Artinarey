import { useEffect, useReducer, useState } from 'react';
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

export type Scope = { projectId: string; recipient: string };

export type ScopeState = {
  /** Scope of the snapshot currently on screen; only a completed load may change it. */
  loaded: Scope;
  /** Scope being requested; never used to label the displayed rows. */
  request: Scope | null;
};

export type ScopeAction =
  | { type: 'chooseProject'; projectId: string }
  | { type: 'chooseRecipient'; recipient: string }
  | { type: 'loadSucceeded'; scope: Scope }
  | { type: 'requestFailed' };

const ALL_RECIPIENTS = 'all';

export function initialScopeState(projectId: string): ScopeState {
  return { loaded: { projectId, recipient: ALL_RECIPIENTS }, request: null };
}

/** A pending or failed selection leaves the displayed scope on the last loaded snapshot. */
export function scopeReducer(state: ScopeState, action: ScopeAction): ScopeState {
  switch (action.type) {
    case 'chooseProject':
      return { ...state, request: { projectId: action.projectId, recipient: ALL_RECIPIENTS } };
    case 'chooseRecipient':
      if (!state.loaded.projectId) return state;
      return { ...state, request: { projectId: state.loaded.projectId, recipient: action.recipient } };
    case 'loadSucceeded':
      return { loaded: action.scope, request: null };
    case 'requestFailed':
      return { ...state, request: null };
  }
}

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

type AppViewProps = {
  snapshots?: Snapshots;
  loadedScope: Scope;
  error: DaemonError | null;
  loading: boolean;
  scopeLoading: boolean;
  onChooseProject: (projectId: string) => void;
  onChooseRecipient: (recipient: string) => void;
};

export function AppView({
  snapshots, loadedScope, error, loading, scopeLoading, onChooseProject, onChooseRecipient,
}: AppViewProps) {
  const selectedProject = snapshots?.projects.find((project) => project.id === loadedScope.projectId)
    ?? snapshots?.projects[0];
  const scopeName = selectedProject?.name;
  const scope = snapshots ? (scopeName ? `Scoped to ${scopeName}` : 'No project selected') : undefined;

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
                value={loadedScope.projectId}
                options={snapshots.projects.map((project) => ({
                  value: project.id, label: project.name,
                }))}
                onChange={onChooseProject}
              />
              <ReadOnlySelect
                id="recipient-select"
                label="Mail recipient"
                value={loadedScope.recipient}
                options={mailRecipientOptions(snapshots.personas).map((value) => ({
                  value, label: value === ALL_RECIPIENTS ? 'All recipients' : value,
                }))}
                onChange={onChooseRecipient}
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

export function App({ api, initial, initialError }: AppProps) {
  const [snapshots, setSnapshots] = useState<Snapshots | undefined>(initial);
  const [scopeState, dispatchScope] = useReducer(
    scopeReducer,
    initial?.projects[0]?.id ?? '',
    initialScopeState,
  );
  const [error, setError] = useState<DaemonError | null>(initialError ?? null);
  const [loading, setLoading] = useState(!initial && !initialError);
  const [scopeLoading, setScopeLoading] = useState(false);

  const scopeRequest = scopeState.request;

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
          dispatchScope({
            type: 'loadSucceeded',
            scope: { projectId, recipient: ALL_RECIPIENTS },
          });
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
        dispatchScope({ type: 'loadSucceeded', scope: scopeRequest });
      } catch (err) {
        if (active) {
          setError(typedError(err));
          dispatchScope({ type: 'requestFailed' });
        }
      } finally {
        if (active) setScopeLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api, scopeRequest]);

  return (
    <AppView
      snapshots={snapshots}
      loadedScope={scopeState.loaded}
      error={error}
      loading={loading}
      scopeLoading={scopeLoading}
      onChooseProject={(projectId) => dispatchScope({ type: 'chooseProject', projectId })}
      onChooseRecipient={(recipient) => dispatchScope({ type: 'chooseRecipient', recipient })}
    />
  );
}
