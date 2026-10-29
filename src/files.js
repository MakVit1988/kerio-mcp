/**
 * File handling for attachments. Everything the server reads or writes lives in one
 * directory (KERIO_FILES_DIR, default ~/kerio-mcp-files). Without this limit a malicious
 * e-mail could talk the AI into attaching or overwriting arbitrary files on the computer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.dwg': 'application/acad',
  '.dxf': 'application/dxf'
};

class FilesError extends Error {}

function createFiles({ dir, maxBytes } = {}) {
  const root = path.resolve(dir || process.env.KERIO_FILES_DIR || path.join(os.homedir(), 'kerio-mcp-files'));
  const limit = maxBytes || (Number(process.env.KERIO_MAX_FILE_MB) || 25) * 1024 * 1024;

  const ensureRoot = () => {
    fs.mkdirSync(root, { recursive: true });
    return fs.realpathSync(root);
  };

  const isInside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

  /** Resolves a user-supplied path inside the files directory or throws. */
  function resolveInside(userPath) {
    const realRoot = ensureRoot();
    const candidate = path.resolve(root, String(userPath || ''));
    if (!isInside(root, candidate)) {
      throw new FilesError(`Path is outside the files directory (${root}): ${userPath}`);
    }
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch (e) {
      throw new FilesError(`File not found in ${root}: ${userPath}`);
    }
    if (!isInside(realRoot, real)) {
      throw new FilesError(`Path is outside the files directory (${root}): ${userPath}`);
    }
    return real;
  }

  /** File name that is safe to create: no directories, no reserved characters. */
  function safeFileName(name) {
    const base = path.basename(String(name || '').replace(/\\/g, '/'));
    // eslint-disable-next-line no-control-regex
    const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
    return cleaned || 'file';
  }

  function uniquePath(directory, name) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let candidate = path.join(directory, name);
    for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(directory, `${stem} (${n})${ext}`);
    return candidate;
  }

  /** Reads a file from the files directory for attaching. */
  function readForAttach(userPath) {
    const real = resolveInside(userPath);
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new FilesError(`Not a file: ${userPath}`);
    if (stat.size > limit) throw new FilesError(`File is ${stat.size} bytes, the limit is ${limit}: ${userPath}`);
    const name = path.basename(real);
    const contentType = MIME_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
    return { name, data: fs.readFileSync(real), contentType };
  }

  /** Saves bytes into a subfolder of the files directory; returns the path written. */
  function save(subdir, name, data) {
    const realRoot = ensureRoot();
    const target = path.resolve(realRoot, ...subdir.split('/').map(safeFileName));
    fs.mkdirSync(target, { recursive: true });
    const file = uniquePath(target, safeFileName(name));
    fs.writeFileSync(file, data);
    return file;
  }

  /** Lists files (recursively, up to a limit) relative to the files directory. */
  function list(max = 200) {
    const realRoot = ensureRoot();
    const out = [];
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (out.length >= max) return;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push({ path: path.relative(realRoot, full), size: fs.statSync(full).size });
      }
    };
    walk(realRoot);
    return out;
  }

  return { root, limit, resolveInside, safeFileName, readForAttach, save, list, FilesError };
}

module.exports = { createFiles, FilesError, MIME_TYPES };
