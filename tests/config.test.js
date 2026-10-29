const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfigFile } = require('../src/config');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kerio-config-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('does nothing when there is no config.json', () => {
  const env = {};
  expect(loadConfigFile(dir, env)).toEqual([]);
  expect(env).toEqual({});
});

test('fills missing variables from config.json', () => {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: 'h', user: 'u', password: 'p#"\\n', filesDir: 'C:\\files', maxFileMb: 10 }));
  const env = {};
  loadConfigFile(dir, env);
  expect(env).toEqual({ KERIO_HOST: 'h', KERIO_USER: 'u', KERIO_PASSWORD: 'p#"\\n', KERIO_FILES_DIR: 'C:\\files', KERIO_MAX_FILE_MB: '10' });
});

test('environment variables win over the file', () => {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: 'file-host', user: 'file-user' }));
  const env = { KERIO_HOST: 'env-host' };
  loadConfigFile(dir, env);
  expect(env.KERIO_HOST).toBe('env-host');
  expect(env.KERIO_USER).toBe('file-user');
});

test('accepts a file with a BOM and rejects broken JSON', () => {
  fs.writeFileSync(path.join(dir, 'config.json'), '\uFEFF{"host":"h"}');
  const env = {};
  loadConfigFile(dir, env);
  expect(env.KERIO_HOST).toBe('h');
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  expect(() => loadConfigFile(dir, {})).toThrow(/Cannot read/);
});
