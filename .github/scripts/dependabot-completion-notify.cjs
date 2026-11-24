function notificationMarker(sha) {
  return `<!-- dependabot-ci-success:${sha} -->`;
}

function hasNotificationMarker(comments, sha) {
  const marker = notificationMarker(sha);
  return Array.isArray(comments)
    && comments.some((comment) => typeof comment?.body === 'string' && comment.body.includes(marker));
}

function normalizeVersion(value) {
  if (typeof value !== 'string') return [];
  const parts = value
    .trim()
    .replace(/^[\s^~vV]+/, '')
    .split(/[.\-+]/)
    .map((part) => part.trim());
  return parts.length > 0 && parts.every((part) => /^\d+$/.test(part))
    ? parts.map(Number)
    : [];
}

function classifyUpdate(from, to) {
  const oldParts = normalizeVersion(from);
  const newParts = normalizeVersion(to);
  if (oldParts.length === 0 || newParts.length === 0) return 'unknown';

  const labels = ['major', 'minor', 'patch'];
  for (let index = 0; index < labels.length; index += 1) {
    const oldPart = oldParts[index];
    const newPart = newParts[index];
    if (oldPart === undefined || newPart === undefined) {
      if (oldPart === newPart) continue;
      return 'unknown';
    }
    if (oldPart !== newPart) return labels[index];
  }
  return 'unknown';
}

function cleanCell(cell) {
  return cell
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  return trimmed
    .slice(1, trimmed.endsWith('|') ? -1 : undefined)
    .split('|')
    .map(cleanCell);
}

function stripTrailingPunctuation(value) {
  return value.replace(/[.,;]$/, '');
}

function parseDependencyUpdates(input = {}) {
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const updates = [];
  const seen = new Set();
  const add = (name, from, to, explicitType) => {
    if (!name || !from || !to || seen.has(name)) return;
    seen.add(name);
    const type = String(explicitType || '').toLowerCase();
    const classification = ['patch', 'minor', 'major'].includes(type)
      ? type
      : classifyUpdate(from, to);
    updates.push({ name, from, to, classification });
  };

  let columns = null;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      columns = null;
      continue;
    }
    const cells = splitRow(line);
    if (!columns) {
      const packageIndex = cells.findIndex((cell) => cell.toLowerCase() === 'package');
      const fromIndex = cells.findIndex((cell) => cell.toLowerCase() === 'from');
      const toIndex = cells.findIndex((cell) => cell.toLowerCase() === 'to');
      if (packageIndex >= 0 && fromIndex >= 0 && toIndex >= 0) {
        columns = {
          package: packageIndex,
          from: fromIndex,
          to: toIndex,
          type: cells.findIndex((cell) => cell.toLowerCase() === 'type'),
        };
      }
      continue;
    }
    if (/^:?-{3,}:?$/.test(cells[columns.from])) continue;
    add(cells[columns.package], cells[columns.from], cells[columns.to], columns.type >= 0 ? cells[columns.type] : undefined);
  }
  if (updates.length > 0) return updates;

  const bodyMatch = body.match(/Bumps\s+\[([^\]]+)\]\([^)]+\)\s+from\s+(\S+)\s+to\s+(\S+)/);
  if (bodyMatch) {
    add(bodyMatch[1], bodyMatch[2], stripTrailingPunctuation(bodyMatch[3]));
    return updates;
  }

  const titleMatch = title.match(/bump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+)/i);
  if (titleMatch) {
    add(titleMatch[1], titleMatch[2], stripTrailingPunctuation(titleMatch[3]));
  }
  return updates;
}

function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\|/g, '\\|')
    .replace(/@/g, '&#64;')
    .replace(/\r?\n/g, ' ');
}

function escapeMarkdownBlock(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => escapeMarkdown(line))
    .join('\n');
}

function sanitizeDescription(description, maxLength = 1200) {
  const text = String(description ?? '')
    .replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '')
    .replace(/</g, '')
    .replace(/>/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function extractUrls(text) {
  const urls = [];
  const seen = new Set();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const url = match[0].replace(/[.,;)'"`]+$/, '');
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
    if (urls.length === 3) break;
  }
  return urls;
}

function buildComment(input = {}) {
  const pr = input.pr ?? {};
  const updates = Array.isArray(input.updates) ? input.updates : [];
  const files = Array.isArray(input.files) ? input.files : [];
  const checks = Array.isArray(input.checks) ? input.checks : [];
  const run = input.run ?? {};
  const rawDescription = typeof input.description === 'string' ? input.description : '';
  const description = sanitizeDescription(rawDescription);
  const urls = extractUrls(rawDescription).map(escapeMarkdown);
  const counts = updates.reduce((acc, update) => {
    const key = ['patch', 'minor', 'major', 'unknown'].includes(update.classification)
      ? update.classification
      : 'unknown';
    acc[key] += 1;
    return acc;
  }, { patch: 0, minor: 0, major: 0, unknown: 0 });
  const shownUpdates = updates.slice(0, 50);
  const omittedUpdates = updates.length - shownUpdates.length;
  const shownFiles = files.slice(0, 20);
  const omittedFiles = files.length - shownFiles.length;

  const lines = [
    notificationMarker(run.head_sha),
    '',
    '@Aariso0',
    '',
    '**Dependabot Update Completed**',
    '',
    `- **PR:** [#${pr.number ?? '?'} — ${escapeMarkdown(pr.title ?? 'Untitled update')}](${escapeMarkdown(pr.html_url ?? '#')})`,
    `- **Run:** [${escapeMarkdown(run.html_url ?? 'CI run')}](${escapeMarkdown(run.html_url ?? '#')})`,
    '',
    '| Dependency | From | To | Classification |',
    '| --- | --- | --- | --- |',
  ];

  if (shownUpdates.length === 0) {
    lines.push('| _No dependency versions parsed_ | — | — | unknown |');
  } else {
    for (const update of shownUpdates) {
      lines.push(`| ${escapeMarkdown(update.name)} | ${escapeMarkdown(update.from)} | ${escapeMarkdown(update.to)} | ${escapeMarkdown(update.classification)} |`);
    }
    if (omittedUpdates > 0) lines.push(`| _…and ${omittedUpdates} more update(s)_ | — | — | — |`);
  }

  lines.push(
    '',
    `**Dependencies updated:** ${updates.length}`,
    `**Classification:** ${counts.major} major, ${counts.minor} minor, ${counts.patch} patch, ${counts.unknown} unknown`,
    '',
    '### Changed files',
  );
  if (shownFiles.length === 0) {
    lines.push('- _No changed files reported_');
  } else {
    for (const file of shownFiles) {
      lines.push(`- ${escapeMarkdown(file.filename)} (+${file.additions ?? 0}/-${file.deletions ?? 0})`);
    }
    if (omittedFiles > 0) lines.push(`- _…and ${omittedFiles} more file(s)_`);
  }

  lines.push('', '### CI status', 'CI workflow run concluded: success.');
  if (checks.length === 0) {
    lines.push('- _No check runs reported by the API_');
  } else {
    for (const check of checks) {
      lines.push(`- ${escapeMarkdown(check.name)}: ${escapeMarkdown(check.conclusion ?? 'unknown')}`);
    }
  }

  lines.push('', '### From Dependabot');
  lines.push(description ? escapeMarkdownBlock(description) : '_No description provided_');
  if (urls.length > 0) lines.push('', `Relevant links: ${urls.join(' ')}`);

  lines.push(
    '',
    '### Summary',
    `This update changes ${updates.length} dependenc${updates.length === 1 ? 'y' : 'ies'} (${counts.major} major, ${counts.minor} minor, ${counts.patch} patch). CI passed for commit \`${escapeMarkdown(run.head_sha ?? 'unknown')}\`.`,
  );

  return lines.join('\n');
}

async function main({ github, context, core } = {}) {
  const run = context?.payload?.workflow_run;
  const repo = context?.repo ?? {};
  const info = (message) => core?.info?.(message);
  const skip = (reason) => {
    info(`Skipping Dependabot notification: ${reason}`);
  };

  if (!run) {
    skip('workflow_run payload is missing');
    return;
  }
  if (run.conclusion !== 'success') {
    skip(`CI conclusion is ${run.conclusion ?? 'unknown'}`);
    return;
  }
  if (run.event !== 'pull_request') {
    skip(`CI event is ${run.event ?? 'unknown'}`);
    return;
  }
  if (run.head_repository?.id != null && run.head_repository.id !== context?.payload?.repository?.id) {
    skip('CI run came from another repository');
    return;
  }

  let candidate = (Array.isArray(run.pull_requests) ? run.pull_requests : [])
    .find((pull) => pull?.head?.sha === run.head_sha && pull?.base?.ref === 'main');
  if (!candidate && run.head_branch) {
    const branchPulls = await github.paginate(github.rest.pulls.list, {
      owner: repo.owner,
      repo: repo.repo,
      head: `${repo.owner}:${run.head_branch}`,
      state: 'open',
    });
    candidate = branchPulls.find((pull) => pull?.head?.sha === run.head_sha && pull?.base?.ref === 'main');
  }
  if (!candidate) {
    skip('no open PR matches the CI head SHA and main base');
    return;
  }

  const { data: pr } = await github.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: candidate.number,
  });
  if (pr.user?.login !== 'dependabot[bot]') {
    skip('PR author is not dependabot[bot]');
    return;
  }
  if (pr.base?.ref !== 'main') {
    skip(`PR base is ${pr.base?.ref ?? 'unknown'}`);
    return;
  }
  if (pr.state !== 'open') {
    skip(`PR state is ${pr.state ?? 'unknown'}`);
    return;
  }
  if (pr.head?.sha !== run.head_sha) {
    skip('PR head SHA changed after CI started');
    return;
  }

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: repo.owner,
    repo: repo.repo,
    issue_number: pr.number,
  });
  if (hasNotificationMarker(comments, run.head_sha)) {
    skip(`comment for head SHA ${run.head_sha} already exists`);
    return;
  }

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const checks = run.check_suite_id == null
    ? []
    : await github.paginate(github.rest.checks.listForSuite, {
      owner: repo.owner,
      repo: repo.repo,
      check_suite_id: run.check_suite_id,
      per_page: 100,
    });

  const body = buildComment({
    pr,
    updates: parseDependencyUpdates({ title: pr.title, body: pr.body ?? '' }),
    files,
    checks,
    run,
    description: pr.body ?? '',
  });

  await github.rest.issues.createComment({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: pr.number,
    body,
  });
  info(`Posted Dependabot completion notification on PR #${pr.number} for ${run.head_sha}`);
}

module.exports = {
  notificationMarker,
  hasNotificationMarker,
  classifyUpdate,
  parseDependencyUpdates,
  buildComment,
  main,
};
