const express = require('express');
const mysql = require('mysql');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const axios = require('axios');
require('dotenv').config();

// Попытка загрузить sharp для оптимизации изображений (опционально)
let sharp = null;
try {
  sharp = require('sharp');
  console.log('✅ Sharp загружен - оптимизация изображений включена');
} catch (e) {
  console.log('⚠️ Sharp не установлен. Установите: npm install sharp');
  console.log('⚠️ Изображения будут загружаться без оптимизации');
}

const app = express();

// CORS: разрешаем фронт (boodaipizza.com) и бэкенд (vasya010-red-252b.twc1.net)
const allowedOrigins = [
  'https://boodaipizza.com',
  'https://www.boodaipizza.com',
  'https://vasya010-red-252b.twc1.net',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
];
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  credentials: true,
  optionsSuccessStatus: 200,
}));
app.use(express.json());

// Middleware для логирования всех запросов (после парсинга body)
app.use((req, res, next) => {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  
  // Логируем входящий запрос
  console.log(`\n📥 [${timestamp}] ${req.method} ${req.path}`);
  console.log(`   IP: ${req.ip || req.connection.remoteAddress}`);
  
  // Безопасная проверка query параметров
  try {
    if (req.query && typeof req.query === 'object' && Object.keys(req.query).length > 0) {
      console.log(`   Query:`, req.query);
    }
  } catch (e) {
    // Игнорируем ошибки при логировании query
  }
  
  // Безопасная проверка body
  try {
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && Object.keys(req.body).length > 0 && req.path !== '/api/public/send-order') {
      // Не логируем полное тело заказа (слишком большое), только для других запросов
      try {
        const bodyStr = JSON.stringify(req.body);
        console.log(`   Body:`, bodyStr.substring(0, 200));
      } catch (e) {
        console.log(`   Body: [не удалось сериализовать]`);
      }
    }
  } catch (e) {
    // Игнорируем ошибки при логировании body
  }
  
  // Перехватываем ответ для логирования
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - startTime;
    const statusEmoji = res.statusCode >= 400 ? '❌' : res.statusCode >= 300 ? '⚠️' : '✅';
    console.log(`${statusEmoji} [${timestamp}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    
    // Логируем ошибки подробнее
    if (res.statusCode >= 400) {
      try {
        const errorData = typeof data === 'string' ? JSON.parse(data) : data;
        console.log(`   Error:`, errorData.error || errorData.message || data);
      } catch (e) {
        console.log(`   Error:`, data?.substring?.(0, 200) || data);
      }
    }
    
    return originalSend.call(this, data);
  };
  
  next();
});

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_very_secure_random_string';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL; // URL для webhook (опционально)

if (!TELEGRAM_BOT_TOKEN) {
  console.error('⚠️ TELEGRAM_BOT_TOKEN не установлен в переменных окружения!');
  console.error('⚠️ Добавьте TELEGRAM_BOT_TOKEN в файл .env');
}
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'GIMZKRMOGP4F0MOTLVCE';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'WvhFfIzzCkITUrXfD8JfoDne7LmBhnNzDuDBj89I';
const MYSQL_HOST = process.env.MYSQL_HOST || 'vh426.timeweb.ru';
const MYSQL_USER = process.env.MYSQL_USER || 'ch79145_pizza';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || 'Vasya11091109';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'ch79145_pizza';
// Локальный SMS Gateway (на вашем сервере)22
const SMS_GATEWAY_URL = process.env.SMS_GATEWAY_URL || 'https://vasya010-red-bdf5.twc1.net/sms/send';
const SMS_GATEWAY_API_KEY = process.env.SMS_GATEWAY_API_KEY || '';
const SMS_GATEWAY_METHOD = process.env.SMS_GATEWAY_METHOD || 'POST'; 

const s3Client = new S3Client({
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
  },
  endpoint: 'https://s3.twcstorage.ru',
  region: 'ru-1',
  forcePathStyle: true,
});
const S3_BUCKET = 'a2c31109-3cf2c97b-aca1-42b0-a822-3e0ade279447';

// Функция для МОМЕНТАЛЬНОЙ отправки в Telegram (быстрая, неблокирующая)
async function sendTelegramMessage(chatId, text, maxRetries = 2) {
  const axiosConfig = {
    timeout: 5000, // 5 секунд таймаут (быстро для моментальной отправки)
    headers: {
      'Content-Type': 'application/json',
      'Connection': 'keep-alive'
    },
    maxRedirects: 3,
    validateStatus: function (status) {
      return status >= 200 && status < 300;
    }
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const startTime = Date.now();
      const response = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text: text,
          parse_mode: 'Markdown',
        },
        axiosConfig
      );
      const duration = Date.now() - startTime;
      console.log(`✅ Telegram сообщение отправлено МОМЕНТАЛЬНО (chat_id: ${chatId}, попытка ${attempt}, время: ${duration}ms)`);
      return { success: true, response: response.data };
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const errorMessage = error.response?.data?.description || error.message;
      const errorCode = error.response?.data?.error_code;
      
      console.error(`❌ Попытка ${attempt}/${maxRetries} отправки в Telegram (chat_id: ${chatId}):`, errorMessage);
      
      // Если это последняя попытка, возвращаем ошибку
      if (isLastAttempt) {
        return { 
          success: false, 
          error: errorMessage,
          errorCode: errorCode,
          errorResponse: error.response?.data,
          networkError: error.code
        };
      }
      
      // Минимальная задержка между попытками (100-300ms для быстроты)
      const delay = Math.min(100 * attempt, 300);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Форматирование суммы для Telegram (всегда два знака, без NaN/undefined → "0.00")
function fmt(n) { return (Number(n) || 0).toFixed(2); }

// Функция для неблокирующей отправки в Telegram (fire and forget)
function sendTelegramMessageAsync(chatId, text, branchName = '') {
  // Запускаем асинхронно, не ждем результата
  return new Promise((resolve) => {
    setImmediate(async () => {
      try {
        if (!chatId) {
          console.error(`⚠️ Chat ID не указан для филиала "${branchName}"`);
          resolve({ success: false, error: 'Chat ID не указан' });
          return;
        }

        if (!TELEGRAM_BOT_TOKEN) {
          console.error('⚠️ TELEGRAM_BOT_TOKEN не настроен');
          resolve({ success: false, error: 'Bot token не настроен' });
          return;
        }

        const result = await sendTelegramMessage(chatId, text);
        if (!result.success) {
          const branchInfo = branchName ? ` (Филиал: ${branchName})` : '';
          console.error(`⚠️ Не удалось отправить сообщение в Telegram${branchInfo} (chat_id: ${chatId}, некритично):`, result.error);
          
          // Дополнительная информация для отладки
          if (result.error && result.error.includes('chat not found')) {
            console.error(`💡 Подсказка: Убедитесь, что бот добавлен в чат/группу с ID ${chatId}, или обновите telegram_chat_id для филиала в базе данных.`);
          }
        } else {
          console.log(`✅ Заказ успешно отправлен в Telegram группу (chat_id: ${chatId}, филиал: ${branchName})`);
        }
        resolve(result);
      } catch (error) {
        console.error('⚠️ Ошибка при асинхронной отправке в Telegram (некритично):', error.message);
        resolve({ success: false, error: error.message });
      }
    });
  });
}

function testS3Connection(callback) {
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: 'test-connection.txt',
    Body: 'This is a test file to check S3 connection.',
  });
  s3Client.send(command, callback);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 1,
    fields: 50
  },
  fileFilter: (req, file, cb) => {
    // Разрешаем только изображения
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Неподдерживаемый тип файла. Разрешены только изображения (JPEG, PNG, GIF, WebP)'));
    }
  }
}).single('image');

// Оптимизация изображения перед загрузкой
async function optimizeImage(buffer, mimetype) {
  if (!sharp) {
    // Если sharp не установлен, возвращаем оригинал
    return buffer;
  }

  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();
    
    // Определяем максимальные размеры для оптимизации
    const maxWidth = 1200; // Максимальная ширина для товаров
    const maxHeight = 1200; // Максимальная высота
    
    let optimized = image;
    
    // Изменяем размер, если изображение слишком большое
    if (metadata.width > maxWidth || metadata.height > maxHeight) {
      optimized = optimized.resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      });
    }
    
    // Оптимизация в зависимости от типа изображения
    if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') {
      return await optimized
        .jpeg({ 
          quality: 85, // Высокое качество, но сжатое
          progressive: true, // Прогрессивная загрузка
          mozjpeg: true // Используем mozjpeg для лучшего сжатия
        })
        .toBuffer();
    } else if (mimetype === 'image/png') {
      return await optimized
        .png({ 
          quality: 90,
          compressionLevel: 9,
          adaptiveFiltering: true
        })
        .toBuffer();
    } else if (mimetype === 'image/webp') {
      return await optimized
        .webp({ 
          quality: 85,
          effort: 6 // Максимальное сжатие
        })
        .toBuffer();
    }
    
    // Для других форматов возвращаем оптимизированное JPEG
    return await optimized
      .jpeg({ quality: 85, progressive: true })
      .toBuffer();
  } catch (error) {
    console.error('⚠️ Ошибка оптимизации изображения, используем оригинал:', error.message);
    return buffer; // Возвращаем оригинал при ошибке
  }
}

// Улучшенная функция загрузки в S3 с оптимизацией изображений
async function uploadToS3(file, callback) {
  try {
    if (!file || !file.buffer) {
      return callback(new Error('Файл не найден или поврежден'));
    }
    
    // Оптимизируем изображение перед загрузкой
    const optimizedBuffer = await optimizeImage(file.buffer, file.mimetype);
    const originalSize = file.buffer.length;
    const optimizedSize = optimizedBuffer.length;
    const compressionRatio = ((1 - optimizedSize / originalSize) * 100).toFixed(1);
    
    if (compressionRatio > 0) {
      console.log(`📦 Изображение оптимизировано: ${(originalSize / 1024).toFixed(2)}KB → ${(optimizedSize / 1024).toFixed(2)}KB (${compressionRatio}% меньше)`);
    }
    
    // Определяем расширение файла (предпочитаем WebP для лучшего сжатия)
    const ext = path.extname(file.originalname).toLowerCase();
    const useWebP = sharp && (ext === '.jpg' || ext === '.jpeg' || ext === '.png');
    const finalExt = useWebP ? '.webp' : ext;
    const finalMimeType = useWebP ? 'image/webp' : (file.mimetype || 'image/jpeg');
    
    const key = `pizza-images/${Date.now()}-${Math.random().toString(36).substring(7)}${finalExt}`;
    const params = {
      Bucket: S3_BUCKET,
      Key: key,
      Body: optimizedBuffer,
      ContentType: finalMimeType,
      CacheControl: 'public, max-age=31536000', // Кэш на 1 год
      Metadata: {
        'original-size': originalSize.toString(),
        'optimized-size': optimizedSize.toString()
      }
    };
    
    const upload = new Upload({ 
      client: s3Client, 
      params,
      queueSize: 4,
      partSize: 1024 * 1024 * 5, // 5MB chunks
    });
    
    upload.done()
      .then(() => {
        console.log(`✅ Файл успешно загружен в S3: ${key} (${(optimizedSize / 1024).toFixed(2)}KB)`);
        callback(null, key);
      })
      .catch((err) => {
        console.error('❌ Ошибка загрузки в S3:', err);
        callback(new Error(`Ошибка загрузки файла: ${err.message || 'Неизвестная ошибка'}`));
      });
  } catch (error) {
    console.error('❌ Ошибка при подготовке загрузки в S3:', error);
    callback(new Error(`Ошибка обработки файла: ${error.message || 'Неизвестная ошибка'}`));
  }
}

// Универсальный обработчик ошибок multer
function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        error: 'Файл слишком большой. Максимальный размер: 5MB' 
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ 
        error: 'Слишком много файлов. Разрешено только одно изображение' 
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ 
        error: 'Неожиданное поле файла. Используйте поле "image"' 
      });
    }
    return res.status(400).json({ 
      error: `Ошибка загрузки файла: ${err.message}` 
    });
  }
  
  if (err) {
    return res.status(400).json({ 
      error: err.message || 'Ошибка загрузки файла' 
    });
  }
  
  next();
}

function getFromS3(key, callback) {
  const params = { Bucket: S3_BUCKET, Key: key };
  s3Client.send(new GetObjectCommand(params), callback);
}

function deleteFromS3(key, callback) {
  const params = { Bucket: S3_BUCKET, Key: key };
  s3Client.send(new DeleteObjectCommand(params), callback);
}

const db = mysql.createPool({
  host: MYSQL_HOST,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  connectionLimit: 10,
  connectTimeout: 10000,
  acquireTimeout: 10000,
  waitForConnections: true,
  queueLimit: 0,
});

// Обработка ошибок подключения к БД
db.on('error', (err) => {
  const timestamp = new Date().toISOString();
  console.error(`\n❌ [${timestamp}] Ошибка подключения к MySQL:`, err);
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.log(`🔄 [${timestamp}] Переподключение к MySQL...`);
  } else {
    throw err;
  }
});

// Логирование подключений к БД
db.on('connection', (connection) => {
  const timestamp = new Date().toISOString();
  console.log(`🔌 [${timestamp}] Новое подключение к MySQL (ID: ${connection.threadId})`);
});

db.on('acquire', (connection) => {
  const timestamp = new Date().toISOString();
  console.log(`📊 [${timestamp}] Получено подключение из пула (ID: ${connection.threadId})`);
});

db.on('release', (connection) => {
  const timestamp = new Date().toISOString();
  console.log(`🔄 [${timestamp}] Подключение возвращено в пул (ID: ${connection.threadId})`);
});

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  const timestamp = new Date().toISOString();
  if (!token) {
    console.log(`🔒 [${timestamp}] Попытка доступа без токена: ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Токен отсутствует' });
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log(`❌ [${timestamp}] Недействительный токен: ${req.method} ${req.path}`);
      return res.status(403).json({ error: 'Недействительный токен' });
    }
    console.log(`✅ [${timestamp}] Аутентификация успешна: User ID ${user.id}, ${req.method} ${req.path}`);
    req.user = user;
    next();
  });
}

function optionalAuthenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (token) {
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (!err) req.user = user;
      next();
    });
  } else {
    next();
  }
}

// Вспомогательная функция для конвертации stream в buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Кэш для изображений в памяти (LRU cache)
const imageCache = new Map();
const MAX_CACHE_SIZE = 100; // Максимум 100 изображений в кэше
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 часа

// Функция для очистки старых записей из кэша
function cleanImageCache() {
  if (imageCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(imageCache.entries());
    // Удаляем самые старые записи
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, entries.length - MAX_CACHE_SIZE);
    toDelete.forEach(([key]) => imageCache.delete(key));
  }
  
  // Удаляем устаревшие записи
  const now = Date.now();
  for (const [key, value] of imageCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      imageCache.delete(key);
    }
  }
}

// Очистка кэша каждые 6 часов
setInterval(cleanImageCache, 6 * 60 * 60 * 1000);

app.get('/product-image/:key', optionalAuthenticateToken, (req, res) => {
  const { key } = req.params;
  const { width, quality } = req.query;
  
  if (!key) {
    return res.status(400).json({ error: 'Ключ изображения не указан' });
  }
  
  const cacheKey = `${key}_${width || 'original'}_${quality || 'default'}`;
  
  // Проверяем кэш
  const cached = imageCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // Кэш на 1 год
    res.setHeader('ETag', cached.etag);
    res.setHeader('Last-Modified', cached.lastModified);
    return res.send(cached.buffer);
  }
  
  getFromS3(`pizza-images/${key}`, async (err, image) => {
    if (err) {
      console.error(`❌ Ошибка получения изображения ${key}:`, err.message);
      return res.status(404).json({ error: `Изображение не найдено: ${err.message}` });
    }
    
    try {
      let imageBuffer = await streamToBuffer(image.Body);
      let contentType = image.ContentType || 'image/jpeg';
      let etag = image.ETag || `"${Date.now()}"`;
      
      // Проверяем If-None-Match для 304 Not Modified (до обработки)
      if (req.headers['if-none-match'] === etag) {
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.status(304).end();
      }
      
      // Оптимизация на лету, если запрошены параметры и установлен sharp
      if (sharp && (width || quality)) {
        const imageProcessor = sharp(imageBuffer);
        
        if (width) {
          const widthNum = parseInt(width);
          if (widthNum > 0 && widthNum <= 2000) {
            imageProcessor.resize(widthNum, null, {
              fit: 'inside',
              withoutEnlargement: true
            });
          }
        }
        
        const qualityNum = quality ? parseInt(quality) : 85;
        if (contentType.includes('jpeg') || contentType.includes('jpg')) {
          imageBuffer = await imageProcessor
            .jpeg({ quality: qualityNum, progressive: true, mozjpeg: true })
            .toBuffer();
        } else if (contentType.includes('png')) {
          imageBuffer = await imageProcessor
            .png({ quality: qualityNum, compressionLevel: 9 })
            .toBuffer();
        } else if (contentType.includes('webp')) {
          imageBuffer = await imageProcessor
            .webp({ quality: qualityNum })
            .toBuffer();
          contentType = 'image/webp';
        }
      }
      
      // Сохраняем в кэш
      if (imageCache.size < MAX_CACHE_SIZE) {
        imageCache.set(cacheKey, {
          buffer: imageBuffer,
          contentType: contentType,
          etag: etag,
          timestamp: Date.now(),
          lastModified: new Date().toUTCString()
        });
      }
      
      // Устанавливаем заголовки для кэширования и оптимизации
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // Кэш на 1 год
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', new Date().toUTCString());
      res.setHeader('Content-Length', imageBuffer.length);
      res.setHeader('Accept-Ranges', 'bytes');
      
      res.send(imageBuffer);
    } catch (error) {
      console.error('❌ Ошибка обработки изображения:', error);
      res.status(500).json({ error: 'Ошибка обработки изображения' });
    }
  });
});

function initializeServer(callback) {
  const maxRetries = 5;
  let retryCount = 0;
  function attemptConnection() {
    db.getConnection((err, connection) => {
      if (err) {
        retryCount++;
        if (retryCount < maxRetries) setTimeout(attemptConnection, 5000);
        else callback(new Error(`MySQL connection failed after ${maxRetries} attempts: ${err.message}`));
        return;
      }
      connection.query('SELECT 1', (err) => {
        if (err) {
          connection.release();
          return callback(new Error(`MySQL connection test failed: ${err.message}`));
        }
        connection.query(`
          CREATE TABLE IF NOT EXISTS branches (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            address VARCHAR(255),
            phone VARCHAR(20),
            telegram_chat_id VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) {
            connection.release();
            return callback(err);
          }
          connection.query('SHOW COLUMNS FROM branches LIKE "address"', (err, branchColumns) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            if (branchColumns.length === 0) {
              connection.query('ALTER TABLE branches ADD COLUMN address VARCHAR(255), ADD COLUMN phone VARCHAR(20)', (err) => {
                if (err) {
                  connection.release();
                  return callback(err);
                }
              });
            }
            connection.query('SHOW COLUMNS FROM branches LIKE "telegram_chat_id"', (err, telegramColumns) => {
              if (err) {
                connection.release();
                return callback(err);
              }
              if (telegramColumns.length === 0) {
                connection.query('ALTER TABLE branches ADD COLUMN telegram_chat_id VARCHAR(50)', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                });
              }
              connection.query('SELECT * FROM branches', (err, branches) => {
                if (err) {
                  connection.release();
                  return callback(err);
                }
                if (branches.length === 0) {
                  const insertBranches = [
                    ['BOODAI PIZZA', '-1002311447135'],
                    ['Район', '-1002638475628'],
                    ['Араванский', '-1002311447135'],
                    ['Ошский район', '-1002638475628'],
                  ];
                  let inserted = 0;
                  insertBranches.forEach(([name, telegram_chat_id]) => {
                    connection.query(
                      'INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)',
                      [name, telegram_chat_id],
                      (err) => {
                        if (err) {
                          connection.release();
                          return callback(err);
                        }
                        inserted++;
                        if (inserted === insertBranches.length) continueInitialization();
                      }
                    );
                  });
                } else {
                  const updateQueries = [
                    ['Араванская', '-1003355571066'],
                  
                  ];
                  // Также обновляем филиал с id=3 (Араванская) напрямую
                  const updateById = [
                    [3, '-1003355571066'], // id филиала, chat_id
                  ];
                  let updated = 0;
                  const totalUpdates = updateQueries.length + updateById.length;
                  
                  updateQueries.forEach(([name, telegram_chat_id]) => {
                    // Обновляем chat_id для указанных филиалов всегда (даже если уже установлен)
                    connection.query(
                      'UPDATE branches SET telegram_chat_id = ? WHERE name = ?',
                      [telegram_chat_id, name],
                      (err) => {
                        if (err) {
                          connection.release();
                          return callback(err);
                        }
                        updated++;
                        if (updated === totalUpdates) continueInitialization();
                      }
                    );
                  });
                  
                  updateById.forEach(([id, telegram_chat_id]) => {
                    // Обновляем chat_id по id филиала
                    connection.query(
                      'UPDATE branches SET telegram_chat_id = ? WHERE id = ?',
                      [telegram_chat_id, id],
                      (err) => {
                        if (err) {
                          connection.release();
                          return callback(err);
                        }
                        updated++;
                        if (updated === totalUpdates) continueInitialization();
                      }
                    );
                  });
                }
              });
            });
          });
        });
        function continueInitialization() {
          connection.query('SELECT id, name, telegram_chat_id FROM branches', (err, branches) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            connection.query('SHOW COLUMNS FROM products', (err, productColumns) => {
              if (err) {
                connection.release();
                return callback(err);
              }
              const columns = productColumns.map(col => col.Field);
              let totalChecks = 0;
              const totalNeeded = 6; // 3 для product + 3 для size
              const checkAllDone = () => {
                totalChecks++;
                if (totalChecks === totalNeeded) {
                  createSubcategoriesTable();
                }
              };
              if (!columns.includes('mini_recipe')) {
                connection.query('ALTER TABLE products ADD COLUMN mini_recipe TEXT', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                  checkAllDone();
                });
              } else {
                checkAllDone();
              }
              if (!columns.includes('sub_category_id')) {
                connection.query('ALTER TABLE products ADD COLUMN sub_category_id INT', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                  checkAllDone();
                });
              } else {
                checkAllDone();
              }
              if (!columns.includes('is_pizza')) {
                connection.query('ALTER TABLE products ADD COLUMN is_pizza BOOLEAN DEFAULT FALSE', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                  checkAllDone();
                });
              } else {
                checkAllDone();
              }
              // Добавляем поля размеров для пицц
              if (!columns.includes('size_small')) {
                connection.query('ALTER TABLE products ADD COLUMN size_small INT DEFAULT NULL', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                  checkAllDone();
                });
              } else {
                checkAllDone();
              }
              if (!columns.includes('size_medium')) {
                connection.query('ALTER TABLE products ADD COLUMN size_medium INT DEFAULT NULL', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                  checkAllDone();
                });
              } else {
                checkAllDone();
              }
              if (!columns.includes('size_large')) {
                connection.query('ALTER TABLE products ADD COLUMN size_large INT DEFAULT NULL', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                  checkAllDone();
                });
              } else {
                checkAllDone();
              }
            });
          });
        }
        function createSubcategoriesTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS subcategories (
              id INT AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(255) NOT NULL,
              category_id INT NOT NULL,
              FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            createPromoCodesTable();
          });
        }
        function createPromoCodesTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS promo_codes (
              id INT AUTO_INCREMENT PRIMARY KEY,
              code VARCHAR(50) NOT NULL UNIQUE,
              discount_percent INT NOT NULL,
              expires_at TIMESTAMP NULL DEFAULT NULL,
              is_active BOOLEAN DEFAULT TRUE,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            createOrdersTable();
          });
        }
        function createOrdersTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS orders (
              id INT AUTO_INCREMENT PRIMARY KEY,
              branch_id INT NOT NULL,
              total DECIMAL(10,2) NOT NULL,
              status ENUM('pending', 'processing', 'completed', 'cancelled') DEFAULT 'pending',
              order_details JSON,
              delivery_details JSON,
              cart_items JSON,
              discount INT DEFAULT 0,
              promo_code VARCHAR(50),
              cashback_used DECIMAL(10,2) DEFAULT 0,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            connection.query('SHOW COLUMNS FROM orders LIKE "cashback_used"', (err, columns) => {
              if (err) {
                connection.release();
                return callback(err);
              }
              if (columns.length === 0) {
                connection.query('ALTER TABLE orders ADD COLUMN cashback_used DECIMAL(10,2) DEFAULT 0', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                  createCashbackTables();
                });
              } else {
                createCashbackTables();
              }
            });
          });
        }
        function createCashbackTables() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS cashback_balance (
              id INT AUTO_INCREMENT PRIMARY KEY,
              phone VARCHAR(20) NOT NULL UNIQUE,
              balance DECIMAL(10,2) DEFAULT 0,
              total_earned DECIMAL(10,2) DEFAULT 0,
              total_spent DECIMAL(10,2) DEFAULT 0,
              user_level ENUM('bronze', 'silver', 'gold', 'platinum') DEFAULT 'bronze',
              total_orders INT DEFAULT 0,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            connection.query(`
              CREATE TABLE IF NOT EXISTS cashback_transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                phone VARCHAR(20) NOT NULL,
                order_id INT,
                type ENUM('earned', 'spent', 'expired') NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_phone (phone),
                INDEX idx_order_id (order_id)
              )
            `, (err) => {
              if (err) {
                connection.release();
                return callback(err);
              }
              createUDSTables();
            });
          });
        }
        function createUDSTables() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS uds_balance (
              id INT AUTO_INCREMENT PRIMARY KEY,
              phone VARCHAR(20) NOT NULL UNIQUE,
              balance INT DEFAULT 0,
              total_earned INT DEFAULT 0,
              total_spent INT DEFAULT 0,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            connection.query(`
              CREATE TABLE IF NOT EXISTS uds_transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                phone VARCHAR(20) NOT NULL,
                order_id INT,
                type ENUM('earned', 'spent', 'expired') NOT NULL,
                amount INT NOT NULL,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_phone (phone),
                INDEX idx_order_id (order_id)
              )
            `, (err) => {
              if (err) {
                connection.release();
                return callback(err);
              }
              createNotificationsTable();
            });
          });
        }
        function createNotificationsTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS notifications (
              id INT AUTO_INCREMENT PRIMARY KEY,
              user_id INT,
              type ENUM('discount', 'promotion', 'order', 'cashback', 'general') NOT NULL DEFAULT 'general',
              title VARCHAR(255) NOT NULL,
              message TEXT NOT NULL,
              image_url VARCHAR(500),
              action_url VARCHAR(500),
              data JSON,
              is_read BOOLEAN DEFAULT FALSE,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              INDEX idx_user_id (user_id),
              INDEX idx_is_read (is_read),
              INDEX idx_created_at (created_at),
              FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            createGiftTable();
          });
        }
        function createGiftTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS gift_opened (
              id INT AUTO_INCREMENT PRIMARY KEY,
              user_id INT NOT NULL,
              opened_date DATE NOT NULL,
              prize_type VARCHAR(50) NOT NULL,
              prize_description TEXT,
              amount DECIMAL(10,2),
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              UNIQUE KEY unique_user_date (user_id, opened_date),
              INDEX idx_user_id (user_id),
              INDEX idx_opened_date (opened_date),
              FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            createUsersTable();
          });
        }
        function createUsersTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS app_users (
              id INT AUTO_INCREMENT PRIMARY KEY,
              phone VARCHAR(20) NOT NULL UNIQUE,
              last_qr_cashback_date DATE,
              name VARCHAR(100),
              address TEXT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              INDEX idx_phone (phone)
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            connection.query('SHOW COLUMNS FROM app_users LIKE "address"', (err, columns) => {
              if (err) {
                connection.release();
                return callback(err);
              }
              if (columns.length === 0) {
                connection.query('ALTER TABLE app_users ADD COLUMN address TEXT', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                });
              }
              // Проверяем наличие поля user_code
              connection.query('SHOW COLUMNS FROM app_users LIKE "user_code"', (err, userCodeColumns) => {
                if (err) {
                  connection.release();
                  return callback(err);
                }
                if (userCodeColumns.length === 0) {
                  connection.query('ALTER TABLE app_users ADD COLUMN user_code VARCHAR(6)', (err) => {
                    if (err) {
                      connection.release();
                      return callback(err);
                    }
                  });
                }
                // Проверяем наличие поля last_qr_cashback_date
                connection.query('SHOW COLUMNS FROM app_users LIKE "last_qr_cashback_date"', (err, cashbackColumns) => {
                    if (err) {
                      connection.release();
                      return callback(err);
                    }
                    if (cashbackColumns.length === 0) {
                      connection.query('ALTER TABLE app_users ADD COLUMN last_qr_cashback_date DATE', (err) => {
                        if (err) {
                          connection.release();
                          return callback(err);
                        }
                        // Проверяем наличие поля referrer_id
                        connection.query('SHOW COLUMNS FROM app_users LIKE "referrer_id"', (err, referrerColumns) => {
                          if (err) {
                            connection.release();
                            return callback(err);
                          }
                          if (referrerColumns.length === 0) {
                            connection.query('ALTER TABLE app_users ADD COLUMN referrer_id INT NULL, ADD INDEX idx_referrer_id (referrer_id)', (err) => {
                              if (err) {
                                connection.release();
                                return callback(err);
                              }
                              createStoriesTable();
                            });
                          } else {
                            createStoriesTable();
                          }
                        });
                      });
                    } else {
                      // Проверяем наличие поля referrer_id
                      connection.query('SHOW COLUMNS FROM app_users LIKE "referrer_id"', (err, referrerColumns) => {
                        if (err) {
                          connection.release();
                          return callback(err);
                        }
                        if (referrerColumns.length === 0) {
                          connection.query('ALTER TABLE app_users ADD COLUMN referrer_id INT NULL, ADD INDEX idx_referrer_id (referrer_id)', (err) => {
                            if (err) {
                              connection.release();
                              return callback(err);
                            }
                            createStoriesTable();
                          });
                        } else {
                          createStoriesTable();
                        }
                      });
                    }
                  });
                });
            });
          });
        }
        function createStoriesTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS stories (
              id INT AUTO_INCREMENT PRIMARY KEY,
              image VARCHAR(255) NOT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            createDiscountsTable();
          });
        }
        function createDiscountsTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS discounts (
              id INT AUTO_INCREMENT PRIMARY KEY,
              product_id INT NOT NULL,
              discount_percent INT NOT NULL,
              expires_at TIMESTAMP NULL DEFAULT NULL,
              is_active BOOLEAN DEFAULT TRUE,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            createBannersTable();
          });
        }
        function createBannersTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS banners (
              id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
              image VARCHAR(255) NOT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              title VARCHAR(255) DEFAULT NULL,
              description TEXT DEFAULT NULL,
              button_text VARCHAR(100) DEFAULT NULL,
              promo_code_id INT DEFAULT NULL,
              FOREIGN KEY (promo_code_id) REFERENCES promo_codes(id) ON DELETE SET NULL
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            createSaucesTable();
          });
        }
        function createSaucesTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS sauces (
              id INT AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(255) NOT NULL,
              price DECIMAL(10,2) NOT NULL,
              image VARCHAR(255) DEFAULT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            createProductsSaucesTable();
          });
        }
        function createProductsSaucesTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS products_sauces (
              product_id INT NOT NULL,
              sauce_id INT NOT NULL,
              PRIMARY KEY (product_id, sauce_id),
              FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
              FOREIGN KEY (sauce_id) REFERENCES sauces(id) ON DELETE CASCADE
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            createProductPromoCodesTable();
          });
        }
        function createProductPromoCodesTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS product_promo_codes (
              id INT AUTO_INCREMENT PRIMARY KEY,
              product_id INT NOT NULL,
              promo_code_id INT NOT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
              FOREIGN KEY (promo_code_id) REFERENCES promo_codes(id) ON DELETE CASCADE,
              UNIQUE KEY unique_product_promo (product_id, promo_code_id)
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            createNewsTable();
          });
        }
        function createNewsTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS news (
              id INT AUTO_INCREMENT PRIMARY KEY,
              title VARCHAR(255) NOT NULL,
              content TEXT NOT NULL,
              image VARCHAR(500),
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            createPromotionsTable();
          });
        }
        function createPromotionsTable() {
          connection.query(`
            CREATE TABLE IF NOT EXISTS promotions (
              id INT AUTO_INCREMENT PRIMARY KEY,
              title VARCHAR(255) NOT NULL,
              description TEXT NOT NULL,
              image VARCHAR(500),
              promo_code_id INT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              FOREIGN KEY (promo_code_id) REFERENCES promo_codes(id) ON DELETE SET NULL
            )
          `, (err) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            addDiscountColumns();
          });
        }
        function addDiscountColumns() {
          connection.query('SHOW COLUMNS FROM discounts', (err, discountColumns) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            const discountFields = discountColumns.map(col => col.Field);
            let discountAlterations = 0;
            const checkDiscountAlterations = () => {
              discountAlterations++;
              if (discountAlterations === 2) createAdminUser();
            };
            if (!discountFields.includes('expires_at')) {
              connection.query('ALTER TABLE discounts ADD COLUMN expires_at TIMESTAMP NULL DEFAULT NULL', (err) => {
                if (err) {
                  connection.release();
                  return callback(err);
                }
                checkDiscountAlterations();
              });
            } else {
              checkDiscountAlterations();
            }
            if (!discountFields.includes('is_active')) {
              connection.query('ALTER TABLE discounts ADD COLUMN is_active BOOLEAN DEFAULT TRUE', (err) => {
                if (err) {
                  connection.release();
                  return callback(err);
                }
                checkDiscountAlterations();
              });
            } else {
              checkDiscountAlterations();
            }
          });
        }
        function createAdminUser() {
          connection.query('SELECT * FROM users WHERE email = ?', ['admin@ameranpizza.com'], (err, users) => {
            if (err) {
              connection.release();
              return callback(err);
            }
            if (users.length === 0) {
              bcrypt.hash('admin123', 10, (err, hashedPassword) => {
                if (err) {
                  connection.release();
                  return callback(err);
                }
                connection.query(
                  'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
                  ['Admin', 'admin@ameranpizza.com', hashedPassword],
                  (err) => {
                    if (err) {
                      connection.release();
                      return callback(err);
                    }
                    connection.release();
                    testS3Connection(callback);
                  }
                );
              });
            } else {
              connection.release();
              testS3Connection(callback);
            }
          });
        }
      });
    });
  }
  attemptConnection();
}

app.get('/api/public/branches', (req, res) => {
  // Убрана фильтрация по country для упрощения загрузки филиалов
  const query = 'SELECT id, name, address FROM branches ORDER BY name';
  
  db.query(query, [], (err, branches) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(branches);
  });
});

app.get('/api/public/branches/:branchId/products', (req, res) => {
  const { branchId } = req.params;
  const branchIdNum = parseInt(branchId);
  // Первый филиал с товарами имеет id = 7, второй филиал id = 8
  // Если запрашивается второй филиал (8), показываем товары из первого филиала (7) тоже
  const firstBranchId = 7;
  const secondBranchId = 8;
  
  // Формируем условие: если запрашивается второй филиал, добавляем товары первого филиала
  let whereCondition = 'p.branch_id = ?';
  let queryParams = [branchId];
  
  if (branchIdNum === secondBranchId) {
    whereCondition = '(p.branch_id = ? OR p.branch_id = ?)';
    queryParams = [branchId, firstBranchId];
  }
  
  db.query(`
    SELECT p.id, p.name, p.description, p.price_small, p.price_medium, p.price_large,
           p.price_single AS price, p.size_small, p.size_medium, p.size_large,
           p.image AS image_url, c.name AS category,
           d.discount_percent, d.expires_at,
           COALESCE(
             (SELECT JSON_ARRAYAGG(
               JSON_OBJECT(
                 'id', s.id,
                 'name', s.name,
                 'price', s.price,
                 'image', s.image
               )
             )
             FROM products_sauces ps
             LEFT JOIN sauces s ON ps.sauce_id = s.id
             WHERE ps.product_id = p.id AND s.id IS NOT NULL),
             '[]'
           ) as sauces
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN discounts d ON p.id = d.product_id AND d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
    WHERE ${whereCondition}
    GROUP BY p.id
  `, queryParams, (err, products) => {
    if (err) {
      const timestamp = new Date().toISOString();
      console.error(`❌ [${timestamp}] Ошибка получения продуктов для филиала ${branchId}:`, err.message);
      return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    }
    
    const parsedProducts = products.map(product => {
      let sauces = [];
      try {
        if (product.sauces) {
          const parsed = typeof product.sauces === 'string' 
            ? JSON.parse(product.sauces) 
            : product.sauces;
          sauces = Array.isArray(parsed) 
            ? parsed.filter(s => s && s.id) 
            : [];
        }
      } catch (e) {
        console.error('Ошибка парсинга соусов для продукта', product.id, ':', e);
        sauces = [];
      }
      
      return {
        ...product,
        sauces: sauces
      };
    });
    
    res.json(parsedProducts);
  });
});

// Публичный endpoint для получения всех соусов с фильтрацией и поиском
app.get('/api/public/sauces', (req, res) => {
  const { search, sort = 'name', order = 'ASC', limit, offset, branchId } = req.query;
  
  // Валидация параметров сортировки
  const validSortFields = ['name', 'price', 'created_at'];
  const validOrders = ['ASC', 'DESC'];
  const sortField = validSortFields.includes(sort) ? sort : 'name';
  const sortOrder = validOrders.includes(order.toUpperCase()) ? order.toUpperCase() : 'ASC';
  
  // Построение запроса
  let query = 'SELECT s.id, s.name, s.price, s.image, s.created_at';
  let whereConditions = [];
  let queryParams = [];
  
  // Поиск по названию
  if (search) {
    whereConditions.push('s.name LIKE ?');
    queryParams.push(`%${search}%`);
  }
  
  // Фильтрация по филиалу (соусы доступные для продуктов филиала)
  if (branchId) {
    query += `, COUNT(DISTINCT ps.product_id) as usage_count`;
    query += ` FROM sauces s`;
    query += ` LEFT JOIN products_sauces ps ON s.id = ps.sauce_id`;
    query += ` LEFT JOIN products p ON ps.product_id = p.id`;
    if (whereConditions.length > 0) {
      query += ` WHERE ${whereConditions.join(' AND ')} AND (p.branch_id = ? OR p.branch_id IS NULL)`;
    } else {
      query += ` WHERE (p.branch_id = ? OR p.branch_id IS NULL)`;
    }
    queryParams.push(branchId);
    query += ` GROUP BY s.id`;
  } else {
    query += ` FROM sauces s`;
    if (whereConditions.length > 0) {
      query += ` WHERE ${whereConditions.join(' AND ')}`;
    }
  }
  
  // Сортировка
  query += ` ORDER BY s.${sortField} ${sortOrder}`;
  
  // Пагинация
  if (limit) {
    const limitNum = parseInt(limit) || 50;
    const offsetNum = parseInt(offset) || 0;
    query += ` LIMIT ? OFFSET ?`;
    queryParams.push(limitNum, offsetNum);
  }
  
  db.query(query, queryParams, (err, sauces) => {
    if (err) {
      console.error('Ошибка получения соусов:', err);
      return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    }
    
    if (!sauces || sauces.length === 0) {
      return res.json({
        sauces: [],
        total: 0,
        limit: limit ? parseInt(limit) : null,
        offset: offset ? parseInt(offset) : null
      });
    }
    
    const saucesWithUrls = sauces.map(sauce => ({
      id: sauce.id,
      name: sauce.name || '',
      price: parseFloat(sauce.price) || 0,
      image: sauce.image ? `https://nukesul-brepb-651f.twc1.net/product-image/${sauce.image.split('/').pop()}` : null,
      created_at: sauce.created_at,
      ...(sauce.usage_count !== undefined && { usage_count: sauce.usage_count })
    }));
    
    // Получаем общее количество для пагинации
    if (limit || search || branchId) {
      let countQuery = 'SELECT COUNT(DISTINCT s.id) as total FROM sauces s';
      let countParams = [];
      
      if (branchId) {
        countQuery += ` LEFT JOIN products_sauces ps ON s.id = ps.sauce_id`;
        countQuery += ` LEFT JOIN products p ON ps.product_id = p.id`;
      }
      
      if (search || branchId) {
        countQuery += ' WHERE ';
        let countConditions = [];
        if (search) {
          countConditions.push('s.name LIKE ?');
          countParams.push(`%${search}%`);
        }
        if (branchId) {
          countConditions.push('(p.branch_id = ? OR p.branch_id IS NULL)');
          countParams.push(branchId);
        }
        countQuery += countConditions.join(' AND ');
      }
      
      db.query(countQuery, countParams, (countErr, countResult) => {
        if (countErr) {
          console.error('Ошибка подсчета соусов:', countErr);
          return res.json({
            sauces: saucesWithUrls,
            total: saucesWithUrls.length,
            limit: limit ? parseInt(limit) : null,
            offset: offset ? parseInt(offset) : null
          });
        }
        
        res.json({
          sauces: saucesWithUrls,
          total: countResult[0].total || saucesWithUrls.length,
          limit: limit ? parseInt(limit) : null,
          offset: offset ? parseInt(offset) : null
        });
      });
    } else {
      res.json(saucesWithUrls);
    }
  });
});

// Публичный endpoint для получения соусов конкретного продукта
app.get('/api/public/products/:productId/sauces', (req, res) => {
  const { productId } = req.params;
  const { sort = 'name', order = 'ASC' } = req.query;
  
  // Валидация productId
  if (!productId || isNaN(parseInt(productId))) {
    return res.status(400).json({ error: 'Некорректный ID продукта' });
  }
  
  // Валидация параметров сортировки
  const validSortFields = ['name', 'price'];
  const validOrders = ['ASC', 'DESC'];
  const sortField = validSortFields.includes(sort) ? sort : 'name';
  const sortOrder = validOrders.includes(order.toUpperCase()) ? order.toUpperCase() : 'ASC';
  
  db.query(`
    SELECT s.id, s.name, s.price, s.image, s.created_at
    FROM products_sauces ps
    LEFT JOIN sauces s ON ps.sauce_id = s.id
    WHERE ps.product_id = ? AND s.id IS NOT NULL
    ORDER BY s.${sortField} ${sortOrder}
  `, [productId], (err, sauces) => {
    if (err) {
      console.error('Ошибка получения соусов продукта:', err);
      return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    }
    
    if (!sauces || sauces.length === 0) {
      return res.json([]);
    }
    
    const saucesWithUrls = sauces.map(sauce => ({
      id: sauce.id,
      name: sauce.name || '',
      price: parseFloat(sauce.price) || 0,
      image: sauce.image ? `https://nukesul-brepb-651f.twc1.net/product-image/${sauce.image.split('/').pop()}` : null,
      created_at: sauce.created_at
    }));
    
    res.json(saucesWithUrls);
  });
});

// Публичный endpoint для получения соусов по филиалу
app.get('/api/public/branches/:branchId/sauces', (req, res) => {
  const { branchId } = req.params;
  const { search, sort = 'name', order = 'ASC' } = req.query;
  
  // Валидация branchId
  if (!branchId || isNaN(parseInt(branchId))) {
    return res.status(400).json({ error: 'Некорректный ID филиала' });
  }
  
  const branchIdNum = parseInt(branchId);
  // Первый филиал с товарами имеет id = 7, второй филиал id = 8
  const firstBranchId = 7;
  const secondBranchId = 8;
  
  // Валидация параметров сортировки
  const validSortFields = ['name', 'price', 'usage_count'];
  const validOrders = ['ASC', 'DESC'];
  const sortField = validSortFields.includes(sort) ? sort : 'name';
  const sortOrder = validOrders.includes(order.toUpperCase()) ? order.toUpperCase() : 'ASC';
  
  // Формируем условие: если запрашивается второй филиал, добавляем соусы из товаров первого филиала
  let whereCondition = 'p.branch_id = ?';
  let queryParams = [branchId];
  
  if (branchIdNum === secondBranchId) {
    whereCondition = '(p.branch_id = ? OR p.branch_id = ?)';
    queryParams = [branchId, firstBranchId];
  }
  
  let query = `
    SELECT DISTINCT s.id, s.name, s.price, s.image, s.created_at,
           COUNT(DISTINCT ps.product_id) as usage_count
    FROM sauces s
    INNER JOIN products_sauces ps ON s.id = ps.sauce_id
    INNER JOIN products p ON ps.product_id = p.id
    WHERE ${whereCondition}
  `;
  
  // Поиск по названию
  if (search) {
    query += ` AND s.name LIKE ?`;
    queryParams.push(`%${search}%`);
  }
  
  query += ` GROUP BY s.id`;
  // Безопасная сортировка
  if (sortField === 'usage_count') {
    query += ` ORDER BY usage_count ${sortOrder}`;
  } else {
    query += ` ORDER BY s.${sortField} ${sortOrder}`;
  }
  
  db.query(query, queryParams, (err, sauces) => {
    if (err) {
      console.error('Ошибка получения соусов филиала:', err);
      return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    }
    
    if (!sauces || sauces.length === 0) {
      return res.json([]);
    }
    
    const saucesWithUrls = sauces.map(sauce => ({
      id: sauce.id,
      name: sauce.name || '',
      price: parseFloat(sauce.price) || 0,
      image: sauce.image ? `https://nukesul-brepb-651f.twc1.net/product-image/${sauce.image.split('/').pop()}` : null,
      created_at: sauce.created_at,
      usage_count: sauce.usage_count || 0
    }));
    
    res.json(saucesWithUrls);
  });
});

// Публичный endpoint для получения популярных соусов
app.get('/api/public/sauces/popular', (req, res) => {
  const { limit = 10, branchId } = req.query;
  const limitNum = Math.min(parseInt(limit) || 10, 50);
  
  let query = `
    SELECT s.id, s.name, s.price, s.image, s.created_at,
           COUNT(DISTINCT ps.product_id) as usage_count
    FROM sauces s
    INNER JOIN products_sauces ps ON s.id = ps.sauce_id
  `;
  let queryParams = [];
  
  if (branchId) {
    query += ` INNER JOIN products p ON ps.product_id = p.id WHERE p.branch_id = ?`;
    queryParams.push(branchId);
  }
  
  query += ` GROUP BY s.id`;
  query += ` ORDER BY usage_count DESC, s.name ASC`;
  query += ` LIMIT ?`;
  queryParams.push(limitNum);
  
  db.query(query, queryParams, (err, sauces) => {
    if (err) {
      console.error('Ошибка получения популярных соусов:', err);
      return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    }
    
    if (!sauces || sauces.length === 0) {
      return res.json([]);
    }
    
    const saucesWithUrls = sauces.map(sauce => ({
      id: sauce.id,
      name: sauce.name || '',
      price: parseFloat(sauce.price) || 0,
      image: sauce.image ? `https://nukesul-brepb-651f.twc1.net/product-image/${sauce.image.split('/').pop()}` : null,
      created_at: sauce.created_at,
      usage_count: sauce.usage_count || 0
    }));
    
    res.json(saucesWithUrls);
  });
});

app.get('/api/public/branches/:branchId/orders', (req, res) => {
  const { branchId } = req.params;
  db.query(`
    SELECT id, total, created_at, status
    FROM orders
    WHERE branch_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `, [branchId], (err, orders) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(orders);
  });
});

app.get('/api/public/stories', (req, res) => {
  db.query('SELECT * FROM stories', (err, stories) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    const storiesWithUrls = stories.map(story => ({
      ...story,
      image: `https://vasya010-red-bdf5.twc1.net/product-image/${story.image.split('/').pop()}`
    }));
    res.json(storiesWithUrls);
  });
});

app.get('/api/public/banners', (req, res) => {
  db.query(`
    SELECT b.id, b.image, b.created_at, b.title, b.description, b.button_text,
           pc.code AS promo_code, pc.discount_percent
    FROM banners b
    LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
    WHERE pc.is_active = TRUE OR pc.id IS NULL
  `, (err, banners) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    const bannersWithUrls = banners.map(banner => ({
      ...banner,
      image: `https://vasya010-red-bdf5.twc1.net/product-image/${banner.image.split('/').pop()}`
    }));
    res.json(bannersWithUrls);
  });
});

app.post('/api/public/validate-promo', (req, res) => {
  const { promoCode } = req.body;
  
  // Валидация входных данных
  if (!promoCode) {
    return res.status(400).json({ error: 'Промокод не указан' });
  }
  
  if (typeof promoCode !== 'string' || promoCode.trim().length === 0) {
    return res.status(400).json({ error: 'Промокод должен быть непустой строкой' });
  }
  
  const cleanPromoCode = promoCode.trim().toUpperCase();
  
  db.query(`
    SELECT discount_percent AS discount, code, expires_at, is_active
    FROM promo_codes
    WHERE code = ?
  `, [cleanPromoCode], (err, promo) => {
    if (err) {
      console.error('Ошибка проверки промокода:', err);
      return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    }
    
    if (promo.length === 0) {
      return res.status(400).json({ error: 'Промокод не найден' });
    }
    
    const promoData = promo[0];
    
    // Проверка активности
    if (!promoData.is_active) {
      return res.status(400).json({ error: 'Промокод неактивен' });
    }
    
    // Проверка срока действия
    if (promoData.expires_at && new Date(promoData.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Промокод истек' });
    }
    
    res.json({ discount: promoData.discount });
  });
});

app.post('/api/public/send-order', optionalAuthenticateToken, (req, res) => {
  const { orderDetails, deliveryDetails, cartItems, discount, promoCode, branchId, paymentMethod, cashbackUsed } = req.body;
  if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: 'Корзина пуста или содержит некорректные данные' });
  }
  if (!branchId) {
    return res.status(400).json({ error: 'Не указан филиал (branchId отсутствует)' });
  }
  
  const userId = req.user?.id; // Получаем ID пользователя из токена (если есть)
  const phone = orderDetails.phone || deliveryDetails.phone;
  
  // Получаем телефон и код пользователя из базы, если авторизован
  const getUserData = (callback) => {
    if (!userId) {
      return callback({ phone, userCode: null });
    }
    db.query('SELECT phone, user_code FROM app_users WHERE id = ?', [userId], (err, users) => {
      if (err || users.length === 0) {
        return callback({ phone, userCode: null });
      }
      callback({ phone: users[0].phone, userCode: users[0].user_code || null });
    });
  };
  
  db.query('SELECT name, telegram_chat_id FROM branches WHERE id = ?', [branchId], (err, branch) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (branch.length === 0) return res.status(400).json({ error: `Филиал с id ${branchId} не найден` });
    const branchName = branch[0].name;
    const chatId = branch[0].telegram_chat_id;
    if (!chatId) {
      return res.status(500).json({
        error: `Для филиала "${branchName}" не настроен Telegram chat ID. Пожалуйста, свяжитесь с администратором для настройки.`,
      });
    }
    
    const total = cartItems.reduce((sum, item) => sum + (Number(item.originalPrice ?? item.price) || 0) * (item.quantity || 0), 0);
    const discountedTotal = total * (1 - (discount || 0) / 100);
    
    const escapeMarkdown = (text) => (text ? text.replace(/([_*[\]()~`>#+-.!])/g, '\\$1') : 'Нет');
    const paymentMethodText = paymentMethod === 'cash' ? 'Наличными' : paymentMethod === 'card' ? 'Картой' : 'Не указан';
    
    // Получаем данные пользователя и обрабатываем заказ
    getUserData((userData) => {
      const userPhone = userData.phone;
      const userCode = userData.userCode;
      
      // Использование кешбэка
      const cashbackUsedAmount = Math.min(parseFloat(cashbackUsed || 0), discountedTotal);
      let finalTotal = Math.max(0, discountedTotal - cashbackUsedAmount);
      
      // Начисление кешбэка 2% от итоговой суммы заказа (после списания)
      const cashbackEarned = userId && userPhone ? Math.round(finalTotal * 0.02 * 100) / 100 : 0;
      
      // Кешбэк будет обработан после создания заказа
      const processCashback = (callback) => callback();
    
    db.query(
      `
      INSERT INTO orders (branch_id, total, status, order_details, delivery_details, cart_items, discount, promo_code, cashback_used)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `,
      [
        branchId,
        finalTotal,
        JSON.stringify(orderDetails),
        JSON.stringify(deliveryDetails),
        JSON.stringify(cartItems),
        discount || 0,
        promoCode || null,
        cashbackUsedAmount,
      ],
      (err, result) => {
        const timestamp = new Date().toISOString();
        if (err) {
          console.error(`❌ [${timestamp}] Ошибка создания заказа:`, err.message);
          return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        }
        const orderId = result.insertId;
        
        console.log(`📦 [${timestamp}] Новый заказ создан: ID ${orderId}, Филиал: ${branchName}, Сумма: ${finalTotal} сом, Телефон: ${phone}`);
        
        // Списываем использованный кешбэк (только для авторизованных пользователей)
        if (cashbackUsedAmount > 0 && userPhone) {
          db.query(
            `UPDATE cashback_balance 
             SET balance = balance - ?, total_spent = total_spent + ?
             WHERE phone = ? AND balance >= ?`,
            [cashbackUsedAmount, cashbackUsedAmount, userPhone, cashbackUsedAmount],
            (err, result) => {
              if (err) {
                console.error(`❌ [${timestamp}] Ошибка списания кешбэка для ${userPhone}:`, err.message);
              } else if (result.affectedRows > 0) {
                // Записываем транзакцию списания
                db.query(
                  'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, ?, "spent", ?, ?)',
                  [userPhone, orderId, cashbackUsedAmount, `Использован кешбэк для заказа #${orderId}`],
                  (err) => {
                    if (err) {
                      console.error(`❌ [${timestamp}] Ошибка записи транзакции списания:`, err.message);
                    }
                  }
                );
                console.log(`💸 [${timestamp}] Списано ${cashbackUsedAmount.toFixed(2)} сом кешбэка пользователю ${userPhone} за заказ #${orderId}`);
              } else {
                console.warn(`⚠️ [${timestamp}] Недостаточно кешбэка для списания у пользователя ${userPhone}`);
              }
            }
          );
        }
        
        // Начисляем кешбэк 2% от суммы заказа (только для авторизованных пользователей)
        if (cashbackEarned > 0 && userPhone) {
          db.query(
            `INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level)
             VALUES (?, ?, ?, 1, 'bronze')
             ON DUPLICATE KEY UPDATE
             balance = balance + ?,
             total_earned = total_earned + ?,
             total_orders = total_orders + 1`,
            [userPhone, cashbackEarned, cashbackEarned, cashbackEarned, cashbackEarned],
            (err) => {
              if (err) {
                console.error(`❌ [${timestamp}] Ошибка начисления кешбэка для ${userPhone}:`, err.message);
              } else {
                // Записываем транзакцию начисления
                db.query(
                  'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, ?, "earned", ?, ?)',
                  [userPhone, orderId, cashbackEarned, `Кешбэк за заказ #${orderId} (2%)`],
                  (err) => {
                    if (err) {
                      console.error(`❌ [${timestamp}] Ошибка записи транзакции начисления:`, err.message);
                    }
                  }
                );
                console.log(`💰 [${timestamp}] Начислен кешбэк ${cashbackEarned.toFixed(2)} сом пользователю ${userPhone} за заказ #${orderId}`);
              }
            }
          );
        }
        
        // СРАЗУ возвращаем ответ клиенту (не ждем Telegram)
        res.status(200).json({ 
          message: 'Заказ успешно отправлен', 
          orderId: orderId,
          cashbackEarned: cashbackEarned,
          cashbackUsed: cashbackUsedAmount,
          total: finalTotal
        });
        
        // Формируем текст заказа с номером заказа
        const orderText = `
📦 *НОВЫЙ ЗАКАЗ С САЙТА*

🆔 *Номер заказа: #${orderId}*
🏪 Филиал: ${escapeMarkdown(branchName)}
👤 Имя: ${escapeMarkdown(orderDetails.name || deliveryDetails.name || "Не указано")}
📞 Телефон: ${escapeMarkdown(phone)}
🔑 Код клиента: ${escapeMarkdown(userCode || "—")}
📝 Комментарии: ${escapeMarkdown(orderDetails.comments || deliveryDetails.comments || "Нет")}
📍 Адрес доставки: ${escapeMarkdown(deliveryDetails.address || "Самовывоз")}
💳 Способ оплаты: ${escapeMarkdown(paymentMethodText)}

🛒 *Товары:*
${cartItems.map((item) => `• ${escapeMarkdown(item.name)} × ${item.quantity} шт. = ${fmt((Number(item.originalPrice ?? item.price) || 0) * item.quantity)} сом`).join('\n')}

💰 Сумма товаров: ${fmt(total)} сом
${discount > 0 ? `💸 Скидка (${discount}%): -${fmt(total * discount / 100)} сом` : ''}
${cashbackUsedAmount > 0 ? `🎁 Кешбэк использован: -${fmt(cashbackUsedAmount)} сом` : ''}
${cashbackEarned > 0 ? `✨ Кешбэк начислен: +${fmt(cashbackEarned)} сом` : ''}

💰 *ИТОГО: ${fmt(finalTotal)} сом*

⏰ ${new Date().toLocaleString('ru-RU', { 
  day: '2-digit', 
  month: '2-digit', 
  year: 'numeric', 
  hour: '2-digit', 
  minute: '2-digit' 
})}
        `;
        
        // Отправляем в Telegram МОМЕНТАЛЬНО и АСИНХРОННО (не блокируем ответ)
        sendTelegramMessageAsync(chatId, orderText, branchName);
        
        // Обрабатываем кешбэк параллельно (не блокируем отправку в Telegram)
        // Обновляем order_id в транзакциях кешбэка
        if (userId && userPhone && (cashbackUsedAmount > 0 || cashbackEarned > 0)) {
          db.query(
            'UPDATE cashback_transactions SET order_id = ? WHERE phone = ? AND order_id IS NULL ORDER BY created_at DESC LIMIT 2',
            [orderId, userPhone],
            () => {}
          );
        }
        processCashback(() => {
          // Кешбэк обработан, но это не блокирует отправку в Telegram
        });
      }
    );
    }); // Закрываем getUserPhone callback
  });
});

// Endpoint для синхронизации офлайн заказов (массовая отправка)
app.post('/api/public/sync-offline-orders', optionalAuthenticateToken, (req, res) => {
  const { orders } = req.body;
  
  if (!orders || !Array.isArray(orders) || orders.length === 0) {
    return res.status(400).json({ error: 'Не переданы заказы для синхронизации' });
  }

  const userId = req.user?.id;
  const results = [];
  let processedCount = 0;
  const totalOrders = orders.length;

  // Обрабатываем каждый заказ
  orders.forEach((orderData, index) => {
    const { 
      localOrderId, 
      branchId, 
      orderDetails, 
      deliveryDetails, 
      cartItems, 
      discount, 
      promoCode, 
      paymentMethod, 
      cashbackUsed 
    } = orderData;

    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      results.push({
        localOrderId: localOrderId || `order_${index}`,
        success: false,
        error: 'Корзина пуста'
      });
      processedCount++;
      if (processedCount === totalOrders) {
        return res.json({ results, synced: results.filter(r => r.success).length });
      }
      return;
    }

    if (!branchId) {
      results.push({
        localOrderId: localOrderId || `order_${index}`,
        success: false,
        error: 'Не указан филиал'
      });
      processedCount++;
      if (processedCount === totalOrders) {
        return res.json({ results, synced: results.filter(r => r.success).length });
      }
      return;
    }

    const phone = orderDetails?.phone || deliveryDetails?.phone;
    
    db.query('SELECT name, telegram_chat_id FROM branches WHERE id = ?', [branchId], (err, branch) => {
      if (err || branch.length === 0) {
        results.push({
          localOrderId: localOrderId || `order_${index}`,
          success: false,
          error: 'Филиал не найден'
        });
        processedCount++;
        if (processedCount === totalOrders) {
          return res.json({ results, synced: results.filter(r => r.success).length });
        }
        return;
      }

      const branchName = branch[0].name;
      const chatId = branch[0].telegram_chat_id;
      
      if (!chatId) {
        results.push({
          localOrderId: localOrderId || `order_${index}`,
          success: false,
          error: 'Telegram chat ID не настроен'
        });
        processedCount++;
        if (processedCount === totalOrders) {
          return res.json({ results, synced: results.filter(r => r.success).length });
        }
        return;
      }

      const total = cartItems.reduce((sum, item) => sum + (Number(item.originalPrice ?? item.price) || 0) * (item.quantity || 0), 0);
      const discountedTotal = total * (1 - (discount || 0) / 100);
      const cashbackUsedAmount = userId ? (Number(cashbackUsed) || 0) : 0;
      const cashbackEarned = userId ? Math.round(discountedTotal * 0.07) : 0;
      const finalTotal = Math.max(0, discountedTotal - cashbackUsedAmount);

      const escapeMarkdown = (text) => (text ? text.replace(/([_*[\]()~`>#+-.!])/g, '\\$1') : 'Нет');
      const paymentMethodText = paymentMethod === 'cash' ? 'Наличными' : paymentMethod === 'card' ? 'Картой' : 'Не указан';
      
      const orderText = `
📦 *Новый заказ (офлайн):*
🏪 Филиал: ${escapeMarkdown(branchName)}
👤 Имя: ${escapeMarkdown(orderDetails?.name || deliveryDetails?.name)}
📞 Телефон: ${escapeMarkdown(phone)}
📝 Комментарии: ${escapeMarkdown(orderDetails?.comments || deliveryDetails?.comments || "Нет")}
📍 Адрес доставки: ${escapeMarkdown(deliveryDetails?.address || "Самовывоз")}
💳 Способ оплаты: ${escapeMarkdown(paymentMethodText)}
🛒 *Товары:*
${cartItems.map((item) => `- ${escapeMarkdown(item.name)} (${item.quantity} шт. по ${item.originalPrice ?? item.price ?? 0} сом)`).join('\n')}
💰 Сумма товаров: ${fmt(total)} сом
${discount > 0 ? `💸 Скидка (${discount}%): -${fmt(total * discount / 100)} сом` : ''}
${cashbackUsedAmount > 0 ? `🎁 Кешбэк использован: -${fmt(cashbackUsedAmount)} сом` : ''}
${cashbackEarned > 0 ? `✨ Кешбэк начислен: +${fmt(cashbackEarned)} сом` : ''}
💰 *Итоговая сумма: ${fmt(finalTotal)} сом*
      `;

      db.query(
        `INSERT INTO orders (branch_id, total, status, order_details, delivery_details, cart_items, discount, promo_code, cashback_used)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        [
          branchId,
          finalTotal,
          JSON.stringify(orderDetails || {}),
          JSON.stringify(deliveryDetails || {}),
          JSON.stringify(cartItems),
          discount || 0,
          promoCode || null,
          cashbackUsedAmount,
        ],
        (err, result) => {
          if (err) {
            results.push({
              localOrderId: localOrderId || `order_${index}`,
              success: false,
              error: `Ошибка БД: ${err.message}`
            });
            processedCount++;
            if (processedCount === totalOrders) {
              return res.json({ results, synced: results.filter(r => r.success).length });
            }
            return;
          }

          const orderId = result.insertId;

          // Формируем улучшенный текст заказа с номером
          const improvedOrderText = `
📦 *НОВЫЙ ЗАКАЗ (ОФЛАЙН)*

🆔 *Номер заказа: #${orderId}*
🏪 Филиал: ${escapeMarkdown(branchName)}
👤 Имя: ${escapeMarkdown(orderDetails?.name || deliveryDetails?.name || "Не указано")}
📞 Телефон: ${escapeMarkdown(phone || "Не указан")}
📍 Адрес доставки: ${escapeMarkdown(deliveryDetails?.address || "Самовывоз")}
💳 Способ оплаты: ${escapeMarkdown(paymentMethodText)}

🛒 *Товары:*
${cartItems.map((item) => `• ${escapeMarkdown(item.name)} × ${item.quantity} шт. = ${fmt((Number(item.originalPrice ?? item.price) || 0) * item.quantity)} сом`).join('\n')}

💰 *ИТОГО: ${fmt(finalTotal)} сом*

⏰ ${new Date().toLocaleString('ru-RU', { 
  day: '2-digit', 
  month: '2-digit', 
  year: 'numeric', 
  hour: '2-digit', 
  minute: '2-digit' 
})}
          `;

          // Отправляем в Telegram асинхронно
          sendTelegramMessageAsync(chatId, improvedOrderText, branchName).then((telegramResult) => {
            results.push({
              localOrderId: localOrderId || `order_${index}`,
              success: true,
              orderId: orderId,
              cashbackEarned: cashbackEarned
            });
            processedCount++;
            
            if (processedCount === totalOrders) {
              return res.json({ 
                results, 
                synced: results.filter(r => r.success).length,
                total: totalOrders
              });
            }
          }).catch((error) => {
            // Заказ сохранен в БД, но Telegram не отправился - все равно успех
            const errorMsg = error.response?.data?.description || error.message;
            if (errorMsg && errorMsg.includes('chat not found')) {
              console.error(`⚠️ Telegram chat not found для филиала "${branchName}" (chat_id: ${chatId}). Убедитесь, что бот добавлен в чат/группу.`);
            }
            results.push({
              localOrderId: localOrderId || `order_${index}`,
              success: true,
              orderId: orderId,
              cashbackEarned: cashbackEarned,
              warning: 'Заказ сохранен, но не отправлен в Telegram'
            });
            processedCount++;
            
            if (processedCount === totalOrders) {
              return res.json({ 
                results, 
                synced: results.filter(r => r.success).length,
                total: totalOrders
              });
            }
          });
        }
      );
    });
  });
});

// Хранилище для SMS кодов (в продакшене использовать Redis или БД)
const smsCodes = new Map();

// Генерация 4-значного кода
function generateSMSCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Генерация 6-значного кода для пользователя
function generateUserCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Linko API credentials
const LINKO_API_LOGIN = 'API Сайт';
const LINKO_API_KEY = '882f446d5f6449d79667eb9eeb1c36ec';
const LINKO_API_URL = 'https://api.linko.ru/api/v1';

// Функция для работы с Linko API (скидки)
async function applyLinkoDiscount(userCode, orderAmount) {
  try {
    const response = await axios.post(
      `${LINKO_API_URL}/discounts/apply`,
      {
        user_code: userCode,
        amount: orderAmount,
      },
      {
        auth: {
          username: LINKO_API_LOGIN,
          password: LINKO_API_KEY,
        },
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Linko API error:', error.message);
    return null;
  }
}

// Функция отправки SMS через локальный SMS Gateway на сервере
async function sendSMS(phone, code) {
  try {
    if (!SMS_GATEWAY_URL || SMS_GATEWAY_URL === '') {
      return false;
    }

    const smsText = `Ваш код подтверждения для America Pizza: ${code}`;
    // Форматируем номер телефона (996XXXXXXXXX)
    let phoneFormatted = phone.replace(/\D/g, '');
    if (!phoneFormatted.startsWith('996')) {
      if (phoneFormatted.startsWith('0')) {
        phoneFormatted = '996' + phoneFormatted.substring(1);
      } else {
        phoneFormatted = '996' + phoneFormatted;
      }
    }

    const payload = {
      phone: phoneFormatted,
      message: smsText,
      code: code,
    };

    // Добавляем API ключ если есть
    if (SMS_GATEWAY_API_KEY && SMS_GATEWAY_API_KEY !== '') {
      payload.api_key = SMS_GATEWAY_API_KEY;
    }

    let response;
    if (SMS_GATEWAY_METHOD.toUpperCase() === 'GET') {
      const params = new URLSearchParams(payload);
      response = await axios.get(`${SMS_GATEWAY_URL}?${params.toString()}`);
    } else {
      response = await axios.post(SMS_GATEWAY_URL, payload, {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Проверяем успешность отправки
    if (response.status === 200) {
      const data = response.data;
      if (data.success === true || 
          data.status === 'success' || 
          data.status === 'sent' ||
          data.error === false) {
        console.log(`✅ SMS отправлено на +${phoneFormatted}`);
        return true;
      } else {
        console.error('❌ Ошибка отправки SMS:', data);
        return false;
      }
    }

    return false;
  } catch (error) {
    console.error('❌ Ошибка при отправке SMS:', error.message);
    if (error.response) {
      console.error('Детали:', error.response.data);
    }
    return false;
  }
}

// API для отправки SMS кода
app.post('/api/public/auth/send-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Телефон обязателен' });
  
  // Очищаем телефон от лишних символов
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 10) {
    return res.status(400).json({ error: 'Некорректный номер телефона' });
  }
  
  // Генерируем код
  const code = generateSMSCode();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 минут
  
  // Сохраняем код
  smsCodes.set(cleanPhone, { code, expiresAt });
  
  // Выводим код в консоль для отладки
  console.log(`\n=== SMS КОД ===`);
  console.log(`Телефон: +${cleanPhone}`);
  console.log(`Код: ${code}`);
  console.log(`Истекает через: 5 минут`);
  console.log(`================\n`);
  
  // Отправляем SMS через локальный gateway
  let smsSent = await sendSMS(cleanPhone, code);
  
  if (!smsSent) {
    console.log('⚠️ SMS не отправлено через gateway. Проверьте настройки SMS_GATEWAY_URL');
  }
  
  res.json({ 
    success: true,
    message: smsSent ? 'Код подтверждения отправлен на ваш номер' : 'Код подтверждения отправлен',
    // Для разработки возвращаем код (в продакшене убрать!)
    code: code, // Временно возвращаем код для тестирования
    phone: cleanPhone,
    smsSent: smsSent,
  });
});

// API для проверки SMS кода и входа/регистрации
app.post('/api/public/auth/verify-code', (req, res) => {
  const { phone, code, referral_code } = req.body;
  if (!phone || !code) {
    return res.status(400).json({ error: 'Телефон и код обязательны' });
  }
  
  // Очищаем телефон от лишних символов
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 10) {
    return res.status(400).json({ error: 'Некорректный номер телефона' });
  }
  
  // Проверяем код
  const stored = smsCodes.get(cleanPhone);
  if (!stored) {
    return res.status(400).json({ error: 'Код не найден. Запросите новый код.' });
  }
  
  if (Date.now() > stored.expiresAt) {
    smsCodes.delete(cleanPhone);
    return res.status(400).json({ error: 'Код истек. Запросите новый код.' });
  }
  
  if (stored.code !== code) {
    return res.status(400).json({ error: 'Неверный код подтверждения' });
  }
  
  // Код верный, удаляем его
  smsCodes.delete(cleanPhone);
  
  // Проверяем, существует ли пользователь
  db.query('SELECT * FROM app_users WHERE phone = ?', [cleanPhone], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    
    if (users.length === 0) {
      // Регистрация нового пользователя
      const userCode = generateUserCode();
      
      // Обрабатываем реферальный код
      const processReferral = (callback) => {
        if (!referral_code || !/^\d{6}$/.test(referral_code)) {
          return callback(null);
        }
        
        // Находим реферера по коду
        db.query('SELECT id, phone FROM app_users WHERE user_code = ?', [referral_code], (err, referrers) => {
          if (err) {
            console.error('Ошибка поиска реферера:', err);
            return callback(null);
          }
          
          if (referrers.length === 0) {
            // Реферальный код не найден, но продолжаем регистрацию
            return callback(null);
          }
          
          const referrer = referrers[0];
          const referrerId = referrer.id;
          const referrerPhone = referrer.phone;
          
          // Начисляем бонус рефереру (10 сом)
          const referralBonus = 10;
          const timestamp = new Date().toISOString();
          db.query(
            `INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level)
             VALUES (?, ?, ?, 0, 'bronze')
             ON DUPLICATE KEY UPDATE
             balance = balance + ?,
             total_earned = total_earned + ?`,
            [referrerPhone, referralBonus, referralBonus, referralBonus, referralBonus],
            (err) => {
              if (err) {
                console.error(`❌ [${timestamp}] Ошибка начисления бонуса рефереру ${referrerPhone}:`, err.message);
              } else {
                // Записываем транзакцию
                db.query(
                  'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, NULL, "earned", ?, ?)',
                  [referrerPhone, referralBonus, `Бонус за приглашение пользователя`],
                  () => {}
                );
                console.log(`💰 [${timestamp}] Начислен реферальный бонус ${referralBonus} сом рефереру ${referrerPhone} за приглашение пользователя ${cleanPhone}`);
              }
              callback(referrerId);
            }
          );
        });
      };
      
      processReferral((referrerId) => {
        // Регистрируем нового пользователя
        const insertQuery = referrerId 
          ? 'INSERT INTO app_users (phone, user_code, referrer_id) VALUES (?, ?, ?)'
          : 'INSERT INTO app_users (phone, user_code) VALUES (?, ?)';
        const insertParams = referrerId 
          ? [cleanPhone, userCode, referrerId]
          : [cleanPhone, userCode];
        
        db.query(insertQuery, insertParams, (err, result) => {
          const timestamp = new Date().toISOString();
          if (err) {
            console.error(`❌ [${timestamp}] Ошибка регистрации пользователя ${cleanPhone}:`, err.message);
            return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          }
          
          console.log(`✅ [${timestamp}] Новый пользователь зарегистрирован: ${cleanPhone}, ID: ${result.insertId}, Код: ${userCode}${referrerId ? `, Реферер ID: ${referrerId}` : ''}`);
          
          // Если пользователь зарегистрировался по реферальному коду, начисляем ему бонус
          if (referrerId) {
            const newUserBonus = 100; // Бонус для нового пользователя
            db.query(
              `INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level)
               VALUES (?, ?, ?, 0, 'bronze')
               ON DUPLICATE KEY UPDATE
               balance = balance + ?,
               total_earned = total_earned + ?`,
              [cleanPhone, newUserBonus, newUserBonus, newUserBonus, newUserBonus],
              (err) => {
                if (err) {
                  console.error(`❌ [${timestamp}] Ошибка начисления бонуса новому пользователю ${cleanPhone}:`, err.message);
                } else {
                  // Записываем транзакцию
                  db.query(
                    'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, NULL, "earned", ?, ?)',
                    [cleanPhone, newUserBonus, `Бонус за регистрацию по реферальному коду`],
                    () => {}
                  );
                  console.log(`💰 [${timestamp}] Начислен бонус ${newUserBonus} сом новому пользователю ${cleanPhone} за регистрацию по реферальному коду`);
                }
                
                const token = jwt.sign({ id: result.insertId, phone: cleanPhone }, JWT_SECRET, { expiresIn: '30d' });
                res.json({ 
                  token, 
                  user: { id: result.insertId, phone: cleanPhone, name: null, user_code: userCode },
                  isNewUser: true
                });
              }
            );
          } else {
            const token = jwt.sign({ id: result.insertId, phone: cleanPhone }, JWT_SECRET, { expiresIn: '30d' });
            res.json({ 
              token, 
              user: { id: result.insertId, phone: cleanPhone, name: null, user_code: userCode },
              isNewUser: true
            });
          }
        });
      });
    } else {
      // Вход существующего пользователя
      const user = users[0];
      const timestamp = new Date().toISOString();
      
      // Если у пользователя нет кода, генерируем его и ОБЯЗАТЕЛЬНО ждем сохранения
      if (!user.user_code) {
        const userCode = generateUserCode();
        console.log(`🔑 [${timestamp}] Генерация user_code для существующего пользователя ${user.phone}: ${userCode}`);
        
        db.query('UPDATE app_users SET user_code = ? WHERE id = ?', [userCode, user.id], (err) => {
          if (err) {
            console.error(`❌ [${timestamp}] Ошибка обновления user_code для пользователя ${user.id}:`, err.message);
            // Все равно возвращаем ответ, но без кода (он будет сгенерирован при следующем запросе)
            const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
            return res.json({ 
              token, 
              user: { id: user.id, phone: user.phone, name: user.name, user_code: null },
              isNewUser: false
            });
          }
          
          console.log(`✅ [${timestamp}] user_code успешно сохранен для пользователя ${user.phone}: ${userCode}`);
          user.user_code = userCode;
          
          console.log(`✅ [${timestamp}] Пользователь авторизован: ${user.phone}, ID: ${user.id}, Код: ${userCode}`);
          const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
          res.json({ 
            token, 
            user: { id: user.id, phone: user.phone, name: user.name, user_code: user.user_code },
            isNewUser: false
          });
        });
      } else {
        // Код уже есть, сразу возвращаем
        console.log(`✅ [${timestamp}] Пользователь авторизован: ${user.phone}, ID: ${user.id}, Код: ${user.user_code}`);
        const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ 
          token, 
          user: { id: user.id, phone: user.phone, name: user.name, user_code: user.user_code },
          isNewUser: false
        });
      }
    }
  });
});

// Health check endpoint (для проверки доступности сервера)
app.get('/api/public/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Сервер работает',
    timestamp: new Date().toISOString()
  });
});

// API для получения user_code пользователя
app.get('/api/public/user-code', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const timestamp = new Date().toISOString();
  
  // Функция для генерации уникального кода
  const generateUniqueUserCode = (callback, maxAttempts = 10) => {
    let attempts = 0;
    
    const tryGenerate = () => {
      attempts++;
      const userCode = generateUserCode();
      
      // Проверяем уникальность кода
      db.query('SELECT id FROM app_users WHERE user_code = ?', [userCode], (err, existing) => {
        if (err) {
          console.error(`❌ [${timestamp}] Ошибка проверки уникальности кода:`, err.message);
          return callback(err, null);
        }
        
        if (existing.length > 0) {
          // Код уже существует, пробуем снова
          if (attempts < maxAttempts) {
            console.log(`⚠️ [${timestamp}] Код ${userCode} уже существует, генерируем новый (попытка ${attempts}/${maxAttempts})`);
            return tryGenerate();
          } else {
            console.error(`❌ [${timestamp}] Не удалось сгенерировать уникальный код после ${maxAttempts} попыток`);
            return callback(new Error('Не удалось сгенерировать уникальный код'), null);
          }
        }
        
        // Код уникален, возвращаем его
        callback(null, userCode);
      });
    };
    
    tryGenerate();
  };
  
  db.query('SELECT user_code FROM app_users WHERE id = ?', [userId], (err, users) => {
    if (err) {
      console.error(`❌ [${timestamp}] Ошибка получения user_code для пользователя ${userId}:`, err.message);
      return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    }
    if (users.length === 0) {
      console.error(`❌ [${timestamp}] Пользователь ${userId} не найден`);
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    let userCode = users[0].user_code;
    
    // Если у пользователя нет кода, генерируем уникальный и ОБЯЗАТЕЛЬНО ждем сохранения
    if (!userCode) {
      console.log(`🔑 [${timestamp}] Генерация user_code для пользователя ${userId}`);
      
      generateUniqueUserCode((err, newUserCode) => {
        if (err) {
          console.error(`❌ [${timestamp}] Ошибка генерации уникального кода для пользователя ${userId}:`, err.message);
          return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        }
        
        userCode = newUserCode;
        console.log(`🔑 [${timestamp}] Сгенерирован уникальный user_code для пользователя ${userId}: ${userCode}`);
        
        db.query('UPDATE app_users SET user_code = ? WHERE id = ?', [userCode, userId], (err) => {
          if (err) {
            console.error(`❌ [${timestamp}] Ошибка обновления user_code для пользователя ${userId}:`, err.message);
            return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          }
          
          console.log(`✅ [${timestamp}] user_code успешно сохранен для пользователя ${userId}: ${userCode}`);
          res.json({ user_code: userCode });
        });
      });
    } else {
      // Код уже есть, сразу возвращаем
      console.log(`✅ [${timestamp}] user_code получен для пользователя ${userId}: ${userCode}`);
      res.json({ user_code: userCode });
    }
  });
});

// API для применения скидки через Linko (для заказов)
app.post('/api/public/linko/apply-discount', authenticateToken, async (req, res) => {
  const { orderAmount } = req.body;
  const userId = req.user.id;
  
  if (!orderAmount || orderAmount <= 0) {
    return res.status(400).json({ error: 'Неверная сумма заказа' });
  }
  
  db.query('SELECT user_code FROM app_users WHERE id = ?', [userId], async (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (users.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    
    const userCode = users[0].user_code;
    if (!userCode) {
      return res.status(400).json({ error: 'У пользователя нет кода' });
    }
    
    try {
      const discountResult = await applyLinkoDiscount(userCode, orderAmount);
      if (discountResult) {
        res.json({ success: true, discount: discountResult });
      } else {
        res.status(500).json({ error: 'Не удалось применить скидку через Linko' });
      }
    } catch (error) {
      res.status(500).json({ error: `Ошибка Linko API: ${error.message}` });
    }
  });
});

// API для админа: получение информации о пользователе по коду
app.get('/api/admin/user-by-code/:code', authenticateToken, (req, res) => {
  const { code } = req.params;
  
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Код должен состоять из 6 цифр' });
  }
  
  // Находим пользователя по коду
  db.query('SELECT id, phone, name, user_code FROM app_users WHERE user_code = ?', [code], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (users.length === 0) {
      return res.status(404).json({ error: 'Пользователь с таким кодом не найден' });
    }
    
    const user = users[0];
    const phone = user.phone;
    
    // Получаем баланс кешбэка
    db.query(
      'SELECT balance, total_earned FROM cashback_balance WHERE phone = ?',
      [phone],
      (err, balanceResult) => {
        if (err) {
          console.error('Ошибка получения баланса:', err);
        }
        
        res.json({
          id: user.id,
          phone: user.phone,
          name: user.name,
          user_code: user.user_code,
          balance: balanceResult.length > 0 ? parseFloat(balanceResult[0].balance || 0) : 0,
          total_earned: balanceResult.length > 0 ? parseFloat(balanceResult[0].total_earned || 0) : 0
        });
      }
    );
  });
});

// API для админа: начисление кешбэка по 6-значному коду пользователя
app.post('/api/admin/cashback/add-by-code', authenticateToken, (req, res) => {
  const { user_code, amount, description } = req.body;
  
  if (!user_code || !amount) {
    return res.status(400).json({ error: 'Код пользователя и сумма обязательны' });
  }
  
  if (amount <= 0) {
    return res.status(400).json({ error: 'Сумма должна быть больше нуля' });
  }
  
  // Проверяем, что код состоит из 6 цифр
  if (!/^\d{6}$/.test(user_code)) {
    return res.status(400).json({ error: 'Код должен состоять из 6 цифр' });
  }
  
  // Находим пользователя по коду
  db.query('SELECT id, phone FROM app_users WHERE user_code = ?', [user_code], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (users.length === 0) {
      return res.status(404).json({ error: 'Пользователь с таким кодом не найден' });
    }
    
    const user = users[0];
    const phone = user.phone;
    
    // Начисляем кешбэк
    db.query(
      `INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level)
       VALUES (?, ?, ?, 0, 'bronze')
       ON DUPLICATE KEY UPDATE
       balance = balance + ?,
       total_earned = total_earned + ?`,
      [phone, amount, amount, amount, amount],
      (err, result) => {
        if (err) return res.status(500).json({ error: `Ошибка начисления кешбэка: ${err.message}` });
        
        // Записываем транзакцию
        const transactionDescription = description || `Начисление кешбэка по коду ${user_code}`;
        db.query(
          'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, NULL, "earned", ?, ?)',
          [phone, amount, transactionDescription],
          (err) => {
            if (err) {
              console.error('Ошибка записи транзакции:', err);
            }
            
            // Получаем актуальный баланс
            db.query(
              'SELECT balance, total_earned FROM cashback_balance WHERE phone = ?',
              [phone],
              (err, balanceResult) => {
                if (err) {
                  console.error('Ошибка получения баланса:', err);
                }
                
                const newBalance = balanceResult.length > 0 ? parseFloat(balanceResult[0].balance) : amount;
                res.json({
                  success: true,
                  message: `Кешбэк успешно начислен пользователю`,
                  user: {
                    phone: phone,
                    user_code: user_code,
                  },
                  amount: amount,
                  new_balance: newBalance.toFixed(2),
                  balance: newBalance,
                  total_earned: balanceResult.length > 0 ? parseFloat(balanceResult[0].total_earned) : amount
                });
              }
            );
          }
        );
      }
    );
  });
});

// API для админа: списание кешбэка по 6-значному коду пользователя
app.post('/api/admin/cashback/subtract-by-code', authenticateToken, (req, res) => {
  const { user_code, amount, description } = req.body;
  
  if (!user_code || !amount) {
    return res.status(400).json({ error: 'Код пользователя и сумма обязательны' });
  }
  
  if (amount <= 0) {
    return res.status(400).json({ error: 'Сумма должна быть больше нуля' });
  }
  
  // Проверяем, что код состоит из 6 цифр
  if (!/^\d{6}$/.test(user_code)) {
    return res.status(400).json({ error: 'Код должен состоять из 6 цифр' });
  }
  
  // Находим пользователя по коду
  db.query('SELECT id, phone FROM app_users WHERE user_code = ?', [user_code], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (users.length === 0) {
      return res.status(404).json({ error: 'Пользователь с таким кодом не найден' });
    }
    
    const user = users[0];
    const phone = user.phone;
    
    // Проверяем текущий баланс
    db.query('SELECT balance FROM cashback_balance WHERE phone = ?', [phone], (err, balanceResult) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      
      const currentBalance = balanceResult.length > 0 ? parseFloat(balanceResult[0].balance || 0) : 0;
      
      if (currentBalance < amount) {
        return res.status(400).json({ 
          error: `Недостаточно средств. Текущий баланс: ${currentBalance.toFixed(2)} сом, требуется: ${amount.toFixed(2)} сом` 
        });
      }
      
      // Списываем кешбэк
      db.query(
        'UPDATE cashback_balance SET balance = balance - ?, total_spent = COALESCE(total_spent, 0) + ? WHERE phone = ?',
        [amount, amount, phone],
        (err, result) => {
          if (err) return res.status(500).json({ error: `Ошибка списания кешбэка: ${err.message}` });
          
          if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Баланс не найден' });
          }
          
          // Записываем транзакцию
          const transactionDescription = description || `Списание кешбэка по коду ${user_code}`;
          db.query(
            'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, NULL, "spent", ?, ?)',
            [phone, amount, transactionDescription],
            (err) => {
              if (err) {
                console.error('Ошибка записи транзакции:', err);
              }
              
              // Получаем актуальный баланс
              db.query(
                'SELECT balance, total_earned, total_spent FROM cashback_balance WHERE phone = ?',
                [phone],
                (err, balanceResult) => {
                  if (err) {
                    console.error('Ошибка получения баланса:', err);
                  }
                  
                  const newBalance = balanceResult.length > 0 ? parseFloat(balanceResult[0].balance) : 0;
                  res.json({
                    success: true,
                    message: `Кешбэк успешно списан`,
                    user: {
                      phone: phone,
                      user_code: user_code,
                    },
                    amount: amount,
                    new_balance: newBalance.toFixed(2),
                    balance: newBalance,
                    total_spent: balanceResult.length > 0 ? parseFloat(balanceResult[0].total_spent || 0) : amount
                  });
                }
              );
            }
          );
        }
      );
    });
  });
});

// API для входа/регистрации по телефону (старый метод, оставляем для совместимости)
app.post('/api/public/auth/phone', (req, res) => {
  const { phone, referral_code } = req.body;
  if (!phone) return res.status(400).json({ error: 'Телефон обязателен' });
  
  // Очищаем телефон от лишних символов
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 10) {
    return res.status(400).json({ error: 'Некорректный номер телефона' });
  }
  
  // Проверяем, существует ли пользователь
  db.query('SELECT * FROM app_users WHERE phone = ?', [cleanPhone], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    
    if (users.length === 0) {
      // Регистрация нового пользователя
      const userCode = generateUserCode();
      
      // Обрабатываем реферальный код
      const processReferral = (callback) => {
        if (!referral_code || !/^\d{6}$/.test(referral_code)) {
          return callback(null);
        }
        
        // Находим реферера по коду
        db.query('SELECT id, phone FROM app_users WHERE user_code = ?', [referral_code], (err, referrers) => {
          if (err) {
            console.error('Ошибка поиска реферера:', err);
            return callback(null);
          }
          
          if (referrers.length === 0) {
            // Реферальный код не найден, но продолжаем регистрацию
            return callback(null);
          }
          
          const referrer = referrers[0];
          const referrerId = referrer.id;
          const referrerPhone = referrer.phone;
          
          // Начисляем бонус рефереру (10 сом)
          const referralBonus = 10;
          const timestamp = new Date().toISOString();
          db.query(
            `INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level)
             VALUES (?, ?, ?, 0, 'bronze')
             ON DUPLICATE KEY UPDATE
             balance = balance + ?,
             total_earned = total_earned + ?`,
            [referrerPhone, referralBonus, referralBonus, referralBonus, referralBonus],
            (err) => {
              if (err) {
                console.error(`❌ [${timestamp}] Ошибка начисления бонуса рефереру ${referrerPhone}:`, err.message);
              } else {
                // Записываем транзакцию
                db.query(
                  'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, NULL, "earned", ?, ?)',
                  [referrerPhone, referralBonus, `Бонус за приглашение пользователя`],
                  () => {}
                );
                console.log(`💰 [${timestamp}] Начислен реферальный бонус ${referralBonus} сом рефереру ${referrerPhone} за приглашение пользователя ${cleanPhone}`);
              }
              callback(referrerId);
            }
          );
        });
      };
      
      processReferral((referrerId) => {
        // Регистрируем нового пользователя
        const insertQuery = referrerId 
          ? 'INSERT INTO app_users (phone, user_code, referrer_id) VALUES (?, ?, ?)'
          : 'INSERT INTO app_users (phone, user_code) VALUES (?, ?)';
        const insertParams = referrerId 
          ? [cleanPhone, userCode, referrerId]
          : [cleanPhone, userCode];
        
        db.query(insertQuery, insertParams, (err, result) => {
          const timestamp = new Date().toISOString();
          if (err) {
            console.error(`❌ [${timestamp}] Ошибка регистрации пользователя ${cleanPhone}:`, err.message);
            return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          }
          
          console.log(`✅ [${timestamp}] Новый пользователь зарегистрирован: ${cleanPhone}, ID: ${result.insertId}, Код: ${userCode}${referrerId ? `, Реферер ID: ${referrerId}` : ''}`);
          
          // Если пользователь зарегистрировался по реферальному коду, начисляем ему бонус
          if (referrerId) {
            const newUserBonus = 100; // Бонус для нового пользователя
            db.query(
              `INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level)
               VALUES (?, ?, ?, 0, 'bronze')
               ON DUPLICATE KEY UPDATE
               balance = balance + ?,
               total_earned = total_earned + ?`,
              [cleanPhone, newUserBonus, newUserBonus, newUserBonus, newUserBonus],
              (err) => {
                if (err) {
                  console.error(`❌ [${timestamp}] Ошибка начисления бонуса новому пользователю ${cleanPhone}:`, err.message);
                } else {
                  // Записываем транзакцию
                  db.query(
                    'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, NULL, "earned", ?, ?)',
                    [cleanPhone, newUserBonus, `Бонус за регистрацию по реферальному коду`],
                    () => {}
                  );
                  console.log(`💰 [${timestamp}] Начислен бонус ${newUserBonus} сом новому пользователю ${cleanPhone} за регистрацию по реферальному коду`);
                }
                
                const token = jwt.sign({ id: result.insertId, phone: cleanPhone }, JWT_SECRET, { expiresIn: '30d' });
                res.json({ 
                  token, 
                  user: { id: result.insertId, phone: cleanPhone, name: null, user_code: userCode },
                  isNewUser: true
                });
              }
            );
          } else {
            const token = jwt.sign({ id: result.insertId, phone: cleanPhone }, JWT_SECRET, { expiresIn: '30d' });
            res.json({ 
              token, 
              user: { id: result.insertId, phone: cleanPhone, name: null, user_code: userCode },
              isNewUser: true
            });
          }
        });
      });
    } else {
      // Вход существующего пользователя
      const user = users[0];
      const timestamp = new Date().toISOString();
      
      // Если у пользователя нет кода, генерируем его и ОБЯЗАТЕЛЬНО ждем сохранения
      if (!user.user_code) {
        const userCode = generateUserCode();
        console.log(`🔑 [${timestamp}] Генерация user_code для существующего пользователя ${user.phone}: ${userCode}`);
        
        db.query('UPDATE app_users SET user_code = ? WHERE id = ?', [userCode, user.id], (err) => {
          if (err) {
            console.error(`❌ [${timestamp}] Ошибка обновления user_code для пользователя ${user.id}:`, err.message);
            // Все равно возвращаем ответ, но без кода (он будет сгенерирован при следующем запросе)
            const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
            return res.json({ 
              token, 
              user: { id: user.id, phone: user.phone, name: user.name, user_code: null },
              isNewUser: false
            });
          }
          
          console.log(`✅ [${timestamp}] user_code успешно сохранен для пользователя ${user.phone}: ${userCode}`);
          user.user_code = userCode;
          
          console.log(`✅ [${timestamp}] Пользователь авторизован: ${user.phone}, ID: ${user.id}, Код: ${userCode}`);
          const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
          res.json({ 
            token, 
            user: { id: user.id, phone: user.phone, name: user.name, user_code: user.user_code },
            isNewUser: false
          });
        });
      } else {
        // Код уже есть, сразу возвращаем
        console.log(`✅ [${timestamp}] Пользователь авторизован: ${user.phone}, ID: ${user.id}, Код: ${user.user_code}`);
        const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ 
          token, 
          user: { id: user.id, phone: user.phone, name: user.name, user_code: user.user_code },
          isNewUser: false
        });
      }
    }
  });
});

// API для обновления профиля пользователя
app.put('/api/public/auth/profile', optionalAuthenticateToken, (req, res) => {
  const { name, phone, address } = req.body;
  const userId = req.user?.id;
  
  if (!userId) return res.status(401).json({ error: 'Необходима авторизация' });
  
  const updates = [];
  const values = [];
  
  if (name !== undefined) {
    if (name.trim().length === 0) {
      return res.status(400).json({ error: 'Имя не может быть пустым' });
    }
    updates.push('name = ?');
    values.push(name.trim());
  }
  
  if (phone !== undefined) {
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 10) {
      return res.status(400).json({ error: 'Некорректный номер телефона' });
    }
    // Проверяем, не занят ли телефон другим пользователем
    db.query('SELECT id FROM app_users WHERE phone = ? AND id != ?', [cleanPhone, userId], (err, users) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (users.length > 0) {
        return res.status(400).json({ error: 'Этот номер телефона уже используется' });
      }
      
      updates.push('phone = ?');
      values.push(cleanPhone);
      values.push(userId);
      
      db.query(`UPDATE app_users SET ${updates.join(', ')} WHERE id = ?`, values, (err, result) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        
        db.query('SELECT * FROM app_users WHERE id = ?', [userId], (err, users) => {
          if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          if (users.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
          
          const user = users[0];
          res.json({ user: { id: user.id, phone: user.phone, name: user.name, address: user.address } });
        });
      });
    });
    return;
  }
  
  if (address !== undefined) {
    updates.push('address = ?');
    values.push(address.trim() || null);
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ error: 'Нет данных для обновления' });
  }
  
  values.push(userId);
  
  db.query(`UPDATE app_users SET ${updates.join(', ')} WHERE id = ?`, values, (err, result) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    
    db.query('SELECT * FROM app_users WHERE id = ?', [userId], (err, users) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (users.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
      
      const user = users[0];
      res.json({ user: { id: user.id, phone: user.phone, name: user.name, address: user.address } });
    });
  });
});

// API для получения профиля пользователя
app.get('/api/public/auth/profile', optionalAuthenticateToken, (req, res) => {
  const userId = req.user?.id;
  
  if (!userId) return res.status(401).json({ error: 'Необходима авторизация' });
  
  db.query('SELECT * FROM app_users WHERE id = ?', [userId], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (users.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    
    const user = users[0];
    res.json({ user: { id: user.id, phone: user.phone, name: user.name, address: user.address } });
  });
});

app.delete('/api/public/auth/account', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.query('SELECT phone FROM app_users WHERE id = ?', [userId], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (users.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });

    const phone = users[0].phone;
    const cleanupQueries = [
      { sql: 'DELETE FROM cashback_transactions WHERE phone = ?', params: [phone] },
      { sql: 'DELETE FROM cashback_balance WHERE phone = ?', params: [phone] },
      { sql: 'DELETE FROM uds_transactions WHERE phone = ?', params: [phone] },
      { sql: 'DELETE FROM uds_balance WHERE phone = ?', params: [phone] },
      { sql: 'DELETE FROM user_qr_codes WHERE user_id = ?', params: [userId] },
      { sql: 'DELETE FROM notifications WHERE user_id = ?', params: [userId] },
    ];

    const runCleanup = (index) => {
      if (index >= cleanupQueries.length) {
        return deleteUser();
      }

      const { sql, params } = cleanupQueries[index];
      db.query(sql, params, (cleanupErr) => {
        if (cleanupErr) {
          return res.status(500).json({ error: `Ошибка сервера: ${cleanupErr.message}` });
        }
        runCleanup(index + 1);
      });
    };

    const deleteUser = () => {
      db.query('DELETE FROM app_users WHERE id = ?', [userId], (deleteErr, result) => {
        if (deleteErr) return res.status(500).json({ error: `Ошибка сервера: ${deleteErr.message}` });
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json({ success: true });
      });
    };

    runCleanup(0);
  });
});

// API для получения кешбэка по токену (для авторизованных пользователей)
app.get('/api/public/cashback/balance', optionalAuthenticateToken, (req, res) => {
  const userId = req.user?.id;
  
  if (!userId) {
    return res.json({
      balance: 0,
      total_earned: 0,
      total_spent: 0,
      user_level: 'bronze',
      total_orders: 0,
      isAuthenticated: false
    });
  }
  
  // Получаем телефон пользователя
  db.query('SELECT phone FROM app_users WHERE id = ?', [userId], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (users.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    
    const phone = users[0].phone;
    
    db.query(
      'SELECT balance, total_earned, total_spent, user_level, total_orders FROM cashback_balance WHERE phone = ?',
      [phone],
      (err, result) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        if (result.length === 0) {
          return res.json({
            balance: 0,
            total_earned: 0,
            total_spent: 0,
            user_level: 'bronze',
            total_orders: 0,
            isAuthenticated: true
          });
        }
        res.json({ ...result[0], isAuthenticated: true });
      }
    );
  });
});

// API для получения транзакций кешбэка по токену
app.get('/api/public/cashback/transactions', optionalAuthenticateToken, (req, res) => {
  const userId = req.user?.id;
  const limit = parseInt(req.query.limit) || 50;
  
  if (!userId) {
    return res.json([]);
  }
  
  db.query('SELECT phone FROM app_users WHERE id = ?', [userId], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (users.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    
    const phone = users[0].phone;
    
    db.query(
      'SELECT * FROM cashback_transactions WHERE phone = ? ORDER BY created_at DESC LIMIT ?',
      [phone, limit],
      (err, transactions) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.json(transactions);
      }
    );
  });
});

// API для работы с кешбэком
app.get('/api/public/cashback/balance/:phone', (req, res) => {
  const { phone } = req.params;
  if (!phone) return res.status(400).json({ error: 'Телефон обязателен' });
  
  db.query(
    'SELECT balance, total_earned, total_spent, user_level, total_orders FROM cashback_balance WHERE phone = ?',
    [phone],
    (err, result) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (result.length === 0) {
        return res.json({
          balance: 0,
          total_earned: 0,
          total_spent: 0,
          user_level: 'bronze',
          total_orders: 0
        });
      }
      res.json(result[0]);
    }
  );
});

// API для открытия подарка
app.post('/api/public/gift/open', authenticateToken, (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Необходима авторизация' });
  
  // Проверяем период активности подарка (20 декабря 2025 - 12 января 2026)
  const now = new Date();
  const startDate = new Date('2025-12-20');
  const endDate = new Date('2026-01-12T23:59:59');
  
  if (now < startDate || now > endDate) {
    return res.status(400).json({ error: 'Период подарка не активен' });
  }
  
  // Проверяем, открывал ли пользователь подарок сегодня
  const today = now.toISOString().split('T')[0];
  
  db.query(
    'SELECT * FROM gift_opened WHERE user_id = ? AND opened_date = ?',
    [userId, today],
    (err, results) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      
      if (results.length > 0) {
        return res.status(400).json({ error: 'Вы уже получили подарок сегодня' });
      }
      
      // Генерируем случайный приз
      const prizes = [
        { type: 'cashback', description: 'Кешбэк 100 сом', amount: 100 },
        { type: 'cashback', description: 'Кешбэк 50 сом', amount: 50 },
        { type: 'cashback', description: 'Кешбэк 200 сом', amount: 200 },
        { type: 'discount', description: 'Скидка 10% на следующий заказ', amount: 10 },
        { type: 'discount', description: 'Скидка 15% на следующий заказ', amount: 15 },
        { type: 'bonus', description: 'Бесплатная доставка', amount: 0 },
      ];
      
      const randomPrize = prizes[Math.floor(Math.random() * prizes.length)];
      
      // Получаем телефон пользователя для начисления кешбэка
      db.query('SELECT phone FROM app_users WHERE id = ?', [userId], (err, users) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        if (users.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
        
        const userPhone = users[0].phone;
        
        // Сохраняем информацию об открытии подарка
        db.query(
          'INSERT INTO gift_opened (user_id, opened_date, prize_type, prize_description, amount) VALUES (?, ?, ?, ?, ?)',
          [userId, today, randomPrize.type, randomPrize.description, randomPrize.amount],
          (err, result) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            
            // Если приз - кешбэк, начисляем его
            if (randomPrize.type === 'cashback' && randomPrize.amount > 0) {
              db.query(
                `INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level)
                 VALUES (?, ?, ?, 0, 'bronze')
                 ON DUPLICATE KEY UPDATE
                 balance = balance + ?,
                 total_earned = total_earned + ?`,
                [userPhone, randomPrize.amount, randomPrize.amount, randomPrize.amount, randomPrize.amount],
                (err) => {
                  if (err) {
                    console.error('Ошибка начисления кешбэка из подарка:', err);
                  } else {
                    // Записываем транзакцию
                    db.query(
                      'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, NULL, "earned", ?, ?)',
                      [userPhone, randomPrize.amount, `Новогодний подарок: ${randomPrize.description}`],
                      () => {}
                    );
                  }
                  
                  res.json({
                    success: true,
                    prize: randomPrize.description,
                    type: randomPrize.type,
                    amount: randomPrize.amount,
                  });
                }
              );
            } else {
              // Для других типов призов просто возвращаем результат
              res.json({
                success: true,
                prize: randomPrize.description,
                type: randomPrize.type,
                amount: randomPrize.amount,
              });
            }
          }
        );
      });
    }
  );
});

// API для получения уведомлений
app.get('/api/public/notifications', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const limit = parseInt(req.query.limit) || 50;
  
  db.query(
    `SELECT * FROM notifications 
     WHERE user_id = ? OR user_id IS NULL 
     ORDER BY created_at DESC 
     LIMIT ?`,
    [userId, limit],
    (err, notifications) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      res.json(notifications);
    }
  );
});

// API для отметки уведомления как прочитанного
app.put('/api/public/notifications/:id/read', authenticateToken, (req, res) => {
  const notificationId = req.params.id;
  const userId = req.user.id;
  
  db.query(
    'UPDATE notifications SET is_read = TRUE WHERE id = ? AND (user_id = ? OR user_id IS NULL)',
    [notificationId, userId],
    (err, result) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      res.json({ success: true });
    }
  );
});

// API для отметки всех уведомлений как прочитанных
app.put('/api/public/notifications/read-all', authenticateToken, (req, res) => {
  const userId = req.user.id;
  
  db.query(
    'UPDATE notifications SET is_read = TRUE WHERE (user_id = ? OR user_id IS NULL) AND is_read = FALSE',
    [userId],
    (err) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      res.json({ success: true });
    }
  );
});

app.get('/api/public/cashback/transactions/:phone', (req, res) => {
  const { phone } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  
  if (!phone) return res.status(400).json({ error: 'Телефон обязателен' });
  
  db.query(
    'SELECT * FROM cashback_transactions WHERE phone = ? ORDER BY created_at DESC LIMIT ?',
    [phone, limit],
    (err, transactions) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      res.json(transactions);
    }
  );
});

// Генерация уникального токена для QR-кода
function generateQRToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

// API для получения своего QR-кода
app.get('/api/public/qr-code/my', authenticateToken, (req, res) => {
  const userId = req.user.id;
  
    // Сначала проверяем, был ли уже начислен кешбэк сегодня (до любых других проверок)
    db.query(
      'SELECT phone, last_qr_cashback_date FROM app_users WHERE id = ?',
      [userId],
      (err, users) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        if (users.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
        
        const userPhone = users[0].phone;
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const lastCashbackDate = users[0]?.last_qr_cashback_date;
        const shouldAwardCashback = !lastCashbackDate || lastCashbackDate !== today;
        
        // Проверяем, есть ли действующий QR-код
        db.query(
          'SELECT * FROM user_qr_codes WHERE user_id = ? AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
          [userId],
          (err, qrCodes) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            
            if (qrCodes.length > 0) {
              // Возвращаем существующий QR-код (без начисления кешбэка)
              const qrCode = qrCodes[0];
              res.json({
                qr_code: qrCode.qr_token,
                expires_at: qrCode.expires_at,
                cashback_earned: 0, // Не начисляем при показе существующего
              });
            } else {
              // Создаем новый QR-код (действителен 10 минут)
              const qrToken = generateQRToken();
              const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 минут
              
              // Начисляем кешбэк за показ QR-кода только один раз в день (30 сом)
              const cashbackAmount = shouldAwardCashback ? 30 : 0;
              
              db.query(
                'INSERT INTO user_qr_codes (user_id, qr_token, expires_at) VALUES (?, ?, ?)',
                [userId, qrToken, expiresAt],
                (err) => {
                  if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
                  
                  if (shouldAwardCashback && cashbackAmount > 0) {
                    // Начисляем кешбэк за показ QR-кода
                    db.query(
                      `INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level)
                       VALUES (?, ?, ?, 0, 'bronze')
                       ON DUPLICATE KEY UPDATE
                       balance = balance + ?,
                       total_earned = total_earned + ?`,
                      [userPhone, cashbackAmount, cashbackAmount, cashbackAmount, cashbackAmount],
                      (err) => {
                        if (err) {
                          console.error('Ошибка начисления кешбэка за QR-код:', err);
                          // Продолжаем даже если кешбэк не начислен
                          return res.json({
                            qr_code: qrToken,
                            expires_at: expiresAt.toISOString(),
                            cashback_earned: 0,
                          });
                        }
                        
                        // Записываем транзакцию
                        db.query(
                          'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, ?, "earned", ?, ?)',
                          [userPhone, null, cashbackAmount, 'Кешбэк за показ QR-кода'],
                          () => {}
                        );
                        
                        // Обновляем дату последнего начисления кешбэка за QR-код СРАЗУ после начисления
                        db.query(
                          'UPDATE app_users SET last_qr_cashback_date = ? WHERE id = ?',
                          [today, userId],
                          (updateErr) => {
                            if (updateErr) {
                              console.error('Ошибка обновления даты кешбэка:', updateErr);
                            }
                          }
                        );
                        
                        res.json({
                          qr_code: qrToken,
                          expires_at: expiresAt.toISOString(),
                          cashback_earned: cashbackAmount,
                        });
                      }
                    );
                  } else {
                    // Не начисляем кешбэк, просто возвращаем QR-код
                    res.json({
                      qr_code: qrToken,
                      expires_at: expiresAt.toISOString(),
                      cashback_earned: 0,
                    });
                  }
                }
              );
            }
          }
        );
      }
    );
});

// API для сканирования QR-кода
app.post('/api/public/qr-code/scan', authenticateToken, (req, res) => {
  const { qr_code } = req.body;
  const scannerUserId = req.user.id;
  
  if (!qr_code) {
    return res.status(400).json({ error: 'QR-код обязателен' });
  }
  
  // Находим пользователя по QR-коду
  db.query(
    'SELECT user_id, expires_at FROM user_qr_codes WHERE qr_token = ? AND expires_at > NOW()',
    [qr_code],
    (err, qrCodes) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      
      if (qrCodes.length === 0) {
        return res.status(400).json({ error: 'QR-код недействителен или истек' });
      }
      
      const qrCode = qrCodes[0];
      const targetUserId = qrCode.user_id;
      
      // Нельзя сканировать свой QR-код
      if (targetUserId === scannerUserId) {
        return res.status(400).json({ error: 'Нельзя сканировать свой QR-код' });
      }
      
      // Получаем информацию о пользователе
      db.query('SELECT phone FROM app_users WHERE id = ?', [targetUserId], (err, users) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        if (users.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
        
        const targetPhone = users[0].phone;
        
        // Начисляем кешбэк (50 сом) за сканирование QR-кода
        const bonusCashback = 50;
        
        db.query(
          `INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level)
           VALUES (?, ?, ?, 0, 'bronze')
           ON DUPLICATE KEY UPDATE
           balance = balance + ?,
           total_earned = total_earned + ?`,
          [targetPhone, bonusCashback, bonusCashback, bonusCashback, bonusCashback],
          (err) => {
            if (err) {
              console.error('Ошибка начисления кешбэка:', err);
              return res.status(500).json({ error: 'Ошибка начисления кешбэка' });
            }
            
            // Записываем транзакцию
            db.query(
              'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, ?, "earned", ?, ?)',
              [targetPhone, null, bonusCashback, 'Кешбэк за сканирование QR-кода'],
              () => {}
            );
            
            // Удаляем использованный QR-код (можно использовать только один раз)
            db.query('DELETE FROM user_qr_codes WHERE qr_token = ?', [qr_code], () => {});
            
            res.json({
              message: `Кешбэк успешно начислен! Начислено ${bonusCashback} сом кешбэка.`,
              bonus_cashback: bonusCashback,
            });
          }
        );
      });
    }
  );
});

app.get('/', (req, res) => res.send('Booday Pizza API'));

app.post('/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Введите email и пароль' });
  db.query('SELECT * FROM users WHERE email = ?', [email], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (users.length === 0) return res.status(401).json({ error: 'Неверный email или пароль' });
    const user = users[0];
    bcrypt.compare(password, user.password, (err, isMatch) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (!isMatch) return res.status(401).json({ error: 'Неверный email или пароль' });
      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
      res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
    });
  });
});

app.get('/branches', authenticateToken, (req, res) => {
  db.query('SELECT * FROM branches', (err, branches) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(branches);
  });
});

app.get('/products', authenticateToken, (req, res) => {
  db.query(`
    SELECT p.*,
           b.name as branch_name,
           c.name as category_name,
           s.name as subcategory_name,
           d.discount_percent,
           d.expires_at,
           d.is_active as discount_active,
           COALESCE(
             (SELECT JSON_ARRAYAGG(
               JSON_OBJECT(
                 'id', sa.id,
                 'name', sa.name,
                 'price', sa.price,
                 'image', sa.image
               )
             )
             FROM products_sauces ps
             LEFT JOIN sauces sa ON ps.sauce_id = sa.id
             WHERE ps.product_id = p.id AND sa.id IS NOT NULL),
             '[]'
           ) as sauces
    FROM products p
    LEFT JOIN branches b ON p.branch_id = b.id
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN subcategories s ON p.sub_category_id = s.id
    LEFT JOIN discounts d ON p.id = d.product_id AND d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
    GROUP BY p.id
  `, (err, products) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    const parsedProducts = products.map(product => {
      let imageUrl = null;
      if (product.image) {
        // Если это уже полный URL, используем его
        if (product.image.startsWith('http')) {
          imageUrl = product.image;
        } else {
          // Извлекаем ключ изображения (убираем путь, если есть)
          const imageKey = product.image.includes('/') 
            ? product.image.split('/').pop() 
            : product.image;
          imageUrl = `https://vasya010-red-bdf5.twc1.net/product-image/${imageKey}`;
        }
      }
      return {
        ...product,
        image: imageUrl,
        image_url: imageUrl,
        sauces: product.sauces ? JSON.parse(product.sauces).filter(s => s && s.id) : []
      };
    });
    res.json(parsedProducts);
  });
});

app.get('/discounts', authenticateToken, (req, res) => {
  db.query(`
    SELECT d.*, p.name as product_name
    FROM discounts d
    JOIN products p ON d.product_id = p.id
    WHERE d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
  `, (err, discounts) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(discounts);
  });
});

app.get('/stories', authenticateToken, (req, res) => {
  db.query('SELECT * FROM stories', (err, stories) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    const storiesWithUrls = stories.map(story => ({
      ...story,
      image: `https://nukesul-brepb-651f.twc1.net/product-image/${story.image.split('/').pop()}`
    }));
    res.json(storiesWithUrls);
  });
});

app.get('/banners', authenticateToken, (req, res) => {
  db.query(`
    SELECT b.*, pc.code AS promo_code, pc.discount_percent
    FROM banners b
    LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
  `, (err, banners) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    const bannersWithUrls = banners.map(banner => ({
      ...banner,
      image: `https://nukesul-brepb-651f.twc1.net/product-image/${banner.image.split('/').pop()}`
    }));
    res.json(bannersWithUrls);
  });
});

app.get('/sauces', authenticateToken, (req, res) => {
  db.query('SELECT * FROM sauces', (err, sauces) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    const saucesWithUrls = sauces.map(sauce => ({
      ...sauce,
      image: sauce.image ? `https://nukesul-brepb-651f.twc1.net/product-image/${sauce.image.split('/').pop()}` : null
    }));
    res.json(saucesWithUrls);
  });
});

app.get('/categories', authenticateToken, (req, res) => {
  db.query('SELECT * FROM categories', (err, categories) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(categories);
  });
});

app.get('/promo-codes', authenticateToken, (req, res) => {
  db.query('SELECT * FROM promo_codes', (err, promoCodes) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(promoCodes);
  });
});

app.get('/promo-codes/check/:code', authenticateToken, (req, res) => {
  const { code } = req.params;
  db.query(`
    SELECT * FROM promo_codes
    WHERE code = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
  `, [code], (err, promo) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (promo.length === 0) return res.status(404).json({ error: 'Промокод не найден или недействителен' });
    res.json(promo[0]);
  });
});

// Список заказов, использовавших промокод (для админки: кто использовал промокод)
app.get('/promo-codes/:id/usage', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('SELECT code FROM promo_codes WHERE id = ?', [id], (err, promo) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (!promo || promo.length === 0) return res.status(404).json({ error: 'Промокод не найден' });
    const code = promo[0].code;
    db.query(
      `SELECT id, total, status, order_details, delivery_details, created_at, promo_code
       FROM orders WHERE promo_code = ? ORDER BY created_at DESC`,
      [code],
      (err, orders) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        const list = (orders || []).map((o) => {
          const details = typeof o.order_details === 'string' ? JSON.parse(o.order_details || '{}') : (o.order_details || {});
          const delivery = typeof o.delivery_details === 'string' ? JSON.parse(o.delivery_details || '{}') : (o.delivery_details || {});
          return {
            orderId: o.id,
            total: o.total,
            status: o.status,
            phone: details.phone || delivery.phone || '—',
            name: details.name || delivery.name || '—',
            address: delivery.address || '—',
            createdAt: o.created_at,
          };
        });
        res.json({ code, usageCount: list.length, orders: list });
      }
    );
  });
});

app.post('/promo-codes', authenticateToken, (req, res) => {
  const { code, discountPercent, expiresAt, isActive } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ error: 'Код и процент скидки обязательны' });
  db.query(
    'INSERT INTO promo_codes (code, discount_percent, expires_at, is_active) VALUES (?, ?, ?, ?)',
    [code, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true],
    (err, result) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      res.status(201).json({ id: result.insertId, code, discount_percent: discountPercent, expires_at: expiresAt || null, is_active: isActive !== undefined ? isActive : true });
    }
  );
});

app.put('/promo-codes/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { code, discountPercent, expiresAt, isActive } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ error: 'Код и процент скидки обязательны' });
  db.query(
    'UPDATE promo_codes SET code = ?, discount_percent = ?, expires_at = ?, is_active = ? WHERE id = ?',
    [code, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true, id],
    (err) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      res.json({ id, code, discount_percent: discountPercent, expires_at: expiresAt || null, is_active: isActive !== undefined ? isActive : true });
    }
  );
});

app.delete('/promo-codes/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM promo_codes WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json({ message: 'Промокод удален' });
  });
});

app.post('/branches', authenticateToken, (req, res) => {
  const { name, address, phone, telegram_chat_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Название филиала обязательно' });
  if (telegram_chat_id && !telegram_chat_id.match(/^-\d+$/)) {
    return res.status(400).json({ error: 'Некорректный формат telegram_chat_id. Должен начинаться с "-" и содержать только цифры.' });
  }
  db.query(
    'INSERT INTO branches (name, address, phone, telegram_chat_id) VALUES (?, ?, ?, ?)',
    [name, address || null, phone || null, telegram_chat_id || null],
    (err, result) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      res.status(201).json({ id: result.insertId, name, address, phone, telegram_chat_id });
    }
  );
});

app.put('/branches/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { name, address, phone, telegram_chat_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Название филиала обязательно' });
  if (telegram_chat_id && !telegram_chat_id.match(/^-\d+$/)) {
    return res.status(400).json({ error: 'Некорректный формат telegram_chat_id. Должен начинаться с "-" и содержать только цифры.' });
  }
  db.query(
    'UPDATE branches SET name = ?, address = ?, phone = ?, telegram_chat_id = ? WHERE id = ?',
    [name, address || null, phone || null, telegram_chat_id || null, id],
    (err) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      res.json({ id, name, address, phone, telegram_chat_id });
    }
  );
});

app.delete('/branches/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM branches WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json({ message: 'Филиал удален' });
  });
});

// API для проверки Telegram chat_id
app.post('/telegram/test-chat-id', authenticateToken, async (req, res) => {
  const { chat_id } = req.body;
  if (!chat_id) {
    return res.status(400).json({ error: 'chat_id обязателен' });
  }
  
  // Проверяем формат chat_id для групп/каналов
  if (!chat_id.match(/^-\d+$/)) {
    return res.status(400).json({ 
      success: false,
      error: 'Некорректный формат chat_id',
      message: 'Chat ID для групп/каналов должен начинаться с "-" и содержать только цифры (например: -1001234567890)'
    });
  }
  
  try {
    // Сначала пробуем получить информацию о чате
    let chatInfo = null;
    try {
      const chatResponse = await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChat`,
        {
          timeout: 5000,
          params: { chat_id: chat_id }
        }
      );
      chatInfo = chatResponse.data.result;
    } catch (chatError) {
      // Если не удалось получить информацию о чате, продолжаем с отправкой тестового сообщения
      console.log('Не удалось получить информацию о чате, пробуем отправить сообщение');
    }
    
    const testMessage = '🧪 Тестовое сообщение для проверки подключения бота к группе/каналу';
    const result = await sendTelegramMessage(chat_id, testMessage, 1);
    
    if (result.success) {
      const chatName = chatInfo?.title || chatInfo?.username || 'группа/канал';
      res.json({ 
        success: true, 
        message: `✅ Chat ID валиден! Тестовое сообщение успешно отправлено в ${chatName}.`,
        chat_id: chat_id,
        chatInfo: chatInfo ? {
          title: chatInfo.title,
          type: chatInfo.type,
          username: chatInfo.username
        } : null
      });
    } else {
      let errorMessage = result.error;
      let detailedMessage = result.error;
      
      if (result.error === 'Bad Request: chat not found') {
        detailedMessage = 'Чат/группа не найдена. Убедитесь, что:\n1. Бот добавлен в группу/канал\n2. Chat ID правильный (начинается с "-" для групп)\n3. Бот не был удален из группы';
      } else if (result.error === 'Forbidden: bot is not a member of the group chat') {
        detailedMessage = 'Бот не является участником группы. Добавьте бота в группу/канал.';
      } else if (result.error && result.error.includes('not enough rights')) {
        detailedMessage = 'У бота недостаточно прав. Убедитесь, что бот имеет права на отправку сообщений в группу/канал.';
      }
      
      res.status(400).json({ 
        success: false, 
        error: errorMessage,
        errorCode: result.errorCode,
        message: detailedMessage
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      message: `Ошибка при проверке chat_id: ${error.message}`
    });
  }
});

// API для получения списка доступных чатов из Telegram (только группы и каналы)
app.get('/telegram/get-chats', authenticateToken, async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`,
      {
        timeout: 10000,
        params: {
          offset: -100, // Получаем последние 100 обновлений
          limit: 100
        }
      }
    );
    
    const updates = response.data.result || [];
    const chats = [];
    const chatIds = new Set();
    
    updates.forEach(update => {
      let chat = null;
      let chatType = '';
      
      if (update.message) {
        chat = update.message.chat;
        chatType = update.message.chat.type || 'message';
      } else if (update.channel_post) {
        chat = update.channel_post.chat;
        chatType = 'channel';
      } else if (update.edited_message) {
        chat = update.edited_message.chat;
        chatType = update.edited_message.chat.type || 'edited_message';
      } else if (update.edited_channel_post) {
        chat = update.edited_channel_post.chat;
        chatType = 'channel';
      }
      
      // Фильтруем только группы и каналы (отрицательные ID или тип 'group'/'supergroup'/'channel')
      if (chat && chat.id) {
        const isGroupOrChannel = chat.id < 0 || 
                                 chat.type === 'group' || 
                                 chat.type === 'supergroup' || 
                                 chat.type === 'channel';
        
        if (isGroupOrChannel && !chatIds.has(chat.id.toString())) {
          chatIds.add(chat.id.toString());
          chats.push({
            id: chat.id,
            title: chat.title || chat.first_name || chat.username || 'Без названия',
            type: chat.type || chatType,
            username: chat.username || null
          });
        }
      }
    });
    
    // Сортируем: сначала группы/каналы (отрицательные ID), потом по алфавиту
    chats.sort((a, b) => {
      if (a.id < 0 && b.id > 0) return -1;
      if (a.id > 0 && b.id < 0) return 1;
      if (a.id < 0 && b.id < 0) {
        // Для групп/каналов сортируем по названию
        return (a.title || '').localeCompare(b.title || '');
      }
      return b.id - a.id;
    });
    
    const groupsCount = chats.filter(c => c.id < 0).length;
    
    res.json({ 
      success: true, 
      chats: chats,
      count: chats.length,
      groupsCount: groupsCount,
      message: chats.length > 0 
        ? `Найдено ${groupsCount} групп/каналов, где есть бот. Выберите нужный chat_id.`
        : 'Группы/каналы не найдены. Убедитесь, что:\n1. Бот добавлен в группу/канал\n2. В группе/канале было отправлено хотя бы одно сообщение\n3. Бот имеет права администратора (для каналов)'
    });
  } catch (error) {
    console.error('Ошибка получения чатов из Telegram:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      message: 'Не удалось получить список чатов. Проверьте токен бота и убедитесь, что бот активен.'
    });
  }
});

// API для получения всех заказов (админ-панель)
app.get('/orders', authenticateToken, (req, res) => {
  const { status, branchId, limit = 100, offset = 0, dateFrom, dateTo } = req.query;
  
  let query = `
    SELECT 
      o.id,
      o.branch_id,
      o.total,
      o.status,
      o.order_details,
      o.delivery_details,
      o.cart_items,
      o.discount,
      o.promo_code,
      o.cashback_used,
      o.created_at,
      b.name as branch_name,
      b.address as branch_address,
      b.phone as branch_phone
    FROM orders o
    LEFT JOIN branches b ON o.branch_id = b.id
    WHERE 1=1
  `;
  const params = [];
  
  if (status) {
    query += ' AND o.status = ?';
    params.push(status);
  }
  
  if (branchId) {
    query += ' AND o.branch_id = ?';
    params.push(branchId);
  }
  
  if (dateFrom) {
    query += ' AND DATE(o.created_at) >= ?';
    params.push(dateFrom);
  }
  
  if (dateTo) {
    query += ' AND DATE(o.created_at) <= ?';
    params.push(dateTo);
  }
  
  query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  
  db.query(query, params, (err, orders) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    
    const parsedOrders = orders.map(order => ({
      ...order,
      order_details: order.order_details ? JSON.parse(order.order_details) : {},
      delivery_details: order.delivery_details ? JSON.parse(order.delivery_details) : {},
      cart_items: order.cart_items ? JSON.parse(order.cart_items) : []
    }));
    
    res.json(parsedOrders);
  });
});

// API для получения статистики заказов
app.get('/orders/stats', authenticateToken, (req, res) => {
  const { branchId, dateFrom, dateTo } = req.query;
  
  let whereClause = 'WHERE 1=1';
  const params = [];
  
  if (branchId) {
    whereClause += ' AND branch_id = ?';
    params.push(branchId);
  }
  
  if (dateFrom) {
    whereClause += ' AND DATE(created_at) >= ?';
    params.push(dateFrom);
  }
  
  if (dateTo) {
    whereClause += ' AND DATE(created_at) <= ?';
    params.push(dateTo);
  }
  
  const statsQuery = `
    SELECT 
      COUNT(*) as total_orders,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_orders,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing_orders,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
      SUM(total) as total_revenue,
      AVG(total) as avg_order_value
    FROM orders
    ${whereClause}
  `;
  
  db.query(statsQuery, params, (err, stats) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(stats[0] || {});
  });
});

// API для получения одного заказа
app.get('/orders/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  
  db.query(`
    SELECT 
      o.*,
      b.name as branch_name,
      b.address as branch_address,
      b.phone as branch_phone
    FROM orders o
    LEFT JOIN branches b ON o.branch_id = b.id
    WHERE o.id = ?
  `, [id], (err, orders) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (orders.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
    
    const order = orders[0];
    order.order_details = order.order_details ? JSON.parse(order.order_details) : {};
    order.delivery_details = order.delivery_details ? JSON.parse(order.delivery_details) : {};
    order.cart_items = order.cart_items ? JSON.parse(order.cart_items) : [];
    
    res.json(order);
  });
});

// API для обновления статуса заказа
app.put('/orders/:id/status', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  const validStatuses = ['pending', 'processing', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Некорректный статус заказа' });
  }
  
  db.query(
    'UPDATE orders SET status = ? WHERE id = ?',
    [status, id],
    (err) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      
      // Получаем обновленный заказ
      db.query('SELECT * FROM orders WHERE id = ?', [id], (err, orders) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        
        const order = orders[0];
        order.order_details = order.order_details ? JSON.parse(order.order_details) : {};
        order.delivery_details = order.delivery_details ? JSON.parse(order.delivery_details) : {};
        order.cart_items = order.cart_items ? JSON.parse(order.cart_items) : [];
        
        res.json({ message: 'Статус заказа обновлен', order });
      });
    }
  );
});

// API для получения новых заказов (для real-time обновлений)
app.get('/orders/new', authenticateToken, (req, res) => {
  const { lastOrderId = 0 } = req.query;
  
  db.query(`
    SELECT 
      o.id,
      o.branch_id,
      o.total,
      o.status,
      o.order_details,
      o.delivery_details,
      o.cart_items,
      o.discount,
      o.promo_code,
      o.cashback_used,
      o.created_at,
      b.name as branch_name
    FROM orders o
    LEFT JOIN branches b ON o.branch_id = b.id
    WHERE o.id > ? AND o.status IN ('pending', 'processing')
    ORDER BY o.created_at DESC
    LIMIT 50
  `, [lastOrderId], (err, orders) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    
    const parsedOrders = orders.map(order => ({
      ...order,
      order_details: order.order_details ? JSON.parse(order.order_details) : {},
      delivery_details: order.delivery_details ? JSON.parse(order.delivery_details) : {},
      cart_items: order.cart_items ? JSON.parse(order.cart_items) : []
    }));
    
    res.json(parsedOrders);
  });
});

// Webhook для Telegram бота - принимает обновления от Telegram
app.post('/telegram/webhook', async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ error: 'Telegram bot token не настроен' });
  }

  try {
    const update = req.body;
    
    // Отвечаем Telegram сразу, чтобы не было таймаута
    res.status(200).json({ ok: true });
    
    // Обрабатываем обновление асинхронно
    processTelegramUpdate(update);
  } catch (error) {
    console.error('Ошибка обработки webhook Telegram:', error);
    res.status(200).json({ ok: true }); // Все равно отвечаем OK, чтобы Telegram не повторял запрос
  }
});

// Функция обработки обновлений от Telegram
async function processTelegramUpdate(update) {
  try {
    // Обработка сообщений
    if (update.message) {
      const message = update.message;
      const chatId = message.chat.id;
      const text = message.text || '';
      const from = message.from;
      
      // Игнорируем сообщения из групп (только личные сообщения)
      if (message.chat.type !== 'private') {
        return;
      }
      
      // Обработка команд
      if (text.startsWith('/')) {
        await handleTelegramCommand(chatId, text, from);
        return;
      }
      
      // Обработка текстовых заказов
      if (text.trim().length > 0) {
        await handleTelegramOrder(chatId, text, from);
      }
    }
    
    // Обработка callback_query (кнопки)
    if (update.callback_query) {
      const callback = update.callback_query;
      await handleTelegramCallback(callback);
    }
  } catch (error) {
    console.error('Ошибка обработки обновления Telegram:', error);
  }
}

// Обработка команд бота
async function handleTelegramCommand(chatId, command, from) {
  const commandName = command.split(' ')[0].toLowerCase();
  
  switch (commandName) {
    case '/start':
      await sendTelegramMessage(chatId, `
🍕 *Добро пожаловать в BOODAI PIZZA!*

Я помогу вам оформить заказ.

📋 *Доступные команды:*
/start - Начать работу
/menu - Посмотреть меню
/order - Оформить заказ
/status - Проверить статус заказа
/help - Помощь

Просто напишите мне, что вы хотите заказать, и я помогу оформить заказ!
      `);
      break;
      
    case '/menu':
      await sendMenuToTelegram(chatId);
      break;
      
    case '/order':
      await sendTelegramMessage(chatId, `
📝 *Оформление заказа*

Напишите мне ваш заказ в следующем формате:

*Пример:*
🍕 Пицца Маргарита - 1 шт
🥤 Кола - 2 шт
📍 Адрес: ул. Ленина, 10
📞 Телефон: +996505001093
💬 Комментарий: Без лука

Или просто опишите, что вы хотите заказать, и я помогу!
      `);
      break;
      
    case '/help':
      await sendTelegramMessage(chatId, `
❓ *Помощь*

Для оформления заказа просто напишите мне:
- Что вы хотите заказать
- Ваш адрес доставки
- Контактный телефон

Или используйте команду /order для подробной инструкции.

📞 Если возникли вопросы, свяжитесь с нами по телефону.
      `);
      break;
      
    default:
      await sendTelegramMessage(chatId, 'Неизвестная команда. Используйте /help для списка команд.');
  }
}

// Отправка меню в Telegram
async function sendMenuToTelegram(chatId) {
  try {
    db.query(`
      SELECT p.name, p.price_single, p.price_small, p.price_medium, p.price_large, 
             c.name as category_name, b.name as branch_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN branches b ON p.branch_id = b.id
      WHERE p.price_single > 0 OR p.price_small > 0 OR p.price_medium > 0 OR p.price_large > 0
      ORDER BY c.name, p.name
      LIMIT 50
    `, async (err, products) => {
      if (err) {
        await sendTelegramMessage(chatId, '❌ Ошибка загрузки меню. Попробуйте позже.');
        return;
      }
      
      if (products.length === 0) {
        await sendTelegramMessage(chatId, '📋 Меню пока пусто. Загляните позже!');
        return;
      }
      
      let menuText = '🍕 *МЕНЮ BOODAI PIZZA*\n\n';
      let currentCategory = '';
      
      products.forEach(product => {
        if (product.category_name !== currentCategory) {
          currentCategory = product.category_name;
          menuText += `\n*${currentCategory || 'Без категории'}*\n`;
        }
        
        menuText += `\n🍴 ${product.name}`;
        
        if (product.price_small) menuText += `\n   Маленький: ${product.price_small} сом`;
        if (product.price_medium) menuText += `\n   Средний: ${product.price_medium} сом`;
        if (product.price_large) menuText += `\n   Большой: ${product.price_large} сом`;
        if (product.price_single) menuText += `\n   Цена: ${product.price_single} сом`;
        
        menuText += '\n';
      });
      
      menuText += '\n💬 Напишите /order чтобы оформить заказ';
      
      await sendTelegramMessage(chatId, menuText);
    });
  } catch (error) {
    console.error('Ошибка отправки меню:', error);
  }
}

// Обработка заказа из Telegram
async function handleTelegramOrder(chatId, text, from) {
  try {
    // Парсим заказ из текста
    const orderData = parseOrderFromText(text, from);
    
    if (!orderData.phone) {
      await sendTelegramMessage(chatId, `
❌ *Не указан телефон*

Пожалуйста, укажите ваш контактный телефон в формате:
📞 +996505001093

Или напишите заказ заново с указанием телефона.
      `);
      return;
    }
    
    // Получаем филиал по умолчанию (первый) или можно добавить выбор
    db.query('SELECT id, name FROM branches LIMIT 1', async (err, branches) => {
      if (err || branches.length === 0) {
        await sendTelegramMessage(chatId, '❌ Ошибка: филиалы не найдены. Свяжитесь с администратором.');
        return;
      }
      
      const branchId = branches[0].id;
      const branchName = branches[0].name;
      
      // Создаем заказ
      const orderDetails = {
        name: orderData.name || from.first_name || 'Клиент',
        phone: orderData.phone,
        comments: orderData.comments || `Заказ через Telegram от @${from.username || 'пользователя'}`
      };
      
      const deliveryDetails = {
        name: orderData.name || from.first_name || 'Клиент',
        phone: orderData.phone,
        address: orderData.address || 'Не указан'
      };
      
      const cartItems = orderData.items || [];
      
      // Если товары не распознаны, создаем заказ с комментарием
      if (cartItems.length === 0) {
        cartItems.push({
          name: 'Заказ из Telegram',
          quantity: 1,
          originalPrice: 0,
          price: 0
        });
      }
      
      const total = cartItems.reduce((sum, item) => 
        sum + (parseFloat(item.originalPrice || item.price || 0) * (item.quantity || 1)), 0
      );
      
      // Сохраняем заказ в базу данных
      db.query(
        `INSERT INTO orders (branch_id, total, status, order_details, delivery_details, cart_items, discount, promo_code, cashback_used)
         VALUES (?, ?, 'pending', ?, ?, ?, 0, NULL, 0)`,
        [
          branchId,
          total,
          JSON.stringify(orderData),
          JSON.stringify(deliveryDetails),
          JSON.stringify(cartItems)
        ],
        async (err, result) => {
          if (err) {
            console.error('Ошибка сохранения заказа из Telegram:', err);
            await sendTelegramMessage(chatId, '❌ Ошибка при сохранении заказа. Попробуйте позже или свяжитесь с нами по телефону.');
            return;
          }
          
          const orderId = result.insertId;
          
          // Отправляем подтверждение клиенту
          await sendTelegramMessage(chatId, `
✅ *Заказ принят!*

📦 Номер заказа: #${orderId}
🏪 Филиал: ${branchName}
💰 Сумма: ${fmt(total)} сом
📞 Телефон: ${orderData.phone}
${orderData.address ? `📍 Адрес: ${orderData.address}` : ''}

⏳ Ваш заказ обрабатывается. Мы свяжемся с вами в ближайшее время!

Используйте /status для проверки статуса заказа.
          `);
          
          // Отправляем уведомление в группу филиала (если настроен chat_id)
          db.query('SELECT telegram_chat_id FROM branches WHERE id = ?', [branchId], async (err, branchData) => {
            if (!err && branchData.length > 0 && branchData[0].telegram_chat_id) {
              const orderText = `
📦 *Новый заказ из Telegram:*
🏪 Филиал: ${branchName}
👤 Имя: ${orderData.name || from.first_name || 'Клиент'}
📞 Телефон: ${orderData.phone}
📍 Адрес: ${orderData.address || 'Не указан'}
💬 Комментарий: ${orderData.comments || text.substring(0, 200)}
🛒 *Товары:*
${cartItems.map(item => `- ${item.name} (${item.quantity || 1} шт. по ${item.originalPrice ?? item.price ?? 0} сом)`).join('\n')}
💰 *Итоговая сумма: ${fmt(total)} сом*
📱 Заказ через Telegram от @${from.username || from.first_name || 'пользователя'}
              `;
              
              await sendTelegramMessageAsync(branchData[0].telegram_chat_id, orderText, branchName);
            }
          });
          
          console.log(`📱 [${new Date().toISOString()}] Новый заказ из Telegram: ID ${orderId}, Телефон: ${orderData.phone}`);
        }
      );
    });
  } catch (error) {
    console.error('Ошибка обработки заказа из Telegram:', error);
    await sendTelegramMessage(chatId, '❌ Произошла ошибка при обработке заказа. Попробуйте позже.');
  }
}

// Парсинг заказа из текста
function parseOrderFromText(text, from) {
  const orderData = {
    name: from.first_name || null,
    phone: null,
    address: null,
    comments: null,
    items: []
  };
  
  // Поиск телефона
  const phoneMatch = text.match(/(\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/);
  if (phoneMatch) {
    orderData.phone = phoneMatch[0].replace(/\s/g, '');
  }
  
  // Поиск адреса
  const addressMatch = text.match(/(?:адрес|адресс?|address)[:：]?\s*(.+?)(?:\n|$)/i);
  if (addressMatch) {
    orderData.address = addressMatch[1].trim();
  }
  
  // Поиск имени
  const nameMatch = text.match(/(?:имя|name)[:：]?\s*(.+?)(?:\n|$)/i);
  if (nameMatch) {
    orderData.name = nameMatch[1].trim();
  }
  
  // Поиск комментария
  const commentMatch = text.match(/(?:комментарий|коммент|comment)[:：]?\s*(.+?)(?:\n|$)/i);
  if (commentMatch) {
    orderData.comments = commentMatch[1].trim();
  }
  
  // Простой парсинг товаров (можно улучшить)
  const lines = text.split('\n');
  lines.forEach(line => {
    if (line.includes(' - ') || line.includes(' x ') || line.includes(' шт')) {
      const itemMatch = line.match(/(.+?)\s*[-x]\s*(\d+)/);
      if (itemMatch) {
        orderData.items.push({
          name: itemMatch[1].trim(),
          quantity: parseInt(itemMatch[2]) || 1,
          originalPrice: 0,
          price: 0
        });
      }
    }
  });
  
  return orderData;
}

// Обработка callback_query (кнопки)
async function handleTelegramCallback(callback) {
  const chatId = callback.message.chat.id;
  const data = callback.data;
  
  // Отвечаем на callback
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
      {
        callback_query_id: callback.id
      }
    );
  } catch (error) {
    console.error('Ошибка ответа на callback:', error);
  }
  
  // Обработка различных callback
  // Можно добавить интерактивное меню, выбор товаров и т.д.
}

// Инициализация webhook при старте сервера
async function setupTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('⚠️ Telegram bot token не настроен, webhook не будет установлен');
    return;
  }
  
  // Если указан URL для webhook, устанавливаем его
  if (TELEGRAM_WEBHOOK_URL) {
    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          url: `${TELEGRAM_WEBHOOK_URL}/telegram/webhook`
        }
      );
      
      if (response.data.ok) {
        console.log('✅ Telegram webhook установлен:', TELEGRAM_WEBHOOK_URL);
      } else {
        console.error('❌ Ошибка установки webhook:', response.data.description);
      }
    } catch (error) {
      console.error('❌ Ошибка установки Telegram webhook:', error.message);
    }
  } else {
    console.log('ℹ️ TELEGRAM_WEBHOOK_URL не указан. Используйте polling или укажите URL для webhook.');
  }
}

app.post('/categories', authenticateToken, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Название категории обязательно' });
  db.query('INSERT INTO categories (name) VALUES (?)', [name], (err, result) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.status(201).json({ id: result.insertId, name });
  });
});

app.put('/categories/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Название категории обязательно' });
  db.query('UPDATE categories SET name = ? WHERE id = ?', [name, id], (err) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json({ id, name });
  });
});

app.delete('/categories/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM categories WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json({ message: 'Категория удалена' });
  });
});

app.get('/subcategories', authenticateToken, (req, res) => {
  db.query(`
    SELECT s.*, c.name as category_name
    FROM subcategories s
    JOIN categories c ON s.category_id = c.id
  `, (err, subcategories) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(subcategories);
  });
});

app.post('/subcategories', authenticateToken, (req, res) => {
  const { name, categoryId } = req.body;
  if (!name || !categoryId) return res.status(400).json({ error: 'Название и категория обязательны' });
  db.query('INSERT INTO subcategories (name, category_id) VALUES (?, ?)', [name, categoryId], (err, result) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    db.query(
      'SELECT s.*, c.name as category_name FROM subcategories s JOIN categories c ON s.category_id = c.id WHERE s.id = ?',
      [result.insertId],
      (err, newSubcategory) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.status(201).json(newSubcategory[0]);
      }
    );
  });
});

app.put('/subcategories/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { name, categoryId } = req.body;
  if (!name || !categoryId) return res.status(400).json({ error: 'Название и категория обязательны' });
  db.query('UPDATE subcategories SET name = ?, category_id = ? WHERE id = ?', [name, categoryId, id], (err) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    db.query(
      'SELECT s.*, c.name as category_name FROM subcategories s JOIN categories c ON s.category_id = c.id WHERE s.id = ?',
      [id],
      (err, updatedSubcategory) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.json(updatedSubcategory[0]);
      }
    );
  });
});

app.delete('/subcategories/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM subcategories WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json({ message: 'Подкатегория удалена' });
  });
});

app.post('/products', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    const { name, description, priceSmall, priceMedium, priceLarge, priceSingle, sizeSmall, sizeMedium, sizeLarge, branchId, categoryId, subCategoryId, sauceIds } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Изображение обязательно' });
    uploadToS3(req.file, (err, imageKey) => {
      if (err) {
        console.error('Ошибка загрузки в S3:', err);
        return res.status(500).json({ error: err.message || 'Ошибка загрузки файла на сервер' });
      }
      if (!name || !branchId || !categoryId || !imageKey) {
        return res.status(400).json({ error: 'Все обязательные поля должны быть заполнены (name, branchId, categoryId, image)' });
      }
      db.query(
        `INSERT INTO products (
          name, description, price_small, price_medium, price_large, price_single,
          size_small, size_medium, size_large,
          branch_id, category_id, sub_category_id, image
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          description || null,
          priceSmall ? parseFloat(priceSmall) : null,
          priceMedium ? parseFloat(priceMedium) : null,
          priceLarge ? parseFloat(priceLarge) : null,
          priceSingle ? parseFloat(priceSingle) : null,
          sizeSmall ? parseInt(sizeSmall) : null,
          sizeMedium ? parseInt(sizeMedium) : null,
          sizeLarge ? parseInt(sizeLarge) : null,
          branchId,
          categoryId,
          subCategoryId || null,
          imageKey,
        ],
        (err, result) => {
          if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          if (sauceIds) {
            let sauceIdsArray = Array.isArray(sauceIds) ? sauceIds : JSON.parse(sauceIds || '[]');
            if (!Array.isArray(sauceIdsArray)) {
              return res.status(400).json({ error: 'sauceIds должен быть массивом' });
            }
            let sauceInsertions = 0;
            if (sauceIdsArray.length === 0) {
              fetchNewProduct();
            } else {
              sauceIdsArray.forEach(sauceId => {
                db.query('SELECT id FROM sauces WHERE id = ?', [sauceId], (err, sauce) => {
                  if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
                  if (sauce.length === 0) {
                    sauceInsertions++;
                    if (sauceInsertions === sauceIdsArray.length) fetchNewProduct();
                    return;
                  }
                  db.query(
                    'INSERT INTO products_sauces (product_id, sauce_id) VALUES (?, ?)',
                    [result.insertId, sauceId],
                    (err) => {
                      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
                      sauceInsertions++;
                      if (sauceInsertions === sauceIdsArray.length) fetchNewProduct();
                    }
                  );
                });
              });
            }
          } else {
            fetchNewProduct();
          }
          function fetchNewProduct() {
            db.query(
              `
              SELECT p.*,
                     b.name as branch_name,
                     c.name as category_name,
                     s.name as subcategory_name,
                     COALESCE(
                       (SELECT JSON_ARRAYAGG(
                         JSON_OBJECT(
                           'id', sa.id,
                           'name', sa.name,
                           'price', sa.price,
                           'image', sa.image
                         )
                       )
                       FROM products_sauces ps
                       LEFT JOIN sauces sa ON ps.sauce_id = sa.id
                       WHERE ps.product_id = p.id AND sa.id IS NOT NULL),
                       '[]'
                     ) as sauces
              FROM products p
              LEFT JOIN branches b ON p.branch_id = b.id
              LEFT JOIN categories c ON p.category_id = c.id
              LEFT JOIN subcategories s ON p.sub_category_id = s.id
              WHERE p.id = ?
              GROUP BY p.id
            `,
              [result.insertId],
              (err, newProduct) => {
                if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
                res.status(201).json({
                  ...newProduct[0],
                  sauces: newProduct[0].sauces ? JSON.parse(newProduct[0].sauces).filter(s => s.id) : []
                });
              }
            );
          }
        }
      );
    });
  });
});

app.put('/products/:id', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    const { id } = req.params;
    const { name, description, priceSmall, priceMedium, priceLarge, priceSingle, sizeSmall, sizeMedium, sizeLarge, branchId, categoryId, subCategoryId, sauceIds } = req.body;
    let imageKey;
    db.query('SELECT image FROM products WHERE id = ?', [id], (err, existing) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (existing.length === 0) return res.status(404).json({ error: 'Продукт не найден' });
      if (req.file) {
        uploadToS3(req.file, (err, key) => {
          if (err) {
            console.error('Ошибка загрузки в S3:', err);
            return res.status(500).json({ error: err.message || 'Ошибка загрузки файла на сервер' });
          }
          imageKey = key;
          if (existing[0].image) deleteFromS3(existing[0].image, updateProduct);
          else updateProduct();
        });
      } else {
        imageKey = existing[0].image;
        updateProduct();
      }
      function updateProduct() {
        db.query(
          `UPDATE products SET
            name = ?, description = ?, price_small = ?, price_medium = ?, price_large = ?,
            price_single = ?, size_small = ?, size_medium = ?, size_large = ?,
            branch_id = ?, category_id = ?, sub_category_id = ?, image = ?
          WHERE id = ?`,
          [
            name,
            description || null,
            priceSmall ? parseFloat(priceSmall) : null,
            priceMedium ? parseFloat(priceMedium) : null,
            priceLarge ? parseFloat(priceLarge) : null,
            priceSingle ? parseFloat(priceSingle) : null,
            sizeSmall ? parseInt(sizeSmall) : null,
            sizeMedium ? parseInt(sizeMedium) : null,
            sizeLarge ? parseInt(sizeLarge) : null,
            branchId,
            categoryId,
            subCategoryId || null,
            imageKey,
            id,
          ],
          (err) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            db.query('DELETE FROM products_sauces WHERE product_id = ?', [id], (err) => {
              if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
              if (sauceIds) {
                let sauceIdsArray = Array.isArray(sauceIds) ? sauceIds : JSON.parse(sauceIds || '[]');
                if (!Array.isArray(sauceIdsArray)) {
                  return res.status(400).json({ error: 'sauceIds должен быть массивом' });
                }
                let sauceInsertions = 0;
                if (sauceIdsArray.length === 0) {
                  fetchUpdatedProduct();
                } else {
                  sauceIdsArray.forEach(sauceId => {
                    db.query('SELECT id FROM sauces WHERE id = ?', [sauceId], (err, sauce) => {
                      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
                      if (sauce.length === 0) {
                        sauceInsertions++;
                        if (sauceInsertions === sauceIdsArray.length) fetchUpdatedProduct();
                        return;
                      }
                      db.query(
                        'INSERT INTO products_sauces (product_id, sauce_id) VALUES (?, ?)',
                        [id, sauceId],
                        (err) => {
                          if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
                          sauceInsertions++;
                          if (sauceInsertions === sauceIdsArray.length) fetchUpdatedProduct();
                        }
                      );
                    });
                  });
                }
              } else {
                fetchUpdatedProduct();
              }
            });
          });
      }
      function fetchUpdatedProduct() {
        db.query(
          `
          SELECT p.*,
                 b.name as branch_name,
                 c.name as category_name,
                 s.name as subcategory_name,
                 COALESCE(
                   (SELECT JSON_ARRAYAGG(
                     JSON_OBJECT(
                       'id', sa.id,
                       'name', sa.name,
                       'price', sa.price,
                       'image', sa.image
                     )
                   )
                   FROM products_sauces ps
                   LEFT JOIN sauces sa ON ps.sauce_id = sa.id
                   WHERE ps.product_id = p.id AND sa.id IS NOT NULL),
                   '[]'
                 ) as sauces
          FROM products p
          LEFT JOIN branches b ON p.branch_id = b.id
          LEFT JOIN categories c ON p.category_id = c.id
          LEFT JOIN subcategories s ON p.sub_category_id = s.id
          WHERE p.id = ?
          GROUP BY p.id
        `,
          [id],
          (err, updatedProduct) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            res.json({
              ...updatedProduct[0],
              sauces: updatedProduct[0].sauces ? JSON.parse(updatedProduct[0].sauces).filter(s => s.id) : []
            });
          }
        );
      }
    });
  });
});

app.delete('/products/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('SELECT image FROM products WHERE id = ?', [id], (err, product) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (product.length === 0) return res.status(404).json({ error: 'Продукт не найден' });
    if (product[0].image) deleteFromS3(product[0].image, deleteProduct);
    else deleteProduct();
    function deleteProduct() {
      db.query('DELETE FROM products WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.json({ message: 'Продукт удален' });
      });
    }
  });
});

app.post('/discounts', authenticateToken, (req, res) => {
  const { productId, discountPercent, expiresAt, isActive } = req.body;
  if (!productId || !discountPercent) return res.status(400).json({ error: 'ID продукта и процент скидки обязательны' });
  if (discountPercent < 1 || discountPercent > 100) return res.status(400).json({ error: 'Процент скидки должен быть от 1 до 100' });
  db.query('SELECT id FROM products WHERE id = ?', [productId], (err, product) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (product.length === 0) return res.status(404).json({ error: 'Продукт не найден' });
    db.query(`
      SELECT id FROM discounts
      WHERE product_id = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
    `, [productId], (err, existingDiscount) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (existingDiscount.length > 0) return res.status(400).json({ error: 'Для этого продукта уже существует активная скидка' });
      db.query(
        'INSERT INTO discounts (product_id, discount_percent, expires_at, is_active) VALUES (?, ?, ?, ?)',
        [productId, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true],
        (err, result) => {
          if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          db.query(
            `SELECT d.*, p.name as product_name
            FROM discounts d
            JOIN products p ON d.product_id = p.id
            WHERE d.id = ?`,
            [result.insertId],
            (err, newDiscount) => {
              if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
              res.status(201).json(newDiscount[0]);
            }
          );
        }
      );
    });
  });
});

app.put('/discounts/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { productId, discountPercent, expiresAt, isActive } = req.body;
  if (!productId || !discountPercent) return res.status(400).json({ error: 'ID продукта и процент скидки обязательны' });
  if (discountPercent < 1 || discountPercent > 100) return res.status(400).json({ error: 'Процент скидки должен быть от 1 до 100' });
  db.query('SELECT product_id FROM discounts WHERE id = ?', [id], (err, discount) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (discount.length === 0) return res.status(404).json({ error: 'Скидка не найдена' });
    db.query('SELECT id FROM products WHERE id = ?', [productId], (err, product) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (product.length === 0) return res.status(404).json({ error: 'Продукт не найден' });
      if (discount[0].product_id !== productId) {
        db.query(`
          SELECT id FROM discounts
          WHERE product_id = ? AND id != ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
        `, [productId, id], (err, existingDiscount) => {
          if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          if (existingDiscount.length > 0) return res.status(400).json({ error: 'Для этого продукта уже существует другая активная скидка' });
          updateDiscount();
        });
      } else {
        updateDiscount();
      }
      function updateDiscount() {
        db.query(
          'UPDATE discounts SET product_id = ?, discount_percent = ?, expires_at = ?, is_active = ? WHERE id = ?',
          [productId, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true, id],
          (err) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            db.query(
              `SELECT d.*, p.name as product_name
              FROM discounts d
              JOIN products p ON d.product_id = p.id
              WHERE d.id = ?`,
              [id],
              (err, updatedDiscount) => {
                if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
                res.json(updatedDiscount[0]);
              }
            );
          }
        );
      }
    });
  });
});

app.delete('/discounts/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query(
    `SELECT d.*, p.name as product_name
    FROM discounts d
    JOIN products p ON d.product_id = p.id
    WHERE d.id = ?`,
    [id],
    (err, discount) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (discount.length === 0) return res.status(404).json({ error: 'Скидка не найдена' });
      db.query('DELETE FROM discounts WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.json({ message: 'Скидка удалена', product: { id: discount[0].product_id, name: discount[0].product_name } });
      });
    }
  );
});

app.post('/banners', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    const { title, description, button_text, promo_code_id } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Изображение обязательно' });
    uploadToS3(req.file, (err, imageKey) => {
      if (err) {
        console.error('Ошибка загрузки в S3:', err);
        return res.status(500).json({ error: err.message || 'Ошибка загрузки файла на сервер' });
      }
      if (promo_code_id) {
        db.query('SELECT id FROM promo_codes WHERE id = ?', [promo_code_id], (err, promo) => {
          if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          if (promo.length === 0) return res.status(404).json({ error: 'Промокод не найден' });
          insertBanner();
        });
      } else {
        insertBanner();
      }
      function insertBanner() {
        db.query(
          'INSERT INTO banners (image, title, description, button_text, promo_code_id) VALUES (?, ?, ?, ?, ?)',
          [imageKey, title || null, description || null, button_text || null, promo_code_id || null],
          (err, result) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            db.query(
              `SELECT b.*, pc.code AS promo_code, pc.discount_percent
              FROM banners b
              LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
              WHERE b.id = ?`,
              [result.insertId],
              (err, newBanner) => {
                if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
                res.status(201).json({
                  ...newBanner[0],
                  image: `https://nukesul-brepb-651f.twc1.net/product-image/${newBanner[0].image.split('/').pop()}`
                });
              }
            );
          }
        );
      }
    });
  });
});

app.put('/banners/:id', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    const { id } = req.params;
    const { title, description, button_text, promo_code_id } = req.body;
    let imageKey;
    db.query('SELECT image FROM banners WHERE id = ?', [id], (err, existing) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (existing.length === 0) return res.status(404).json({ error: 'Баннер не найден' });
      if (req.file) {
        uploadToS3(req.file, (err, key) => {
          if (err) {
            console.error('Ошибка загрузки в S3:', err);
            return res.status(500).json({ error: err.message || 'Ошибка загрузки файла на сервер' });
          }
          imageKey = key;
          if (existing[0].image) deleteFromS3(existing[0].image, updateBanner);
          else updateBanner();
        });
      } else {
        imageKey = existing[0].image;
        updateBanner();
      }
      function updateBanner() {
        if (promo_code_id) {
          db.query('SELECT id FROM promo_codes WHERE id = ?', [promo_code_id], (err, promo) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            if (promo.length === 0) return res.status(404).json({ error: 'Промокод не найден' });
            performUpdate();
          });
        } else {
          performUpdate();
        }
        function performUpdate() {
          db.query(
            'UPDATE banners SET image = ?, title = ?, description = ?, button_text = ?, promo_code_id = ? WHERE id = ?',
            [imageKey, title || null, description || null, button_text || null, promo_code_id || null, id],
            (err) => {
              if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
              db.query(
                `SELECT b.*, pc.code AS promo_code, pc.discount_percent
                FROM banners b
                LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
                WHERE b.id = ?`,
                [id],
                (err, updatedBanner) => {
                  if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
                  res.json({
                    ...updatedBanner[0],
                    image: `https://nukesul-brepb-651f.twc1.net/product-image/${updatedBanner[0].image.split('/').pop()}`
                  });
                }
              );
            }
          );
        }
      }
    });
  });
});

app.delete('/banners/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('SELECT image FROM banners WHERE id = ?', [id], (err, banner) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (banner.length === 0) return res.status(404).json({ error: 'Баннер не найден' });
    if (banner[0].image) deleteFromS3(banner[0].image, deleteBanner);
    else deleteBanner();
    function deleteBanner() {
      db.query('DELETE FROM banners WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.json({ message: 'Баннер удален' });
      });
    }
  });
});

app.post('/stories', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    if (!req.file) return res.status(400).json({ error: 'Изображение обязательно' });
    uploadToS3(req.file, (err, imageKey) => {
      if (err) {
        console.error('Ошибка загрузки в S3:', err);
        return res.status(500).json({ error: err.message || 'Ошибка загрузки файла на сервер' });
      }
      db.query('INSERT INTO stories (image) VALUES (?)', [imageKey], (err, result) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.status(201).json({
          id: result.insertId,
          image: `https://nukesul-brepb-651f.twc1.net/product-image/${imageKey.split('/').pop()}`,
          created_at: new Date()
        });
      });
    });
  });
});

app.delete('/stories/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('SELECT image FROM stories WHERE id = ?', [id], (err, story) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (story.length === 0) return res.status(404).json({ error: 'История не найдена' });
    if (story[0].image) deleteFromS3(story[0].image, deleteStory);
    else deleteStory();
    function deleteStory() {
      db.query('DELETE FROM stories WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.json({ message: 'История удалена' });
      });
    }
  });
});

app.post('/sauces', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    const { name, price } = req.body;
    let imageKey = null;
    if (!name || !price) return res.status(400).json({ error: 'Название и цена обязательны' });
    if (req.file) {
      uploadToS3(req.file, (err, key) => {
        if (err) {
          console.error('Ошибка загрузки в S3:', err);
          return res.status(500).json({ error: err.message || 'Ошибка загрузки файла на сервер' });
        }
        imageKey = key;
        insertSauce();
      });
    } else {
      insertSauce();
    }
    function insertSauce() {
      db.query(
        'INSERT INTO sauces (name, price, image) VALUES (?, ?, ?)',
        [name, parseFloat(price), imageKey],
        (err, result) => {
          if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          res.status(201).json({
            id: result.insertId,
            name,
            price: parseFloat(price),
            image: imageKey ? `https://nukesul-brepb-651f.twc1.net/product-image/${imageKey.split('/').pop()}` : null,
            created_at: new Date()
          });
        }
      );
    }
  });
});

app.put('/sauces/:id', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    const { id } = req.params;
    const { name, price } = req.body;
    let imageKey;
    if (!name || !price) return res.status(400).json({ error: 'Название и цена обязательны' });
    db.query('SELECT image FROM sauces WHERE id = ?', [id], (err, existing) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (existing.length === 0) return res.status(404).json({ error: 'Соус не найден' });
      if (req.file) {
        uploadToS3(req.file, (err, key) => {
          if (err) {
            console.error('Ошибка загрузки в S3:', err);
            return res.status(500).json({ error: err.message || 'Ошибка загрузки файла на сервер' });
          }
          imageKey = key;
          if (existing[0].image) deleteFromS3(existing[0].image, updateSauce);
          else updateSauce();
        });
      } else {
        imageKey = existing[0].image;
        updateSauce();
      }
      function updateSauce() {
        db.query(
          'UPDATE sauces SET name = ?, price = ?, image = ? WHERE id = ?',
          [name, parseFloat(price), imageKey, id],
          (err) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            res.json({
              id,
              name,
              price: parseFloat(price),
              image: imageKey ? `https://nukesul-brepb-651f.twc1.net/product-image/${imageKey.split('/').pop()}` : null,
              created_at: existing[0].created_at
            });
          }
        );
      }
    });
  });
});

app.delete('/sauces/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('SELECT image FROM sauces WHERE id = ?', [id], (err, sauce) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (sauce.length === 0) return res.status(404).json({ error: 'Соус не найден' });
    if (sauce[0].image) deleteFromS3(sauce[0].image, deleteSauce);
    else deleteSauce();
    function deleteSauce() {
      db.query('DELETE FROM sauces WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.json({ message: 'Соус удален' });
      });
    }
  });
});

app.post('/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Все поля обязательны' });
  db.query('SELECT * FROM users WHERE email = ?', [email], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (users.length > 0) return res.status(400).json({ error: 'Email уже зарегистрирован' });
    bcrypt.hash(password, 10, (err, hashedPassword) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      db.query(
        'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
        [name, email, hashedPassword],
        (err, result) => {
          if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          const token = jwt.sign({ id: result.insertId, email }, JWT_SECRET, { expiresIn: '1h' });
          res.status(201).json({ token, user: { id: result.insertId, name, email } });
        }
      );
    });
  });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Введите email и пароль' });
  db.query('SELECT * FROM users WHERE email = ?', [email], (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (users.length === 0) return res.status(401).json({ error: 'Неверный email или пароль' });
    const user = users[0];
    bcrypt.compare(password, user.password, (err, isMatch) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (!isMatch) return res.status(401).json({ error: 'Неверный email или пароль' });
      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
      res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
    });
  });
});

app.get('/users', authenticateToken, (req, res) => {
  db.query('SELECT id, name, email FROM users', (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(users);
  });
});

// API для получения всех пользователей приложения (app_users)
app.get('/app-users', authenticateToken, (req, res) => {
  db.query('SELECT id, phone, name, user_code, address, created_at, referrer_id FROM app_users ORDER BY created_at DESC', (err, users) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(users);
  });
});

// ========== ПРОМОКОДЫ НА ТОВАРЫ ==========
app.get('/product-promo-codes', authenticateToken, (req, res) => {
  db.query(`
    SELECT ppc.*, p.name as product_name, pc.code as promo_code, pc.discount_percent
    FROM product_promo_codes ppc
    LEFT JOIN products p ON ppc.product_id = p.id
    LEFT JOIN promo_codes pc ON ppc.promo_code_id = pc.id
    ORDER BY ppc.created_at DESC
  `, (err, productPromoCodes) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(productPromoCodes);
  });
});

app.post('/product-promo-codes', authenticateToken, (req, res) => {
  const { productId, promoCodeId } = req.body;
  if (!productId || !promoCodeId) {
    return res.status(400).json({ error: 'ID продукта и промокода обязательны' });
  }
  db.query(
    'INSERT INTO product_promo_codes (product_id, promo_code_id) VALUES (?, ?)',
    [productId, promoCodeId],
    (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({ error: 'Эта привязка уже существует' });
        }
        return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      }
      db.query(`
        SELECT ppc.*, p.name as product_name, pc.code as promo_code, pc.discount_percent
        FROM product_promo_codes ppc
        LEFT JOIN products p ON ppc.product_id = p.id
        LEFT JOIN promo_codes pc ON ppc.promo_code_id = pc.id
        WHERE ppc.id = ?
      `, [result.insertId], (err, rows) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.status(201).json(rows[0]);
      });
    }
  );
});

app.delete('/product-promo-codes/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM product_promo_codes WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json({ message: 'Привязка удалена' });
  });
});

// ========== НОВОСТИ ==========
// Публичный эндпоинт для получения новостей
app.get('/api/public/news', (req, res) => {
  db.query('SELECT * FROM news ORDER BY created_at DESC', (err, news) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    const newsWithUrls = news.map(item => ({
      ...item,
      image: item.image ? `https://vasya010-red-bdf5.twc1.net/product-image/${item.image.split('/').pop()}` : null
    }));
    res.json(newsWithUrls);
  });
});

app.get('/news', authenticateToken, (req, res) => {
  db.query('SELECT * FROM news ORDER BY created_at DESC', (err, news) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    const newsWithUrls = news.map(item => ({
      ...item,
      image: item.image ? `https://vasya010-red-bdf5.twc1.net/product-image/${item.image.split('/').pop()}` : null
    }));
    res.json(newsWithUrls);
  });
});

app.post('/news', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    const { title, content } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Заголовок и содержание обязательны' });
    }
    
    const handleInsert = (imageKey) => {
      db.query(
        'INSERT INTO news (title, content, image) VALUES (?, ?, ?)',
        [title, content, imageKey || null],
        (err, result) => {
          if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          db.query('SELECT * FROM news WHERE id = ?', [result.insertId], (err, rows) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            const newsItem = rows[0];
            res.status(201).json({
              ...newsItem,
              image: newsItem.image ? `https://vasya010-red-bdf5.twc1.net/product-image/${newsItem.image.split('/').pop()}` : null
            });
          });
        }
      );
    };

    if (req.file) {
      uploadToS3(req.file, (err, key) => {
        if (err) {
          console.error('Ошибка загрузки в S3:', err);
          return res.status(500).json({ error: err.message || 'Ошибка загрузки файла на сервер' });
        }
        handleInsert(key);
      });
    } else {
      handleInsert(null);
    }
  });
});

app.put('/news/:id', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    const { id } = req.params;
    const { title, content } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Заголовок и содержание обязательны' });
    }

    db.query('SELECT image FROM news WHERE id = ?', [id], (err, existing) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (existing.length === 0) return res.status(404).json({ error: 'Новость не найдена' });

      let imageKey = existing[0].image;
      if (req.file) {
        uploadToS3(req.file, (err, key) => {
          if (err) {
            console.error('Ошибка загрузки в S3:', err);
            return res.status(500).json({ error: err.message || 'Ошибка загрузки файла на сервер' });
          }
          imageKey = key;
          if (existing[0].image) deleteFromS3(existing[0].image, updateNews);
          else updateNews();
        });
      } else {
        updateNews();
      }

      function updateNews() {
        db.query(
          'UPDATE news SET title = ?, content = ?, image = ? WHERE id = ?',
          [title, content, imageKey, id],
          (err) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            db.query('SELECT * FROM news WHERE id = ?', [id], (err, rows) => {
              if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
              const newsItem = rows[0];
              res.json({
                ...newsItem,
                image: newsItem.image ? `https://vasya010-red-bdf5.twc1.net/product-image/${newsItem.image.split('/').pop()}` : null
              });
            });
          }
        );
      }
    });
  });
});

app.delete('/news/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('SELECT image FROM news WHERE id = ?', [id], (err, news) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (news.length === 0) return res.status(404).json({ error: 'Новость не найдена' });
    if (news[0].image) deleteFromS3(news[0].image, deleteNews);
    else deleteNews();
    function deleteNews() {
      db.query('DELETE FROM news WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.json({ message: 'Новость удалена' });
      });
    }
  });
});

// ========== АКЦИИ ==========
function sendPromotionNotifications(promotion, callback) {
  db.query('SELECT id FROM app_users', (err, users) => {
    if (err) {
      console.error('Ошибка получения пользователей для уведомлений:', err);
      return callback(err);
    }
    
    let notificationsSent = 0;
    let errors = 0;
    const totalUsers = users.length;
    
    if (totalUsers === 0) {
      return callback(null, { sent: 0, total: 0 });
    }

    const imageUrl = promotion.image ? `https://vasya010-red-bdf5.twc1.net/product-image/${promotion.image.split('/').pop()}` : null;
    const promoText = promotion.promo_code ? ` Промокод: ${promotion.promo_code} (${promotion.discount_percent}%)` : '';
    
    users.forEach((user, index) => {
      const notification = {
        user_id: user.id,
        type: 'promotion',
        title: promotion.title,
        message: `${promotion.description}${promoText}`,
        image_url: imageUrl,
        action_url: null,
        data: JSON.stringify({ promotion_id: promotion.id })
      };

      db.query(
        'INSERT INTO notifications (user_id, type, title, message, image_url, action_url, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [notification.user_id, notification.type, notification.title, notification.message, notification.image_url, notification.action_url, notification.data],
        (err) => {
          if (err) {
            console.error(`Ошибка создания уведомления для пользователя ${user.id}:`, err);
            errors++;
          } else {
            notificationsSent++;
          }

          if (notificationsSent + errors === totalUsers) {
            callback(null, { sent: notificationsSent, total: totalUsers, errors });
          }
        }
      );
    });
  });
}

// Публичный эндпоинт для получения акций
app.get('/api/public/promotions', (req, res) => {
  db.query(`
    SELECT p.*, pc.code as promo_code, pc.discount_percent
    FROM promotions p
    LEFT JOIN promo_codes pc ON p.promo_code_id = pc.id
    WHERE pc.is_active = TRUE OR pc.id IS NULL
    ORDER BY p.created_at DESC
  `, (err, promotions) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    const promotionsWithUrls = promotions.map(item => ({
      ...item,
      image: item.image ? `https://vasya010-red-bdf5.twc1.net/product-image/${item.image.split('/').pop()}` : null
    }));
    res.json(promotionsWithUrls);
  });
});

app.get('/promotions', authenticateToken, (req, res) => {
  db.query(`
    SELECT p.*, pc.code as promo_code, pc.discount_percent
    FROM promotions p
    LEFT JOIN promo_codes pc ON p.promo_code_id = pc.id
    ORDER BY p.created_at DESC
  `, (err, promotions) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    const promotionsWithUrls = promotions.map(item => ({
      ...item,
      image: item.image ? `https://vasya010-red-bdf5.twc1.net/product-image/${item.image.split('/').pop()}` : null
    }));
    res.json(promotionsWithUrls);
  });
});

app.post('/promotions', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    const { title, description, promo_code_id, send_notification } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'Заголовок и описание обязательны' });
    }

    const handleInsert = (imageKey) => {
      db.query(
        'INSERT INTO promotions (title, description, image, promo_code_id) VALUES (?, ?, ?, ?)',
        [title, description, imageKey || null, promo_code_id || null],
        (err, result) => {
          if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          
          db.query(`
            SELECT p.*, pc.code as promo_code, pc.discount_percent
            FROM promotions p
            LEFT JOIN promo_codes pc ON p.promo_code_id = pc.id
            WHERE p.id = ?
          `, [result.insertId], (err, rows) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            const promotion = rows[0];
            const promotionWithUrl = {
              ...promotion,
              image: promotion.image ? `https://vasya010-red-bdf5.twc1.net/product-image/${promotion.image.split('/').pop()}` : null
            };

            // Отправка уведомлений, если требуется
            if (send_notification === 'true' || send_notification === true) {
              sendPromotionNotifications(promotionWithUrl, (err, result) => {
                if (err) {
                  console.error('Ошибка отправки уведомлений:', err);
                } else {
                  console.log(`Уведомления отправлены: ${result.sent} из ${result.total}`);
                }
              });
            }

            res.status(201).json(promotionWithUrl);
          });
        }
      );
    };

    if (req.file) {
      uploadToS3(req.file, (err, key) => {
        if (err) {
          console.error('Ошибка загрузки в S3:', err);
          return res.status(500).json({ error: err.message || 'Ошибка загрузки файла на сервер' });
        }
        handleInsert(key);
      });
    } else {
      handleInsert(null);
    }
  });
});

app.put('/promotions/:id', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    const { id } = req.params;
    const { title, description, promo_code_id } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'Заголовок и описание обязательны' });
    }

    db.query('SELECT image FROM promotions WHERE id = ?', [id], (err, existing) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (existing.length === 0) return res.status(404).json({ error: 'Акция не найдена' });

      let imageKey = existing[0].image;
      if (req.file) {
        uploadToS3(req.file, (err, key) => {
          if (err) {
            console.error('Ошибка загрузки в S3:', err);
            return res.status(500).json({ error: err.message || 'Ошибка загрузки файла на сервер' });
          }
          imageKey = key;
          if (existing[0].image) deleteFromS3(existing[0].image, updatePromotion);
          else updatePromotion();
        });
      } else {
        updatePromotion();
      }

      function updatePromotion() {
        db.query(
          'UPDATE promotions SET title = ?, description = ?, image = ?, promo_code_id = ? WHERE id = ?',
          [title, description, imageKey, promo_code_id || null, id],
          (err) => {
            if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
            db.query(`
              SELECT p.*, pc.code as promo_code, pc.discount_percent
              FROM promotions p
              LEFT JOIN promo_codes pc ON p.promo_code_id = pc.id
              WHERE p.id = ?
            `, [id], (err, rows) => {
              if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
              const promotion = rows[0];
              res.json({
                ...promotion,
                image: promotion.image ? `https://vasya010-red-bdf5.twc1.net/product-image/${promotion.image.split('/').pop()}` : null
              });
            });
          }
        );
      }
    });
  });
});

app.delete('/promotions/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('SELECT image FROM promotions WHERE id = ?', [id], (err, promotions) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (promotions.length === 0) return res.status(404).json({ error: 'Акция не найдена' });
    if (promotions[0].image) deleteFromS3(promotions[0].image, deletePromotion);
    else deletePromotion();
    function deletePromotion() {
      db.query('DELETE FROM promotions WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.json({ message: 'Акция удалена' });
      });
    }
  });
});

// SMS Gateway endpoint (для отправки SMS с этого же сервера)
app.post('/sms/send', async (req, res) => {
  try {
    const { api_key, phone, message, code } = req.body;
    
    // Проверка API ключа (если настроен)
    if (SMS_GATEWAY_API_KEY && SMS_GATEWAY_API_KEY !== '' && api_key !== SMS_GATEWAY_API_KEY) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid API key' 
      });
    }
    
    // Проверка обязательных полей
    if (!phone || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Phone and message are required' 
      });
    }
    
    console.log(`\n📤 Отправка SMS через gateway:`);
    console.log(`   Телефон: ${phone}`);
    console.log(`   Сообщение: ${message}`);
    console.log(`   Код: ${code || 'N/A'}\n`);
    
    // Здесь должна быть реальная отправка SMS через модем/API оператора
    // Пока просто логируем (адаптируйте под ваш способ отправки)
    
    // ПРИМЕР: Отправка через команду (раскомментируйте и адаптируйте)
    // const { exec } = require('child_process');
    // const phoneClean = phone.replace(/\D/g, '');
    // const command = `gammu sendsms TEXT ${phoneClean} -text "${message}"`;
    // exec(command, (error, stdout, stderr) => {
    //   if (error) {
    //     console.error('Ошибка отправки SMS:', error);
    //     return res.status(500).json({ success: false, error: error.message });
    //   }
    //   console.log(`✅ SMS отправлено на ${phone}`);
    //   res.json({ success: true, status: 'sent', phone: phone });
    // });
    
    // ВРЕМЕННО: Возвращаем успех (замените на реальную отправку)
    console.log(`✅ SMS gateway получил запрос для ${phone}`);
    res.json({ 
      success: true, 
      status: 'sent',
      phone: phone,
      message: 'SMS gateway endpoint работает. Настройте реальную отправку SMS.'
    });
    
  } catch (error) {
    console.error('Ошибка обработки запроса SMS gateway:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// GET endpoint для SMS gateway (для совместимости)
app.get('/sms/send', async (req, res) => {
  try {
    const { api_key, phone, message, code } = req.query;
    
    if (SMS_GATEWAY_API_KEY && SMS_GATEWAY_API_KEY !== '' && api_key !== SMS_GATEWAY_API_KEY) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }
    
    if (!phone || !message) {
      return res.status(400).json({ success: false, error: 'Phone and message are required' });
    }
    
    console.log(`📤 GET запрос SMS: ${phone} - ${message}`);
    res.json({ success: true, status: 'sent', phone: phone });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

initializeServer((err) => {
  if (err) {
    console.error('❌ Ошибка инициализации сервера:', err.message);
    process.exit(1);
  }
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    const timestamp = new Date().toISOString();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 [${timestamp}] Сервер запущен на порту ${PORT}`);
    console.log(`🌐 [${timestamp}] API доступен по адресу: http://localhost:${PORT}`);
    
    // Устанавливаем webhook для Telegram бота после запуска сервера
    await setupTelegramWebhook();
    console.log(`📡 [${timestamp}] Публичные endpoints:`);
    console.log(`   - GET  /api/public/branches`);
    console.log(`   - GET  /api/public/branches/:branchId/products`);
    console.log(`   - GET  /api/public/sauces (с фильтрацией: search, sort, order, limit, offset, branchId)`);
    console.log(`   - GET  /api/public/products/:productId/sauces (с сортировкой: sort, order)`);
    console.log(`   - GET  /api/public/branches/:branchId/sauces (с поиском и сортировкой)`);
    console.log(`   - GET  /api/public/sauces/popular (с параметрами: limit, branchId)`);
  });
  
  // Обработка ошибок сервера
  app.on('error', (err) => {
    console.error('❌ Ошибка сервера:', err);
  });
  
  process.on('uncaughtException', (err) => {
    console.error('❌ Необработанное исключение:', err);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    const timestamp = new Date().toISOString();
    console.error(`\n❌ [${timestamp}] Необработанный rejection:`, reason);
    console.error(`   Promise:`, promise);
  });
  
  process.on('uncaughtException', (error) => {
    const timestamp = new Date().toISOString();
    console.error(`\n❌ [${timestamp}] Необработанное исключение:`, error);
    console.error(`   Stack:`, error.stack);
  });
});