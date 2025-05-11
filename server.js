// server.js
// Онлайн-игра Durak, адаптированная для развертывания на Render с PostgreSQL
// Исправлена кнопка "Take Cards", файлы обслуживаются из папки public

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg'); // PostgreSQL клиент
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Инициализация Express и HTTP-сервера
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type'],
        credentials: true
    }
});

// Конфигурация порта и базы данных
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

// Инициализация пула подключений к PostgreSQL
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Необходим для Render PostgreSQL
    },
    max: 20, // Максимальное количество подключений в пуле
    idleTimeoutMillis: 30000, // Время простоя перед закрытием соединения
    connectionTimeoutMillis: 2000 // Таймаут подключения
});

// Проверка подключения к базе данных
async function checkDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('Успешное подключение к базе данных PostgreSQL');
        client.release();
    } catch (err) {
        console.error('Ошибка подключения к базе данных:', err.message);
        process.exit(1);
    }
}
checkDatabaseConnection();

// Инициализация схемы базы данных
async function initDatabase() {
    try {
        console.log('Инициализация базы данных...');
        // Удаление существующих таблиц
        await pool.query('DROP TABLE IF EXISTS players CASCADE');
        await pool.query('DROP TABLE IF EXISTS rooms CASCADE');

        // Создание таблицы rooms
        await pool.query(`
            CREATE TABLE rooms (
                roomId TEXT PRIMARY KEY,
                trump JSONB,
                deck JSONB,
                gameTable JSONB,
                currentAttacker TEXT,
                currentDefender TEXT,
                createdAt BIGINT,
                lastActivity BIGINT,
                activePlayers INTEGER DEFAULT 0,
                gameEnded BOOLEAN DEFAULT FALSE
            )
        `);
        console.log('Таблица rooms создана');

        // Создание таблицы players
        await pool.query(`
            CREATE TABLE players (
                id TEXT PRIMARY KEY,
                roomId TEXT,
                playerId TEXT UNIQUE,
                name TEXT,
                ready BOOLEAN DEFAULT FALSE,
                hand JSONB,
                joinedAt BIGINT,
                isDisconnected BOOLEAN DEFAULT FALSE,
                lastDisconnectedAt BIGINT,
                language TEXT DEFAULT 'en',
                socketIds JSONB DEFAULT '[]',
                FOREIGN KEY (roomId) REFERENCES rooms (roomId) ON DELETE CASCADE
            )
        `);
        console.log('Таблица players создана');

        // Очистка таблиц для чистого старта
        await pool.query('DELETE FROM rooms');
        await pool.query('DELETE FROM players');
        console.log('Таблицы очищены');
    } catch (err) {
        console.error('Ошибка инициализации базы данных:', err.message);
        process.exit(1);
    }
}
initDatabase();

// Настройка Express для обслуживания статических файлов из папки public
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css');
        }
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));

// Маршруты для HTML страниц
app.get('/', (req, res) => {
    console.log('Запрос главной страницы');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/room', (req, res) => {
    console.log('Запрос страницы комнаты');
    res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/game', (req, res) => {
    console.log('Запрос страницы игры');
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// API для получения состояния комнаты
app.get('/room/:roomId', async (req, res) => {
    const roomId = sanitizeInput(req.params.roomId);
    console.log(`HTTP запрос состояния комнаты: roomId=${roomId}`);
    try {
        const playersResult = await pool.query(
            'SELECT name, ready, hand, language, playerId FROM players WHERE roomId = $1',
            [roomId]
        );
        const roomResult = await pool.query(
            'SELECT roomId, trump, deck, gameTable, currentAttacker, currentDefender FROM rooms WHERE roomId = $1',
            [roomId]
        );

        if (!roomResult.rows[0]) {
            console.log(`Комната ${roomId} не найдена для HTTP запроса`);
            return res.status(404).json({ error: 'Комната не найдена' });
        }

        const players = playersResult.rows;
        const room = roomResult.rows[0];
        const playerNames = players.map(p => p.name);
        const readyCount = players.filter(p => p.ready).length;
        const totalCount = players.length;
        console.log(`HTTP ответ для комнаты ${roomId}: игроки=${playerNames.join(',') || 'нет'}, готовы=${readyCount}/${totalCount}`);

        res.json({
            players: players.map(player => ({
                name: player.name,
                ready: !!player.ready,
                hand: player.hand ? JSON.parse(player.hand) : [],
                language: player.language,
                playerId: player.playerId
            })),
            readyCount,
            totalCount,
            trump: room.trump ? JSON.parse(room.trump) : null,
            deckCount: room.deck ? JSON.parse(room.deck).length : 0,
            table: room.gameTable ? JSON.parse(room.gameTable) : [],
            currentAttacker: room.currentAttacker,
            currentDefender: room.currentDefender
        });
    } catch (err) {
        console.error('Ошибка получения состояния комнаты:', err.message);
        res.status(500).json({ error: 'Ошибка сервера при получении состояния комнаты' });
    }
});

// Функция очистки ввода
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 50);
}

// Очистка языкового ввода
function sanitizeLanguage(lang) {
    const validLanguages = ['en', 'ru', 'uk'];
    return validLanguages.includes(lang) ? lang : 'en';
}

// Генерация 4-значного кода комнаты
async function generateRoomCode() {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const result = await pool.query('SELECT roomId FROM rooms WHERE roomId = $1', [code]);
    if (result.rows.length > 0) {
        return generateRoomCode(); // Рекурсия при совпадении кода
    }
    console.log(`Сгенерирован код комнаты: ${code}`);
    return code;
}

// Управление socketIds для игроков
async function addSocketId(playerId, socketId) {
    try {
        const result = await pool.query('SELECT socketIds FROM players WHERE playerId = $1', [playerId]);
        let socketIds = result.rows[0]?.socketIds ? JSON.parse(result.rows[0].socketIds) : [];
        
        // Отключение старых сокетов
        socketIds.forEach(id => {
            if (id !== socketId && io.sockets.sockets.get(id)) {
                console.log(`Отключение старого сокета ${id} для playerId ${playerId}`);
                io.to(id).emit('errorMessage', 'Другая сессия взяла управление этим игроком');
                io.sockets.sockets.get(id)?.disconnect(true);
            }
        });

        // Обновление списка сокетов
        socketIds = socketIds.filter(id => id === socketId || io.sockets.sockets.get(id));
        if (!socketIds.includes(socketId)) {
            socketIds.push(socketId);
        }

        await pool.query('UPDATE players SET socketIds = $1 WHERE playerId = $2', [JSON.stringify(socketIds), playerId]);
        console.log(`Добавлен socketId ${socketId} для playerId ${playerId}`);
    } catch (err) {
        console.error('Ошибка добавления socketId:', err.message);
        throw err;
    }
}

async function removeSocketId(playerId, socketId) {
    try {
        const result = await pool.query('SELECT socketIds FROM players WHERE playerId = $1', [playerId]);
        let socketIds = result.rows[0]?.socketIds ? JSON.parse(result.rows[0].socketIds) : [];
        socketIds = socketIds.filter(id => id !== socketId);
        await pool.query('UPDATE players SET socketIds = $1 WHERE playerId = $2', [JSON.stringify(socketIds), playerId]);
        console.log(`Удален socketId ${socketId} для playerId ${playerId}`);
    } catch (err) {
        console.error('Ошибка удаления socketId:', err.message);
        throw err;
    }
}

// Очистка дубликатов игроков
async function cleanDuplicatePlayers(roomId, playerName, socketId, playerId) {
    try {
        const result = await pool.query(
            'SELECT playerId, id, socketIds FROM players WHERE roomId = $1 AND name = $2 AND playerId != $3',
            [roomId, playerName, playerId]
        );
        console.log(`Очистка дубликатов для ${playerName} в комнате ${roomId}, socket=${socketId}, playerId=${playerId}, найдено дубликатов: ${result.rows.length}`);
        for (const row of result.rows) {
            await pool.query('DELETE FROM players WHERE roomId = $1 AND playerId = $2', [roomId, row.playerId]);
            console.log(`Удален дубликат игрока ${playerName} с playerId ${row.playerId} из комнаты ${roomId}`);
        }
    } catch (err) {
        console.error('Ошибка очистки дубликатов игроков:', err.message);
        throw err;
    }
}

// Ограничение присоединения игрока
async function restrictPlayerJoin(roomId, playerName, playerId, socketId) {
    try {
        const result = await pool.query(
            'SELECT playerId, isDisconnected, socketIds FROM players WHERE roomId = $1 AND name = $2 AND playerId != $3',
            [roomId, playerName, playerId]
        );
        const row = result.rows[0];
        if (row && !row.isDisconnected) {
            const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
            if (socketIds.some(id => io.sockets.sockets.get(id))) {
                console.log(`Игрок ${playerName} уже активен в комнате ${roomId} с другим playerId ${row.playerId}, блокировка присоединения`);
                return false;
            }
        }
        return true;
    } catch (err) {
        console.error('Ошибка проверки присоединения игрока:', err.message);
        return false;
    }
}

// Обработка игры с одним игроком
async function handleSinglePlayerGame(roomId) {
    try {
        const roomResult = await pool.query('SELECT trump, gameEnded FROM rooms WHERE roomId = $1', [roomId]);
        const room = roomResult.rows[0];
        if (!room || !room.trump || room.gameEnded) {
            console.log(`Комната ${roomId} неактивна или игра завершена`);
            return;
        }

        const playersResult = await pool.query(
            'SELECT DISTINCT playerId, name FROM players WHERE roomId = $1 AND isDisconnected = FALSE',
            [roomId]
        );
        const players = playersResult.rows;
        if (players.length === 1) {
            const winner = players[0];
            console.log(`Объявление ${winner.name} победителем в комнате ${roomId} из-за единственного активного игрока`);
            await pool.query('UPDATE rooms SET gameEnded = TRUE WHERE roomId = $1', [roomId]);
            io.to(roomId).emit('gameOver', { winners: [winner.name] });
            await deleteRoom(roomId);
        }
    } catch (err) {
        console.error('Ошибка обработки игры с одним игроком:', err.message);
    }
}

// Создание колоды карт
function createDeck() {
    const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
    const ranks = ['6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
    const deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push({ rank, suit });
        }
    }
    console.log(`Создана колода: ${deck.length} карт`);
    return deck;
}

// Перемешивание колоды
function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    console.log('Колода перемешана');
}

// Поиск наименьшей козырной карты для определения первого атакующего
function findLowestTrumpCard(players, trumpSuit) {
    const rankOrder = ['6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
    let lowestTrumpCard = null;
    let firstAttacker = null;

    for (const player of players) {
        const hand = player.hand ? JSON.parse(player.hand) : [];
        const trumpCards = hand.filter(card => card.suit === trumpSuit);
        if (trumpCards.length > 0) {
            const lowestCard = trumpCards.reduce((min, card) => {
                const minRankIndex = rankOrder.indexOf(min.rank);
                const cardRankIndex = rankOrder.indexOf(card.rank);
                return cardRankIndex < minRankIndex ? card : min;
            }, trumpCards[0]);
            if (!lowestTrumpCard || rankOrder.indexOf(lowestCard.rank) < rankOrder.indexOf(lowestTrumpCard.rank)) {
                lowestTrumpCard = lowestCard;
                firstAttacker = player.playerId;
            }
        }
    }

    console.log(`Найдена наименьшая козырная карта: ${lowestTrumpCard ? `${lowestTrumpCard.rank} of ${lowestTrumpCard.suit}` : 'нет'}, атакующий: ${firstAttacker || 'не определен'}`);
    return { lowestTrumpCard, firstAttacker };
}

// Запуск таймера хода
function startTurnTimer(roomId) {
    clearTurnTimer(roomId);
    const timer = setTimeout(async () => {
        try {
            const roomResult = await pool.query('SELECT currentDefender, gameEnded FROM rooms WHERE roomId = $1', [roomId]);
            const room = roomResult.rows[0];
            if (!room) {
                console.error(`Комната ${roomId} не найдена для таймера`);
                return;
            }
            if (room.gameEnded) {
                console.log(`Комната ${roomId} завершена, пропуск действия таймера`);
                return;
            }
            const playersResult = await pool.query(
                'SELECT DISTINCT playerId FROM players WHERE roomId = $1 AND isDisconnected = FALSE',
                [roomId]
            );
            const players = playersResult.rows;
            if (players.length < 2) {
                console.log(`Менее 2 игроков в комнате ${roomId}, обработка одиночной игры`);
                await handleSinglePlayerGame(roomId);
                return;
            }
            const playerIds = players.map(p => p.playerId);
            const currentIndex = playerIds.indexOf(room.currentDefender);
            const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
            const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
            const newAttacker = playerIds[nextAttackerIndex];
            const newDefender = playerIds[nextDefenderIndex] || playerIds[0];

            await pool.query(
                'UPDATE rooms SET gameTable = $1, currentAttacker = $2, currentDefender = $3, lastActivity = $4 WHERE roomId = $5',
                [JSON.stringify([]), newAttacker, newDefender, Date.now(), roomId]
            );
            console.log(`Время хода истекло в комнате ${roomId}, новый атакующий: ${newAttacker}, новый защитник: ${newDefender}`);
            io.to(roomId).emit('errorMessage', 'Время хода истекло');
            await updateGameState(roomId);
            startTurnTimer(roomId);
        } catch (err) {
            console.error('Ошибка обновления хода по таймеру:', err.message);
        }
    }, 30000); // 30 секунд на ход

    io.to(roomId).emit('startTimer', { duration: 30000 });
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room) {
        room.timer = timer;
        console.log(`Таймер установлен для комнаты ${roomId}`);
    } else {
        console.warn(`Комната ${roomId} не найдена в adapter.rooms, таймер не установлен`);
    }
}

// Очистка таймера хода
function clearTurnTimer(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.timer) {
        clearTimeout(room.timer);
        delete room.timer;
        console.log(`Таймер очищен для комнаты ${roomId}`);
    }
}

// Обновление состояния комнаты (для room.html)
async function updateRoomState(roomId) {
    try {
        const playersResult = await pool.query(
            'SELECT name, ready, isDisconnected, language, playerId, id, socketIds FROM players WHERE roomId = $1',
            [roomId]
        );
        const players = playersResult.rows;
        const readyCount = players.filter(p => p.ready).length;
        const totalCount = players.length;
        const activeCount = players.filter(p => !p.isDisconnected).length;

        await pool.query('UPDATE rooms SET activePlayers = $1 WHERE roomId = $2', [activeCount, roomId]);
        console.log(`Обновление комнаты ${roomId}: игроки=${players.map(p => p.name).join(',') || 'нет'}, готовы=${readyCount}/${totalCount}, активны=${activeCount}`);

        io.to(roomId).emit('updateRoom', {
            players: players.map(player => ({
                name: player.name,
                ready: !!player.ready,
                playerId: player.playerId
            })),
            readyCount,
            totalCount,
            playerLanguages: players.map(player => ({ name: player.name, language: player.language }))
        });

        players.forEach(player => {
            const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
            socketIds.forEach(socketId => {
                io.to(socketId).emit('playerStatus', {
                    playerId: player.playerId,
                    ready: !!player.ready,
                    isDisconnected: !!player.isDisconnected
                });
            });
        });
    } catch (err) {
        console.error('Ошибка обновления состояния комнаты:', err.message);
        io.to(roomId).emit('errorMessage', 'Ошибка сервера при получении данных игроков');
    }
}

// Обновление состояния игры (для game.html)
async function updateGameState(roomId) {
    try {
        const roomResult = await pool.query(
            'SELECT trump, deck, gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = $1',
            [roomId]
        );
        const room = roomResult.rows[0];
        if (!room) {
            console.log(`Комната ${roomId} не найдена для состояния игры`);
            io.to(roomId).emit('errorMessage', 'Комната игры не существует');
            return;
        }
        if (room.gameEnded) {
            console.log(`Комната ${roomId} завершена, пропуск обновления состояния игры`);
            return;
        }

        const playersResult = await pool.query(
            'SELECT id, name, hand, playerId, isDisconnected, language, socketIds FROM players WHERE roomId = $1',
            [roomId]
        );
        const players = playersResult.rows;
        const activePlayers = players.filter(p => !p.isDisconnected);

        await pool.query('UPDATE rooms SET activePlayers = $1 WHERE roomId = $2', [activePlayers.length, roomId]);

        if (activePlayers.length < 2 && room.trump) {
            console.log(`Менее 2 активных игроков в комнате ${roomId}, обработка одиночной игры`);
            await handleSinglePlayerGame(roomId);
            return;
        }

        const table = room.gameTable ? JSON.parse(room.gameTable) : [];
        const canTakeCards = table.some(pair => pair.attack && !pair.defense); // Флаг для кнопки "Take Cards"

        const gameState = {
            players: players.map(player => ({
                id: player.playerId,
                name: player.name,
                hand: player.hand ? JSON.parse(player.hand) : [],
                isDisconnected: !!player.isDisconnected,
                language: player.language
            })),
            trump: room.trump ? JSON.parse(room.trump) : null,
            deckCount: room.deck ? JSON.parse(room.deck).length : 0,
            table,
            currentAttacker: room.currentAttacker,
            currentDefender: room.currentDefender,
            canTakeCards // Отправка флага на клиент
        };

        console.log(`Обновление игры ${roomId}: игроки=${players.map(p => p.name).join(',') || 'нет'}, козырь=${JSON.stringify(gameState.trump)}, колода=${gameState.deckCount}, стол=${JSON.stringify(gameState.table)}, атакующий=${room.currentAttacker}, защитник=${room.currentDefender}, canTakeCards=${canTakeCards}`);

        players.forEach(player => {
            const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
            socketIds.forEach(socketId => {
                io.to(socketId).emit('updateGame', gameState);
            });
        });

        await checkGameEnd(roomId);
        await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
    } catch (err) {
        console.error('Ошибка обновления состояния игры:', err.message);
        io.to(roomId).emit('errorMessage', 'Ошибка сервера при получении состояния игры');
    }
}

// Запуск игры
async function startGame(roomId) {
    console.log(`Попытка запустить игру в комнате ${roomId}`);
    try {
        const roomResult = await pool.query('SELECT trump, gameEnded FROM rooms WHERE roomId = $1', [roomId]);
        const room = roomResult.rows[0];
        if (room?.trump) {
            console.log(`Игра уже начата в комнате ${roomId}, обновление состояния`);
            await updateGameState(roomId);
            return;
        }
        if (room?.gameEnded) {
            console.log(`Игра в комнате ${roomId} завершена, запуск невозможен`);
            io.to(roomId).emit('errorMessage', 'Игра завершена');
            return;
        }

        const playersResult = await pool.query(
            'SELECT id, playerId, name, ready, isDisconnected, socketIds, hand FROM players WHERE roomId = $1',
            [roomId]
        );
        const players = playersResult.rows;
        const activePlayers = players.filter(p => !p.isDisconnected);

        if (activePlayers.length < 2) {
            console.log(`Недостаточно активных игроков для старта игры в комнате ${roomId}: ${activePlayers.length}`);
            io.to(roomId).emit('errorMessage', 'Для начала игры требуется минимум 2 игрока');
            return;
        }

        const readyCount = activePlayers.filter(p => p.ready).length;
        if (readyCount !== activePlayers.length) {
            console.log(`Не все активные игроки готовы в комнате ${roomId}: ${readyCount}/${activePlayers.length}`);
            io.to(roomId).emit('errorMessage', 'Все активные игроки должны быть готовы для начала игры');
            return;
        }

        // Создание и перемешивание колоды
        const deck = createDeck();
        shuffleDeck(deck);

        // Определение козыря
        const trumpCard = deck[Math.floor(Math.random() * deck.length)];
        const trump = { card: trumpCard, suit: trumpCard.suit };
        deck.splice(deck.indexOf(trumpCard), 1);
        deck.push(trumpCard);

        // Раздача карт игрокам
        for (const player of activePlayers) {
            const hand = deck.splice(0, 6);
            await pool.query(
                'UPDATE players SET hand = $1 WHERE playerId = $2',
                [JSON.stringify(hand), player.playerId]
            );
            console.log(`Карты розданы игроку ${player.name} в комнате ${roomId}: ${hand.length} карт`);
        }

        // Определение первого атакующего
        const { lowestTrumpCard, firstAttacker } = findLowestTrumpCard(activePlayers, trump.suit);
        let currentAttacker, currentDefender;

        if (firstAttacker) {
            console.log(`Первый атакующий в комнате ${roomId}: playerId=${firstAttacker}, наименьшая козырная карта=${lowestTrumpCard.rank} of ${lowestTrumpCard.suit}`);
            currentAttacker = firstAttacker;
            const activePlayerIds = activePlayers.map(p => p.playerId);
            const attackerIndex = activePlayerIds.indexOf(firstAttacker);
            const defenderIndex = (attackerIndex + 1) % activePlayerIds.length;
            currentDefender = activePlayerIds[defenderIndex];
        } else {
            console.log(`Козырные карты не найдены в комнате ${roomId}, выбор случайного атакующего`);
            const activePlayerIds = activePlayers.map(p => p.playerId);
            currentAttacker = activePlayerIds[0];
            currentDefender = activePlayerIds[1];
        }

        // Обновление состояния комнаты
        await pool.query(
            'UPDATE rooms SET trump = $1, deck = $2, gameTable = $3, currentAttacker = $4, currentDefender = $5, lastActivity = $6, activePlayers = $7, gameEnded = FALSE WHERE roomId = $8',
            [JSON.stringify(trump), JSON.stringify(deck), JSON.stringify([]), currentAttacker, currentDefender, Date.now(), activePlayers.length, roomId]
        );

        console.log(`Игра начата в комнате ${roomId}, козырь: ${JSON.stringify(trump)}, атакующий: ${currentAttacker}, защитник: ${currentDefender}, колода: ${deck.length} карт`);

        io.to(roomId).emit('startGame', { trump, currentAttacker, currentDefender });
        await updateGameState(roomId);
        startTurnTimer(roomId);
    } catch (err) {
        console.error('Ошибка запуска игры:', err.message);
        io.to(roomId).emit('errorMessage', 'Ошибка сервера при запуске игры');
    }
}

// Валидация карты для атаки
function isValidAttackCard(card, table, trump) {
    if (!table.length) return true;
    const valid = table.some(pair => pair.attack.rank === card.rank);
    console.log(`Валидация карты атаки ${card.rank} of ${card.suit}: ${valid}`);
    return valid;
}

// Валидация карты для защиты
function isValidDefenseCard(defenseCard, attackCard, trump) {
    const rankOrder = ['6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
    if (defenseCard.suit === attackCard.suit) {
        const result = rankOrder.indexOf(defenseCard.rank) > rankOrder.indexOf(attackCard.rank);
        console.log(`Валидация карты защиты ${defenseCard.rank} of ${defenseCard.suit} против ${attackCard.rank} of ${attackCard.suit}: ${result}`);
        return result;
    }
    const result = defenseCard.suit === trump;
    console.log(`Валидация карты защиты ${defenseCard.rank} of ${defenseCard.suit} как козырь против ${attackCard.rank} of ${attackCard.suit}: ${result}`);
    return result;
}

// Раздача карт игрокам
async function drawCards(roomId, playerIds) {
    try {
        const roomResult = await pool.query('SELECT deck, gameEnded FROM rooms WHERE roomId = $1', [roomId]);
        const room = roomResult.rows[0];
        if (!room) {
            console.log(`Комната ${roomId} не существует для раздачи карт`);
            return;
        }
        if (room.gameEnded) {
            console.log(`Комната ${roomId} завершена, пропуск раздачи карт`);
            return;
        }

        let deck = room.deck ? JSON.parse(room.deck) : [];
        for (const playerId of playerIds) {
            const playerResult = await pool.query(
                'SELECT hand, isDisconnected FROM players WHERE playerId = $1',
                [playerId]
            );
            const player = playerResult.rows[0];
            if (player.isDisconnected) {
                console.log(`Игрок ${playerId} отключен, пропуск раздачи карт`);
                continue;
            }
            let hand = player.hand ? JSON.parse(player.hand) : [];
            while (hand.length < 6 && deck.length > 0) {
                hand.push(deck.shift());
            }
            await pool.query('UPDATE players SET hand = $1 WHERE playerId = $2', [JSON.stringify(hand), playerId]);
            console.log(`Игроку ${playerId} роздано карт: ${hand.length}`);
        }

        await pool.query('UPDATE rooms SET deck = $1, lastActivity = $2 WHERE roomId = $3', [JSON.stringify(deck), Date.now(), roomId]);
        console.log(`Колода обновлена в комнате ${roomId}: ${deck.length} карт`);
    } catch (err) {
        console.error('Ошибка раздачи карт:', err.message);
    }
}

// Проверка окончания игры
async function checkGameEnd(roomId) {
    try {
        const roomResult = await pool.query('SELECT deck, gameEnded FROM rooms WHERE roomId = $1', [roomId]);
        const room = roomResult.rows[0];
        if (!room) {
            console.log(`Комната ${roomId} не найдена для проверки окончания игры`);
            return;
        }
        if (room.gameEnded) {
            console.log(`Комната ${roomId} уже завершена, пропуск проверки окончания игры`);
            return;
        }

        const deck = room.deck ? JSON.parse(room.deck) : [];
        const playersResult = await pool.query(
            'SELECT playerId, name, hand, isDisconnected FROM players WHERE roomId = $1',
            [roomId]
        );
        const players = playersResult.rows;
        const activePlayers = players.filter(p => !p.isDisconnected);

        if (activePlayers.length < 2) {
            console.log(`Менее 2 активных игроков в комнате ${roomId}, обработка одиночной игры`);
            await handleSinglePlayerGame(roomId);
            return;
        }

        const winners = activePlayers.filter(p => (JSON.parse(p.hand || '[]')).length === 0);
        if (deck.length === 0 && winners.length > 0) {
            const winnerNames = winners.map(p => p.name).join(', ');
            console.log(`Игра завершена в комнате ${roomId}: Победители: ${winnerNames}`);
            await pool.query('UPDATE rooms SET gameEnded = TRUE WHERE roomId = $1', [roomId]);
            io.to(roomId).emit('gameOver', { winners: winners.map(p => p.name) });
            await deleteRoom(roomId);
        }
    } catch (err) {
        console.error('Ошибка проверки окончания игры:', err.message);
    }
}

// Удаление комнаты
async function deleteRoom(roomId) {
    clearTurnTimer(roomId);
    try {
        await pool.query('UPDATE rooms SET gameEnded = TRUE WHERE roomId = $1', [roomId]);
        await pool.query('DELETE FROM players WHERE roomId = $1', [roomId]);
        await pool.query('DELETE FROM rooms WHERE roomId = $1', [roomId]);
        console.log(`Комната ${roomId} удалена после окончания игры`);
        io.to(roomId).emit('roomDeleted', 'Игра завершена, комната удалена');
    } catch (err) {
        console.error('Ошибка удаления комнаты:', err.message);
    }
}

// Обработчики Socket.io
io.on('connection', (socket) => {
    console.log(`Новое подключение: socketId=${socket.id}`);

    socket.on('createRoom', async (data) => {
        let playerName, playerId, language;
        if (typeof data === 'string') {
            playerName = data;
            playerId = uuidv4();
            language = 'en';
            console.log(`Получен старый формат createRoom: playerName=${playerName}`);
        } else if (typeof data === 'object' && data.playerName && data.playerName.trim()) {
            playerName = data.playerName;
            playerId = data.playerId || uuidv4();
            language = sanitizeLanguage(data.language || 'en');
        } else {
            console.error('Неверные данные createRoom:', data);
            socket.emit('errorMessage', 'Неверные данные');
            return;
        }

        playerName = sanitizeInput(playerName ? playerName.trim() : '');
        playerId = sanitizeInput(playerId);
        console.log(`Запрос на создание комнаты: player=${playerName}, playerId=${playerId}, language=${language}, socket=${socket.id}`);

        if (!playerName || playerName === 'undefined') {
            socket.emit('errorMessage', 'Введите корректное имя');
            socket.emit('setPlayerId', playerId);
            return;
        }

        try {
            const playerResult = await pool.query('SELECT playerId FROM players WHERE playerId = $1', [playerId]);
            if (playerResult.rows.length > 0) {
                playerId = uuidv4();
                socket.emit('setPlayerId', playerId);
                console.log(`Обнаружен дубликат playerId, назначен новый: ${playerId}`);
            }

            const roomId = await generateRoomCode();
            await pool.query(
                'INSERT INTO rooms (roomId, createdAt, lastActivity, gameEnded) VALUES ($1, $2, $3, $4)',
                [roomId, Date.now(), Date.now(), false]
            );

            await pool.query('DELETE FROM players WHERE id = $1', [socket.id]);
            await cleanDuplicatePlayers(roomId, playerName, socket.id, playerId);

            await pool.query(
                'INSERT INTO players (id, roomId, playerId, name, ready, joinedAt, isDisconnected, language, socketIds) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                [socket.id, roomId, playerId, playerName, false, Date.now(), false, language, JSON.stringify([socket.id])]
            );

            console.log(`Комната ${roomId} создана, игрок ${playerName} добавлен с playerId ${playerId}, language=${language}, socket=${socket.id}`);
            socket.join(roomId);
            socket.emit('roomCreated', { roomId, playerId, language, playerName });
            socket.emit('roomJoined', { roomId, playerId, language, playerName });
            socket.emit('playerStatus', { playerId, ready: false, isDisconnected: false });
            await updateRoomState(roomId);
        } catch (err) {
            console.error('Ошибка создания комнаты:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('joinRoom', async (data) => {
        let roomId, playerName, playerId, language;
        if (typeof data === 'object' && data.roomId && data.playerName && data.playerName.trim()) {
            roomId = data.roomId;
            playerName = data.playerName;
            playerId = data.playerId || uuidv4();
            language = sanitizeLanguage(data.language || 'en');
        } else {
            console.error('Неверные данные joinRoom:', data);
            socket.emit('errorMessage', 'Неверные данные');
            return;
        }

        roomId = sanitizeInput(roomId ? roomId.trim().toLowerCase() : '');
        playerName = sanitizeInput(playerName ? playerName.trim() : '');
        playerId = sanitizeInput(playerId);
        console.log(`Запрос на присоединение к комнате: roomId=${roomId}, player=${playerName}, playerId=${playerId}, language=${language}, socket=${socket.id}`);

        if (!roomId || !playerName || playerName === 'undefined') {
            socket.emit('errorMessage', 'Неверный ID комнаты или имя');
            socket.emit('setPlayerId', playerId);
            return;
        }

        try {
            const roomResult = await pool.query('SELECT roomId FROM rooms WHERE roomId = $1', [roomId]);
            if (!roomResult.rows[0]) {
                socket.emit('errorMessage', 'Комната не существует');
                socket.emit('setPlayerId', playerId);
                return;
            }

            const playerResult = await pool.query(
                'SELECT name, playerId, id, isDisconnected, hand, lastDisconnectedAt, language, ready, socketIds FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const player = playerResult.rows[0];

            if (player) {
                if (player.name !== playerName) {
                    socket.emit('errorMessage', 'Несоответствие имени игрока для данного ID');
                    return;
                }
                if (!player.isDisconnected) {
                    await addSocketId(playerId, socket.id);
                    console.log(`Игрок ${playerName} добавил сокет ${socket.id} к существующему playerId ${playerId} в комнате ${roomId}`);
                    socket.join(roomId);
                    socket.emit('roomJoined', { roomId, playerId, language: player.language, playerName });
                    socket.emit('playerStatus', { playerId, ready: !!player.ready, isDisconnected: false });
                    await updateRoomState(roomId);
                    const gameResult = await pool.query('SELECT trump FROM rooms WHERE roomId = $1', [roomId]);
                    if (gameResult.rows[0]?.trump) {
                        await updateGameState(roomId);
                    }
                    return;
                } else {
                    await pool.query(
                        'UPDATE players SET id = $1, isDisconnected = FALSE, lastDisconnectedAt = NULL, language = $2, socketIds = $3 WHERE roomId = $4 AND playerId = $5',
                        [socket.id, language, JSON.stringify([socket.id]), roomId, playerId]
                    );
                    console.log(`Игрок ${playerName} переподключился к комнате ${roomId}, playerId: ${playerId}, socket: ${socket.id}`);
                    socket.join(roomId);
                    socket.emit('roomJoined', { roomId, playerId, language: player.language, playerName });
                    socket.emit('playerStatus', { playerId, ready: !!player.ready, isDisconnected: false });
                    io.to(roomId).emit('playerReconnected', { playerName });
                    await updateRoomState(roomId);
                    const gameResult = await pool.query('SELECT trump FROM rooms WHERE roomId = $1', [roomId]);
                    if (gameResult.rows[0]?.trump) {
                        await updateGameState(roomId);
                    }
                    return;
                }
            }

            const canJoin = await restrictPlayerJoin(roomId, playerName, playerId, socket.id);
            if (!canJoin) {
                socket.emit('errorMessage', 'Игрок с таким именем уже активен с другим ID');
                return;
            }

            await cleanDuplicatePlayers(roomId, playerName, socket.id, playerId);
            await pool.query('DELETE FROM players WHERE id = $1', [socket.id]);

            const countResult = await pool.query('SELECT COUNT(*) as count FROM players WHERE roomId = $1', [roomId]);
            if (parseInt(countResult.rows[0].count) >= 6) { // Лимит игроков
                socket.emit('errorMessage', 'Комната заполнена');
                socket.emit('setPlayerId', playerId);
                return;
            }

            socket.join(roomId);
            await pool.query(
                'INSERT INTO players (id, roomId, playerId, name, ready, joinedAt, isDisconnected, language, socketIds) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                [socket.id, roomId, playerId, playerName, false, Date.now(), false, language, JSON.stringify([socket.id])]
            );

            console.log(`Игрок ${playerName} присоединился к комнате ${roomId} с playerId ${playerId}, language=${language}, socket=${socket.id}`);
            socket.emit('roomJoined', { roomId, playerId, language, playerName });
            socket.emit('playerStatus', { playerId, ready: false, isDisconnected: false });
            await updateRoomState(roomId);
            await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
        } catch (err) {
            console.error('Ошибка присоединения к комнате:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('takeCards', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerName} запросил взять карты в комнате ${roomId}, playerId: ${playerId}`);

        try {
            const roomResult = await pool.query(
                'SELECT gameTable, currentDefender, deck, gameEnded FROM rooms WHERE roomId = $1',
                [roomId]
            );
            const room = roomResult.rows[0];
            if (!room) {
                console.log(`Комната ${roomId} не существует или была удалена`);
                socket.emit('errorMessage', 'Комната игры не существует');
                return;
            }
            if (room.gameEnded) {
                console.log(`Комната ${roomId} завершена, отклонение действия takeCards`);
                socket.emit('errorMessage', 'Игра завершена');
                return;
            }
            if (playerId !== room.currentDefender) {
                socket.emit('errorMessage', 'Только защитник может взять карты');
                return;
            }

            let table = room.gameTable ? JSON.parse(room.gameTable) : [];
            let deck = room.deck ? JSON.parse(room.deck) : [];

            if (!table.some(pair => pair.attack && !pair.defense)) {
                socket.emit('errorMessage', 'Нет непобитых карт для взятия');
                return;
            }

            const playerResult = await pool.query(
                'SELECT hand, isDisconnected FROM players WHERE playerId = $1',
                [playerId]
            );
            const player = playerResult.rows[0];
            if (!player) {
                console.error(`Игрок ${playerId} не найден`);
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            if (player.isDisconnected) {
                socket.emit('errorMessage', 'Нельзя взять карты, будучи отключенным');
                return;
            }

            let defenderHand = player.hand ? JSON.parse(player.hand) : [];
            table.forEach(pair => {
                if (pair.attack) defenderHand.push(pair.attack);
                if (pair.defense) defenderHand.push(pair.defense);
            });

            await pool.query('UPDATE players SET hand = $1 WHERE playerId = $2', [JSON.stringify(defenderHand), playerId]);
            console.log(`Игрок ${playerName} взял ${table.length} пар карт в комнате ${roomId}`);

            table = [];
            await pool.query('UPDATE rooms SET gameTable = $1, lastActivity = $2 WHERE roomId = $3', [JSON.stringify(table), Date.now(), roomId]);

            const playersResult = await pool.query('SELECT playerId, isDisconnected FROM players WHERE roomId = $1', [roomId]);
            const players = playersResult.rows;
            const activePlayers = players.filter(p => !p.isDisconnected);

            if (activePlayers.length < 2) {
                console.log(`Менее 2 активных игроков в комнате ${roomId}, обработка одиночной игры`);
                await handleSinglePlayerGame(roomId);
                return;
            }

            const playerIds = activePlayers.map(p => p.playerId);
            const currentDefenderIndex = playerIds.indexOf(room.currentDefender);
            const nextAttackerIndex = (currentDefenderIndex + 1) % playerIds.length;
            const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
            const newAttacker = playerIds[nextAttackerIndex];
            const newDefender = playerIds[nextDefenderIndex] || playerIds[0];

            await drawCards(roomId, [newAttacker, newDefender]);
            await pool.query(
                'UPDATE rooms SET currentAttacker = $1, currentDefender = $2, lastActivity = $3 WHERE roomId = $4',
                [newAttacker, newDefender, Date.now(), roomId]
            );
            console.log(`Ход обновлен в комнате ${roomId}: новый атакующий=${newAttacker}, новый защитник=${newDefender}`);

            await updateGameState(roomId);
            await checkGameEnd(roomId);
            startTurnTimer(roomId);
        } catch (err) {
            console.error('Ошибка взятия карт:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('changeLanguage', async ({ playerId, language }) => {
        language = sanitizeLanguage(language);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerId} меняет язык на ${language}`);
        try {
            await pool.query('UPDATE players SET language = $1 WHERE playerId = $2', [language, playerId]);
            const result = await pool.query('SELECT roomId, socketIds FROM players WHERE playerId = $1', [playerId]);
            const player = result.rows[0];
            if (!player) {
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            console.log(`Язык обновлен для игрока ${playerId} на ${language} в комнате ${player.roomId}`);
            const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
            socketIds.forEach(socketId => {
                io.to(socketId).emit('languageChanged', { language });
            });
            await updateRoomState(player.roomId);
            await updateGameState(player.roomId);
        } catch (err) {
            console.error('Ошибка обновления языка:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера при обновлении языка');
        }
    });

    socket.on('ready', async ({ roomId, playerId }) => {
        roomId = sanitizeInput(roomId);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок готов в комнате ${roomId}, socket: ${socket.id}, playerId: ${playerId}`);
        try {
            const playerResult = await pool.query(
                'SELECT ready, isDisconnected, socketIds FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const player = playerResult.rows[0];
            if (!player) {
                console.warn(`Игрок ${playerId} не найден в комнате ${roomId}`);
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            if (player.ready) {
                console.log(`Игрок ${playerId} уже готов в комнате ${roomId}, отправка статуса`);
                const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
                socketIds.forEach(socketId => {
                    io.to(socketId).emit('playerStatus', { playerId, ready: true, isDisconnected: false });
                });
                return;
            }

            await pool.query(
                'UPDATE players SET isDisconnected = FALSE, lastDisconnectedAt = NULL, ready = TRUE WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
            socketIds.forEach(socketId => {
                io.to(socketId).emit('playerStatus', { playerId, ready: true, isDisconnected: false });
            });

            const countResult = await pool.query(
                'SELECT COUNT(*) as total, SUM(ready::INTEGER) as ready FROM players WHERE roomId = $1 AND isDisconnected = FALSE',
                [roomId]
            );
            const { total, ready } = countResult.rows[0];
            console.log(`Статус комнаты ${roomId}: ${ready}/${total} готовы`);

            await updateRoomState(roomId);
            await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);

            if (parseInt(ready) >= 2 && parseInt(ready) === parseInt(total)) {
                console.log(`Все игроки готовы в комнате ${roomId}, запуск игры`);
                await startGame(roomId);
            }
        } catch (err) {
            console.error('Ошибка установки статуса готовности:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('requestPlayerUpdate', async (roomId) => {
        roomId = sanitizeInput(roomId);
        console.log(`Запрос обновления игроков для комнаты ${roomId}`);
        await updateRoomState(roomId);
        await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
    });

    socket.on('leaveRoom', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerName} запросил выход из комнаты ${roomId}, playerId: ${playerId}`);
        try {
            await removeSocketId(playerId, socket.id);
            const result = await pool.query('SELECT socketIds FROM players WHERE roomId = $1 AND playerId = $2', [roomId, playerId]);
            const socketIds = result.rows[0]?.socketIds ? JSON.parse(result.rows[0].socketIds) : [];
            if (socketIds.length === 0) {
                await pool.query('DELETE FROM players WHERE roomId = $1 AND playerId = $2', [roomId, playerId]);
                console.log(`Игрок ${playerName} удален из комнаты ${roomId}`);
                socket.leave(roomId);
                await updateRoomState(roomId);
                await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
            } else {
                socket.leave(roomId);
                await updateRoomState(roomId);
            }
        } catch (err) {
            console.error('Ошибка выхода из комнаты:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера при выходе из комнаты');
        }
    });

    socket.on('leaveGame', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerName} запросил выход из игры ${roomId}, playerId: ${playerId}`);
        try {
            await pool.query(
                'UPDATE players SET isDisconnected = TRUE, lastDisconnectedAt = $1 WHERE roomId = $2 AND playerId = $3',
                [Date.now(), roomId, playerId]
            );
            console.log(`Игрок ${playerName} помечен как отключенный в игре ${roomId}`);
            await removeSocketId(playerId, socket.id);
            socket.leave(roomId);
            await updateGameState(roomId);
            await handleSinglePlayerGame(roomId);
            await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
        } catch (err) {
            console.error('Ошибка выхода из игры:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера при выходе из игры');
        }
    });

    socket.on('playCard', async ({ roomId, playerName, playerId, card, role }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerName} (${role}) сыграл карту ${card.rank} of ${card.suit} в комнате ${roomId}, socket=${socket.id}`);
        try {
            const roomResult = await pool.query(
                'SELECT trump, gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = $1',
                [roomId]
            );
            const room = roomResult.rows[0];
            if (!room) {
                socket.emit('errorMessage', 'Комната игры не существует');
                return;
            }
            if (room.gameEnded) {
                console.log(`Комната ${roomId} завершена, отклонение действия playCard`);
                socket.emit('errorMessage', 'Игра завершена');
                return;
            }

            const trump = room.trump ? JSON.parse(room.trump).suit : null;
            let table = room.gameTable ? JSON.parse(room.gameTable) : [];

            const playerResult = await pool.query(
                'SELECT id, isDisconnected, hand, socketIds FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const player = playerResult.rows[0];
            if (!player) {
                console.error(`Игрок ${playerId} не найден`);
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            if (player.isDisconnected) {
                socket.emit('errorMessage', 'Нельзя играть карты, будучи отключенным');
                return;
            }

            const isAttacker = playerId === room.currentAttacker;
            const isDefender = playerId === room.currentDefender;

            if (role === 'attack' && !isAttacker) {
                socket.emit('errorMessage', 'Не ваш ход для атаки');
                return;
            }
            if (role === 'defend' && !isDefender) {
                socket.emit('errorMessage', 'Не ваш ход для защиты');
                return;
            }

            let hand = player.hand ? JSON.parse(player.hand) : [];
            const cardIndex = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
            if (cardIndex === -1) {
                socket.emit('errorMessage', 'Неверная карта');
                return;
            }

            if (role === 'attack') {
                if (!isValidAttackCard(card, table, trump) || table.length >= 12) {
                    socket.emit('errorMessage', 'Неверная карта для атаки');
                    return;
                }
                table.push({ attack: card, defense: null });
            } else if (role === 'defend') {
                const lastAttack = table.find(pair => !pair.defense);
                if (!lastAttack) {
                    socket.emit('errorMessage', 'Нет карты атаки для защиты');
                    return;
                }
                if (!isValidDefenseCard(card, lastAttack.attack, trump)) {
                    socket.emit('errorMessage', 'Неверная карта для защиты');
                    return;
                }
                lastAttack.defense = card;
            }

            hand.splice(cardIndex, 1);
            await pool.query('UPDATE players SET hand = $1 WHERE playerId = $2', [JSON.stringify(hand), playerId]);
            await pool.query('UPDATE rooms SET gameTable = $1, lastActivity = $2 WHERE roomId = $3', [JSON.stringify(table), Date.now(), roomId]);

            console.log(`Карта сыграна в комнате ${roomId}: игрок=${playerName}, роль=${role}, карта=${card.rank} of ${card.suit}`);
            await updateGameState(roomId);
            await checkGameEnd(roomId);
            startTurnTimer(roomId);
        } catch (err) {
            console.error('Ошибка игры карты:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('endTurn', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerName} завершил ход в комнате ${roomId}`);
        try {
            const roomResult = await pool.query(
                'SELECT gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = $1',
                [roomId]
            );
            const room = roomResult.rows[0];
            if (!room) {
                socket.emit('errorMessage', 'Комната игры не существует');
                return;
            }
            if (room.gameEnded) {
                console.log(`Комната ${roomId} завершена, отклонение действия endTurn`);
                socket.emit('errorMessage', 'Игра завершена');
                return;
            }

            let table = room.gameTable ? JSON.parse(room.gameTable) : [];
            const playerResult = await pool.query(
                'SELECT id, isDisconnected, socketIds FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const player = playerResult.rows[0];
            if (!player) {
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            if (player.isDisconnected) {
                socket.emit('errorMessage', 'Нельзя завершить ход, будучи отключенным');
                return;
            }

            const isDefender = playerId === room.currentDefender;
            if (!isDefender) {
                socket.emit('errorMessage', 'Только защитник может завершить ход');
                return;
            }

            const hasUndefended = table.some(pair => !pair.defense);
            if (hasUndefended) {
                const playersResult = await pool.query(
                    'SELECT playerId, name, hand, isDisconnected, socketIds FROM players WHERE roomId = $1',
                    [roomId]
                );
                const players = playersResult.rows;
                const defender = players.find(p => p.playerId === room.currentDefender);
                if (!defender) {
                    socket.emit('errorMessage', 'Защитник не найден');
                    return;
                }

                let defenderHand = defender.hand ? JSON.parse(defender.hand) : [];
                table.forEach(pair => {
                    if (pair.attack) defenderHand.push(pair.attack);
                    if (pair.defense) defenderHand.push(pair.defense);
                });

                await pool.query('UPDATE players SET hand = $1 WHERE playerId = $2', [JSON.stringify(defenderHand), defender.playerId]);
                console.log(`Защитник ${defender.name} взял карты в комнате ${roomId}`);

                table = [];
                await pool.query('UPDATE rooms SET gameTable = $1, lastActivity = $2 WHERE roomId = $3', [JSON.stringify(table), Date.now(), roomId]);

                const activePlayers = players.filter(p => !p.isDisconnected);
                if (activePlayers.length < 2) {
                    console.log(`Менее 2 активных игроков в комнате ${roomId}, обработка одиночной игры`);
                    await handleSinglePlayerGame(roomId);
                    return;
                }

                const playerIds = activePlayers.map(p => p.playerId);
                const currentIndex = playerIds.indexOf(room.currentAttacker);
                const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
                const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                const newAttacker = playerIds[nextAttackerIndex];
                const newDefender = playerIds[nextDefenderIndex] || playerIds[0];

                await drawCards(roomId, [newAttacker, newDefender]);
                await pool.query(
                    'UPDATE rooms SET currentAttacker = $1, currentDefender = $2, lastActivity = $3 WHERE roomId = $4',
                    [newAttacker, newDefender, Date.now(), roomId]
                );

                await updateGameState(roomId);
                await checkGameEnd(roomId);
                startTurnTimer(roomId);
            } else {
                console.log(`Защитник ${playerName} успешно отбился в комнате ${roomId}`);
                table = [];
                await pool.query('UPDATE rooms SET gameTable = $1, lastActivity = $2 WHERE roomId = $3', [JSON.stringify(table), Date.now(), roomId]);

                const playersResult = await pool.query(
                    'SELECT playerId, name, isDisconnected FROM players WHERE roomId = $1',
                    [roomId]
                );
                const players = playersResult.rows;
                const activePlayers = players.filter(p => !p.isDisconnected);

                if (activePlayers.length < 2) {
                    console.log(`Менее 2 активных игроков в комнате ${roomId}, обработка одиночной игры`);
                    await handleSinglePlayerGame(roomId);
                    return;
                }

                const playerIds = activePlayers.map(p => p.playerId);
                const currentIndex = playerIds.indexOf(room.currentAttacker);
                const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
                const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                const newAttacker = playerIds[nextAttackerIndex];
                const newDefender = playerIds[nextDefenderIndex] || playerIds[0];

                await drawCards(roomId, [newAttacker, newDefender]);
                await pool.query(
                    'UPDATE rooms SET currentAttacker = $1, currentDefender = $2, lastActivity = $3 WHERE roomId = $4',
                    [newAttacker, newDefender, Date.now(), roomId]
                );

                await updateGameState(roomId);
                await checkGameEnd(roomId);
                startTurnTimer(roomId);
            }
        } catch (err) {
            console.error('Ошибка завершения хода:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('chatMessage', ({ roomId, playerName, message }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        message = sanitizeInput(message ? message.trim().slice(0, 200) : '');
        console.log(`Сообщение чата в комнате ${roomId} от ${playerName}: ${message}`);
        io.to(roomId).emit('chatMessage', { playerName, message });
    });

    socket.on('tempDisconnect', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Временное отключение: игрок=${playerName}, playerId=${playerId}, комната=${roomId}, socket=${socket.id}`);
        try {
            await pool.query(
                'UPDATE players SET isDisconnected = TRUE, lastDisconnectedAt = $1 WHERE roomId = $2 AND playerId = $3',
                [Date.now(), roomId, playerId]
            );
            console.log(`Игрок ${playerName} помечен как временно отключенный в комнате ${roomId}`);
            await removeSocketId(playerId, socket.id);
            await updateGameState(roomId);
            await handleSinglePlayerGame(roomId);
        } catch (err) {
            console.error('Ошибка временного отключения:', err.message);
        }
    });

    socket.on('reconnectPlayer', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Запрос переподключения: игрок=${playerName}, playerId=${playerId}, комната=${roomId}, socket=${socket.id}`);
        try {
            const result = await pool.query(
                'SELECT isDisconnected, language, ready, socketIds, name FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const player = result.rows[0];
            if (!player) {
                console.warn(`Игрок ${playerName} не найден в комнате ${roomId} для переподключения`);
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            if (player.name !== playerName) {
                socket.emit('errorMessage', 'Несоответствие имени игрока');
                return;
            }

            await pool.query(
                'UPDATE players SET isDisconnected = FALSE, lastDisconnectedAt = NULL WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            await addSocketId(playerId, socket.id);

            console.log(`Игрок ${playerName} переподключился к комнате ${roomId}, playerId: ${playerId}, socket: ${socket.id}`);
            socket.join(roomId);
            socket.emit('roomJoined', { roomId, playerId, language: player.language, playerName });
            socket.emit('playerStatus', { playerId, ready: !!player.ready, isDisconnected: false });
            io.to(roomId).emit('playerReconnected', { playerName });
            await updateRoomState(roomId);

            const gameResult = await pool.query('SELECT trump FROM rooms WHERE roomId = $1', [roomId]);
            if (gameResult.rows[0]?.trump) {
                await updateGameState(roomId);
                await handleSinglePlayerGame(roomId);
            }
        } catch (err) {
            console.error('Ошибка переподключения игрока:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('disconnect', async () => {
        console.log(`Пользователь отключился: socketId=${socket.id}`);
        try {
            const result = await pool.query(
                'SELECT roomId, playerId, name FROM players WHERE id = $1',
                [socket.id]
            );
            const player = result.rows[0];
            if (!player) {
                console.log(`Игрок с socketId ${socket.id} не найден в базе данных`);
                return;
            }

            const { roomId, playerId, name } = player;
            console.log(`Игрок ${name} отключился от комнаты ${roomId}, playerId: ${playerId}, socket=${socket.id}`);

            await removeSocketId(playerId, socket.id);
            const socketResult = await pool.query(
                'SELECT socketIds FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const socketIds = socketResult.rows[0]?.socketIds ? JSON.parse(socketResult.rows[0].socketIds) : [];

            if (socketIds.length === 0) {
                await pool.query(
                    'UPDATE players SET isDisconnected = TRUE, lastDisconnectedAt = $1 WHERE roomId = $2 AND playerId = $3',
                    [Date.now(), roomId, playerId]
                );
                console.log(`Игрок ${name} помечен как отключенный в комнате ${roomId}`);

                const gameResult = await pool.query('SELECT trump FROM rooms WHERE roomId = $1', [roomId]);
                if (gameResult.rows[0]?.trump) {
                    await updateGameState(roomId);
                    await handleSinglePlayerGame(roomId);
                } else {
                    await updateRoomState(roomId);
                }
                await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
            } else {
                await updateRoomState(roomId);
            }
        } catch (err) {
            console.error('Ошибка обработки отключения:', err.message);
        }
    });
});

// Периодическая очистка старых комнат
async function cleanOldRooms() {
    const oneHourAgo = Date.now() - 3600000; // 1 час назад
    try {
        const roomsResult = await pool.query('SELECT roomId FROM rooms WHERE lastActivity < $1', [oneHourAgo]);
        for (const room of roomsResult.rows) {
            const playersResult = await pool.query('SELECT COUNT(*) as count FROM players WHERE roomId = $1', [room.roomId]);
            const count = parseInt(playersResult.rows[0].count);
            console.log(`Очистка комнаты ${room.roomId} с ${count} игроками`);
            if (count === 0) {
                clearTurnTimer(room.roomId);
                await pool.query('DELETE FROM players WHERE roomId = $1', [room.roomId]);
                await pool.query('DELETE FROM rooms WHERE roomId = $1', [room.roomId]);
                console.log(`Комната ${room.roomId} удалена`);
            }
        }
    } catch (err) {
        console.error('Ошибка очистки старых комнат:', err.message);
    }
}
setInterval(cleanOldRooms, 60000); // Каждую минуту

// Обработка завершения работы сервера
process.on('SIGTERM', async () => {
    console.log('Получен SIGTERM, завершение работы');
    try {
        io.emit('serverShutdown', 'Сервер завершает работу');
        await pool.end();
        console.log('Соединение с базой данных закрыто');
        server.close(() => {
            console.log('Сервер остановлен');
            process.exit(0);
        });
    } catch (err) {
        console.error('Ошибка при завершении работы:', err.message);
        process.exit(1);
    }
});

// Запуск сервера
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
