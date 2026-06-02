const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadStoreAt(filePath) {
  process.env.STORE_FILE = filePath;
  const modPath = path.join(__dirname, '..', 'src', 'store.js');
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

test('store persists to disk and hydrates status normalization', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-store-'));
  const storePath = path.join(tmpDir, 'store.json');

  const storeA = loadStoreAt(storePath);
  const firstMatch = storeA.values('matches')[0];
  assert.ok(firstMatch, 'expected seeded match');

  // Simulate legacy status value and force flush.
  storeA.update('matches', firstMatch.id, { status: 'active' });
  storeA.persistNow();
  assert.ok(fs.existsSync(storePath), 'expected persisted file');

  const storeB = loadStoreAt(storePath);
  const hydrated = storeB.getMatch(firstMatch.id);
  assert.equal(hydrated.status, 'in_progress');
});
