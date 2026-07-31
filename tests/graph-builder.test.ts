/**
 * Cross-task knowledge graph builder tests (Wave 17).
 *
 * Exercises `@/main/graph/builder#buildGraph` across:
 *   - parent_id → `parent` edges
 *   - context.links blocks/related/duplicate → link edges
 *   - external artifacts (PR / issue / calendar event) → artifact nodes + edges
 *   - scope filtering (all / workspace / tag / root)
 *   - the 200-node cap + truncation flag on the `all` scope
 *   - optional goal membership via an injected loader (defensive)
 *
 * Uses an in-memory DB; no path mocking required since the builder only reads
 * tasks + the `workspaces` setting.
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from './helpers/mock-db';

import {
  buildGraph,
  readArtifactNodes,
  type BuildGraphDeps,
} from '@/main/graph/builder';
import { patchTaskLinks } from '@/main/links';
import { createTask, updateTask } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';
import type { GraphEdge, GraphNode } from '@/shared/api-contract';
import type { Task } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function seed(opts: Partial<Task> & { title: string }): Task {
  return createTask(opts);
}

function edgeKinds(edges: GraphEdge[]): string[] {
  return edges.map((e) => e.kind).sort();
}

function nodeIds(nodes: GraphNode[]): string[] {
  return nodes.map((n) => n.id).sort();
}

function hasEdge(
  edges: GraphEdge[],
  source: string,
  target: string,
  kind: GraphEdge['kind'],
): boolean {
  return edges.some(
    (e) => e.source === source && e.target === target && e.kind === kind,
  );
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

describe('graph builder', () => {
  useMockedDb();

  describe('task nodes', () => {
    it('emits one node per in-scope task with status + priority', () => {
      const a = seed({ title: 'A', status: 'queued', priority: 'p1' });
      const b = seed({ title: 'B', status: 'done', priority: 'p3' });

      const graph = buildGraph({ scope: { kind: 'all' } });
      const ids = nodeIds(graph.nodes);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);

      const nodeA = graph.nodes.find((n) => n.id === a.id);
      expect(nodeA).toMatchObject({
        kind: 'task',
        label: 'A',
        status: 'queued',
        priority: 'p1',
      });
    });

    it('excludes archived tasks from the all scope', () => {
      const live = seed({ title: 'live' });
      seed({ title: 'gone', status: 'archived' });
      const graph = buildGraph({ scope: { kind: 'all' } });
      expect(nodeIds(graph.nodes)).toEqual([live.id]);
    });
  });

  describe('parent edges', () => {
    it('draws a parent → child edge when both are in scope', () => {
      const parent = seed({ title: 'parent' });
      const child = seed({ title: 'child', parent_id: parent.id });

      const graph = buildGraph({ scope: { kind: 'all' } });
      expect(hasEdge(graph.edges, parent.id, child.id, 'parent')).toBe(true);
    });

    it('drops a parent edge when the parent is out of scope', () => {
      const parent = seed({ title: 'parent', tags: ['other'] });
      const child = seed({ title: 'child', parent_id: parent.id, tags: ['focus'] });

      const graph = buildGraph({ scope: { kind: 'tag', value: 'focus' } });
      // Parent is not in the tag scope, so no parent edge is drawn.
      expect(graph.edges.filter((e) => e.kind === 'parent')).toHaveLength(0);
      expect(nodeIds(graph.nodes)).toEqual([child.id]);
    });
  });

  describe('link edges', () => {
    it('emits blocks / related / duplicate edges', () => {
      const a = seed({ title: 'A' });
      const b = seed({ title: 'B' });
      const c = seed({ title: 'C' });
      const d = seed({ title: 'D' });

      patchTaskLinks(a.id, { blocks: [b.id] });
      patchTaskLinks(a.id, { related: [c.id] });
      patchTaskLinks(a.id, { duplicate_of: d.id });

      const graph = buildGraph({ scope: { kind: 'all' } });
      expect(hasEdge(graph.edges, a.id, b.id, 'blocks')).toBe(true);
      expect(hasEdge(graph.edges, a.id, d.id, 'duplicate')).toBe(true);
      // Related is symmetric → emitted once with the ids ordered.
      const [lo, hi] = a.id < c.id ? [a.id, c.id] : [c.id, a.id];
      expect(hasEdge(graph.edges, lo, hi, 'related')).toBe(true);
    });

    it('emits a related edge only once even if both ends declare it', () => {
      const a = seed({ title: 'A' });
      const b = seed({ title: 'B' });
      patchTaskLinks(a.id, { related: [b.id] });
      patchTaskLinks(b.id, { related: [a.id] });

      const graph = buildGraph({ scope: { kind: 'all' } });
      const related = graph.edges.filter((e) => e.kind === 'related');
      expect(related).toHaveLength(1);
    });

    it('drops a link edge to an out-of-scope task', () => {
      const a = seed({ title: 'A', tags: ['focus'] });
      const b = seed({ title: 'B', tags: ['other'] });
      patchTaskLinks(a.id, { blocks: [b.id] });

      const graph = buildGraph({ scope: { kind: 'tag', value: 'focus' } });
      expect(graph.edges.filter((e) => e.kind === 'blocks')).toHaveLength(0);
    });
  });

  describe('artifact nodes', () => {
    it('creates a PR node + produces edge from context.github_pr', () => {
      const t = seed({ title: 'ship it' });
      updateTask(t.id, {
        context: {
          github_pr: { number: 42, url: 'https://github.com/o/r/pull/42', state: 'open' },
        },
      });

      const graph = buildGraph({ scope: { kind: 'all' } });
      const prNode = graph.nodes.find((n) => n.kind === 'pr');
      expect(prNode).toBeDefined();
      expect(prNode?.label).toBe('PR #42');
      expect(prNode?.url).toBe('https://github.com/o/r/pull/42');
      expect(hasEdge(graph.edges, t.id, prNode!.id, 'produces')).toBe(true);
    });

    it('creates an event node from a calendar_event_id', () => {
      const t = seed({ title: 'meeting prep' });
      updateTask(t.id, { calendar_event_id: 'evt-abc' });

      const graph = buildGraph({ scope: { kind: 'all' } });
      const eventNode = graph.nodes.find((n) => n.kind === 'event');
      expect(eventNode).toBeDefined();
      expect(eventNode?.id).toBe('artifact:event:evt-abc');
      expect(hasEdge(graph.edges, t.id, eventNode!.id, 'produces')).toBe(true);
    });

    it('collapses a shared PR into a single node with two produces edges', () => {
      const url = 'https://github.com/o/r/pull/7';
      const a = seed({ title: 'A' });
      const b = seed({ title: 'B' });
      updateTask(a.id, { context: { github_pr: { number: 7, url, state: 'open' } } });
      updateTask(b.id, { context: { github_pr: { number: 7, url, state: 'open' } } });

      const graph = buildGraph({ scope: { kind: 'all' } });
      const prNodes = graph.nodes.filter((n) => n.kind === 'pr');
      expect(prNodes).toHaveLength(1);
      const produces = graph.edges.filter((e) => e.kind === 'produces');
      expect(produces).toHaveLength(2);
    });

    it('readArtifactNodes returns empty for a bare task', () => {
      const t = seed({ title: 'bare' });
      expect(readArtifactNodes(t)).toEqual([]);
    });
  });

  describe('scope filtering', () => {
    it('workspace scope selects tasks whose tags intersect the workspace', () => {
      settingsRepository.set('workspaces', [
        { id: 'it', name: 'IndexThread', tags: ['indexthread'] },
      ]);
      const inWs = seed({ title: 'in', tags: ['indexthread'] });
      seed({ title: 'out', tags: ['other'] });

      const graph = buildGraph({ scope: { kind: 'workspace', value: 'it' } });
      expect(nodeIds(graph.nodes)).toEqual([inWs.id]);
    });

    it('workspace scope is empty for an unknown workspace', () => {
      seed({ title: 'x', tags: ['indexthread'] });
      const graph = buildGraph({ scope: { kind: 'workspace', value: 'nope' } });
      expect(graph.nodes).toHaveLength(0);
    });

    it('tag scope matches case-insensitively', () => {
      const t = seed({ title: 'tagged', tags: ['Leal'] });
      const graph = buildGraph({ scope: { kind: 'tag', value: 'leal' } });
      expect(nodeIds(graph.nodes)).toEqual([t.id]);
    });

    it('root scope pulls ancestors, descendants, and linked tasks', () => {
      const grandparent = seed({ title: 'gp' });
      const parent = seed({ title: 'p', parent_id: grandparent.id });
      const root = seed({ title: 'root', parent_id: parent.id });
      const child = seed({ title: 'c', parent_id: root.id });
      const linked = seed({ title: 'linked' });
      const unrelated = seed({ title: 'unrelated' });
      patchTaskLinks(root.id, { related: [linked.id] });

      const graph = buildGraph({ scope: { kind: 'root', value: root.id } });
      const ids = nodeIds(graph.nodes);
      expect(ids).toContain(grandparent.id);
      expect(ids).toContain(parent.id);
      expect(ids).toContain(root.id);
      expect(ids).toContain(child.id);
      expect(ids).toContain(linked.id);
      expect(ids).not.toContain(unrelated.id);
    });

    it('root scope is empty for an unknown task id', () => {
      seed({ title: 'x' });
      const graph = buildGraph({ scope: { kind: 'root', value: 'missing' } });
      expect(graph.nodes).toHaveLength(0);
    });
  });

  describe('node cap', () => {
    it('truncates the all scope at the cap and flags it', () => {
      for (let i = 0; i < 12; i += 1) seed({ title: `t${i}` });
      const graph = buildGraph({ scope: { kind: 'all' }, nodeCap: 5 });
      expect(graph.nodes.length).toBeLessThanOrEqual(5);
      expect(graph.truncated).toBe(true);
      expect(graph.node_cap).toBe(5);
    });

    it('does not flag truncation when under the cap', () => {
      seed({ title: 'a' });
      const graph = buildGraph({ scope: { kind: 'all' }, nodeCap: 5 });
      expect(graph.truncated).toBe(false);
    });
  });

  describe('goal membership (injected loader)', () => {
    it('emits a goal node + member_of edge when the loader resolves a goal', () => {
      const t = seed({ title: 'goal-task' });
      const deps: BuildGraphDeps = {
        loadAllTasks: () => [t],
        loadWorkspaces: () => [],
        loadGoal: () => ({ id: 'g1', label: 'Ship v2' }),
      };
      const graph = buildGraph({ scope: { kind: 'all' } }, deps);
      const goalNode = graph.nodes.find((n) => n.kind === 'goal');
      expect(goalNode).toMatchObject({ id: 'goal:g1', label: 'Ship v2' });
      expect(hasEdge(graph.edges, t.id, 'goal:g1', 'member_of')).toBe(true);
    });

    it('reads context.goal_id with the default loader', () => {
      seed({ title: 'g', context: { goal_id: 'g9', goal_title: 'Launch' } });
      const graph = buildGraph({ scope: { kind: 'all' } });
      const goalNode = graph.nodes.find((n) => n.kind === 'goal');
      expect(goalNode).toMatchObject({ id: 'goal:g9', label: 'Launch' });
    });

    it('survives a throwing goal loader', () => {
      const t = seed({ title: 'g' });
      const deps: BuildGraphDeps = {
        loadAllTasks: () => [t],
        loadWorkspaces: () => [],
        loadGoal: () => {
          throw new Error('boom');
        },
      };
      const graph = buildGraph({ scope: { kind: 'all' } }, deps);
      expect(graph.nodes.filter((n) => n.kind === 'goal')).toHaveLength(0);
    });
  });

  describe('scope echo', () => {
    it('echoes the requested scope back', () => {
      const graph = buildGraph({ scope: { kind: 'tag', value: 'x' } });
      expect(graph.scope).toEqual({ kind: 'tag', value: 'x' });
    });
  });

  describe('edge kinds smoke', () => {
    it('produces a sane mix of edge kinds for a small connected graph', () => {
      const parent = seed({ title: 'p' });
      const child = seed({ title: 'c', parent_id: parent.id });
      const blocker = seed({ title: 'b' });
      patchTaskLinks(blocker.id, { blocks: [parent.id] });
      updateTask(child.id, {
        context: { github_pr: { number: 1, url: 'https://x/pull/1', state: 'open' } },
      });

      const graph = buildGraph({ scope: { kind: 'all' } });
      const kinds = new Set(edgeKinds(graph.edges));
      expect(kinds.has('parent')).toBe(true);
      expect(kinds.has('blocks')).toBe(true);
      expect(kinds.has('produces')).toBe(true);
    });
  });
});
