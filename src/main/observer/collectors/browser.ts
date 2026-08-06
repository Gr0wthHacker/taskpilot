/**
 * Browser activity observer.
 * Uses Chrome DevTools Protocol to monitor page visits and search queries.
 */

// @ts-ignore - chrome-remote-interface types not available
import CDP from 'chrome-remote-interface';
// @ts-ignore - devtools-protocol types not available
import type { ProtocolMapping } from 'devtools-protocol';

import type { ObserverCollector, ObservationEventPayload } from './base';
import { emitObservation } from './base';

export class BrowserCollector implements ObserverCollector {
  name = 'Browser Activity';
  private running = false;
  // @ts-ignore - CDP.Client type not available
  private client: any | null = null;
  private port = 9222; // Default Chrome DevTools Protocol port
  private lastUrls = new Set<string>(); // Dedup recent visits

  async start(): Promise<void> {
    if (this.running) return;

    try {
      // Try to connect to Chrome DevTools Protocol
      this.client = await (CDP as any)({ port: this.port, host: 'localhost' });

      const { Page, Runtime } = this.client;

      // Listen for page navigation
      Page.frameNavigated((_params: ProtocolMapping.Events['Page.frameNavigated']): void => {
        // Will be called when page loads
      });

      // Listen for JavaScript execution to catch search queries
      Runtime.executionContextCreated((): void => {
        // Can be used to track page interactions
      });

      this.running = true;

      // Poll Chrome history every 10 seconds
      this.pollChromeHistory().catch(console.debug);
    } catch (err) {
      console.debug('BrowserCollector: Chrome DevTools Protocol not available', err);
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Poll Chrome's local storage to detect search queries and page visits.
   * This is a best-effort approach since CDP doesn't directly expose history.
   */
  private async pollChromeHistory(): Promise<void> {
    if (!this.client || !this.running) return;

    try {
      const tabs = await (CDP as any).List({ port: this.port });

      for (const tab of tabs) {
        // Skip non-webpage tabs
        if (!tab.url || tab.type !== 'page') continue;

        // Detect if this is a search engine
        const url = new URL(tab.url);
        const isSearch = this.isSearchQuery(url);

        if (isSearch) {
          const query = this.extractSearchQuery(url);
          if (query && !this.lastUrls.has(query)) {
            this.lastUrls.add(query);
            this.emitSearchEvent(query, url.hostname);
          }
        } else if (!this.lastUrls.has(tab.url)) {
          // Regular page visit
          this.lastUrls.add(tab.url);
          this.emitPageVisitEvent(tab.url, tab.title || '');
        }
      }

      // Cleanup old URLs (keep last 100)
      if (this.lastUrls.size > 100) {
        const arr = Array.from(this.lastUrls);
        this.lastUrls = new Set(arr.slice(arr.length - 100));
      }

      // Poll again in 10 seconds
      if (this.running) {
        setTimeout(() => this.pollChromeHistory().catch(console.debug), 10000);
      }
    } catch (err) {
      console.debug('BrowserCollector: poll error', err);
      if (this.running) {
        setTimeout(() => this.pollChromeHistory().catch(console.debug), 30000);
      }
    }
  }

  private isSearchQuery(url: URL): boolean {
    const searchEngines = ['google.com', 'duckduckgo.com', 'bing.com', 'github.com', 'stackoverflow.com'];
    return searchEngines.some((engine) => url.hostname.includes(engine));
  }

  private extractSearchQuery(url: URL): string | null {
    const params = url.searchParams;

    // Google
    if (url.hostname.includes('google.com')) {
      return params.get('q') || null;
    }

    // DuckDuckGo
    if (url.hostname.includes('duckduckgo.com')) {
      return params.get('q') || null;
    }

    // Bing
    if (url.hostname.includes('bing.com')) {
      return params.get('q') || null;
    }

    // GitHub
    if (url.hostname.includes('github.com')) {
      return params.get('q') || params.get('type') || null;
    }

    // Stack Overflow
    if (url.hostname.includes('stackoverflow.com')) {
      const match = url.pathname.match(/\?tab=.*&q=([^&]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    }

    return null;
  }

  private emitSearchEvent(query: string, engine: string): void {
    const tags = this.extractTagsFromQuery(query);

    const event: ObservationEventPayload = {
      source: 'search',
      type: 'search_query',
      data: {
        query,
        engine,
      },
      raw: query,
      tags,
      confidence: 0.85,
    };

    emitObservation(event);
  }

  private emitPageVisitEvent(url: string, title: string): void {
    let tags: string[] = [];
    try {
      const urlObj = new URL(url);
      tags = [urlObj.hostname.replace('www.', '')];

      // Tag common sites
      if (urlObj.hostname.includes('github.com')) tags.push('github');
      if (urlObj.hostname.includes('stackoverflow.com')) tags.push('stackoverflow');
      if (urlObj.hostname.includes('docs.')) tags.push('documentation');
      if (urlObj.hostname.includes('blog')) tags.push('article');
    } catch {
      /* ignore */
    }

    const event: ObservationEventPayload = {
      source: 'browser',
      type: 'page_visit',
      data: {
        url,
        title,
        hostname: new URL(url).hostname,
      },
      tags,
      confidence: 0.8,
    };

    emitObservation(event);
  }

  private extractTagsFromQuery(query: string): string[] {
    const tags: string[] = [];
    const lower = query.toLowerCase();

    // Language detection
    if (['typescript', 'ts', 'javascript', 'js', 'react', 'vue', 'angular'].some((t) => lower.includes(t)))
      tags.push('typescript');
    if (['python', 'py'].some((t) => lower.includes(t))) tags.push('python');
    if (['rust', 'rs'].some((t) => lower.includes(t))) tags.push('rust');

    // Topic detection
    if (['api', 'rest', 'graphql'].some((t) => lower.includes(t))) tags.push('api');
    if (['database', 'sql', 'postgres', 'mongo'].some((t) => lower.includes(t))) tags.push('database');
    if (['bug', 'error', 'debug', 'fix'].some((t) => lower.includes(t))) tags.push('debugging');
    if (['test', 'jest', 'vitest', 'mocha'].some((t) => lower.includes(t))) tags.push('testing');
    if (['performance', 'optimize', 'slow'].some((t) => lower.includes(t))) tags.push('performance');

    return [...new Set(tags)];
  }
}
