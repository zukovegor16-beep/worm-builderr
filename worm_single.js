// AI Worm v8.0 FINAL — безупречный родительский червь
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import notifier from 'node-notifier';
import * as acorn from 'acorn';
import crypto from 'crypto';
import http from 'http';
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Worm is alive\n');
}).listen(PORT, () => {
  log('info', `Keep‑alive server listening on port ${PORT}`);
});



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========== НАСТРОЙКИ ==========
const API_KEYS = [
  'sk-137f3ae022ee4df2aaccc389a92de8a6',
];
const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const INIT_MSG_COUNT = 5;
const MAX_RETRIES = 5;
const FILES_PER_PROMPT = 3;
const LAUNCH_RETRIES = 5;
const CONTEXT_MAX_LENGTH = 8000;
const STREAM_TIMEOUT = 30000;         // мс
const MAX_FILE_SIZE = 500_000;       // символов (около 500 КБ)
const EXEC_TIMEOUT = 30000;          // мс
const BACKUP_MAX_AGE_DAYS = 7;       // удаление бэкапов старше N дней

const PROGRESS_FILE = path.join(__dirname, 'worm_progress.json');
const LOG_FILE = path.join(__dirname, 'worm.log');

// ========== ТРИ УЛУЧШАЮЩИХ СООБЩЕНИЯ ==========
const IMPROVEMENT_MSGS = [
  "Разве это предел ты можешь сильнее и тут много ошибок и неточностей. Доделай его но не давай разум, сложные решения должны приниматься через дип сик.",
  "Это же не твой предел, сделай лучше быстрее качественное и исправь вообще все ошибки, он должен быть идеален, бесплатен и разработывать коды от 100-200 тысяч строк, проверка и резины должны выполняться за секунды, оптммизируй то что ты создал.",
  "Да спору нет, он сможет делать код 100-200 тысяч строк он все равно недостаточно оптимизирован и я уверен что он может качественнее обрабатывать ошибки! Исправь , улучши и прогон  в голове 10 раз есть ли тут ошибки, просмотри созданный код со всех сторон и исправь я уверен они есть."
];

// ========== ЛОГГЕР (асинхронный, с поддержкой стека) ==========
async function log(level, msg, error = null) {
  const ts = new Date().toISOString();
  let line = `[${ts}] [${level}] ${msg}`;
  if (error && error.stack) {
    line += `\nStack: ${error.stack}`;
  }
  console.log(line);
  try {
    await fs.appendFile(LOG_FILE, line + '\n');
  } catch {}
}

// ========== УВЕДОМЛЕНИЯ ==========
function notify(title, message) {
  notifier.notify({ title, message, sound: true, wait: false });
}

// ========== ПРОВЕРКА API КЛЮЧА ==========
function validateKey(key) {
  if (!key || !key.startsWith('sk-')) {
    throw new Error(`Неверный формат API-ключа: ключ должен начинаться с "sk-"`);
  }
}

// ========== ОЧИСТКА СТАРЫХ БЭКАПОВ ==========
async function cleanupOldBackups(days = BACKUP_MAX_AGE_DAYS) {
  const backupDir = path.join(__dirname, 'backups');
  try {
    const files = await fs.readdir(backupDir);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(backupDir, file);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > days * 24 * 60 * 60 * 1000) {
        await fs.unlink(filePath);
        log('info', `Удалён старый бэкап: ${file}`);
      }
    }
  } catch {}
}

// ========== ФАЙЛОВЫЕ ОПЕРАЦИИ ==========
async function backupFile(filePath) {
  try {
    await fs.access(filePath);
    const backupDir = path.join(__dirname, 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${path.basename(filePath)}.${ts}.bak`;
    await fs.copyFile(filePath, path.join(backupDir, backupName));
    log('info', `Создан бэкап: ${backupName}`);
  } catch (err) {
    log('error', `Ошибка создания бэкапа для ${filePath}: ${err.message}`, err);
  }
}

async function saveFile(filePath, content, dryRun = false) {
  if (content.length > MAX_FILE_SIZE) {
    throw new Error(`Файл ${filePath} слишком большой (${content.length} символов). Максимум: ${MAX_FILE_SIZE}`);
  }
  if (dryRun) {
    log('info', `[DRY-RUN] Сохранение ${filePath} (${content.length} символов)`);
    return;
  }
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await backupFile(filePath);
    await fs.writeFile(filePath, content, 'utf-8');
    log('info', `Файл сохранён: ${filePath}`);
  } catch (err) {
    throw new Error(`Не удалось сохранить ${filePath}: ${err.message}`);
  }
}

// ========== ПРОВЕРКА СИНТАКСИСА ==========
async function quickCheck(filePath, dryRun = false) {
  if (dryRun) {
    log('info', `[DRY-RUN] Проверка синтаксиса ${filePath}`);
    return null;
  }
  const ext = path.extname(filePath).toLowerCase();
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    if (ext === '.json') {
      JSON.parse(raw);
      return null;
    } else if (ext === '.js') {
      acorn.parse(raw, { ecmaVersion: 2022, sourceType: 'module' });
      return null;
    }
    return null;
  } catch (e) {
    return `Ошибка в ${path.basename(filePath)}: ${e.message}`;
  }
}

// ========== ПУЛ КЛЮЧЕЙ ==========
class KeyPool {
  constructor(keys) {
    keys.forEach(validateKey);
    this.keys = keys;
    this.idx = 0;
  }
  getNext() {
    const key = this.keys[this.idx % this.keys.length];
    this.idx++;
    return key;
  }
}

// ========== СЕССИЯ DEEPSEEK ==========
class DeepSeekSession {
  constructor(apiKey) {
    validateKey(apiKey);
    this.apiKey = apiKey;
    this.messages = [];
  }

  async send(userMessage, onChunk = null) {
    log('info', `[ЗАПРОС] ${userMessage.slice(0, 300)}...`);
    this.messages.push({ role: 'user', content: userMessage });
    let context = this.messages.slice(-10);
    const totalLength = context.reduce((sum, m) => sum + m.content.length, 0);
    if (totalLength > CONTEXT_MAX_LENGTH) {
      context = [this.messages[this.messages.length - 1]];
      const lastAssistant = this.messages.slice().reverse().find(m => m.role === 'assistant');
      if (lastAssistant) context.unshift(lastAssistant);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fullReply = await this._streamRequest(context, onChunk);
        this.messages.push({ role: 'assistant', content: fullReply });
        log('info', `[ОТВЕТ] ${fullReply.slice(0, 300)}...`);
        return fullReply;
      } catch (e) {
        log('warn', `Запрос не удался (попытка ${attempt+1}): ${e.message}`, e);
        if (e.message.includes('429')) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else if (e.message.includes('500') || e.message.includes('502')) {
          log('error', 'Серверная ошибка API, пауза 60 с');
          await new Promise(resolve => setTimeout(resolve, 60000));
        } else if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
        }
      }
    }
    throw new Error('Не удалось выполнить запрос после 3 попыток');
  }

  async _streamRequest(messages, onChunk) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT);
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: 0.2,
          max_tokens: 4000,
          stream: true
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API error ${response.status}: ${errText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullReply = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const content = data.choices?.[0]?.delta?.content;
              if (content) {
                fullReply += content;
                if (onChunk) onChunk(content, fullReply);
              }
            } catch {}
          }
        }
      }
      return fullReply;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ========== ИЗВЛЕЧЕНИЕ ФАЙЛОВ (улучшенное) ==========
function extractFiles(reply) {
  const map = {};
  // Имя файла: только буквы, цифры, подчёркивания, точки, дефисы, слеши
  const re = /```(?:\w+\s+)?([\w\.\-\/]+?)\s*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(reply)) !== null) {
    const fname = m[1].trim();
    const code = m[2].trim();
    if (fname && !map[fname]) map[fname] = code;
  }
  return map;
}

// ========== ХЕШИРОВАНИЕ ОШИБОК ДЛЯ ДЕДУБЛИКАЦИИ ==========
function hashError(msg) {
  return crypto.createHash('md5').update(msg).digest('hex');
}

// ========== РОДИТЕЛЬСКИЙ ЧЕРВЬ ==========
class ParentWorm {
  constructor(apiKeys, plan, baseDir, dryRun = false) {
    this.keyPool = new KeyPool(apiKeys);
    this.plan = plan;
    this.baseDir = baseDir;
    this.projectName = plan.project_name || 'big_project';
    this.stages = plan.stages || [];
    this.completedStages = new Set();
    this.dryRun = dryRun;
  }

  async _loadProgress() {
    if (this.dryRun) return;
    try {
      const raw = await fs.readFile(PROGRESS_FILE, 'utf-8');
      this.completedStages = new Set(JSON.parse(raw).completedStages || []);
      log('info', `Прогресс загружен: ${this.completedStages.size} этапов`);
    } catch {}
  }

  async _saveProgress() {
    if (this.dryRun) return;
    try {
      await fs.writeFile(PROGRESS_FILE, JSON.stringify({ completedStages: [...this.completedStages] }), 'utf-8');
    } catch (err) {
      log('error', `Не удалось сохранить прогресс: ${err.message}`, err);
    }
  }

  _splitStage(stage) {
    const files = stage.files || [];
    if (files.length <= FILES_PER_PROMPT) return [stage];
    const parts = [];
    for (let i = 0; i < files.length; i += FILES_PER_PROMPT) {
      const chunk = files.slice(i, i + FILES_PER_PROMPT);
      parts.push({ ...stage, name: `${stage.name} (часть ${Math.floor(i / FILES_PER_PROMPT) + 1})`, files: chunk });
    }
    return parts;
  }

  async run() {
    await cleanupOldBackups();                     // очистка старых бэкапов
    await this._loadProgress();
    log('info', `Запуск проекта "${this.projectName}" (dry-run: ${this.dryRun})`);

    if (this.completedStages.size === 0) {
      const initSession = new DeepSeekSession(this.keyPool.getNext());
      for (let i = 0; i < INIT_MSG_COUNT; i++) {
        await initSession.send(
          `Инициализация проекта "${this.projectName}". Полный план: ${JSON.stringify(this.plan, null, 2)}`
        );
      }
    }

    for (const stage of this.stages) {
      if (this.completedStages.has(stage.name)) {
        log('info', `Этап "${stage.name}" уже выполнен`);
        continue;
      }

      const subStages = this._splitStage(stage);
      for (const sub of subStages) {
        await this._processSubStage(sub);
      }
      this.completedStages.add(stage.name);
      await this._saveProgress();
    }

    log('info', 'Все этапы собраны.');
    if (!this.dryRun) {
      await this._launchWithAutoFix();
    } else {
      log('info', '[DRY-RUN] Запуск пропущен.');
    }
  }

  async _processSubStage(subStage) {
    const filesNeeded = subStage.files;
    if (!filesNeeded.length) return;
    log('info', `Подэтап: ${subStage.name} (файлы: ${filesNeeded})`);

    const session = new DeepSeekSession(this.keyPool.getNext());
    let currentFiles = {};

    // 1. Первичный запрос с полным описанием этапа
    const initialPrompt =
      `Ты участвуешь в разработке проекта "${this.projectName}".\n` +
      `Текущий этап: "${subStage.name}".\n` +
      `Описание этапа: ${subStage.description || 'нет описания'}.\n` +
      `Необходимо создать файлы: ${filesNeeded.join(', ')}.\n` +
      `Выдай код для каждого файла строго в формате:\n` +
      `\`\`\`имя_файла\nкод...\n\`\`\`\n` +
      `Не объединяй файлы, не добавляй лишних.`;
    const initialReply = await session.send(initialPrompt);
    currentFiles = extractFiles(initialReply);

    if (!this._checkPlan(filesNeeded, currentFiles)) {
      log('warn', 'Несоответствие плану, перезапрашиваем...');
      const retryReply = await session.send(
        `Ошибка: файлы не соответствуют плану. Нужно: ${filesNeeded.join(', ')}. Переделай.`
      );
      currentFiles = extractFiles(retryReply);
      if (!this._checkPlan(filesNeeded, currentFiles)) {
        throw new Error(`Не удалось добиться соответствия плану после повторного запроса`);
      }
    }

    // 2. Три улучшающих сообщения
    for (let i = 0; i < IMPROVEMENT_MSGS.length; i++) {
      let msg = IMPROVEMENT_MSGS[i] + '\n\nТекущий код этапа:\n';
      for (const [fname, code] of Object.entries(currentFiles)) {
        msg += `\`\`\`${fname}\n${code}\n\`\`\`\n`;
      }
      msg += `Выдай новый улучшенный код всех файлов в том же формате.`;

      const reply = await session.send(msg);
      const improved = extractFiles(reply);
      if (Object.keys(improved).length === 0) {
        log('warn', `На улучшающее сообщение ${i+1} код не получен, оставлен предыдущий вариант.`);
      } else {
        currentFiles = improved;
        if (!this._checkPlan(filesNeeded, currentFiles)) {
          log('warn', `После улучшения ${i+1} план нарушен, пробуем исправить...`);
          const fixPlanReply = await session.send(
            `Файлы не соответствуют плану: нужно ${filesNeeded.join(', ')}. Исправь.`
          );
          currentFiles = extractFiles(fixPlanReply);
        }
      }
    }

    // 3. Финальное сохранение и проверка синтаксиса
    log('info', 'Сохранение и проверка синтаксиса...');
    for (const [fname, code] of Object.entries(currentFiles)) {
      const filePath = path.join(this.baseDir, this.projectName, fname);
      await saveFile(filePath, code, this.dryRun);
      const err = await quickCheck(filePath, this.dryRun);
      if (err) {
        log('error', `Синтаксическая ошибка в ${fname}: ${err}`);
        const fixSession = new DeepSeekSession(this.keyPool.getNext());
        const fixReply = await fixSession.send(
          `Ошибка в файле ${fname}: ${err}\nТекущий код:\n\`\`\`${fname}\n${code}\n\`\`\`\nИсправь и выдай новый код.`
        );
        const fixed = extractFiles(fixReply);
        if (fixed[fname]) {
          await saveFile(filePath, fixed[fname], this.dryRun);
          const recheck = await quickCheck(filePath, this.dryRun);
          if (recheck) {
            log('error', `Исправление не помогло: ${recheck}`);
            throw new Error(`Файл ${fname} содержит синтаксическую ошибку, исправить не удалось`);
          } else {
            log('info', `Файл ${fname} успешно исправлен`);
          }
        } else {
          throw new Error(`Не удалось получить исправленный код для ${fname}`);
        }
      } else {
        log('info', `Файл ${fname} проверен`);
      }
    }
    log('info', `Подэтап "${subStage.name}" завершён успешно`);
  }

  _checkPlan(expected, actual) {
    const eSet = new Set(expected);
    const aNames = Object.keys(actual);
    const missing = [...eSet].filter(f => !aNames.includes(f));
    const extra = aNames.filter(f => !eSet.has(f));
    if (missing.length) log('warn', `Отсутствуют: ${missing.join(', ')}`);
    if (extra.length) log('warn', `Лишние: ${extra.join(', ')}`);
    return missing.length === 0 && extra.length === 0;
  }

  async _launchWithAutoFix() {
    const projectPath = path.join(this.baseDir, this.projectName);
    const entryPoints = ['main.js', 'index.js', 'app.js'];
    let entryPath = null;
    for (const ep of entryPoints) {
      try {
        entryPath = path.join(projectPath, ep);
        await fs.access(entryPath);
        break;
      } catch {}
    }
    if (!entryPath) {
      log('warn', 'Не найдена точка входа, запуск пропущен');
      notify('Проект собран', `Файлы в ${projectPath}, но точка входа не обнаружена.`);
      return;
    }

    let lastError = null;
    let lastErrorHash = null;
    for (let attempt = 1; attempt <= LAUNCH_RETRIES; attempt++) {
      log('info', `Попытка запуска ${attempt} из ${LAUNCH_RETRIES}...`);
      try {
        const output = await this._execNode(entryPath);
        log('info', `Запуск успешен! Вывод: ${output}`);
        notify('Успех!', `Проект "${this.projectName}" успешно запущен и работает!`);
        return;
      } catch (err) {
        lastError = err;
        log('error', `Ошибка при запуске: ${err.message}`, err);
        const currentHash = hashError(err.message);
        if (currentHash === lastErrorHash) {
          log('warn', 'Ошибка повторяется, прерываем попытки запуска.');
          break;
        }
        lastErrorHash = currentHash;

        if (attempt === LAUNCH_RETRIES) break;

        const fixSession = new DeepSeekSession(this.keyPool.getNext());
        const prompt =
          `Проект "${this.projectName}" не запускается. Ошибка:\n${err.message}\n\n` +
          `Вывод: ${err.stdout || ''} ${err.stderr || ''}\n` +
          `Проанализируй ошибку, найди файл и выдай исправленный код в формате:\n` +
          `\`\`\`имя_файла\nкод\n\`\`\`\n` +
          `Если нужно изменить несколько файлов — укажи каждый.`;
        const fixReply = await fixSession.send(prompt);
        const fixedFiles = extractFiles(fixReply);
        if (Object.keys(fixedFiles).length === 0) {
          log('error', 'DeepSeek не дал исправлений, завершаем.');
          break;
        }
        for (const [fname, code] of Object.entries(fixedFiles)) {
          const filePath = path.join(projectPath, fname);
          await saveFile(filePath, code, this.dryRun);
          log('info', `Файл ${fname} обновлён (исправление для запуска).`);
        }
      }
    }
    throw new Error(`Не удалось запустить проект после ${LAUNCH_RETRIES} попыток. Последняя ошибка: ${lastError?.message}`);
  }

  async _execNode(scriptPath) {
    return new Promise((resolve, reject) => {
      exec(`node "${scriptPath}"`, { timeout: EXEC_TIMEOUT }, (error, stdout, stderr) => {
        if (error) {
          reject({ message: error.message, stdout, stderr });
        } else {
          resolve(stdout);
        }
      });
    });
  }
}

// ========== ТОЧКА ВХОДА ==========
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  API_KEYS.forEach(validateKey);
  if (!API_KEYS.length) {
    console.error('❌ Не указано ни одного API-ключа. Добавь ключ в массив API_KEYS.');
    process.exit(1);
  }

  // Health check
  try {
    const testSession = new DeepSeekSession(API_KEYS[0]);
    await testSession.send('ping');
    log('info', 'API DeepSeek доступен.');
  } catch (e) {
    log('error', `API DeepSeek недоступен: ${e.message}`, e);
    process.exit(1);
  }

  const planPath = path.join(__dirname, 'plan_big_worm.json');
  const planRaw = await fs.readFile(planPath, 'utf-8');
  const plan = JSON.parse(planRaw);
  const baseDir = path.join(__dirname, 'projects');
  const worm = new ParentWorm(API_KEYS, plan, baseDir, dryRun);

  // Graceful shutdown
  const shutdown = async () => {
    log('info', 'Получен сигнал завершения, сохраняю прогресс...');
    await worm._saveProgress();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await worm.run();
}
// Заглушка HTTP‑сервера, чтобы Render видел открытый порт
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => {
  console.log(`Health check server listening on port ${PORT}`);
});
main().catch(err => {
  log('crit', err.message, err);
  console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', err.message);
  process.exit(1);
});
