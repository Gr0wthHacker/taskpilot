/**
 * Code change observer.
 * Watches local project directories for file changes, git commits.
 */

import fs from 'node:fs';
import path from 'node:path';

// @ts-ignore - chokidar types not available
import chokidar from 'chokidar';

import type { ObserverCollector, ObservationEventPayload } from './base';
import { emitObservation } from './base';

export class CodeCollector implements ObserverCollector {
  name = 'Code Changes';
  // @ts-ignore - chokidar.FSWatcher type not available
  private watcher: any | null = null;
  private running = false;
  private watchPaths: string[] = [];
  private ignorePatterns = [
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    'coverage',
    '**/.env*',
  ];

  constructor() {
    // Watch common project directories
    // Expand this based on user's project layout
    const userHome = process.env.HOME || process.env.USERPROFILE || '';
    this.watchPaths = [
      userHome, // Home directory (catches ~/projects/*, ~/work/*, etc.)
    ].filter((p) => fs.existsSync(p));
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (this.watchPaths.length === 0) {
      console.warn('CodeCollector: no paths to watch');
      return;
    }

    this.watcher = chokidar.watch(this.watchPaths, {
      ignored: this.ignorePatterns,
      persistent: true,
      // Debounce: don't fire on every keystroke
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 200,
      },
      // Only watch for 2 levels deep (avoid traversing entire home dir)
      depth: 6,
      // Skip initial scan (too slow on first boot)
      ignoreInitial: true,
    });

    this.watcher.on('change', (filePath: string) => {
      this.onFileChange(filePath);
    });

    this.watcher.on('add', (filePath: string) => {
      this.onFileAdd(filePath);
    });

    this.running = true;
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private onFileChange(filePath: string): void {
    const ext = path.extname(filePath);

    // Infer tags from file extension/path
    const tags = this.extractTags(filePath);

    const event: ObservationEventPayload = {
      source: 'code',
      type: 'file_change',
      data: {
        path: filePath,
        extension: ext,
        directory: path.dirname(filePath),
      },
      tags,
      confidence: 0.9,
    };

    emitObservation(event);
  }

  private onFileAdd(filePath: string): void {
    const ext = path.extname(filePath);
    const tags = this.extractTags(filePath);

    const event: ObservationEventPayload = {
      source: 'code',
      type: 'file_add',
      data: {
        path: filePath,
        extension: ext,
        directory: path.dirname(filePath),
      },
      tags,
      confidence: 0.85,
    };

    emitObservation(event);
  }

  private extractTags(filePath: string): string[] {
    const tags: string[] = [];
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath).toLowerCase();

    // Language detection
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) tags.push('typescript');
    if (['.py'].includes(ext)) tags.push('python');
    if (['.go'].includes(ext)) tags.push('go');
    if (['.rs'].includes(ext)) tags.push('rust');
    if (['.java'].includes(ext)) tags.push('java');
    if (['.sql'].includes(ext)) tags.push('sql');

    // Framework detection
    if (['react', 'next'].some((f) => filePath.includes(f))) tags.push('react');
    if (['vue'].some((f) => filePath.includes(f))) tags.push('vue');
    if (['tailwind', 'css'].some((f) => filePath.includes(f))) tags.push('styling');

    // File type detection
    if (name.includes('test')) tags.push('testing');
    if (name.includes('spec')) tags.push('testing');
    if (name.includes('package.json')) tags.push('dependencies');
    if (ext === '.md') tags.push('documentation');

    return [...new Set(tags)];
  }
}
