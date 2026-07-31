/**
 * Tests for the auto-drain bridge (BUILD 7).
 *
 * We can't actually fork PowerShell + schtasks.exe from a unit test (and
 * shouldn't — that would register a real Windows task on the dev box).
 * Instead we verify:
 *
 *   - `isAutoDrainAvailable()` reflects platform correctly
 *   - The PowerShell scripts the bridge points at exist on disk
 *   - The setup script contains the expected schtasks invocation shape
 *     so it can't be silently neutered by a future refactor
 *   - The wrapper prompt contains language that matches the
 *     ambient-deliberate skill's description (so SkillRule autoloads
 *     it in `claude -p` mode — this is a load-bearing detail per recon)
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';

mockTaskpilotPaths();

import { isAutoDrainAvailable } from '@/main/deliberation/auto-drain';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS = path.join(REPO_ROOT, 'scripts');

describe('auto-drain bridge', () => {
  it('reports availability based on platform', () => {
    if (process.platform === 'win32') {
      expect(isAutoDrainAvailable()).toBe(true);
    } else {
      expect(isAutoDrainAvailable()).toBe(false);
    }
  });

  it('ships setup-auto-drain.ps1 next to the other scripts', () => {
    const setup = path.join(SCRIPTS, 'setup-auto-drain.ps1');
    expect(fs.existsSync(setup)).toBe(true);
    const body = fs.readFileSync(setup, 'utf8');
    // Locked behavior: the script MUST register the task as the current
    // user with an InteractiveToken principal — otherwise DPAPI can't
    // decrypt the Claude OAuth and the headless invocation fails silently.
    expect(body).toMatch(/LogonType\s+Interactive/);
    // The 5-minute cadence is the contract this build promises.
    expect(body).toMatch(/Minutes\s+5/);
    // We pre-flight the CLI before registering, so a missing/expired
    // login surfaces synchronously instead of as a silent task fire.
    expect(body).toMatch(/--version/);
  });

  it('ships teardown-auto-drain.ps1', () => {
    const teardown = path.join(SCRIPTS, 'teardown-auto-drain.ps1');
    expect(fs.existsSync(teardown)).toBe(true);
    const body = fs.readFileSync(teardown, 'utf8');
    expect(body).toMatch(/Unregister-ScheduledTask/);
    expect(body).toMatch(/TaskPilot/);
  });

  it('ships run-ambient-deliberate.ps1 with skill-triggering prompt', () => {
    const wrapper = path.join(SCRIPTS, 'run-ambient-deliberate.ps1');
    expect(fs.existsSync(wrapper)).toBe(true);
    const body = fs.readFileSync(wrapper, 'utf8');

    // Anthropic docs: `/<skill>` slash-commands DO NOT work in `-p`
    // mode. The wrapper must echo language from the skill's description
    // so SkillRule autoloads it. Lock those phrases in.
    expect(body).toMatch(/pending deliberations/i);
    expect(body).toMatch(/drain the deliberation queue|drain.*deliberation/i);

    // Required flags per the build contract — losing any of these
    // breaks billing, session hygiene, or auth.
    expect(body).toMatch(/--no-session-persistence/);
    expect(body).toMatch(/--permission-mode\s+bypassPermissions/);
    expect(body).toMatch(/--add-dir/);

    // MUST NOT use --bare (would force ANTHROPIC_API_KEY auth, which
    // contradicts the goal of inheriting the user's subscription login).
    expect(body).not.toMatch(/--bare\b/);
  });

  it('rotates the auto-drain log at 5 MB', () => {
    const wrapper = path.join(SCRIPTS, 'run-ambient-deliberate.ps1');
    const body = fs.readFileSync(wrapper, 'utf8');
    // The recon callout flagged that `-p --output-format json` is
    // verbose; the rotation cap is part of the contract.
    expect(body).toMatch(/5MB|5 MB/);
  });
});
