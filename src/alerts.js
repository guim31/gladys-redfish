// -----------------------------------------------------------------------------
// What the scene triggers compare with, server by server: the last health,
// the last power state, the critical log entries already seen. Transitions
// only: a server that boots already degraded is recorded, not announced, the
// first time it is read (after an install, or a lost /data).
//
// `saved` is the JSON written under /data by src/store.js.
// -----------------------------------------------------------------------------

import { healthRank } from './redfish/model.js';

// Critical entries remembered per log service: more than any page holds.
export const MAX_SEEN_ENTRIES = 500;

export class Watcher {
  constructor(saved = {}) {
    const systems =
      saved && typeof saved.systems === 'object' && saved.systems ? saved.systems : {};
    /** @type {Record<string, { health?: string|null, on?: boolean|null, logs?: Record<string, string[]> }>} */
    this.systems = structuredClone(systems);
  }

  get saved() {
    return { systems: this.systems };
  }

  entry(key) {
    this.systems[key] ??= {};
    return this.systems[key];
  }

  /**
   * Record the health and power state of a server.
   * @returns {{ degraded: boolean, poweredOn: boolean, poweredOff: boolean, previousHealth: string|null }}
   */
  observe(key, { health, on }) {
    const entry = this.entry(key);
    const result = { degraded: false, poweredOn: false, poweredOff: false, previousHealth: null };
    if (health !== null) {
      const previous = entry.health ?? null;
      result.previousHealth = previous;
      // OK → Warning, OK → Critical, Warning → Critical.
      result.degraded =
        previous !== null && health !== 'OK' && healthRank(health) > healthRank(previous);
      entry.health = health;
    }
    if (on !== null) {
      const previous = entry.on ?? null;
      result.poweredOn = previous === false && on === true;
      result.poweredOff = previous === true && on === false;
      entry.on = on;
    }
    return result;
  }

  /**
   * The critical entries of a log service not seen before. The first read of
   * a service records them all silently.
   * @param {Array<{ key: string }>} entries newest first
   */
  newEntries(key, service, entries) {
    const entry = this.entry(key);
    entry.logs ??= {};
    const seen = entry.logs[service];
    const keys = entries.map((item) => item.key);
    if (!Array.isArray(seen)) {
      entry.logs[service] = keys.slice(0, MAX_SEEN_ENTRIES);
      return [];
    }
    const known = new Set(seen);
    const fresh = entries.filter((item) => !known.has(item.key));
    entry.logs[service] = [...new Set([...keys, ...seen])].slice(0, MAX_SEEN_ENTRIES);
    return fresh;
  }

  /** Forget the servers of a slot (another controller at this address). */
  forgetSlot(slot) {
    let changed = false;
    for (const key of Object.keys(this.systems)) {
      if (key.startsWith(`${slot}-`)) {
        delete this.systems[key];
        changed = true;
      }
    }
    return changed;
  }

  /** Forget the servers of the slots no longer configured. */
  forgetSlots(kept) {
    let changed = false;
    for (const key of Object.keys(this.systems)) {
      if (!kept.has(Number(key.split('-')[0]))) {
        delete this.systems[key];
        changed = true;
      }
    }
    return changed;
  }
}
