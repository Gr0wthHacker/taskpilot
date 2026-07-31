/**
 * Onboarding step 3 — Google Calendar connection.
 *
 * Reuses the same OAuth-start + polling pattern as Settings:
 *   POST /api/calendar/auth/start → { auth_url }
 *   open the URL via window.taskpilot.openExternal
 *   poll /api/calendar/status until { connected: true } or timeout
 *
 * The user can also Skip — calendar setup is optional and the wizard advances
 * either way. We surface the connected email once polling succeeds so the
 * user has tangible confirmation.
 */

import { useEffect, useRef, useState } from 'react';

import { api } from '@/renderer/lib/api';
import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import { cn } from '@/renderer/lib/utils';

interface AuthStartResponse {
  auth_url: string;
}

interface CalendarStatusResponse {
  connected: boolean;
  email?: string | null;
}

type Phase = 'idle' | 'connecting' | 'polling' | 'connected';

export interface Step3CalendarProps {
  onSkip: () => void;
  /** Called when the connection succeeds — parent typically advances the wizard. */
  onConnected?: (email: string | null) => void;
}

const POLL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

async function openExternal(url: string): Promise<void> {
  if (typeof window === 'undefined') return;
  const bridge = window.taskpilot;
  if (bridge && typeof bridge.openExternal === 'function') {
    await bridge.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export default function Step3Calendar({
  onSkip,
  onConnected,
}: Step3CalendarProps): JSX.Element {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Check current connection state on mount so a previously-connected user
  // sees "already connected" instead of being asked again.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<CalendarStatusResponse>('/api/calendar/status');
        if (cancelled || !mountedRef.current) return;
        if (res.connected) {
          setPhase('connected');
          setConnectedEmail(res.email ?? null);
        }
      } catch {
        /* ignore — keep idle */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stopPolling = (): void => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const startPolling = (): void => {
    stopPolling();
    setPhase('polling');

    const tick = async (): Promise<void> => {
      try {
        const res = await api.get<CalendarStatusResponse>('/api/calendar/status');
        if (!mountedRef.current) return;
        if (res.connected) {
          stopPolling();
          setPhase('connected');
          setConnectedEmail(res.email ?? null);
          toast({
            title: 'Connected to Google Calendar',
            description: res.email
              ? `Authenticated as ${res.email}.`
              : 'You can close the browser tab.',
          });
          onConnected?.(res.email ?? null);
        }
      } catch {
        /* keep polling */
      }
    };

    intervalRef.current = setInterval(() => {
      void tick();
    }, POLL_MS);

    timeoutRef.current = setTimeout(() => {
      stopPolling();
      if (!mountedRef.current) return;
      setPhase('idle');
      toast({
        title: 'Connection timed out',
        description:
          'Google didn’t redirect back in time. You can try again or skip and connect later from Settings.',
      });
    }, POLL_TIMEOUT_MS);
  };

  const connect = async (): Promise<void> => {
    setPhase('connecting');
    try {
      const res = await api.post<AuthStartResponse>('/api/calendar/auth/start');
      if (!res.auth_url) {
        setPhase('idle');
        toast({
          title: 'Calendar auth failed',
          description: 'Server did not return an authorization URL.',
        });
        return;
      }
      await openExternal(res.auth_url);
      startPolling();
    } catch (err) {
      setPhase('idle');
      const message = err instanceof Error ? err.message : 'Unexpected error.';
      toast({ title: 'Calendar auth failed', description: message });
    }
  };

  const isWorking = phase === 'connecting' || phase === 'polling';

  return (
    <section aria-label="onboarding-step-3" className="space-y-6 text-center">
      <header className="space-y-2">
        <h2 className="text-3xl font-semibold tracking-tight">Connect Google Calendar</h2>
        <p className="mx-auto max-w-lg text-sm text-muted-foreground">
          TaskPilot reads your upcoming events into the Daily Plan and surfaces
          tasks tied to meetings. Optional — you can wire this up later from
          Settings.
        </p>
      </header>

      {phase === 'connected' ? (
        <div className="mx-auto max-w-md rounded-lg border border-primary/40 bg-primary/5 p-4 text-sm">
          <div className="font-medium">Connected.</div>
          {connectedEmail ? (
            <div className="text-muted-foreground">Authenticated as {connectedEmail}.</div>
          ) : (
            <div className="text-muted-foreground">Calendar sync is live.</div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <Button
            onClick={() => {
              void connect();
            }}
            disabled={isWorking}
            className={cn('px-6')}
          >
            {phase === 'connecting'
              ? 'Starting…'
              : phase === 'polling'
                ? 'Waiting for Google…'
                : 'Connect now'}
          </Button>
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            disabled={isWorking}
          >
            Skip for now
          </button>
          {phase === 'polling' && (
            <p className="max-w-md text-xs text-muted-foreground">
              A browser tab should have opened. Approve access there — we'll
              detect the callback automatically.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
