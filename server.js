const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '50mb' }));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LEGACY_CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const LEGACY_USERS_FILE = path.join(DATA_DIR, 'users.json');
const LEGACY_SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const DATABASE_URL = process.env.DATABASE_URL;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultPermissions = () => ({ canCreate: true, canEdit: true, canDelete: true });

function getDefaultUsers() {
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const adminLogin = process.env.ADMIN_LOGIN || 'admin';
    return {
        users: [{
            id: 1,
            login: adminLogin,
            password: adminPass,
            role: 'admin',
            createdAt: new Date().toISOString(),
            cardLimit: null,
            permissions: defaultPermissions()
        }],
        nextId: 2
    };
}

function getLegacyOrDefault(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return fallback;
    }
}

const storage = (() => {
    if (DATABASE_URL) {
        const pool = new Pool({
            connectionString: DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        return {
            label: 'postgres',
            async init() {
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS app_state (
                        key TEXT PRIMARY KEY,
                        value JSONB NOT NULL
                    )
                `);
            },
            async hasKey(key) {
                const result = await pool.query('SELECT 1 FROM app_state WHERE key = $1 LIMIT 1', [key]);
                return result.rowCount > 0;
            },
            async getState(key, fallback) {
                const result = await pool.query('SELECT value FROM app_state WHERE key = $1 LIMIT 1', [key]);
                if (result.rowCount === 0) return fallback;
                return result.rows[0].value ?? fallback;
            },
            async setState(key, value) {
                await pool.query(
                    `INSERT INTO app_state (key, value) VALUES ($1, $2::jsonb)
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                    [key, JSON.stringify(value)]
                );
            }
        };
    }

    const fallbackStateFile = path.join(DATA_DIR, 'state.json');
    let stateCache = null;
    function loadCache() {
        if (stateCache) return stateCache;
        if (!fs.existsSync(fallbackStateFile)) {
            stateCache = {};
            return stateCache;
        }
        stateCache = getLegacyOrDefault(fallbackStateFile, {});
        return stateCache;
    }

    function saveCache(cache) {
        stateCache = cache;
        fs.writeFileSync(fallbackStateFile, JSON.stringify(cache));
    }

    return {
        label: 'file',
        async init() {},
        async hasKey(key) {
            const cache = loadCache();
            return Object.prototype.hasOwnProperty.call(cache, key);
        },
        async getState(key, fallback) {
            const cache = loadCache();
            if (!Object.prototype.hasOwnProperty.call(cache, key)) return fallback;
            return cache[key] ?? fallback;
        },
        async setState(key, value) {
            const cache = loadCache();
            cache[key] = value;
            saveCache(cache);
        }
    };
})();

async function getCards() { return storage.getState('cards', { cards: [], nextId: 1 }); }
async function saveCards(data) { return storage.setState('cards', data); }
async function getUsers() { return storage.getState('users', { users: [], nextId: 1 }); }
async function saveUsers(data) { return storage.setState('users', data); }
async function getSessions() { return storage.getState('sessions', {}); }
async function saveSessions(data) { return storage.setState('sessions', data); }

function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const requireAuth = asyncHandler(async (req, res, next) => {
    const token = req.headers['x-session'] || req.body?.session;
    if (!token) return res.status(401).json({ error: 'Nie zalogowany' });
    const sessions = await getSessions();
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Nie zalogowany' });
    if (Date.now() - session.createdAt > 30 * 86400000) {
        delete sessions[token];
        await saveSessions(sessions);
        return res.status(401).json({ error: 'Sesja wygasła' });
    }
    req.session = session;
    req.sessionToken = token;
    next();
});

const requireAdmin = asyncHandler(async (req, res, next) => {
    await requireAuth(req, res, async () => {
        if (req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
        next();
    });
});

async function createSession(userId, role) {
    const token = crypto.randomBytes(32).toString('hex');
    const sessions = await getSessions();
    sessions[token] = { userId, role, createdAt: Date.now() };
    await saveSessions(sessions);
    return token;
}

async function getSession(token) {
    if (!token) return null;
    const sessions = await getSessions();
    const session = sessions[token];
    if (!session) return null;
    if (Date.now() - session.createdAt > 30 * 86400000) {
        delete sessions[token];
        await saveSessions(sessions);
        return null;
    }
    return session;
}

async function deleteSession(token) {
    if (!token) return;
    const sessions = await getSessions();
    delete sessions[token];
    await saveSessions(sessions);
}

async function bootstrapState() {
    await storage.init();

    if (!(await storage.hasKey('cards'))) {
        const cards = getLegacyOrDefault(LEGACY_CARDS_FILE, { cards: [], nextId: 1 });
        await storage.setState('cards', cards);
    }
    if (!(await storage.hasKey('users'))) {
        const users = getLegacyOrDefault(LEGACY_USERS_FILE, getDefaultUsers());
        await storage.setState('users', users);
    }
    if (!(await storage.hasKey('sessions'))) {
        const sessions = getLegacyOrDefault(LEGACY_SESSIONS_FILE, {});
        await storage.setState('sessions', sessions);
    }

    if (process.env.ADMIN_LOGIN && process.env.ADMIN_PASSWORD) {
        const usersData = await getUsers();
        const adminIdx = usersData.users.findIndex((u) => u.role === 'admin');
        if (adminIdx !== -1) {
            usersData.users[adminIdx].login = process.env.ADMIN_LOGIN;
            usersData.users[adminIdx].password = process.env.ADMIN_PASSWORD;
            await saveUsers(usersData);
        }
    }

    const sessions = await getSessions();
    const now = Date.now();
    let changed = false;
    Object.keys(sessions).forEach((token) => {
        if (now - sessions[token].createdAt > 30 * 86400000) {
            delete sessions[token];
            changed = true;
        }
    });
    if (changed) await saveSessions(sessions);
}

// ── Statyczne pliki ───────────────────────────────────────────
app.use('/assets', express.static(path.join(__dirname, 'software/assets'), {
    setHeaders(res, filePath) {
        if (filePath.endsWith('panel.css')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));
app.use('/qrcode.jpeg', express.static(path.join(__dirname, 'software/qrcode.jpeg')));
app.use('/worker.js', express.static(path.join(__dirname, 'software/worker.js')));

const htmlPages = ['card', 'confirm', 'display', 'document', 'documents', 'home', 'more', 'pesel', 'qr', 'scan', 'services', 'share', 'shortcuts', 'show', 'demo'];
htmlPages.forEach((page) => {
    app.get(`/${page}`, (req, res) => res.sendFile(path.join(__dirname, 'software', `${page}.html`)));
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'software', 'login.html')));
app.get('/id', (req, res) => res.sendFile(path.join(__dirname, 'software', 'id.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'software', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'software', 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'software', 'admin.html')));
app.get('/generator', (req, res) => res.sendFile(path.join(__dirname, 'software', 'generator.html')));

// ── API ───────────────────────────────────────────────────────
app.post('/api/login', asyncHandler(async (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.json({ ok: false, error: 'Podaj login i hasło' });
    const { users } = await getUsers();
    const user = users.find((u) => u.login === login && u.password === password);
    if (!user) return res.json({ ok: false, error: 'Zły login lub hasło' });
    const token = await createSession(user.id, user.role);
    res.json({ ok: true, token, role: user.role });
}));

app.post('/api/logout', asyncHandler(async (req, res) => {
    await deleteSession(req.body?.session);
    res.json({ ok: true });
}));

app.post('/api/me', asyncHandler(async (req, res) => {
    const session = await getSession(req.body?.session);
    if (!session) return res.json({ ok: false });
    const { users } = await getUsers();
    const user = users.find((u) => u.id === session.userId);
    if (!user) return res.json({ ok: false });
    res.json({ ok: true, role: session.role, permissions: user.permissions || defaultPermissions(), cardLimit: user.cardLimit ?? null });
}));

app.post('/api/cards', requireAuth, asyncHandler(async (req, res) => {
    const { cards } = await getCards();
    const isAdmin = req.session.role === 'admin';
    const { users } = await getUsers();
    const user = users.find((u) => u.id === req.session.userId);
    const perms = user?.permissions || defaultPermissions();
    const cardLimit = user?.cardLimit ?? null;
    const list = isAdmin
        ? cards.map((c) => ({ id: c.id, token: c.token, name: c.data.name || '', surname: c.data.surname || '', day: c.data.day || 1, month: c.data.month || 1, year: c.data.year || 2000, createdBy: c.createdBy || null, createdByLogin: c.createdByLogin || null }))
        : cards.filter((c) => c.createdBy === req.session.userId).map((c) => ({ id: c.id, token: c.token, name: c.data.name || '', surname: c.data.surname || '', day: c.data.day || 1, month: c.data.month || 1, year: c.data.year || 2000 }));
    res.json({ ok: true, cards: list, isAdmin, permissions: perms, cardLimit, cardCount: list.length });
}));

app.get('/get/card', asyncHandler(async (req, res) => {
    const { card_token: cardToken, session, id } = req.query;
    const { cards } = await getCards();
    let card;
    if (cardToken) {
        card = cards.find((c) => c.token === cardToken);
    } else if (session && id) {
        const sessionData = await getSession(session);
        if (!sessionData) return res.status(401).json({ error: 'Brak sesji' });
        card = cards.find((c) => c.id === parseInt(id, 10));
    }
    if (!card) return res.status(404).json({ error: 'Nie znaleziono' });
    const { image, ...cardData } = card.data;
    res.json(cardData);
}));

app.get('/images', asyncHandler(async (req, res) => {
    const { card_token: cardToken, session, id } = req.query;
    const { cards } = await getCards();
    let card;
    if (cardToken) {
        card = cards.find((c) => c.token === cardToken);
    } else if (session && id) {
        const sessionData = await getSession(session);
        if (!sessionData) return res.status(401).send('Brak sesji');
        card = cards.find((c) => c.id === parseInt(id, 10));
    }
    if (!card || !card.data.image) return res.status(404).send('Brak zdjęcia');
    const base64 = card.data.image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const mimeType = card.data.image.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    res.set('Content-Type', mimeType);
    res.send(buffer);
}));

app.post('/api/submit', requireAuth, asyncHandler(async (req, res) => {
    const { id, data } = req.body;
    if (!data) return res.status(400).json({ error: 'Brak danych' });
    const isAdmin = req.session.role === 'admin';
    const { users } = await getUsers();
    const user = users.find((u) => u.id === req.session.userId);
    const perms = user?.permissions || defaultPermissions();
    const cardsData = await getCards();
    if (id && parseInt(id, 10) !== 0) {
        if (!isAdmin && !perms.canEdit) return res.json({ ok: false, error: 'Nie masz uprawnień do edytowania kart' });
        const idx = cardsData.cards.findIndex((c) => c.id === parseInt(id, 10));
        if (idx !== -1) {
            if (!isAdmin && cardsData.cards[idx].createdBy !== req.session.userId) return res.json({ ok: false, error: 'Nie masz dostępu do tej karty' });
            cardsData.cards[idx].data = data;
            await saveCards(cardsData);
            return res.json({ ok: true });
        }
    }
    if (!isAdmin && !perms.canCreate) return res.json({ ok: false, error: 'Nie masz uprawnień do tworzenia kart' });
    if (!isAdmin && user?.cardLimit !== null && user?.cardLimit !== undefined) {
        const userCardCount = cardsData.cards.filter((c) => c.createdBy === req.session.userId).length;
        if (userCardCount >= user.cardLimit) return res.json({ ok: false, error: `Osiągnąłeś limit ${user.cardLimit} kart` });
    }
    const cardToken = crypto.randomBytes(20).toString('hex');
    cardsData.cards.push({
        id: cardsData.nextId++,
        token: cardToken,
        data,
        createdBy: req.session.userId,
        createdByLogin: user?.login || 'unknown',
        createdAt: new Date().toISOString()
    });
    await saveCards(cardsData);
    res.json({ ok: true, token: cardToken });
}));

app.post('/api/delete-card', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.body;
    const isAdmin = req.session.role === 'admin';
    const { users } = await getUsers();
    const user = users.find((u) => u.id === req.session.userId);
    const perms = user?.permissions || defaultPermissions();
    if (!isAdmin && !perms.canDelete) return res.json({ ok: false, error: 'Nie masz uprawnień do usuwania kart' });
    const cardsData = await getCards();
    const card = cardsData.cards.find((c) => c.id === parseInt(id, 10));
    if (!card) return res.json({ ok: false, error: 'Karta nie istnieje' });
    if (!isAdmin && card.createdBy !== req.session.userId) return res.json({ ok: false, error: 'Nie masz dostępu do tej karty' });
    cardsData.cards = cardsData.cards.filter((c) => c.id !== parseInt(id, 10));
    await saveCards(cardsData);
    res.json({ ok: true });
}));

app.post('/api/users', requireAdmin, asyncHandler(async (req, res) => {
    const { users } = await getUsers();
    const { cards } = await getCards();
    const result = users.map((u) => ({
        id: u.id,
        login: u.login,
        role: u.role,
        createdAt: u.createdAt,
        cardLimit: u.cardLimit ?? null,
        cardCount: cards.filter((c) => c.createdBy === u.id).length,
        permissions: u.permissions || defaultPermissions()
    }));
    res.json({ ok: true, users: result });
}));

app.post('/api/users/add', requireAdmin, asyncHandler(async (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.json({ ok: false, error: 'Podaj login i hasło' });
    const usersData = await getUsers();
    if (usersData.users.find((u) => u.login === login)) return res.json({ ok: false, error: 'Login zajęty' });
    usersData.users.push({
        id: usersData.nextId++,
        login,
        password,
        role: 'user',
        createdAt: new Date().toISOString(),
        cardLimit: null,
        permissions: defaultPermissions()
    });
    await saveUsers(usersData);
    res.json({ ok: true });
}));

app.post('/api/users/delete', requireAdmin, asyncHandler(async (req, res) => {
    const { id } = req.body;
    const usersData = await getUsers();
    const user = usersData.users.find((u) => u.id === parseInt(id, 10));
    if (user?.role === 'admin') return res.json({ ok: false, error: 'Nie możesz usunąć admina' });
    usersData.users = usersData.users.filter((u) => u.id !== parseInt(id, 10));
    await saveUsers(usersData);
    res.json({ ok: true });
}));

app.post('/api/users/password', requireAdmin, asyncHandler(async (req, res) => {
    const { id, password } = req.body;
    if (!password) return res.json({ ok: false, error: 'Podaj nowe hasło' });
    const usersData = await getUsers();
    const idx = usersData.users.findIndex((u) => u.id === parseInt(id, 10));
    if (idx === -1) return res.json({ ok: false, error: 'Użytkownik nie istnieje' });
    usersData.users[idx].password = password;
    await saveUsers(usersData);
    res.json({ ok: true });
}));

app.post('/api/users/permissions', requireAdmin, asyncHandler(async (req, res) => {
    const { id, permissions, cardLimit, role } = req.body;
    const usersData = await getUsers();
    const idx = usersData.users.findIndex((u) => u.id === parseInt(id, 10));
    if (idx === -1) return res.json({ ok: false, error: 'Użytkownik nie istnieje' });
    if (usersData.users[idx].role === 'admin' && role !== undefined && role !== 'admin') {
        return res.json({ ok: false, error: 'Nie możesz zdegradować głównego admina' });
    }
    if (permissions !== undefined) usersData.users[idx].permissions = permissions;
    if (cardLimit !== undefined) {
        if (cardLimit === '' || cardLimit === null) usersData.users[idx].cardLimit = null;
        else {
            const parsed = parseInt(cardLimit, 10);
            usersData.users[idx].cardLimit = Number.isNaN(parsed) ? null : parsed;
        }
    }
    if (role !== undefined) usersData.users[idx].role = role;
    await saveUsers(usersData);
    res.json({ ok: true });
}));

app.post('/api/admin/cards', requireAdmin, asyncHandler(async (req, res) => {
    const { cards } = await getCards();
    const list = cards.map((c) => ({
        id: c.id,
        token: c.token,
        name: c.data.name || '',
        surname: c.data.surname || '',
        day: c.data.day || 1,
        month: c.data.month || 1,
        year: c.data.year || 2000,
        createdBy: c.createdBy || null,
        createdByLogin: c.createdByLogin || 'unknown',
        createdAt: c.createdAt || null
    }));
    res.json({ ok: true, cards: list });
}));

app.post('/validate', (req, res) => res.json({ status: 2 }));
app.post('/submit', (req, res) => res.status(401).json({ error: 'Użyj /api/submit' }));
app.post('/panel/default', (req, res) => res.status(401).json({ error: 'Użyj /api/cards' }));
app.post('/panel/admin', (req, res) => res.status(401).json({ error: 'Użyj /api/users' }));
app.post('/panel/delete', (req, res) => res.status(401).json({ error: 'Użyj /api/delete-card' }));

app.get('/cache/files', (req, res) => {
    const assetsDir = path.join(__dirname, 'software/assets');
    const files = [];
    function walk(dir, base) {
        fs.readdirSync(dir).forEach((item) => {
            const fullPath = path.join(dir, item);
            const rel = path.join(base, item).replace(/\\/g, '/');
            if (fs.statSync(fullPath).isDirectory()) walk(fullPath, rel);
            else files.push(rel);
        });
    }
    walk(assetsDir, 'assets');
    res.json({ files });
});

app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).json({ ok: false, error: 'Błąd serwera' });
});

async function start() {
    await bootstrapState();
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`✅ Serwer na porcie ${PORT} (storage: ${storage.label})`);
    });
}

start().catch((error) => {
    console.error('❌ Nie udało się uruchomić serwera:', error);
    process.exit(1);
});
