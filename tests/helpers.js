'use strict';

class MemoryStore {
  constructor() { this.docs = new Map(); this.tail = Promise.resolve(); }
  key(collection, id) { return `${collection}/${id}`; }
  async get(collection, id) {
    const value = this.docs.get(this.key(collection, id));
    return value === undefined ? null : structuredClone(value);
  }
  async put(collection, id, value) { this.docs.set(this.key(collection, id), structuredClone(value)); }
  async create(collection, id, value) {
    if (this.docs.has(this.key(collection, id))) throw new Error('ALREADY_EXISTS');
    await this.put(collection, id, value);
  }
  async remove(collection, id) { this.docs.delete(this.key(collection, id)); }
  async list(collection, { limit = 1000, after = '', descending = false, filters = {}, searchTerms = [] } = {}) {
    return [...this.docs.entries()].filter(([key]) => key.startsWith(`${collection}/`))
      .map(([key, value]) => ({ ...structuredClone(value), _id: key.slice(collection.length + 1) }))
      .filter(row => Object.entries(filters).every(([k, v]) => row[k] === v))
      .filter(row => searchTerms.every(term => (row.searchText || '').includes(term)))
      .sort((a, b) => descending ? b._id.localeCompare(a._id) : a._id.localeCompare(b._id))
      .filter(row => !after || (descending ? row._id < after : row._id > after)).slice(0, limit);
  }
  async transaction(fn) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    const tx = new MemoryStore();
    tx.docs = structuredClone(this.docs);
    try {
      const result = await fn(tx);
      this.docs = tx.docs;
      return result;
    } finally { release(); }
  }
}

const NOW = Date.parse('2026-09-12T09:02:00+08:00');
const LIMITS = { dailyCalls: 50, dailyMicroUsd: 500000, roundCalls: 17, validationCalls: 20, validationMicroUsd: 200000 };
const PRICE = { microUsd: 10000, verifiedAt: NOW - 1000, expiresAt: NOW + 3600000, source: 'https://tikhub.io/xiaohongshu-api' };

async function prepared() {
  const store = new MemoryStore();
  for (const hour of ['0900', '1200', '2000']) {
    await store.put('dfp_rounds', `20260912-${hour}`, { status: 'running', calls: 0, microUsd: 0, day: '2026-09-12' });
  }
  return store;
}

module.exports = { MemoryStore, NOW, LIMITS, PRICE, prepared };
