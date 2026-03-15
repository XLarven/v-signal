const http = require('http');
const { Server } = require('socket.io');

const port = Number(process.env.VOICE_SIGNALING_PORT || 3055);
const host = process.env.VOICE_SIGNALING_HOST || '0.0.0.0';
const socialApiBase = (process.env.NORIE_SOCIAL_API_BASE || 'https://api.norie.app/api').replace(/\/$/, '');
const allowedOriginRaw = (process.env.VOICE_SIGNALING_ALLOWED_ORIGIN || '*').trim();
const allowedOrigins = allowedOriginRaw === '*'
    ? '*'
    : allowedOriginRaw.split(',').map(origin => origin.trim()).filter(Boolean);
const friendCache = new Map();
const FRIEND_CACHE_TTL_MS = Number(process.env.VOICE_FRIEND_CACHE_TTL_MS || 15000);

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, status: 'ok' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        success: true,
        service: 'norie-voice-signaling',
        status: 'running',
        socialApiBase
    }));
});

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST']
    }
});

const onlineUsers = new Map();
const socketUsers = new Map();
const activePeers = new Map();

const getFriendCacheKey = (userId) => String(userId || '').trim();

const getCachedFriendSet = (userId) => {
    const key = getFriendCacheKey(userId);
    const cached = friendCache.get(key);
    if (!cached) {
        return null;
    }

    if (Date.now() - cached.at > FRIEND_CACHE_TTL_MS) {
        friendCache.delete(key);
        return null;
    }

    return cached.friends;
};

const cacheFriendSet = (userId, friends) => {
    friendCache.set(getFriendCacheKey(userId), {
        at: Date.now(),
        friends
    });
};

const fetchFriendSet = async (userId) => {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
        return new Set();
    }

    const cached = getCachedFriendSet(normalizedUserId);
    if (cached) {
        return cached;
    }

    const response = await fetch(`${socialApiBase}/friends_list.php?uuid=${encodeURIComponent(normalizedUserId)}`);
    if (!response.ok) {
        throw new Error(`friends_list HTTP ${response.status}`);
    }

    const payload = await response.json();
    const friends = new Set(
        Array.isArray(payload?.friends)
            ? payload.friends
                .map(friend => String(friend.friend_uuid || friend.uuid || friend.id || '').trim())
                .filter(Boolean)
            : []
    );

    cacheFriendSet(normalizedUserId, friends);
    return friends;
};

const verifyFriendRelationship = async (leftUserId, rightUserId) => {
    const left = String(leftUserId || '').trim();
    const right = String(rightUserId || '').trim();

    if (!left || !right || left === right) {
        return false;
    }

    const [leftFriends, rightFriends] = await Promise.all([
        fetchFriendSet(left),
        fetchFriendSet(right)
    ]);

    return leftFriends.has(right) || rightFriends.has(left);
};

const getSocketId = (userId) => onlineUsers.get(String(userId || '').trim()) || null;

const clearPeerLink = (userId, notifyPeer = false, reason = 'call-ended') => {
    const normalizedUserId = String(userId || '').trim();
    const peerId = activePeers.get(normalizedUserId);

    activePeers.delete(normalizedUserId);

    if (!peerId) {
        return;
    }

    if (activePeers.get(peerId) === normalizedUserId) {
        activePeers.delete(peerId);
    }

    if (!notifyPeer) {
        return;
    }

    const peerSocketId = getSocketId(peerId);
    if (peerSocketId) {
        io.to(peerSocketId).emit('call-ended', {
            fromUserId: normalizedUserId,
            reason
        });
    }
};

const registerPeerLink = (leftUserId, rightUserId) => {
    const left = String(leftUserId || '').trim();
    const right = String(rightUserId || '').trim();

    if (!left || !right || left === right) {
        return;
    }

    activePeers.set(left, right);
    activePeers.set(right, left);
};

const emitIfOnline = (targetUserId, eventName, payload) => {
    const socketId = getSocketId(targetUserId);
    if (!socketId) {
        return false;
    }

    io.to(socketId).emit(eventName, payload);
    return true;
};

io.on('connection', (socket) => {
    socket.on('register-user', (payload = {}) => {
        const userId = String(payload.userId || '').trim();
        const username = String(payload.username || '').trim();

        if (!userId) {
            socket.emit('voice-error', { message: 'Geçersiz kullanıcı kimliği.' });
            return;
        }

        const existingSocketId = getSocketId(userId);
        if (existingSocketId && existingSocketId !== socket.id) {
            io.to(existingSocketId).emit('call-ended', {
                fromUserId: userId,
                reason: 'session-replaced'
            });
        }

        onlineUsers.set(userId, socket.id);
        socketUsers.set(socket.id, { userId, username });
        socket.emit('voice-registered', { userId });
    });

    socket.on('call-request', async (payload = {}) => {
        const caller = socketUsers.get(socket.id);
        const targetUserId = String(payload.targetUserId || '').trim();

        if (!caller?.userId || !targetUserId) {
            socket.emit('voice-error', { message: 'Arama isteği eksik.' });
            return;
        }

        if (caller.userId === targetUserId) {
            socket.emit('call-unavailable', { reason: 'self-call' });
            return;
        }

        try {
            const areFriends = await verifyFriendRelationship(caller.userId, targetUserId);
            if (!areFriends) {
                socket.emit('call-unavailable', {
                    targetUserId,
                    reason: 'not-friends'
                });
                return;
            }
        } catch (err) {
            socket.emit('voice-error', {
                message: 'Arkadaşlık doğrulaması yapılamadı.'
            });
            return;
        }

        const delivered = emitIfOnline(targetUserId, 'incoming-call', {
            callerId: caller.userId,
            callerName: payload.callerName || caller.username || caller.userId
        });

        if (!delivered) {
            socket.emit('call-unavailable', {
                targetUserId,
                reason: 'offline'
            });
            return;
        }

        activePeers.set(caller.userId, targetUserId);
    });

    socket.on('call-accept', async (payload = {}) => {
        const callee = socketUsers.get(socket.id);
        const callerId = String(payload.callerId || '').trim();

        if (!callee?.userId || !callerId) {
            return;
        }

        try {
            const areFriends = await verifyFriendRelationship(callee.userId, callerId);
            if (!areFriends) {
                emitIfOnline(callerId, 'call-rejected', {
                    rejectorId: callee.userId,
                    reason: 'not-friends'
                });
                return;
            }
        } catch {
            emitIfOnline(callerId, 'call-rejected', {
                rejectorId: callee.userId,
                reason: 'validation-failed'
            });
            return;
        }

        registerPeerLink(callee.userId, callerId);
        emitIfOnline(callerId, 'call-accepted', {
            acceptorId: callee.userId,
            acceptorName: payload.calleeName || callee.username || callee.userId
        });
    });

    socket.on('call-reject', (payload = {}) => {
        const callee = socketUsers.get(socket.id);
        const callerId = String(payload.callerId || '').trim();

        if (!callee?.userId || !callerId) {
            return;
        }

        clearPeerLink(callee.userId, false);
        activePeers.delete(callerId);

        emitIfOnline(callerId, 'call-rejected', {
            rejectorId: callee.userId,
            reason: payload.reason || 'rejected'
        });
    });

    socket.on('webrtc-offer', (payload = {}) => {
        const caller = socketUsers.get(socket.id);
        const targetUserId = String(payload.targetUserId || '').trim();

        if (!caller?.userId || !targetUserId || !payload.offer) {
            return;
        }

        emitIfOnline(targetUserId, 'webrtc-offer', {
            fromUserId: caller.userId,
            offer: payload.offer
        });
    });

    socket.on('webrtc-answer', (payload = {}) => {
        const callee = socketUsers.get(socket.id);
        const targetUserId = String(payload.targetUserId || '').trim();

        if (!callee?.userId || !targetUserId || !payload.answer) {
            return;
        }

        emitIfOnline(targetUserId, 'webrtc-answer', {
            fromUserId: callee.userId,
            answer: payload.answer
        });
    });

    socket.on('ice-candidate', (payload = {}) => {
        const sender = socketUsers.get(socket.id);
        const targetUserId = String(payload.targetUserId || '').trim();

        if (!sender?.userId || !targetUserId || !payload.candidate) {
            return;
        }

        emitIfOnline(targetUserId, 'ice-candidate', {
            fromUserId: sender.userId,
            candidate: payload.candidate
        });
    });

    socket.on('call-end', (payload = {}) => {
        const sender = socketUsers.get(socket.id);
        const targetUserId = String(payload.targetUserId || activePeers.get(sender?.userId || '') || '').trim();

        if (!sender?.userId) {
            return;
        }

        clearPeerLink(sender.userId, false);
        if (targetUserId) {
            emitIfOnline(targetUserId, 'call-ended', {
                fromUserId: sender.userId,
                reason: payload.reason || 'ended'
            });
        }
    });

    socket.on('disconnect', () => {
        const user = socketUsers.get(socket.id);
        if (!user?.userId) {
            return;
        }

        if (onlineUsers.get(user.userId) === socket.id) {
            onlineUsers.delete(user.userId);
        }

        socketUsers.delete(socket.id);
        clearPeerLink(user.userId, true, 'disconnect');
    });
});

server.listen(port, host, () => {
    console.log(`Norie ses sinyal sunucusu hazir: http://${host}:${port}`);
});
