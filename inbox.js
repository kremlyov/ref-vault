import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function normalizeInboxInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('JSON должен содержать объект со ссылкой url');
  const url = new URL(String(value.url || '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Нужна ссылка http(s) без логина и пароля');
  const tags = Array.isArray(value.tags) ? value.tags : String(value.tags || '').split(',');
  return { url: url.href, tags: tags.map(x => String(x).trim()).filter(Boolean), note: String(value.note || ''), collection: String(value.collection || '') || 'Inbox / Без разбора', createdAt: String(value.createdAt || '') };
}

export function createInbox({ storageDir, archiveReference, inboxDir = process.env.REF_VAULT_INBOX_DIR || path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/REF-VAULT Inbox'), intervalMs = 3000, autoStart = true }) {
  const directory = path.resolve(inboxDir.replace(/^~(?=\/)/, os.homedir()));
  const queueFile = path.join(storageDir, 'inbox-queue.json');
  let jobs = [];
  if (fs.existsSync(queueFile)) jobs = JSON.parse(fs.readFileSync(queueFile, 'utf8')).jobs;
  if (!Array.isArray(jobs)) throw Error('Некорректная база очереди');
  // A persisted processing state means the previous process was interrupted.
  for (const job of jobs) if (job.status === 'processing') job.status = 'queued';
  const observed = new Map();
  let scanning = false, working = false, stopped = false, directoryError = '';
  const persist = () => {
    const tmp = queueFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ jobs }, null, 2));
    fs.renameSync(tmp, queueFile);
  };
  function status(job, next, error = '') {
    job.status = next; job.error = error; job.updatedAt = new Date().toISOString(); persist();
  }
  async function processJobs() {
    if (working || stopped) return;
    working = true;
    try {
      for (const job of jobs.filter(j => j.status === 'queued')) {
        if (stopped) break;
        status(job, 'processing');
        job.attempts = (job.attempts || 0) + 1;
        try {
          const input = normalizeInboxInput(JSON.parse(job.raw));
          const item = await archiveReference({ ...input, inboxJobId: job.id });
          job.itemId = item.id;
          job.mediaArchived = item.mediaArchived;
          job.mediaFound = item.mediaFound;
          job.partial = Boolean(item.archiveErrors?.length);
          status(job, 'saved');
        } catch (e) {
          // Persist no signed URLs or raw remote-server errors in the visible queue.
          status(job, 'error', e instanceof SyntaxError ? 'Некорректный JSON' : 'Не удалось импортировать. Проверь ссылку и повтори; при блокировке площадки используй ручную загрузку.');
        }
      }
    } finally { working = false; }
  }
  async function scan() {
    if (scanning || stopped) return;
    scanning = true;
    try {
      if (!fs.existsSync(directory)) {
        directoryError = 'Папка Inbox не найдена. Включи iCloud Drive и создай REF-VAULT Inbox или укажи REF_VAULT_INBOX_DIR.';
        await processJobs();
        return;
      }
      directoryError = '';
      const names = fs.readdirSync(directory).filter(name => name.toLowerCase().endsWith('.json')).sort();
      for (const name of names) {
        const filename = path.join(directory, name);
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const signature = `${stat.size}:${stat.mtimeMs}`;
        const previous = observed.get(name);
        if (previous?.signature !== signature) { observed.set(name, { signature, since: Date.now() }); continue; }
        if (Date.now() - previous.since < intervalMs) continue;
        if (stat.size > 1024 * 1024) {
          const id = crypto.createHash('sha256').update(`${name}:${signature}`).digest('hex');
          if (!jobs.some(j => j.id === id)) {
            jobs.unshift({ id, filename: name, status: 'error', error: 'JSON превышает 1 МБ', createdAt: new Date().toISOString(), attempts: 0 }); persist();
          }
          continue;
        }
        const raw = fs.readFileSync(filename, 'utf8');
        // Hash includes filename: two intentionally shared copies remain independent.
        const id = crypto.createHash('sha256').update(name + '\0' + raw).digest('hex');
        if (jobs.some(j => j.id === id)) continue;
        let input, error;
        try { input = normalizeInboxInput(JSON.parse(raw)); } catch { error = 'Некорректный JSON или ссылка. Исправь исходный файл.'; }
        jobs.unshift({ id, filename: name, raw, input, status: error ? 'error' : 'queued', error: error || '', createdAt: new Date().toISOString(), attempts: 0 });
        persist();
      }
    } catch { directoryError = 'Не удалось прочитать папку Inbox. Проверь доступ и синхронизацию.'; }
    finally { scanning = false; }
    await processJobs();
  }
  const timer = autoStart ? setInterval(() => { void scan().catch(() => { directoryError = "Не удалось записать очередь. Проверь доступ к хранилищу."; }); }, intervalMs) : null;
  timer?.unref();
  if (autoStart) void scan().catch(() => { directoryError = "Не удалось записать очередь."; });
  return {
    scan,
    snapshot: () => ({ directory, available: fs.existsSync(directory), error: directoryError, jobs: jobs.map(({ raw, input, ...job }) => ({ ...job, url: input?.url || '', collection: input?.collection || '' })) }),
    retry(id) {
      const job = jobs.find(j => j.id === id);
      if (!job || job.status !== 'error' || !job.raw) throw Error('Это задание нельзя повторить');
      status(job, 'queued'); void processJobs().catch(() => { directoryError = 'Не удалось записать очередь.'; });
    },
    stop() { stopped = true; if (timer) clearInterval(timer); }
  };
}
