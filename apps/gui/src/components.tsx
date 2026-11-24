import { useState, type ReactNode } from 'react';
import {
  ArrowsLeftRight, CheckCircle, ClockClockwise, FolderOpen, GitBranch, HardDrives,
  ListChecks, Warning,
} from '@phosphor-icons/react';
import type {
  GuiApproval, GuiAudit, GuiChatReply, GuiLease, GuiMoveStatus, GuiPreMerge,
  GuiProject, GuiSession, GuiStorage, GuiTask, GuiWorktree,
} from './api.ts';
import {
  Button, Chip, EmptyState, IconButton, Modal, TextField, Toggle,
} from './ui.tsx';

export function Logo() {
  return <img className="logo" src="/logo-dark.svg" alt="Artinarey" width={32} height={32} />;
}

function Panel({ id, title, meta, children }: {
  id: string;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel" id={id} aria-labelledby={`${id}-heading`}>
      <div className="panel-heading">
        <h2 id={`${id}-heading`}>{title}</h2>
        {meta && <span className="panel-meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function tone(status: string): 'active' | 'offline' | 'warning' | 'success' | 'neutral' {
  const value = status.toLowerCase();
  if (['active', 'running', 'approved', 'verified', 'done'].includes(value)) return 'active';
  if (['offline', 'failed', 'rejected'].includes(value)) return 'offline';
  if (['pending', 'waiting', 'paused', 'blocked'].includes(value)) return 'warning';
  return 'neutral';
}

export function ProjectView({ rows }: { rows: GuiProject[] }) {
  return (
    <Panel id="projects" title="Projects" meta={`${rows.length} total`}>
      {rows.length === 0
        ? <EmptyState title="No projects" message="Register a project to see its store health here." />
        : (
          <Table headers={['Project', 'Store path', 'Bytes', 'Free bytes', 'Status']}>
            {rows.map((project) => (
              <tr key={project.id}>
                <th scope="row">{project.name}</th>
                <td><code>{project.storeDir}</code></td>
                <td className="numeric">{project.bytes.toLocaleString('en-US')}</td>
                <td className="numeric">{project.freeBytes.toLocaleString('en-US')}</td>
                <td><Chip tone={tone(project.status)}>{project.status}</Chip></td>
              </tr>
            ))}
          </Table>
        )}
    </Panel>
  );
}

export function PersonaView({ rows }: {
  rows: Array<{ id: string; role: string; name: string; worktreeId: string | null; running: boolean }>;
}) {
  return (
    <Panel id="personas" title="Personas" meta={`${rows.length} total`}>
      {rows.length === 0
        ? <EmptyState title="No personas" message="Personas appear here once a project has agents." />
        : (
          <Table headers={['Role', 'Name', 'Worktree', 'State']}>
            {rows.map((persona) => (
              <tr key={persona.id}>
                <th scope="row">{persona.role}</th>
                <td>{persona.name}</td>
                <td><code>{persona.worktreeId ?? 'unbound'}</code></td>
                <td><Chip tone={persona.running ? 'active' : 'neutral'}>
                  {persona.running ? 'running' : 'idle'}
                </Chip></td>
              </tr>
            ))}
          </Table>
        )}
    </Panel>
  );
}

export function WorktreeView({ rows }: { rows: GuiWorktree[] }) {
  return (
    <Panel id="worktrees" title="Worktrees" meta={`${rows.length} total`}>
      {rows.length === 0
        ? <EmptyState title="No worktrees" message="Create or adopt a worktree to get started." />
        : (
          <Table headers={['Path', 'Branch', 'Persona', 'Locked', 'Prunable', 'Auto-approve']}>
            {rows.map((worktree) => (
              <tr key={worktree.id}>
                <th scope="row"><code>{worktree.path}</code></th>
                <td>{worktree.branch ?? 'detached'}</td>
                <td><code>{worktree.personaId ?? 'unbound'}</code></td>
                <td>{worktree.locked ? 'locked' : 'unlocked'}</td>
                <td>{worktree.prunable ? 'prunable' : 'kept'}</td>
                <td>{worktree.autoApprove ? 'on' : 'off'}</td>
              </tr>
            ))}
          </Table>
        )}
    </Panel>
  );
}

export function TasksView({ tasks, leases, autoApprove, onAutoApprove }: {
  tasks: GuiTask[];
  leases: GuiLease[];
  autoApprove: Record<string, boolean>;
  onAutoApprove: (worktreeId: string, enabled: boolean) => void;
}) {
  const worktreeIds = [...new Set(leases.map((lease) => lease.worktreeId))];
  return (
    <div className="stack">
      <Panel id="tasks" title="Tasks and leases" meta={`${tasks.length} tasks`}>
        {tasks.length === 0
          ? <EmptyState title="No tasks" message="Tasks assigned to agents appear here." />
          : (
            <Table headers={['Task', 'Status', 'Assignee', 'Worktree', 'Updated']}>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <th scope="row">{task.title}</th>
                  <td><Chip tone={tone(task.status)}>{task.status}</Chip></td>
                  <td>{task.assignee ?? 'unassigned'}</td>
                  <td><code>{task.worktreeId ?? 'unbound'}</code></td>
                  <td className="numeric">{task.updatedAt}</td>
                </tr>
              ))}
            </Table>
          )}
      </Panel>
      <Panel id="leases" title="Active leases" meta={`${leases.length} leases`}>
        {leases.length === 0
          ? <EmptyState title="No active leases" message="A lease appears when a persona claims a worktree." />
          : (
            <Table headers={['Worktree', 'Persona', 'Reason', 'Until']}>
              {leases.map((lease) => (
                <tr key={lease.id}>
                  <th scope="row"><code>{lease.worktreeId}</code></th>
                  <td><code>{lease.personaId}</code></td>
                  <td>{lease.reason}</td>
                  <td className="numeric">{lease.expiresAt ?? 'no expiry'}</td>
                </tr>
              ))}
            </Table>
          )}
      </Panel>
      {worktreeIds.length > 0 && (
        <Panel id="approvals-settings" title="Worktree auto-approve">
          <div className="toggle-list">
            {worktreeIds.map((id) => (
              <div className="toggle-row" key={id}>
                <span><GitBranch size={15} aria-hidden="true" /> <code>{id}</code></span>
                <Toggle
                  checked={Boolean(autoApprove[id])}
                  onChange={(next) => onAutoApprove(id, next)}
                  label={`Auto-approve worktree ${id}`}
                />
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

export function SessionsView({ sessions, onStop }: {
  sessions: GuiSession[];
  onStop: (id: string) => void;
}) {
  return (
    <Panel id="sessions" title="Sessions" meta={`${sessions.length} sessions`}>
      {sessions.length === 0
        ? <EmptyState title="No sessions" message="Sessions appear here when a persona starts work." />
        : (
          <Table headers={['Session', 'Persona', 'Vendor', 'State', 'Started', '']}>
            {sessions.map((session) => (
              <tr key={session.id}>
                <th scope="row"><code>{session.id}</code></th>
                <td><code>{session.personaId}</code></td>
                <td>{session.vendor}{session.vendorSessionId && <> <code>{session.vendorSessionId}</code></>}</td>
                <td><Chip tone={tone(session.status)}>{session.status}</Chip></td>
                <td className="numeric">{session.startedAt}</td>
                <td>
                  {session.status === 'running' && (
                    <IconButton label={`Stop session ${session.id}`} onClick={() => onStop(session.id)}>
                      <span className="stop-icon" aria-hidden="true" />
                    </IconButton>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
    </Panel>
  );
}

export function PreMergeView({ rows }: { rows: GuiPreMerge[] }) {
  return (
    <Panel id="premerge" title="Pre-merge" meta={`${rows.length} checks`}>
      {rows.length === 0
        ? <EmptyState title="Nothing to verify" message="Lease verification results appear here before a merge." />
        : (
          <Table headers={['Worktree', 'State', 'Summary', 'Checked']}>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row"><code>{row.worktreeId}</code></th>
                <td><Chip tone={tone(row.status)}>{row.status}</Chip></td>
                <td>{row.summary}</td>
                <td className="numeric">{row.checkedAt}</td>
              </tr>
            ))}
          </Table>
        )}
    </Panel>
  );
}

export function AuditView({ rows }: { rows: GuiAudit[] }) {
  return (
    <Panel id="audit" title="Audit" meta={`${rows.length} events`}>
      {rows.length === 0
        ? <EmptyState title="No audit events" message="Decisions are recorded here as they happen." />
        : (
          <ul className="audit-list">
            {rows.map((row) => (
              <li key={row.id} className="audit-row">
                <span className="audit-time numeric">{row.at}</span>
                <Chip tone="neutral">{row.type}</Chip>
                <span>{row.text}</span>
              </li>
            ))}
          </ul>
        )}
    </Panel>
  );
}

export function ApprovalsView({ approvals, onDecide }: {
  approvals: GuiApproval[];
  onDecide: (id: string, decision: 'approved' | 'rejected') => void;
}) {
  const open = approvals.filter((item) => item.status === 'pending');
  return (
    <Panel id="approvals" title="Approvals" meta={`${open.length} waiting`}>
      {open.length === 0
        ? <EmptyState title="No pending approvals" message="Risky calls and spawn requests land here for a decision." />
        : (
          <ul className="approval-list">
            {open.map((item) => (
              <li key={item.id} className="approval-row">
                <div className="approval-copy">
                  <p className="approval-title"><Warning size={15} aria-hidden="true" /> {item.kind}</p>
                  <p className="approval-summary">{item.summary}</p>
                  <p className="approval-meta">
                    <code>{item.worktreeId ?? 'no worktree'}</code>
                    <span className="numeric">{item.requestedAt}</span>
                  </p>
                </div>
                <div className="approval-actions">
                  <Button variant="secondary" onClick={() => onDecide(item.id, 'rejected')}>Reject</Button>
                  <Button variant="primary" onClick={() => onDecide(item.id, 'approved')}>Approve</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
    </Panel>
  );
}

export function ChatView({ replies, onSend, busy }: {
  replies: GuiChatReply[];
  onSend: (message: string) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState('');
  function submit() {
    const message = draft.trim();
    if (!message || busy) return;
    onSend(message);
    setDraft('');
  }
  return (
    <Panel id="chat" title="Chat" meta={replies.length ? `${replies.length} replies` : undefined}>
      <div className="chat-thread" aria-live="polite">
        {replies.length === 0
          ? <EmptyState title="Start a conversation" message="Messages go to a live session when one is running; otherwise they are queued as mail and copied to the senior dev." />
          : replies.map((reply) => (
            <div className="chat-reply" key={reply.id}>
              <p>{reply.text}</p>
              <span className="chat-meta">
                {reply.queued ? 'queued as mail' : 'sent to session'}
                {reply.copiedTo ? ` · copied to ${reply.copiedTo}` : ''}
              </span>
            </div>
          ))}
      </div>
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <TextField
          id="chat-message"
          label="Message"
          value={draft}
          onChange={setDraft}
          placeholder="Ask the senior dev to do something…"
        />
        <Button variant="primary" type="submit" busy={busy} disabled={!draft.trim()}>Send</Button>
      </form>
    </Panel>
  );
}

export function StorageView({
  storage, move, target, onTarget, onSetRoot, onPreflight, onMove, onReconnect,
  onUndo, onDeleteOld, busy,
}: {
  storage: GuiStorage | null;
  move: GuiMoveStatus | null;
  target: string;
  onTarget: (value: string) => void;
  onSetRoot: (value: string) => void;
  onPreflight: () => void;
  onMove: () => void;
  onReconnect: () => void;
  onUndo: () => void;
  onDeleteOld: () => void;
  busy: boolean;
}) {
  const [rootDraft, setRootDraft] = useState(storage?.dataRoot ?? '');
  const phase = move?.phase ?? 'idle';
  const progress = move && move.bytesTotal > 0
    ? Math.min(100, Math.round((move.bytesCopied / move.bytesTotal) * 100)) : 0;

  return (
    <div className="stack">
      <Panel id="storage" title="Storage settings">
        <div className="form-row">
          <TextField
            id="data-root"
            label="Data root"
            value={rootDraft}
            onChange={setRootDraft}
            placeholder="/absolute/path/to/artinarey"
            hint="An absolute path. The daemon validates it before applying."
          />
          <div className="form-actions">
            <Button onClick={() => onSetRoot(rootDraft)} disabled={!rootDraft.trim() || busy}>Save root</Button>
          </div>
        </div>
        {storage && (
          <Table headers={['Project', 'Store path', 'Bytes', 'Free bytes']}>
            {storage.projects.map((project) => (
              <tr key={project.id}>
                <th scope="row">{project.name}</th>
                <td><code>{project.storeDir}</code></td>
                <td className="numeric">{project.bytes.toLocaleString('en-US')}</td>
                <td className="numeric">{project.freeBytes.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
      <Panel id="move" title="Move store" meta={<><ArrowsLeftRight size={14} aria-hidden="true" /> wizard</>}>
        <div className="form-row">
          <TextField
            id="move-target"
            label="Target directory"
            value={target}
            onChange={onTarget}
            placeholder="/Volumes/NewDisk/artinarey"
            hint="Copy, verify, then switch. The old store stays intact until verification passes."
          />
          <div className="form-actions">
            <Button onClick={onPreflight} disabled={!target.trim() || busy}>Check</Button>
            <Button variant="primary" onClick={onMove} disabled={!target.trim() || busy}>Start move</Button>
          </div>
        </div>
        {move && (
          <div className={`move-status move-${phase}`}>
            <div className="move-line">
              <Chip tone={phase === 'offline' ? 'offline' : phase === 'done' ? 'success' : tone(phase)}>
                {phase}
              </Chip>
              <span className="move-path"><code>{move.source}</code> → <code>{move.target}</code></span>
            </div>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <p className="move-detail">
              {move.bytesCopied.toLocaleString('en-US')} / {move.bytesTotal.toLocaleString('en-US')} bytes
              {move.verified ? ' · verified' : ''}
              {move.error ? ` · ${move.error}` : ''}
            </p>
            <div className="form-actions">
              <Button
                variant="primary"
                onClick={onReconnect}
                disabled={busy || phase !== 'offline'}
              >
                Reconnect
              </Button>
              <Button onClick={onUndo} disabled={busy || !['done', 'switching', 'rebuilding'].includes(phase)}>
                Undo switch
              </Button>
              <Button variant="danger" onClick={onDeleteOld} disabled={busy || phase !== 'done'}>
                Delete old store
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

const C4_WARNING = 'Adopting an unmanaged worktree can bind a directory that another process still owns. ' +
  'Only adopt a worktree whose path you control and whose lease is free.';

export function NewWorktreeDialog({ open, onOpenChange, onCreate }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (branch: string) => void;
}) {
  const [branch, setBranch] = useState('');
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New worktree"
      description="Create a managed worktree for a persona to work in."
      footer={<>
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" disabled={!branch.trim()} onClick={() => { onCreate(branch.trim()); onOpenChange(false); }}>
          Create worktree
        </Button>
      </>}
    >
      <TextField
        id="new-worktree-branch"
        label="Branch name"
        value={branch}
        onChange={setBranch}
        placeholder="artinarey/dev2"
      />
    </Modal>
  );
}

export function AdoptDialog({ open, onOpenChange, onAdopt }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdopt: (path: string) => void;
}) {
  const [path, setPath] = useState('');
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Adopt worktree"
      tone="warning"
      footer={<>
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="danger" disabled={!path.trim()} onClick={() => { onAdopt(path.trim()); onOpenChange(false); }}>
          Adopt anyway
        </Button>
      </>}
    >
      <div className="warning-note"><Warning size={18} aria-hidden="true" /><span>{C4_WARNING}</span></div>
      <TextField
        id="adopt-path"
        label="Worktree path"
        value={path}
        onChange={setPath}
        placeholder="/absolute/path/to/worktree"
      />
    </Modal>
  );
}

export function BlockerModal({ open, project, worktree, persona, action, onClose }: {
  open: boolean;
  project: string;
  worktree: string;
  persona: string;
  action: string;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Worktree blocked"
      tone="warning"
      footer={<Button variant="primary" onClick={onClose}>OK</Button>}
    >
      <p className="blocker-copy">
        <code>{project}</code> / <code>{worktree}</code> is blocked by <strong>{persona}</strong>.
        Stop or delete {persona} to {action}.
      </p>
    </Modal>
  );
}

export function SaveNotice({ children }: { children: ReactNode }) {
  return <span className="save-notice"><CheckCircle size={14} aria-hidden="true" /> {children}</span>;
}

export function StorageIcon() { return <HardDrives size={16} aria-hidden="true" />; }
export function TasksIcon() { return <ListChecks size={16} aria-hidden="true" />; }
export function AuditIcon() { return <ClockClockwise size={16} aria-hidden="true" />; }
export function FolderIcon() { return <FolderOpen size={16} aria-hidden="true" />; }
