import type { ReactNode } from 'react';
import type {
  GuiMail, GuiPersona, GuiProject, GuiWorktree,
} from '../../../packages/daemon/src/gui.ts';
import type { DaemonError } from './api.ts';

export function Logo() {
  return <img className="logo" src="/logo.svg" alt="Artinarey" width={40} height={40} />;
}

export function Panel({
  id, title, count, scope, children,
}: { id: string; title: string; count: number; scope?: string; children: ReactNode }) {
  return (
    <section className="panel" id={id} aria-labelledby={`${id}-heading`}>
      <div className="panel-heading">
        <h2 id={`${id}-heading`}>{title}</h2>
        <span className="count">{count} total</span>
      </div>
      {scope && <p className="scope">{scope}</p>}
      {children}
    </section>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="empty" role="status">{message}</p>;
}

export function StatusChip({ status }: { status: GuiProject['status'] }) {
  return <span className={`chip chip-${status}`}>{status}</span>;
}

export function ErrorPanel({ error }: { error: DaemonError }) {
  return (
    <div className="error-panel" role="alert">
      <strong>{error.code}</strong>
      <span>{error.message}</span>
    </div>
  );
}

/**
 * A selection changes only which read-only snapshot is displayed. The marker
 * attribute distinguishes it from any control that could mutate daemon state.
 */
export function ReadOnlySelect({
  id, label, value, options, onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="selector" htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        data-readonly-select="true"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
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

export function ProjectView({ rows }: { rows: GuiProject[] }) {
  return (
    <Panel id="projects" title="Projects" count={rows.length}>
      {rows.length === 0
        ? <EmptyState message="No projects are registered." />
        : (
          <Table headers={['Project', 'Store path', 'Bytes', 'Free bytes', 'Status']}>
            {rows.map((project) => (
              <tr key={project.id}>
                <th scope="row">{project.name}</th>
                <td><code>{project.storeDir}</code></td>
                <td className="numeric">{project.bytes.toLocaleString('en-US')}</td>
                <td className="numeric">{project.freeBytes.toLocaleString('en-US')}</td>
                <td><StatusChip status={project.status} /></td>
              </tr>
            ))}
          </Table>
        )}
    </Panel>
  );
}

export function PersonaView({ rows, scope }: { rows: GuiPersona[]; scope?: string }) {
  return (
    <Panel id="personas" title="Personas" count={rows.length} scope={scope}>
      {rows.length === 0
        ? <EmptyState message="No personas are registered." />
        : (
          <Table headers={['Role', 'Name', 'Worktree', 'Session', 'State']}>
            {rows.map((persona) => (
              <tr key={persona.id}>
                <th scope="row">{persona.role}</th>
                <td>{persona.name}</td>
                <td><code>{persona.worktreeId ?? 'unbound'}</code></td>
                <td><code>{persona.lastVendorSessionId ?? 'none'}</code></td>
                <td>{persona.running ? 'running' : 'idle'}</td>
              </tr>
            ))}
          </Table>
        )}
    </Panel>
  );
}

export function WorktreeView({ rows, scope }: { rows: GuiWorktree[]; scope?: string }) {
  return (
    <Panel id="worktrees" title="Worktrees" count={rows.length} scope={scope}>
      {rows.length === 0
        ? <EmptyState message="No worktrees are registered." />
        : (
          <Table headers={['Path', 'Branch', 'Persona', 'Locked', 'Prunable']}>
            {rows.map((worktree) => (
              <tr key={worktree.id}>
                <th scope="row"><code>{worktree.path}</code></th>
                <td>{worktree.branch ?? 'detached'}</td>
                <td><code>{worktree.personaId ?? 'unbound'}</code></td>
                <td>{worktree.locked ? 'locked' : 'unlocked'}</td>
                <td>{worktree.prunable ? 'prunable' : 'kept'}</td>
              </tr>
            ))}
          </Table>
        )}
    </Panel>
  );
}

export function MailView({ rows, scope }: { rows: GuiMail[]; scope?: string }) {
  return (
    <Panel id="mail" title="Mail" count={rows.length} scope={scope}>
      {rows.length === 0
        ? <EmptyState message="No mail metadata is indexed." />
        : (
          <Table headers={['Id', 'Thread', 'From', 'To', 'Cc', 'Subject', 'Kind', 'Created']}>
            {rows.map((mail) => (
              <tr key={mail.id}>
                <th scope="row"><code>{mail.id}</code></th>
                <td>{mail.thread}</td>
                <td>{mail.from}</td>
                <td>{mail.to.join(', ')}</td>
                <td>{mail.cc.join(', ')}</td>
                <td>{mail.subject}</td>
                <td>{mail.kind}</td>
                <td className="numeric">{mail.createdAt}</td>
              </tr>
            ))}
          </Table>
        )}
    </Panel>
  );
}
