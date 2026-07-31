/**
 * Onboarding gate.
 *
 * Wraps the main Layout. On first mount, queries `/api/onboarding/status`.
 * If onboarding is not complete and the user isn't already at `/onboarding`,
 * pushes a `replace` navigation there.
 *
 * The gate is intentionally permissive on errors: if the status fetch fails
 * we let the user into the app rather than trap them in a loading screen.
 * That matches how the rest of the app degrades when the local API server
 * isn't responding.
 */

import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { api } from '@/renderer/lib/api';

interface OnboardingStatusResponse {
  completed: boolean;
  completed_at?: string;
}

export interface OnboardingGateProps {
  children: React.ReactNode;
}

type GateState = 'checking' | 'allowed' | 'redirecting';

export default function OnboardingGate({
  children,
}: OnboardingGateProps): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<GateState>('checking');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<OnboardingStatusResponse>('/api/onboarding/status');
        if (cancelled) return;
        if (!res.completed && location.pathname !== '/onboarding') {
          setState('redirecting');
          navigate('/onboarding', { replace: true });
          return;
        }
        setState('allowed');
      } catch {
        // Permissive fallback: don't keep the user out of the app if the
        // status endpoint is unreachable.
        if (!cancelled) setState('allowed');
      }
    })();
    return () => {
      cancelled = true;
    };
    // We only want to run this on first mount of the Layout subtree, not
    // on every location change — the wizard handles its own navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'checking' || state === 'redirecting') {
    return (
      <div
        aria-label="onboarding-gate-loading"
        className="flex h-screen w-screen items-center justify-center bg-background text-sm text-muted-foreground"
      >
        Loading…
      </div>
    );
  }

  return <>{children}</>;
}
