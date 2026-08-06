/**
 * Notes & Documents observer.
 * Watches markdown files, note directories for changes.
 */

import fs from 'node:fs';
import path from 'node:path';

import chokidar from 'chokidar';

import type { ObserverCollector, ObservationEventPayload } from './base';
import { emitObservation } from './base';

export class NotesCollector implements ObserverCollector {
  name = 'Notes & Docs';
  private watcher: chokidar.FSWatcher | null = null;
  private running = false;
  private watchPaths: string[] = [];

  constructor() {
    const userHome = process.env.HOME || process.env.USERPROFILE || '';

    // Common note directories
    const noteDirs = [
      path.join(userHome, 'Documents'),
      path.join(userHome, 'Notes'),
      path.join(userHome, 'Desktop'),
      path.join(userHome, '.taskpilot', 'notes'),
    ];

    this.watchPaths = noteDirs.filter((p) => {
      try {
        return fs.existsSync(p) && fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.watchPaths.length === 0) {
      console.debug('NotesCollector: no note directories found');
      return;
    }

    this.watcher = chokidar.watch(this.watchPaths, {
      ignored: ['node_modules', '.git', '**/.env*', '**/.*'],
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 200,
      },
      depth: 8,
      ignoreInitial: true,
    });

    this.watcher.on('change', (filePath) => {
      this.onNoteChange(filePath);
    });

    this.watcher.on('add', (filePath) => {
      this.onNoteAdd(filePath);
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

  private onNoteChange(filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();

    // Only watch markdown and text files
    if (!['.md', '.txt', '.mdx', '.rst'].includes(ext)) return;

    // Try to extract content + tags from file
    const tags = this.extractTagsFromPath(filePath);
    let preview = '';

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      // Get first 500 chars or first line if it's a title
      const lines = content.split('\n');
      const title = lines[0]?.replace(/^#+\s+/, '') || '';
      preview = title.slice(0, 200);
    } catch {
      // Ignore read errors
    }

    const event: ObservationEventPayload = {
      source: 'notes',
      type: 'note_change',
      data: {
        path: filePath,
        extension: ext,
        preview,
      },
      raw: preview,
      tags,
      confidence: 0.8,
    };

    emitObservation(event);
  }

  private onNoteAdd(filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();

    if (!['.md', '.txt', '.mdx', '.rst'].includes(ext)) return;

    const tags = this.extractTagsFromPath(filePath);

    const event: ObservationEventPayload = {
      source: 'notes',
      type: 'note_add',
      data: {
        path: filePath,
        extension: ext,
      },
      tags,
      confidence: 0.85,
    };

    emitObservation(event);
  }

  private extractTagsFromPath(filePath: string): string[] {
    const tags: string[] = [];
    const name = path.basename(filePath).toLowerCase();
    const dir = path.dirname(filePath).toLowerCase();

    // Topic detection from filename/path
    if (name.includes('research')) tags.push('research');
    if (name.includes('meeting') || name.includes('notes')) tags.push('notes');
    if (name.includes('todo') || name.includes('task')) tags.push('tasks');
    if (name.includes('idea') || name.includes('brainstorm')) tags.push('ideas');
    if (name.includes('log') || name.includes('journal')) tags.push('journal');

    if (dir.includes('projects')) tags.push('project');
    if (dir.includes('personal')) tags.push('personal');
    if (dir.includes('work')) tags.push('work');

    return [...new Set(tags)];
  }
}
