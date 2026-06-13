/**
 * Contrôleur REST — parties Songo (CRUD + coups).
 */

'use strict';

const gamesStore = require('../stores/gamesStore');
const engine = require('../engine/songoEngine');

function getToken(req) {
    return req.headers['x-player-token'] || req.body?.token || req.query?.token || null;
}

function buildGameResponse(game, playerSlot) {
    let token = null;
    if (playerSlot === 1) token = game.player1Token;
    if (playerSlot === 2) token = game.player2Token;

    const payload = {
        id: game.id,
        status: game.status,
        state: game.state,
        playerSlot,
        token,
        winner: game.state.gameOver ? engine.getMatchWinner(game.state) : 0,
        lastMove: game.lastMove || null,
    };

    if (
        game.status === 'playing' &&
        playerSlot &&
        game.state.currentPlayer === playerSlot &&
        !game.state.gameOver
    ) {
        payload.legalMoves = engine.getLegalMoveIndices(game.state);
    } else {
        payload.legalMoves = [];
    }

    return payload;
}

/** POST /api/games — créer une partie */
function create(req, res) {
    const game = gamesStore.createGame();
    res.status(201).json(buildGameResponse(game, 1));
}

/** GET /api/games — lister les parties en attente */
function listWaiting(req, res) {
    const waiting = gamesStore
        .getAllGames()
        .filter((g) => g.status === 'waiting')
        .map((g) => ({ id: g.id, createdAt: g.createdAt }));

    res.json({ games: waiting });
}

/** GET /api/games/:id — lire l'état d'une partie */
function getOne(req, res) {
    const game = gamesStore.getGame(req.params.id);
    if (!game) {
        return res.status(404).json({ error: 'Partie introuvable.' });
    }

    const token = getToken(req);
    const playerSlot = gamesStore.getPlayerSlot(game, token);

    if (game.status !== 'waiting' && !playerSlot) {
        return res.status(403).json({ error: 'Jeton joueur invalide.' });
    }

    res.json(buildGameResponse(game, playerSlot));
}

/** POST /api/games/:id/join — rejoindre en joueur 2 */
function join(req, res) {
    const result = gamesStore.joinGame(req.params.id);
    if (result.error) {
        return res.status(result.status).json({ error: result.error });
    }

    res.json(buildGameResponse(result.game, 2));
}

/** POST /api/games/:id/moves — jouer un coup */
function playMove(req, res) {
    const game = gamesStore.getGame(req.params.id);
    if (!game) {
        return res.status(404).json({ error: 'Partie introuvable.' });
    }

    const token = getToken(req);
    const playerSlot = gamesStore.getPlayerSlot(game, token);
    if (!playerSlot) {
        return res.status(403).json({ error: 'Jeton joueur invalide.' });
    }

    if (game.status !== 'playing') {
        return res.status(400).json({ error: 'La partie n\'a pas encore commencé ou est terminée.' });
    }

    const pickIndex = Number(req.body?.pickIndex);
    if (!Number.isInteger(pickIndex) || pickIndex < 0 || pickIndex >= engine.CASES) {
        return res.status(400).json({ error: 'Index de case invalide.' });
    }

    if (playerSlot !== game.state.currentPlayer) {
        return res.status(400).json({
            error: `Ce n'est pas votre tour — c'est au tour du Joueur ${game.state.currentPlayer}.`,
        });
    }

    const boardBefore = {
        nord: [...game.state.nord],
        sud: [...game.state.sud],
        scores: [...game.state.scores],
    };

    const result = engine.playMove(game.state, pickIndex);
    if (!result.ok) {
        return res.status(400).json({ error: result.error });
    }

    game.moveSeq = (game.moveSeq || 0) + 1;
    game.lastMove = { ...result.lastMove, id: game.moveSeq, boardBefore };

    gamesStore.markFinished(game);
    res.json(buildGameResponse(game, playerSlot));
}

/** DELETE /api/games/:id — supprimer / abandonner une partie */
function remove(req, res) {
    const game = gamesStore.getGame(req.params.id);
    if (!game) {
        return res.status(404).json({ error: 'Partie introuvable.' });
    }

    const token = getToken(req);
    const playerSlot = gamesStore.getPlayerSlot(game, token);
    if (!playerSlot) {
        return res.status(403).json({ error: 'Jeton joueur invalide.' });
    }

    gamesStore.deleteGame(req.params.id);
    res.json({ ok: true, message: 'Partie supprimée.' });
}

module.exports = {
    create,
    listWaiting,
    getOne,
    join,
    playMove,
    remove,
};
