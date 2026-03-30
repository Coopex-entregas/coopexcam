(() => {
  const root = document.querySelector('[data-join-token]');
  if (!root) return;

  const role = root.dataset.role;
  const joinToken = root.dataset.joinToken;
  const roomCode = root.dataset.roomCode;
  const socket = io({
    transports: ['websocket', 'polling'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 1000,
  });

  const peers = {};
  const remoteStreams = {};
  let myId = Number(root.dataset.participantId || 0);
  let localStream = null;
  let currentState = window.__INITIAL_STATE__ || { room: {}, participants: [] };
  let micEnabled = true;
  let camEnabled = true;
  let galleryPinned = false;

  const selectedVideo = document.getElementById('selectedVideo');
  const stageEmpty = document.getElementById('stageEmpty');
  const videoGrid = document.getElementById('videoGrid');
  const participantsList = document.getElementById('participantsList');
  const voteBox = document.getElementById('voteBox');
  const summaryView = document.getElementById('summaryView');
  const decisionsView = document.getElementById('decisionsView');

  function safePlay(video) {
    if (!video) return;
    const p = video.play?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  function api(url, method = 'POST', body = null) {
    return fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : null
    }).then(async r => {
      let data = {};
      try { data = await r.json(); } catch (e) {}
      if (!r.ok) throw new Error(data.message || 'Falha na operação');
      return data;
    }).catch(err => {
      console.error(err);
      alert(err.message || 'Erro');
      throw err;
    });
  }

  async function startMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      attachTile({ id: myId || -1, name: 'Você', stream: localStream, isLocal: true });
      promoteStream(localStream, 'Você', true);
      setupAudioLevel(localStream);
      return true;
    } catch (e) {
      console.error(e);
      if (stageEmpty) stageEmpty.textContent = 'Permita câmera e microfone';
      return false;
    }
  }

  function attachTile({ id, name, stream, isLocal = false }) {
    if (!videoGrid) return;
    let tile = document.querySelector(`.video-tile[data-id="${id}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.dataset.id = id;
      tile.innerHTML = `<video autoplay playsinline></video><div class="video-name"></div>`;
      tile.addEventListener('click', () => {
        galleryPinned = true;
        promoteStream(stream, name, !!isLocal);
        markSelected(id);
      });
      videoGrid.appendChild(tile);
    }
    const video = tile.querySelector('video');
    video.srcObject = stream;
    video.muted = !!isLocal;
    tile.querySelector('.video-name').textContent = name;
    safePlay(video);
  }

  function removeTile(id) {
    document.querySelector(`.video-tile[data-id="${id}"]`)?.remove();
    delete remoteStreams[id];
    if (peers[id]) {
      try { peers[id].close(); } catch (e) {}
      delete peers[id];
    }
  }

  function promoteStream(stream, label, muted = false) {
    if (!selectedVideo) return;
    selectedVideo.srcObject = stream;
    selectedVideo.muted = !!muted;
    selectedVideo.dataset.label = label || '';
    if (stageEmpty) stageEmpty.style.display = 'none';
    safePlay(selectedVideo);
  }

  function markSelected(id) {
    document.querySelectorAll('.video-tile').forEach(el => {
      el.classList.toggle('selected', Number(el.dataset.id) === Number(id));
    });
  }

  function resetToGallery() {
    galleryPinned = false;
    markSelected(0);
    updateSelectedFromState();
  }

  function renderParticipants() {
    if (!participantsList) return;
    participantsList.innerHTML = '';
    currentState.participants.forEach(p => {
      const row = document.createElement('div');
      row.className = 'participant-item';
      row.innerHTML = `
        <div>
          <strong>${p.display_name}</strong>
          <div class="muted small">${p.full_name}</div>
          <div class="participant-meta">
            ${p.online ? '<span class="badge green">online</span>' : '<span class="badge">offline</span>'}
            ${p.is_eligible ? '<span class="badge">apto</span>' : ''}
            ${p.hand_raised ? '<span class="badge">pediu fala</span>' : ''}
            ${p.mic_blocked ? '<span class="badge red">mic bloqueado</span>' : ''}
            ${p.cam_blocked ? '<span class="badge red">cam bloqueada</span>' : ''}
          </div>
        </div>
        <div class="row gap wrap">
          ${role === 'admin' && !p.is_admin ? `
          <button class="btn" data-action="toggle_eligible" data-id="${p.id}">Voto</button>
          <button class="btn" data-action="allow_speak" data-id="${p.id}">Liberar</button>
          <button class="btn" data-action="block_mic" data-id="${p.id}">Mic</button>
          <button class="btn" data-action="block_cam" data-id="${p.id}">Cam</button>
          <button class="btn" data-action="spotlight" data-id="${p.id}">Destaque</button>
          <button class="btn danger" data-action="remove" data-id="${p.id}">Remover</button>` : ''}
        </div>`;
      participantsList.appendChild(row);
    });

    participantsList.querySelectorAll('button[data-action]').forEach(btn => {
      btn.onclick = () => api(`/admin/api/room/${roomCode}/participant/${btn.dataset.id}`, 'POST', { action: btn.dataset.action });
    });
  }

  function renderVote() {
    const vote = currentState.vote;
    const box = voteBox || document.getElementById('voteStats');
    if (!box) return;
    if (!vote) { box.innerHTML = ''; return; }

    const counts = Object.entries(vote.counts || {}).map(([k, v]) => `<div class="badge">${k}: ${v}</div>`).join('');
    const stats = `<div class="row wrap gap">
      <span class="badge">presentes ${vote.presentes}</span>
      <span class="badge">aptos ${vote.aptos}</span>
      <span class="badge">votaram ${vote.votaram}</span>
      <span class="badge">faltam ${vote.faltam}</span>
      ${counts}
    </div>`;

    if (role === 'participant' && voteBox) {
      const options = (vote.options || []).map(opt => `<button class="btn btn-primary vote-opt" data-option="${opt}">${opt}</button>`).join('');
      box.innerHTML = `<h3>${vote.title}</h3>${stats}<div class="row wrap gap" style="margin-top:8px">${options}</div><div class="muted small" style="margin-top:8px">${vote.result || ''}</div>`;
      box.querySelectorAll('.vote-opt').forEach(btn => btn.onclick = () => api(`/api/vote/${joinToken}`, 'POST', { option: btn.dataset.option }));
    } else {
      box.innerHTML = `${stats}<div class="muted small">${vote.title} · ${vote.result || ''}</div>`;
    }
  }

  function renderNotes() {
    if (summaryView) summaryView.textContent = currentState.room?.summary_text || '';
    if (decisionsView) decisionsView.textContent = currentState.room?.decisions_text || '';
    const st = document.getElementById('summaryText');
    const dt = document.getElementById('decisionsText');
    if (st) st.value = currentState.room?.summary_text || '';
    if (dt) dt.value = currentState.room?.decisions_text || '';
  }

  function applyState(state) {
    currentState = state || { room: {}, participants: [] };
    renderParticipants();
    renderVote();
    renderNotes();
  }

  function updateSelectedFromState() {
    const selected = Number(currentState.room?.screen_share_id || currentState.room?.selected_id || currentState.room?.speaker_id || 0);
    document.querySelectorAll('.video-tile').forEach(el => {
      el.classList.toggle('selected', Number(el.dataset.id) === selected);
      el.classList.toggle('active', Number(el.dataset.id) === Number(currentState.room?.speaker_id || 0));
    });
    if (galleryPinned) return;
    if (selected && remoteStreams[selected]) {
      const p = currentState.participants.find(x => Number(x.id) === selected);
      promoteStream(remoteStreams[selected], p ? p.display_name : 'Participante', false);
    } else if (!selected && localStream && (!selectedVideo?.srcObject || selectedVideo.dataset.label === 'Você')) {
      promoteStream(localStream, 'Você', true);
    }
  }

  function setupAdminButtons() {
    document.querySelectorAll('[data-bulk]').forEach(btn => btn.onclick = () => api(`/admin/api/room/${roomCode}/bulk`, 'POST', { action: btn.dataset.bulk }));
    document.getElementById('copyInvite')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(document.getElementById('inviteUrl').value);
    });
    document.getElementById('toggleRoom')?.addEventListener('click', async () => {
      const r = await api(`/admin/api/room/${roomCode}/toggle_status`);
      if (r.ok) location.reload();
    });
    document.getElementById('deleteRoom')?.addEventListener('click', async () => {
      if (!confirm('Excluir esta sala?')) return;
      const r = await api(`/admin/api/room/${roomCode}/delete`);
      if (r.ok) location.href = '/admin/dashboard';
    });
    document.getElementById('startVote')?.addEventListener('click', async () => {
      const title = document.getElementById('voteTitle').value || 'Votação';
      const options = (document.getElementById('voteOptions').value || 'Sim,Não,Abstenção').split(',').map(x => x.trim()).filter(Boolean);
      const rule = document.getElementById('voteRule').value;
      const secret = document.getElementById('voteSecret').checked;
      await api(`/admin/api/room/${roomCode}/vote`, 'POST', { title, options, rule, secret });
    });
    document.getElementById('endVote')?.addEventListener('click', () => api(`/admin/api/room/${roomCode}/vote/end`, 'POST'));
    document.getElementById('saveNotes')?.addEventListener('click', async () => {
      await api(`/admin/api/room/${roomCode}/notes`, 'POST', {
        summary_text: document.getElementById('summaryText').value,
        decisions_text: document.getElementById('decisionsText').value
      });
    });
    document.getElementById('shareScreen')?.addEventListener('click', async () => {
      try {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const screenTrack = screen.getVideoTracks()[0];
        socket.emit('screen_share', { join_token: joinToken, active: true });
        Object.values(peers).forEach(pc => {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        });
        galleryPinned = true;
        promoteStream(screen, 'Tela compartilhada', true);
        screenTrack.onended = () => {
          socket.emit('screen_share', { join_token: joinToken, active: false });
          if (!localStream) return;
          const camTrack = localStream.getVideoTracks()[0];
          Object.values(peers).forEach(pc => {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender && camTrack) sender.replaceTrack(camTrack);
          });
          resetToGallery();
        };
      } catch (e) {
        console.warn(e);
      }
    });
  }

  function setupParticipantButtons() {
    document.getElementById('raiseHand')?.addEventListener('click', () => socket.emit('raise_hand', { join_token: joinToken }));
    document.getElementById('lowerHand')?.addEventListener('click', () => socket.emit('lower_hand', { join_token: joinToken }));
    document.getElementById('toggleMic')?.addEventListener('click', () => {
      if (!localStream) return;
      micEnabled = !micEnabled;
      localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
      document.getElementById('toggleMic').classList.toggle('off', !micEnabled);
    });
    document.getElementById('toggleCam')?.addEventListener('click', () => {
      if (!localStream) return;
      camEnabled = !camEnabled;
      localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
      document.getElementById('toggleCam').classList.toggle('off', !camEnabled);
    });
    document.getElementById('toggleFullscreen')?.addEventListener('click', () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    });
  }

  function shouldInitiate(targetId) {
    return Number(myId) > 0 && Number(targetId) > 0 && Number(myId) < Number(targetId);
  }

  function createPeer(targetId) {
    if (peers[targetId]) return peers[targetId];
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peers[targetId] = pc;

    if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = ev => {
      if (ev.candidate) socket.emit('signal', { join_token: joinToken, target_id: targetId, type: 'ice', candidate: ev.candidate });
    };

    pc.ontrack = ev => {
      const stream = ev.streams[0];
      remoteStreams[targetId] = stream;
      const p = currentState.participants.find(x => Number(x.id) === Number(targetId));
      attachTile({ id: targetId, name: p ? p.display_name : `Participante ${targetId}`, stream, isLocal: false });
      if (!galleryPinned) {
        const selected = Number(currentState.room?.screen_share_id || currentState.room?.selected_id || currentState.room?.speaker_id || 0);
        if (!selected || selected === Number(targetId) || !selectedVideo?.srcObject) {
          promoteStream(stream, p ? p.display_name : 'Participante', false);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) removeTile(targetId);
    };

    return pc;
  }

  async function callPeer(targetId) {
    const pc = createPeer(targetId);
    if (pc._makingOffer) return;
    pc._makingOffer = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { join_token: joinToken, target_id: targetId, type: 'offer', description: pc.localDescription });
    } catch (e) {
      console.warn(e);
    } finally {
      pc._makingOffer = false;
    }
  }

  async function handleSignal(data) {
    const fromId = Number(data.from_id);
    const pc = createPeer(fromId);
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.description));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { join_token: joinToken, target_id: fromId, type: 'answer', description: pc.localDescription });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.description));
      } else if (data.type === 'ice' && data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (e) {
      console.warn('signal error', e);
    }
  }

  function syncPeers() {
    if (!myId || !localStream) return;
    const onlineIds = new Set();
    (currentState.participants || []).filter(p => p.online && Number(p.id) !== Number(myId)).forEach(p => {
      onlineIds.add(Number(p.id));
      if (!peers[p.id]) {
        createPeer(p.id);
        if (shouldInitiate(p.id)) setTimeout(() => callPeer(p.id), 200);
      }
    });
    Object.keys(peers).forEach(id => {
      if (!onlineIds.has(Number(id))) removeTile(Number(id));
    });
    updateSelectedFromState();
  }

  function setupAudioLevel(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const analyser = ctx.createAnalyser();
      const src = ctx.createMediaStreamSource(stream);
      src.connect(analyser);
      analyser.fftSize = 256;
      const data = new Uint8Array(analyser.frequencyBinCount);
      setInterval(() => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        socket.emit('speaker_update', { join_token: joinToken, speaking: avg > 14 && micEnabled });
      }, 900);
    } catch (e) {
      console.warn('audio meter off', e);
    }
  }

  document.getElementById('backToGallery')?.addEventListener('click', resetToGallery);

  socket.on('connect', async () => {
    await startMedia();
    socket.emit('join_room', { join_token: joinToken });
  });

  socket.on('joined_ok', data => {
    if (data.participant_id) {
      myId = Number(data.participant_id);
      if (localStream) {
        removeTile(-1);
        attachTile({ id: myId, name: 'Você', stream: localStream, isLocal: true });
        promoteStream(localStream, 'Você', true);
      }
      syncPeers();
    }
  });

  socket.on('room_state', state => {
    applyState(state);
    syncPeers();
  });

  socket.on('signal', handleSignal);
  socket.on('removed', payload => {
    alert(payload.reason || 'Removido da sala.');
    location.href = '/';
  });

  if (role === 'admin') setupAdminButtons();
  else setupParticipantButtons();

  applyState(currentState);
})();
