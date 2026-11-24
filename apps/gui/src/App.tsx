import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, ChatCircle, Gear, SquaresFour } from '@phosphor-icons/react';
import type {
  GuiApproval, GuiAudit, GuiChatReply, GuiLease, GuiMail, GuiMoveStatus, GuiPersona,
  GuiPreMerge, GuiProject, GuiSession, GuiStorage, GuiTask, GuiWorktree,
} from './api.ts';
import { type DaemonError, type GuiApi, type MailQuery } from './api.ts';
import {
  AdoptDialog, ApprovalsView, AuditView, BlockerModal, ChatView, Logo, NewWorktreeDialog,
  PersonaView, PreMergeView, ProjectView, SessionsView, StorageView, TasksView, WorktreeView,
} from './components.tsx';
import { Button, ErrorBanner, Select, Skeleton, TabBar, type TabItem } from './ui.tsx';
import { useMotionTransition } from './motion.ts';

export type Snapshots = {
  projects: GuiProject[];
  personas: GuiPersona[];
  worktrees: GuiWorktree[];
  mail: GuiMail[];
  tasks: GuiTask[];
  leases: GuiLease[];
  sessions: GuiSession[];
  preMerge: GuiPreMerge[];
  audit: GuiAudit[];
  approvals: GuiApproval[];
  storage: GuiStorage | null;
};

export type AppProps = {
  api: GuiApi;
  initial?: Partial<Snapshots>;
  initialError?: DaemonError | null;
};

export type Scope = { projectId: string; recipient: string };
export type ScopeState = { loaded: Scope; request: Scope | null };
export type ScopeAction =
  | { type: 'chooseProject'; projectId: string }
  | { type: 'chooseRecipient'; recipient: string }
  | { type: 'loadSucceeded'; scope: Scope }
  | { type: 'requestFailed' };

const ALL_RECIPIENTS = 'all';
const EMPTY: Snapshots = {
  projects: [], personas: [], worktrees: [], mail: [], tasks: [], leases: [],
  sessions: [], preMerge: [], audit: [], approvals: [], storage: null,
};

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

export function typedError(value: unknown): DaemonError {
  if (value && typeof value === 'object' && 'code' in value && 'message' in value) {
    const error = value as { code: unknown; message: unknown };
    if (typeof error.code === 'string' && typeof error.message === 'string') return error as DaemonError;
  }
  return {
    code: 'INTERNAL_ERROR',
    message: value instanceof Error ? value.message : String(value),
  };
}

export function scopedMailQuery(projectId: string, recipient: string): MailQuery {
  return recipient === ALL_RECIPIENTS ? { projectId } : { projectId, recipient };
}

export function mailRecipientOptions(personas: GuiPersona[]): string[] {
  return [ALL_RECIPIENTS, ...new Set(personas.map((persona) => persona.role).filter(Boolean))];
}

/** Loads a full snapshot without writing it: callers decide whether it is still current. */
export async function loadSnapshots(api: GuiApi, projectId: string, recipient: string): Promise<Snapshots> {
  if (!projectId) {
    const [projects, storage] = await Promise.all([api.projects(), api.storage()]);
    return { ...EMPTY, projects, storage };
  }
  const [projects, personas, worktrees, mail, tasks, leases, sessions, preMerge, audit, approvals, storage] =
    await Promise.all([
      api.projects(), api.personas(projectId), api.worktrees(projectId),
      api.mail(scopedMailQuery(projectId, recipient)), api.tasks(projectId),
      api.leases(projectId), api.sessions(projectId), api.preMerge(projectId),
      api.audit(projectId), api.approvals(projectId), api.storage(),
    ]);
  return {
    projects, personas, worktrees, mail, tasks, leases, sessions, preMerge,
    audit, approvals, storage,
  };
}

type LiveScope = { scope: Scope; version: number };

/** Only the newest scope load may publish snapshots; refresh never claims this guard. */
export function createScopeGuard() {
  let seq = 0;
  let mutationVersion = 0;
  return {
    next: () => ++seq,
    isCurrent: (claimed: number) => claimed === seq,
    snapshotsChanged: () => { mutationVersion++; },
    async loadRequested(
      claimed: number,
      isActive: () => boolean,
      load: () => Promise<Snapshots>,
      publish: (next: Snapshots) => void,
    ) {
      while (isActive() && claimed === seq) {
        const version = mutationVersion;
        const next = await load();
        if (!isActive() || claimed !== seq) return;
        // A successful action can invalidate any collection in the snapshot.
        if (version !== mutationVersion) continue;
        publish(next);
        return;
      }
    },
  };
}

/**
 * Refresh reads the live loaded scope and drops replies whose scope changed while
 * the request was in flight, so a late action cannot overwrite a newer scope.
 */
export function refreshLoadedScope(
  loadAll: (projectId: string, recipient: string) => Promise<Snapshots>,
  liveScope: { current: LiveScope },
  setSnapshots: (next: Snapshots) => void,
  setError: (error: DaemonError) => void,
): () => void {
  let seq = 0;
  return () => {
    const started = liveScope.current;
    const claimed = ++seq;
    void loadAll(started.scope.projectId, started.scope.recipient).then((next) => {
      if (claimed !== seq || liveScope.current.version !== started.version) return;
      setSnapshots(next);
    }).catch((err) => {
      if (claimed === seq && liveScope.current.version === started.version) setError(typedError(err));
    });
  };
}

type Section = 'workspace' | 'chat' | 'approvals' | 'storage';
type TabValue = 'tasks' | 'sessions' | 'premerge' | 'audit';

type Blocker = { project: string; worktree: string; persona: string; action: string };

function parseBlocker(error: DaemonError): Blocker | null {
  if (error.code !== 'WORKTREE_BLOCKED') return null;
  const [project = '', worktree = '', persona = '', ...rest] = error.message.split('|');
  return { project, worktree, persona, action: rest.join('|') || 'continue' };
}

export function AppView({
  api, snapshots, loadedScope, error, loading, scopeLoading, section, onSection,
  onChooseProject, onChooseRecipient, onRefresh, onActionError,
}: {
  api: GuiApi;
  snapshots: Snapshots;
  loadedScope: Scope;
  error: DaemonError | null;
  loading: boolean;
  scopeLoading: boolean;
  section: Section;
  onSection: (section: Section) => void;
  onChooseProject: (projectId: string) => void;
  onChooseRecipient: (recipient: string) => void;
  onRefresh: () => void;
  onActionError: (error: DaemonError) => void;
}) {
  const transition = useMotionTransition('spring');
  const [tab, setTab] = useState<TabValue>('tasks');
  const [replies, setReplies] = useState<GuiChatReply[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');
  const [newWorktree, setNewWorktree] = useState(false);
  const [adopt, setAdopt] = useState(false);
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  const [move, setMove] = useState<GuiMoveStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedProject = snapshots.projects.find((p) => p.id === loadedScope.projectId)
    ?? snapshots.projects[0];
  const projectId = selectedProject?.id ?? '';
  const pending = approvalsPending(snapshots.approvals);
  const visibleMove = move && move.projectId === projectId ? move : null;

  useEffect(() => {
    setMove(null);
    setTarget('');
    setReplies([]);
  }, [projectId]);

  useEffect(() => {
    if (section !== 'storage' || !projectId) return;
    let active = true;
    void api.moveStatus(projectId).then((status) => {
      if (!active) return;
      setMove((current) => current && current.projectId === projectId ? current : status);
    }).catch((err) => {
      if (active) onActionError(typedError(err));
    });
    return () => { active = false; };
  }, [api, section, projectId, onActionError]);

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try {
      await action();
      if (success) setNotice(success);
      onRefresh();
    } catch (err) {
      const typed = typedError(err);
      const found = parseBlocker(typed);
      if (found) setBlocker(found);
      else onActionError(typed);
    } finally {
      setBusy(false);
    }
  }

  const tabs: TabItem[] = [
    {
      value: 'tasks', label: 'Tasks & leases',
      content: <TasksView
        tasks={snapshots.tasks}
        leases={snapshots.leases}
        worktrees={snapshots.worktrees}
        autoApprove={Object.fromEntries(snapshots.worktrees.map((w) => [w.id, w.autoApprove]))}
        busy={busy}
        onAutoApprove={(worktreeId, enabled) => void run(
          () => api.autoApprove(worktreeId, enabled),
          `Auto-approve ${enabled ? 'enabled' : 'disabled'}.`,
        )}
      />,
    },
    {
      value: 'sessions', label: 'Sessions', badge: snapshots.sessions.filter((s) => s.status === 'running').length,
      content: <SessionsView
        sessions={snapshots.sessions}
        busy={busy}
        onStop={(id) => void run(() => api.stopSession(id), 'Session stopped.')}
      />,
    },
    {
      value: 'premerge', label: 'Pre-merge',
      content: <PreMergeView rows={snapshots.preMerge} />,
    },
    {
      value: 'audit', label: 'Audit',
      content: <AuditView rows={snapshots.audit} />,
    },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <div>
            <p className="brand-name">Artinarey</p>
            <p className="brand-note">Workspace</p>
          </div>
        </div>

        <nav className="source-list" aria-label="Sections">
          <button
            type="button"
            className={`source-item${section === 'workspace' ? ' is-selected' : ''}`}
            onClick={() => onSection('workspace')}
            aria-current={section === 'workspace' ? 'page' : undefined}
          ><SquaresFour size={16} aria-hidden="true" /><span>Overview</span></button>
          <button
            type="button"
            className={`source-item${section === 'chat' ? ' is-selected' : ''}`}
            onClick={() => onSection('chat')}
            aria-current={section === 'chat' ? 'page' : undefined}
          ><ChatCircle size={16} aria-hidden="true" /><span>Chat</span></button>
          <button
            type="button"
            className={`source-item${section === 'approvals' ? ' is-selected' : ''}`}
            onClick={() => onSection('approvals')}
            aria-current={section === 'approvals' ? 'page' : undefined}
          >
            <Bell size={16} aria-hidden="true" /><span>Approvals</span>
            {pending > 0 && <span className="source-badge">{pending}</span>}
          </button>
          <button
            type="button"
            className={`source-item${section === 'storage' ? ' is-selected' : ''}`}
            onClick={() => onSection('storage')}
            aria-current={section === 'storage' ? 'page' : undefined}
          ><Gear size={16} aria-hidden="true" /><span>Storage</span></button>
        </nav>

        <div className="sidebar-fields">
          <Select
            id="project-select"
            label="Project"
            value={loadedScope.projectId}
            options={snapshots.projects.map((p) => ({ value: p.id, label: p.name }))}
            onChange={onChooseProject}
          />
          {section === 'workspace' && (
            <Select
              id="recipient-select"
              label="Mail recipient"
              value={loadedScope.recipient}
              options={mailRecipientOptions(snapshots.personas).map((value) => ({
                value, label: value === ALL_RECIPIENTS ? 'All recipients' : value,
              }))}
              onChange={onChooseRecipient}
            />
          )}
        </div>

        <p className="sidebar-note">Local only. The daemon makes no outbound model call.</p>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <h1>{selectedProject?.name ?? 'No project selected'}</h1>
            <p>
              {selectedProject
                ? `Store ${selectedProject.storeDir} · ${selectedProject.status}`
                : 'Register a project to see its state here.'}
            </p>
          </div>
          <div className="header-actions">
            <Button onClick={() => setNewWorktree(true)} disabled={!projectId}>New worktree</Button>
            <Button onClick={() => setAdopt(true)} disabled={!projectId}>Adopt</Button>
          </div>
        </header>

        {error && <ErrorBanner code={error.code} message={error.message} onDismiss={() => onActionError({ code: '', message: '' })} />}
        {notice && <div className="notice" role="status">{notice}</div>}
        {loading && <Skeleton rows={4} />}

        {!loading && (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={section}
              className="surface"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={transition}
            >
              {section === 'workspace' && (
                <>
                  {scopeLoading && <p className="loading" role="status">Reloading snapshot…</p>}
                  <TabBar items={tabs} value={tab} onValueChange={(value) => setTab(value as TabValue)} label="Workspace views" />
                  <ProjectView rows={snapshots.projects} />
                  <PersonaView rows={snapshots.personas} />
                  <WorktreeView rows={snapshots.worktrees} />
                </>
              )}
              {section === 'chat' && (
                <ChatView
                  replies={replies}
                  busy={chatBusy}
                  onSend={(message) => {
                    setChatBusy(true);
                    const live = snapshots.sessions.find((session) => session.status === 'running');
                    void api.chat(projectId, message, undefined, live?.id).then((reply) => {
                      setReplies((current) => [...current, reply]);
                    }).catch((err) => onActionError(typedError(err))).finally(() => setChatBusy(false));
                  }}
                />
              )}
              {section === 'approvals' && (
                <ApprovalsView
                  approvals={snapshots.approvals}
                  busy={busy}
                  onDecide={(id, decision) => void run(
                    () => api.approve(id, decision, 'user'),
                    `Approval ${decision}.`,
                  )}
                />
              )}
              {section === 'storage' && (
                <StorageView
                  storage={snapshots.storage}
                  move={visibleMove}
                  target={target}
                  onTarget={setTarget}
                  busy={busy}
                  onSetRoot={(root) => void run(() => api.setStorage(root), 'Data root saved.')}
                  onPreflight={() => void run(
                    async () => { setMove(await api.movePreflight(projectId, target)); },
                    'Preflight complete.',
                  )}
                  onMove={() => void run(
                    async () => {
                      setMove(await api.moveStart(projectId, target));
                      const status = await api.moveStatus(projectId);
                      setMove(status);
                    },
                    'Move finished.',
                  )}
                  onReconnect={() => void run(
                    async () => {
                      const resumeTarget = visibleMove?.target || target;
                      setMove(await api.moveStart(projectId, resumeTarget));
                    },
                    'Storage reconnected; move resumed.',
                  )}
                  onUndo={() => void run(async () => { setMove(await api.moveUndo(projectId)); }, 'Switch undone.')}
                  onDeleteOld={() => void run(async () => { await api.moveDeleteOld(projectId); setMove(null); }, 'Old store deleted.')}
                />
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </main>

      <NewWorktreeDialog
        open={newWorktree}
        onOpenChange={setNewWorktree}
        onCreate={(branch) => void run(() => api.createWorktree(projectId, branch), 'Worktree created.')}
      />
      <AdoptDialog
        open={adopt}
        onOpenChange={setAdopt}
        onAdopt={(path) => void run(() => api.adoptWorktree(projectId, path), 'Worktree adopted.')}
      />
      <BlockerModal
        open={Boolean(blocker)}
        project={blocker?.project ?? ''}
        worktree={blocker?.worktree ?? ''}
        persona={blocker?.persona ?? ''}
        action={blocker?.action ?? ''}
        onClose={() => setBlocker(null)}
      />
    </div>
  );
}

function approvalsPending(rows: GuiApproval[]): number {
  return rows.filter((row) => row.status === 'pending').length;
}

export function App({ api, initial, initialError }: AppProps) {
  const [snapshots, setSnapshots] = useState<Snapshots>({ ...EMPTY, ...initial });
  const [error, setError] = useState<DaemonError | null>(initialError ?? null);
  const [loading, setLoading] = useState(!initial && !initialError);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [section, setSection] = useState<Section>('workspace');
  const [scopeState, dispatchScope] = useReducer(
    scopeReducer,
    initial?.projects?.[0]?.id ?? '',
    initialScopeState,
  );
  const scopeRequest = scopeState.request;
  const scopeGuard = useRef(createScopeGuard());
  const liveScope = useRef<LiveScope>({ scope: scopeState.loaded, version: 0 });

  const loadAll = useCallback(
    (projectId: string, recipient: string) => loadSnapshots(api, projectId, recipient),
    [api],
  );

  const publishScope = useCallback((scope: Scope, next: Snapshots) => {
    liveScope.current = { scope, version: liveScope.current.version + 1 };
    setSnapshots(next);
    dispatchScope({ type: 'loadSucceeded', scope });
  }, []);

  useEffect(() => {
    if (initial || initialError) return;
    let active = true;
    const seq = scopeGuard.current.next();
    void (async () => {
      try {
        const projects = await api.projects();
        const projectId = projects[0]?.id ?? '';
        if (!active || !scopeGuard.current.isCurrent(seq)) return;
        const next = await loadAll(projectId, ALL_RECIPIENTS);
        if (!active || !scopeGuard.current.isCurrent(seq)) return;
        publishScope({ projectId, recipient: ALL_RECIPIENTS }, next);
      } catch (err) {
        if (active) setError(typedError(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api, initial, initialError, loadAll, publishScope]);

  useEffect(() => {
    if (!scopeRequest) return;
    let active = true;
    const seq = scopeGuard.current.next();
    setScopeLoading(true);
    void scopeGuard.current.loadRequested(
      seq,
      () => active,
      () => loadAll(scopeRequest.projectId, scopeRequest.recipient),
      (next) => {
        setScopeLoading(false);
        setError(null);
        publishScope(scopeRequest, next);
      },
    ).catch((err) => {
      if (!active || !scopeGuard.current.isCurrent(seq)) return;
      setScopeLoading(false);
      setError(typedError(err));
      dispatchScope({ type: 'requestFailed' });
    });
    return () => { active = false; };
  }, [scopeRequest, loadAll, publishScope]);

  const refresh = useMemo(
    () => {
      const refreshLoaded = refreshLoadedScope(loadAll, liveScope, setSnapshots, setError);
      return () => {
        scopeGuard.current.snapshotsChanged();
        refreshLoaded();
      };
    },
    [loadAll],
  );

  const clearError = useCallback((next: DaemonError) => {
    setError(next.code && next.message ? next : null);
  }, []);

  return (
    <AppView
      api={api}
      snapshots={snapshots}
      loadedScope={scopeState.loaded}
      error={error}
      loading={loading}
      scopeLoading={scopeLoading}
      section={section}
      onSection={setSection}
      onChooseProject={(projectId) => dispatchScope({ type: 'chooseProject', projectId })}
      onChooseRecipient={(recipient) => dispatchScope({ type: 'chooseRecipient', recipient })}
      onRefresh={refresh}
      onActionError={clearError}
    />
  );
}
