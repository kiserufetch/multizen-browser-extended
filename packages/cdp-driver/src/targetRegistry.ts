/**
 * Tracks the browser's page targets (tabs) and which one is "active" — the
 * target page-level actions (navigate / click / type / extract) route to.
 *
 * Today the driver binds to a single page for the whole session, so closing
 * that tab kills it (defect #18) and new tabs / popups go unnoticed (#19). This
 * registry is the browser-wide target model those fixes build on: it is pure
 * (no CDP, no I/O), so the selection and re-selection logic can be unit-tested
 * exhaustively, and the CdpSession feeds it from Target.* events.
 *
 * Re-selection policy: when the active page is removed, fall back to the most
 * recently seen remaining page (the one the operator most likely switched to),
 * or null when no page remains.
 */
export interface TargetRecord {
  targetId: string;
  type: string;
  url?: string;
  title?: string;
}

export class TargetRegistry {
  /** Page targets only, in insertion order (Map preserves it). */
  private readonly pages = new Map<string, TargetRecord>();
  private activeId: string | null = null;

  /** Add or update a target. Only `page` targets are tracked as tabs; others
   *  (iframe/worker/…) are ignored here. Returns true if it is a tracked page. */
  upsert(record: TargetRecord): boolean {
    if (record.type !== "page") return false;
    // Re-insert so the most-recently-touched page sorts last (used by reselect).
    this.pages.delete(record.targetId);
    this.pages.set(record.targetId, { ...record });
    if (this.activeId === null) this.activeId = record.targetId;
    return true;
  }

  /** Remove a target. If it was active, re-select a replacement. */
  remove(targetId: string): void {
    const wasActive = this.activeId === targetId;
    this.pages.delete(targetId);
    if (wasActive) this.activeId = this.mostRecent();
  }

  /** Explicitly make a known page active. Returns false if unknown. */
  setActive(targetId: string): boolean {
    if (!this.pages.has(targetId)) return false;
    this.activeId = targetId;
    return true;
  }

  /** The active page target id, or null when no page is tracked. */
  active(): string | null {
    return this.activeId;
  }

  activeRecord(): TargetRecord | null {
    return this.activeId ? (this.pages.get(this.activeId) ?? null) : null;
  }

  has(targetId: string): boolean {
    return this.pages.has(targetId);
  }

  /** All tracked page targets, insertion order. */
  list(): TargetRecord[] {
    return Array.from(this.pages.values());
  }

  get size(): number {
    return this.pages.size;
  }

  clear(): void {
    this.pages.clear();
    this.activeId = null;
  }

  private mostRecent(): string | null {
    let last: string | null = null;
    for (const id of this.pages.keys()) last = id;
    return last;
  }
}
