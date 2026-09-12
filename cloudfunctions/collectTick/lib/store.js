'use strict';

const COLLECTIONS = Object.freeze(['dfp_state', 'dfp_budgets', 'dfp_rounds', 'dfp_attempts',
  'dfp_candidates', 'dfp_results', 'dfp_snapshots', 'dfp_parts', 'dfp_notes']);

function validate(collection, id) {
  if (!COLLECTIONS.includes(collection) || typeof id !== 'string' || !id || id.length > 150 || /[/\u0000-\u001f]/.test(id)) throw new Error('INVALID_DOCUMENT_KEY');
}
function clean(value) {
  const result = JSON.parse(JSON.stringify(value));
  delete result._id;
  if (Buffer.byteLength(JSON.stringify(result)) > 184000) throw new Error('DOCUMENT_TOO_LARGE');
  return result;
}
class Operations {
  constructor(source) { this.source = source; }
  async get(collection, id) {
    validate(collection, id);
    const response = await this.source.collection(collection).doc(id).get();
    return Array.isArray(response.data) ? response.data[0] || null : response.data || null;
  }
  async put(collection, id, value) {
    validate(collection, id);
    await this.source.collection(collection).doc(id).set(clean(value));
  }
  async create(collection, id, value) {
    if (await this.get(collection, id)) throw new Error('ALREADY_EXISTS');
    await this.put(collection, id, value);
  }
  async remove(collection, id) {
    validate(collection, id);
    await this.source.collection(collection).doc(id).remove();
  }
}
class CloudStore extends Operations {
  constructor(db) { super(db); this.db = db; }
  async transaction(fn) { return this.db.runTransaction(raw => fn(new Operations(raw))); }
  async create(collection, id, value) { return this.transaction(tx => tx.create(collection, id, value)); }
  async list(collection, { limit = 50, after = '', descending = false, filters = {}, searchTerms = [] } = {}) {
    if (!COLLECTIONS.includes(collection) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_QUERY');
    const where = { ...filters };
    if (after) where._id = descending ? this.db.command.lt(after) : this.db.command.gt(after);
    if (searchTerms.length) {
      const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Literal lookaheads implement all-word matching; input never becomes executable regex.
      where.searchText = this.db.RegExp({ regexp: searchTerms.map(term => `(?=[\\s\\S]*${escape(term)})`).join(''), options: 'i' });
    }
    const response = await this.db.collection(collection).where(where).orderBy('_id', descending ? 'desc' : 'asc').limit(limit).get();
    return response.data || [];
  }
}

module.exports = { CloudStore, COLLECTIONS, clean };
