import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The gallery submission rules, as a gate rather than as prose.
 *
 * Every assertion here is a rule n8n WROTE down, in one of two pages (read 2026-08-25):
 *   - n8n.notion.site/Template-submission-guidelines-9959894476734da3b402c90b124b1f77
 *   - n8n.notion.site/Sticky-note-guidelines-for-templates-2aa5b6e0c94f8058b0aefddd02655887
 *
 * Rules we INFERRED from their sticky-note generator (template 13868) are deliberately NOT
 * here: measured against the exemplar both pages hold up — n8n.io/workflows/4817 — several of
 * them are false. See docs/spec-n8n-node.md §6.2 for which, and why the distinction matters.
 *
 * Submission 18308 was bounced twice. The second bounce named nothing, but the template broke
 * exactly two written rules that the template which passed did not: default node names, and a
 * section sticky covering one node. Both are checked below.
 */

const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const STICKY_TYPE = 'n8n-nodes-base.stickyNote';

/** n8n's own default node names — the ones you get by dropping a node on the canvas. */
const DEFAULT_NAME = /^(When clicking |When chat message|OpenAI Chat Model|Basic LLM Chain|Edit Fields|Sticky Note|No Operation|Replace Me|Execute Workflow Trigger)/;

interface Node {
  name: string;
  type: string;
  position: [number, number];
  parameters: { content?: string; width?: number; height?: number; color?: number };
}
interface Workflow {
  name: string;
  nodes: Node[];
  connections: Record<string, Record<string, ({ node: string }[] | null)[]>>;
}

/** Words as a reviewer counts them: markdown punctuation is not content. */
const words = (s: string) => (s.replace(/[-#*`[\]()]/g, ' ').match(/\S+/g) ?? []).length;

const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json'));

describe.each(files)('%s conforms to the gallery submission rules', (file) => {
  const wf: Workflow = JSON.parse(readFileSync(join(TEMPLATES_DIR, file), 'utf8'));
  const stickies = wf.nodes.filter((n) => n.type === STICKY_TYPE);
  const work = wf.nodes.filter((n) => n.type !== STICKY_TYPE);
  // A sticky with no colour key is colour 1 — yellow.
  const overviews = stickies.filter((s) => (s.parameters.color ?? 1) === 1);
  const sections = stickies.filter((s) => s.parameters.color === 7);

  /** Nodes fully inside a sticky's box. A node is 100x100 plus its name label below. */
  const covers = (s: Node) => {
    const [x, y] = s.position;
    const w = s.parameters.width ?? 240;
    const h = s.parameters.height ?? 160;
    return work.filter(
      (n) =>
        n.position[0] >= x && n.position[0] + 100 <= x + w && n.position[1] >= y && n.position[1] + 100 <= y + h,
    );
  };

  // "Rename all nodes to describe their purpose." This is the rule that bounced 18308.
  it('renames every node away from the n8n default', () => {
    expect(work.filter((n) => DEFAULT_NAME.test(n.name)).map((n) => n.name)).toEqual([]);
  });

  it('carries exactly one yellow overview sticky, top-left, of 100-300 words', () => {
    expect(overviews).toHaveLength(1);
    const overview = overviews[0]!;
    expect(words(overview.parameters.content ?? '')).toBeGreaterThanOrEqual(100);
    expect(words(overview.parameters.content ?? '')).toBeLessThanOrEqual(300);
    // Top-left: nothing else starts further left, and nothing sits above it.
    const left = Math.min(...wf.nodes.map((n) => n.position[0]));
    expect(overview.position[0]).toBe(left);
  });

  it('gives the overview "How it works" and a setup section', () => {
    const content = overviews[0]!.parameters.content ?? '';
    expect(content).toMatch(/^### How it works$/m);
    expect(content).toMatch(/^### Setup/m);
  });

  // "Stretched to cover/label multiple nodes (not just one)." The other rule that bounced 18308:
  // a 240-wide sticky is floored at the width of a single node's padded box, so a group that
  // ends up with one member silently becomes a label, which is not what a section sticky is.
  it('stretches every section sticky over two or more nodes', () => {
    const singles = sections.filter((s) => covers(s).length < 2);
    expect(singles.map((s) => (s.parameters.content ?? '').split('\n')[0])).toEqual([]);
  });

  it('keeps every section sticky under 50 words and grey', () => {
    for (const s of sections) expect(words(s.parameters.content ?? '')).toBeLessThan(50);
    // Section stickies are required from 4 nodes up; below that a template may have none.
    if (work.length >= 4) expect(sections.length).toBeGreaterThan(0);
  });

  it('leaves no node outside every section sticky', () => {
    const grouped = new Set(sections.flatMap((s) => covers(s).map((n) => n.name)));
    expect(work.filter((n) => !grouped.has(n.name)).map((n) => n.name)).toEqual([]);
  });

  it('overlaps no two stickies', () => {
    const box = (s: Node) => ({
      x0: s.position[0],
      y0: s.position[1],
      x1: s.position[0] + (s.parameters.width ?? 240),
      y1: s.position[1] + (s.parameters.height ?? 160),
    });
    const collisions: string[] = [];
    for (let i = 0; i < stickies.length; i++) {
      for (let j = i + 1; j < stickies.length; j++) {
        const a = box(stickies[i]!);
        const b = box(stickies[j]!);
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
          collisions.push(`${stickies[i]!.parameters.content?.split('\n')[0]} x ${stickies[j]!.parameters.content?.split('\n')[0]}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  // A rename that misses `connections` produces a workflow that imports with dead wires, and
  // the canvas still looks right in a screenshot — so this is checked, not eyeballed.
  it('leaves no connection naming a node that does not exist', () => {
    const names = new Set(wf.nodes.map((n) => n.name));
    const dangling: string[] = [];
    for (const [src, outputs] of Object.entries(wf.connections)) {
      if (!names.has(src)) dangling.push(src);
      for (const slots of Object.values(outputs))
        for (const slot of slots ?? []) for (const c of slot ?? []) if (!names.has(c.node)) dangling.push(c.node);
    }
    expect(dangling).toEqual([]);
  });

  it('names no credential or personal identifier in the sticky copy', () => {
    for (const s of stickies) {
      // Real addresses and ids are what the guidelines call out; a placeholder is fine.
      expect(s.parameters.content ?? '').not.toMatch(/\b[\w.+-]+@(?!example\.)[\w-]+\.[a-z]{2,}\b/i);
      expect(s.parameters.content ?? '').not.toMatch(/\bsk-[A-Za-z0-9]{16,}\b/);
    }
  });
});
