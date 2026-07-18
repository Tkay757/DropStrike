const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration endpoint for client-side Google OAuth Sign-In
app.get('/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '32883702529-0kkbhu7f15e4u4cvkte2a9jhrt5c1l0r.apps.googleusercontent.com'
  });
});

// Retrieve public listing of active rooms (exposes no PINs for security)
app.get('/active-rooms', (req, res) => {
  const rooms = [];
  for (const [pin, room] of activeRooms.entries()) {
    rooms.push({
      roomId: room.roomId,
      roomName: room.roomName,
      hostName: room.hostProfile?.name || 'Host',
      hostPicture: room.hostProfile?.picture || null,
      clientsCount: (room.clientSocketId || room.pendingClientSocketId) ? 1 : 0,
      personLimit: room.personLimit
    });
  }
  res.json({
    success: true,
    roomsCount: rooms.length,
    rooms: rooms
  });
});

// Volatile in-memory room store: PIN -> Room Details
// Room Details: { roomId, pin, hostSocketId, clientSocketId, hostProfile, clientProfile }
const activeRooms = new Map();

// Helper to generate a unique 6-digit numeric PIN
function generateUniquePIN() {
  let pin;
  do {
    pin = Math.floor(100000 + Math.random() * 900000).toString();
  } while (activeRooms.has(pin));
  return pin;
}

// Socket.io signalling logic
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // 1. Create a room (Sender)
  socket.on('create-room', ({ senderProfile, settings }, callback) => {
    try {
      const pin = generateUniquePIN();
      const roomId = `room-${Math.random().toString(36).substr(2, 9)}`;
      
      const roomName = settings?.roomName || `Room ${pin}`;
      const personLimit = parseInt(settings?.personLimit) || 2; // Host + Guests
      const expiryLimit = parseInt(settings?.expiryLimit) || 1; // minutes
      
      // Setup room expiry timeout
      const timeoutId = setTimeout(() => {
        console.log(`Room ${pin} expired after ${expiryLimit} minute(s).`);
        io.to(roomId).emit('room-expired');
        activeRooms.delete(pin);
      }, expiryLimit * 60 * 1000);
      
      const roomData = {
        roomId,
        pin,
        hostSocketId: socket.id,
        clientSocketId: null,
        hostProfile: senderProfile,
        clientProfile: null,
        timeoutId,
        roomName,
        personLimit,
        expiryLimit
      };

      activeRooms.set(pin, roomData);
      socket.join(roomId);
      socket.currentPin = pin; // Associate pin with socket for cleanup

      console.log(`Room created. Name: ${roomName}, PIN: ${pin}, RoomID: ${roomId}, Host: ${socket.id}, Capacity: ${personLimit}, Expiry: ${expiryLimit}m`);
      callback({ success: true, pin, roomId, roomName, personLimit, expiryLimit });
    } catch (err) {
      console.error('Error creating room:', err);
      callback({ success: false, error: 'Internal Server Error' });
    }
  });

  // 2. Join a room (Receiver - places client in pending state)
  socket.on('join-room', ({ pin, receiverProfile }, callback) => {
    try {
      const room = activeRooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Invalid or expired 6-digit PIN' });
      }

      const limit = room.personLimit || 2;
      if (room.clientSocketId || room.pendingClientSocketId) {
        return callback({ success: false, error: `This room has reached its limit of ${limit} peers.` });
      }

      // Track connection intent by placing them in pending queue
      room.pendingClientSocketId = socket.id;
      room.pendingReceiverProfile = receiverProfile;
      socket.currentPin = pin;

      console.log(`Receiver requesting to join. PIN: ${pin}, Client: ${socket.id}, Name: ${receiverProfile.name}`);

      // Alert host of request
      io.to(room.hostSocketId).emit('peer-join-request', {
        clientSocketId: socket.id,
        receiverProfile
      });

      // Respond that they are in the waiting lobby
      callback({
        success: true,
        status: 'waiting_approval',
        roomName: room.roomName
      });
    } catch (err) {
      console.error('Error joining room:', err);
      callback({ success: false, error: 'Internal Server Error' });
    }
  });

  // 2b. Host approves peer connection request
  socket.on('approve-peer', ({ clientSocketId }) => {
    try {
      const pin = socket.currentPin;
      const room = activeRooms.get(pin);
      if (!room || room.hostSocketId !== socket.id) return;

      if (room.pendingClientSocketId === clientSocketId) {
        room.clientSocketId = clientSocketId;
        room.clientProfile = room.pendingReceiverProfile;
        
        room.pendingClientSocketId = null;
        room.pendingReceiverProfile = null;

        const clientSocket = io.sockets.sockets.get(clientSocketId);
        if (clientSocket) {
          clientSocket.join(room.roomId);
        }

        console.log(`Host approved peer. Client: ${clientSocketId} joined room ${room.roomId}`);

        // Notify client of approval
        io.to(clientSocketId).emit('join-approved', {
          roomId: room.roomId,
          senderProfile: room.hostProfile,
          roomName: room.roomName
        });

        // Notify host to begin RTC connection negotiation
        socket.emit('peer-connected', {
          receiverProfile: room.clientProfile
        });
      }
    } catch (err) {
      console.error('Error approving peer:', err);
    }
  });

  // 2c. Host rejects peer connection request
  socket.on('reject-peer', ({ clientSocketId }) => {
    try {
      const pin = socket.currentPin;
      const room = activeRooms.get(pin);
      if (!room || room.hostSocketId !== socket.id) return;

      if (room.pendingClientSocketId === clientSocketId) {
        room.pendingClientSocketId = null;
        room.pendingReceiverProfile = null;

        console.log(`Host rejected peer: ${clientSocketId}`);

        io.to(clientSocketId).emit('join-rejected', {
          reason: 'The room host rejected your request to join.'
        });
      }
    } catch (err) {
      console.error('Error rejecting peer:', err);
    }
  });

  // 3. Relay signaling details between peers (Offers, Answers, ICE Candidates)
  socket.on('signal', ({ pin, signalData }) => {
    const room = activeRooms.get(pin);
    if (!room) {
      console.log(`[Signaling] Room for PIN ${pin} not found!`);
      return;
    }

    // Send the signal to the opposite peer
    const targetSocketId = (socket.id === room.hostSocketId) 
      ? room.clientSocketId 
      : room.hostSocketId;

    const signalType = signalData.sdp ? signalData.sdp.type : (signalData.ice ? 'ICE' : 'Unknown');
    console.log(`[Signaling] Relaying ${signalType} from ${socket.id} to target: ${targetSocketId} (Host: ${room.hostSocketId}, Client: ${room.clientSocketId})`);

    if (targetSocketId) {
      io.to(targetSocketId).emit('signal', { signalData });
    } else {
      console.log(`[Signaling] Target socket ID for PIN ${pin} is null/undefined!`);
    }
  });

  // 4. Manual room exit (Sender/Receiver)
  socket.on('leave-room', () => {
    handleLeaveRoom(socket);
  });

  // 5. Client disconnect cleanup
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
    handleLeaveRoom(socket);
  });
});

// Helper: Handle room exit logic
function handleLeaveRoom(socket) {
  if (socket.currentPin) {
    const pin = socket.currentPin;
    const room = activeRooms.get(pin);

    if (room) {
      if (socket.id === room.hostSocketId) {
        console.log(`Host left room, deleting room: ${pin}`);
        if (room.timeoutId) {
          clearTimeout(room.timeoutId);
        }
        // Notify client if they are connected
        if (room.clientSocketId) {
          io.to(room.clientSocketId).emit('peer-disconnected', { reason: 'Sender closed the connection' });
          // Reset client attributes so client cleanups don't reference room
          const clientSocket = io.sockets.sockets.get(room.clientSocketId);
          if (clientSocket) {
            clientSocket.leave(room.roomId);
            clientSocket.currentPin = null;
          }
        }
        // Notify pending client if they are waiting
        if (room.pendingClientSocketId) {
          io.to(room.pendingClientSocketId).emit('join-rejected', { reason: 'Sender closed the connection' });
          const pendingClientSocket = io.sockets.sockets.get(room.pendingClientSocketId);
          if (pendingClientSocket) {
            pendingClientSocket.currentPin = null;
          }
        }
        socket.leave(room.roomId);
        socket.currentPin = null;
        activeRooms.delete(pin);
      } else if (socket.id === room.clientSocketId) {
        console.log(`Client left room: ${pin}`);
        // Notify host
        io.to(room.hostSocketId).emit('peer-disconnected', { reason: 'Receiver disconnected' });
        socket.leave(room.roomId);
        socket.currentPin = null;
        // Reset receiver properties on the active room
        room.clientSocketId = null;
        room.clientProfile = null;
      } else if (socket.id === room.pendingClientSocketId) {
        console.log(`Pending client left room: ${pin}`);
        // Notify host that join request was canceled
        io.to(room.hostSocketId).emit('peer-join-canceled', { clientSocketId: socket.id });
        socket.currentPin = null;
        room.pendingClientSocketId = null;
        room.pendingReceiverProfile = null;
      }
    }
  }
}

// Serve frontend routing fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
