/**
 * GitHub publishing for mindstream syntheses.
 *
 * On approval, commits a timestamped markdown file to Gr0wthHacker/mindstream.
 */

import * as path from 'node:path';
import { TASKPILOT_HOME } from '@/shared/constants';
import type { SynthesisResult } from './index';

export function formatSynthesisFile(synthesis: SynthesisResult): {
  filename: string;
  content: string;
} {
  const date = new Date(synthesis.timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');

  const filename = `${year}-${month}-${day}T${hour}-${min}Z.md`;
  const content = `# ${date.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC

${synthesis.raw_summary}

---
*Generated at ${synthesis.timestamp}*
`;

  return { filename, content };
}

export async function publishToMindstream(synthesis: SynthesisResult): Promise<void> {
  const { filename, content } = formatSynthesisFile(synthesis);
  const repoPath = path.join(TASKPILOT_HOME, 'mindstream-local');
  const filePath = path.join(repoPath, filename);

  try {
    const fs = await import('node:fs/promises');
    await fs.mkdir(repoPath, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to write synthesis to ${filePath}: ${err}`);
  }
}

export async function commitAndPushSynthesis(
  synthesis: SynthesisResult,
  opts: { push?: boolean; remoteName?: string } = {},
): Promise<void> {
  const { filename } = formatSynthesisFile(synthesis);
  const repoPath = path.join(TASKPILOT_HOME, 'mindstream-local');
  const { spawn } = await import('node:child_process');
  const push = opts.push !== false;
  const remote = opts.remoteName || 'origin';

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', ['add', filename], { cwd: repoPath });
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`git add failed with code ${code}`));
      else resolve();
    });
  });

  const commitMsg = `Mindstream: ${filename}`;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', ['commit', '-m', commitMsg], { cwd: repoPath });
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`git commit failed with code ${code}`));
      else resolve();
    });
  });

  if (push) {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('git', ['push', remote, 'main'], { cwd: repoPath });
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(`git push failed with code ${code}`));
        else resolve();
      });
    });
  }
}

export async function initMindstreamRepo(): Promise<void> {
  const repoPath = path.join(TASKPILOT_HOME, 'mindstream-local');
  const fs = await import('node:fs/promises');
  const { spawn } = await import('node:child_process');

  try {
    await fs.access(path.join(repoPath, '.git'));
    return;
  } catch {
    /* doesn't exist */
  }

  await fs.mkdir(repoPath, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', ['init'], { cwd: repoPath });
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`git init failed`));
      else resolve();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', ['remote', 'add', 'origin', 'https://github.com/Gr0wthHacker/mindstream.git'], {
      cwd: repoPath,
    });
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`git remote add failed`));
      else resolve();
    });
  });

  await new Promise<void>((resolve) => {
    const proc = spawn('git', ['fetch', 'origin', 'main'], { cwd: repoPath });
    proc.on('close', () => {
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    const proc = spawn('git', ['checkout', '-b', 'main', 'origin/main'], { cwd: repoPath });
    proc.on('close', () => {
      resolve();
    });
  });
}
