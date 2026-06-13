# Songo Remote — Version réseau (Node.js + Express)

Jeu de **Songo** à 2 joueurs sur **deux navigateurs distincts**.

**Stack client (consigne prof)** : HTML, CSS, JavaScript et **AJAX** (`XMLHttpRequest`).

**Stack serveur** : Node.js + Express (API REST, sans WebSocket).

Règles officielles : https://www.clubawale.com/post/comment-jouer-le-songo

---

## 1. Différence avec la version locale (v1)

| | Version 1 (`../`) | Version 2 (`songo_remote/`) |
|---|---|---|
| Joueurs | Même écran, même machine | Deux machines / deux onglets |
| Logique du jeu | Dans `script.js` (navigateur) | Sur le **serveur** (`engine/`) |
| Communication | Aucune | **AJAX** (XMLHttpRequest) vers API REST |
| Synchronisation | Immédiate | Polling toutes les 2 secondes |

---

## 2. Architecture globale

```
┌─────────────────┐         HTTP (REST)          ┌─────────────────────────────┐
│   Navigateur    │  ◄────────────────────────►  │   Serveur Node.js (Express) │
│                 │                              │                             │
│  index.html     │   GET  /api/games/:id        │  router/        → routes    │
│  css/style.css  │   POST /api/games/:id/moves  │  controllers/   → logique   │
│  script.js      │                              │  stores/        → données   │
│  (UI seulement) │                              │  engine/        → règles    │
└─────────────────┘                              └─────────────────────────────┘
```

**Principe** : le navigateur n'exécute plus les règles du Songo. Il affiche l'état reçu du serveur et envoie les intentions de coup (`pickIndex`). Le serveur valide, applique les règles et renvoie le nouvel état.

---

## 3. Structure des fichiers

```
songo_remote/
├── app.js                      # Point d'entrée Express, fichiers statiques
├── package.json                # Dépendances : express, morgan, nodemon
├── index.html                  # Interface (3 écrans + modales)
├── script.js                   # Client : UI + requêtes AJAX vers /api
├── css/style.css               # Styles
├── audio/                      # Musique d'ambiance
│
├── engine/
│   └── songoEngine.js          # ★ Moteur de règles (logique métier pure)
│
├── stores/
│   └── gamesStore.js           # ★ Stockage CRUD des parties (mémoire RAM)
│
├── controllers/
│   ├── healthController.js     # Vérification serveur
│   └── gameController.js       # ★ Contrôleur REST des parties
│
└── router/
    └── index.js                # Définition des routes /api/*
```

---

## 4. Moteur de jeu — `engine/songoEngine.js`

Module **sans dépendance Express**. Il contient toute la logique métier copiée et adaptée depuis la v1.

### État d'une partie (`state`)

```javascript
{
  nord: [5, 5, 5, 5, 5, 5, 5],   // camp Joueur 2 (Nord)
  sud:  [5, 5, 5, 5, 5, 5, 5],   // camp Joueur 1 (Sud)
  scores: [0, 0],                 // graines capturées [J1, J2]
  currentPlayer: 1,               // 1 ou 2
  gameOver: false,
  message: 'Tour de Joueur 1'
}
```

### Fonctions exportées

| Fonction | Rôle |
|----------|------|
| `createInitialState()` | Plateau de départ (7×5 graines) |
| `getLegalMoves(state)` | Liste des coups autorisés (solidarité, case 7…) |
| `getLegalMoveIndices(state)` | Indices des cases jouables |
| `explainRefusedMove(state, player, index)` | Message d'erreur si coup interdit |
| `playMove(state, pickIndex)` | Joue un coup ; retourne `{ ok, error? }` |
| `getMatchWinner(state)` | `1`, `2` ou `0` (nul) |
| `resolveWinner(state)` | Message texte de fin |

### Règles implémentées

- Distribution des graines (boucle 14 cases, règle > 13 graines)
- Récoltes (prises, chaîne, case 1 spéciale)
- Solidarité (≥ 7 graines, maximum transmis)
- Interdit case 7 (1–2 graines chez l'adversaire)
- Fin : 40 graines, < 10 sur tablier, solidarité impossible

---

## 5. Stockage — `stores/gamesStore.js`

Stockage **en mémoire** (`Map`) — les parties disparaissent si le serveur redémarre.

### Objet `game` stocké

```javascript
{
  id: 'A1B2C3D4',           // code à 8 caractères (majuscules)
  status: 'waiting',        // waiting | playing | finished
  player1Token: 'uuid-…',   // jeton secret Joueur 1
  player2Token: null,       // jeton secret Joueur 2 (après join)
  state: { … },             // état du plateau (moteur)
  createdAt: 1718123456789
}
```

### Opérations CRUD

| Fonction | Opération |
|----------|-----------|
| `createGame()` | **Create** — nouvelle partie, J1 en attente |
| `getGame(id)` | **Read** — lire une partie |
| `getAllGames()` | **Read** — toutes les parties |
| `joinGame(id)` | **Update** — J2 rejoint, status → `playing` |
| `deleteGame(id)` | **Delete** — abandon / suppression |
| `getPlayerSlot(game, token)` | Identifie J1 (1) ou J2 (2) via jeton |
| `markFinished(game)` | Passe en `finished` si `gameOver` |

---

## 6. API REST — routes

Base : `http://localhost:3000/api`

### `GET /health`

Vérifie que le serveur répond.

```json
{ "status": "ok", "service": "songo-remote", "version": "1.0.0" }
```

### `POST /games` — Créer une partie

Le **Joueur 1** crée une salle. Réponse `201` :

```json
{
  "id": "A1B2C3D4",
  "status": "waiting",
  "playerSlot": 1,
  "token": "jeton-secret-j1",
  "state": { … },
  "legalMoves": [],
  "winner": 0
}
```

### `GET /games` — Parties en attente

Liste les salles où `status === 'waiting'`.

### `GET /games/:id` — Lire l'état

Header requis (sauf partie en attente) :

```
X-Player-Token: <jeton>
```

Réponse : état complet + `legalMoves` si c'est votre tour.

### `POST /games/:id/join` — Rejoindre (Joueur 2)

Réponse : même format, `playerSlot: 2`, nouveau `token`.

### `POST /games/:id/moves` — Jouer un coup

```http
POST /api/games/A1B2C3D4/moves
X-Player-Token: <jeton>
Content-Type: application/json

{ "pickIndex": 3 }
```

- **200** : coup accepté, nouvel état renvoyé
- **400** : coup refusé + `{ "error": "raison…" }`
- **403** : jeton invalide

### `DELETE /games/:id` — Abandonner

Supprime la partie (jeton requis).

---

## 7. Contrôleur — `controllers/gameController.js`

Fait le lien entre **HTTP** et **moteur + store** :

1. Lit le jeton joueur (`X-Player-Token`)
2. Vérifie les droits (bon joueur, bon tour)
3. Appelle `engine.playMove()` ou le store
4. Formate la réponse avec `buildGameResponse()`

`legalMoves` n'est renvoyé que si :
- la partie est en cours (`playing`)
- c'est le tour du joueur connecté
- la partie n'est pas terminée

---

## 8. Client — `script.js`

Le client est découpé en sections :

| Section | Rôle |
|---------|------|
| 1. Constantes & état | `gameId`, `playerToken`, `playerSlot`, `state` |
| 2. AJAX | `ajaxRequest`, `createOnlineGame`, `joinOnlineGame`, `playMoveRemote` |
| 3. Rendu visuel | Plateau, graines, scores (inchangé visuellement) |
| 4. Audio | Musique |
| 5. Navigation | Écrans splash / menu / jeu |
| 6. Initialisation | Événements boutons |

### AJAX — fonction centrale

```javascript
// XMLHttpRequest : requête asynchrone sans recharger la page
function ajaxRequest(method, path, body) {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () { /* traiter la réponse JSON */ };
    xhr.send(body ? JSON.stringify(body) : null);
}
```

### Synchronisation sans WebSocket

```javascript
// Toutes les 2 secondes : AJAX GET pour récupérer l'état adverse
setInterval(syncFromServer, 2000);
// → ajaxRequest('GET', '/api/games/:id')
```

### Parcours utilisateur

1. **Joueur 1** : menu → **CRÉER** → code affiché → attend J2
2. **Joueur 2** : menu → **REJOINDRE** → saisit le code
3. Les deux voient le plateau ; seul le joueur actif peut cliquer ses cases
4. Clic case → `POST /moves` → serveur valide → plateau mis à jour
5. L'autre joueur voit le changement au prochain polling (≤ 2 s)

### Session locale

`localStorage` (`songo-remote-session`) sauvegarde `gameId` + `token` pour survivre à un rechargement de page.

---

## 9. Serveur — `app.js`

```javascript
app.use(morgan('dev'));          // logs HTTP
app.use(express.json());         // body JSON
app.use('/api', apiRouter);      // routes API

// Fichiers statiques (sans exposer node_modules)
app.use('/css', express.static(...));
app.use('/audio', express.static(...));
app.get('/script.js', ...);
app.get('/', ...);               // index.html
```

Port par défaut : **3000** (`process.env.PORT` pour changer).

---

## 10. Lancer le projet

```bash
cd songo_remote
npm install
npm start          # nodemon app.js (redémarrage auto)
# ou
npm run dev        # node app.js
```

Ouvrir **http://localhost:3000** sur deux navigateurs (ou deux machines du même réseau en remplaçant `localhost` par l'IP du serveur).

### Test rapide de l'API

```bash
# Créer
curl -s -X POST http://localhost:3000/api/games | jq

# Rejoindre (remplacer CODE)
curl -s -X POST http://localhost:3000/api/games/CODE/join | jq

# Jouer (remplacer CODE et TOKEN)
curl -s -X POST http://localhost:3000/api/games/CODE/moves \
  -H "Content-Type: application/json" \
  -H "X-Player-Token: TOKEN" \
  -d '{"pickIndex":0}' | jq
```

---

## 11. Technologies utilisées

| Technologie | Usage |
|-------------|-------|
| **Node.js** | Runtime serveur |
| **Express 5** | Framework HTTP, routes, JSON |
| **Morgan** | Logs des requêtes |
| **crypto (natif)** | UUID pour id parties et jetons |
| **AJAX / XMLHttpRequest** | Appels API côté client (sans rechargement) |
| **localStorage** | Scores locaux + session de partie |

**Non utilisé** (volontairement) : WebSocket, base de données, sessions Express.

---

## 12. Pistes d'évolution

- Persistance des parties (fichier JSON ou MongoDB)
- Authentification joueur (pseudo)
- Réduire le délai de polling ou passer au WebSocket plus tard
- Empêcher la triche (toute validation reste côté serveur ✓)
