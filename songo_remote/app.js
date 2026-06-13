/**
 * ============================================================
 *  SONGO REMOTE — Serveur Node.js / Express
 *  Version réseau : 2 joueurs sur des machines distinctes
 * ============================================================
 */

const os = require('os');
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const apiRouter = require('./router');

/** Adresses IPv4 locales (Wi‑Fi / Ethernet) pour jouer depuis un autre appareil */
function getLocalIPv4Addresses() {
    const addresses = [];
    const interfaces = os.networkInterfaces();
    for (const ifaces of Object.values(interfaces)) {
        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        }
    }
    return addresses;
}

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

/* --- Middleware --- */
app.use(morgan('dev'));
app.use(express.json());

/* --- API --- */
app.use('/api', apiRouter);

/* --- Fichiers statiques (interface copiée de la v1) --- */
app.use('/css', express.static(path.join(ROOT, 'css')));
app.use('/audio', express.static(path.join(ROOT, 'audio')));

app.get('/script.js', (req, res) => {
    res.sendFile(path.join(ROOT, 'script.js'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(ROOT, 'index.html'));
});

/* --- Démarrage (0.0.0.0 = accessible depuis le réseau local) --- */
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log('Songo remote — serveur démarré');
    console.log(`  Sur cette machine : http://localhost:${PORT}`);
    const ips = getLocalIPv4Addresses();
    if (ips.length > 0) {
        console.log('  Depuis un autre appareil (même Wi‑Fi) :');
        ips.forEach((ip) => console.log(`    → http://${ip}:${PORT}`));
    } else {
        console.log('  (aucune IP réseau détectée — vérifiez la connexion Wi‑Fi)');
    }
});

module.exports = app;
