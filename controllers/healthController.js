/**
 * Contrôleur — vérification que le serveur répond.
 */

function getHealth(req, res) {
    res.json({
        status: 'ok',
        service: 'songo-remote',
        version: '1.0.0',
    });
}

module.exports = { getHealth };
