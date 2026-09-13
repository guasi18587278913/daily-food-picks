'use strict';
const { randomUUID } = require('node:crypto');

const ACTIONS = Object.freeze(['redeem', 'suspend', 'restore', 'setRole', 'createInvite', 'revokeInvite', 'migrate']);

/**
 * Records one access-changing operation for later review. Never used for business decisions.
 *
 * A write failure must not reverse an operation that already succeeded, so it is reported and swallowed —
 * but the whole entry is logged, so the record can be rebuilt from the function log if the write was lost.
 * @param {{put:Function}} store
 * @param {{actor:string,action:string,target?:string|null,result?:string,at:number}} entry
 */
async function audit(store, { actor, action, target = null, result = 'ok', at }) {
  if (!ACTIONS.includes(action)) {
    console.error(`audit refused an unknown action: ${action}`);
    return false;
  }
  const entry = { at: new Date(at).toISOString(), actor, action, target, result };
  // The id keeps documents in time order while staying inside the character set every existing
  // collection already uses: digits, letters and underscore only. A timestamp string would introduce
  // ':' and '.' as document-id characters, which nothing in this project has verified against the platform.
  const id = `${String(at).padStart(13, '0')}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  try {
    await store.put('dfp_access_log', id, entry);
    return true;
  } catch (error) {
    console.error(`audit write failed: ${JSON.stringify(entry)} reason=${error && error.message}`);
    return false;
  }
}

module.exports = { audit, ACTIONS };
