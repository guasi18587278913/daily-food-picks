'use strict';
// Operator-only tool. Default is a read-only preview; --apply is required for an authorized registration.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const cloudbase = require('@cloudbase/node-sdk');
const { CloudStore } = require('../cloudfunctions/collectTick/lib/store');
const { registerLinks } = require('../cloudfunctions/catalog/lib/navigation-registry');
const ENV_ID = require('../config/cloudbaserc.example.json').envId;
async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--input');
  if (index < 0 || !args[index + 1] || args.some((arg, i) => arg !== '--input' && arg !== '--apply' && i !== index + 1)) throw new Error('EXPECTED_PRIVATE_INPUT_FILE');
  const bytes = fs.readFileSync(args[index + 1]);
  if (bytes.length > 40000) throw new Error('SOURCE_INPUT_TOO_LARGE');
  const input = JSON.parse(bytes.toString('utf8'));
  if (!input || !Array.isArray(input.entries) || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 0 || Object.keys(input).some(k => !['entries','expectedRevision'].includes(k))) throw new Error('SOURCE_INPUT_INVALID');
  const output = execFileSync('tcb', ['secrets','get','-e',ENV_ID,'--json','--yes'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 25000 });
  const credential = JSON.parse(output.slice(output.indexOf('{'))).data;
  const app = cloudbase.init({ env: ENV_ID, region: 'ap-shanghai', secretId: credential.secretId,
    secretKey: credential.secretKey, sessionToken: credential.token });
  const result = await registerLinks(new CloudStore(app.database()), { ...input, apply: args.includes('--apply') });
  console.log(JSON.stringify({ environment: ENV_ID, ...result }));
}
if (require.main === module) main().catch(e => {
  console.error(JSON.stringify({ error: /^[A-Z_]{1,80}$/.test(e.message || '') ? e.message : 'SOURCE_LINK_OPERATION_FAILED' }));
  process.exitCode = 1;
});
module.exports = { main };
