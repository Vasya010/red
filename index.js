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

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_very_secure_random_string';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  console.error('ОШИБКА: TELEGRAM_BOT_TOKEN не установлен в переменных окружения!');
  process.exit(1);
}
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'GIMZKRMOGP4F0MOTLVCE';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'WvhFfIzzCkITUrXfD8JfoDne7LmBhnNzDuDBj89I';
const MYSQL_HOST = process.env.MYSQL_HOST || 'vh438.timeweb.ru';
const MYSQL_USER = process.env.MYSQL_USER || 'ch79145_pizza';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || 'Vasya11091109';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'ch79145_pizza';
// Локальный SMS Gateway (на вашем сервере)
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
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('image');

function uploadToS3(file, callback) {
  const key = `pizza-images/${Date.now()}${path.extname(file.originalname)}`;
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  };
  const upload = new Upload({ client: s3Client, params });
  upload.done().then(() => callback(null, key)).catch(callback);
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

// Обработка ошибок подключения к БД122
db.on('error', (err) => {
  console.error('❌ Ошибка подключения к MySQL:', err);
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.log('🔄 Переподключение к MySQL...');
  } else {
    throw err;
  }
});

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Токен отсутствует' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Недействительный токен' });
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

app.get('/product-image/:key', optionalAuthenticateToken, (req, res) => {
  const { key } = req.params;
  getFromS3(`pizza-images/${key}`, (err, image) => {
    if (err) return res.status(500).json({ error: `Ошибка получения изображения: ${err.message}` });
    res.setHeader('Content-Type', image.ContentType || 'image/jpeg');
    image.Body.pipe(res);
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
                    ['american_pizza.osh', '-1003140309410'],
                    ['Араванский', '-1002311447135'],
                    ['Ошский район', '-1002638475628'],
                  ];
                  let updated = 0;
                  updateQueries.forEach(([name, telegram_chat_id]) => {
                    connection.query(
                      'UPDATE branches SET telegram_chat_id = ? WHERE name = ? AND (telegram_chat_id IS NULL OR telegram_chat_id = "")',
                      [telegram_chat_id, name],
                      (err) => {
                        if (err) {
                          connection.release();
                          return callback(err);
                        }
                        updated++;
                        if (updated === updateQueries.length) continueInitialization();
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
              let productAlterations = 0;
              const checkProductAlterations = () => {
                productAlterations++;
                if (productAlterations === 3) createSubcategoriesTable();
              };
              if (!columns.includes('mini_recipe')) {
                connection.query('ALTER TABLE products ADD COLUMN mini_recipe TEXT', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                  checkProductAlterations();
                });
              } else {
                checkProductAlterations();
              }
              if (!columns.includes('sub_category_id')) {
                connection.query('ALTER TABLE products ADD COLUMN sub_category_id INT', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                  checkProductAlterations();
                });
              } else {
                checkProductAlterations();
              }
              if (!columns.includes('is_pizza')) {
                connection.query('ALTER TABLE products ADD COLUMN is_pizza BOOLEAN DEFAULT FALSE', (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                  checkProductAlterations();
                });
              } else {
                checkProductAlterations();
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
              status ENUM('pending', 'accepted', 'preparing', 'sent', 'on_way', 'delivered', 'cancelled') DEFAULT 'pending',
              order_details JSON,
              delivery_details JSON,
              cart_items JSON,
              discount INT DEFAULT 0,
              promo_code VARCHAR(50),
              cashback_used DECIMAL(10,2) DEFAULT 0,
              user_id INT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
              FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE SET NULL
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
                  checkUserIdColumn();
                });
              } else {
                checkUserIdColumn();
              }
            });
            
            function checkUserIdColumn() {
              connection.query('SHOW COLUMNS FROM orders LIKE "user_id"', (err, userIdColumns) => {
                if (err) {
                  connection.release();
                  return callback(err);
                }
                if (userIdColumns.length === 0) {
                  connection.query('ALTER TABLE orders ADD COLUMN user_id INT, ADD FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE SET NULL', (err) => {
                    if (err) {
                      connection.release();
                      return callback(err);
                    }
                    updateOrderStatusEnum();
                  });
                } else {
                  updateOrderStatusEnum();
                }
              });
            }
            
            function updateOrderStatusEnum() {
              connection.query(`
                ALTER TABLE orders 
                MODIFY COLUMN status ENUM('pending', 'accepted', 'preparing', 'sent', 'on_way', 'delivered', 'cancelled') DEFAULT 'pending'
              `, (err) => {
                if (err) {
                  console.log('Статусы заказов уже обновлены или ошибка:', err.message);
                }
                // Обновляем старые статусы на новые
                connection.query(`UPDATE orders SET status = 'accepted' WHERE status = 'processing'`, () => {});
                connection.query(`UPDATE orders SET status = 'delivered' WHERE status = 'completed'`, () => {});
                createCardRequestsAndCouriersTables();
              });
            }
            
            function createCardRequestsAndCouriersTables() {
              connection.query(`
                CREATE TABLE IF NOT EXISTS card_requests (
                  id INT AUTO_INCREMENT PRIMARY KEY,
                  user_id INT,
                  first_name VARCHAR(100) NOT NULL,
                  last_name VARCHAR(100) NOT NULL,
                  phone VARCHAR(20) NOT NULL,
                  status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE SET NULL,
                  INDEX idx_status (status),
                  INDEX idx_user_id (user_id)
                )
              `, (err) => {
                if (err) {
                  connection.release();
                  return callback(err);
                }
                connection.query(`
                  CREATE TABLE IF NOT EXISTS couriers (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    phone VARCHAR(20) NOT NULL,
                    vehicle VARCHAR(100),
                    is_active BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_is_active (is_active)
                  )
                `, (err) => {
                  if (err) {
                    connection.release();
                    return callback(err);
                  }
                  createCashbackTables();
                });
              });
            }
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
                  // Проверяем наличие поля last_qr_cashback_date
                  connection.query('SHOW COLUMNS FROM app_users LIKE "last_qr_cashback_date"', (err, cashbackColumns) => {
                    if (err) {
                      connection.release();
                      return callback(err);
                    }
                    if (cashbackColumns.length === 0) {
                      connection.query('ALTER TABLE app_users ADD COLUMN last_qr_cashback_date DATE', (err) => {
                        connection.release();
                        return callback(err);
                      });
                    } else {
                      connection.release();
                      return callback(null);
                    }
                  });
                });
              } else {
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
                      createStoriesTable();
                    });
                  } else {
                    createStoriesTable();
                  }
                });
              }
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
          // Создаем таблицы для заявок на карты и курьеров, если их еще нет
          connection.query(`
            CREATE TABLE IF NOT EXISTS card_requests (
              id INT AUTO_INCREMENT PRIMARY KEY,
              user_id INT,
              first_name VARCHAR(100) NOT NULL,
              last_name VARCHAR(100) NOT NULL,
              phone VARCHAR(20) NOT NULL,
              status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE SET NULL,
              INDEX idx_status (status),
              INDEX idx_user_id (user_id)
            )
          `, (err) => {
            if (err) {
              console.log('Ошибка создания таблицы card_requests:', err.message);
            }
            connection.query(`
              CREATE TABLE IF NOT EXISTS couriers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                vehicle VARCHAR(100),
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_is_active (is_active)
              )
            `, (err) => {
              if (err) {
                console.log('Ошибка создания таблицы couriers:', err.message);
              }
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
            });
          });
        }
      });
    });
  }
  attemptConnection();
}

app.get('/api/public/branches', (req, res) => {
  db.query('SELECT id, name, address FROM branches', (err, branches) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(branches);
  });
});

app.get('/api/public/branches/:branchId/products', (req, res) => {
  const { branchId } = req.params;
  db.query(`
    SELECT p.id, p.name, p.description, p.price_small, p.price_medium, p.price_large,
           p.price_single AS price, p.image AS image_url, c.name AS category,
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
    WHERE p.branch_id = ?
    GROUP BY p.id
  `, [branchId], (err, products) => {
    if (err) {
      console.error('Ошибка получения продуктов:', err);
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
  
  // Валидация параметров сортировки
  const validSortFields = ['name', 'price', 'usage_count'];
  const validOrders = ['ASC', 'DESC'];
  const sortField = validSortFields.includes(sort) ? sort : 'name';
  const sortOrder = validOrders.includes(order.toUpperCase()) ? order.toUpperCase() : 'ASC';
  
  let query = `
    SELECT DISTINCT s.id, s.name, s.price, s.image, s.created_at,
           COUNT(DISTINCT ps.product_id) as usage_count
    FROM sauces s
    INNER JOIN products_sauces ps ON s.id = ps.sauce_id
    INNER JOIN products p ON ps.product_id = p.id
    WHERE p.branch_id = ?
  `;
  let queryParams = [branchId];
  
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
  db.query(`
    SELECT discount_percent AS discount
    FROM promo_codes
    WHERE code = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
  `, [promoCode], (err, promo) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (promo.length === 0) return res.status(400).json({ error: 'Промокод недействителен' });
    res.json({ discount: promo[0].discount });
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
  
  // Получаем телефон пользователя из базы, если авторизован
  const getUserPhone = (callback) => {
    if (!userId) {
      return callback(phone);
    }
    db.query('SELECT phone FROM app_users WHERE id = ?', [userId], (err, users) => {
      if (err || users.length === 0) {
        return callback(phone);
      }
      callback(users[0].phone);
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
    
    const total = cartItems.reduce((sum, item) => sum + (Number(item.originalPrice) || 0) * item.quantity, 0);
    const discountedTotal = total * (1 - (discount || 0) / 100);
    const cashbackUsedAmount = userId ? (Number(cashbackUsed) || 0) : 0; // Кешбэк только для авторизованных
    
    // Кешбэк начисляется только для авторизованных пользователей
    const cashbackEarned = userId ? Math.round(discountedTotal * 0.03) : 0; // 3% кешбэк
    const finalTotal = Math.max(0, discountedTotal - cashbackUsedAmount);
    
    const escapeMarkdown = (text) => (text ? text.replace(/([_*[\]()~`>#+-.!])/g, '\\$1') : 'Нет');
    const paymentMethodText = paymentMethod === 'cash' ? 'Наличными' : paymentMethod === 'card' ? 'Картой' : 'Не указан';
    
    // Получаем телефон пользователя и обрабатываем заказ
    getUserPhone((userPhone) => {
      // Обрабатываем кешбэк (только для авторизованных пользователей)
      const processCashback = (callback) => {
        if (!userId || !userPhone) {
          return callback();
        }
      
      // Списываем использованный кешбэк
      if (cashbackUsedAmount > 0) {
        db.query(
          'UPDATE cashback_balance SET balance = balance - ?, total_spent = total_spent + ? WHERE phone = ? AND balance >= ?',
          [cashbackUsedAmount, cashbackUsedAmount, userPhone, cashbackUsedAmount],
          (err, result) => {
            if (err) {
              console.error('Ошибка списания кешбэка:', err);
              return callback();
            }
            if (result.affectedRows > 0) {
              // Записываем транзакцию списания
              db.query(
                'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, ?, "spent", ?, ?)',
                [userPhone, null, cashbackUsedAmount, 'Использование кешбэка для оплаты заказа'],
                () => {}
              );
            }
            // Начисляем новый кешбэк
            if (cashbackEarned > 0) {
              db.query(
                `INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level)
                 VALUES (?, ?, ?, 1, 'bronze')
                 ON DUPLICATE KEY UPDATE
                 balance = balance + ?,
                 total_earned = total_earned + ?,
                 total_orders = total_orders + 1,
                 user_level = CASE
                   WHEN total_orders + 1 >= 100 THEN 'platinum'
                   WHEN total_orders + 1 >= 50 THEN 'gold'
                   WHEN total_orders + 1 >= 10 THEN 'silver'
                   ELSE 'bronze'
                 END`,
                [userPhone, cashbackEarned, cashbackEarned, cashbackEarned, cashbackEarned],
                (err) => {
                  if (err) {
                    console.error('Ошибка начисления кешбэка:', err);
                    return callback();
                  }
                  // Записываем транзакцию начисления
                  db.query(
                    'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, ?, "earned", ?, ?)',
                    [userPhone, null, cashbackEarned, 'Кешбэк за заказ'],
                    () => {}
                  );
                  callback();
                }
              );
            } else {
              callback();
            }
          }
        );
      } else if (cashbackEarned > 0) {
        // Только начисляем кешбэк
        db.query(
          `INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level)
           VALUES (?, ?, ?, 1, 'bronze')
           ON DUPLICATE KEY UPDATE
           balance = balance + ?,
           total_earned = total_earned + ?,
           total_orders = total_orders + 1,
           user_level = CASE
             WHEN total_orders + 1 >= 100 THEN 'platinum'
             WHEN total_orders + 1 >= 50 THEN 'gold'
             WHEN total_orders + 1 >= 10 THEN 'silver'
             ELSE 'bronze'
           END`,
          [userPhone, cashbackEarned, cashbackEarned, cashbackEarned, cashbackEarned],
          (err) => {
            if (err) {
              console.error('Ошибка начисления кешбэка:', err);
              return callback();
            }
            db.query(
              'INSERT INTO cashback_transactions (phone, order_id, type, amount, description) VALUES (?, ?, "earned", ?, ?)',
              [userPhone, null, cashbackEarned, 'Кешбэк за заказ'],
              () => {}
            );
            callback();
          }
        );
      } else {
        callback();
      }
    };
    
    const orderText = `
📦 *Новый заказ:*
🏪 Филиал: ${escapeMarkdown(branchName)}
👤 Имя: ${escapeMarkdown(orderDetails.name || deliveryDetails.name)}
📞 Телефон: ${escapeMarkdown(phone)}
📝 Комментарии: ${escapeMarkdown(orderDetails.comments || deliveryDetails.comments || "Нет")}
📍 Адрес доставки: ${escapeMarkdown(deliveryDetails.address || "Самовывоз")}
💳 Способ оплаты: ${escapeMarkdown(paymentMethodText)}
🛒 *Товары:*
${cartItems.map((item) => `- ${escapeMarkdown(item.name)} (${item.quantity} шт. по ${item.originalPrice} сом)`).join('\n')}
💰 Сумма товаров: ${total.toFixed(2)} сом
${discount > 0 ? `💸 Скидка (${discount}%): -${(total * discount / 100).toFixed(2)} сом` : ''}
${cashbackUsedAmount > 0 ? `🎁 Кешбэк использован: -${cashbackUsedAmount.toFixed(2)} сом` : ''}
${cashbackEarned > 0 ? `✨ Кешбэк начислен: +${cashbackEarned.toFixed(2)} сом` : ''}
💰 *Итоговая сумма: ${finalTotal.toFixed(2)} сом*
    `;
    
    db.query(
      `
      INSERT INTO orders (branch_id, total, status, order_details, delivery_details, cart_items, discount, promo_code, cashback_used, user_id)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
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
        userId || null,
      ],
      (err, result) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        const orderId = result.insertId;
        
        // Обновляем order_id в транзакциях кешбэка
        if (userId && userPhone && (cashbackUsedAmount > 0 || cashbackEarned > 0)) {
          db.query(
            'UPDATE cashback_transactions SET order_id = ? WHERE phone = ? AND order_id IS NULL ORDER BY created_at DESC LIMIT 2',
            [orderId, userPhone],
            () => {}
          );
        }
        
        // Обрабатываем кешбэк, затем отправляем в Telegram
        processCashback(() => {
          axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: chatId,
              text: orderText,
              parse_mode: 'Markdown',
            }
          ).then(response => {
            res.status(200).json({ 
              message: 'Заказ успешно отправлен', 
              orderId: orderId,
              cashbackEarned: cashbackEarned
            });
          }).catch(telegramError => {
            const errorDescription = telegramError.response?.data?.description || telegramError.message;
            if (telegramError.response?.data?.error_code === 403) {
              return res.status(500).json({
                error: `Бот не имеет прав для отправки сообщений в группу (chat_id: ${chatId}). Убедитесь, что бот добавлен в группу и имеет права администратора.`,
              });
            }
            return res.status(500).json({ error: `Ошибка отправки в Telegram: ${errorDescription}` });
          });
        });
      }
    );
    }); // Закрываем getUserPhone callback
  });
});

// Хранилище для SMS кодов (в продакшене использовать Redis или БД)
const smsCodes = new Map();

// Генерация 4-значного кода
function generateSMSCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
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
  const { phone, code } = req.body;
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
      db.query('INSERT INTO app_users (phone) VALUES (?)', [cleanPhone], (err, result) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        
        const token = jwt.sign({ id: result.insertId, phone: cleanPhone }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ 
          token, 
          user: { id: result.insertId, phone: cleanPhone, name: null },
          isNewUser: true
        });
      });
    } else {
      // Вход существующего пользователя
      const user = users[0];
      const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
      res.json({ 
        token, 
        user: { id: user.id, phone: user.phone, name: user.name },
        isNewUser: false
      });
    }
  });
});

// API для входа/регистрации по телефону (старый метод, оставляем для совместимости)
app.post('/api/public/auth/phone', (req, res) => {
  const { phone } = req.body;
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
      db.query('INSERT INTO app_users (phone) VALUES (?)', [cleanPhone], (err, result) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        
        const token = jwt.sign({ id: result.insertId, phone: cleanPhone }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ 
          token, 
          user: { id: result.insertId, phone: cleanPhone, name: null },
          isNewUser: true
        });
      });
    } else {
      // Вход существующего пользователя
      const user = users[0];
      const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
      res.json({ 
        token, 
        user: { id: user.id, phone: user.phone, name: user.name },
        isNewUser: false
      });
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
app.get('/api/public/auth/profile', authenticateToken, (req, res) => {
  const userId = req.user?.id;
  const userPhone = req.user?.phone;
  
  if (!userId) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }
  
  // Сначала ищем по ID
  db.query('SELECT * FROM app_users WHERE id = ?', [userId], (err, users) => {
    if (err) {
      console.error('Ошибка получения профиля:', err);
      return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    }
    
    // Если пользователь найден по ID
    if (users.length > 0) {
      const user = users[0];
      return res.json({ 
        user: { 
          id: user.id, 
          phone: user.phone, 
          name: user.name, 
          address: user.address,
          first_name: user.name ? user.name.split(' ')[0] : null,
          last_name: user.name ? user.name.split(' ').slice(1).join(' ') : null
        } 
      });
    }
    
    // Если пользователь не найден по ID, но есть телефон, ищем по телефону
    if (userPhone) {
      db.query('SELECT * FROM app_users WHERE phone = ?', [userPhone], (err, usersByPhone) => {
        if (err) {
          console.error('Ошибка поиска пользователя по телефону:', err);
        }
        
        if (usersByPhone && usersByPhone.length > 0) {
          const user = usersByPhone[0];
          return res.json({ 
            user: { 
              id: user.id, 
              phone: user.phone, 
              name: user.name, 
              address: user.address,
              first_name: user.name ? user.name.split(' ')[0] : null,
              last_name: user.name ? user.name.split(' ').slice(1).join(' ') : null
            } 
          });
        }
        
        // Если не найден ни по ID, ни по телефону, возвращаем пустой профиль
        return res.json({ 
          user: { 
            id: userId, 
            phone: userPhone, 
            name: null, 
            address: null,
            first_name: null,
            last_name: null
          } 
        });
      });
    } else {
      // Если нет телефона в токене, возвращаем пустой профиль
      return res.json({ 
        user: { 
          id: userId, 
          phone: null, 
          name: null, 
          address: null,
          first_name: null,
          last_name: null
        } 
      });
    }
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
  
  // Проверяем, что это админ с правильным email
  if (email !== 'admin@ameranpizza.com') {
    return res.status(403).json({ error: 'Доступ запрещен. Только администратор может войти в админ-панель.' });
  }
  
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
    const parsedProducts = products.map(product => ({
      ...product,
      sauces: product.sauces ? JSON.parse(product.sauces).filter(s => s && s.id) : []
    }));
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
    if (err) return res.status(400).json({ error: `Ошибка загрузки изображения: ${err.message}` });
    const { name, description, priceSmall, priceMedium, priceLarge, priceSingle, branchId, categoryId, subCategoryId, sauceIds } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Изображение обязательно' });
    uploadToS3(req.file, (err, imageKey) => {
      if (err) return res.status(500).json({ error: `Ошибка загрузки в S3: ${err.message}` });
      if (!name || !branchId || !categoryId || !imageKey) {
        return res.status(400).json({ error: 'Все обязательные поля должны быть заполнены (name, branchId, categoryId, image)' });
      }
      db.query(
        `INSERT INTO products (
          name, description, price_small, price_medium, price_large, price_single,
          branch_id, category_id, sub_category_id, image
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          description || null,
          priceSmall ? parseFloat(priceSmall) : null,
          priceMedium ? parseFloat(priceMedium) : null,
          priceLarge ? parseFloat(priceLarge) : null,
          priceSingle ? parseFloat(priceSingle) : null,
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
    if (err) return res.status(400).json({ error: `Ошибка загрузки изображения: ${err.message}` });
    const { id } = req.params;
    const { name, description, priceSmall, priceMedium, priceLarge, priceSingle, branchId, categoryId, subCategoryId, sauceIds } = req.body;
    let imageKey;
    db.query('SELECT image FROM products WHERE id = ?', [id], (err, existing) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (existing.length === 0) return res.status(404).json({ error: 'Продукт не найден' });
      if (req.file) {
        uploadToS3(req.file, (err, key) => {
          if (err) return res.status(500).json({ error: `Ошибка загрузки в S3: ${err.message}` });
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
            price_single = ?, branch_id = ?, category_id = ?, sub_category_id = ?, image = ?
          WHERE id = ?`,
          [
            name,
            description || null,
            priceSmall ? parseFloat(priceSmall) : null,
            priceMedium ? parseFloat(priceMedium) : null,
            priceLarge ? parseFloat(priceLarge) : null,
            priceSingle ? parseFloat(priceSingle) : null,
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
    if (err) return res.status(400).json({ error: `Ошибка загрузки изображения: ${err.message}` });
    const { title, description, button_text, promo_code_id } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Изображение обязательно' });
    uploadToS3(req.file, (err, imageKey) => {
      if (err) return res.status(500).json({ error: `Ошибка загрузки в S3: ${err.message}` });
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
    if (err) return res.status(400).json({ error: `Ошибка загрузки изображения: ${err.message}` });
    const { id } = req.params;
    const { title, description, button_text, promo_code_id } = req.body;
    let imageKey;
    db.query('SELECT image FROM banners WHERE id = ?', [id], (err, existing) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (existing.length === 0) return res.status(404).json({ error: 'Баннер не найден' });
      if (req.file) {
        uploadToS3(req.file, (err, key) => {
          if (err) return res.status(500).json({ error: `Ошибка загрузки в S3: ${err.message}` });
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
    if (err) return res.status(400).json({ error: `Ошибка загрузки изображения: ${err.message}` });
    if (!req.file) return res.status(400).json({ error: 'Изображение обязательно' });
    uploadToS3(req.file, (err, imageKey) => {
      if (err) return res.status(500).json({ error: `Ошибка загрузки в S3: ${err.message}` });
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
    if (err) return res.status(400).json({ error: `Ошибка загрузки изображения: ${err.message}` });
    const { name, price } = req.body;
    let imageKey = null;
    if (!name || !price) return res.status(400).json({ error: 'Название и цена обязательны' });
    if (req.file) {
      uploadToS3(req.file, (err, key) => {
        if (err) return res.status(500).json({ error: `Ошибка загрузки в S3: ${err.message}` });
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
    if (err) return res.status(400).json({ error: `Ошибка загрузки изображения: ${err.message}` });
    const { id } = req.params;
    const { name, price } = req.body;
    let imageKey;
    if (!name || !price) return res.status(400).json({ error: 'Название и цена обязательны' });
    db.query('SELECT image FROM sauces WHERE id = ?', [id], (err, existing) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (existing.length === 0) return res.status(404).json({ error: 'Соус не найден' });
      if (req.file) {
        uploadToS3(req.file, (err, key) => {
          if (err) return res.status(500).json({ error: `Ошибка загрузки в S3: ${err.message}` });
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
    if (err) return res.status(400).json({ error: `Ошибка загрузки изображения: ${err.message}` });
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
              image: newsItem.image ? `https://vasya010-red-bdf5.twc1.netproduct-image/${newsItem.image.split('/').pop()}` : null
            });
          });
        }
      );
    };

    if (req.file) {
      uploadToS3(req.file, (err, key) => {
        if (err) return res.status(500).json({ error: `Ошибка загрузки в S3: ${err.message}` });
        handleInsert(key);
      });
    } else {
      handleInsert(null);
    }
  });
});

app.put('/news/:id', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: `Ошибка загрузки изображения: ${err.message}` });
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
          if (err) return res.status(500).json({ error: `Ошибка загрузки в S3: ${err.message}` });
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
    if (err) return res.status(400).json({ error: `Ошибка загрузки изображения: ${err.message}` });
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
        if (err) return res.status(500).json({ error: `Ошибка загрузки в S3: ${err.message}` });
        handleInsert(key);
      });
    } else {
      handleInsert(null);
    }
  });
});

app.put('/promotions/:id', authenticateToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: `Ошибка загрузки изображения: ${err.message}` });
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
          if (err) return res.status(500).json({ error: `Ошибка загрузки в S3: ${err.message}` });
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

// Заказ карты
app.post('/api/public/order-card', authenticateToken, (req, res) => {
  const { first_name, last_name, phone } = req.body;
  const userId = req.user?.id;

  if (!first_name || !last_name || !phone) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }

  // Проверяем, существует ли пользователь в app_users
  const checkUserAndCreateRequest = (finalUserId) => {
    // Проверяем, есть ли уже активная заявка по телефону или user_id
    const checkQuery = finalUserId 
      ? 'SELECT * FROM card_requests WHERE (user_id = ? OR phone = ?) AND status = "pending"'
      : 'SELECT * FROM card_requests WHERE phone = ? AND status = "pending"';
    const checkParams = finalUserId ? [finalUserId, phone] : [phone];
    
    db.query(checkQuery, checkParams, (err, existing) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      if (existing.length > 0) {
        return res.status(400).json({ error: 'У вас уже есть активная заявка на карту' });
      }

      // Создаем заявку (user_id может быть NULL)
      db.query(
        'INSERT INTO card_requests (user_id, first_name, last_name, phone, status) VALUES (?, ?, ?, ?, "pending")',
        [finalUserId || null, first_name, last_name, phone],
        (err, result) => {
          if (err) {
            console.error('Ошибка создания заявки на карту:', err);
            return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
          }
          
          // Создаем уведомление для админа
          db.query(
            'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, "card_request")',
            [
              finalUserId || null,
              'Новая заявка на карту',
              `Пользователь ${first_name} ${last_name} (${phone}) подал заявку на карту`
            ],
            () => {}
          );

          res.json({ 
            success: true, 
            message: 'Заявка на карту отправлена. Ожидайте подтверждения администратора.',
            request_id: result.insertId
          });
        }
      );
    });
  };

  if (userId) {
    // Проверяем, существует ли пользователь в app_users
    db.query('SELECT id FROM app_users WHERE id = ?', [userId], (err, users) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      // Если пользователь не найден, используем NULL
      const finalUserId = users.length > 0 ? userId : null;
      checkUserAndCreateRequest(finalUserId);
    });
  } else {
    // Если user_id нет в токене, создаем заявку без user_id
    checkUserAndCreateRequest(null);
  }
});

// Админ: Получить все заявки на карты
app.get('/card-requests', authenticateToken, (req, res) => {
  db.query(`
    SELECT cr.*, 
           au.phone as user_phone,
           au.name as user_name
    FROM card_requests cr
    LEFT JOIN app_users au ON cr.user_id = au.id
    ORDER BY cr.created_at DESC
  `, (err, requests) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(requests);
  });
});

// Админ: Одобрить заявку на карту
app.put('/card-requests/:id/approve', authenticateToken, (req, res) => {
  const { id } = req.params;
  
  db.query('SELECT * FROM card_requests WHERE id = ?', [id], (err, requests) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (requests.length === 0) return res.status(404).json({ error: 'Заявка не найдена' });
    
    const request = requests[0];
    
    // Обновляем статус заявки
    db.query(
      'UPDATE card_requests SET status = "approved" WHERE id = ?',
      [id],
      (err) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        
        // Создаем карту (добавляем запись в cashback_balance с начальным балансом 0)
        db.query(
          'INSERT INTO cashback_balance (phone, balance, total_earned, total_orders, user_level) VALUES (?, 0, 0, 0, "bronze") ON DUPLICATE KEY UPDATE phone = phone',
          [request.phone],
          (err) => {
            if (err) console.error('Ошибка создания карты:', err);
            
            // Создаем уведомление для пользователя
            if (request.user_id) {
              db.query(
                'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, "card_approved")',
                [
                  request.user_id,
                  'Карта одобрена!',
                  'Ваша заявка на карту была одобрена. Теперь вы можете получать кешбек с каждого заказа!'
                ],
                () => {}
              );
            }
            
            res.json({ 
              success: true, 
              message: 'Заявка одобрена, карта создана',
              request: { ...request, status: 'approved' }
            });
          }
        );
      }
    );
  });
});

// Админ: Отклонить заявку на карту
app.delete('/card-requests/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  
  db.query('SELECT * FROM card_requests WHERE id = ?', [id], (err, requests) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (requests.length === 0) return res.status(404).json({ error: 'Заявка не найдена' });
    
    const request = requests[0];
    
    // Обновляем статус на rejected
    db.query(
      'UPDATE card_requests SET status = "rejected" WHERE id = ?',
      [id],
      (err) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        
        // Создаем уведомление для пользователя
        if (request.user_id) {
          db.query(
            'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, "card_rejected")',
            [
              request.user_id,
              'Заявка на карту отклонена',
              'К сожалению, ваша заявка на карту была отклонена. Свяжитесь с администратором для уточнения деталей.'
            ],
            () => {}
          );
        }
        
        res.json({ success: true, message: 'Заявка отклонена' });
      }
    );
  });
});

// Админ: Получить всех курьеров
app.get('/couriers', authenticateToken, (req, res) => {
  db.query('SELECT * FROM couriers ORDER BY created_at DESC', (err, couriers) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(couriers);
  });
});

// Админ: Создать курьера
app.post('/couriers', authenticateToken, (req, res) => {
  const { name, phone, vehicle } = req.body;
  
  if (!name || !phone) {
    return res.status(400).json({ error: 'Имя и телефон обязательны' });
  }
  
  db.query(
    'INSERT INTO couriers (name, phone, vehicle) VALUES (?, ?, ?)',
    [name, phone, vehicle || null],
    (err, result) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      res.json({ 
        success: true, 
        message: 'Курьер создан',
        courier: { id: result.insertId, name, phone, vehicle }
      });
    }
  );
});

// Админ: Обновить курьера
app.put('/couriers/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { name, phone, vehicle, is_active } = req.body;
  
  db.query(
    'UPDATE couriers SET name = ?, phone = ?, vehicle = ?, is_active = ? WHERE id = ?',
    [name, phone, vehicle || null, is_active !== undefined ? is_active : true, id],
    (err) => {
      if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
      db.query('SELECT * FROM couriers WHERE id = ?', [id], (err, couriers) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        res.json(couriers[0]);
      });
    }
  );
});

// Админ: Удалить курьера
app.delete('/couriers/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM couriers WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json({ success: true, message: 'Курьер удален' });
  });
});

// Админ: Получить все заказы
app.get('/orders', authenticateToken, (req, res) => {
  db.query(`
    SELECT o.*, 
           b.name as branch_name,
           au.phone as user_phone,
           au.name as user_name
    FROM orders o
    LEFT JOIN branches b ON o.branch_id = b.id
    LEFT JOIN app_users au ON o.user_id = au.id
    ORDER BY o.created_at DESC
  `, (err, orders) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    res.json(orders);
  });
});

// Админ: Обновить статус заказа
app.put('/orders/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  if (!status) {
    return res.status(400).json({ error: 'Статус обязателен' });
  }
  
  db.query('SELECT * FROM orders WHERE id = ?', [id], (err, orders) => {
    if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
    if (orders.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
    
    const order = orders[0];
    
    db.query(
      'UPDATE orders SET status = ? WHERE id = ?',
      [status, id],
      (err) => {
        if (err) return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
        
        // Получаем user_id из заказа (если есть)
        const userId = order.user_id;
        
        // Создаем уведомление для пользователя
        if (userId) {
          const statusMessages = {
            'accepted': 'Ваш заказ принят!',
            'preparing': 'Ваш заказ готовится!',
            'sent': 'Ваш заказ отправлен!',
            'on_way': 'Ваш заказ в пути!',
            'delivered': 'Ваш заказ доставлен! Приятного аппетита!',
            'cancelled': 'Ваш заказ был отменен.'
          };
          
          const statusTitles = {
            'accepted': 'Заказ принят',
            'preparing': 'Заказ готовится',
            'sent': 'Заказ отправлен',
            'on_way': 'Заказ в пути',
            'delivered': 'Заказ доставлен',
            'cancelled': 'Заказ отменен'
          };
          
          db.query(
            'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, "order_status")',
            [
              userId,
              statusTitles[status] || 'Статус заказа изменен',
              statusMessages[status] || `Статус вашего заказа изменен на: ${status}`
            ],
            () => {}
          );
        }
        
        // Отправляем уведомление в телеграм (если настроен)
        if (order.branch_id && TELEGRAM_BOT_TOKEN) {
          db.query('SELECT telegram_chat_id FROM branches WHERE id = ?', [order.branch_id], (err, branches) => {
            if (!err && branches.length > 0 && branches[0].telegram_chat_id) {
              const chatId = branches[0].telegram_chat_id;
              const message = `📦 Статус заказа #${id} изменен на: ${status}`;
              axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML'
              }).catch(err => console.error('Ошибка отправки в Telegram:', err));
            }
          });
        }
        
        res.json({ success: true, message: 'Статус заказа обновлен', order: { ...order, status } });
      }
    );
  });
});

initializeServer((err) => {
  if (err) {
    console.error('❌ Ошибка инициализации сервера:', err.message);
    process.exit(1);
  }
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    console.log(`🌐 API доступен по адресу: http://localhost:${PORT}`);
    console.log(`📡 Публичные endpoints:`);
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
    console.error('❌ Необработанный rejection:', reason);
  });
});