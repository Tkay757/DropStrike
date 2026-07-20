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
      clientsCount: Object.keys(room.clients).length,
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
        hostProfile: senderProfile,
        clients: {}, // { socketId: { status: 'pending' | 'approved', profile: ... } }
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

      const limit = room.personLimit;
      const currentCount = Object.keys(room.clients).length;
      if (limit > 0 && currentCount >= (limit - 1)) { // -1 because limit includes the host
        return callback({ success: false, error: `This room has reached its limit of ${limit} peers.` });
      }

      // Track connection intent
      room.clients[socket.id] = { status: 'pending', profile: receiverProfile };
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

      if (room.clients[clientSocketId] && room.clients[clientSocketId].status === 'pending') {
        room.clients[clientSocketId].status = 'approved';

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

        // Notify host to begin RTC connection negotiation with THIS specific client
        socket.emit('peer-connected', {
          clientSocketId,
          receiverProfile: room.clients[clientSocketId].profile
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

      if (room.clients[clientSocketId] && room.clients[clientSocketId].status === 'pending') {
        delete room.clients[clientSocketId];

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
    // If sender, we need to know WHICH receiver to send to.
    let targetSocketId = null;
    if (socket.id === room.hostSocketId) {
      targetSocketId = signalData.target; // Sender MUST specify target
    } else {
      targetSocketId = room.hostSocketId; // Receiver always sends to Host
      signalData.target = socket.id; // Tell host who sent it
    }

    const signalType = signalData.sdp ? signalData.sdp.type : (signalData.ice ? 'ICE' : 'Unknown');
    console.log(`[Signaling] Relaying ${signalType} from ${socket.id} to target: ${targetSocketId}`);

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
        // Notify clients if they are connected
        Object.keys(room.clients).forEach(clientId => {
          const clientData = room.clients[clientId];
          if (clientData.status === 'approved') {
            io.to(clientId).emit('peer-disconnected', { reason: 'Sender closed the connection' });
          } else {
            io.to(clientId).emit('join-rejected', { reason: 'Sender closed the connection' });
          }
          const clientSocket = io.sockets.sockets.get(clientId);
          if (clientSocket) {
            clientSocket.leave(room.roomId);
            clientSocket.currentPin = null;
          }
        });

        socket.leave(room.roomId);
        socket.currentPin = null;
        activeRooms.delete(pin);
      } else if (room.clients[socket.id]) {
        const clientStatus = room.clients[socket.id].status;
        console.log(`Client left room: ${pin} (Status: ${clientStatus})`);
        
        if (clientStatus === 'approved') {
          // Notify host
          io.to(room.hostSocketId).emit('peer-disconnected', { reason: 'Receiver disconnected', clientSocketId: socket.id });
        } else {
          // Notify host that join request was canceled
          io.to(room.hostSocketId).emit('peer-join-canceled', { clientSocketId: socket.id });
        }
        
        socket.leave(room.roomId);
        socket.currentPin = null;
        delete room.clients[socket.id];
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
