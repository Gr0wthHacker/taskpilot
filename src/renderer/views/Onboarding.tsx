/**
 * Onboarding view.
 *
 * Full-screen 5-step wizard mounted at `/onboarding`. Owns local state for
 * the current step + per-step props; each step component is presentational
 * and reports back via callbacks.
 *
 * Flow:
 *   1. Welcome (PRD framing, get-started / skip-setup)
 *   2. Sample data (empty vs. load demo tasks)
 *   3. Calendar (Google OAuth connect or skip)
 *   4. Claude (MCP config + cowork tip — copyable snippets)
 *   5. Done (POST /api/onboarding/complete → navigate /)
 *
 * "Skip setup" at any point still calls `/api/onboarding/complete` so the
 * gate doesn't keep redirecting the user back here on every relaunch.
 */

import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import OnboardingShell from '@/renderer/components/Onboarding/OnboardingShell';
import Step1Welcome from '@/renderer/components/Onboarding/Step1Welcome';
import Step2SampleData, {
  type SampleDataChoice,
} from '@/renderer/components/Onboarding/Step2SampleData';
import Step3Calendar from '@/renderer/components/Onboarding/Step3Calendar';
import Step4Claude from '@/renderer/components/Onboarding/Step4Claude';
import Step5Done from '@/renderer/components/Onboarding/Step5Done';
import { useToast } from '@/renderer/components/ui/use-toast';
import { api } from '@/renderer/lib/api';

const TOTAL_STEPS = 5;

interface CompleteResponse {
  ok: true;
  completed_at: string;
}

export default function Onboarding(): JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [step, setStep] = useState<number>(1);
  const [sampleChoice, setSampleChoice] = useState<SampleDataChoice>('empty');
  const [sampleLoading, setSampleLoading] = useState<boolean>(false);
  const [completing, setCompleting] = useState<boolean>(false);

  const goNext = useCallback((): void => {
    setStep((prev) => Math.min(prev + 1, TOTAL_STEPS));
  }, []);

  const goBack = useCallback((): void => {
    setStep((prev) => Math.max(prev - 1, 1));
  }, []);

  const finishOnboarding = useCallback(
    async (reason: 'completed' | 'skipped'): Promise<void> => {
      setCompleting(true);
      try {
        await api.post<CompleteResponse>('/api/onboarding/complete');
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unable to mark setup complete.';
        toast({ title: 'Setup not saved', description: message });
        // Still navigate — the gate will fall back to allowing the app in,
        // and the user can rerun setup from Settings if needed.
      } finally {
        setCompleting(false);
      }
      if (reason === 'skipped') {
        toast({
          title: 'Setup skipped',
          description: 'You can revisit the wizard from Settings → About.',
        });
      }
      navigate('/', { replace: true });
    },
    [navigate, toast],
  );

  const handleSkip = useCallback((): void => {
    void finishOnboarding('skipped');
  }, [finishOnboarding]);

  const handleComplete = useCallback((): void => {
    void finishOnboarding('completed');
  }, [finishOnboarding]);

  /* --------------------------- per-step rendering --------------------------- */

  let content: JSX.Element;
  let nextLabel = 'Next';
  let nextDisabled = false;
  let onNext: (() => void) | undefined = goNext;
  let onBack: (() => void) | undefined = goBack;
  let hideControls = false;

  if (step === 1) {
    content = <Step1Welcome onGetStarted={goNext} onSkip={handleSkip} />;
    onBack = undefined;
    hideControls = true; // Step 1 has its own primary CTA
  } else if (step === 2) {
    content = (
      <Step2SampleData
        choice={sampleChoice}
        onChoiceChange={setSampleChoice}
        loading={sampleLoading}
        onLoadingChange={setSampleLoading}
      />
    );
    nextDisabled = sampleLoading;
  } else if (step === 3) {
    content = <Step3Calendar onSkip={goNext} />;
    nextLabel = 'Continue';
  } else if (step === 4) {
    content = <Step4Claude />;
    nextLabel = 'Continue';
  } else {
    // step 5
    content = <Step5Done onComplete={handleComplete} loading={completing} />;
    onNext = undefined; // Step 5 owns its own primary CTA
    hideControls = true;
  }

  return (
    <div aria-label="view-onboarding">
      <OnboardingShell
        step={step}
        totalSteps={TOTAL_STEPS}
        onBack={step > 1 ? onBack : undefined}
        {...(onNext ? { onNext } : {})}
        onSkip={handleSkip}
        nextLabel={nextLabel}
        nextDisabled={nextDisabled}
        hideControls={hideControls}
      >
        {content}
      </OnboardingShell>
    </div>
  );
}
