/**
 * React hook for observer system.
 * Manages suggestions, context, briefing, and actions.
 */

import { useEffect, useState, useCallback } from 'react';
import type { Suggestion } from '@/shared/schema-v2';
import type { BriefingContent } from '@/main/observer/briefing-generator';

let API_TOKEN = '';
const API_BASE = '/api/observer';

// Load API token from main process on startup
if (typeof window !== 'undefined' && (window as any).taskpilot?.getApiToken) {
  (window as any).taskpilot.getApiToken().then((token: string | { error: any }) => {
    if (typeof token === 'string') {
      API_TOKEN = token;
    }
  }).catch(() => {
    // Token unavailable, use empty string
    API_TOKEN = '';
  });
}

declare global {
  interface Window {
    electron?: {
      ipcRenderer?: {
        send: (channel: string, ...args: any[]) => void;
        on: (channel: string, cb: (...args: any[]) => void) => () => void;
      };
    };
  }
}

interface UseObserverOptions {
  autoRefresh?: boolean;
  refreshInterval?: number;
}

export function useObserverSuggestions(options: UseObserverOptions = {}) {
  const { autoRefresh = true, refreshInterval = 60000 } = options;
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/suggestions?limit=5`, {
        headers: { 'Authorization': `Bearer ${API_TOKEN}` }
      });
      if (!response.ok) throw new Error('Failed to fetch suggestions');
      const data = await response.json();
      setSuggestions(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoRefresh) {
      fetchSuggestions();
      const interval = setInterval(fetchSuggestions, refreshInterval);
      return () => clearInterval(interval);
    }
    return undefined;
  }, [autoRefresh, refreshInterval, fetchSuggestions]);

  const dismissSuggestion = useCallback(async (id: string) => {
    try {
      await fetch(`${API_BASE}/suggestions/${id}/action`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action: 'dismiss' })
      });
      setSuggestions(s => s.filter(x => x.id !== id));
    } catch (err) {
      console.error('Failed to dismiss suggestion:', err);
    }
  }, []);

  const executeSuggestion = useCallback(async (id: string) => {
    try {
      await fetch(`${API_BASE}/suggestions/${id}/action`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action: 'execute' })
      });
      setSuggestions(s => s.filter(x => x.id !== id));
    } catch (err) {
      console.error('Failed to execute suggestion:', err);
    }
  }, []);

  return {
    suggestions,
    loading,
    error,
    refresh: fetchSuggestions,
    dismiss: dismissSuggestion,
    execute: executeSuggestion,
  };
}

export function useObserverContext() {
  const [context, setContext] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const fetchContext = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/context`, {
        headers: { 'Authorization': `Bearer ${API_TOKEN}` }
      });
      if (response.ok) {
        const data = await response.json();
        setContext(data);
      }
    } catch (err) {
      console.debug('Failed to fetch context:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchContext();
    const interval = setInterval(fetchContext, 30000); // Every 30s
    return () => clearInterval(interval);
  }, [fetchContext]);

  return { context, loading, refresh: fetchContext };
}

export function useObserverBriefing() {
  const [briefing, setBriefing] = useState<BriefingContent | null>(null);
  const [showBriefing, setShowBriefing] = useState(false);

  const generateBriefing = useCallback(async () => {
    try {
      // Briefing is generated server-side, fetch it
      const response = await fetch(`${API_BASE}/context`, {
        headers: { 'Authorization': `Bearer ${API_TOKEN}` }
      });
      if (response.ok) {
        // This is a simplified version; full briefing generation happens on server
        // For now, we'll trigger it via electron IPC
        if (window.electron?.ipcRenderer) {
          window.electron.ipcRenderer.send('observer:generate-briefing');
        }
      }
    } catch (err) {
      console.error('Failed to generate briefing:', err);
    }
  }, []);

  useEffect(() => {
    // Listen for briefing from main process
    if (window.electron?.ipcRenderer) {
      const unsubscribe = window.electron.ipcRenderer.on('observer:briefing', (briefing: BriefingContent) => {
        setBriefing(briefing);
        setShowBriefing(true);
      });
      return () => unsubscribe?.();
    }
    return undefined;
  }, []);

  return {
    briefing,
    showBriefing,
    generate: generateBriefing,
    dismiss: () => setShowBriefing(false),
  };
}
