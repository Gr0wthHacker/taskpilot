/**
 * GitHub activity observer.
 * Polls GitHub API for user's recent activity (PRs, issues, pushes).
 */

import { Octokit } from '@octokit/rest';

import type { ObserverCollector, ObservationEventPayload } from './base';
import { emitObservation } from './base';

export class GitHubCollector implements ObserverCollector {
  name = 'GitHub Activity';
  private running = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private octokit: Octokit | null = null;
  private token: string | null = null;
  private username: string | null = null;
  private lastEventId = '';

  /**
   * Initialize with GitHub token (from ~/.taskpilot/env or settings).
   */
  constructor(token?: string) {
    this.token = token || process.env.GITHUB_TOKEN || null;
    if (this.token) {
      this.octokit = new Octokit({ auth: this.token });
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.octokit || !this.token) {
      console.debug('GitHubCollector: no token, skipping');
      return;
    }

    this.running = true;

    // Get authenticated user's login
    try {
      const { data } = await this.octokit.users.getAuthenticated();
      this.username = data.login;
    } catch (err) {
      console.debug('GitHubCollector: failed to get authenticated user', err);
      this.running = false;
      return;
    }

    // Poll every 5 minutes
    await this.pollOnce();
    this.pollInterval = setInterval(() => {
      this.pollOnce().catch(console.debug);
    }, 5 * 60 * 1000);
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async pollOnce(): Promise<void> {
    if (!this.octokit || !this.username) return;

    try {
      // Get recent events for authenticated user
      const { data: events } = await (this.octokit.activity as any).listEventsForAuthenticatedUser({
        per_page: 50,
      });

      for (const event of events) {
        // Skip if we've seen this event before (use creation time as simple dedup)
        const eventTime = (event as any).created_at;
        if (!eventTime || eventTime <= this.lastEventId) continue;

        const payload = this.eventToObservation(event);
        if (payload) {
          emitObservation(payload);
        }

        this.lastEventId = eventTime || new Date().toISOString();
      }
    } catch (err) {
      console.debug('GitHubCollector: poll error', err);
    }
  }

  private eventToObservation(event: any): ObservationEventPayload | null {
    const repo = event.repo?.name || '';
    const type = event.type || '';

    // Filter to user's direct actions
    const relevantTypes = [
      'PushEvent',
      'PullRequestEvent',
      'PullRequestReviewEvent',
      'IssuesEvent',
      'CommitCommentEvent',
    ];

    if (!relevantTypes.includes(type)) {
      return null;
    }

    const payload: ObservationEventPayload = {
      source: 'github',
      type: type.replace('Event', '').toLowerCase(),
      data: {
        repo,
        type,
        action: event.payload?.action || 'unknown',
        created_at: event.created_at,
      },
      tags: ['github', repo.split('/')[0] || 'unknown'],
      confidence: 0.95,
    };

    // Extract additional details based on event type
    if (type === 'PushEvent') {
      payload.data.branch = event.payload?.ref?.replace('refs/heads/', '');
      payload.data.commits = event.payload?.commits?.length || 0;
    } else if (type === 'PullRequestEvent') {
      payload.data.pr_number = event.payload?.pull_request?.number;
      payload.data.pr_title = event.payload?.pull_request?.title;
      payload.data.action = event.payload?.action;
    } else if (type === 'IssuesEvent') {
      payload.data.issue_number = event.payload?.issue?.number;
      payload.data.issue_title = event.payload?.issue?.title;
      payload.data.action = event.payload?.action;
    }

    return payload;
  }
}
