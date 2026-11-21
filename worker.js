// Cloudflare Worker: бот обратной связи (замена Livegram)
// D1-привязка: BD. Секреты: BOT_TOKEN, GROUP_ID, WEBHOOK_SECRET.
// Необязательные переменные: WELCOME, AUTOREPLY, TZ_OFFSET (часы от UTC, по умолчанию 3 = Москва),
//   NOTICE_TTL_SEC (секунды жизни уведомлений в General, по умолчанию 6),
//   NOTICE_LONG_TTL_SEC (секунды жизни ответа на /app в General, по умолчанию 20).
// Для рассылок и дочистки временных сообщений нужен Cron Trigger "* * * * *".
// Mini App теперь лежит на GitHub Pages (файл index.html). Воркер отдаёт только API.
// Переменная APP_URL: адрес Mini App (по умолчанию https://itsalexoncc-cell.github.io/support-bot-2/).
// Доп. секрет: ADMIN_USER_ID (Telegram ID владельца; несколько аккаунтов: через запятую).
//
// АНОНИМНОСТЬ ВЛАДЕЛЬЦА:
//   клиент -> группа: forwardMessage (в группе видна плашка «Переслано от <клиент>»);
//                     если клиент отвечает на конкретное сообщение: copyMessage с цитатой (одно сообщение)
//   группа -> клиент: ТОЛЬКО copyMessage (клиент видит бота, а не ваш аккаунт). Здесь forwardMessage использовать нельзя.

const BATCH = 45; // сообщений рассылки за один запуск (лимит подзапросов на free-плане: 50)
const AUTOREPLY_EVERY = 6 * 3600; // автоответ одному клиенту не чаще раза в 6 часов
const DEFAULT_APP_URL = 'https://itsalexoncc-cell.github.io/support-bot-2/';
const GENERAL_THREAD_ID = 1; // топик General в форуме

const appUrl = (env) => env.APP_URL || DEFAULT_APP_URL;

// CORS: API вызывается со страницы на github.io, поэтому разрешаем именно этот origin
const corsHeaders = (env) => ({
  'Access-Control-Allow-Origin': new URL(appUrl(env)).origin,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
});

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Сколько секунд живёт временное сообщение (long: ответ с кнопкой, которую нужно успеть нажать)
const noticeSec = (env, long = false) =>
  Math.max(0, Number(long ? env.NOTICE_LONG_TTL_SEC ?? 20 : env.NOTICE_TTL_SEC ?? 6));

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Установка webhook и меню команд: открыть /setup?key=WEBHOOK_SECRET
    if (url.pathname === '/setup' && url.searchParams.get('key') === env.WEBHOOK_SECRET) {
      const set = await tg(env, 'setWebhook', {
        url: url.origin,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
      });
      await tg(env, 'setMyCommands', { commands: [{ command: 'app', description: 'Открыть мини-приложение' }] });
      const cmds = await tg(env, 'setMyCommands', {
        scope: { type: 'chat', chat_id: Number(env.GROUP_ID) },
        commands: [
          { command: 'del', description: 'Удалить сообщение (ответом на него)' },
          { command: 'ban', description: 'Заблокировать клиента' },
          { command: 'unban', description: 'Разблокировать клиента' },
          { command: 'app', description: 'Открыть мини-приложение' },
        ],
      });
      const menu = await tg(env, 'setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Меню', web_app: { url: appUrl(env) } },
      });
      const schema = await ensureSchema(env);
      const me = await tg(env, 'getMe', {});
      return new Response(JSON.stringify({ set, cmds, menu, schema, me }, null, 2));
    }

    if (url.pathname.startsWith('/api/')) {
      const cors = corsHeaders(env);
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const res = await handleApi(req, env);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }

    // Старый адрес Mini App: отправляем на GitHub Pages
    if (req.method === 'GET' && url.pathname === '/') return Response.redirect(appUrl(env), 302);

    if (req.method !== 'POST') return new Response('ok');
    if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const update = await req.json();
    ctx.waitUntil(handle(update, env).catch((e) => console.error('handle error', e)));
    return new Response('ok');
  },

  // Cron: дочистка временных сообщений и порционная отправка рассылок
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepTemp(env));
    ctx.waitUntil(tickBroadcast(env).catch((e) => console.error('broadcast error', e)));
  },
};

async function handle(update, env) {
  if (update.my_chat_member) return onMyChatMember(update.my_chat_member, env);
  if (update.callback_query) return onCallback(update.callback_query, env);
  if (update.edited_message) return onEdit(update.edited_message, env);
  const m = update.message;
  if (!m) return;
  if (m.chat.type === 'private') return fromUser(m, env);
  if (String(m.chat.id) === String(env.GROUP_ID)) return fromGroup(m, env);
}

// ---------- настройки ----------
async function getSetting(env, key) {
  const r = await env.BD.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r?.value ?? null;
}
const setSetting = (env, key, value) =>
  env.BD.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, value).run();
const delSetting = (env, key) => env.BD.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();

async function isWorkTime(env) {
  const hours = await getSetting(env, 'work_hours');
  if (!hours) return true; // рабочее время не задано -> автоответ не нужен
  const days = (await getSetting(env, 'work_days')) || '1-7';
  const [a, b] = hours.split('-').map(Number);
  const [d1, d2] = days.split('-').map(Number);
  const tz = Number(env.TZ_OFFSET ?? 3);
  const t = new Date(Date.now() + tz * 3600 * 1000);
  const h = t.getUTCHours();
  const dow = t.getUTCDay() || 7;
  if (dow < d1 || dow > d2) return false;
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

// ---------- временные сообщения и уведомления в General ----------
// Временные сообщения записываются в базу: если воркер остановят до удаления, их дочистит cron или следующее уведомление
let tempReady;
const ensureTemp = (env) =>
  (tempReady ||= env.BD.prepare(
    'CREATE TABLE IF NOT EXISTS temp_msgs (chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, delete_at INTEGER NOT NULL, PRIMARY KEY (chat_id, message_id))'
  ).run().catch(() => {}));

// Удаляет временные сообщения, которые не успели удалиться сами (запас в 30 секунд, чтобы не задеть живые)
async function sweepTemp(env, limit = 5) {
  try {
    await ensureTemp(env);
    const { results } = await env.BD.prepare('SELECT chat_id, message_id FROM temp_msgs WHERE delete_at < ? LIMIT ?')
      .bind(now(), limit).all();
    for (const t of results || []) {
      const d = await tg(env, 'deleteMessage', { chat_id: t.chat_id, message_id: t.message_id });
      if (d.error_code === 429) break; // Telegram просит подождать, повторим в следующий раз
      await env.BD.prepare('DELETE FROM temp_msgs WHERE chat_id = ? AND message_id = ?').bind(t.chat_id, t.message_id).run();
    }
  } catch (e) {
    console.error('sweep error', e);
  }
}

// Отправляет временное сообщение и через несколько секунд удаляет его
async function flash(env, params, seconds = noticeSec(env)) {
  try {
    await sweepTemp(env);
    const r = await tg(env, 'sendMessage', params);
    if (!r.ok) return r;
    const chat = String(params.chat_id);
    const id = r.result.message_id;
    await env.BD.prepare('INSERT OR REPLACE INTO temp_msgs (chat_id, message_id, delete_at) VALUES (?, ?, ?)')
      .bind(chat, id, now() + Math.ceil(seconds) + 30).run().catch(() => {});
    await sleep(seconds * 1000);
    const d = await tg(env, 'deleteMessage', { chat_id: params.chat_id, message_id: id });
    if (d.ok || /not found/i.test(d.description || '')) {
      await env.BD.prepare('DELETE FROM temp_msgs WHERE chat_id = ? AND message_id = ?').bind(chat, id).run().catch(() => {});
    }
    return r;
  } catch (e) {
    console.error('flash error', e);
  }
}

// Уведомление в General, исчезает само. С groupMsgId это ответ на сообщение из топика, без него (null) просто сообщение.
// Если Telegram не принял ответ на сообщение из другого топика, шлём в General без привязки.
async function generalNotice(env, groupMsgId, text) {
  const base = { chat_id: env.GROUP_ID, text, disable_notification: true };
  const r = await flash(env, {
    ...base,
    message_thread_id: GENERAL_THREAD_ID,
    ...(groupMsgId ? { reply_parameters: { message_id: groupMsgId, allow_sending_without_reply: true } } : {}),
  });
  if (!r?.ok) await flash(env, base);
}

// Сообщение у клиента уже исчезло: для нас это тоже успех
const deleteOk = (r) => r.ok || /message to delete not found/i.test(r.description || '');
const deleteReason = (r) =>
  /can't be deleted|too old/i.test(r.description || '') ? 'сообщение старше 48 часов' : r.description || 'ошибка';

// ---------- клиент -> группа ----------
async function fromUser(m, env) {
  const u = await env.BD.prepare(
    'SELECT topic_id, banned, last_auto_reply FROM users WHERE user_id = ?'
  ).bind(m.from.id).first();
  if (u?.banned) return;

  // /app в личке: кнопка, открывающая мини-приложение
  if (/^\/app(@\w+)?(\s|$)/i.test(m.text || '')) {
    await tg(env, 'sendMessage', {
      chat_id: m.chat.id,
      text: 'Откройте мини-приложение:',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть', web_app: { url: appUrl(env) } }]] },
    });
    return;
  }

  // Если клиент закрепил сообщение у себя в чате — сохраняем в его «Закреп»
  if (m.pinned_message) {
    await ensureCustomName(env);
    const pm = m.pinned_message;
    const txt = (pm.text || pm.caption || '').trim();
    if (txt) {
      await env.BD.prepare(
        'INSERT INTO pins (user_id, group_msg_id, text, created_at) VALUES (?, ?, ?, ?)'
      ).bind(m.from.id, pm.message_id, txt, now()).run().catch(() => {});
    }
    return;
  }

  if ((m.text || '').startsWith('/start')) {
    // Приветствие отключено. Сотрудника тихо регистрируем (топик), чтобы он мог открыть Mini App.
    if (!u?.topic_id) {
      await createTopic(m.from, env);
      await env.BD.prepare('UPDATE users SET first_name = ?, last_name = ?, username = ? WHERE user_id = ?')
        .bind(m.from.first_name || null, m.from.last_name || null, m.from.username || null, m.from.id).run().catch(() => {});
    }
    await checkAvatar(env, m.from).catch((e) => console.error('avatar', e));
    return;
  }

  let topicId = u?.topic_id;
  if (!topicId) topicId = await createTopic(m.from, env);

  // обновляем имя/username для Mini App (не критично для переписки)
  await env.BD.prepare('UPDATE users SET first_name = ?, last_name = ?, username = ?, blocked_bot = 0 WHERE user_id = ?')
    .bind(m.from.first_name || null, m.from.last_name || null, m.from.username || null, m.from.id).run().catch(() => {});

  // ответ клиента на конкретное сообщение
  let replyTo;
  if (m.reply_to_message) {
    const row = await env.BD.prepare(
      'SELECT group_msg_id AS g FROM messages WHERE user_id = ? AND user_msg_id = ?'
    ).bind(m.from.id, m.reply_to_message.message_id).first();
    replyTo = row?.g;
  }

  // Отправка в группу. Ответ на конкретное сообщение уходит копией с цитатой (одно сообщение):
  // Telegram не позволяет пересланному сообщению быть ответом. Остальные сообщения пересылаем с плашкой «Переслано от».
  const toGroup = async (tid) => {
    if (replyTo) return copy(env, m.chat.id, m.message_id, env.GROUP_ID, tid, replyTo);
    const f = await fwd(env, m.chat.id, m.message_id, env.GROUP_ID, tid);
    if (f.ok || /thread not found/i.test(f.description || '')) return f;
    console.error('forward failed, using copy', f.description);
    return copy(env, m.chat.id, m.message_id, env.GROUP_ID, tid);
  };

  let r = await toGroup(topicId);
  if (!r.ok && /thread not found/i.test(r.description || '')) {
    topicId = await createTopic(m.from, env); // топик удалили вручную
    r = await toGroup(topicId);
  }
  if (!r.ok) {
    console.error('send to group failed', r);
    return;
  }
  await saveMap(env, m.from.id, m.message_id, r.result.message_id);
  await env.BD.prepare('UPDATE users SET last_msg_at = ? WHERE user_id = ?').bind(now(), m.from.id).run();

  // автоответ вне рабочего времени
  const text = (await getSetting(env, 'autoreply')) || env.AUTOREPLY;
  if (text && !(await isWorkTime(env)) && !(u?.last_auto_reply && now() - u.last_auto_reply < AUTOREPLY_EVERY)) {
    await tg(env, 'sendMessage', { chat_id: m.chat.id, text });
    await env.BD.prepare('UPDATE users SET last_auto_reply = ? WHERE user_id = ?').bind(now(), m.from.id).run();
  }

  await checkAvatar(env, m.from).catch((e) => console.error('avatar', e));
}

async function createTopic(u, env) {
  const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Без имени';
  const title = (u.username ? `${fullName} (@${u.username})` : fullName).slice(0, 128);

  const res = await tg(env, 'createForumTopic', { chat_id: env.GROUP_ID, name: title });
  if (!res.ok) throw new Error('createForumTopic: ' + res.description);
  const topicId = res.result.message_thread_id;

  await env.BD.prepare(
    `INSERT INTO users (user_id, topic_id, name) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET topic_id = excluded.topic_id, name = excluded.name`
  ).bind(u.id, topicId, title).run();

  await tg(env, 'sendMessage', {
    chat_id: env.GROUP_ID,
    message_thread_id: topicId,
    parse_mode: 'HTML',
    text:
      `👤 <a href="tg://user?id=${u.id}">${esc(fullName)}</a>\n` +
      `ID: <code>${u.id}</code>\n` +
      (u.username ? `Username: @${esc(u.username)}\n` : '') +
      `\n<i>Сообщения, начинающиеся с //, пользователю не отправляются.</i>`,
  });
  return topicId;
}

// ---------- группа -> клиент ----------
// ВАЖНО: здесь только copyMessage (через copy). Если заменить на forwardMessage, клиент увидит ваш настоящий аккаунт.
async function fromGroup(m, env) {
  if (m.from?.is_bot && !m.sender_chat) return;
  if (
    m.forum_topic_created || m.forum_topic_edited || m.forum_topic_closed ||
    m.forum_topic_reopened || m.general_forum_topic_hidden || m.general_forum_topic_unhidden
  ) return;

  // Если в топике клиента закрепили сообщение — добавляем его в раздел «Закреп» для этого юзера
  if (m.pinned_message) {
    const tid = m.message_thread_id;
    if (!tid) return;
    const row = await env.BD.prepare('SELECT user_id FROM users WHERE topic_id = ?').bind(tid).first();
    if (!row) return;
    await ensureCustomName(env);
    const pm = m.pinned_message;
    const txt = (pm.text || pm.caption || '').trim();
    if (txt && !txt.startsWith('//')) {
      await env.BD.prepare(
        'INSERT INTO pins (user_id, group_msg_id, text, created_at) VALUES (?, ?, ?, ?)'
      ).bind(row.user_id, pm.message_id, txt, now()).run().catch(() => {});
      const mp = await env.BD.prepare(
        'SELECT user_msg_id AS u FROM messages WHERE user_id = ? AND group_msg_id = ?'
      ).bind(row.user_id, pm.message_id).first();
      if (mp?.u) {
        await tg(env, 'pinChatMessage', { chat_id: row.user_id, message_id: mp.u }).catch(() => {});
      }
      await tg(env, 'sendMessage', {
        chat_id: m.chat.id,
        message_thread_id: tid,
        text: '📌 Добавлено в раздел «Закреп» у сотрудника.',
        disable_notification: true,
      });
    }
    return;
  }

  const text = m.text || '';
  const cmd = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (cmd && (await onCommand(m, env, cmd[1].toLowerCase(), (cmd[2] || '').trim()))) return;

  const tid = m.message_thread_id;
  if (!tid) return;
  if ((m.text || m.caption || '').startsWith('//')) return; // заметка для команды

  const row = await env.BD.prepare('SELECT user_id FROM users WHERE topic_id = ?').bind(tid).first();
  if (!row) return;

  let replyTo;
  if (m.reply_to_message) {
    const mp = await env.BD.prepare(
      'SELECT user_msg_id AS u FROM messages WHERE user_id = ? AND group_msg_id = ?'
    ).bind(row.user_id, m.reply_to_message.message_id).first();
    replyTo = mp?.u;
  }

  const r = await copy(env, m.chat.id, m.message_id, row.user_id, undefined, replyTo);
  if (r.ok) {
    await saveMap(env, row.user_id, r.result.message_id, m.message_id);
  } else {
    if (/blocked by the user|user is deactivated/i.test(r.description || '')) {
      await env.BD.prepare('UPDATE users SET blocked_bot = 1 WHERE user_id = ?').bind(row.user_id).run().catch(() => {});
    }
    await tg(env, 'sendMessage', {
      chat_id: m.chat.id,
      message_thread_id: tid,
      text: '⚠️ Не доставлено: ' + (r.description || 'ошибка'),
    });
  }
}

// ---------- правки сообщений ----------
async function onEdit(m, env) {
  if (m.chat.type === 'private') {
    const row = await env.BD.prepare(
      `SELECT x.group_msg_id, u.topic_id, u.banned FROM messages x
       JOIN users u ON u.user_id = x.user_id
       WHERE x.user_id = ? AND x.user_msg_id = ?`
    ).bind(m.from.id, m.message_id).first();
    if (!row || row.banned) return;
    const r = await mirrorEdit(env, m, env.GROUP_ID, row.group_msg_id);
    if (r.ok) {
      await tg(env, 'sendMessage', {
        chat_id: env.GROUP_ID,
        message_thread_id: row.topic_id,
        reply_parameters: { message_id: row.group_msg_id, allow_sending_without_reply: true },
        text: '✏️ Клиент изменил это сообщение',
        disable_notification: true,
      });
    } else if (!/not modified/i.test(r.description || '')) {
      // Пересланные сообщения Telegram может не дать править: присылаем новую версию отдельным сообщением
      await tg(env, 'sendMessage', {
        chat_id: env.GROUP_ID,
        message_thread_id: row.topic_id,
        reply_parameters: { message_id: row.group_msg_id, allow_sending_without_reply: true },
        text: '✏️ Клиент изменил сообщение, новая версия ниже:',
        disable_notification: true,
      });
      await copy(env, m.chat.id, m.message_id, env.GROUP_ID, row.topic_id);
    }
    return;
  }

  if (String(m.chat.id) === String(env.GROUP_ID)) {
    if (m.from?.is_bot && !m.sender_chat) return;
    const row = await env.BD.prepare(
      'SELECT user_id, user_msg_id FROM messages WHERE group_msg_id = ?'
    ).bind(m.message_id).first();
    if (!row) {
      // Связи с сообщением у клиента нет (старше 3 суток или не доставлялось): предупреждаем в General на несколько секунд.
      // Заметки «//», General и чужие топики не трогаем: их клиенту и не отправляли.
      const tid = m.message_thread_id;
      if (!tid || tid === GENERAL_THREAD_ID || (m.text || m.caption || '').startsWith('//')) return;
      const topic = await env.BD.prepare('SELECT user_id FROM users WHERE topic_id = ?').bind(tid).first();
      if (topic) {
        await generalNotice(
          env,
          m.message_id,
          '⚠️ Правка не передана клиенту: сообщение не связано с перепиской (возможно, старше 3 суток)'
        );
      }
      return;
    }
    const r = await mirrorEdit(env, m, row.user_id, row.user_msg_id);
    if (!r.ok && !/not modified/i.test(r.description || '') && m.message_thread_id) {
      await tg(env, 'sendMessage', {
        chat_id: m.chat.id,
        message_thread_id: m.message_thread_id,
        text: '⚠️ Правку не удалось передать клиенту: ' + (r.description || 'ошибка'),
      });
    }
  }
}

function inputMedia(m) {
  const cap = { caption: m.caption, caption_entities: m.caption_entities };
  if (m.photo) return { type: 'photo', media: m.photo[m.photo.length - 1].file_id, ...cap };
  if (m.video) return { type: 'video', media: m.video.file_id, ...cap };
  if (m.animation) return { type: 'animation', media: m.animation.file_id, ...cap };
  if (m.audio) return { type: 'audio', media: m.audio.file_id, ...cap };
  if (m.document) return { type: 'document', media: m.document.file_id, ...cap };
  return null;
}

async function mirrorEdit(env, m, chat_id, message_id) {
  if (m.text !== undefined) {
    return tg(env, 'editMessageText', { chat_id, message_id, text: m.text, entities: m.entities });
  }
  const media = inputMedia(m);
  if (media) {
    const r = await tg(env, 'editMessageMedia', { chat_id, message_id, media });
    if (r.ok || /not modified/i.test(r.description || '')) return r;
  }
  return tg(env, 'editMessageCaption', {
    chat_id,
    message_id,
    caption: m.caption || '',
    caption_entities: m.caption_entities,
    show_caption_above_media: m.show_caption_above_media,
  });
}

// ---------- команды (только админы группы) ----------
async function isAdminId(env, userId) {
  const r = await tg(env, 'getChatMember', { chat_id: env.GROUP_ID, user_id: userId });
  return r.ok && ['creator', 'administrator'].includes(r.result.status);
}

async function onCommand(m, env, cmd, arg) {
  const known = ['ban', 'unban', 'app', 'del', 'delete'];
  if (!known.includes(cmd)) return false; // неизвестная команда: пересылаем как обычное сообщение

  const isGeneral = !m.message_thread_id || m.message_thread_id === GENERAL_THREAD_ID;

  // В топике ответ остаётся. В General ничего не копится: команда убирается сразу, ответ через несколько секунд
  const say = async (text, extra = {}, long = false) => {
    const params = { chat_id: m.chat.id, message_thread_id: m.message_thread_id, text, parse_mode: 'HTML', ...extra };
    if (!isGeneral) return tg(env, 'sendMessage', params);
    await tg(env, 'deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }).catch(() => {});
    return flash(env, params, noticeSec(env, long));
  };

  // /app в группе: кнопка-ссылка (inline web_app работает только в личке; ссылка на Mini App из BotFather /newapp, short name в APP_SHORT, по умолчанию card)
  if (cmd === 'app') {
    const uname = await botUsername(env);
    await say('Мини-приложение:', {
      reply_markup: { inline_keyboard: [[{ text: 'Открыть', url: `https://t.me/${uname}/${env.APP_SHORT || 'card'}?mode=compact` }]] },
    }, true);
    return true;
  }

  const admin =
    (m.sender_chat && String(m.sender_chat.id) === String(env.GROUP_ID)) ||
    (await isAdminId(env, m.from.id));
  if (!admin) {
    await say('Команды доступны только администраторам группы.');
    return true;
  }

  if (cmd === 'del' || cmd === 'delete') {
    await onDelete(m, env);
    return true;
  }

  if (cmd === 'ban' || cmd === 'unban') {
    let uid = Number(arg) || null;
    if (!uid && m.message_thread_id && m.message_thread_id !== GENERAL_THREAD_ID) {
      const r = await env.BD.prepare('SELECT user_id FROM users WHERE topic_id = ?').bind(m.message_thread_id).first();
      uid = r?.user_id;
    }
    if (!uid) {
      await say('Выполните команду в топике клиента или укажите ID: /ban 123456789');
      return true;
    }
    const val = cmd === 'ban' ? 1 : 0;
    const res = await env.BD.prepare('UPDATE users SET banned = ? WHERE user_id = ?').bind(val, uid).run();
    if (!res.meta.changes) await say('Клиент с таким ID не найден в базе.');
    else await say(val ? '🚫 Клиент заблокирован: его сообщения больше не пересылаются.' : '✅ Клиент разблокирован.');
    return true;
  }

  return false;
}

// ---------- удаление сообщений (/del) ----------
async function onDelete(m, env) {
  const tid = m.message_thread_id;
  const target = m.reply_to_message;
  const dropCommand = () =>
    tg(env, 'deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }).catch(() => {});

  const user =
    tid && tid !== GENERAL_THREAD_ID
      ? await env.BD.prepare('SELECT user_id FROM users WHERE topic_id = ?').bind(tid).first()
      : null;

  // без ответа на конкретное сообщение reply_to_message в топике указывает на его заголовок
  if (!user || !target || target.forum_topic_created || target.message_id === tid) {
    await dropCommand();
    await flash(env, {
      chat_id: m.chat.id,
      ...(tid ? { message_thread_id: tid } : {}),
      text: 'Ответьте командой /del на сообщение в топике клиента, которое нужно удалить.',
      disable_notification: true,
    });
    return;
  }
  await dropCommand();

  const row = await env.BD.prepare(
    'SELECT user_msg_id AS u FROM messages WHERE user_id = ? AND group_msg_id = ?'
  ).bind(user.user_id, target.message_id).first();
  if (!row) {
    await generalNotice(env, target.message_id, '⚠️ Не удалено: сообщение старше 48 часов или не относится к переписке с клиентом');
    return;
  }

  // удаляем у клиента (и его сообщение, и копию нашего: бот может удалять и то и другое в личке)
  const del = await tg(env, 'deleteMessage', { chat_id: user.user_id, message_id: row.u });
  if (!deleteOk(del)) {
    await generalNotice(env, target.message_id, '⚠️ Не удалено: ' + deleteReason(del));
    return;
  }
  await env.BD.prepare('DELETE FROM messages WHERE user_id = ? AND group_msg_id = ?')
    .bind(user.user_id, target.message_id).run().catch(() => {});

  const fromClient = target.from?.is_bot && !target.sender_chat;
  if (!fromClient) {
    // своё сообщение: у клиента удалено, убираем и у себя в топике
    const d = await tg(env, 'deleteMessage', { chat_id: m.chat.id, message_id: target.message_id });
    if (!deleteOk(d)) {
      await generalNotice(env, target.message_id, '⚠️ У клиента удалено, а в топике не получилось: ' + (d.description || 'ошибка'));
    }
    return;
  }

  // сообщение клиента: в топике остаётся пометка вместо содержимого
  const text = '🗑 Сообщение удалено';
  const e = await tg(env, 'editMessageText', { chat_id: m.chat.id, message_id: target.message_id, text });
  if (e.ok || /not modified/i.test(e.description || '')) return;
  // пересланное или медиа-сообщение текстом не заменить: удаляем его из топика, а «Сообщение удалено» на несколько секунд показываем в General
  const d = await tg(env, 'deleteMessage', { chat_id: m.chat.id, message_id: target.message_id });
  if (!deleteOk(d)) {
    await generalNotice(env, target.message_id, '⚠️ У клиента удалено, а в топике не получилось: ' + (d.description || 'ошибка'));
    return;
  }
  await generalNotice(env, null, text);
}

async function onCallback(q, env) {
  const [act, idStr] = (q.data || '').split(':');
  if (act !== 'bc_go' && act !== 'bc_no') return;
  if (String(q.message?.chat?.id) !== String(env.GROUP_ID)) return;

  if (!(await isAdminId(env, q.from.id))) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Только для админов', show_alert: true });
    return;
  }
  const b = await env.BD.prepare("SELECT id FROM broadcasts WHERE id = ? AND status = 'pending'")
    .bind(Number(idStr)).first();
  if (!b) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Уже обработано' });
    return;
  }
  const status = act === 'bc_go' ? 'running' : 'cancelled';
  await env.BD.prepare('UPDATE broadcasts SET status = ? WHERE id = ?').bind(status, b.id).run();
  await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
  await tg(env, 'editMessageText', {
    chat_id: q.message.chat.id,
    message_id: q.message.message_id,
    text:
      act === 'bc_go'
        ? `🚀 Рассылка запущена. Отправка идёт порциями (около ${BATCH} сообщений в минуту), по завершении напишу итог здесь.`
        : 'Рассылка отменена.',
  });
}

// ---------- рассылка (вызывается по cron раз в минуту) ----------
async function tickBroadcast(env) {
  const b = await env.BD.prepare("SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT 1").first();
  if (!b) return;
  const { results } = await env.BD.prepare(
    'SELECT user_id FROM users WHERE banned = 0 AND user_id > ? ORDER BY user_id LIMIT ?'
  ).bind(b.cursor, BATCH).all();

  let sent = 0, failed = 0, cursor = b.cursor, stopped = false;
  for (const u of results) {
    const r = await copy(env, b.from_chat, b.msg_id, u.user_id);
    if (r.ok) sent++;
    else if (r.error_code === 429) { stopped = true; break; } // Telegram просит подождать
    else failed++;
    cursor = u.user_id;
  }
  const done = !stopped && results.length < BATCH;
  await env.BD.prepare(
    'UPDATE broadcasts SET cursor = ?, sent = sent + ?, failed = failed + ?, status = ? WHERE id = ?'
  ).bind(cursor, sent, failed, done ? 'done' : 'running', b.id).run();

  if (done) {
    await tg(env, 'sendMessage', {
      chat_id: b.notify_chat,
      text: `📣 Рассылка завершена. Доставлено: ${b.sent + sent}, не доставлено: ${b.failed + failed} (клиент заблокировал бота или удалил аккаунт).`,
    });
  }
}

// ---------- вспомогательное ----------
// copyMessage: без пометки об отправителе. Используется для всего, что уходит клиентам (анонимность владельца).
function copy(env, fromChat, msgId, toChat, threadId, replyTo) {
  const body = { chat_id: toChat, from_chat_id: fromChat, message_id: msgId };
  if (threadId) body.message_thread_id = threadId;
  if (replyTo) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  return tg(env, 'copyMessage', body);
}

// forwardMessage: с плашкой «Переслано от». Используется ТОЛЬКО для клиент -> группа.
function fwd(env, fromChat, msgId, toChat, threadId) {
  const body = { chat_id: toChat, from_chat_id: fromChat, message_id: msgId };
  if (threadId) body.message_thread_id = threadId;
  return tg(env, 'forwardMessage', body);
}

async function saveMap(env, userId, userMsgId, groupMsgId) {
  await env.BD.prepare(
    'INSERT OR REPLACE INTO messages (user_id, user_msg_id, group_msg_id, created_at) VALUES (?, ?, ?, ?)'
  ).bind(userId, userMsgId, groupMsgId, now()).run();
  if (Math.random() < 0.02) {
    // правки в Telegram возможны около 2 суток, храним 3
    await env.BD.prepare('DELETE FROM messages WHERE created_at < ?').bind(now() - 3 * 86400).run();
  }
}

// =====================  MINI APP: API  =====================

// Пользователь заблокировал/разблокировал бота (личный чат: chat.id = user_id)
async function onMyChatMember(ev, env) {
  if (ev.chat.type !== 'private') return;
  const status = ev.new_chat_member?.status;
  if (status !== 'kicked' && status !== 'member') return;
  await env.BD.prepare('UPDATE users SET blocked_bot = ? WHERE user_id = ?')
    .bind(status === 'kicked' ? 1 : 0, ev.chat.id).run();
}

// ADMIN_USER_ID: один ID или несколько через запятую, например 123456789,987654321
const adminIds = (env) => String(env.ADMIN_USER_ID || '').split(/[,;\s]+/).map(Number).filter(Boolean);
const isAdminUser = (env, id) => adminIds(env).includes(Number(id));

// Запрет ссылок на Telegram в текстах, которые правит владелец (защита анонимности)
const LEAK = /t\.me|telegram\.me|tg:\/\/|(^|\s)@[A-Za-z]\w{3,}/i;

// Колонки и таблица pins создаются сами при первом обращении (ошибки игнорируются)
let customNameReady;
function ensureCustomName(env) {
  customNameReady ||= (async () => {
    for (const col of ['custom_name', 'custom_username']) {
      await DB(env).prepare('ALTER TABLE users ADD COLUMN ' + col + ' TEXT').run().catch(() => {});
    }
    await DB(env).prepare(
      'CREATE TABLE IF NOT EXISTS pins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, group_msg_id INTEGER, text TEXT NOT NULL, created_at INTEGER)'
    ).run().catch(() => {});
  })();
  return customNameReady;
}

async function getContent(env, kind) {
  try { const v = JSON.parse((await getSetting(env, kind)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

let botNameCache;
async function botName(env) {
  if (!botNameCache) {
    const r = await tg(env, 'getMe', {});
    botNameCache = r.ok ? r.result.first_name : 'Бот';
  }
  return botNameCache;
}

// Создаёт недостающие колонки и таблицы (ошибки «уже существует» безвредны)
async function ensureSchema(env) {
  const out = {};
  const run = async (name, sql) => {
    try { await env.BD.prepare(sql).run(); out[name] = 'ok'; }
    catch (e) { out[name] = String(e.message || e).slice(0, 80); }
  };
  await run('first_name', 'ALTER TABLE users ADD COLUMN first_name TEXT');
  await run('last_name', 'ALTER TABLE users ADD COLUMN last_name TEXT');
  await run('username', 'ALTER TABLE users ADD COLUMN username TEXT');
  await run('hidden', 'ALTER TABLE users ADD COLUMN hidden INTEGER DEFAULT 0');
  await run('blocked_bot', 'ALTER TABLE users ADD COLUMN blocked_bot INTEGER DEFAULT 0');
  await run('custom_name', 'ALTER TABLE users ADD COLUMN custom_name TEXT');
  await run('custom_username', 'ALTER TABLE users ADD COLUMN custom_username TEXT');
  await run('avatar_log', 'CREATE TABLE IF NOT EXISTS avatar_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, emoji_id TEXT, created_at INTEGER)');
  await run('avatars', 'CREATE TABLE IF NOT EXISTS avatars (user_id INTEGER PRIMARY KEY, file_unique_id TEXT, emoji_id TEXT, checked_at INTEGER, pending INTEGER DEFAULT 0)');
  await run('schedule', "CREATE TABLE IF NOT EXISTS schedule (day TEXT PRIMARY KEY, kind TEXT DEFAULT 'work')");
  await run('schedule_kind', "ALTER TABLE schedule ADD COLUMN kind TEXT DEFAULT 'work'");
  await run('pins', 'CREATE TABLE IF NOT EXISTS pins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, group_msg_id INTEGER, text TEXT NOT NULL, created_at INTEGER)');
  await run('temp_msgs', 'CREATE TABLE IF NOT EXISTS temp_msgs (chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, delete_at INTEGER NOT NULL, PRIMARY KEY (chat_id, message_id))');
  return out;
}

const enc = new TextEncoder();
const DB = (env) => env.BD;

const DEFAULT_HEADER = {
  title: 'Работник склада',
  company: 'ООО «Смарт Деним»',
  phone: '+79883685548',
  email: 's.nesterov101@yandex.ru',
};

// ---------- крипто ----------
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(key, data) {
  const k = await crypto.subtle.importKey(
    'raw', typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Проверка подписи Telegram initData. Возвращает объект user или null.
async function verifyInitData(initData, botToken, maxAgeSec = 86400) {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const checkString = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = await hmac('WebAppData', botToken);
  const sig = hex(await hmac(secret, checkString));
  if (!safeEqual(sig, hash)) return null;
  const age = Date.now() / 1000 - Number(p.get('auth_date'));
  if (!(age >= 0 && age < maxAgeSec)) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

// Непрозрачный идентификатор коллеги: Telegram ID наружу не уходит.
async function refFor(userId, env) {
  return hex(await hmac('ref:' + env.BOT_TOKEN, String(userId))).slice(0, 16);
}

async function resolveRef(ref, env) {
  const { results } = await DB(env)
    .prepare('SELECT user_id FROM users WHERE topic_id IS NOT NULL').all();
  for (const r of results) {
    if (safeEqual(await refFor(r.user_id, env), ref)) return r.user_id;
  }
  return null;
}

// ---------- ответы ----------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

// ---------- данные ----------
async function getHeader(env) {
  const row = await DB(env).prepare("SELECT value FROM settings WHERE key = 'header'").first();
  if (!row) return DEFAULT_HEADER;
  try { return { ...DEFAULT_HEADER, ...JSON.parse(row.value) }; } catch { return DEFAULT_HEADER; }
}

function validateHeader(h) {
  const text = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
  const leak = LEAK;
  if (!text(h.title, 60) || !text(h.company, 60)) return 'Некорректное название или компания';
  if (leak.test(h.title) || leak.test(h.company)) return 'Нельзя указывать ссылки на Telegram';
  if (!/^\+?[0-9]{10,15}$/.test(h.phone || '')) return 'Некорректный телефон';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h.email || '')) return 'Некорректная почта';
  return null;
}

// Список коллег (без звёздочек избранного и без данных владельца)
async function listColleagues(env, viewerId) {
  const admins = JSON.stringify(adminIds(env));
  const isAdm = isAdminUser(env, viewerId);
  const sql = `SELECT user_id, first_name, last_name, name, username, hidden, blocked_bot, custom_name, custom_username
                 FROM users
                WHERE topic_id IS NOT NULL AND user_id != ?1 AND user_id NOT IN (SELECT value FROM json_each(?2))
                  AND COALESCE(banned,0) = 0
                  AND (?3 = 1 OR (COALESCE(hidden,0) = 0 AND COALESCE(blocked_bot,0) = 0))
                ORDER BY COALESCE(first_name, name) COLLATE NOCASE`;
  const { results } = await DB(env).prepare(sql).bind(viewerId, admins, isAdm ? 1 : 0).all();

  return Promise.all(results.map(async (u) => {
    const first = u.first_name || u.name || 'Без имени';
    return {
      ref: await refFor(u.user_id, env),
      name: u.custom_name || [first, u.last_name].filter(Boolean).join(' '),
      initial: (u.custom_name || first).trim().charAt(0).toUpperCase(),
      username: u.custom_username || u.username || null,
      ...(isAdm ? { hidden: !!u.hidden, blocked: !!u.blocked_bot } : {}),
    };
  }));
}

// Список закреплённых сообщений для каждого юзера
async function listPins(env, viewerId, isAdm) {
  if (isAdm) {
    const { results } = await DB(env).prepare(
      `SELECT p.id, p.user_id, p.text, p.created_at, u.first_name, u.last_name, u.name, u.custom_name
         FROM pins p LEFT JOIN users u ON u.user_id = p.user_id
        ORDER BY p.id DESC LIMIT 100`
    ).all();
    return results.map((r) => {
      const first = r.first_name || r.name || 'Сотрудник';
      const who = r.user_id === 0 ? 'Всем сотрудникам' : (r.custom_name || [first, r.last_name].filter(Boolean).join(' '));
      return { id: r.id, text: r.text, who };
    });
  }
  const { results } = await DB(env).prepare(
    'SELECT id, text, created_at FROM pins WHERE user_id = ? OR user_id = 0 ORDER BY id DESC LIMIT 50'
  ).bind(viewerId).all();
  return results.map((r) => ({ id: r.id, text: r.text }));
}

// Данные для /api/me и /api/bootstrap (одни и те же, чтобы ответы не расходились)
async function loadMe(env, isAdmin) {
  const [qr, header, bot] = await Promise.all([
    DB(env).prepare("SELECT 1 AS x FROM settings WHERE key = 'qr'").first(),
    getHeader(env),
    botName(env),
  ]);
  return { isAdmin, header, bot, qr: !!qr };
}

async function loadSchedule(env) {
  await ensureSchedule(env);
  const since = new Date(Date.now() - 400 * 86400 * 1000).toISOString().slice(0, 10);
  const { results } = await DB(env).prepare(
    "SELECT day, COALESCE(kind, 'work') AS kind FROM schedule WHERE day >= ? ORDER BY day"
  ).bind(since).all();
  return results.map((r) => ({ d: r.day, k: r.kind }));
}

// Журнал новых аватарок (виден только админам, проверка прав — у вызывающего)
async function loadAvatarLog(env) {
  const { results } = await DB(env).prepare(
    `SELECT l.id, l.user_id, l.created_at,
            (a.emoji_id = l.emoji_id AND COALESCE(a.pending, 0) = 0) AS actual,
            u.first_name, u.last_name, u.name, u.custom_name
       FROM avatar_log l
       LEFT JOIN users u ON u.user_id = l.user_id
       LEFT JOIN avatars a ON a.user_id = l.user_id
      ORDER BY l.id DESC LIMIT 50`
  ).all();
  return Promise.all(results.map(async (r) => {
    const nm = userLabel(r);
    return { id: r.id, ref: await refFor(r.user_id, env), name: nm, initial: nm.charAt(0).toUpperCase(), at: r.created_at, actual: !!r.actual };
  }));
}

async function photoResponse(env, userId) {
  const api = `https://api.telegram.org/bot${env.BOT_TOKEN}`;
  const photos = await (await fetch(`${api}/getUserProfilePhotos?user_id=${userId}&limit=1`)).json();
  const sizes = photos.ok && photos.result.photos[0];
  if (!sizes) return new Response(null, { status: 404 });
  const small = sizes[Math.min(1, sizes.length - 1)]; // средний размер
  const file = await (await fetch(`${api}/getFile?file_id=${small.file_id}`)).json();
  if (!file.ok) return new Response(null, { status: 404 });
  const img = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.result.file_path}`);
  return new Response(img.body, {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' },
  });
}

// ---------- роутер ----------
async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 1. Аутентификация: заголовок "Authorization: tma <initData>"
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('tma ')) return json({ error: 'unauthorized' }, 401);
  const tgUser = await verifyInitData(auth.slice(4), env.BOT_TOKEN);
  if (!tgUser) return json({ error: 'unauthorized' }, 401);

  const me = Number(tgUser.id);
  const isAdmin = isAdminUser(env, me);

  // 2. Доступ только тем, кто есть в базе и не заблокирован
  const row = await DB(env).prepare('SELECT banned, first_name, last_name, username FROM users WHERE user_id = ?').bind(me).first();
  if (!isAdmin && (!row || row.banned)) return json({ error: 'forbidden' }, 403);

  // Схему создаёт /setup (ensureSchema): DDL на каждом холодном старте тормозил открытие.
  // Имя в базе обновляем только если оно изменилось.
  if (row && ((row.first_name || null) !== (tgUser.first_name || null) ||
              (row.last_name || null) !== (tgUser.last_name || null) ||
              (row.username || null) !== (tgUser.username || null))) {
    await DB(env).prepare('UPDATE users SET first_name = ?, last_name = ?, username = ? WHERE user_id = ?')
      .bind(tgUser.first_name || null, tgUser.last_name || null, tgUser.username || null, me).run().catch(() => {});
  }

  try {
    if (path === '/api/me' && request.method === 'GET') {
      return json(await loadMe(env, isAdmin));
    }

    // Всё для запуска мини-аппа одним запросом: шапка, коллеги, закрепы, уведомления, график
    // и (только админам) журнал аватарок. Раньше приложение слало их отдельными запросами.
    if (path === '/api/bootstrap' && request.method === 'GET') {
      const [meData, colleagues, pins, notifications, schedule, avlog] = await Promise.all([
        loadMe(env, isAdmin),
        listColleagues(env, me),
        listPins(env, me, isAdmin),
        getContent(env, 'notifications'),
        loadSchedule(env),
        isAdmin ? loadAvatarLog(env) : Promise.resolve(null),
      ]);
      return json({ me: meData, colleagues, pins, notifications, schedule, ...(isAdmin ? { avlog } : {}) });
    }

    if (path === '/api/colleagues' && request.method === 'GET') {
      return json({ items: await listColleagues(env, me) });
    }

    if (path === '/api/pins') {
      if (request.method === 'GET') {
        return json({ items: await listPins(env, me, isAdmin) });
      }
      if (request.method === 'POST') {
        if (!isAdmin) return json({ error: 'forbidden' }, 403);
        const body = await request.json().catch(() => ({}));
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text || text.length > 1000 || LEAK.test(text)) return json({ error: 'bad_request' }, 400);
        let targetId = 0;
        if (body.ref && body.ref !== 'all') {
          targetId = await resolveRef(body.ref, env);
          if (!targetId) return json({ error: 'not_found' }, 404);
        }
        await DB(env).prepare(
          'INSERT INTO pins (user_id, text, created_at) VALUES (?, ?, ?)'
        ).bind(targetId, text, now()).run();
        return json({ ok: true });
      }
      if (request.method === 'DELETE') {
        const id = Number(url.searchParams.get('id'));
        if (!id) return json({ error: 'bad_request' }, 400);
        if (isAdmin) {
          await DB(env).prepare('DELETE FROM pins WHERE id = ?').bind(id).run();
        } else {
          await DB(env).prepare('DELETE FROM pins WHERE id = ? AND user_id = ?').bind(id, me).run();
        }
        return json({ ok: true });
      }
    }

    // Очередь аватарок: мини-апп (владелец) рисует круг и присылает PNG
    if (path === '/api/avatars/pending' && request.method === 'GET') {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      const { results } = await DB(env).prepare(
        `SELECT a.user_id, u.first_name, u.last_name, u.name, u.custom_name
           FROM avatars a LEFT JOIN users u ON u.user_id = a.user_id
          WHERE a.pending = 1 AND a.user_id NOT IN (SELECT value FROM json_each(?1))
          ORDER BY a.rowid LIMIT 10`
      ).bind(JSON.stringify(adminIds(env))).all();
      return json({ items: await Promise.all(results.map(async (r) => {
        const nm = userLabel(r);
        return { ref: await refFor(r.user_id, env), name: nm, initial: initials(r) };
      })) });
    }

    // Журнал новых аватарок: виден только админам (показывается в «Уведомлениях»)
    if (path === '/api/avatars/log' && request.method === 'GET') {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      return json({ items: await loadAvatarLog(env) });
    }

    if (path === '/api/avatars/log' && request.method === 'DELETE') {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      const id = Number(url.searchParams.get('id'));
      const l = id ? await DB(env).prepare('SELECT user_id, emoji_id FROM avatar_log WHERE id = ?').bind(id).first() : null;
      if (!l) return json({ error: 'not_found' }, 404);
      const err = await deleteEmoji(env, l.emoji_id);
      if (err) return json({ error: 'tg: ' + err }, 502);
      await DB(env).prepare('DELETE FROM avatar_log WHERE id = ?').bind(id).run();
      await DB(env).prepare('UPDATE avatars SET emoji_id = NULL WHERE user_id = ? AND emoji_id = ?').bind(l.user_id, l.emoji_id).run();
      return json({ ok: true });
    }

    if (path === '/api/avatars/emoji' && request.method === 'POST') {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      const body = await request.json().catch(() => ({}));
      const target = body.ref ? await resolveRef(body.ref, env) : null;
      if (!target || typeof body.png !== 'string' || body.png.length > 400000) return json({ error: 'bad_request' }, 400);
      const a = await DB(env).prepare('SELECT pending FROM avatars WHERE user_id = ?').bind(target).first();
      if (!a) return json({ error: 'not_found' }, 404);
      const bytes = Uint8Array.from(atob(body.png), (c) => c.charCodeAt(0));
      const res = await makeEmoji(env, bytes);
      if (res.error) return json({ error: 'tg: ' + res.error }, 502);
      await DB(env).prepare('UPDATE avatars SET emoji_id = ?, pending = 0 WHERE user_id = ?').bind(res.emoji, target).run();
      await DB(env).prepare('INSERT INTO avatar_log (user_id, emoji_id, created_at) VALUES (?, ?, ?)').bind(target, res.emoji, now()).run();
      return json({ ok: true });
    }

    // График работы: смотрят все, отмечает только владелец. Тип дня: work | sick | vacation
    if (path === '/api/schedule') {
      await ensureSchedule(env);
      if (request.method === 'GET') {
        return json({ items: await loadSchedule(env) });
      }
      if (request.method === 'PUT') {
        if (!isAdmin) return json({ error: 'forbidden' }, 403);
        const body = await request.json().catch(() => ({}));
        const day = typeof body.date === 'string' ? body.date : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) return json({ error: 'bad_request' }, 400);
        if (['work', 'sick', 'vacation'].includes(body.kind)) {
          await DB(env).prepare('INSERT OR REPLACE INTO schedule (day, kind) VALUES (?, ?)').bind(day, body.kind).run();
        } else {
          await DB(env).prepare('DELETE FROM schedule WHERE day = ?').bind(day).run();
        }
        return json({ ok: true });
      }
    }

    // QR-код бота: картинка PNG в base64 лежит в settings, загружает владелец
    if (path === '/api/qr') {
      if (request.method === 'GET') {
        const b64 = await getSetting(env, 'qr');
        if (!b64) return new Response(null, { status: 404 });
        return new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' },
        });
      }
      if (request.method === 'POST') {
        if (!isAdmin) return json({ error: 'forbidden' }, 403);
        const body = await request.json().catch(() => ({}));
        const png = typeof body.png === 'string' ? body.png : '';
        if (!png || png.length > 400000 || !/^[A-Za-z0-9+/=]+$/.test(png) || !png.startsWith('iVBOR')) return json({ error: 'bad_request' }, 400);
        await setSetting(env, 'qr', png);
        return json({ ok: true });
      }
      if (request.method === 'DELETE') {
        if (!isAdmin) return json({ error: 'forbidden' }, 403);
        await delSetting(env, 'qr');
        return json({ ok: true });
      }
    }

    if (path.startsWith('/api/photo/') && request.method === 'GET') {
      const seg = path.slice('/api/photo/'.length);
      if (seg === 'bot') return photoResponse(env, Number(env.BOT_TOKEN.split(':')[0]));
      const target = await resolveRef(seg, env);
      if (!target || isAdminUser(env, target)) return new Response(null, { status: 404 });
      return photoResponse(env, target);
    }

    if (path === '/api/rename' && request.method === 'POST') {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      const body = await request.json().catch(() => ({}));
      const target = body.ref ? await resolveRef(body.ref, env) : null;
      if (!target) return json({ error: 'not_found' }, 404);
      const sets = [], vals = [];
      if (typeof body.name === 'string') {
        const name = body.name.trim();
        if (name.length > 60 || LEAK.test(name)) return json({ error: 'bad_request' }, 400);
        sets.push('custom_name = ?'); vals.push(name || null);
      }
      if (typeof body.username === 'string') {
        const un = body.username.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
        if (un && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(un)) return json({ error: 'Некорректный username' }, 400);
        sets.push('custom_username = ?'); vals.push(un || null);
      }
      if (!sets.length) return json({ error: 'bad_request' }, 400);
      await DB(env).prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE user_id = ?').bind(...vals, target).run();
      return json({ ok: true });
    }

    if (path === '/api/hide' && request.method === 'POST') {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      const body = await request.json().catch(() => ({}));
      const target = body.ref ? await resolveRef(body.ref, env) : null;
      if (!target) return json({ error: 'not_found' }, 404);
      await DB(env).prepare('UPDATE users SET hidden = ? WHERE user_id = ?').bind(body.hidden ? 1 : 0, target).run();
      return json({ ok: true });
    }

    if (path.startsWith('/api/content/')) {
      const kind = path.slice('/api/content/'.length);
      if (!['instructions', 'notifications'].includes(kind)) return json({ error: 'not_found' }, 404);
      if (request.method === 'GET') return json({ items: await getContent(env, kind) });
      if (request.method === 'PUT') {
        if (!isAdmin) return json({ error: 'forbidden' }, 403);
        const body = await request.json().catch(() => ({}));
        const items = body.items;
        const bad = !Array.isArray(items) || items.length > 30 || items.some((i) =>
          typeof i?.title !== 'string' || typeof i?.text !== 'string' || !i.title.trim() || !i.text.trim() ||
          i.title.length > 80 || i.text.length > 1000 || LEAK.test(i.title + ' ' + i.text));
        if (bad) return json({ error: 'bad_request' }, 400);
        const clean = items.map((i) => ({ title: i.title.trim(), text: i.text.trim() }));
        await setSetting(env, kind, JSON.stringify(clean));
        return json({ ok: true });
      }
    }

    // Только владелец: правка шапки
    if (path === '/api/header' && request.method === 'PUT') {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      const body = await request.json().catch(() => ({}));
      const str = (v) => (typeof v === 'string' ? v.trim() : '');
      let phone = str(body.phone).replace(/[\s\-().]/g, '');
      if (/^8\d{10}$/.test(phone)) phone = '+7' + phone.slice(1);
      if (/^7\d{10}$/.test(phone)) phone = '+' + phone;
      const header = { title: str(body.title), company: str(body.company), phone, email: str(body.email) };
      const err = validateHeader(header);
      if (err) return json({ error: err }, 400);
      await DB(env).prepare(
        "INSERT INTO settings (key, value) VALUES ('header', ?1) " +
        'ON CONFLICT(key) DO UPDATE SET value = ?1'
      ).bind(JSON.stringify(header)).run();
      return json({ ok: true, header });
    }
  } catch (e) {
    console.error('miniapp api error', e);
    return json({ error: 'server_error' }, 500);
  }

  return json({ error: 'not_found' }, 404);
}

// =====================  АВТОАВАТАРКИ ТОПИКОВ  =====================
// Worker следит за сменой аватарки (не чаще раза в 3 дня на человека), а круглую PNG рисует
// мини-апп владельца (canvas) и присылает в /api/avatars/emoji. Дальше пак эмодзи и сообщение в General.
const AVATAR_CHECK_EVERY = 3 * 86400;
const PACK_LIMIT = 200;

let avReady;
function ensureAvatars(env) {
  avReady ||= (async () => {
    await DB(env).prepare(
      'CREATE TABLE IF NOT EXISTS avatars (user_id INTEGER PRIMARY KEY, file_unique_id TEXT, emoji_id TEXT, checked_at INTEGER, pending INTEGER DEFAULT 0)'
    ).run().catch(() => {});
    await DB(env).prepare('ALTER TABLE avatars ADD COLUMN pending INTEGER DEFAULT 0').run().catch(() => {});
    await DB(env).prepare('CREATE TABLE IF NOT EXISTS avatar_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, emoji_id TEXT, created_at INTEGER)').run().catch(() => {});
  })();
  return avReady;
}

const userLabel = (r) => {
  const first = r.first_name || r.name || 'Без имени';
  return r.custom_name || [first, r.last_name].filter(Boolean).join(' ');
};

async function checkAvatar(env, user) {
  if (isAdminUser(env, user.id)) return; // администраторам аватарки не генерируем
  await ensureAvatars(env);
  const t = now();
  const row = await DB(env).prepare('SELECT file_unique_id, checked_at FROM avatars WHERE user_id = ?').bind(user.id).first();
  if (row && t - row.checked_at < AVATAR_CHECK_EVERY) return; // свежая проверка: в Telegram не ходим

  const r = await tg(env, 'getUserProfilePhotos', { user_id: user.id, limit: 1 });
  const uid = r.ok && r.result.photos[0] ? r.result.photos[0][0].file_unique_id : null; // самая маленькая версия

  if (row && (row.file_unique_id || null) === uid) {
    await DB(env).prepare('UPDATE avatars SET checked_at = ? WHERE user_id = ?').bind(t, user.id).run();
    return;
  }
  await DB(env).prepare(
    `INSERT INTO avatars (user_id, file_unique_id, checked_at, pending) VALUES (?, ?, ?, 1)
     ON CONFLICT(user_id) DO UPDATE SET file_unique_id = excluded.file_unique_id, checked_at = excluded.checked_at, pending = 1`
  ).bind(user.id, uid, t).run();
}

let botUserCache;
async function botUsername(env) {
  if (!botUserCache) {
    const r = await tg(env, 'getMe', {});
    botUserCache = r.ok ? r.result.username : '';
  }
  return botUserCache;
}

function tgForm(env, method, fields, bytes) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  fd.append('f1', new Blob([bytes], { type: 'image/png' }), 'avatar.png');
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', body: fd }).then((r) => r.json());
}

// Кладёт PNG в пак custom_emoji (имя заканчивается на _by_<username бота>), возвращает custom_emoji_id
async function makeEmoji(env, bytes) {
  const owner = adminIds(env)[0];
  if (!owner) return { error: 'ADMIN_USER_ID не задан' };
  const uname = await botUsername(env);
  let n = Number((await getSetting(env, 'emoji_pack_n')) || 1);
  let cnt = Number((await getSetting(env, 'emoji_pack_cnt')) || 0);
  if (cnt >= PACK_LIMIT) { n++; cnt = 0; } // старые эмодзи не удаляем
  const name = `av${n}_by_${uname}`;
  const input = JSON.stringify({ sticker: 'attach://f1', format: 'static', emoji_list: ['👤'] });

  const create = () => tgForm(env, 'createNewStickerSet', {
    user_id: owner, name, title: 'Avatars ' + n, sticker_type: 'custom_emoji', stickers: '[' + input + ']',
  }, bytes);
  let r = null;
  if (cnt === 0) {
    r = await create();
    if (!r.ok && /already occupied/i.test(r.description || '')) r = null; // пак уже есть, просто добавим
  }
  if (!r) {
    r = await tgForm(env, 'addStickerToSet', { user_id: owner, name, sticker: input }, bytes);
    if (!r.ok && /STICKERSET_INVALID|not found/i.test(r.description || '')) r = await create(); // пак пропал (стал пустым)
  }
  if (!r.ok) return { error: r.description || 'ошибка' };

  const set = await tg(env, 'getStickerSet', { name });
  if (!set.ok) return { error: set.description || 'getStickerSet' };
  const st = set.result.stickers;
  const emoji = st[st.length - 1]?.custom_emoji_id;
  if (!emoji) return { error: 'нет custom_emoji_id' };
  await setSetting(env, 'emoji_pack_n', String(n));
  await setSetting(env, 'emoji_pack_cnt', String(st.length));
  return { emoji };
}

// Инициалы для серой аватарки: имя и фамилия заполнены -> 2 буквы, иначе 1
function initials(r) {
  const f = Array.from((r.first_name || '').trim())[0];
  const l = Array.from((r.last_name || '').trim())[0];
  if (f) return (f + (l || '')).toUpperCase();
  return (Array.from(userLabel(r).trim())[0] || '?').toUpperCase();
}

// Удаляет эмодзи из пака по custom_emoji_id (null = успех)
async function deleteEmoji(env, emojiId) {
  if (!emojiId) return null;
  const g = await tg(env, 'getCustomEmojiStickers', { custom_emoji_ids: [emojiId] });
  const fid = g.ok && g.result[0] ? g.result[0].file_id : null;
  if (!fid) return null; // в паке уже нет
  const r = await tg(env, 'deleteStickerFromSet', { sticker: fid });
  if (!r.ok && !/not found|invalid/i.test(r.description || '')) return r.description || 'ошибка';
  return null;
}

let schedReady;
function ensureSchedule(env) {
  schedReady ||= (async () => {
    await DB(env).prepare("CREATE TABLE IF NOT EXISTS schedule (day TEXT PRIMARY KEY, kind TEXT DEFAULT 'work')").run().catch(() => {});
    await DB(env).prepare("ALTER TABLE schedule ADD COLUMN kind TEXT DEFAULT 'work'").run().catch(() => {});
  })();
  return schedReady;
}
