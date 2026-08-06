/**
 * Observer Integration
 * Wires v2 observer into electron main process and IPC handlers.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { initializeObserver, shutdownObserver } from './observer-bootstrap';
import { generateBriefing } from './observer/briefing-generator';
import { settingsRepository } from './db/repositories/settings';

let mainWindow: BrowserWindow | null = null;
let briefingScheduleTimer: NodeJS.Timeout | null = null;

/**
 * Initialize observer integration.
 * Call from main.ts after creating window.
 */
export async function initializeObserverIntegration(window: BrowserWindow): Promise<void> {
  mainWindow = window;

  try {
    // Start observer system
    const githubToken = settingsRepository.get<string>('github_token');
    await initializeObserver({
      enabled: true,
      githubToken: githubToken || undefined,
    });

    // Setup IPC handlers
    setupObserverIPC();

    // Schedule morning briefing
    scheduleMorningBriefing();

    console.log('Observer integration initialized');
  } catch (err) {
    console.error('Failed to initialize observer integration:', err);
  }
}

/**
 * Shutdown observer integration.
 * Call from app.on('quit').
 */
export async function shutdownObserverIntegration(): Promise<void> {
  if (briefingScheduleTimer) {
    clearTimeout(briefingScheduleTimer);
    briefingScheduleTimer = null;
  }

  await shutdownObserver();

  console.log('Observer integration shut down');
}

/**
 * Setup IPC handlers for observer.
 */
function setupObserverIPC(): void {
  // Generate and send briefing
  ipcMain.on('observer:generate-briefing', (event) => {
    try {
      const briefing = generateBriefing();
      event.reply('observer:briefing', briefing);
    } catch (err) {
      console.error('Failed to generate briefing:', err);
    }
  });

  // Check observer status
  ipcMain.handle('observer:status', async () => {
    try {
      const response = await fetch('http://localhost:7847/api/observer/status', {
        headers: {
          'Authorization': `Bearer ${settingsRepository.get<string>('taskpilot_api_token') || ''}`
        }
      });
      if (response.ok) {
        return await response.json();
      }
      return { error: 'Failed to fetch status' };
    } catch (err) {
      console.error('Failed to fetch observer status:', err);
      return { error: String(err) };
    }
  });

  // Force suggestion refresh
  ipcMain.handle('observer:refresh-suggestions', async () => {
    try {
      const response = await fetch('http://localhost:7847/api/observer/suggestions', {
        headers: {
          'Authorization': `Bearer ${settingsRepository.get<string>('taskpilot_api_token') || ''}`
        }
      });
      if (response.ok) {
        return await response.json();
      }
      return [];
    } catch (err) {
      console.error('Failed to fetch suggestions:', err);
      return [];
    }
  });
}

/**
 * Schedule morning briefing for 8 AM (or custom time).
 */
function scheduleMorningBriefing(): void {
  const hour = settingsRepository.get<number>('observer_briefing_hour') ?? 8;
  const enabled = settingsRepository.get<boolean>('observer_briefing_enabled') ?? true;

  if (!enabled || !mainWindow) return;

  function scheduleNext() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(hour, 0, 0, 0);

    const delay = tomorrow.getTime() - now.getTime();

    briefingScheduleTimer = setTimeout(() => {
      if (mainWindow && mainWindow.webContents) {
        try {
          const briefing = generateBriefing();
          mainWindow.webContents.send('observer:briefing', briefing);
        } catch (err) {
          console.error('Failed to send briefing:', err);
        }
      }

      // Reschedule for tomorrow
      scheduleNext();
    }, delay);

    console.log(`Morning briefing scheduled for ${tomorrow.toLocaleTimeString()}`);
  }

  scheduleNext();
}

/**
 * Show briefing modal via IPC.
 */
export function showBriefingModal(briefing: any): void {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('observer:show-briefing-modal', briefing);
  }
}
