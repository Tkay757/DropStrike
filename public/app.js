// DropFlow - Core Client-Side Logic
let socket;
let currentUser = null;
let currentRole = null; // 'sender' or 'receiver'
let activePin = null;
let selectedFile = null;
let selectedFiles = [];
let currentFileIndex = 0;
let completedFilesBytes = 0;
let totalFilesSize = 0;
let senderOffset = 0;

// WebRTC State Variables
let peerConnection = null;
let dataChannel = null;
let peerConnections = {}; // clientId -> RTCPeerConnection
let dataChannels = {}; // clientId -> RTCDataChannel
let receivedChunks = [];
let receivedSize = 0;
let fileMetadata = null;

// Transfer Rate Tracking
let transferStartTime = null;
let speedInterval = null;
let countdownInterval = null;

// WebRTC ICE Candidate Queue (avoids race condition candidate loss)
let iceQueue = [];
let isRemoteDescSet = false;
let pendingClientSocketId = null;


// ----------------------------------------
// Sound Engine (Procedural Web Audio API)
// ----------------------------------------
window.appIsActiveSession = false;

const SoundEngine = {
  ctx: null,
  init: function() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  },
  playClick: function() {
    this.init();
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(300, this.ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.05);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.05);
  },
  playSuccess: function() {
    this.init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    
    // First chime
    const osc1 = this.ctx.createOscillator();
    const gain1 = this.ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(523.25, t); // C5
    gain1.gain.setValueAtTime(0, t);
    gain1.gain.linearRampToValueAtTime(0.3, t + 0.05);
    gain1.gain.exponentialRampToValueAtTime(0.01, t + 0.4);
    osc1.connect(gain1);
    gain1.connect(this.ctx.destination);
    osc1.start(t);
    osc1.stop(t + 0.4);
    
    // Second chime
    const osc2 = this.ctx.createOscillator();
    const gain2 = this.ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(783.99, t + 0.15); // G5
    gain2.gain.setValueAtTime(0, t + 0.15);
    gain2.gain.linearRampToValueAtTime(0.3, t + 0.2);
    gain2.gain.exponentialRampToValueAtTime(0.01, t + 0.6);
    osc2.connect(gain2);
    gain2.connect(this.ctx.destination);
    osc2.start(t + 0.15);
    osc2.stop(t + 0.6);
  },
  playError: function() {
    this.init();
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(300, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(150, this.ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.3);
  }
};

// Global click listener for buttons to play click sound
document.addEventListener('click', (e) => {
  if (e.target.closest('button') || e.target.closest('.btn')) {
    SoundEngine.playClick();
  }
});

// Refresh/Close Warning for Active Sessions
window.addEventListener('beforeunload', (e) => {
  if (window.appIsActiveSession) {
    e.preventDefault();
    e.returnValue = ''; // Standard way to trigger warning
  }
});
// ----------------------------------------

// Configuration
const CHUNK_SIZE = 16384; // 16KB
const BUFFER_THRESHOLD = 1048576; // 1MB
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10
};

// UI Element Mapping
const panels = {
  dashboard: document.getElementById('panel-dashboard'),
  sender: document.getElementById('panel-sender'),
  receiver: document.getElementById('panel-receiver')
};

const views = {
  // Sender sub-steps
  sendSelect: document.getElementById('send-step-select'),
  sendSettings: document.getElementById('send-step-settings'),
  sendDashboard: document.getElementById('send-step-dashboard'),
  // Receiver sub-steps
  receivePin: document.getElementById('receive-step-pin'),
  receiveNegotiate: document.getElementById('receive-step-negotiate'),
  receiveTransfer: document.getElementById('receive-step-transfer')
};

// Helper: Show specific panel
function showPanel(panelId) {
  Object.keys(panels).forEach(key => {
    const el = panels[key];
    if (!el) return;
    
    if (key === panelId) {
      el.classList.remove('hidden');
      el.classList.add('panel-active');
    } else {
      el.classList.add('hidden');
      el.classList.remove('panel-active');
    }
  });
}

// Helper: Show modern dynamic toast notifications
function showNotification(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast-card ${type}`;

  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '⚠️';

  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-text">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  // Trigger animation after brief timeout
  setTimeout(() => {
    toast.classList.add('show');
  }, 10);

  // Auto remove after 5 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.remove();
    }, 400);
  }, 5000);
}

// Helper: Show specific sub-step in a panel
function showSubStep(viewElement, siblingElements) {
  siblingElements.forEach(el => el.classList.add('hidden'));
  viewElement.classList.remove('hidden');
}

// Helper: Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Initialize socket connection
function initSocket() {
  if (socket) return;
  
  socket = io();

  // Socket: Local client disconnected from server (Network drop)
  socket.on('disconnect', () => {
    console.warn('Socket disconnected from server.');
    if (currentRole === 'receiver' && document.getElementById('receive-step-negotiate').classList.contains('hidden') === false) {
      // If receiver was stuck waiting for approval or negotiating and lost connection
      resetTransferState();
      showNotification('Connection to server lost. Please try rejoining the room.', 'error');
      showPanel('dashboard');
    }
  });

  // Socket: Peer joined my room (I am the sender)
  socket.on('peer-connected', async ({ clientSocketId, receiverProfile }) => {
    console.log('Receiver joined room:', receiverProfile);
    
    const container = document.getElementById('active-receivers-container');
    if (container) {
      const card = document.createElement('div');
      card.className = 'receiver-active-card';
      card.id = `receiver-card-${clientSocketId}`;
      card.innerHTML = `
        <div class="receiver-profile-row">
          <img src="${receiverProfile.picture || 'https://via.placeholder.com/50'}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;">
          <div class="receiver-profile-info">
            <h4 style="margin:0;font-size:16px;">${receiverProfile.name}</h4>
            <p style="margin:0;font-size:12px;color:var(--text-muted);">${receiverProfile.email}</p>
          </div>
          <div class="receiver-download-status-badge" id="badge-${clientSocketId}">Connecting</div>
        </div>
      `;
      container.appendChild(card);
    }
    
    await initializeRtcConnection(true, clientSocketId);
  });

  // Socket: Peer join request (I am the sender, waiting for approval)
  socket.on('peer-join-request', ({ clientSocketId, receiverProfile }) => {
    console.log('Received join request from:', receiverProfile.name, clientSocketId);
    
    const container = document.getElementById('join-requests-container');
    if (!container) return;
    
    const card = document.createElement('div');
    card.id = `request-${clientSocketId}`;
    card.className = 'receiver-request-card';
    card.style = 'background: rgba(255,255,255,0.03); border: 1px solid rgba(0,0,0,0.06); border-radius: 16px; padding: 15px; text-align: center; display: flex; flex-direction: column; gap: 10px; align-items: center; width: 100%;';
    card.innerHTML = `
      <h4 style="font-size: 16px; font-weight: 700; margin: 0;">${receiverProfile.name}</h4>
      <p style="color: var(--text-secondary); font-size: 12px; margin: 0;">wants to join</p>
      <div style="display: flex; gap: 10px; width: 100%; margin-top: 5px;">
        <button class="btn btn-accent" style="flex: 1; color: #ffffff; padding: 8px;" onclick="socket.emit('approve-peer', { clientSocketId: '${clientSocketId}' }); this.parentElement.parentElement.remove();">Approve</button>
        <button class="btn btn-danger" style="flex: 1; color: #ffffff; padding: 8px;" onclick="socket.emit('reject-peer', { clientSocketId: '${clientSocketId}' }); this.parentElement.parentElement.remove();">Reject</button>
      </div>
    `;
    container.appendChild(card);
  });

  // Socket: Peer join request canceled (I am the sender, client disconnected)
  socket.on('peer-join-canceled', ({ clientSocketId }) => {
    console.log('Peer join request canceled by client:', clientSocketId);
    const card = document.getElementById(`request-${clientSocketId}`);
    if (card) {
      card.remove();
    }
    
    // Check if container is empty to show placeholder again
    const container = document.getElementById('join-requests-container');
    const actContainer = document.getElementById('active-receivers-container');
    if (container && container.children.length === 0 && actContainer && actContainer.children.length === 0) {
      document.getElementById('receiver-placeholder').classList.remove('hidden');
    }
  });

  // Socket: Join request approved by host (I am the receiver)
  socket.on('join-approved', async ({ roomId, senderProfile, roomName }) => {
    console.log('Join request approved by host. RoomID:', roomId);

    // Render sender profile details
    document.getElementById('sender-name').innerText = senderProfile.name;
    document.getElementById('sender-email').innerText = senderProfile.email;
    document.getElementById('sender-avatar').src = senderProfile.picture || 'https://via.placeholder.com/50';

    // Render Room Name if available
    const roomTitleCard = document.getElementById('receiver-room-title-card');
    const roomNameEl = document.getElementById('receiver-room-name');
    if (roomTitleCard && roomNameEl && roomName) {
      roomNameEl.innerText = roomName;
      roomTitleCard.style.display = 'block';
    } else if (roomTitleCard) {
      roomTitleCard.style.display = 'none';
    }

    // Unhide sender identity card and update status text
    document.getElementById('sender-identity-card').classList.remove('hidden');
    document.getElementById('receiver-connection-status').innerText = 'Approved! Establishing P2P negotiation...';

    // Negotiate parameters and transition step
    showSubStep(views.receiveNegotiate, [views.receivePin, views.receiveTransfer]);
  });

  // Socket: Join request rejected by host (I am the receiver)
  socket.on('join-rejected', ({ reason }) => {
    console.log('Join request rejected by host. Reason:', reason);
    resetTransferState();

    // Go back to input screen and render error message
    showSubStep(views.receivePin, [views.receiveNegotiate, views.receiveTransfer]);
    const errorMsgEl = document.getElementById('receive-error-msg');
    errorMsgEl.innerText = reason || 'Connection rejected by host.';
    errorMsgEl.classList.remove('hidden');

    // Reset PIN inputs
    pinBoxes.forEach(box => { box.value = ''; });
    pinBoxes[0].focus();
  });

  // Socket: Relay WebRTC signaling messages
  socket.on('signal', async ({ signalData }) => {
    let pc;
    if (currentRole === 'sender') {
      pc = peerConnections[signalData.target];
    } else {
      pc = peerConnection;
    }
    
    if (!pc) return;

    if (signalData.sdp) {
      if (signalData.sdp.type === 'offer') {
        if (!isRemoteDescSet) {
          await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
          isRemoteDescSet = true;
          
          while (iceQueue.length > 0) {
            await pc.addIceCandidate(iceQueue.shift());
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { pin: activePin, signalData: { sdp: answer } });
        }
      } else if (signalData.sdp.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
      }
    } else if (signalData.ice) {
      if (currentRole === 'sender' || isRemoteDescSet) {
        await pc.addIceCandidate(new RTCIceCandidate(signalData.ice));
      } else {
        iceQueue.push(new RTCIceCandidate(signalData.ice));
      }
    }
  });

  // Socket: Room expired
  socket.on('room-expired', () => {
    showNotification('The room has expired.', 'error');
    resetTransferState();
    showPanel('dashboard');
  });

  // Socket: Peer disconnected
  socket.on('peer-disconnected', ({ reason }) => {
    console.log('Peer disconnected:', reason);
    
    if (currentRole === 'sender') {
      // Check if download was already completed
      const pctEl = document.getElementById('receiver-download-pct');
      const isCompleted = pctEl && pctEl.innerText === '100%';

      // Clear WebRTC objects
      if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
      }
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
      receivedChunks = [];
      receivedSize = 0;
      
      // Stop transfer speed tracking
      stopSpeedTracker();
      
      // Reset UI elements on sender transfer view
      document.getElementById('send-progress-fill').style.width = '0%';
      document.getElementById('send-progress-pct').innerText = '0%';
      document.getElementById('send-transfer-speed').innerText = '0 KB/s';
      document.getElementById('send-time-remaining').innerText = 'Calculating...';
      document.getElementById('send-bytes-meta').innerText = '0 MB / 0 MB';
      
      // Reset connected peer details (instantly makes their profile disappear)
      document.getElementById('receiver-placeholder').classList.remove('hidden');
      const reqContainer = document.getElementById('join-requests-container');
      if (reqContainer) reqContainer.innerHTML = '';
      const actContainer = document.getElementById('active-receivers-container');
      if (actContainer) actContainer.innerHTML = '';
      
      // Reset cancel button text if it was modified
      const cancelBtn = document.getElementById('btn-cancel-send');
      if (cancelBtn) {
        cancelBtn.innerText = 'Cancel Transfer / Close Room';
        cancelBtn.className = 'btn btn-danger btn-block';
      }

      // Suppress alert dialog if receiver downloaded successfully and exited naturally
      if (!isCompleted) {
        console.log(`Receiver disconnected: ${reason}. Keeping room open.`);
      }
    } else {
      // Receiver side: exit to dashboard
      resetTransferState();
      showNotification(`Connection terminated: ${reason}`, 'error');
      showPanel('dashboard');
    }
  });
}

// Initialize WebRTC Peer Connection
async function initializeRtcConnection(isHost, clientId = null) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  
  if (isHost && clientId) {
    peerConnections[clientId] = pc;
  } else {
    peerConnection = pc;
  }

  pc.onsignalingstatechange = () => console.log('RTC Signaling:', pc.signalingState);
  pc.oniceconnectionstatechange = () => {
    console.log('RTC ICE:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      if (isHost && clientId) {
        delete peerConnections[clientId];
        delete dataChannels[clientId];
        const badge = document.getElementById(`badge-${clientId}`);
        if (badge) { badge.innerText = 'Disconnected'; badge.style.background = 'red'; }
      } else {
        resetTransferState();
        showPanel('dashboard');
      }
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { pin: activePin, signalData: { ice: event.candidate, target: clientId } });
    }
  };

  if (isHost) {
    const dc = pc.createDataChannel('fileTransfer', { ordered: true });
    dataChannels[clientId] = dc;
    setupDataChannelEvents(dc, clientId);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { pin: activePin, signalData: { sdp: offer, target: clientId } });
  } else {
    pc.ondatachannel = (event) => {
      dataChannel = event.channel;
      setupDataChannelEvents(dataChannel, null);
    };
  }
}

// Update UI text with actual WebRTC connection status properties for easy testing diagnostics
function updateRtcStatesLog() {
  if (!peerConnection) return;
  const stateStr = `(SDP: ${peerConnection.signalingState} | ICE: ${peerConnection.iceConnectionState} | ICEGather: ${peerConnection.iceGatheringState})`;
  
  if (currentRole === 'sender') {
    const el = document.getElementById('receiver-download-text');
    if (el) {
      el.innerText = `Establishing P2P link... ${stateStr}`;
    }
  } else {
    const el = document.getElementById('receiver-connection-status');
    if (el) {
      el.innerText = `Connecting to room... ${stateStr}`;
    }
  }
}

// Setup RTC Data Channel Listeners
let clientStreams = {}; // { clientId: { offset: 0, fileIndex: 0, reader: new FileReader() } }

function setupDataChannelEvents(dc, clientId) {
  if (!dc) return;

  dc.onopen = () => {
    console.log(`WebRTC P2P Data Channel Opened! Client: ${clientId || 'Host'}`);
    if (currentRole === 'sender' && clientId) {
      const badge = document.getElementById(`badge-${clientId}`);
      if (badge) {
        badge.innerText = 'Connected';
        badge.className = 'receiver-download-status-badge status-completed';
      }
      
      // Initialize stream state for this client
      clientStreams[clientId] = {
        offset: 0,
        fileIndex: 0
      };
      
      startStreamingForClient(clientId);
    }
  };

  dc.onclose = () => {
    console.log(`WebRTC Data Channel Closed. Client: ${clientId || 'Host'}`);
    if (currentRole === 'sender' && clientId) {
      delete clientStreams[clientId];
      const badge = document.getElementById(`badge-${clientId}`);
      if (badge) { badge.innerText = 'Disconnected'; badge.style.background = 'red'; }
    } else if (currentRole === 'receiver') {
      resetTransferState();
    }
  };

  dc.onerror = (err) => {
    console.error('Data Channel Error:', err);
  };

  // Receive packets
  dc.onmessage = (event) => {
    if (typeof event.data === 'string') {
      // JSON Metadata / Controls
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'metadata') {
          fileMetadata = message;
          receivedChunks = [];
          receivedSize = 0;
          
          document.getElementById('sender-meta-filename').innerText = `${fileMetadata.name} (${fileMetadata.fileIndex + 1}/${fileMetadata.totalFiles})`;
          document.getElementById('sender-meta-filesize').innerText = formatBytes(fileMetadata.size);
          document.getElementById('sender-identity-card').classList.remove('hidden');
          
          const transferTitle = document.querySelector('.transfer-title');
          if (transferTitle) {
            transferTitle.innerText = `Downloading (${fileMetadata.fileIndex + 1}/${fileMetadata.totalFiles}): ${fileMetadata.name}`;
          }

          showSubStep(views.receiveTransfer, [views.receivePin, views.receiveNegotiate]);
          transferStartTime = Date.now();
          if (!speedInterval) {
            startSpeedTracker('receiver');
          }
        } else if (message.type === 'complete') {
          finalizeReceivedFile();
        } else if (message.type === 'all-complete') {
          stopSpeedTracker();
          const recTime = document.getElementById('receive-time-remaining');
          if (recTime) recTime.innerText = 'Completed';
          const recSpeed = document.getElementById('receive-transfer-speed');
          if (recSpeed) recSpeed.innerText = '0 KB/s';
          
          const cancelBtn = document.getElementById('btn-cancel-receive');
          if (cancelBtn) {
            cancelBtn.innerText = 'Done (Exit Room)';
            cancelBtn.className = 'btn btn-accent btn-block';
          }
          
          const transferTitle = document.querySelector('.transfer-title');
          if (transferTitle) {
            transferTitle.innerText = 'All Transfers Completed!';
          }
        } else if (message.type === 'receiver-progress') {
          // Sender updates download progress of receiver
          if (currentRole === 'sender') {
             // For multiple receivers, we just update the global layout to show activity
             const stream = clientStreams[clientId];
             if (stream) {
               document.getElementById('receiver-download-pct').innerText = `${message.percentage}%`;
               document.getElementById('receiver-download-progress-fill').style.width = `${message.percentage}%`;
               document.getElementById('receiver-download-text').innerText = `Downloading file ${stream.fileIndex + 1}/${selectedFiles.length}...`;
             }
          }
        } else if (message.type === 'receiver-complete') {
          // Mark current file status as complete in sender list
          const stream = clientStreams[clientId];
          if (stream) {
            const statusEl = document.getElementById(`sender-file-status-${stream.fileIndex}`);
            if (statusEl) {
              statusEl.innerText = 'Sent';
              statusEl.className = 'file-item-status status-completed';
            }
            // Move to next file for this client
            stream.fileIndex++;
            startStreamingForClient(clientId);
          }
        }
      } catch (e) {
        console.error('Error parsing signaling message over data channel', e);
      }
    } else {
      // Binary chunk received (Receiver side)
      if (currentRole === 'receiver') {
        receivedChunks.push(event.data);
        receivedSize += event.data.byteLength;
        updateProgressBar('receiver', receivedSize, fileMetadata.size);
      }
    }
  };
}

// SENDER: Stream active queued file in chunks for a SPECIFIC client
function startStreamingForClient(clientId) {
  if (!selectedFiles || selectedFiles.length === 0) return;
  const dc = dataChannels[clientId];
  if (!dc || dc.readyState !== 'open') return;

  const stream = clientStreams[clientId];
  if (!stream) return;

  if (stream.fileIndex >= selectedFiles.length) {
    console.log(`Sender: Sent all files to client ${clientId}`);
    try {
      dc.send(JSON.stringify({ type: 'all-complete' }));
    } catch (e) {
      console.error('Failed to send final complete packet:', e);
    }
    
    // Set sender's final layout states (Will overwrite for multiple clients, but that's ok for MVP UI)
    const badge = document.getElementById('receiver-download-badge');
    badge.innerText = `Completed`;
    badge.className = 'receiver-download-status-badge status-completed';

    document.getElementById('receiver-download-pct').innerText = `100%`;
    document.getElementById('receiver-download-progress-fill').style.width = `100%`;
    document.getElementById('receiver-download-text').innerText = `Completed all downloads!`;
    
    const sendTime = document.getElementById('send-time-remaining');
    if (sendTime) sendTime.innerText = 'Completed';
    const sendSpeed = document.getElementById('send-transfer-speed');
    if (sendSpeed) sendSpeed.innerText = '0 KB/s';
    
    const cancelBtn = document.getElementById('btn-cancel-send');
    if (cancelBtn) {
      cancelBtn.innerText = 'Done (Close Room)';
      cancelBtn.className = 'btn btn-accent btn-block';
    }
    return;
  }

  const activeFile = selectedFiles[stream.fileIndex];
  console.log(`Sender: Streaming file ${stream.fileIndex + 1}/${selectedFiles.length}: ${activeFile.name} to ${clientId}`);

  // Mark status as active sending
  const statusEl = document.getElementById(`sender-file-status-${stream.fileIndex}`);
  if (statusEl) {
    statusEl.innerText = 'Sending...';
    statusEl.className = 'file-item-status status-active';
  }

  transferStartTime = Date.now();
  if (!speedInterval) {
    startSpeedTracker('sender');
  }

  // Send Metadata first
  dc.send(JSON.stringify({
    type: 'metadata',
    name: activeFile.name,
    size: activeFile.size,
    mime: activeFile.type,
    fileIndex: stream.fileIndex,
    totalFiles: selectedFiles.length,
    totalQueueSize: totalFilesSize
  }));

  stream.offset = 0;
  const fileReader = new FileReader();
  dc.bufferedAmountLowThreshold = CHUNK_SIZE * 4;

  const readNextChunk = () => {
    if (dc.readyState !== 'open') return;
    if (stream.offset >= activeFile.size) {
      dc.send(JSON.stringify({ type: 'complete', fileIndex: stream.fileIndex }));
      console.log(`Sender: Completed stream slice for ${activeFile.name} to ${clientId}`);
      
      // Keep local progress bar at 100%
      updateProgressBar('sender', activeFile.size, activeFile.size);
      return;
    }

    const slice = activeFile.slice(stream.offset, stream.offset + CHUNK_SIZE);
    fileReader.readAsArrayBuffer(slice);
  };

  fileReader.onload = (e) => {
    if (dc.readyState !== 'open') return;

    const buffer = e.target.result;
    dc.send(buffer);
    stream.offset += buffer.byteLength;
    
    // For MVP, just use this client's offset for the global progress bar
    senderOffset = stream.offset;
    updateProgressBar('sender', stream.offset, activeFile.size);

    if (stream.offset < activeFile.size) {
      if (dc.bufferedAmount > BUFFER_THRESHOLD) {
        dc.onbufferedamountlow = () => {
          dc.onbufferedamountlow = null;
          readNextChunk();
        };
      } else {
        setTimeout(readNextChunk, 1);
      }
    } else {
      readNextChunk();
    }
  };

  readNextChunk();
};

// RECEIVER: Combine binary chunks and download
function finalizeReceivedFile() {
  if (!fileMetadata || receivedChunks.length === 0) return;

  // Send receiver-complete message back to sender before downloading
  if (dataChannel && dataChannel.readyState === 'open') {
    try {
      dataChannel.send(JSON.stringify({ type: 'receiver-complete' }));
    } catch (e) {
      console.error('Could not send completion message:', e);
    }
  }
  
  // Merge chunks into one Blob and download
  const fileBlob = new Blob(receivedChunks, { type: fileMetadata.mime });
  const downloadUrl = URL.createObjectURL(fileBlob);
  
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = fileMetadata.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  
  URL.revokeObjectURL(downloadUrl);
  
  // Increment completed files count receiver-side
  completedFilesBytes += fileMetadata.size;
}

// Progress Bar & Stats Updates
function updateProgressBar(role, currentBytes, totalBytes) {
  const pct = Math.min(100, Math.floor((currentBytes / totalBytes) * 100));
  const rolePrefix = role === 'sender' ? 'send' : 'receive';
  const fillElement = document.getElementById(`${rolePrefix}-progress-fill`);
  const pctElement = document.getElementById(`${rolePrefix}-progress-pct`);
  const bytesElement = document.getElementById(`${rolePrefix}-bytes-meta`);

  if (fillElement) fillElement.style.width = `${pct}%`;
  if (pctElement) pctElement.innerText = `${pct}%`;
  
  // Render overall bytes transferred out of total queue size
  const totalQueue = role === 'sender' ? totalFilesSize : (fileMetadata ? fileMetadata.totalQueueSize : totalBytes);
  if (bytesElement) {
    bytesElement.innerText = `${formatBytes(completedFilesBytes + currentBytes)} / ${formatBytes(totalQueue)}`;
  }
}

// Track Transfer Speed & Estimations
function startSpeedTracker(role) {
  let prevBytes = 0;
  const rolePrefix = role === 'sender' ? 'send' : 'receive';
  
  speedInterval = setInterval(() => {
    if (!transferStartTime) return;
    
    const currentBytes = (role === 'sender') ? 
      (peerConnection && dataChannel && selectedFiles.length > 0 ? getSenderOffset() : 0) : 
      receivedSize;
    
    // Total transferred bytes including completed files
    const totalTransferred = completedFilesBytes + currentBytes;
    const elapsedSeconds = (Date.now() - transferStartTime) / 1000;
    if (elapsedSeconds <= 0) return;

    // Calculate current speed based on total transferred bytes
    const bytesTransferredSinceLast = totalTransferred - prevBytes;
    prevBytes = totalTransferred;
    
    const speed = bytesTransferredSinceLast;
    const speedEl = document.getElementById(`${rolePrefix}-transfer-speed`);
    if (speedEl) speedEl.innerText = `${formatBytes(speed)}/s`;

    // Estimate remaining time for overall queue
    const totalQueue = role === 'sender' ? totalFilesSize : (fileMetadata ? fileMetadata.totalQueueSize : currentBytes);
    const remainingBytes = totalQueue - totalTransferred;
    const timeEl = document.getElementById(`${rolePrefix}-time-remaining`);
    if (timeEl) {
      if (speed > 0) {
        const remainingSeconds = Math.max(0, Math.ceil(remainingBytes / speed));
        const m = Math.floor(remainingSeconds / 60);
        const s = remainingSeconds % 60;
        timeEl.innerText = m > 0 ? `${m}m ${s}s` : `${s}s`;
      } else {
        timeEl.innerText = 'Stalled';
      }
    }
  }, 1000);
}

function stopSpeedTracker() {
  if (speedInterval) {
    clearInterval(speedInterval);
    speedInterval = null;
  }
}

// Helper to estimate sender offset
function getSenderOffset() {
  return senderOffset;
}

// Reset connections and speeds
function resetTransferState() {
  window.appIsActiveSession = false;
  stopSpeedTracker();

  // Reset pending state references
  pendingClientSocketId = null;
  const reqCard = document.getElementById('receiver-request-card');
  if (reqCard) reqCard.classList.add('hidden');

  // Notify signaling server that we are leaving the room before closing connection
  if (socket && activePin) {
    socket.emit('leave-room');
  }

  // Reset ICE queues
  iceQueue = [];
  isRemoteDescSet = false;

  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  const label = document.getElementById('dash-countdown-val');
  if (label) label.innerText = '01:00';

  const cancelBtn = document.getElementById('btn-cancel-send');
  if (cancelBtn) {
    cancelBtn.innerText = 'Cancel Transfer / Close Room';
    cancelBtn.className = 'btn btn-danger btn-block';
  }

  const cancelReceiveBtn = document.getElementById('btn-cancel-receive');
  if (cancelReceiveBtn) {
    cancelReceiveBtn.innerText = 'Cancel Transfer';
    cancelReceiveBtn.className = 'btn btn-danger btn-block';
  }

  // Reset Receiver UI progress stats
  const recProgressFill = document.getElementById('receive-progress-fill');
  if (recProgressFill) recProgressFill.style.width = '0%';
  
  const recProgressPct = document.getElementById('receive-progress-pct');
  if (recProgressPct) recProgressPct.innerText = '0%';
  
  const recSpeed = document.getElementById('receive-transfer-speed');
  if (recSpeed) recSpeed.innerText = '0 KB/s';
  
  const recTime = document.getElementById('receive-time-remaining');
  if (recTime) recTime.innerText = 'Calculating...';
  
  const recBytes = document.getElementById('receive-bytes-meta');
  if (recBytes) recBytes.innerText = '0 MB / 0 MB';
  
  const recStatus = document.getElementById('receiver-connection-status');
  if (recStatus) recStatus.innerText = 'Connecting to room...';
  
  if (dataChannel) {
    try {
      dataChannel.close();
    } catch (e) {}
    dataChannel = null;
  }
  
  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (e) {}
    peerConnection = null;
  }

  receivedChunks = [];
  receivedSize = 0;
  fileMetadata = null;
  selectedFile = null;
  selectedFiles = [];
  currentFileIndex = 0;
  completedFilesBytes = 0;
  totalFilesSize = 0;
  activePin = null;

  // Clear receiver lobbies list polling
  if (lobbiesInterval) {
    clearInterval(lobbiesInterval);
    lobbiesInterval = null;
  }

  // Reset file input and selection card state
  const fileInputEl = document.getElementById('file-input');
  if (fileInputEl) fileInputEl.value = '';
  const detailsEl = document.getElementById('file-details-card');
  if (detailsEl) detailsEl.classList.add('hidden');
  const layoutEl = document.getElementById('select-step-layout');
  if (layoutEl) layoutEl.classList.remove('files-selected');

  // Reset sender/receiver sub-step views to initial states to prevent page collisions
  if (views.sendSelect) views.sendSelect.classList.remove('hidden');
  if (views.sendSettings) views.sendSettings.classList.add('hidden');
  if (views.sendDashboard) views.sendDashboard.classList.add('hidden');
  if (views.receivePin) views.receivePin.classList.remove('hidden');
  if (views.receiveNegotiate) views.receiveNegotiate.classList.add('hidden');
  if (views.receiveTransfer) views.receiveTransfer.classList.add('hidden');

  // Reset receiver nickname field
  const nicknameEl = document.getElementById('receiver-nickname');
  const nicknameContainer = document.querySelector('.nickname-container');
  if (nicknameEl) {
    nicknameEl.value = currentUser ? currentUser.name : '';
    nicknameEl.style.borderColor = 'rgba(0, 0, 0, 0.1)';
  }
  if (nicknameContainer) {
    nicknameContainer.style.display = currentUser ? 'none' : 'flex';
  }

  // Reset room configuration settings inputs
  const configNameEl = document.getElementById('setting-room-name');
  if (configNameEl) configNameEl.value = '';
  
  const configPersonEl = document.getElementById('setting-person-limit');
  if (configPersonEl) configPersonEl.value = '2';
  
  const configExpiryEl = document.getElementById('setting-expiry-limit');
  if (configExpiryEl) configExpiryEl.value = '1';

  // Hide room headers on host dashboard
  const roomTitleEl = document.getElementById('dash-room-title');
  if (roomTitleEl) {
    roomTitleEl.innerText = '';
    roomTitleEl.style.display = 'none';
  }

  const peerCountEl = document.getElementById('dash-peer-count');
  if (peerCountEl) {
    peerCountEl.innerText = '';
  }

  // Revert emerald receiver or red sender theme to default indigo theme
  document.body.classList.remove('receiver-active', 'sender-active');
}

// Start client-side countdown timer based on expiry minutes
function startCountdownTimer(expiryMinutes) {
  const label = document.getElementById('dash-countdown-val');
  if (countdownInterval) clearInterval(countdownInterval);

  if (expiryMinutes === 9999) {
    if (label) label.innerHTML = '<span style="font-size: 24px;">&infin;</span>';
    return; // Do not set an interval
  }

  let timeLeft = (expiryMinutes || 1) * 60; // minutes to seconds
  if (label) {
    label.innerText = `${(expiryMinutes || 1).toString().padStart(2, '0')}:00`;
  }

  countdownInterval = setInterval(() => {
    timeLeft--;
    if (timeLeft <= 0) {
      clearInterval(countdownInterval);
      showNotification(`The room has expired (${expiryMinutes || 1}-minute limit reached).`, 'error');
      resetTransferState();
      showPanel('dashboard');
    } else {
      const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
      const s = (timeLeft % 60).toString().padStart(2, '0');
      if (label) label.innerText = `${m}:${s}`;
    }
  }, 1000);
}

// Google Auth Flow
function handleGoogleLoginSuccess(profile) {
  currentUser = profile;
  
  // Persist user profile session for page reload resilience
  localStorage.setItem('currentUser', JSON.stringify(profile));
  
  // Render user profile details
  const nameEl = document.getElementById('user-name');
  const emailEl = document.getElementById('user-email');
  const avatarEl = document.getElementById('user-avatar');
  if (nameEl) nameEl.innerText = profile.name;
  if (emailEl) emailEl.innerText = profile.email;
  if (avatarEl) avatarEl.src = profile.picture || 'https://via.placeholder.com/32';
  
  const userHeader = document.getElementById('user-header');
  if (userHeader) userHeader.classList.remove('hidden');
  
  // Activate sliding logo animation on header
  const header = document.querySelector('.app-header');
  if (header) header.classList.add('active-mode');

  // Update dashboard card auth states
  const authContainer = document.getElementById('dash-auth-container');
  if (authContainer) authContainer.classList.add('hidden');
  
  const startSendBtn = document.getElementById('btn-start-sending-dash');
  if (startSendBtn) startSendBtn.classList.remove('hidden');
  
  const cardDesc = document.getElementById('send-card-desc');
  if (cardDesc) cardDesc.innerText = 'Select files and get a temporary 6-digit PIN to establish a direct WebRTC pipeline.';
  
  const receiveCardDesc = document.getElementById('receive-card-desc');
  if (receiveCardDesc) receiveCardDesc.innerText = 'Enter a 6-digit room PIN to securely download files using your Google identity.';
  
  // Init websockets connection
  initSocket();
}

let lobbiesInterval = null;

// Fetch and render the active rooms list for the receiver
async function fetchActiveLobbies() {
  try {
    const res = await fetch('/active-rooms');
    const data = await res.json();
    if (data && data.success) {
      renderLobbiesList(data.rooms, data.roomsCount);
    }
  } catch (err) {
    console.error('Error fetching active lobbies:', err);
  }
}

function renderLobbiesList(rooms, count) {
  const onlineCountEl = document.getElementById('lobbies-online-count');
  if (onlineCountEl) {
    onlineCountEl.innerText = `Active Lobbies (${count} Online)`;
  }
  
  const listEl = document.getElementById('active-lobbies-list');
  if (!listEl) return;
  
  if (count === 0) {
    listEl.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 13px; padding: 20px 10px;">No active lobbies nearby. Ask a sender to open a room.</div>`;
    return;
  }
  
  listEl.innerHTML = '';
  rooms.forEach(room => {
    const isFull = room.clientsCount >= (room.personLimit - 1);
    
    const item = document.createElement('div');
    item.className = `lobby-item ${isFull ? 'full' : ''}`;
    
    const avatarHtml = room.hostPicture 
      ? `<img src="${room.hostPicture}" class="lobby-avatar" style="object-fit: cover;">`
      : `<div class="lobby-avatar">🎮</div>`;
      
    const badgeHtml = isFull 
      ? `<span class="lobby-badge badge-full">Full</span>`
      : `<span class="lobby-badge badge-private">🔒 Private</span>`;
      
    item.innerHTML = `
      ${avatarHtml}
      <div class="lobby-details">
        <span class="lobby-name">${escapeHtmlLobby(room.roomName)}</span>
        <span class="lobby-host">Host: ${escapeHtmlLobby(room.hostName)}</span>
      </div>
      ${badgeHtml}
    `;
    
    if (window.selectedLobbyRoomName && window.selectedLobbyRoomName === room.roomName) {
      item.classList.add('selected');
    }
    
    if (!isFull) {
      item.onclick = () => {
        // Deselect all items
        document.querySelectorAll('.lobby-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        window.selectedLobbyRoomName = room.roomName; // Remember selection
        
        // Focus PIN inputs or Name
        const firstInput = document.querySelector('.pin-box');
        if (firstInput) firstInput.focus();
      };
    }
    
    listEl.appendChild(item);
  });
}

function escapeHtmlLobby(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Automatically fetch configuration and initialize Google Identity Services
async function loadGoogleSignInConfig() {
  try {
    const res = await fetch('/config');
    const config = await res.json();
    if (config && config.googleClientId) {
      initGoogleSignIn(config.googleClientId);
    }
  } catch (err) {
    console.error('Error fetching Google Sign-In config:', err);
  }
}

let googleInitRetries = 0;
let tokenClient = null;

function initGoogleSignIn(clientId) {
  // If Google Identity Services SDK hasn't loaded yet, retry up to 5 seconds
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
    if (googleInitRetries < 50) {
      googleInitRetries++;
      setTimeout(() => initGoogleSignIn(clientId), 100);
    } else {
      console.error('Google Sign-In SDK failed to load after 5 seconds.');
      showAuthError('Failed to load Google Sign-In. Please check your internet connection or disable your adblocker.');
    }
    return;
  }

  try {
    showAuthError(null); // Clear loading / error messages

    // Initialize the token client using oauth2 client authorization flow
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
      callback: async (tokenResponse) => {
        if (tokenResponse && tokenResponse.access_token) {
          try {
            // Fetch user profile from the standard Google OAuth API using the access token
            const res = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${tokenResponse.access_token}`);
            const user = await res.json();
            if (user) {
              handleGoogleLoginSuccess({
                name: user.name,
                email: user.email,
                picture: user.picture
              });
            } else {
              showAuthError('Failed to retrieve user profile data.');
            }
          } catch (err) {
            console.error('Error fetching Google profile:', err);
            showAuthError('Error fetching your Google profile details.');
          }
        } else {
          showAuthError('Authorization failed or was cancelled.');
        }
      }
    });

    // Bind click event to our custom HTML login button
    const googleLoginBtn = document.getElementById('btn-google-login');
    if (googleLoginBtn) {
      googleLoginBtn.onclick = (e) => {
        e.stopPropagation();
        if (tokenClient) {
          tokenClient.requestAccessToken();
        } else {
          showAuthError('Google Client is not ready.');
        }
      };
    }
  } catch (err) {
    console.error('Error initializing Google token client:', err);
    showAuthError('Could not initialize Google Identity Services.');
  }
}

// Inline Auth panel warning rendering
function showAuthError(message) {
  const errEl = document.getElementById('auth-error-msg');
  if (errEl) {
    if (message) {
      errEl.innerText = message;
      errEl.classList.remove('hidden');
    } else {
      errEl.classList.add('hidden');
    }
  }
}

// Decodes standard JWT tokens on client-side
function decodeJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
  } catch (e) {
    console.error('JWT Decode Exception:', e);
    return null;
  }
}

let confirmResolve = null;

function showCustomConfirm(title, message) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    
    const modalTitleEl = document.querySelector('#confirm-modal h3');
    const modalTextEl = document.querySelector('#confirm-modal p');
    if (modalTitleEl) modalTitleEl.innerText = title || 'Close Transfer Room?';
    if (modalTextEl) modalTextEl.innerText = message || 'Are you sure you want to close this room?';
    
    const modal = document.getElementById('confirm-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.offsetHeight; // trigger reflow
      modal.classList.add('show');
    } else {
      resolve(confirm(message));
    }
  });
}

function hideCustomConfirm(value) {
  const modal = document.getElementById('confirm-modal');
  if (modal) {
    modal.classList.remove('show');
    setTimeout(() => {
      modal.classList.add('hidden');
      if (confirmResolve) {
        confirmResolve(value);
        confirmResolve = null;
      }
    }, 300);
  } else {
    if (confirmResolve) {
      confirmResolve(value);
      confirmResolve = null;
    }
  }
}

// Bind modal action buttons
const btnModalOk = document.getElementById('btn-confirm-modal-ok');
if (btnModalOk) {
  btnModalOk.addEventListener('click', () => {
    hideCustomConfirm(true);
  });
}

const btnModalCancel = document.getElementById('btn-confirm-modal-cancel');
if (btnModalCancel) {
  btnModalCancel.addEventListener('click', () => {
    hideCustomConfirm(false);
  });
}

// Sign Out Handler
document.getElementById('btn-signout').addEventListener('click', async () => {
  if (currentRole === 'sender' && activePin) {
    const isConfirmed = await showCustomConfirm(
      "Sign Out?",
      "You have an active transfer room. Are you sure you want to sign out and close it?"
    );
    if (!isConfirmed) return;
  }
  currentUser = null;
  localStorage.removeItem('currentUser'); // Clear persisted session
  
  const userHeader = document.getElementById('user-header');
  if (userHeader) userHeader.classList.add('hidden');
  
  // Reset sliding logo animation on header
  const header = document.querySelector('.app-header');
  if (header) header.classList.remove('active-mode');

  // Reset dashboard card auth states
  const authContainer = document.getElementById('dash-auth-container');
  if (authContainer) authContainer.classList.remove('hidden');
  
  const startSendBtn = document.getElementById('btn-start-sending-dash');
  if (startSendBtn) startSendBtn.classList.add('hidden');
  
  const cardDesc = document.getElementById('send-card-desc');
  if (cardDesc) cardDesc.innerText = 'Authenticate with Google to securely host a direct P2P transfer session.';

  const receiveCardDesc = document.getElementById('receive-card-desc');
  if (receiveCardDesc) receiveCardDesc.innerText = 'Connect as a guest to instantly download files via a 6-digit room PIN.';

  resetTransferState();
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  showPanel('dashboard');
});

// NAVIGATION: Main Dashboard Selectors
document.getElementById('card-trigger-send').addEventListener('click', (e) => {
  // If they click on authentication widgets inside the card, ignore
  if (e.target.closest('#dash-auth-container') || e.target.closest('.btn-google') || e.target.closest('.oauth-config-input')) {
    return;
  }
  
  if (!currentUser) {
    showNotification('Please log in with Google to send files.', 'info');
    return;
  }
  
  currentRole = 'sender';
  showPanel('sender');
  showSubStep(views.sendSelect, [views.sendSettings, views.sendDashboard]);
});

// Button listener for Start Sending when already logged in
const btnStartSendingDash = document.getElementById('btn-start-sending-dash');
if (btnStartSendingDash) {
  btnStartSendingDash.addEventListener('click', (e) => {
    e.stopPropagation();
    currentRole = 'sender';
    showPanel('sender');
    showSubStep(views.sendSelect, [views.sendSettings, views.sendDashboard]);
  });
}

// Receive handler wrapper
const startReceiveHandler = (e) => {
  if (e) e.stopPropagation();
  currentRole = 'receiver';
  document.body.classList.add('receiver-active');
  showPanel('receiver');
  showSubStep(views.receivePin, [views.receiveNegotiate, views.receiveTransfer]);
  
  // Initialize socket connection for receiver if not already connected
  initSocket();

  // Fetch active lobbies list immediately on load, and start polling every 5 seconds
  fetchActiveLobbies();
  if (lobbiesInterval) clearInterval(lobbiesInterval);
  lobbiesInterval = setInterval(fetchActiveLobbies, 5000);
  
  // Pre-fill and hide nickname input if user is authenticated with Google
  const nicknameContainer = document.querySelector('.nickname-container');
  const nicknameEl = document.getElementById('receiver-nickname');
  if (currentUser) {
    if (nicknameEl) nicknameEl.value = currentUser.name;
    if (nicknameContainer) nicknameContainer.style.display = 'none';
  } else {
    if (nicknameEl) nicknameEl.value = '';
    if (nicknameContainer) nicknameContainer.style.display = 'flex';
  }
  
  // Focus first input box
  setTimeout(() => {
    const firstInput = document.querySelector('.pin-box');
    if (firstInput) firstInput.focus();
  }, 100);
};

document.getElementById('card-trigger-receive').addEventListener('click', startReceiveHandler);

const btnStartReceivingDash = document.getElementById('btn-start-receiving-dash');
if (btnStartReceivingDash) {
  btnStartReceivingDash.addEventListener('click', startReceiveHandler);
}

// Back buttons
document.getElementById('btn-back-send').addEventListener('click', async () => {
  if (currentRole === 'sender' && activePin) {
    const isConfirmed = await showCustomConfirm(
      "Close Transfer Room?",
      "Are you sure you want to close this room? All active transfers will be terminated."
    );
    if (!isConfirmed) return;
  }
  resetTransferState();
  showPanel('dashboard');
});

document.getElementById('btn-back-receive').addEventListener('click', () => {
  resetTransferState();
  showPanel('dashboard');
});

// Cancel transfer buttons
document.getElementById('btn-cancel-send').addEventListener('click', async () => {
  if (currentRole === 'sender' && activePin) {
    const isConfirmed = await showCustomConfirm(
      "Close Transfer Room?",
      "Are you sure you want to close this room? All active transfers will be terminated."
    );
    if (!isConfirmed) return;
  }
  resetTransferState();
  showPanel('dashboard');
});

document.getElementById('btn-cancel-receive').addEventListener('click', () => {
  resetTransferState();
  showPanel('dashboard');
});

// FILE DRAG & DROP SELECTION
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    handleFileSelected(e.dataTransfer.files);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFileSelected(e.target.files);
  }
});

function handleFileSelected(files) {
  const newFiles = Array.from(files);
  // Append new files to selection queue
  selectedFiles = selectedFiles.concat(newFiles);
  if (selectedFiles.length === 0) return;

  renderPreviewList();
}

function renderPreviewList() {
  const listContainer = document.getElementById('selected-files-list');
  const detailsCard = document.getElementById('file-details-card');
  const layoutEl = document.getElementById('select-step-layout');

  if (selectedFiles.length === 0) {
    if (layoutEl) layoutEl.classList.remove('files-selected');
    if (detailsCard) detailsCard.classList.add('hidden');
    const fileInputEl = document.getElementById('file-input');
    if (fileInputEl) fileInputEl.value = '';
    selectedFile = null;
    return;
  }

  if (layoutEl) layoutEl.classList.add('files-selected');
  if (detailsCard) detailsCard.classList.remove('hidden');

  if (listContainer) {
    listContainer.innerHTML = '';
    selectedFiles.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'file-item-row';
      item.id = `selected-file-row-${index}`;
      item.innerHTML = `
        <span class="file-item-icon">📄</span>
        <div class="file-item-info">
          <span class="file-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span class="file-item-size">${formatBytes(file.size)}</span>
        </div>
        <button class="btn-remove-file" data-index="${index}" title="Remove file">×</button>
      `;
      listContainer.appendChild(item);
    });

    // Bind remove button listeners
    const removeButtons = listContainer.querySelectorAll('.btn-remove-file');
    removeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-index'));
        selectedFiles.splice(idx, 1);
        renderPreviewList();
      });
    });
  }

  // Set fallback compatibility selectedFile for STUN setup references
  selectedFile = selectedFiles[0];
}

// Render dynamic dashboard list of sharing files
function renderDashboardFilesList() {
  const listContainer = document.getElementById('dash-files-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';
  selectedFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-item-row';
    item.id = `sender-file-row-${index}`;
    item.innerHTML = `
      <span class="file-item-icon">📄</span>
      <div class="file-item-info">
        <span class="file-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
        <span class="file-item-size">${formatBytes(file.size)}</span>
      </div>
      <span class="file-item-status" id="sender-file-status-${index}">Waiting</span>
    `;
    listContainer.appendChild(item);
  });
}


// SENDER: Go to Room Settings configuration panel
document.getElementById('btn-generate-pin').addEventListener('click', () => {
  if (selectedFiles.length === 0) return;
  document.body.classList.add('sender-active');
  showSubStep(views.sendSettings, [views.sendSelect, views.sendDashboard]);
});

// SENDER: Go back from settings to file selection
document.getElementById('btn-back-to-select').addEventListener('click', () => {
  document.body.classList.remove('sender-active');
  showSubStep(views.sendSelect, [views.sendSettings, views.sendDashboard]);
});

// SENDER: Confirm Settings, Generate PIN, and Open Room
document.getElementById('btn-confirm-room').addEventListener('click', () => {
  if (selectedFiles.length === 0) return;

  // Collect settings
  const roomName = document.getElementById('setting-room-name').value.trim();
  const personLimit = parseInt(document.getElementById('setting-person-limit').value) || 2;
  const expiryLimit = parseInt(document.getElementById('setting-expiry-limit').value) || 1;
  const customPin = document.getElementById('setting-custom-pin').value.trim().toUpperCase();
  const visibility = document.getElementById('setting-visibility').value;

  const settings = {
    roomName,
    personLimit,
    expiryLimit,
    customPin,
    visibility
  };

  socket.emit('create-room', { senderProfile: currentUser, settings }, (response) => {
    try {
      if (response.success) {
        activePin = response.pin;
        currentFileIndex = 0;
        completedFilesBytes = 0;
        senderOffset = 0;
        
        // Calculate total queue size
        totalFilesSize = selectedFiles.reduce((acc, file) => acc + file.size, 0);

        // Update Room Name on Host Dashboard
        const roomTitleEl = document.getElementById('dash-room-title');
        if (roomTitleEl) {
          roomTitleEl.innerText = `Lobby: ${response.roomName}`;
          roomTitleEl.style.display = 'block';
          window.appIsActiveSession = true;
          SoundEngine.playSuccess();
        }

        // Update Person Limit on Host Dashboard
        const peerCountEl = document.getElementById('dash-peer-count');
        if (peerCountEl) {
          peerCountEl.innerText = `(0/${response.personLimit - 1} connected)`;
        }

        // Update UI elements in Sender Dashboard
        document.getElementById('dash-pin-code').innerText = activePin;
        renderDashboardFilesList();
        
        // Reset upload progress values
        document.getElementById('send-progress-fill').style.width = '0%';
        document.getElementById('send-progress-pct').innerText = '0%';
        document.getElementById('send-transfer-speed').innerText = '0 KB/s';
        document.getElementById('send-bytes-meta').innerText = `0 Bytes / ${formatBytes(totalFilesSize)}`;
        document.getElementById('send-time-remaining').innerText = 'Calculating...';
        
        // Reset connected peer card to waiting state
        document.getElementById('receiver-placeholder').classList.remove('hidden');
        const reqContainer = document.getElementById('join-requests-container');
        if (reqContainer) reqContainer.innerHTML = '';
        const actContainer = document.getElementById('active-receivers-container');
        if (actContainer) actContainer.innerHTML = '';
        
        showSubStep(views.sendDashboard, [views.sendSelect, views.sendSettings]);
        document.body.classList.remove('receiver-active');
        
        // Start the countdown timer for the room session based on expiry setting
        startCountdownTimer(response.expiryLimit);
      } else {
        console.error('Failed to create transfer room:', response.error);
        alert('Failed to create room: ' + response.error);
      }
    } catch (err) {
      console.error(err);
      alert('Error transitioning to dashboard: ' + err.message + '\\n' + err.stack);
    }
  });
});

// RECEIVER: PIN Entry inputs focus navigation
const pinBoxes = document.querySelectorAll('.pin-box');
pinBoxes.forEach((box, idx) => {
  box.addEventListener('input', (e) => {
    // Only allow numbers
    box.value = box.value.replace(/[^0-9]/g, '');
    
    if (box.value.length === 1 && idx < pinBoxes.length - 1) {
      pinBoxes[idx + 1].focus();
    }
  });

  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && box.value.length === 0 && idx > 0) {
      pinBoxes[idx - 1].focus();
    }
  });
});

// RECEIVER: Handle Submit PIN Connect
document.getElementById('btn-connect-pin').addEventListener('click', async () => {
  // Collect 6-digit PIN
  let pin = '';
  pinBoxes.forEach(box => { pin += box.value; });

  const errorMsgEl = document.getElementById('receive-error-msg');
  errorMsgEl.classList.add('hidden');

  if (pin.length !== 6) {
    errorMsgEl.innerText = 'Please fill out the full 6-digit PIN code.';
    errorMsgEl.classList.remove('hidden');
    return;
  }

  const nicknameEl = document.getElementById('receiver-nickname');
  const nickname = nicknameEl ? nicknameEl.value.trim() : '';
  if (!nickname) {
    if (nicknameEl) {
      nicknameEl.style.borderColor = 'var(--danger-color)';
      nicknameEl.focus();
    }
    errorMsgEl.innerText = 'Please enter your name to connect.';
    errorMsgEl.classList.remove('hidden');
    return;
  } else {
    if (nicknameEl) {
      nicknameEl.style.borderColor = 'rgba(0, 0, 0, 0.1)';
    }
  }

  activePin = pin;
  document.getElementById('receiver-connection-status').innerText = 'Pre-initializing WebRTC...';
  showSubStep(views.receiveNegotiate, [views.receivePin, views.receiveTransfer]);
  document.body.classList.add('receiver-active');

  // Pre-initialize WebRTC connection to avoid signaling race conditions
  try {
    await initializeRtcConnection(false);
  } catch (err) {
    console.error('Error initializing RTC connection:', err);
    errorMsgEl.innerText = 'Failed to initialize WebRTC subsystem.';
    errorMsgEl.classList.remove('hidden');
    showSubStep(views.receivePin, [views.receiveNegotiate, views.receiveTransfer]);
    return;
  }

  document.getElementById('receiver-connection-status').innerText = 'Sending join request to host...';

  // Request room join on socket.io signaling backend
  const receiverProfile = currentUser ? {
    name: currentUser.name,
    email: currentUser.email,
    picture: currentUser.picture
  } : {
    name: nickname,
    email: 'Guest Link',
    picture: null
  };

  socket.emit('join-room', { pin, receiverProfile }, (response) => {
    if (response.success) {
      if (response.status === 'waiting_approval') {
        console.log('Join request sent, waiting for host approval...');
        window.appIsActiveSession = true;
        SoundEngine.playSuccess();
        const statusText = response.roomName 
          ? `Waiting for host of "${response.roomName}" to approve connection...` 
          : 'Waiting for room host to approve connection...';
        document.getElementById('receiver-connection-status').innerText = statusText;
      }
    } else {
      // If joining fails, reset RTC objects
      resetTransferState();

      // Go back to input screen and render error message
      showSubStep(views.receivePin, [views.receiveNegotiate, views.receiveTransfer]);
      errorMsgEl.innerText = response.error || 'Connection failed.';
      errorMsgEl.classList.remove('hidden');
      
      // Reset PIN inputs
      pinBoxes.forEach(box => { box.value = ''; });
      pinBoxes[0].focus();
    }
  });
});

// HTML escaping helper
function escapeHtml(str) {
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Automatically establish socket connection on page load
initSocket();

// Automatically load Google Sign-In SDK configuration on page load
loadGoogleSignInConfig();

// Automatically restore user login session from localStorage on page load
const savedUser = localStorage.getItem('currentUser');
if (savedUser) {
  try {
    const profile = JSON.parse(savedUser);
    handleGoogleLoginSuccess(profile);
  } catch (err) {
    console.error('Error restoring session from localStorage:', err);
    localStorage.removeItem('currentUser');
  }
}

// -------------------------------------------------------------
// Theme Toggle Logic