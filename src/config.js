/**
 * Optional settings file written by the Windows installer (config.json next to server.js).
 * Environment variables always win, so .env files, MCP client settings and tests still work.
 */
const fs = require('fs');
const path = require('path');

const KEYS = {
  host: 'KERIO_HOST',
  user: 'KERIO_USER',
  password: 'KERIO_PASSWORD',
  filesDir: 'KERIO_FILES_DIR',
  maxFileMb: 'KERIO_MAX_FILE_MB'
};

/** Fills missing KERIO_* variables from <dir>/config.json. Returns the names it set. */
function loadConfigFile(dir, env = process.env) {
  const file = path.join(dir, 'config.json');
  if (!fs.existsSync(file)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
  const applied = [];
  for (const [key, variable] of Object.entries(KEYS)) {
    if (data[key] !== undefined && data[key] !== '' && !env[variable]) {
      env[variable] = String(data[key]);
      applied.push(variable);
    }
  }
  return applied;
}

module.exports = { loadConfigFile, KEYS };
