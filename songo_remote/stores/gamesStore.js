/**
 * Stockage en mémoire des parties (CRUD).
 * Chaque partie possède un identifiant et un jeton par joueur.
 */

'use strict';

const { randomUUID } = require('crypto');
const { createInitialState } = require('../engine/songoEngine');

/** @type {Map<string, object>} */
const games = new Map();

function createGame() {
    const id = randomUUID().slice(0, 8).toUpperCase();
    const game = {
        id,
        status: 'waiting',
        player1Token: randomUUID(),
        player2Token: null,
        state: createInitialState(),
        createdAt: Date.now(),
        moveSeq: 0,
        lastMove: null,
    };
    games.set(id, game);
    return game;
}

function getGame(id) {
    return games.get(id) || null;
}

function getAllGames() {
    return Array.from(games.values());
}

function joinGame(id) {
    const game = getGame(id);
    if (!game) return { error: 'Partie introuvable.', status: 404 };
    if (game.status !== 'waiting') return { error: 'Cette partie n\'accepte plus de joueur.', status: 400 };
    if (game.player2Token) return { error: 'Partie complète.', status: 400 };

    game.player2Token = randomUUID();
    game.status = 'playing';
    return { game };
}

function getPlayerSlot(game, token) {
    if (!game || !token) return null;
    if (token === game.player1Token) return 1;
    if (token === game.player2Token) return 2;
    return null;
}

function deleteGame(id) {
    return games.delete(id);
}

function markFinished(game) {
    if (game.state.gameOver) {
        game.status = 'finished';
    }
}

module.exports = {
    createGame,
    getGame,
    getAllGames,
    joinGame,
    getPlayerSlot,
    deleteGame,
    markFinished,
};
