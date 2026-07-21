/* global window, document */
(function initChatDirectory(global) {
  'use strict';

  let config = {};
  let contactsSyncAttempted = false;
  let searchTimer = null;
  let activeProfileConversationId = null;
  let activeProfile = null;
  let profileLoadSequence = 0;
  let profileActionInFlight = null;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function formatPhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) return String(value || '').replace(/@(c\.us|lid|g\.us)$/i, '');
    if (digits.length === 13 && digits.startsWith('55')) {
      return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
    }
    if (digits.length === 12 && digits.startsWith('55')) {
      return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 8)}-${digits.slice(8)}`;
    }
    return `+${digits}`;
  }

  function ensureUi() {
    if (document.getElementById('chatDirectoryStyles')) return;
    const style = document.createElement('style');
    style.id = 'chatDirectoryStyles';
    style.textContent = `
      .directory-overlay{position:fixed;inset:0;background:rgba(15,23,42,.56);backdrop-filter:blur(5px);z-index:11500;display:none;align-items:center;justify-content:center;padding:20px}.directory-overlay.open{display:flex}
      .directory-dialog{width:min(540px,100%);max-height:min(720px,90vh);display:flex;flex-direction:column;background:#fff;border-radius:18px;box-shadow:0 28px 80px rgba(15,23,42,.28);overflow:hidden;color:#111b21}
      .directory-header{display:flex;align-items:center;justify-content:space-between;padding:20px 22px;border-bottom:1px solid #e9edef}.directory-header h3{font-size:18px;margin:0}.directory-close{border:0;background:transparent;font-size:27px;color:#667781;cursor:pointer}
      .directory-body{padding:18px 22px;overflow:auto}.directory-label{display:block;font-size:12px;font-weight:750;color:#54656f;margin:0 0 7px}.directory-row{display:flex;gap:8px;margin-bottom:16px}.directory-input{width:100%;border:1px solid #d1d7db;border-radius:9px;padding:11px 12px;font-size:14px;outline:none;background:#f8fafc}.directory-input:focus{border-color:#25d366;box-shadow:0 0 0 3px rgba(37,211,102,.12);background:#fff}
      .directory-primary{border:0;border-radius:9px;background:#25d366;color:#fff;font-weight:750;padding:10px 15px;cursor:pointer;white-space:nowrap}.directory-primary:disabled{opacity:.55;cursor:wait}
      .directory-section-title{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.45px;color:#8696a0;margin:18px 0 8px}.directory-results{border:1px solid #edf1ef;border-radius:10px;overflow:hidden}.directory-contact{display:flex;align-items:center;gap:11px;width:100%;padding:11px 12px;border:0;border-bottom:1px solid #edf1ef;background:#fff;text-align:left;cursor:pointer}.directory-contact:last-child{border-bottom:0}.directory-contact:hover{background:#f0fdf4}.directory-contact-avatar{width:38px;height:38px;border-radius:50%;background:#e8f8ee;color:#166534;display:flex;align-items:center;justify-content:center;font-weight:800;overflow:hidden;flex:none}.directory-contact-avatar img{width:100%;height:100%;object-fit:cover}.directory-contact-copy{min-width:0;flex:1}.directory-contact-name{font-weight:700;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.directory-contact-phone{font-size:12px;color:#667781;margin-top:2px}.directory-empty{padding:24px;text-align:center;color:#8696a0;font-size:13px}
      .profile-scrim{position:fixed;inset:0;background:rgba(15,23,42,.34);z-index:11400;display:none}.profile-scrim.open{display:block}.profile-drawer{position:absolute;right:0;top:0;height:100%;width:min(430px,94vw);background:#fff;box-shadow:-20px 0 60px rgba(15,23,42,.2);display:flex;flex-direction:column;animation:profileSlide .2s ease}@keyframes profileSlide{from{transform:translateX(24px);opacity:.5}to{transform:none;opacity:1}}
      .profile-header{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #e9edef}.profile-header h3{font-size:16px;margin:0}.profile-content{overflow:auto;padding:24px 22px}.profile-hero{text-align:center;padding-bottom:22px;border-bottom:1px solid #edf1ef}.profile-avatar{width:104px;height:104px;border-radius:50%;margin:0 auto 13px;background:#dcfce7;color:#166534;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:800;overflow:hidden}.profile-avatar img{width:100%;height:100%;object-fit:cover}.profile-name{font-size:19px;font-weight:800}.profile-phone{font-size:13px;color:#667781;margin-top:5px}.profile-about{font-size:13px;color:#54656f;margin-top:9px;line-height:1.45}.profile-meta{display:flex;justify-content:center;gap:7px;margin-top:10px;flex-wrap:wrap}.profile-chip{background:#f0f2f5;border-radius:99px;padding:5px 9px;font-size:11px;color:#54656f;font-weight:700}
      .profile-controls{margin-top:20px}.profile-status-list{border:1px solid #edf1ef;border-radius:12px;padding:2px 13px;background:#f8fafc}.profile-status-row{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:11px 0;border-bottom:1px solid #e9edef;font-size:12.5px;color:#667781}.profile-status-row:last-child{border-bottom:0}.profile-status-row strong{color:#111b21;font-size:12.5px;text-align:right}.profile-status-row strong.warning{color:#b45309}.profile-status-row strong.danger{color:#b42318}.profile-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px}.profile-action{min-height:42px;border:1px solid #d1d7db;border-radius:10px;background:#fff;color:#344054;font-size:12.5px;font-weight:750;padding:9px 11px;cursor:pointer}.profile-action:hover{background:#f8fafc;border-color:#98a2b3}.profile-action.danger{color:#b42318;border-color:#f4c7c3;background:#fff8f7}.profile-action.restore{color:#067647;border-color:#abefc6;background:#f6fef9}.profile-action:disabled{opacity:.58;cursor:wait}.profile-actions .profile-action:last-child:nth-child(odd){grid-column:1/-1}
      .participant-list{margin-top:18px}.participant{display:flex;gap:11px;align-items:center;padding:10px 0;border-bottom:1px solid #edf1ef}.participant-avatar{width:36px;height:36px;border-radius:50%;background:#f0f2f5;color:#54656f;display:flex;align-items:center;justify-content:center;font-weight:750;overflow:hidden;flex:none}.participant-avatar img{width:100%;height:100%;object-fit:cover}.participant-copy{min-width:0;flex:1}.participant-name{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.participant-phone{font-size:11.5px;color:#8696a0;margin-top:2px}.participant-role{font-size:10px;background:#dcfce7;color:#166534;padding:4px 7px;border-radius:99px;font-weight:800}
      .chat-headline.profile-clickable{cursor:pointer;border-radius:9px;padding:4px 7px;margin-left:-7px}.chat-headline.profile-clickable:hover{background:rgba(15,23,42,.05)}.chat-headline.profile-clickable:after{content:'›';font-size:26px;line-height:1;color:#94a3b8;margin-left:2px}
    `;
    document.head.appendChild(style);

    const directory = document.createElement('div');
    directory.id = 'newConversationModal';
    directory.className = 'directory-overlay';
    directory.innerHTML = `
      <div class="directory-dialog" role="dialog" aria-modal="true" aria-labelledby="newConversationTitle">
        <div class="directory-header"><h3 id="newConversationTitle">Iniciar nova conversa</h3><button class="directory-close" type="button" data-directory-close>&times;</button></div>
        <div class="directory-body">
          <label class="directory-label" for="newConversationPhone">Telefone com DDD e país</label>
          <div class="directory-row"><input class="directory-input" id="newConversationPhone" inputmode="tel" placeholder="Ex.: +55 44 99999-9999"><button class="directory-primary" id="startConversationByPhone" type="button">Abrir</button></div>
          <label class="directory-label" for="contactDirectorySearch">Contatos salvos no WhatsApp</label>
          <input class="directory-input" id="contactDirectorySearch" placeholder="Buscar por nome ou telefone">
          <div class="directory-section-title" id="contactDirectoryStatus">Contatos</div>
          <div class="directory-results" id="contactDirectoryResults"><div class="directory-empty">Carregando contatos...</div></div>
        </div>
      </div>`;
    document.body.appendChild(directory);

    const profile = document.createElement('div');
    profile.id = 'conversationProfileScrim';
    profile.className = 'profile-scrim';
    profile.innerHTML = `<aside class="profile-drawer" role="dialog" aria-modal="true" aria-label="Dados da conversa"><div class="profile-header"><h3>Dados da conversa</h3><button class="directory-close" type="button" data-profile-close>&times;</button></div><div class="profile-content" id="conversationProfileContent"><div class="directory-empty">Carregando...</div></div></aside>`;
    document.body.appendChild(profile);

    directory.addEventListener('click', event => {
      if (event.target === directory || event.target.closest('[data-directory-close]')) closeNewConversation();
    });
    profile.addEventListener('click', event => {
      if (event.target === profile || event.target.closest('[data-profile-close]')) {
        closeProfile();
        return;
      }
      const actionButton = event.target.closest('[data-profile-action]');
      if (actionButton) handleProfileAction(actionButton.dataset.profileAction);
    });
    document.getElementById('startConversationByPhone').addEventListener('click', () => startConversation({ phone: document.getElementById('newConversationPhone').value }));
    document.getElementById('newConversationPhone').addEventListener('keydown', event => {
      if (event.key === 'Enter') startConversation({ phone: event.currentTarget.value });
    });
    document.getElementById('contactDirectorySearch').addEventListener('input', event => {
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => loadContacts(event.target.value), 220);
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      closeNewConversation();
      closeProfile();
    });
  }

  function notify(message, type = 'error') {
    if (typeof config.notify === 'function') config.notify(message, type);
  }

  function closeNewConversation() {
    document.getElementById('newConversationModal')?.classList.remove('open');
  }

  function closeProfile() {
    document.getElementById('conversationProfileScrim')?.classList.remove('open');
    activeProfileConversationId = null;
    activeProfile = null;
    profileActionInFlight = null;
    profileLoadSequence += 1;
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || '?';
  }

  function contactName(contact) {
    return contact?.name || contact?.short_name || contact?.push_name || contact?.verified_name || formatPhone(contact?.phone || contact?.whatsapp_id);
  }

  function renderContacts(contacts) {
    const results = document.getElementById('contactDirectoryResults');
    const status = document.getElementById('contactDirectoryStatus');
    status.textContent = `${contacts.length} contato${contacts.length === 1 ? '' : 's'}`;
    if (!contacts.length) {
      results.innerHTML = '<div class="directory-empty">Nenhum contato salvo encontrado.</div>';
      return;
    }
    results.innerHTML = contacts.map(contact => {
      const name = contactName(contact);
      const avatar = contact.profile_pic_url
        ? `<img src="${escapeHtml(contact.profile_pic_url)}" alt="">`
        : escapeHtml(initials(name));
      return `<button class="directory-contact" type="button" data-contact-id="${escapeHtml(contact.whatsapp_id)}"><span class="directory-contact-avatar">${avatar}</span><span class="directory-contact-copy"><span class="directory-contact-name">${escapeHtml(name)}</span><span class="directory-contact-phone">${escapeHtml(formatPhone(contact.phone || contact.whatsapp_id))}${Number(contact.is_business) === 1 ? ' · Empresa' : ''}</span></span></button>`;
    }).join('');
    results.querySelectorAll('[data-contact-id]').forEach(button => {
      button.addEventListener('click', () => startConversation({ contact_id: button.dataset.contactId }));
    });
  }

  async function loadContacts(query = '', syncIfEmpty = false) {
    try {
      const response = await config.api(`/api/contacts?q=${encodeURIComponent(query)}&limit=100`);
      const contacts = response.ok ? await response.json() : [];
      renderContacts(Array.isArray(contacts) ? contacts : []);
      if (syncIfEmpty && !contacts.length && !contactsSyncAttempted) {
        contactsSyncAttempted = true;
        document.getElementById('contactDirectoryStatus').textContent = 'Sincronizando contatos do WhatsApp...';
        const syncResponse = await config.api('/api/contacts/sync', { method: 'POST' });
        if (syncResponse.ok) await loadContacts(query, false);
      }
    } catch {
      renderContacts([]);
      notify('Não foi possível carregar os contatos do WhatsApp.');
    }
  }

  async function openNewConversation() {
    ensureUi();
    document.getElementById('newConversationPhone').value = '';
    document.getElementById('contactDirectorySearch').value = '';
    document.getElementById('newConversationModal').classList.add('open');
    document.getElementById('newConversationPhone').focus();
    await loadContacts('', true);
  }

  async function startConversation(payload) {
    const button = document.getElementById('startConversationByPhone');
    button.disabled = true;
    try {
      const response = await config.api('/api/conversations/start', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Não foi possível iniciar a conversa.');
      closeNewConversation();
      notify(data.created ? 'Conversa criada.' : 'Conversa aberta.', 'success');
      if (typeof config.onConversationOpen === 'function') config.onConversationOpen(data.conversation.id);
    } catch (error) {
      notify(error.message || 'Não foi possível iniciar a conversa.');
    } finally {
      button.disabled = false;
    }
  }

  function renderProfile(profile) {
    const content = document.getElementById('conversationProfileContent');
    if (!content) return;
    const name = profile.contact_name || profile.name || formatPhone(profile.phone);
    const avatar = profile.profile_pic_url
      ? `<img src="${escapeHtml(profile.profile_pic_url)}" alt="">`
      : escapeHtml(initials(name));
    const participants = Array.isArray(profile.participants) ? profile.participants : [];
    const isGroup = Number(profile.is_group) === 1;
    const archived = Number(profile.whatsapp_archived) === 1;
    const blocked = !isGroup && Number(profile.is_blocked) === 1;
    const muted = isProfileMuted(profile);
    const chips = [
      isGroup ? 'Grupo' : (Number(profile.is_business) === 1 ? 'Conta comercial' : 'Contato'),
      Number(profile.is_saved) === 1 ? 'Salvo nos contatos' : '',
      archived ? 'Arquivada' : '',
      muted ? 'Notificações silenciadas' : '',
      blocked ? 'Bloqueado' : ''
    ].filter(Boolean);
    const participantsHtml = participants.map(participant => {
      const participantDisplayName = participant.name || formatPhone(participant.phone || participant.participant_id);
      const participantAvatar = participant.profile_pic_url
        ? `<img src="${escapeHtml(participant.profile_pic_url)}" alt="">`
        : escapeHtml(initials(participantDisplayName));
      return `<div class="participant"><div class="participant-avatar">${participantAvatar}</div><div class="participant-copy"><div class="participant-name">${escapeHtml(participantDisplayName)}</div><div class="participant-phone">${escapeHtml(formatPhone(participant.phone || participant.participant_id))}</div></div>${Number(participant.is_super_admin || participant.is_admin) === 1 ? `<span class="participant-role">${Number(participant.is_super_admin) === 1 ? 'Criador' : 'Admin'}</span>` : ''}</div>`;
    }).join('');
    const actionDisabled = Boolean(profileActionInFlight);
    const actionLabel = (action, regularLabel) => profileActionInFlight === action ? 'Aguarde...' : regularLabel;
    const controls = `<div class="profile-controls">
      <div class="directory-section-title">Privacidade e notificações</div>
      <div class="profile-status-list">
        <div class="profile-status-row"><span>Conversa</span><strong class="${archived ? 'warning' : ''}">${archived ? 'Arquivada' : 'Ativa'}</strong></div>
        <div class="profile-status-row"><span>Notificações</span><strong class="${muted ? 'warning' : ''}">${muted ? 'Silenciadas' : 'Ativas'}</strong></div>
        ${isGroup ? '' : `<div class="profile-status-row"><span>Contato</span><strong class="${blocked ? 'danger' : ''}">${blocked ? 'Bloqueado' : 'Permitido'}</strong></div>`}
      </div>
      <div class="profile-actions">
        <button class="profile-action ${archived ? 'restore' : ''}" type="button" data-profile-action="archive" ${actionDisabled ? 'disabled' : ''}>${escapeHtml(actionLabel('archive', archived ? 'Desarquivar' : 'Arquivar'))}</button>
        <button class="profile-action ${muted ? 'restore' : ''}" type="button" data-profile-action="mute" ${actionDisabled ? 'disabled' : ''}>${escapeHtml(actionLabel('mute', muted ? 'Ativar notificações' : 'Silenciar notificações'))}</button>
        ${isGroup ? '' : `<button class="profile-action ${blocked ? 'restore' : 'danger'}" type="button" data-profile-action="block" ${actionDisabled ? 'disabled' : ''}>${escapeHtml(actionLabel('block', blocked ? 'Desbloquear contato' : 'Bloquear contato'))}</button>`}
      </div>
    </div>`;
    content.innerHTML = `<div class="profile-hero"><div class="profile-avatar">${avatar}</div><div class="profile-name">${escapeHtml(name)}</div><div class="profile-phone">${escapeHtml(isGroup ? `${participants.length} participantes` : formatPhone(profile.phone))}</div>${profile.profile_about || profile.group_description ? `<div class="profile-about">${escapeHtml(profile.profile_about || profile.group_description)}</div>` : ''}<div class="profile-meta">${chips.map(chip => `<span class="profile-chip">${escapeHtml(chip)}</span>`).join('')}</div></div>${controls}${isGroup ? `<div class="directory-section-title">Participantes</div><div class="participant-list">${participantsHtml || '<div class="directory-empty">Nenhum participante disponível.</div>'}</div>` : ''}`;
  }

  function isProfileMuted(profile) {
    if (profile?.muted !== undefined) return Boolean(profile.muted);
    if (profile?.is_muted !== undefined) return Boolean(profile.is_muted);
    if (!profile?.muted_until) return false;
    const normalized = String(profile.muted_until).trim().replace(' ', 'T');
    const expiresAt = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
    return Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() > Date.now();
  }

  async function loadProfile(conversationId, { refresh = false, showLoading = true } = {}) {
    const requestId = ++profileLoadSequence;
    const content = document.getElementById('conversationProfileContent');
    if (showLoading) content.innerHTML = '<div class="directory-empty">Atualizando dados do WhatsApp...</div>';
    try {
      const profileUrl = refresh
        ? `/api/conversations/${conversationId}/profile?refresh=1`
        : `/api/conversations/${conversationId}/profile`;
      const response = await config.api(profileUrl);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Perfil indisponível.');
      if (requestId !== profileLoadSequence || Number(conversationId) !== Number(activeProfileConversationId)) return null;
      activeProfile = data;
      renderProfile(data);
      return data;
    } catch (error) {
      if (requestId !== profileLoadSequence || Number(conversationId) !== Number(activeProfileConversationId)) return null;
      if (showLoading || !activeProfile) {
        content.innerHTML = `<div class="directory-empty">${escapeHtml(error.message || 'Perfil indisponível.')}</div>`;
      } else {
        notify(error.message || 'Não foi possível atualizar o perfil.');
      }
      return null;
    }
  }

  async function openProfile(conversationId) {
    if (!conversationId) return;
    ensureUi();
    activeProfileConversationId = Number(conversationId);
    activeProfile = null;
    profileActionInFlight = null;
    document.getElementById('conversationProfileScrim').classList.add('open');
    await loadProfile(conversationId, { refresh: true });
  }

  async function setBlocked(conversationId, blocked) {
    const response = await config.api(`/api/conversations/${conversationId}/block`, {
      method: 'PATCH',
      body: JSON.stringify({ blocked: Boolean(blocked) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível alterar o bloqueio do contato.');
    notify(blocked ? 'Contato bloqueado.' : 'Contato desbloqueado.', 'success');
    return data;
  }

  async function setMuted(conversationId, muted) {
    const response = await config.api(`/api/conversations/${conversationId}/state`, {
      method: 'PATCH',
      body: JSON.stringify({ muted: Boolean(muted) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível alterar as notificações.');
    notify(muted ? 'Notificações silenciadas.' : 'Notificações ativadas.', 'success');
    return data;
  }

  function applyProfileActionState(action, nextValue, data) {
    if (!activeProfile) return;
    if (action === 'archive') {
      activeProfile = {
        ...activeProfile,
        ...(data?.conversation || {}),
        whatsapp_archived: nextValue ? 1 : 0
      };
    } else if (action === 'mute') {
      activeProfile = {
        ...activeProfile,
        ...(data || {}),
        muted: Boolean(nextValue),
        muted_until: nextValue ? (data?.muted_until || '9999-12-31 23:59:59') : null
      };
    } else if (action === 'block') {
      activeProfile = {
        ...activeProfile,
        ...(data?.profile || {}),
        is_blocked: nextValue ? 1 : 0
      };
    }
    renderProfile(activeProfile);
  }

  async function handleProfileAction(action) {
    if (!activeProfileConversationId || !activeProfile || profileActionInFlight) return;
    if (action === 'block' && Number(activeProfile.is_group) === 1) return;
    const conversationId = activeProfileConversationId;
    const nextValue = action === 'archive'
      ? Number(activeProfile.whatsapp_archived) !== 1
      : action === 'mute'
        ? !isProfileMuted(activeProfile)
        : Number(activeProfile.is_blocked) !== 1;
    profileActionInFlight = action;
    renderProfile(activeProfile);
    try {
      let data;
      if (action === 'archive') data = await setArchived(conversationId, nextValue);
      else if (action === 'mute') data = await setMuted(conversationId, nextValue);
      else if (action === 'block') data = await setBlocked(conversationId, nextValue);
      else return;
      if (!data || Number(conversationId) !== Number(activeProfileConversationId)) return;
      applyProfileActionState(action, nextValue, data);
      await loadProfile(conversationId, { showLoading: false });
    } catch (error) {
      notify(error.message || 'Não foi possível atualizar a conversa.');
    } finally {
      if (Number(conversationId) === Number(activeProfileConversationId)) {
        profileActionInFlight = null;
        if (activeProfile) renderProfile(activeProfile);
      }
    }
  }

  async function setArchived(conversationId, archived) {
    try {
      const response = await config.api(`/api/conversations/${conversationId}/archive`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: Boolean(archived) })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Não foi possível alterar o arquivamento.');
      const destination = data.synced ? 'no sistema e no WhatsApp' : 'neste painel';
      notify(archived ? `Conversa arquivada ${destination}.` : `Conversa desarquivada ${destination}.`, 'success');
      if (typeof config.onArchiveChanged === 'function') config.onArchiveChanged(data.conversation || data);
      return data;
    } catch (error) {
      notify(error.message || 'Não foi possível alterar o arquivamento.');
      return null;
    }
  }

  function configure(nextConfig) {
    config = { ...config, ...nextConfig };
    ensureUi();
  }

  global.ChatDirectory = {
    configure,
    openNewConversation,
    startConversation,
    openProfile,
    closeProfile,
    setArchived,
    formatPhone
  };
})(window);
