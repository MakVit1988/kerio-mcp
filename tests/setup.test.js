const fs = require('fs');
const os = require('os');
const path = require('path');
const setup = require('../installer/setup');

let tmp;
let appSource;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kerio-setup-'));
  appSource = path.join(tmp, 'pkg', 'app');
  fs.mkdirSync(path.join(appSource, 'installer'), { recursive: true });
  fs.writeFileSync(path.join(appSource, 'server.js'), '// server');
  fs.writeFileSync(path.join(appSource, 'installer', 'uninstall.bat'), '@echo off');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('helpers', () => {
  test('parseArgs reads options and rejects unknown ones', () => {
    const o = setup.parseArgs(['--yes', '--email', 'a@b.c', '--host', 'h', '--install-dir', 'D', '--files-dir', 'F', '--claude-config', 'c1', '--claude-config', 'c2', '--skip-login-check']);
    expect(o).toMatchObject({ yes: true, email: 'a@b.c', host: 'h', installDir: 'D', filesDir: 'F', claudeConfigs: ['c1', 'c2'], skipLoginCheck: true });
    expect(() => setup.parseArgs(['--nope'])).toThrow(/Unknown option/);
    expect(() => setup.parseArgs(['--email'])).toThrow(/needs a value/);
  });

  test.each([
    ['https://Mail.Example.com/webmail/', 'mail.example.com'],
    ['  mail.example.com  ', 'mail.example.com'],
    ['mail.example.com:8443', 'mail.example.com:8443']
  ])('normalizeHost(%s)', (input, expected) => expect(setup.normalizeHost(input)).toBe(expected));

  test('normalizeHost rejects garbage', () => {
    expect(() => setup.normalizeHost('')).toThrow(/Invalid/);
    expect(() => setup.normalizeHost('a b')).toThrow(/Invalid/);
  });

  test('isEmail', () => {
    expect(setup.isEmail('ivan@example.com')).toBe(true);
    expect(setup.isEmail('ivan@example')).toBe(false);
    expect(setup.isEmail('')).toBe(false);
  });

  test('Windows config paths include the classic and the Store location', () => {
    const local = path.join(tmp, 'Local');
    fs.mkdirSync(path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true });
    fs.mkdirSync(path.join(local, 'Packages', 'Other_abc'), { recursive: true });
    const paths = setup.claudeDesktopConfigPaths({ env: { APPDATA: path.join(tmp, 'Roaming'), LOCALAPPDATA: local }, platform: 'win32', home: tmp });
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(path.join(tmp, 'Roaming', 'Claude', 'claude_desktop_config.json'));
    expect(paths[1]).toContain(path.join('Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude'));
  });

  test('pickDesktopConfigs prefers existing Claude folders, else the first path', () => {
    const a = path.join(tmp, 'a', 'cfg.json');
    const b = path.join(tmp, 'b', 'cfg.json');
    fs.mkdirSync(path.dirname(b));
    expect(setup.pickDesktopConfigs([a, b])).toEqual([b]);
    fs.rmSync(path.dirname(b), { recursive: true });
    expect(setup.pickDesktopConfigs([a, b])).toEqual([a]);
  });
});

describe('Claude Desktop config', () => {
  const entry = { nodeExe: 'C:\\k\\node\\node.exe', serverJs: 'C:\\k\\app\\server.js' };

  test('creates the file when missing', () => {
    const file = path.join(tmp, 'Claude', 'claude_desktop_config.json');
    setup.registerInDesktopConfig(file, entry);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mcpServers: { 'kerio-mail': { command: entry.nodeExe, args: [entry.serverJs] } } });
  });

  test('keeps other settings and servers, makes a backup, replaces our own entry', () => {
    const file = path.join(tmp, 'cfg.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x', args: ['1'] }, 'kerio-mail': { command: 'old' } } }));
    setup.registerInDesktopConfig(file, entry);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.theme).toBe('dark');
    expect(data.mcpServers.other).toEqual({ command: 'x', args: ['1'] });
    expect(data.mcpServers['kerio-mail'].command).toBe(entry.nodeExe);
    expect(fs.readdirSync(tmp).filter(n => n.startsWith('cfg.json.bak-'))).toHaveLength(1);
  });

  test('refuses to touch a file with broken JSON', () => {
    const file = path.join(tmp, 'cfg.json');
    fs.writeFileSync(file, '{ not json');
    expect(() => setup.registerInDesktopConfig(file, entry)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });

  test('unregister removes only our entry', () => {
    const file = path.join(tmp, 'cfg.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' }, 'kerio-mail': { command: 'y' } } }));
    expect(setup.unregisterFromDesktopConfig(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers).toEqual({ other: { command: 'x' } });
    expect(setup.unregisterFromDesktopConfig(file)).toBe(false);
    expect(setup.unregisterFromDesktopConfig(path.join(tmp, 'missing.json'))).toBe(false);
  });
});

describe('Claude Code', () => {
  const entry = { nodeExe: '/n/node', serverJs: '/n/app/server.js' };

  test('reports when the claude command is missing', () => {
    const run = jest.fn(() => ({ status: null, error: new Error('ENOENT'), output: '' }));
    expect(setup.registerInClaudeCode(entry, run)).toMatchObject({ registered: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('replaces the user-scope entry', () => {
    const run = jest.fn(() => ({ status: 0, output: '' }));
    expect(setup.registerInClaudeCode(entry, run)).toEqual({ registered: true });
    expect(run.mock.calls.map(c => c[0].join(' '))).toEqual([
      '--version',
      'mcp remove kerio-mail --scope user',
      'mcp add kerio-mail --scope user -- /n/node /n/app/server.js'
    ]);
  });

  test('reports a failure of claude mcp add', () => {
    const run = jest.fn(args => (args[1] === 'add' ? { status: 1, output: 'boom' } : { status: 0, output: '' }));
    expect(setup.registerInClaudeCode(entry, run)).toEqual({ registered: false, reason: 'boom' });
  });
});

describe('install and uninstall', () => {
  const base = () => ({
    host: 'https://Mail.Example.com/', user: 'u@example.com', password: 'p"a#ss\\n',
    installDir: path.join(tmp, 'Install'), filesDir: path.join(tmp, 'Files')
  });
  const deps = (extra = {}) => ({
    appSource,
    desktopConfigs: [path.join(tmp, 'Claude', 'claude_desktop_config.json')],
    checkLogin: jest.fn(async () => {}),
    claudeCode: jest.fn(() => ({ registered: true })),
    ...extra
  });

  test('copies the app and node, writes protected settings, registers everywhere', async () => {
    const d = deps();
    const r = await setup.install(base(), d);
    expect(d.checkLogin).toHaveBeenCalledWith('mail.example.com', 'u@example.com', 'p"a#ss\\n');
    expect(fs.readFileSync(path.join(r.appDir, 'server.js'), 'utf8')).toBe('// server');
    expect(fs.existsSync(r.nodeExe)).toBe(true);
    expect(fs.existsSync(path.join(r.installDir, 'uninstall.bat'))).toBe(true);
    expect(fs.statSync(r.filesDir).isDirectory()).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(r.appDir, 'config.json'), 'utf8'));
    expect(cfg).toEqual({ host: 'mail.example.com', user: 'u@example.com', password: 'p"a#ss\\n', filesDir: r.filesDir });
    if (process.platform !== 'win32') expect(fs.statSync(path.join(r.appDir, 'config.json')).mode & 0o777).toBe(0o600);
    const desktop = JSON.parse(fs.readFileSync(d.desktopConfigs[0], 'utf8'));
    expect(desktop.mcpServers['kerio-mail']).toEqual({ command: r.nodeExe, args: [r.serverJs] });
    expect(JSON.stringify(desktop)).not.toContain('p"a#ss');
    expect(d.claudeCode).toHaveBeenCalledWith({ nodeExe: r.nodeExe, serverJs: r.serverJs });
    expect(r.claudeCode.registered).toBe(true);
  });

  test('a failed login changes nothing', async () => {
    const d = deps({ checkLogin: jest.fn(async () => { throw new Error('bad password'); }) });
    await expect(setup.install(base(), d)).rejects.toThrow(/bad password/);
    expect(fs.existsSync(base().installDir)).toBe(false);
    expect(fs.existsSync(d.desktopConfigs[0])).toBe(false);
  });

  test('installing again replaces the app and keeps one entry', async () => {
    await setup.install(base(), deps());
    const second = await setup.install({ ...base(), password: 'new' }, deps());
    expect(JSON.parse(fs.readFileSync(path.join(second.appDir, 'config.json'), 'utf8')).password).toBe('new');
  });

  test('uninstall removes registrations and the folder but keeps the files folder', async () => {
    const d = deps();
    const r = await setup.install(base(), d);
    fs.writeFileSync(path.join(r.filesDir, 'keep.txt'), 'x');
    const removed = setup.uninstall({ installDir: r.installDir }, { desktopConfigs: d.desktopConfigs, claudeCodeRemove: () => true });
    expect(removed.removedFrom).toEqual(d.desktopConfigs);
    expect(removed.codeRemoved).toBe(true);
    expect(fs.existsSync(r.installDir)).toBe(false);
    expect(fs.existsSync(path.join(r.filesDir, 'keep.txt'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(d.desktopConfigs[0], 'utf8')).mcpServers).toEqual({});
  });

  test('uninstall refuses a folder that is not an installation', () => {
    const other = path.join(tmp, 'Documents');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'important.txt'), 'x');
    expect(() => setup.uninstall({ installDir: other }, { desktopConfigs: [], claudeCodeRemove: () => false })).toThrow(/не найдена установка/);
    expect(fs.existsSync(path.join(other, 'important.txt'))).toBe(true);
  });
});

describe('finding the Claude Desktop config on unusual layouts', () => {
  const win = { platform: 'win32' };
  let env;
  beforeEach(() => {
    env = { APPDATA: path.join(tmp, 'Roaming'), LOCALAPPDATA: path.join(tmp, 'Local') };
  });

  test('finds the file in Claude-Data\\<package> and updates only that one', () => {
    const real = path.join(env.LOCALAPPDATA, 'Claude-Data', 'claude_pzs8sxrjxfjjc', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, JSON.stringify({ preferences: { a: 1 } }));
    fs.mkdirSync(path.join(env.APPDATA, 'Claude'), { recursive: true }); // classic folder without a config
    expect(setup.discoverDesktopConfigs({ env, home: tmp, ...win })).toEqual([real]);
  });

  test('registering keeps the existing preferences', () => {
    const real = path.join(env.LOCALAPPDATA, 'Claude-Data', 'pkg', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, JSON.stringify({ coworkUserFilesPath: 'C:\\Users\\u\\Claude', preferences: { sidebarMode: 'x' } }));
    const [file] = setup.discoverDesktopConfigs({ env, home: tmp, ...win });
    setup.registerInDesktopConfig(file, { nodeExe: 'C:\\k\\node.exe', serverJs: 'C:\\k\\server.js' });
    const data = JSON.parse(fs.readFileSync(real, 'utf8'));
    expect(data.preferences).toEqual({ sidebarMode: 'x' });
    expect(data.coworkUserFilesPath).toBe('C:\\Users\\u\\Claude');
    expect(data.mcpServers['kerio-mail'].command).toBe('C:\\k\\node.exe');
  });

  test('finds several copies (classic and relocated) and updates all', () => {
    const a = path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json');
    const b = path.join(env.LOCALAPPDATA, 'Claude-Data', 'pkg', 'claude_desktop_config.json');
    for (const f of [a, b]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{}'); }
    expect(setup.discoverDesktopConfigs({ env, home: tmp, ...win }).sort()).toEqual([a, b].sort());
  });

  test('without any config it falls back to the classic location', () => {
    fs.mkdirSync(path.join(env.APPDATA, 'Claude'), { recursive: true });
    expect(setup.discoverDesktopConfigs({ env, home: tmp, ...win })).toEqual([path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json')]);
  });

  test('the scan ignores cache folders and gives up beyond the depth limit', () => {
    const cache = path.join(tmp, 'root', 'Cache', 'claude_desktop_config.json');
    const deep = path.join(tmp, 'root', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'claude_desktop_config.json');
    const ok = path.join(tmp, 'root', 'a', 'claude_desktop_config.json');
    for (const f of [cache, deep, ok]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{}'); }
    expect(setup.scanForDesktopConfigs([path.join(tmp, 'root')])).toEqual([ok]);
  });

  test('claudeDataRoots lists only Claude folders and does nothing outside Windows', () => {
    fs.mkdirSync(path.join(env.LOCALAPPDATA, 'Claude-Data'), { recursive: true });
    fs.mkdirSync(path.join(env.LOCALAPPDATA, 'Other'), { recursive: true });
    fs.mkdirSync(path.join(env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true });
    const roots = setup.claudeDataRoots({ env, home: tmp, ...win }).map(r => path.basename(r)).sort();
    expect(roots).toEqual(['Claude-Data', 'Claude_pzs8sxrjxfjjc']);
    expect(setup.claudeDataRoots({ env, home: tmp, platform: 'linux' })).toEqual([]);
  });
});

test('installing from a repository checkout leaves out tests, dist and git data', async () => {
  for (const dir of ['tests', 'dist', '.git', '.github', 'src']) {
    fs.mkdirSync(path.join(appSource, dir), { recursive: true });
    fs.writeFileSync(path.join(appSource, dir, 'x.txt'), 'x');
  }
  const r = await setup.install(
    { host: 'mail.example.com', user: 'u@example.com', password: 'p', installDir: path.join(tmp, 'I'), filesDir: path.join(tmp, 'F') },
    { appSource, desktopConfigs: [path.join(tmp, 'c.json')], checkLogin: async () => {}, claudeCode: () => ({ registered: false, reason: 'x' }) }
  );
  expect(fs.readdirSync(r.appDir).sort()).toEqual(['config.json', 'installer', 'server.js', 'src']);
});

describe('uninstall when the folder cannot be deleted', () => {
  const settings = () => ({
    host: 'mail.example.com', user: 'u@example.com', password: 'p',
    installDir: path.join(tmp, 'Inst'), filesDir: path.join(tmp, 'Files')
  });
  const deps = () => ({
    appSource, desktopConfigs: [path.join(tmp, 'Claude', 'claude_desktop_config.json')],
    checkLogin: async () => {}, claudeCode: () => ({ registered: false, reason: 'x' })
  });

  test('explains what to do, and the Claude entries are already gone', async () => {
    const d = deps();
    const r = await setup.install(settings(), d);
    const rm = jest.spyOn(fs, 'rmSync').mockImplementation(() => { const e = new Error('denied'); e.code = 'EPERM'; throw e; });
    let caught;
    try {
      setup.uninstall({ installDir: r.installDir }, { desktopConfigs: d.desktopConfigs, claudeCodeRemove: () => true });
    } catch (error) { caught = error; }
    rm.mockRestore();
    expect(caught.message).toMatch(/Настройки Claude уже очищены/);
    expect(caught.message).toMatch(/Выход/);
    expect(caught.code).toBe('EPERM');
    expect(JSON.parse(fs.readFileSync(d.desktopConfigs[0], 'utf8')).mcpServers).toEqual({});
    expect(fs.existsSync(r.installDir)).toBe(true);
  });

  test('a second run finishes the job on a half-removed folder', async () => {
    const d = deps();
    const r = await setup.install(settings(), d);
    fs.rmSync(path.join(r.installDir, 'app'), { recursive: true }); // what is left after a failed attempt
    const result = setup.uninstall({ installDir: r.installDir }, { desktopConfigs: d.desktopConfigs, claudeCodeRemove: () => false });
    expect(result.installDir).toBe(r.installDir);
    expect(fs.existsSync(r.installDir)).toBe(false);
  });

  test('leaves the process outside the install folder before deleting it', async () => {
    const d = deps();
    const r = await setup.install(settings(), d);
    const before = process.cwd();
    process.chdir(r.installDir);
    try {
      setup.uninstall({ installDir: r.installDir }, { desktopConfigs: d.desktopConfigs, claudeCodeRemove: () => false });
      expect(fs.realpathSync(process.cwd())).not.toBe(fs.realpathSync(path.dirname(r.installDir)) + path.sep + 'Inst');
    } finally {
      process.chdir(before);
    }
    expect(fs.existsSync(r.installDir)).toBe(false);
  });
});
