/**
 * Tests for the projects.json loader + CWD → business inference.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';

const PATHS = mockTaskpilotPaths();

import {
  buildRepoIndex,
  exists,
  getBusiness,
  inferBusinessFromPath,
  invalidateCache,
  listBusinesses,
  PROJECTS_FILE_PATH,
} from '@/main/businesses/loader';

function writeProjectsFile(json: unknown): void {
  fs.mkdirSync(path.dirname(PROJECTS_FILE_PATH), { recursive: true });
  fs.writeFileSync(
    PROJECTS_FILE_PATH,
    JSON.stringify(json, null, 2),
    'utf8',
  );
  invalidateCache();
}

function clearProjectsFile(): void {
  try {
    fs.unlinkSync(PROJECTS_FILE_PATH);
  } catch {
    /* ignore */
  }
  invalidateCache();
}

describe('businesses/loader', () => {
  beforeEach(() => {
    clearProjectsFile();
  });
  afterEach(() => {
    clearProjectsFile();
  });

  it('returns an empty list when projects.json is missing', () => {
    expect(exists()).toBe(false);
    expect(listBusinesses()).toEqual([]);
  });

  it('parses well-formed projects.json', () => {
    writeProjectsFile({
      owner: 'Gr0wthHacker',
      projects: [
        {
          name: 'Leal Health',
          tag: 'leal-health',
          goal_id: 'K_HrKrWZx_EM',
          repos: ['Gr0wthHacker/leal-treatment-finder-site'],
        },
      ],
    });
    expect(exists()).toBe(true);
    const list = listBusinesses();
    expect(list).toHaveLength(1);
    expect(list[0]?.tag).toBe('leal-health');
    expect(getBusiness('leal-health')?.name).toBe('Leal Health');
    expect(getBusiness('unknown')).toBeNull();
  });

  it('returns empty when projects.json is malformed JSON', () => {
    fs.mkdirSync(path.dirname(PROJECTS_FILE_PATH), { recursive: true });
    fs.writeFileSync(PROJECTS_FILE_PATH, '{ not valid', 'utf8');
    invalidateCache();
    expect(listBusinesses()).toEqual([]);
  });

  it('builds the repo → tag index across multiple businesses', () => {
    writeProjectsFile({
      projects: [
        {
          name: 'Leal Health',
          tag: 'leal-health',
          repos: ['Gr0wthHacker/leal-a', 'Gr0wthHacker/leal-b'],
        },
        {
          name: 'IndexThread',
          tag: 'indexthread',
          repos: ['Gr0wthHacker/redditmarketing'],
        },
      ],
    });
    const idx = buildRepoIndex();
    expect(idx.get('Gr0wthHacker/leal-a')).toBe('leal-health');
    expect(idx.get('Gr0wthHacker/leal-b')).toBe('leal-health');
    expect(idx.get('Gr0wthHacker/redditmarketing')).toBe('indexthread');
    expect(idx.size).toBe(3);
  });

  it('infers business from a CWD whose tail folder matches a repo name', () => {
    writeProjectsFile({
      projects: [
        {
          name: 'Leal Health',
          tag: 'leal-health',
          repos: ['Gr0wthHacker/leal-treatment-finder-site'],
        },
      ],
    });
    expect(inferBusinessFromPath('C:\\Users\\Jack\\code\\leal-treatment-finder-site')).toBe(
      'leal-health',
    );
    // Posix-style.
    expect(inferBusinessFromPath('/Users/jack/code/leal-treatment-finder-site')).toBe(
      'leal-health',
    );
    // Case-insensitive match.
    expect(inferBusinessFromPath('/Users/jack/code/Leal-Treatment-Finder-Site')).toBe(
      'leal-health',
    );
  });

  it('returns null when the CWD does not match any repo', () => {
    writeProjectsFile({
      projects: [
        {
          name: 'Leal Health',
          tag: 'leal-health',
          repos: ['Gr0wthHacker/leal-x'],
        },
      ],
    });
    expect(inferBusinessFromPath('/tmp/some-other-repo')).toBeNull();
    expect(inferBusinessFromPath('')).toBeNull();
  });

  // Make sure PATHS is referenced so tsc doesn't complain.
  it('uses the mocked TASKPILOT_HOME for the projects file path', () => {
    expect(PROJECTS_FILE_PATH.startsWith(PATHS.TASKPILOT_HOME)).toBe(true);
  });
});
