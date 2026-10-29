/**
 * Client for the Kerio Connect web-client JSON-RPC API
 * (https://<host>/webmail/api/jsonrpc/). Works over HTTPS only, so it runs
 * wherever port 443 is reachable (including cloud sessions behind an HTTPS proxy).
 *
 * The session is created lazily, re-created when the server reports that it
 * expired, and requests are retried on transient network errors.
 */

const SPECIAL_FOLDERS = {
  inbox: 'INBOX',
  sent: 'Sent Items',
  drafts: 'Drafts',
  trash: 'Deleted Items',
  deleted: 'Deleted Items',
  junk: 'Junk E-mail',
  spam: 'Junk E-mail'
};

const MAIL_FIELDS = ['id', 'from', 'to', 'subject', 'receiveDate', 'isSeen', 'isFlagged', 'hasAttachment'];
const SCAN_PAGE = 100;
const MAX_SCAN = 1000;

class KerioError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'KerioError';
    this.code = code;
  }
}

class KerioClient {
  /**
   * @param {{host: string, user: string, password: string, fetchImpl?: Function, timeoutMs?: number}} options
   */
  constructor({ host, user, password, fetchImpl, timeoutMs = 30000 }) {
    if (!host || !user || !password) {
      throw new KerioError('KERIO_HOST, KERIO_USER and KERIO_PASSWORD are required');
    }
    this.host = host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.user = user;
    this.password = password;
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.url = `https://${this.host}/webmail/api/jsonrpc/`;
    this.token = null;
    this.cookies = new Map();
    this.folderCache = null;
    this.requestId = 0;
  }

  // ---- transport -------------------------------------------------------

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(response) {
    const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  authHeaders() {
    return {
      ...(this.token ? { 'X-Token': this.token } : {}),
      ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {})
    };
  }

  /**
   * One HTTP request with timeout and retries on network errors.
   * `read` turns the Response into the value to return, inside the retry loop.
   */
  async http(url, makeInit, read, { retries = 3, timeoutMs = this.timeoutMs } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.fetch(url, { ...makeInit(), signal: AbortSignal.timeout(timeoutMs) });
        this.storeCookies(response);
        return await read(response);
      } catch (error) {
        lastError = error;
        if (error instanceof KerioError) throw error;
        if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw new KerioError(`Kerio is not reachable: ${lastError && lastError.message}`);
  }

  post(method, params, options) {
    return this.http(
      this.url,
      () => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json-rpc', ...this.authHeaders() },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params })
      }),
      response => response.json(),
      options
    );
  }

  // ---- files -----------------------------------------------------------

  /**
   * Uploads a file so it can be attached to a mail (the returned id is valid for about an hour).
   * @param {{name: string, data: Buffer|Uint8Array, contentType?: string}} file
   * @returns {Promise<{id: string, name: string, length: number}>}
   */
  async uploadFile({ name, data, contentType = 'application/octet-stream' }) {
    if (!this.token) await this.login();
    for (let attempt = 0; attempt < 2; attempt++) {
      const json = await this.http(
        `${this.url}upload/`,
        () => {
          const form = new FormData();
          form.append('file', new Blob([data], { type: contentType }), name);
          return { method: 'POST', headers: this.authHeaders(), body: form };
        },
        response => response.json(),
        { timeoutMs: this.timeoutMs * 4 }
      );
      if (json.error && json.error.code === -32001 && attempt === 0) {
        await this.login();
        continue;
      }
      if (json.error) throw new KerioError(`Upload failed: ${json.error.message}`, json.error.code);
      const uploaded = json.result && json.result.fileUpload;
      if (!uploaded || !uploaded.id) throw new KerioError('Upload failed: no file id in response');
      return uploaded;
    }
  }

  /** Downloads an attachment of a mail (an object from mail.attachments) and returns its bytes. */
  async downloadAttachment(attachment, { maxBytes = Infinity } = {}) {
    if (!attachment || !attachment.url) throw new KerioError('Attachment has no download url');
    if (attachment.size > maxBytes) {
      throw new KerioError(`Attachment ${attachment.name} is ${attachment.size} bytes, the limit is ${maxBytes}`);
    }
    if (!this.token) await this.login();
    return this.http(
      `https://${this.host}${attachment.url}`,
      () => ({ method: 'GET', headers: this.authHeaders() }),
      async response => {
        if (!response.ok) throw new KerioError(`Download failed: HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      },
      { timeoutMs: this.timeoutMs * 4 }
    );
  }

  async login() {
    this.token = null;
    this.cookies.clear();
    const data = await this.post('Session.login', {
      userName: this.user,
      password: this.password,
      application: { name: 'kerio-mcp', vendor: 'kerio-mcp', version: '1.0' }
    });
    if (data.error || !data.result || !data.result.token) {
      const message = data.error ? data.error.message : 'no token in response';
      throw new KerioError(`Kerio login failed: ${message}`, data.error && data.error.code);
    }
    this.token = data.result.token;
  }

  /** Calls a JSON-RPC method, logging in first or again when needed. */
  async rpc(method, params = {}) {
    if (!this.token) await this.login();
    let data = await this.post(method, params);
    if (data.error && data.error.code === -32001) {
      await this.login();
      data = await this.post(method, params);
    }
    if (data.error) throw new KerioError(`${method}: ${data.error.message}`, data.error.code);
    return data.result;
  }

  /** Runs a batch method and turns per-item errors into an exception. */
  async batch(method, params) {
    const result = await this.rpc(method, params);
    if (result && result.errors && result.errors.length) {
      const first = result.errors[0];
      throw new KerioError(`${method}: ${first.message} (code ${first.code})`, first.code);
    }
    return result;
  }

  async logout() {
    if (!this.token) return;
    try { await this.post('Session.logout', {}, { retries: 0 }); } catch (e) { /* best effort */ }
    this.token = null;
  }

  // ---- folders ---------------------------------------------------------

  async listFolders({ refresh = false } = {}) {
    if (this.folderCache && !refresh) return this.folderCache;
    const result = await this.rpc('Folders.get', {});
    this.folderCache = result.list.map(f => ({ id: f.id, name: f.name, type: f.type, parentId: f.parentId }));
    return this.folderCache;
  }

  /** Accepts "inbox", "sent", ..., a folder name (case-insensitive) or a full folder id. */
  async resolveFolder(folder = 'inbox') {
    if (typeof folder === 'string' && folder.startsWith('keriostorage://')) return folder;
    const wanted = SPECIAL_FOLDERS[String(folder).toLowerCase()] || folder;
    const folders = await this.listFolders();
    const match = folders.find(f => f.name.toLowerCase() === String(wanted).toLowerCase());
    if (!match) {
      const names = folders.filter(f => f.type === 'FMail').map(f => f.name).join(', ');
      throw new KerioError(`Folder not found: ${folder}. Mail folders: ${names}`);
    }
    return match.id;
  }

  async createFolder(name, parent = null) {
    const parentId = parent ? await this.resolveFolder(parent) : (await this.listFolders())[0].id;
    await this.batch('Folders.create', { folders: [{ name, parentId, type: 'FMail' }] });
    this.folderCache = null;
    return { name };
  }

  // ---- reading ---------------------------------------------------------

  /** One page of mails; `query` is matched against subject OR sender. */
  async fetchPage(folderId, start, pageSize, query) {
    const params = {
      folderIds: [folderId],
      query: {
        fields: MAIL_FIELDS,
        start,
        limit: pageSize,
        orderBy: [{ columnName: 'receiveDate', direction: 'Desc' }]
      }
    };
    if (query) {
      params.query.conditions = [
        { fieldName: 'subject', comparator: 'Like', value: query },
        { fieldName: 'from', comparator: 'Like', value: query }
      ];
      params.query.combining = 'Or';
    }
    const result = await this.rpc('Mails.get', params);
    return { total: result.totalItems, list: result.list };
  }

  /**
   * @param {{folder?: string, limit?: number, start?: number, unreadOnly?: boolean, query?: string}} options
   *
   * The server ignores read-state conditions, so unread mails are collected by
   * scanning pages (newest first, at most MAX_SCAN mails).
   */
  async listMails({ folder = 'inbox', limit = 20, start = 0, unreadOnly = false, query } = {}) {
    const folderId = await this.resolveFolder(folder);
    if (!unreadOnly) {
      const { total, list } = await this.fetchPage(folderId, start, limit, query);
      return { total, mails: list };
    }
    const mails = [];
    let position = start;
    let total = Infinity;
    while (mails.length < limit && position < total && position - start < MAX_SCAN) {
      const page = await this.fetchPage(folderId, position, SCAN_PAGE, query);
      total = page.total;
      if (!page.list.length) break;
      for (const mail of page.list) {
        if (!mail.isSeen && mails.length < limit) mails.push(mail);
      }
      position += page.list.length;
    }
    return { total: mails.length, scanned: position - start, mails };
  }

  async getMail(id) {
    const result = await this.batch('Mails.getById', { ids: [id] });
    const mail = result.result && result.result[0];
    if (!mail) throw new KerioError(`Mail not found: ${id}`);
    return { ...mail, text: extractText(mail) };
  }

  // ---- changing --------------------------------------------------------

  async setFlags(ids, { seen, flagged, flagColor } = {}) {
    const patch = {};
    if (seen !== undefined) patch.isSeen = seen;
    if (flagged !== undefined) {
      patch.isFlagged = flagged;
      if (flagged) patch.flagColor = flagColor || 'Red';
    }
    await this.batch('Mails.set', { mails: ids.map(id => ({ id, ...patch })) });
  }

  /** Moves mails to a folder. The server assigns new ids to moved mails. */
  async moveMails(ids, folder) {
    const folderId = await this.resolveFolder(folder);
    await this.batch('Mails.set', { mails: ids.map(id => ({ id, folderId })) });
  }

  /** Moves mails to "Deleted Items", or deletes them for good when permanent is true. */
  async deleteMails(ids, { permanent = false } = {}) {
    if (permanent) {
      await this.batch('Mails.remove', { ids });
    } else {
      await this.moveMails(ids, 'trash');
    }
  }

  /**
   * @param {{to?: string[], cc?: string[], bcc?: string[], subject: string, body: string,
   *          attachments?: {name: string, data: Buffer, contentType?: string}[]}} message
   */
  async createDraft({ to, cc, bcc, subject, body, attachments = [] }) {
    const draftsId = await this.resolveFolder('drafts');
    const toList = a => (a || []).map(address => ({ name: '', address }));
    const uploaded = [];
    for (const file of attachments) {
      const result = await this.uploadFile(file);
      uploaded.push({ id: result.id, name: file.name, contentType: file.contentType || 'application/octet-stream' });
    }
    const result = await this.batch('Mails.create', {
      mails: [{
        folderId: draftsId,
        subject,
        to: toList(to),
        cc: toList(cc),
        bcc: toList(bcc),
        isDraft: true,
        plainBody: true,
        displayableParts: [{ contentType: 'ctTextPlain', content: body }],
        attachments: uploaded
      }]
    });
    return result.result[0].id;
  }

  /** Creates a draft and sends it; returns the draft id that was sent. */
  async sendMail(message) {
    const id = await this.createDraft(message);
    await this.batch('Mails.set', {
      mails: [{ id, from: { name: this.displayName || '', address: this.user }, send: true }]
    });
    return id;
  }
}

/** Plain text of a mail: plain parts as is, HTML parts with tags stripped. */
function extractText(mail) {
  const parts = mail.displayableParts || [];
  return parts
    .map(part => (part.contentType === 'ctTextHtml' ? htmlToText(part.content) : part.content))
    .join('\n')
    .trim();
}

// Elements hidden with inline styles are a known way to smuggle instructions to an AI reader.
const HIDDEN_ELEMENT = /<(\w+)\b[^>]*style\s*=\s*"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d]))[^"]*"[^>]*>[\s\S]*?<\/\1>/gi;
const INVISIBLE_CHARS = /[​-‏⁠-⁤͏﻿­]/g;

function htmlToText(html) {
  return String(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(HIDDEN_ELEMENT, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

module.exports = { KerioClient, KerioError, extractText, htmlToText, SPECIAL_FOLDERS };
