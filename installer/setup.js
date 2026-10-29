#!/usr/bin/env node
/**
 * Interactive installer / uninstaller for kerio-mcp (written for Windows, runs anywhere).
 *
 * Asks for the e-mail, the password, the install folder and the files folder, then
 *   1. checks that the login works,
 *   2. copies the server and a private copy of node.exe into the install folder,
 *   3. stores the settings in <install>/app/config.json (readable only by the current user),
 *   4. registers the server in Claude Desktop and in Claude Code.
 *
 * Unattended use: --yes --email you@example.com --host mail.example.com
 *                 --install-dir <dir> --files-dir <dir>   (password in KERIO_SETUP_PASSWORD)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const readline = require('readline');

const SERVER_NAME = 'kerio-mail';
const isWindows = process.platform === 'win32';

// ---- small helpers --------------------------------------------------------

function parseArgs(argv) {
  const opts = { claudeConfigs: [], yes: false, uninstall: false, skipLoginCheck: false, skipClaudeCode: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`Option ${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--yes': opts.yes = true; break;
      case '--uninstall': opts.uninstall = true; break;
      case '--skip-login-check': opts.skipLoginCheck = true; break;
      case '--skip-claude-code': opts.skipClaudeCode = true; break;
      case '--email': opts.email = value(); break;
      case '--host': opts.host = value(); break;
      case '--install-dir': opts.installDir = value(); break;
      case '--files-dir': opts.filesDir = value(); break;
      case '--claude-config': opts.claudeConfigs.push(value()); break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

/** "https://Mail.Example.com/webmail/" -> "mail.example.com" */
function normalizeHost(input) {
  const host = String(input || '').trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
  if (!host || /\s/.test(host) || !/^[a-z0-9.-]+(:\d+)?$/.test(host)) {
    throw new Error(`Invalid server address: ${input}`);
  }
  return host;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function defaultInstallDir(env = process.env, home = os.homedir()) {
  return path.join(env.LOCALAPPDATA || path.join(home, '.local', 'share'), 'kerio-mcp');
}

function defaultFilesDir(home = os.homedir()) {
  return path.join(home, 'Documents', 'kerio-mcp-files');
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error.message}). Fix or remove it and run the installer again.`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---- Claude Desktop ---------------------------------------------------------

/**
 * Possible locations of claude_desktop_config.json. The Microsoft Store build of Claude
 * keeps it inside its package folder, the classic installer in %APPDATA%.
 */
function claudeDesktopConfigPaths({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const paths = [path.join(appData, 'Claude', 'claude_desktop_config.json')];
    const packages = path.join(local, 'Packages');
    if (fs.existsSync(packages)) {
      for (const name of fs.readdirSync(packages)) {
        if (/^Claude_/i.test(name)) {
          paths.push(path.join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
        }
      }
    }
    return paths;
  }
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')];
  }
  return [path.join(home, '.config', 'Claude', 'claude_desktop_config.json')];
}

const SKIP_DIRS = /^(cache|code cache|gpucache|dawncache|local storage|indexeddb|service worker|blob_storage|session storage|node_modules|logs|crashpad|shared dictionary|network)$/i;

/**
 * Finds claude_desktop_config.json files below the given folders (a few levels deep).
 * Newer Claude Desktop builds keep their data outside the usual folders, for example in
 * %LOCALAPPDATA%\\Claude-Data\\<package>, so the fixed locations are not enough.
 */
function scanForDesktopConfigs(roots, { maxDepth = 6, maxEntries = 20000 } = {}) {
  const found = [];
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || seen > maxEntries) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      seen++;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'claude_desktop_config.json') found.push(full);
      else if (entry.isDirectory() && !SKIP_DIRS.test(entry.name)) walk(full, depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return found;
}

/** Folders worth scanning on Windows: everything called Claude* in AppData and in the Store packages. */
function claudeDataRoots({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== 'win32') return [];
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roots = [];
  for (const base of [appData, local, path.join(local, 'Packages')]) {
    try {
      for (const name of fs.readdirSync(base)) if (/^claude/i.test(name)) roots.push(path.join(base, name));
    } catch (e) { /* folder does not exist */ }
  }
  return roots;
}

/**
 * The configs to change: every existing claude_desktop_config.json that was found; otherwise
 * the known locations whose Claude folder exists; otherwise the first known location.
 */
function pickDesktopConfigs(candidates, scanned = []) {
  const existing = [...new Set([...candidates, ...scanned])].filter(file => fs.existsSync(file));
  if (existing.length) return existing;
  const present = candidates.filter(file => fs.existsSync(path.dirname(file)));
  return present.length ? present : candidates.slice(0, 1);
}

/** What the installer uses on a real system. */
function discoverDesktopConfigs(opts = {}) {
  return pickDesktopConfigs(claudeDesktopConfigPaths(opts), scanForDesktopConfigs(claudeDataRoots(opts)));
}

function registerInDesktopConfig(file, { nodeExe, serverJs }) {
  const config = readJson(file);
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
  config.mcpServers[SERVER_NAME] = { command: nodeExe, args: [serverJs] };
  writeJson(file, config);
}

/** Returns true when an entry was removed. */
function unregisterFromDesktopConfig(file) {
  if (!fs.existsSync(file)) return false;
  const config = readJson(file);
  if (!config.mcpServers || !(SERVER_NAME in config.mcpServers)) return false;
  fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  delete config.mcpServers[SERVER_NAME];
  writeJson(file, config);
  return true;
}

// ---- Claude Code --------------------------------------------------------------

const quote = text => (/[\s"&|<>^()]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** Runs the `claude` command; on Windows it is a .cmd shim, so it goes through the shell. */
function runClaude(args) {
  const result = isWindows
    ? cp.spawnSync(`claude ${args.map(quote).join(' ')}`, { shell: true, encoding: 'utf8' })
    : cp.spawnSync('claude', args, { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.trim(), error: result.error };
}

function registerInClaudeCode({ nodeExe, serverJs }, run = runClaude) {
  const probe = run(['--version']);
  if (probe.error || probe.status !== 0) return { registered: false, reason: 'Claude Code (command "claude") not found' };
  run(['mcp', 'remove', SERVER_NAME, '--scope', 'user']); // ignore: the entry may not exist yet
  const added = run(['mcp', 'add', SERVER_NAME, '--scope', 'user', '--', nodeExe, serverJs]);
  if (added.status !== 0) return { registered: false, reason: added.output || 'claude mcp add failed' };
  return { registered: true };
}

function unregisterFromClaudeCode(run = runClaude) {
  const probe = run(['--version']);
  if (probe.error || probe.status !== 0) return false;
  return run(['mcp', 'remove', SERVER_NAME, '--scope', 'user']).status === 0;
}

// ---- files ----------------------------------------------------------------------

/** Makes the file readable and writable only by the current user. */
function protectFile(file) {
  if (isWindows) {
    const user = process.env.USERNAME;
    if (!user) return false;
    const result = cp.spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:(R,W)`], { encoding: 'utf8' });
    return result.status === 0;
  }
  fs.chmodSync(file, 0o600);
  return true;
}

function copyApp(source, destination) {
  if (path.resolve(source) === path.resolve(destination)) return;
  fs.rmSync(destination, { recursive: true, force: true });
  // When installing from a repository checkout, leave out what the running server does not need.
  const skip = new Set(['.git', '.github', 'tests', 'dist', 'coverage']);
  fs.cpSync(source, destination, {
    recursive: true,
    filter: file => !skip.has(path.relative(source, file).split(path.sep)[0])
  });
}

function copyNode(installDir) {
  const target = path.join(installDir, 'node', isWindows ? 'node.exe' : 'node');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (path.resolve(process.execPath) !== path.resolve(target)) {
    fs.copyFileSync(process.execPath, target);
    if (!isWindows) fs.chmodSync(target, 0o755);
  }
  return target;
}

// ---- install ------------------------------------------------------------------------

async function checkLoginDefault(host, user, password) {
  const { KerioClient } = require('../src/kerio-client');
  const client = new KerioClient({ host, user, password, timeoutMs: 20000 });
  await client.login();
  await client.logout();
}

/**
 * Performs the installation. Everything environment-specific can be replaced through `deps`
 * so tests do not touch the real system.
 */
async function install(settings, deps = {}) {
  const {
    log = () => {},
    checkLogin = checkLoginDefault,
    appSource = path.resolve(__dirname, '..'),
    desktopConfigs = discoverDesktopConfigs(),
    claudeCode = registerInClaudeCode,
    withNode = true
  } = deps;

  const host = normalizeHost(settings.host);
  const { user, password } = settings;
  const installDir = path.resolve(settings.installDir);
  const filesDir = path.resolve(settings.filesDir);
  const appDir = path.join(installDir, 'app');
  const serverJs = path.join(appDir, 'server.js');

  if (!settings.skipLoginCheck) {
    log('Проверяю вход в почту...');
    await checkLogin(host, user, password);
  }

  log(`Копирую программу в ${installDir} ...`);
  fs.mkdirSync(installDir, { recursive: true });
  try {
    copyApp(appSource, appDir);
  } catch (error) {
    if (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES') {
      throw new Error('Не удаётся заменить файлы: закройте Claude Desktop полностью (в том числе в трее) и запустите установку снова.');
    }
    throw error;
  }
  const nodeExe = withNode ? copyNode(installDir) : process.execPath;

  const configFile = path.join(appDir, 'config.json');
  writeJson(configFile, { host, user, password, filesDir });
  const protectedOk = protectFile(configFile);

  fs.mkdirSync(filesDir, { recursive: true });
  const uninstallBat = path.join(appSource, 'installer', 'uninstall.bat');
  if (fs.existsSync(uninstallBat)) fs.copyFileSync(uninstallBat, path.join(installDir, 'uninstall.bat'));

  const registeredDesktop = [];
  for (const file of desktopConfigs) {
    registerInDesktopConfig(file, { nodeExe, serverJs });
    registeredDesktop.push(file);
  }
  const code = settings.skipClaudeCode ? { registered: false, reason: 'пропущено' } : claudeCode({ nodeExe, serverJs });

  return { installDir, appDir, nodeExe, serverJs, filesDir, host, configProtected: protectedOk, desktop: registeredDesktop, claudeCode: code };
}

/** Removes the registrations and the install folder. The files folder is kept. */
function uninstall({ installDir }, deps = {}) {
  const {
    desktopConfigs = [...new Set([...claudeDesktopConfigPaths(), ...scanForDesktopConfigs(claudeDataRoots())])].filter(file => fs.existsSync(file)),
    claudeCodeRemove = unregisterFromClaudeCode
  } = deps;
  const dir = path.resolve(installDir);
  if (!fs.existsSync(path.join(dir, 'app', 'server.js'))) {
    throw new Error(`В ${dir} не найдена установка kerio-mcp, ничего не удалено.`);
  }
  const removedFrom = desktopConfigs.filter(file => unregisterFromDesktopConfig(file));
  const codeRemoved = claudeCodeRemove();
  fs.rmSync(dir, { recursive: true, force: true });
  return { removedFrom, codeRemoved, installDir: dir };
}

// ---- console interaction ------------------------------------------------------------------

function ask(question, fallback) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `, answer => {
      rl.close();
      resolve(answer.trim() || fallback || '');
    });
  });
}

/** Reads a line without echoing it. */
function askHidden(question) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      ask(question).then(resolve);
      return;
    }
    process.stdout.write(`${question}: `);
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

function loadDefaults() {
  const file = path.join(__dirname, 'defaults.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    return {};
  }
}

async function interactiveSettings(defaults) {
  const settings = {};
  console.log('Подключение почты Kerio к Claude (Desktop и Code)\n');
  for (let attempt = 1; ; attempt++) {
    settings.host = defaults.host || (await ask('Адрес почтового сервера (как в браузере для WebMail, например mail.example.com)'));
    settings.user = await ask('Ваша почта (например, ivan@example.com)');
    if (!isEmail(settings.user)) { console.log('Это не похоже на адрес почты, попробуйте ещё раз.\n'); continue; }
    settings.password = await askHidden('Пароль от почты (при вводе не отображается)');
    if (!settings.password) { console.log('Пароль не введён.\n'); continue; }
    try {
      console.log('Проверяю вход в почту...');
      await checkLoginDefault(normalizeHost(settings.host), settings.user, settings.password);
      console.log('Вход выполнен.\n');
      break;
    } catch (error) {
      console.log(`Не удалось войти: ${error.message}`);
      if (attempt >= 3) throw new Error('Три неудачные попытки. Проверьте адрес сервера, почту и пароль (если включена двухфакторная защита, нужен пароль приложения).');
      console.log('Попробуйте ещё раз.\n');
    }
  }
  settings.installDir = await ask('Папка для установки', defaultInstallDir());
  settings.filesDir = await ask('Папка для файлов (сюда скачиваются вложения, отсюда берутся файлы для отправки)', defaultFilesDir());
  settings.skipLoginCheck = true; // already checked above
  return settings;
}

function printResult(result) {
  console.log('\nГотово.\n');
  console.log(`Программа:   ${result.installDir}`);
  console.log(`Файлы:       ${result.filesDir}`);
  console.log(`Сервер:      ${result.host}`);
  if (!result.configProtected) console.log('Внимание: не удалось ограничить доступ к файлу с паролем (config.json).');
  for (const file of result.desktop) console.log(`Claude Desktop: настроен (${file})`);
  console.log(result.claudeCode.registered
    ? 'Claude Code:    настроен'
    : `Claude Code:    не настроен (${result.claudeCode.reason})`);
  console.log('\nДальше:');
  console.log('  1. Полностью закройте Claude Desktop (в том числе в трее) и откройте его снова.');
  console.log('  2. Для Claude Code откройте новую сессию командой "claude".');
  console.log('  3. Спросите, например: "покажи непрочитанные письма".');
  console.log('\nУдалить: запустите uninstall.bat из папки установки.');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.uninstall) {
    const installDir = opts.installDir || defaultInstallDir();
    if (!opts.yes) {
      const answer = await ask(`Удалить kerio-mcp из ${installDir} и убрать из Claude? Папка с файлами останется (да/нет)`, 'нет');
      if (!/^(д|да|y|yes)$/i.test(answer)) { console.log('Отменено.'); return; }
    }
    const deps = opts.claudeConfigs.length ? { desktopConfigs: opts.claudeConfigs } : {};
    const result = uninstall({ installDir }, deps);
    console.log(`Удалено. Настройки Claude Desktop очищены: ${result.removedFrom.length}; Claude Code: ${result.codeRemoved ? 'очищен' : 'не менялся'}.`);
    return;
  }

  const defaults = loadDefaults();
  let settings;
  if (opts.yes) {
    const password = process.env.KERIO_SETUP_PASSWORD;
    if (!opts.email || !password) throw new Error('Для --yes нужны --email и переменная KERIO_SETUP_PASSWORD');
    settings = {
      host: opts.host || defaults.host,
      user: opts.email,
      password,
      installDir: opts.installDir || defaultInstallDir(),
      filesDir: opts.filesDir || defaultFilesDir(),
      skipLoginCheck: opts.skipLoginCheck,
      skipClaudeCode: opts.skipClaudeCode
    };
  } else {
    settings = await interactiveSettings(defaults);
    settings.skipClaudeCode = opts.skipClaudeCode;
  }
  const deps = { log: message => console.log(message) };
  if (opts.claudeConfigs.length) deps.desktopConfigs = opts.claudeConfigs;
  printResult(await install(settings, deps));
}

module.exports = {
  parseArgs, normalizeHost, isEmail, defaultInstallDir, defaultFilesDir, claudeDesktopConfigPaths,
  pickDesktopConfigs, scanForDesktopConfigs, claudeDataRoots, discoverDesktopConfigs, registerInDesktopConfig, unregisterFromDesktopConfig, registerInClaudeCode,
  unregisterFromClaudeCode, protectFile, install, uninstall, SERVER_NAME
};

if (require.main === module) {
  main().then(
    () => process.exit(0),
    error => { console.error(`\nОшибка: ${error.message}`); process.exit(1); }
  );
}
