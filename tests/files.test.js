const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFiles } = require('../src/files');

let dir;
let outside;
let files;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kerio-files-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kerio-outside-'));
  files = createFiles({ dir, maxBytes: 1000 });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('safeFileName', () => {
  test.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Windows\\evil.exe', 'evil.exe'],
    ['счёт №5 (1).pdf', 'счёт №5 (1).pdf'],
    ['a:b*c?.txt', 'a_b_c_.txt'],
    ['..', 'file'],
    ['', 'file']
  ])('%s -> %s', (input, expected) => {
    expect(files.safeFileName(input)).toBe(expected);
  });
});

describe('reading files for attaching', () => {
  test('reads a file from the directory and guesses its type', () => {
    fs.writeFileSync(path.join(dir, 'doc.pdf'), 'data');
    const f = files.readForAttach('doc.pdf');
    expect(f).toMatchObject({ name: 'doc.pdf', contentType: 'application/pdf' });
    expect(f.data.toString()).toBe('data');
  });

  test('refuses paths outside the directory', () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    expect(() => files.readForAttach(path.join(outside, 'secret.txt'))).toThrow(/outside the files directory/);
    expect(() => files.readForAttach('../' + path.basename(outside) + '/secret.txt')).toThrow(/outside/);
  });

  test('refuses a symlink that points outside', () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    expect(() => files.readForAttach('link.txt')).toThrow(/outside the files directory/);
  });

  test('refuses missing files, directories and files over the limit', () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2000));
    expect(() => files.readForAttach('nope.txt')).toThrow(/not found/);
    expect(() => files.readForAttach('sub')).toThrow(/Not a file/);
    expect(() => files.readForAttach('big.bin')).toThrow(/limit/);
  });
});

describe('saving files', () => {
  test('never overwrites: adds a counter to the name', () => {
    const a = files.save('downloads/x', 'a.txt', 'one');
    const b = files.save('downloads/x', 'a.txt', 'two');
    expect(path.basename(a)).toBe('a.txt');
    expect(path.basename(b)).toBe('a (1).txt');
    expect(fs.readFileSync(a, 'utf8')).toBe('one');
  });

  test('keeps hostile names inside the directory', () => {
    const saved = files.save('downloads/x', '../../../evil.sh', 'x');
    expect(path.relative(fs.realpathSync(dir), saved).startsWith('..')).toBe(false);
    expect(path.basename(saved)).toBe('evil.sh');
  });

  test('list shows saved files with relative paths', () => {
    files.save('downloads/x', 'a.txt', 'abc');
    expect(files.list()).toEqual([{ path: path.join('downloads', 'x', 'a.txt'), size: 3 }]);
  });
});
