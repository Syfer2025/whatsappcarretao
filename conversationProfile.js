const { getChatId, getDisplayName } = require('./whatsappUtils');
const { withTimeout } = require('./runtimeUtils');

async function tryCall(promiseFactory, timeoutMs, label) {
  try {
    return await withTimeout(promiseFactory, timeoutMs, label);
  } catch {
    return null;
  }
}

async function getProfilePicUrl({ whatsapp, contact, chatId, timeoutMs }) {
  const contactId = getChatId(contact) || chatId;
  const attempts = [];

  if (typeof contact?.getProfilePicUrl === 'function') {
    attempts.push(() => contact.getProfilePicUrl());
  }
  if (whatsapp && typeof whatsapp.getProfilePicUrl === 'function' && contactId) {
    attempts.push(() => whatsapp.getProfilePicUrl(contactId));
  }
  if (whatsapp && typeof whatsapp.getProfilePicUrl === 'function' && chatId && chatId !== contactId) {
    attempts.push(() => whatsapp.getProfilePicUrl(chatId));
  }

  for (const attempt of attempts) {
    const url = await tryCall(attempt, timeoutMs, 'getProfilePicUrl');
    if (typeof url === 'string' && url.trim()) return url.trim();
  }

  return null;
}

async function getConversationProfile({
  whatsapp,
  chat,
  chatId,
  timeoutMs = 2500
}) {
  const contact = typeof chat?.getContact === 'function'
    ? await tryCall(() => chat.getContact(), timeoutMs, 'getContact')
    : null;

  return {
    contactName: getDisplayName(chat, chatId, contact),
    profilePicUrl: await getProfilePicUrl({ whatsapp, contact, chatId, timeoutMs })
  };
}

module.exports = {
  getConversationProfile
};
